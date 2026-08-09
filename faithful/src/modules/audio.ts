/*
 * The ambient track — "odessa", the same recording the 2012 site played.
 *
 * The original used Howler 2.0.0 with a sprite map:
 *
 *   init:     [0,     50]
 *   firework: [0,   1900]
 *   full:     [0, 300015]
 *
 * All three start at 0, so they are the same audio played for different
 * durations: a tick, a 1.9 s stab under each firework, and the full
 * five-minute track. Two <audio> elements reproduce that without the library.
 *
 * Sequencing, which is the part that matters:
 *
 *   cold open      the file is fetched and decoded, so it is ready on time
 *   fireworks      short stabs under the first four bursts
 *   display ends   the track proper begins
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

const FIREWORK_MS = 1900

/*
 * When each stab fires, relative to the display starting. The original's
 * timings, unchanged.
 */
const STAB_DELAYS = [0, 1000, 1300, 1800] as const

/*
 * Louder than the bed, because the sprite is quieter than the music.
 *
 * The stabs play the track's first 1.9 s — that is what Howler's
 * `firework: [0, 1900]` sprite was. Measured, that opening averages -21.2 dBFS
 * against -13.1 for the body of the track, and it decays to -31 dB by 1.75 s.
 * At the bed's own 0.55 it is barely there.
 */
const STAB_VOLUME = 0.7

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
  /** Short stabs under the opening bursts. */
  playFireworkStabs(): void
  /** Start the track proper. Called when the firework display finishes. */
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
   * One element per stab, built and buffered during the cold open.
   *
   * Both halves of that matter, and the previous arrangement got both wrong.
   * It created a single element at the moment the display started and replayed
   * it by resetting currentTime, which meant the four stabs interrupted each
   * other instead of layering — and, worse, the element never buffered: live,
   * the first stab fired at readyState 0 and the rest at 1, so play() resolved
   * (playback *began*) while there was no decoded audio to emit. Restarting it
   * every 300 ms is what stopped it ever getting any. Nothing was audible.
   *
   * Separate elements can overlap, which is what Howler did with a sprite, and
   * loading them alongside the bed gives them the whole cold open to buffer.
   * They share one URL, so the browser fetches it once and serves the rest from
   * cache.
   */
  const stabs: HTMLAudioElement[] = []

  /*
   * The control reflects *intent*, not whether audio happens to be coming out
   * right now. The track is not due until the firework display ends, and a
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
    } else {
      // Deliberately does not set `wantsTrack`. Un-muting says "let me hear
      // it", not "skip the cue" — if the display is still running, the track
      // still waits for it.
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

      for (const _ of STAB_DELAYS) {
        const stab = new window.Audio()
        stab.src = bed.src
        stab.volume = STAB_VOLUME
        stab.preload = 'auto'
        try {
          stab.load()
        } catch {
          // As above.
        }
        stabs.push(stab)
      }
    },

    playFireworkStabs(): void {
      /*
       * Releasing is unconditional, and that is the point.
       *
       * Each of these holds a buffered copy of a five-minute track, loaded
       * during the cold open so it is ready on cue. Both mute paths used to
       * return without releasing anything — muted before the display, and muted
       * during it — so a visitor who turned the sound off kept four of them
       * attached for the life of the page. The one path that did release was
       * the one where they had already played.
       */
      const release = (stab: HTMLAudioElement): void => {
        stab.pause()
        // Drop the buffer rather than leaving a decoded copy of the track
        // parked for the life of the page.
        stab.removeAttribute('src')
        stab.load()
      }

      if (muted) {
        for (const stab of stabs) release(stab)
        stabs.length = 0
        return
      }

      STAB_DELAYS.forEach((delay, i) => {
        const stab = stabs[i]
        if (!stab) return

        setTimeout(() => {
          // Muted between priming and this stab's turn: nothing to play, but
          // still something to give back.
          if (muted) {
            release(stab)
            return
          }

          // No currentTime reset: each element is played once, from its own
          // start. Resetting is what made these interrupt one another.
          void stab.play().catch(() => undefined)

          setTimeout(() => release(stab), FIREWORK_MS)
        }, delay)
      })
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
