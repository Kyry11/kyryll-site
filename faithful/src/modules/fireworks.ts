/*
 * Fireworks over the Harbour Bridge.
 *
 * A canvas particle system: rockets accelerate toward a target point, and on
 * arrival burst into 150 trailing, decaying, wind-blown sparks. The launch
 * window is deliberately the right-hand third of the viewport — that is where
 * the bridge sits in bg1.jpg, which is the entire point of the effect.
 *
 * Clicking the sky launches one at that point, and dragging trails them from
 * the bottom of the screen — the canvas is interactive, exactly as it was.
 *
 * Ported from the 2012 fireworks.js. Three things differ, all deliberate and
 * all noted where they happen:
 *
 *   - the tuning constants are slower, so the display can be watched rather
 *     than merely noticed (see the TUNING block below, which lists the
 *     originals alongside)
 *   - the frame loop sleeps when the sky is empty instead of running forever,
 *     which is what lets the canvas stay for the life of the page — and it
 *     must stay, or clicking the sky would stop working once the opening
 *     display finished
 *   - sparks blown off screen are now destroyed. In the original `p.radius`
 *     was never assigned, so the offscreen test compared against NaN and
 *     always passed; particles died only by alpha decay, and one blown above
 *     the top of the window could fall back into view
 */

import { isNarrow, rand } from './dom'

interface Particle {
  x: number
  y: number
  trail: Array<{ x: number; y: number }>
  angle: number
  speed: number
  friction: number
  gravity: number
  hue: number
  brightness: number
  alpha: number
  decay: number
  wind: number
  lineWidth: number
  radius: number
}

interface Rocket {
  x: number
  y: number
  startX: number
  startY: number
  targetX: number
  targetY: number
  hitX: boolean
  hitY: boolean
  trail: Array<{ x: number; y: number }>
  speed: number
  angle: number
  shockwaveAngle: number
  acceleration: number
  hue: number
  brightness: number
  alpha: number
  lineWidth: number
}

/*
 * Tuning.
 *
 * Slower than the 2012 values, deliberately. The original's rockets reached
 * their burst point in well under a second and the sparks were gone almost as
 * fast — you registered that fireworks had happened rather than watching any.
 * Rockets now climb at roughly half speed, sparks carry further before
 * gravity takes them, and they fade out over about twice as long.
 *
 * Original values kept alongside for reference.
 */
const PART_COUNT = 150
const PART_SPEED = 4               // was 5
const PART_SPEED_VARIANCE = 8      // was 10
const PART_WIND = 50
const PART_FRICTION = 3            // was 5 — less drag, so they drift further
const PART_GRAVITY = 0.55          // was 1
const PART_DECAY_MIN = 5           // was 10
const PART_DECAY_MAX = 26          // was 50
const HUE_VARIANCE = 30
const FWORK_SPEED = 2.2            // was 4
const FWORK_ACCEL = 5              // was 10
const FLICKER_DENSITY = 25
const CLEAR_ALPHA = 16             // was 25 — longer trails
const LINE_WIDTH = 1

/** Gap between rockets in the opening display. The original used 100 ms. */
const DISPLAY_INTERVAL_MS = 190

/** How far left of the bridge the second cluster sits. From the original. */
const CITY_OFFSET_X = 500

/**
 * Frames to keep drawing after the last spark dies.
 *
 * The loop fades the previous frame rather than clearing it, which is what
 * leaves the trails — so the canvas is still holding a ghost for a while after
 * nothing is left to simulate. Sleeping immediately would freeze that ghost on
 * screen.
 */
const SETTLE_FRAMES = 90

export function startFireworks(onDisplayEnd?: () => void): () => void {
  const canvas = document.createElement('canvas')
  canvas.id = 'fireworks'
  Object.assign(canvas.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    zIndex: '25',
    // Interactive: clicking the sky launches a firework at that point. See
    // setInteractive below for why this is conditional.
    pointerEvents: 'auto',
    touchAction: 'none',
  } satisfies Partial<CSSStyleDeclaration>)

  const context = canvas.getContext('2d')
  if (!context) {
    onDisplayEnd?.()
    return () => undefined
  }

  // Bound to a separate const so the null check survives into the closures
  // below, which are what actually do the drawing.
  const ctx: CanvasRenderingContext2D = context

  let cw = 0
  let ch = 0

  /*
   * Measured from documentElement first: a window that has not been laid out
   * yet reports innerWidth 0, and a 0x0 canvas has no hit area at all — it
   * would take no clicks and draw nothing, silently, for the life of the page.
   */
  function sizeCanvas(): boolean {
    const w = document.documentElement.clientWidth || window.innerWidth
    const h = document.documentElement.clientHeight || window.innerHeight
    if (w === cw && h === ch) return false

    cw = canvas.width = w
    ch = canvas.height = h
    // Resizing a canvas resets its context state.
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    return true
  }

  sizeCanvas()
  document.body.appendChild(canvas)

  const particles: Particle[] = []
  const rockets: Rocket[] = []
  let currentHue = 30

  let resizeTimer = 0
  const onResize = (): void => {
    window.clearTimeout(resizeTimer)
    resizeTimer = window.setTimeout(sizeCanvas, 100)
  }
  window.addEventListener('resize', onResize, { passive: true })

  /**
   * Launch from the bridge, to a point picked over the bridge. This is the
   * unattended display.
   */
  function launch(offsetX = 0): void {
    // The bridge occupies roughly the right third of the background plate.
    const left = (cw / 3) * 2 - 150
    const right = cw - 150

    const startX = rand(left, right)
    const startY = ch
    const targetY = rand(50, ch / 2) - 50
    const targetX = startX - left < right - startX ? rand(left, startX) : rand(startX, right)

    launchFrom(startX + offsetX, startY, targetX + offsetX, targetY)
  }

  /**
   * The second cluster, over the city rather than the bridge.
   *
   * The original fired one of these for every fifth rocket of the display,
   * offset 500px to the left and aimed 100px lower — so the finale played out
   * across two parts of the skyline at once. An earlier pass here dropped it
   * silently while repurposing that `i % 5` branch to cycle the hue.
   */
  function launchOverCity(): void {
    launch(-CITY_OFFSET_X)
  }

  /**
   * Launch at a point the visitor chose.
   *
   * The original's mousedown fired from a random spot along the bridge to
   * wherever you clicked; dragging then fired from the bottom centre of the
   * screen, following the pointer, with a fresh hue for every move. Both are
   * preserved.
   */
  function launchAt(x: number, y: number, from: 'bridge' | 'centre'): void {
    // clientX/clientY, not pageX/pageY. The canvas is position: fixed at the
    // origin, so viewport coordinates are already canvas coordinates at any
    // scroll offset. The original used pageX/pageY, which only agreed with
    // that because the page happened to be at scroll 0 whenever anyone
    // clicked — scrolled, its fireworks would have landed off-target.
    currentHue = rand(0, 360)

    const startX = from === 'bridge' ? rand((cw / 3) * 2 - 150, cw - 150) : cw / 2

    launchFrom(startX, ch, x, y)
  }

  function launchFrom(startX: number, startY: number, targetX: number, targetY: number): void {
    // Cheap, and covers a canvas that was built before the window had a size.
    if (cw === 0 || ch === 0) sizeCanvas()
    ensureRunning()

    rockets.push({
      x: startX,
      y: startY,
      startX,
      startY,
      targetX,
      targetY,
      hitX: false,
      hitY: false,
      trail: [
        { x: startX, y: startY },
        { x: startX, y: startY },
        { x: startX, y: startY },
      ],
      speed: FWORK_SPEED,
      angle: Math.atan2(targetY - startY, targetX - startX),
      shockwaveAngle: Math.atan2(targetY - startY, targetX - startX) + 90 * (Math.PI / 180),
      acceleration: FWORK_ACCEL / 100,
      hue: currentHue,
      brightness: rand(50, 80),
      alpha: rand(50, 100) / 100,
      lineWidth: LINE_WIDTH,
    })
  }

  function burst(x: number, y: number, hue: number): void {
    for (let i = 0; i < PART_COUNT; i++) {
      particles.push({
        x,
        y,
        trail: [
          { x, y },
          { x, y },
          { x, y },
        ],
        angle: rand(0, 360),
        speed: rand(Math.max(1, PART_SPEED - PART_SPEED_VARIANCE), PART_SPEED + PART_SPEED_VARIANCE),
        friction: 1 - PART_FRICTION / 100,
        gravity: PART_GRAVITY / 2,
        hue: rand(hue - HUE_VARIANCE, hue + HUE_VARIANCE),
        brightness: rand(50, 80),
        alpha: rand(40, 100) / 100,
        decay: rand(PART_DECAY_MIN, PART_DECAY_MAX) / 1000,
        wind: (rand(0, PART_WIND) - PART_WIND / 2) / 25,
        lineWidth: LINE_WIDTH,
        radius: 1,
      })
    }
  }

  function shiftTrail(trail: Array<{ x: number; y: number }>, x: number, y: number): void {
    const [a, b, c] = trail
    if (!a || !b || !c) return
    c.x = b.x; c.y = b.y
    b.x = a.x; b.y = a.y
    a.x = x;   a.y = y
  }

  function updateRockets(): void {
    for (let i = rockets.length - 1; i >= 0; i--) {
      const f = rockets[i]
      if (!f) continue

      const vx = Math.cos(f.angle) * f.speed
      const vy = Math.sin(f.angle) * f.speed
      f.speed *= 1 + f.acceleration

      shiftTrail(f.trail, f.x, f.y)

      // Approach the target from whichever side the rocket started on.
      if (f.startX >= f.targetX ? f.x + vx <= f.targetX : f.x + vx >= f.targetX) {
        f.x = f.targetX
        f.hitX = true
      } else {
        f.x += vx
      }

      if (f.startY >= f.targetY ? f.y + vy <= f.targetY : f.y + vy >= f.targetY) {
        f.y = f.targetY
        f.hitY = true
      } else {
        f.y += vy
      }

      if (f.hitX && f.hitY) {
        burst(f.targetX, f.targetY, f.hue)
        rockets.splice(i, 1)
      }
    }
  }

  function updateParticles(): void {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i]
      if (!p) continue

      const radians = (p.angle * Math.PI) / 180
      const vx = Math.cos(radians) * p.speed
      const vy = Math.sin(radians) * p.speed
      p.speed *= p.friction

      shiftTrail(p.trail, p.x, p.y)

      p.x += vx
      p.y += vy + p.gravity
      p.angle += p.wind
      p.alpha -= p.decay

      const offscreen =
        p.x + p.radius < 0 || p.x - p.radius > cw || p.y + p.radius < 0 || p.y - p.radius > ch

      if (offscreen || p.alpha < 0.05) particles.splice(i, 1)
    }
  }

  function drawRockets(): void {
    ctx.globalCompositeOperation = 'lighter'

    for (const f of rockets) {
      ctx.lineWidth = f.lineWidth

      const from = f.trail[rand(0, 2)] ?? f.trail[0]
      if (!from) continue

      ctx.beginPath()
      ctx.moveTo(Math.round(from.x), Math.round(from.y))
      ctx.lineTo(Math.round(f.x), Math.round(f.y))
      ctx.closePath()
      ctx.strokeStyle = `hsla(${f.hue}, 100%, ${f.brightness}%, ${f.alpha})`
      ctx.stroke()

      // The bow wave ahead of the rocket.
      ctx.save()
      ctx.translate(Math.round(f.x), Math.round(f.y))
      ctx.rotate(f.shockwaveAngle)
      ctx.beginPath()
      ctx.arc(0, 0, f.speed / 5, 0, Math.PI, true)
      ctx.strokeStyle = `hsla(${f.hue}, 100%, ${f.brightness}%, ${rand(25, 60) / 100})`
      ctx.lineWidth = f.lineWidth
      ctx.stroke()
      ctx.restore()
    }
  }

  function drawParticles(): void {
    for (const p of particles) {
      const from = p.trail[rand(0, 2)] ?? p.trail[0]
      if (!from) continue

      ctx.beginPath()
      ctx.moveTo(Math.round(from.x), Math.round(from.y))
      ctx.lineTo(Math.round(p.x), Math.round(p.y))
      ctx.closePath()
      ctx.strokeStyle = `hsla(${p.hue}, 100%, ${p.brightness}%, ${p.alpha})`
      ctx.stroke()

      // Occasional bright flecks, so the sparks twinkle rather than streak.
      const inverseDensity = 50 - FLICKER_DENSITY
      if (rand(0, inverseDensity) === inverseDensity) {
        ctx.beginPath()
        ctx.arc(Math.round(p.x), Math.round(p.y), rand(p.lineWidth, p.lineWidth + 3) / 2, 0, Math.PI * 2, false)
        ctx.closePath()
        ctx.fillStyle = `hsla(${p.hue}, 100%, ${p.brightness}%, ${rand(50, 100) / 100})`
        ctx.fill()
      }
    }
  }

  let frame = 0
  let idle = true
  let launchesScheduled = false
  let displayEnded = false

  /*
   * The canvas has to outlive the opening display, because clicking the sky
   * launches a firework and that has to keep working. The original simply ran
   * its frame loop forever; instead this sleeps once the sky is empty and
   * wakes on the next launch, so an idle page costs nothing.
   */
  let settle = SETTLE_FRAMES

  const loop = (): void => {
    // Fade the previous frame rather than clearing it — this is what leaves
    // the trails behind the sparks.
    ctx.globalCompositeOperation = 'destination-out'
    ctx.fillStyle = `rgba(0, 0, 0, ${CLEAR_ALPHA / 100})`
    ctx.fillRect(0, 0, cw, ch)

    updateRockets()
    updateParticles()
    drawRockets()
    drawParticles()

    if (rockets.length > 0 || particles.length > 0) {
      settle = SETTLE_FRAMES
    } else if (--settle <= 0) {
      // The sky is empty and the trails have gone. If that is the end of the
      // opening display rather than a lull between clicks, say so once — the
      // ambient track waits on this.
      if (launchesScheduled && !displayEnded) {
        displayEnded = true
        onDisplayEnd?.()
      }

      // Nothing left to draw and the trails have faded out. Sleep.
      idle = true
      ctx.clearRect(0, 0, cw, ch)
      return
    }

    frame = requestAnimationFrame(loop)
  }

  function ensureRunning(): void {
    settle = SETTLE_FRAMES
    if (!idle) return
    idle = false
    // No document.hidden check: the browser already declines to fire rAF in a
    // hidden tab, so scheduling costs nothing and the loop simply resumes when
    // the tab comes back. Gating on it here instead left launches queued with
    // no loop to draw them, recoverable only via a visibilitychange that some
    // embedded views never fire.
    frame = requestAnimationFrame(loop)
  }

  /* ---- clicking the sky -------------------------------------------------- */

  /*
   * The canvas sits at z-index 25 and covers the viewport, so it catches
   * clicks on the sky while everything above it — the content column at 70,
   * the treeline at 100, the sound toggle at 120 — goes on receiving its own.
   * That layering is why the original could get away with this.
   *
   * Only on the composed desktop layout though. Below the stage width the page
   * scrolls normally, and a full-viewport element swallowing touch moves would
   * make it feel broken.
   */
  function setInteractive(): void {
    canvas.style.pointerEvents = isNarrow() ? 'none' : 'auto'
  }

  setInteractive()

  /*
   * A plain drag flag rather than pointer capture. The canvas already covers
   * the whole viewport so there is nothing to capture *from*, and
   * setPointerCapture throws if the pointer is no longer active — an exception
   * thrown out of a pointerdown handler for no benefit.
   */
  let dragging = false

  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return
    dragging = true
    launchAt(e.clientX, e.clientY, 'bridge')
  }

  // Dragging trails fireworks from the bottom centre, as the original did.
  const onPointerMove = (e: PointerEvent): void => {
    if (!dragging) return
    launchAt(e.clientX, e.clientY, 'centre')
  }

  const endDrag = (): void => {
    dragging = false
  }

  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  // On window, so releasing outside the canvas still ends the drag.
  window.addEventListener('pointerup', endDrag)
  window.addEventListener('pointercancel', endDrag)

  /* ---- the opening display ----------------------------------------------- */

  const timers: number[] = []

  // Opening salvo: ten rockets at once, a second in — the original delayed
  // these too, and firing them synchronously made the show start early.
  timers.push(
    window.setTimeout(() => {
      for (let i = 0; i < 10; i++) launch()
    }, 1000),
  )

  // Then fifty more.
  timers.push(
    window.setTimeout(() => {
      for (let i = 0; i < 50; i++) {
        timers.push(
          window.setTimeout(() => {
            // The original re-rolled the hue for every rocket, not every fifth.
            currentHue = rand(0, 360)
            launch()

            // And every fifth one was doubled, over the city.
            if (i % 5 === 0) launchOverCity()

            // Last one away: from here, an empty sky means the display is over.
            if (i === 49) launchesScheduled = true
          }, i * DISPLAY_INTERVAL_MS),
        )
      }
    }, 1000),
  )

  // As with the flock's stop(): nothing calls this, because the canvas has to
  // outlive the display for the click-to-launch to keep working. Unexercised.
  const stop = (): void => {
    cancelAnimationFrame(frame)
    idle = true
    for (const t of timers) window.clearTimeout(t)
    window.clearTimeout(resizeTimer)
    window.removeEventListener('resize', onResize)
    window.removeEventListener('resize', setInteractive)
    window.removeEventListener('pointerup', endDrag)
    window.removeEventListener('pointercancel', endDrag)
    document.removeEventListener('visibilitychange', onVisibility)
    canvas.remove()
  }

  const onVisibility = (): void => {
    if (document.hidden) {
      cancelAnimationFrame(frame)
      idle = true
    } else if (rockets.length > 0 || particles.length > 0 || (launchesScheduled && !displayEnded)) {
      /*
       * Also restarts when the sky is already empty but the display has not
       * been declared over. Hiding the tab inside the ~1.5 s settle window
       * cancelled the loop with both arrays empty, so nothing ever set
       * displayEnded — and the ambient track, which waits on that callback,
       * never started for the rest of the session.
       */
      ensureRunning()
    }
  }

  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('resize', setInteractive, { passive: true })

  return stop
}
