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

  function reflect(): void {
    button?.setAttribute('aria-pressed', String(playing))
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
    if (playing) {
      bed.pause()
      playing = false
      muted = true
    } else {
      muted = false
      // Pressing the speaker is itself the gesture, and is also a request to
      // hear it now rather than waiting for a cue that may have passed.
      wantsTrack = true
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
   * Desktop has no speaker — the original showed it on touch devices only, and
   * this reproduces that. But the track starts on its own there, so leaving no
   * way at all to stop it would be worse than the clutter the icon caused.
   * Space mutes. Undiscoverable, which is the price of an uncluttered scene,
   * but it means nobody is stuck.
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

    playFireworkStabs(): void {
      if (muted) return

      for (const delay of [0, 1000, 1300, 1800]) {
        setTimeout(() => {
          if (muted) return
          const stab = new window.Audio(bed.src)
          stab.volume = 0.4
          void stab.play().catch(() => undefined)
          setTimeout(() => stab.pause(), FIREWORK_MS)
        }, delay)
      }
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
