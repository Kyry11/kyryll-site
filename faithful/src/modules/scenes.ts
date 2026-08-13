/*
 * The cloud layer drifting against the scroll.
 *
 * Original:
 *   $(window).on("scroll", function () { clouds.style.backgroundPosition = ... })
 *
 * Same maths, two changes. The handler is passive so it can never block
 * scrolling, and the write is deferred to the next animation frame instead of
 * happening inline — a scroll event can fire several times per frame, and each
 * inline write to backgroundPosition forced a synchronous style recalc.
 */

import { prefersReducedMotion } from './dom'

/** Height of one cloud tile, in pixels. */
const TILE_HEIGHT = 500

/** Width of bg-clouds.png. A drift of exactly this repeats seamlessly. */
const TILE_WIDTH = 1650

/*
 * How far down the stack the band pattern repeats.
 *
 * Direction alternates every band and the drift speed cycles every three, so
 * band i and band i + 6 are identical in every respect: same direction, same
 * duration, and — since they all start together — the same phase. Six bands is
 * therefore the shortest distance the layer can be shifted by without anything
 * changing on screen, which is the property the wrap below needs.
 */
const PATTERN_BANDS = 6
const WRAP_HEIGHT = PATTERN_BANDS * TILE_HEIGHT

/*
 * How many bands of cloud to build.
 *
 * Enough to cover the stage at both ends of the wrap. The stage is 4000px and
 * the layer sits between 0 and one wrap height above it, so the stack has to
 * span 4000 + 3000 for the bottom of the last scene to still have cloud over
 * it at the moment the offset is furthest up. Cheap: each band is one element
 * with a repeating background and a compositor-driven transform.
 */
const CLOUD_BANDS = 14

/** Scroll-to-drift ratio. Below 1 the clouds outrun the page. */
const SPEED_RATIO = 0.4

/*
 * Where the layer sits for a given scroll position.
 *
 * The wrap used to be `% (TILE_HEIGHT + 1)`, straight from the 2012 code, and
 * it was harmless there: every row of cloud was one repeating background, so
 * shifting the layer by a tile height put an indistinguishable row in each
 * row's place. The rows are no longer indistinguishable. Each drifts its own
 * way at its own rate, so a one-tile shift swaps every row for a differently
 * offset one — a visible jump, and there are fifteen of them across the stage,
 * five inside every scene change.
 *
 * Wrapping on the pattern's own period instead makes the shift a genuine
 * no-op: band i lands exactly where band i + 6 was, showing the same pixels.
 *
 * Fractional, where the original floored. Scene changes are eased tweens that
 * move the page by well under a pixel per frame at each end, and rounding the
 * offset there turns the arrival into a series of small steps.
 */
function cloudOffset(scrollPosition: number): number {
  return -((scrollPosition / SPEED_RATIO) % WRAP_HEIGHT)
}

/**
 * The harbour skyline plate along the bottom of the viewport.
 *
 * In the original this was the CSS background of the second bird canvas, and
 * that canvas was built in `setupBirdAnimation()` during `init()` — so the
 * skyline was on screen from the very first frame, behind the cold open.
 *
 * The port had it created inside `startFlock()`, which does not run until the
 * whole opening sequence has finished: fireworks, the seven-second column
 * fade, the clouds lifting and the nav writing itself on. That left the
 * horizon empty for the best part of half a minute. It is its own element and
 * its own concern now, built during boot.
 */
export function setupTreeline(): void {
  if (document.getElementById('treeline')) return

  const treeline = document.createElement('div')
  treeline.id = 'treeline'
  treeline.setAttribute('aria-hidden', 'true')
  document.getElementById('content')?.appendChild(treeline)
}

/**
 * Light horizontal wind across the cloud layer.
 *
 * The vertical parallax is unchanged — it still moves the whole layer against
 * the scroll. This adds a slow sideways drift on top, and alternate bands go
 * opposite ways, so the sky shears gently against itself instead of sliding as
 * one sheet. A single repeating background cannot do that: every tile shares one
 * background-position, so the bands have to be real elements.
 *
 * Each band is three tiles wide and offset by one, so there is always material
 * either side of the viewport and the drift never exposes an edge. The distance
 * travelled is exactly one tile width, which is what makes the loop seamless.
 */
function buildCloudBands(clouds: HTMLElement): HTMLElement {
  const existing = clouds.querySelector<HTMLElement>('.cloud-layer')
  if (existing) return existing

  /*
   * Two nested elements because the two motions must not share a transform.
   * The wrapper carries the vertical parallax; the bands inside it carry the
   * horizontal drift. Writing both to one element means whichever runs last
   * wins, and the drift is an animation, so it would always be the parallax
   * that lost.
   */
  const layer = document.createElement('div')
  layer.className = 'cloud-layer'
  layer.setAttribute('aria-hidden', 'true')

  for (let i = 0; i < CLOUD_BANDS; i++) {
    const band = document.createElement('div')
    band.className = 'cloud-band'
    band.setAttribute('aria-hidden', 'true')
    band.style.top = `${i * TILE_HEIGHT}px`
    band.style.setProperty('--tile-width', `${TILE_WIDTH}px`)

    /*
     * Alternating direction, and deliberately not the same speed. Two bands
     * drifting in opposite directions at an identical rate read as a single
     * mirrored motion; a little difference makes it look like air rather than
     * a mechanism.
     */
    band.style.animationDirection = i % 2 === 0 ? 'normal' : 'reverse'
    band.style.animationDuration = `${90 + (i % 3) * 20}s`

    layer.appendChild(band)
  }

  clouds.appendChild(layer)
  return layer
}

export function setupCloudsParallax(): void {
  const clouds = document.getElementById('clouds')
  if (!clouds || prefersReducedMotion()) return

  const layer = buildCloudBands(clouds)

  let queued = false

  const update = (): void => {
    queued = false
    // translateY rather than background-position: the image now lives on the
    // bands, and the compositor moves a transform without repainting the layer.
    layer.style.transform = `translateY(${cloudOffset(window.scrollY)}px)`
  }

  window.addEventListener(
    'scroll',
    () => {
      if (queued) return
      queued = true
      requestAnimationFrame(update)
    },
    { passive: true },
  )

  update()
}
