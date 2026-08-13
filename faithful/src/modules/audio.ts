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
 *   five minutes   it ends, and stays ended
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
 * The bus every report is mixed through.
 *
 * This is set from the whole display rather than from one shell, because the
 * dense middle is what runs out of headroom first: fifty rockets 190 ms apart,
 * each ringing for up to two seconds once its rumble is counted. Set it for a
 * single satisfying bang and the middle clips; set it so the middle survives
 * and a lone shell is inaudible. The compressor in makeBus() is what breaks
 * that trade — it leaves single reports alone and only leans on the pile-ups —
 * and it is the reason this number can be as high as it is.
 *
 * For scale: a typical report now peaks a little under the music bed's own
 * RMS at 0.55, so a shell reads about as loud as the music it will eventually
 * play under, and the full display peaks around 0.6 with no clipping.
 */
const EXPLOSION_VOLUME = 0.55

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

  /*
   * Once through, where the original looped forever.
   *
   * Five minutes of music is a long visit already, and a second lap says
   * nothing the first did not. When it ends the harbour is simply quiet, which
   * is the right ending for a scene that opens with fireworks.
   */
  bed.loop = false
  bed.volume = 0.55
  bed.preload = 'auto'
  bed.src = pickSource()

  /*
   * Nothing is remembered between visits, deliberately.
   *
   * Persisting this was what made silence permanent: the preference outlived
   * the visit that set it, so one stray space bar meant every future arrival
   * was mute, and on the desktop the icon that would undo it is not on screen
   * to be found. Both halves of that are now gone — the choice lasts as long
   * as the page does, and a reload always brings the sound back.
   *
   * It costs a returning visitor who genuinely wants silence one keypress.
   * That is the cheaper mistake by a long way: the other one is unrecoverable
   * without opening devtools, which is not a thing to ask of anybody.
   */
  let muted = false

  let playing = false
  let wantsTrack = false
  let armed = false

  /*
   * The reports are synthesised rather than sampled, so sixty of them cost a
   * few dozen nodes instead of sixty downloads. The previous arrangement
   * preloaded four copies of a five-minute track for four sounds nobody could
   * hear.
   *
   * One noise buffer is shared by every shell, and every burst reads a
   * different slice of it — see noiseBurst().
   */
  let ac: AudioContext | null = null
  let noise: AudioBuffer | null = null
  let bus: GainNode | null = null

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
  }

  button?.addEventListener('click', toggle)

  /*
   * On the desktop the speaker is not on screen at all — the original showed
   * it on touch devices only, and this reproduces that. Space is the control
   * there, along with Tab, which brings the real button into view (see the
   * :focus-visible rule in layout.css).
   *
   * Space being undiscoverable used to matter a great deal, because the choice
   * it made was written to localStorage: one stray press silenced every future
   * visit, with nothing on screen to undo it. Nothing is stored now and the
   * track stops on its own after one pass, so the worst a stray press can do
   * is mute the rest of this visit, and a reload undoes it.
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

      noise ??= makeNoise(ctx)
      bus ??= makeBus(ctx)

      /*
       * How far off this shell is: 0 overhead, 1 across the water. Everything
       * below is derived from it, because in life these qualities are not
       * independent — distance takes the top end off, softens the attack, drops
       * the level and lengthens the tail, all at once. Rolling them separately
       * is what makes synthesised repeats sound like one sound with a volume
       * knob on it; moving them together is most of the realism here.
       */
      const distance = Math.random()
      const near = 1 - distance

      /*
       * Somewhere across the water rather than dead centre. Two reports at the
       * same moment used to arrive at exactly the same place, which the ear
       * hears as one louder report; separated, they stay two.
       */
      const pan = typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : null
      if (pan) {
        pan.pan.value = (Math.random() * 2 - 1) * 0.7
        pan.connect(bus)
      }
      const dest: AudioNode = pan ?? bus

      // A few milliseconds of scatter, so shells fired together never land on
      // the same sample boundary and comb-filter each other.
      const at = ctx.currentTime + Math.random() * 0.03
      const body = 0.32 + distance * 0.45 + Math.random() * 0.25

      /*
       * The floor here is higher than distance alone would suggest, and it has
       * to be: a far shell is quietened twice over, once by this and again by
       * the filter below, which throws away most of the energy in the noise on
       * its way past. Scaling level honestly on top of that put the far quarter
       * of the display at a rendered peak of 0.005 — not distant, just missing
       * on any laptop speaker.
       */
      const level = 0.7 + near * 0.3

      // The report itself.
      noiseBurst(ctx, noise, dest, {
        at,
        length: body,
        level,
        from: 1100 + near * 1700,
        to: 130 + near * 80,
        attack: 0.005 + distance * 0.02,
        rate: 0.75 + Math.random() * 0.5,
      })

      /*
       * And the rumble coming back off the water and the buildings behind it,
       * which is most of what a distant firework actually sounds like. Later,
       * softer, longer, with nothing above a few hundred hertz left in it — and
       * more of it the further off the shell is.
       */
      noiseBurst(ctx, noise, dest, {
        at: at + 0.03 + distance * 0.07,
        length: body * 1.7 + distance * 0.8,
        level: level * (0.16 + distance * 0.34),
        from: 340,
        to: 95,
        attack: 0.05 + distance * 0.12,
        rate: 0.5 + Math.random() * 0.3,
      })

      // Close shells have a weight to them that filtered noise alone cannot
      // give: the thump arrives as pitch, not as hiss.
      if (near > 0.35) {
        thump(ctx, dest, {
          at,
          length: 0.16 + Math.random() * 0.1,
          level: level * 0.32,
          from: 58 + Math.random() * 26,
          to: 30,
        })
      }

      /*
       * Roughly one in five is a crackler — a scatter of small pops instead of
       * a single report. Without something like it the display is sixty
       * instances of one event, however carefully each is varied, and the ear
       * works that out quickly.
       */
      if (Math.random() < 0.22) {
        const pops = 5 + Math.floor(Math.random() * 5)
        for (let i = 0; i < pops; i++) {
          noiseBurst(ctx, noise, dest, {
            at: at + 0.06 + Math.random() * (0.3 + distance * 0.3),
            length: 0.03 + Math.random() * 0.04,
            level: level * (0.1 + Math.random() * 0.18),
            from: 1600 + near * 1800,
            to: 500,
            attack: 0.002,
            rate: 0.9 + Math.random() * 0.7,
          })
        }
      }
    },

    startTrack(): void {
      wantsTrack = true
      tryStart()
    },
  }
}

/**
 * The bus every report is mixed through, and the compressor that keeps the
 * dense part of the display from clipping.
 *
 * Fifty rockets go up 190 ms apart and each report rings for up to two seconds
 * once its rumble is counted, so ten of them can be sounding at once. Summed
 * flat, a level that suits one shell tears the middle of the display apart, and
 * a level that survives the middle leaves a single shell inaudible — which is
 * exactly the corner the first attempt at this painted itself into.
 *
 * The threshold sits above where any one report lands, so a lone shell passes
 * through untouched and keeps every bit of its range. Only the pile-ups are
 * pulled down, which is also what happens in the ear: a barrage does not sound
 * ten times a single bang.
 */
function makeBus(ctx: AudioContext): GainNode {
  const gain = ctx.createGain()
  gain.gain.value = EXPLOSION_VOLUME

  const comp = ctx.createDynamicsCompressor()
  comp.threshold.value = -6
  comp.knee.value = 4
  comp.ratio.value = 10
  comp.attack.value = 0.003
  comp.release.value = 0.2

  gain.connect(comp).connect(ctx.destination)
  return gain
}

/**
 * Three seconds of white noise, generated once and shared by every report.
 *
 * Long enough that a burst can start anywhere in the first second and still
 * have material left at the slowest playback rate.
 */
function makeNoise(ctx: AudioContext): AudioBuffer {
  const frames = Math.floor(ctx.sampleRate * 3)
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1
  return buffer
}

interface BurstOptions {
  /** When it starts, on the context clock. */
  at: number
  length: number
  /** Peak, before the shared bus takes it down to listening level. */
  level: number
  /** Lowpass cutoff at the attack, and at the end of the decay. */
  from: number
  to: number
  attack: number
  rate: number
}

/**
 * One filtered noise burst: the body of a report, its tail, or a single grain
 * of a crackle.
 *
 * The downward sweep is what makes it read as distance rather than static. A
 * real report arrives as a crack that loses its top end almost at once;
 * holding the filter open just sounds like tape hiss.
 */
function noiseBurst(ctx: AudioContext, buffer: AudioBuffer, dest: AudioNode, o: BurstOptions): void {
  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.playbackRate.value = o.rate

  /*
   * A different slice of the buffer every time, which is the difference
   * between varied and merely modulated.
   *
   * Every report used to begin at sample zero of the same noise, so however
   * much the filter and the level moved around, the grain underneath was
   * identical sixty times over — and the fine structure is exactly what the
   * ear latches onto as repetition. Reading from a random offset costs
   * nothing and there is no seam to hide, because it is noise.
   */
  const consumed = o.length * o.rate
  const offset = Math.random() * Math.max(0, buffer.duration - consumed - 0.05)

  const filter = ctx.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.setValueAtTime(o.from, o.at)
  filter.frequency.exponentialRampToValueAtTime(o.to, o.at + o.length)

  // Exponential ramps cannot touch zero, hence the floors.
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0.0001, o.at)
  gain.gain.exponentialRampToValueAtTime(Math.max(o.level, 0.0002), o.at + o.attack)
  gain.gain.exponentialRampToValueAtTime(0.0001, o.at + o.length)

  source.connect(filter).connect(gain).connect(dest)
  source.start(o.at, offset)
  source.stop(o.at + o.length + 0.05)
}

/** The low body of a near shell: a sine dropping in pitch as it decays. */
function thump(
  ctx: AudioContext,
  dest: AudioNode,
  o: { at: number; length: number; level: number; from: number; to: number },
): void {
  const osc = ctx.createOscillator()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(o.from, o.at)
  osc.frequency.exponentialRampToValueAtTime(o.to, o.at + o.length)

  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0.0001, o.at)
  gain.gain.exponentialRampToValueAtTime(Math.max(o.level, 0.0002), o.at + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, o.at + o.length)

  osc.connect(gain).connect(dest)
  osc.start(o.at)
  osc.stop(o.at + o.length + 0.05)
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
