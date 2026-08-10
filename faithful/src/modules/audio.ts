/*
 * Sound: the ambient track, and the fireworks.
 *
 * The original used Howler 2.0.0 with a sprite map:
 *
 *   init:     [0,     50]
 *   firework: [0,   1900]
 *   full:     [0, 300015]
 *
 * All three start at 0, so they are the same recording played for different
 * durations — including the "firework", which was the track's own opening bar.
 * That was never a bang: measured off the file it averages -21 dBFS and decays
 * to -31 by 1.75 s, so layering four of them reads as music starting rather
 * than a shell going off. The reports are synthesised here instead, which needs
 * no asset and sounds like what it is meant to be.
 *
 * Sequencing, which is the part that matters:
 *
 *   cold open      the track is fetched and decoded, so it is ready on time
 *   fireworks      one report per burst, for as long as the display runs
 *   the finale     the track proper begins, a few seconds before the last
 *                  shells burn out, so the music arrives under them
 *
 * The original called .play() during load and expected it to work. Every
 * browser has blocked unprompted playback since 2017, so it has silently not
 * worked for years — but the intent was that sound simply happens, with the
 * speaker there to turn it off rather than on. That intent is honoured as
 * closely as the platform allows: when the track's moment arrives it just
 * starts, and if the autoplay policy refuses, it starts on the visitor's very
 * next interaction — any click, tap, key or scroll, not the speaker
 * specifically. Since the cold open invites a click to skip, in practice the
 * gesture has already happened long before the music is due.
 */

import { isNarrow } from './dom'

/*
 * Well under the bed's 0.55. Sixty of these go off across the display and
 * several overlap at any moment, so each has to sit low enough that a cluster
 * is a rumble rather than a wall.
 */
const EXPLOSION_VOLUME = 0.16

/*
 * Deliberately not the key the earlier build used ('kyryll:sound'). That one
 * recorded on/off with sound defaulting to *off*, so a stored 'off' says
 * nothing about whether the visitor ever chose silence — reading it here would
 * mute people permanently for a preference they never expressed.
 */
const PREF_KEY = 'kyryll:muted'

export interface Audio {
  /** Fetch and decode during the cold open, so the track is ready on cue. */
  prime(): void
  /** One report, played as a shell bursts. */
  playExplosion(): void
  /** Start the track proper. */
  startTrack(): void
}

export function createAudio(): Audio {
  const button = document.getElementById('sound')
  const bed = new window.Audio()

  bed.loop = true
  bed.volume = 0.55
  bed.preload = 'auto'
  bed.src = pickSource()

  let muted = false
  try {
    muted = window.localStorage.getItem(PREF_KEY) === '1'
  } catch {
    // Private mode; default to sound on, as the original did.
  }

  let playing = false
  let wantsTrack = false
  let armed = false

  /*
   * The reports are synthesised: a filtered noise burst with a fast decay,
   * which is what a firework sounds like from across a harbour.
   *
   * One shared noise buffer covers every shell — only playback rate, filter
   * sweep and level vary — so sixty bursts cost sixty gain nodes rather than
   * sixty downloads. The previous arrangement preloaded four copies of a
   * five-minute track for four sounds nobody could hear.
   */
  let ac: AudioContext | null = null
  let noise: AudioBuffer | null = null

  function audioContext(): AudioContext | null {
    if (muted) return null

    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return null
      ac ??= new Ctor()
    } catch {
      return null
    }

    // The same autoplay policy the bed faces: suspended until a gesture.
    // Asking to resume is free and silently ignored if it is refused.
    if (ac.state === 'suspended') void ac.resume()

    return ac
  }

  /*
   * The control reflects *intent*, not whether audio happens to be coming out
   * right now. The track is not due until the display is nearly over, and a
   * button that reads "off" for the first thirteen seconds — then flips on its
   * own — describes the machine rather than the choice.
   */
  function reflect(): void {
    button?.setAttribute('aria-pressed', String(!muted))
  }

  reflect()

  /** Plays if the track is due, not muted, and the browser will allow it. */
  function tryStart(): void {
    if (muted || !wantsTrack || playing) return

    void bed.play().then(
      () => {
        playing = true
        reflect()
      },
      () => {
        // Refused by the autoplay policy. Wait for a gesture and try again.
        armFirstGesture()
      },
    )
  }

  function armFirstGesture(): void {
    if (armed) return
    armed = true

    const events = ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const

    const go = (): void => {
      for (const type of events) document.removeEventListener(type, go)
      armed = false
      tryStart()
    }

    for (const type of events) {
      document.addEventListener(type, go, { once: true, passive: true })
    }
  }

  function toggle(): void {
    /*
     * Branches on `muted`, not on `playing`.
     *
     * Keying off `playing` meant that pressing this before the track was due —
     * anywhere in the ~13 s the opening display runs — took the else-branch and
     * started the music *immediately*. The one control offered for stopping
     * audio turned it on instead, eight seconds early.
     */
    muted = !muted

    if (muted) {
      // Unconditional: the track may not have started yet, and the point is
      // that it must not start later either.
      bed.pause()
      playing = false

      /*
       * And the fireworks, which pausing the bed does not touch. Suspending the
       * context silences anything mid-decay as well as everything after it —
       * a report already sounding is the only one that matters to somebody who
       * has just pressed mute.
       */
      if (ac && ac.state === 'running') void ac.suspend()
    } else {
      // Deliberately does not set `wantsTrack`. Un-muting says "let me hear
      // it", not "skip the cue" — if the display is still running, the track
      // still waits for it.
      if (ac && ac.state === 'suspended') void ac.resume()
      tryStart()
    }

    reflect()

    try {
      window.localStorage.setItem(PREF_KEY, muted ? '1' : '0')
    } catch {
      // ignore
    }
  }

  button?.addEventListener('click', toggle)

  /*
   * On the desktop the speaker is hidden while the sound is playing — the
   * original showed it on touch devices only, and this reproduces that. Space
   * mutes, which is undiscoverable and was for a while the *only* desktop
   * control: because the choice below is persisted, one stray press silenced
   * every future visit with nothing on screen to undo it. The icon now comes
   * back whenever the sound is off (see layout.css), so the scene stays clear
   * while the music plays and the way back is always visible when it is not.
   *
   * Space is a busy key, so this yields in every case where it already means
   * something: it is the activation key for whatever control has focus, the
   * page-down key when the page scrolls, and the skip key during the cold
   * open.
   */
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' && e.key !== ' ') return
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return

    // Focused control, or a text field: space belongs to it.
    const target = e.target
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      target instanceof HTMLButtonElement ||
      target instanceof HTMLAnchorElement ||
      (target instanceof HTMLElement && (target.isContentEditable || target.tabIndex >= 0))
    ) {
      return
    }

    // splash.ts listens for space to skip the intro.
    if (document.getElementById('loading-splash')) return

    // On the stacked layout space is how you page down the document, and the
    // speaker is on screen there anyway.
    if (isNarrow()) return

    // Only now, having decided to act: suppress the default scroll.
    e.preventDefault()
    toggle()
  })

  return {
    prime(): void {
      // Buffering a 3.6 MB file takes a moment; the cold open is exactly the
      // dead time to spend on it, so the track can start on cue rather than
      // stalling when it is finally asked for.
      try {
        bed.load()
      } catch {
        // Nothing to do — playback will simply buffer later instead.
      }
    },

    playExplosion(): void {
      if (muted) return

      const ctx = audioContext()
      // Before the first gesture the context is suspended, and scheduling into
      // a suspended context queues everything to fire at once when it resumes.
      if (!ctx || ctx.state !== 'running') return

      if (!noise) {
        // Two seconds of white noise, generated once. Long enough that varying
        // the playback rate never runs off the end.
        const frames = Math.floor(ctx.sampleRate * 2)
        noise = ctx.createBuffer(1, frames, ctx.sampleRate)
        const data = noise.getChannelData(0)
        for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1
      }

      const now = ctx.currentTime
      const length = 0.45 + Math.random() * 0.35

      const source = ctx.createBufferSource()
      source.buffer = noise
      source.playbackRate.value = 0.7 + Math.random() * 0.6

      /*
       * The downward sweep is what makes it read as distance rather than
       * static. A real report arrives as a crack that loses its top end almost
       * at once; holding the filter open just sounds like tape hiss.
       */
      const filter = ctx.createBiquadFilter()
      filter.type = 'lowpass'
      filter.frequency.setValueAtTime(1400 + Math.random() * 1200, now)
      filter.frequency.exponentialRampToValueAtTime(140, now + length)

      const gain = ctx.createGain()
      const peak = EXPLOSION_VOLUME * (0.6 + Math.random() * 0.4)
      gain.gain.setValueAtTime(0.0001, now)
      gain.gain.exponentialRampToValueAtTime(peak, now + 0.012)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + length)

      source.connect(filter).connect(gain).connect(ctx.destination)
      source.start(now)
      source.stop(now + length + 0.05)
    },

    startTrack(): void {
      wantsTrack = true
      tryStart()
    },
  }
}

/**
 * The original listed mp3 / m4a / ogg and let Howler pick. canPlayType is the
 * platform's version of the same question.
 */
function pickSource(): string {
  const probe = document.createElement('audio')
  if (probe.canPlayType('audio/mpeg')) return '/sound/odessa.mp3'
  if (probe.canPlayType('audio/mp4')) return '/sound/odessa.m4a'
  return '/sound/odessa.ogg'
}
