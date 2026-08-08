/*
 * The rotating technology thumbnails on the intro pane.
 *
 * Original: jQuery Cycle Lite on #foliothumbs, with its defaults (4 s dwell,
 * fade transition). Cycle Lite absolutely-positioned each slide and animated
 * opacity through the jQuery queue; here the slides are stacked in CSS and the
 * transition runs on the compositor.
 */

import { $, $$, prefersReducedMotion } from './dom'

const DWELL_MS = 4000

export function setupCarousel(): void {
  const strip = $('#foliothumbs')
  if (!strip) return

  const slides = $$(':scope > div', strip)
  if (slides.length === 0) return

  let index = 0
  slides[0]?.setAttribute('data-active', '')

  // A still carousel is the honest reading of "reduce motion" — the first
  // slide stays up rather than cross-fading every four seconds.
  if (prefersReducedMotion()) return

  let timer = window.setInterval(advance, DWELL_MS)

  function advance(): void {
    slides[index]?.removeAttribute('data-active')
    index = (index + 1) % slides.length
    slides[index]?.setAttribute('data-active', '')
  }

  // Cycling while the tab is in the background burns frames for no one.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      window.clearInterval(timer)
    } else {
      timer = window.setInterval(advance, DWELL_MS)
    }
  })
}
