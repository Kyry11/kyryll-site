/*
 * The contact form, and the two ways it comes apart.
 *
 * Send  -> the form folds itself into an envelope, one panel at a time, then
 *          flies off screen on a looping bezier.
 * Shatter -> all 25 tiles launch as independent ballistic projectiles.
 *
 * Both work the same way as the original: the fieldset is cloned into an NxN
 * grid of absolutely-positioned copies, each clipped to its own cell, so the
 * assembled grid is indistinguishable from the intact form until the pieces
 * start moving. The original drove them with jQuery.animate plus GSAP's
 * TweenMax (bezier + autoRotate); these use the Web Animations API.
 *
 * Two things did change, both because the original no longer works:
 *
 *  - It sent a GET to https://email.kyryll.com/v1/send with the message in the
 *    query string. That host stopped resolving, so the form has been dead for
 *    years. It now POSTs JSON to /api/contact — see api/contact/.
 *
 *  - Every section change also called that endpoint, emailing a "logged event"
 *    with a visitor id, visit count, first-visit date and full IP chain. That
 *    beacon is gone entirely; nothing is sent unless the visitor presses Send.
 */

import { $, $$, isNarrow, prefersReducedMotion, rand, wait } from './dom'

const ENDPOINT = '/api/contact'

const ENVELOPE_GRID = 3
const SHATTER_GRID = 5

export function setupContactForm(): void {
  const form = $<HTMLFormElement>('#contactform')
  const fieldset = $<HTMLFieldSetElement>('#contactfieldset')
  const status = $('#tipsSendMail')
  const cancel = $<HTMLButtonElement>('#cancel')

  if (!form || !fieldset || !status) return

  // Enter moves to the next field rather than submitting, as it did before.
  for (const field of $$<HTMLInputElement>('input', form)) {
    field.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return
      const fields = $$<HTMLElement>('input, textarea', form)
      const next = fields[fields.indexOf(field) + 1]
      if (next) {
        e.preventDefault()
        next.focus()
      }
    })
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault()
    void send(form, fieldset, status)
  })

  cancel?.addEventListener('click', () => {
    if (isNarrow() || prefersReducedMotion()) {
      resetForm(form, fieldset, status)
      return
    }
    void shatter(form, fieldset).then(() => resetForm(form, fieldset, status))
  })
}

/* ---- submit ------------------------------------------------------------- */

async function send(
  form: HTMLFormElement,
  fieldset: HTMLFieldSetElement,
  status: HTMLElement,
): Promise<void> {
  const invalid = firstInvalidField(form)
  if (invalid) {
    flagInvalid(invalid, status)
    return
  }

  const submit = $<HTMLButtonElement>('#submit', form)
  if (submit) submit.disabled = true
  status.textContent = 'Sending…'

  const data = Object.fromEntries(new FormData(form).entries())

  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    })

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as
        | { message?: string; field?: string }
        | null

      // The server names the offending field when it can, so the same rumble
      // the original used for client-side errors applies to server ones too.
      const field = body?.field
        ? $<HTMLInputElement | HTMLTextAreaElement>(`#${CSS.escape(body.field)}`, form)
        : null

      if (field) {
        status.textContent = body?.message ?? ''
        field.setAttribute('data-invalid', '')
        field.focus()
        field.addEventListener('input', () => field.removeAttribute('data-invalid'), { once: true })
      } else {
        status.textContent = body?.message ?? 'Could not reach the server'
      }

      if (submit) submit.disabled = false
      return
    }

    /*
     * The server's own words, not a hardcoded success line. It answers 202 when
     * the send was accepted but Azure had not confirmed delivery inside the
     * request budget, and saying "has been sent" there would be a guess
     * presented as a fact.
     */
    const body = (await response.json().catch(() => null)) as { message?: string } | null
    status.textContent = body?.message ?? 'Message has been sent, I will get back to you sooon'

    if (isNarrow() || prefersReducedMotion()) {
      await wait(1200)
      resetForm(form, fieldset, status)
    } else {
      await foldIntoEnvelope(form, fieldset)
      resetForm(form, fieldset, status)
    }
  } catch {
    status.textContent = 'Could not reach the server'
  } finally {
    if (submit) submit.disabled = false
  }
}

function firstInvalidField(form: HTMLFormElement): HTMLInputElement | HTMLTextAreaElement | null {
  for (const field of $$<HTMLInputElement | HTMLTextAreaElement>('input, textarea', form)) {
    if (!field.checkValidity()) return field
  }
  return null
}

function flagInvalid(field: HTMLInputElement | HTMLTextAreaElement, status: HTMLElement): void {
  status.textContent = field.validationMessage
  field.setAttribute('data-invalid', '')
  field.focus()

  const clear = (): void => {
    field.removeAttribute('data-invalid')
    status.textContent = ''
  }

  field.addEventListener('input', clear, { once: true })
  field.addEventListener('blur', clear, { once: true })
  setTimeout(clear, 5000)
}

function resetForm(
  form: HTMLFormElement,
  fieldset: HTMLFieldSetElement,
  status: HTMLElement,
): void {
  for (const tile of $$('.clipped', form)) tile.remove()
  form.reset()
  fieldset.removeAttribute('data-hidden')
  fieldset.style.opacity = '1'
  status.textContent = ''
}

/* ---- tiling ------------------------------------------------------------- */

interface Grid {
  tiles: HTMLElement[]
  cellWidth: number
  cellHeight: number
}

/**
 * Clones the fieldset into an NxN grid of clipped copies stacked over it.
 *
 * The original used the `clip` property, which has been deprecated since 2015;
 * `clip-path: inset()` is the replacement and takes its insets from the
 * opposite edges, hence the arithmetic.
 */
function tileForm(form: HTMLFormElement, fieldset: HTMLFieldSetElement, n: number): Grid {
  const width = form.offsetWidth
  const height = form.offsetHeight
  const cellWidth = width / n
  const cellHeight = height / n

  const markup = fieldset.innerHTML
  const tiles: HTMLElement[] = []

  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const top = row * cellHeight
      const left = col * cellWidth

      const tile = document.createElement('div')
      tile.className = 'clipped'
      tile.innerHTML = markup
      tile.style.width = `${width}px`
      tile.style.height = `${height}px`
      tile.style.clipPath = `inset(${top}px ${width - (left + cellWidth)}px ${height - (top + cellHeight)}px ${left}px)`

      // The clones are decoration. Duplicated ids and focusable controls in a
      // flying tile would be both invalid and reachable by tab.
      tile.setAttribute('aria-hidden', 'true')
      tile.inert = true
      for (const el of Array.from(tile.querySelectorAll('[id]'))) el.removeAttribute('id')

      // Carry the typed values across, so the tiles show the real message.
      copyValues(fieldset, tile)

      form.appendChild(tile)
      tiles.push(tile)
    }
  }

  fieldset.setAttribute('data-hidden', '')

  return { tiles, cellWidth, cellHeight }
}

function copyValues(source: HTMLElement, target: HTMLElement): void {
  const from = $$<HTMLInputElement | HTMLTextAreaElement>('input, textarea', source)
  const to = $$<HTMLInputElement | HTMLTextAreaElement>('input, textarea', target)

  from.forEach((field, i) => {
    const clone = to[i]
    if (!clone) return
    if (clone instanceof HTMLTextAreaElement) {
      clone.textContent = field.value
    }
    clone.value = field.value
  })
}

/* ---- send: fold into an envelope --------------------------------------- */

/*
 * Cell indices in the 3x3 grid:
 *
 *   0 1 2
 *   3 4 5
 *   6 7 8
 *
 * Cell 4 is the envelope face; everything else folds onto it in five moves,
 * with the face swapping to the next flap plate between each.
 */
const FOLD_STEPS: ReadonlyArray<{
  cells: number[]
  axis: 'X' | 'Y'
  degrees: number
  origin: (w: number, h: number) => string
  duration: number
  /** Plate to show on the envelope face once this step lands. */
  plate?: string
}> = [
  { cells: [2],    axis: 'X', degrees: -180, origin: (_w, h) => `50% ${h}px 0`,     duration: 1000 },
  { cells: [5, 8], axis: 'Y', degrees: -180, origin: (w) => `${2 * w}px 50% 0`,     duration: 500, plate: '/img/envelope-flap-1.png' },
  { cells: [6, 7], axis: 'X', degrees:  180, origin: (_w, h) => `50% ${2 * h}px 0`, duration: 500, plate: '/img/envelope-flap-2.png' },
  { cells: [0, 3], axis: 'Y', degrees:  180, origin: (w) => `${w}px 50% 0`,         duration: 500, plate: '/img/envelope-flap-3.png' },
  { cells: [1],    axis: 'X', degrees: -180, origin: (_w, h) => `50% ${h}px 0`,     duration: 500, plate: '/img/envelope-full.png' },
]

async function foldIntoEnvelope(form: HTMLFormElement, fieldset: HTMLFieldSetElement): Promise<void> {
  const { tiles, cellWidth, cellHeight } = tileForm(form, fieldset, ENVELOPE_GRID)
  const face = tiles[4]

  for (const step of FOLD_STEPS) {
    const folding = step.cells
      .map((i) => tiles[i])
      .filter((tile): tile is HTMLElement => tile !== undefined)

    await Promise.all(
      folding.map((tile) => {
        tile.style.transformOrigin = step.origin(cellWidth, cellHeight)
        const anim = tile.animate(
          [{ transform: 'none' }, { transform: `rotate${step.axis}(${step.degrees}deg)` }],
          { duration: step.duration, easing: 'cubic-bezier(0.6, 0.04, 0.98, 0.34)', fill: 'forwards' },
        )
        return settled(anim, step.duration).then(() => tile.remove())
      }),
    )

    if (step.plate && face) showPlate(face, step.plate, cellWidth, cellHeight)
  }

  if (face) {
    await wait(500)
    await flyAway(face)
    face.remove()
  }
}

function showPlate(face: HTMLElement, src: string, cellWidth: number, cellHeight: number): void {
  face.replaceChildren()
  face.setAttribute('data-envelope', '')
  face.style.clipPath = 'none'
  face.style.width = `${cellWidth}px`
  face.style.height = `${cellHeight}px`
  face.style.marginLeft = `${cellWidth}px`
  face.style.marginTop = `${cellHeight}px`
  face.style.backgroundImage = `url(${src})`
}

/**
 * The flight path. GSAP tweened a 7-point bezier with curviness 1.25 and
 * autoRotate; these are the same waypoints as keyframes, with the rotation
 * baked in per point rather than derived from the tangent.
 */
/**
 * Resolves when the animation finishes — or when its nominal duration has
 * elapsed, whichever comes first.
 *
 * Animation timelines freeze while a document is not being rendered, so
 * `finished` alone never settles in a backgrounded tab. dom.ts avoids awaiting
 * it at all for that reason; here the animations are genuinely worth watching,
 * so they are still driven by the compositor and merely backstopped. Without
 * this, submitting the form and switching tabs left the fieldset hidden and the
 * tiles frozen mid-flight until you came back.
 */
function settled(anim: Animation, duration: number): Promise<void> {
  return Promise.race([
    anim.finished.then(() => undefined).catch(() => undefined),
    wait(duration + 120),
  ])
}

function flyAway(face: HTMLElement): Promise<void> {
  const frames = [
    { x: 100,             y: 100,             rx: 0,             ry: 0 },
    { x: 500,             y: -50,             rx: rand(-30, 30), ry: rand(-5, 5) },
    { x: rand(420, 560),  y: rand(0, 100),    rx: rand(-5, 5),   ry: rand(-10, 10) },
    { x: 400,             y: -50,             rx: rand(-25, 25), ry: rand(-10, 10) },
    { x: 300,             y: -70,             rx: rand(-5, 5),   ry: rand(-5, 5) },
    { x: 400,             y: -100,            rx: rand(-15, 15), ry: rand(-5, 5) },
    { x: 1600,            y: rand(-300, 1200), rx: 5,            ry: 10 },
  ]

  face.style.transformOrigin = '50% 50%'

  const duration = rand(7, 15) * 1000

  const anim = face.animate(
    frames.map((f) => ({
      transform: `translate(${f.x}px, ${f.y}px) rotateX(${f.rx}deg) rotateY(${f.ry}deg)`,
    })),
    { duration, easing: 'ease-in-out', fill: 'forwards' },
  )

  return settled(anim, duration)
}

/* ---- cancel: shatter ---------------------------------------------------- */

/**
 * Every tile becomes a projectile: launched at 90-120 units/s at 80-89
 * degrees, left, right, or straight up, then pulled back down by gravity.
 *
 * The original stepped this in a setInterval per tile — 25 concurrent 10 ms
 * timers, each writing `bottom` and `left` — which meant 2500 layout-affecting
 * style writes a second. Same trajectory, one rAF loop, transforms only.
 */
function shatter(form: HTMLFormElement, fieldset: HTMLFieldSetElement): Promise<void> {
  const { tiles } = tileForm(form, fieldset, SHATTER_GRID)

  const gravity = -9.8
  const totalTime = 20

  const projectiles = tiles.map((tile) => {
    const speed = rand(90, 120)
    const theta = (rand(80, 89) * Math.PI) / 180
    // Left, right, or straight up.
    const direction = [1, -1, 0][Math.floor(Math.random() * 3)] ?? 0

    tile.style.transform =
      `scale(${rand(90, 110) / 100}) skew(${rand(-5, 10)}deg) rotateZ(${rand(5, 30)}deg)`

    return { tile, speed, theta, direction }
  })

  return new Promise((resolve) => {
    const start = performance.now()
    let finished = false

    const done = (): void => {
      if (finished) return
      finished = true
      resolve()
    }

    // Same reasoning as settled(): rAF does not run in a hidden tab, and
    // without this the form would never be restored. The flight covers
    // `totalTime` units at ten per second, so two seconds plus a margin.
    setTimeout(done, (totalTime / 10) * 1000 + 400)

    const step = (now: number): void => {
      if (finished) return

      // The original advanced t by 0.10 every 10 ms — ten time units per real
      // second — so the 20-unit flight lasts two seconds.
      const t = ((now - start) / 1000) * 10

      for (const { tile, speed, theta, direction } of projectiles) {
        const ux = Math.cos(theta) * speed * direction
        const uy = Math.sin(theta) * speed - -gravity * t

        const x = ux * t
        const y = uy * t + 0.5 * gravity * t * t

        // `bottom` in the original, so positive y is upward.
        tile.style.translate = `${x}px ${-y}px`
      }

      if (t <= totalTime) requestAnimationFrame(step)
      else done()
    }

    requestAnimationFrame(step)
  })
}
