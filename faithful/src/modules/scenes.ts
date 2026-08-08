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

/** Scroll-to-drift ratio. Below 1 the clouds lag behind the page. */
const SPEED_RATIO = 0.4

function cloudOffset(scrollPosition: number): number {
  return TILE_HEIGHT - (Math.floor(scrollPosition / SPEED_RATIO) % (TILE_HEIGHT + 1))
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

export function setupCloudsParallax(): void {
  const clouds = document.getElementById('clouds')
  if (!clouds || prefersReducedMotion()) return

  let queued = false

  const update = (): void => {
    queued = false
    clouds.style.backgroundPosition = `0 ${cloudOffset(window.scrollY)}px`
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
