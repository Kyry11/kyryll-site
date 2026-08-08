/*
 * The handful of jQuery conveniences the original actually relied on.
 * Everything else it used ($.ajax, .css, .attr, selectors) has a direct
 * platform equivalent and is called inline.
 */

/** Below this width the site reflows to a single column — see responsive.css. */
export const STAGE_WIDTH = 1000

export function isNarrow(): boolean {
  // A window that has not been laid out yet reports 0, which would otherwise
  // read as "very narrow" and commit the page to the stacked layout before it
  // has any idea how wide it is.
  const width = document.documentElement.clientWidth || window.innerWidth
  if (width === 0) return false

  return width <= STAGE_WIDTH
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function $<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T | null {
  return root.querySelector<T>(selector)
}

export function $$<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll<T>(selector))
}

/** jQuery's .fadeIn(duration), as a promise. */
export function fadeIn(el: HTMLElement, duration: number): Promise<void> {
  return animate(el, [{ opacity: 0 }, { opacity: 1 }], duration, '1')
}

/** jQuery's .fadeOut(duration), as a promise. Leaves the element hidden. */
export async function fadeOut(el: HTMLElement, duration: number): Promise<void> {
  await animate(el, [{ opacity: 1 }, { opacity: 0 }], duration, '0')
  el.hidden = true
}

function animate(
  el: HTMLElement,
  frames: Keyframe[],
  duration: number,
  endOpacity: string,
): Promise<void> {
  const anim = el.animate(frames, { duration, easing: 'ease', fill: 'forwards' })

  // Deliberately NOT `await anim.finished`.
  //
  // An animation timeline is frozen while its document is not being rendered —
  // a background tab, or a window the compositor has parked. `finished` then
  // never settles, and since the whole opening sequence is chained off these
  // fades, the site would sit on the splash screen indefinitely and only
  // recover if the tab were brought to the front. Timers keep firing when
  // hidden (throttled, but they fire), so the sequence is driven off one and
  // the animation is purely cosmetic.
  return wait(duration).then(() => {
    el.style.opacity = endOpacity
    anim.cancel()
  })
}

export function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

/**
 * Splits an element's text into per-character spans, preserving inline markup
 * (`<b>`, `<i>`) and leaving a sequential index on each so CSS can stagger the
 * reveal. This replaces the cooltext plugin, which did the same thing with a
 * jQuery animation queue per letter.
 *
 * Returns the number of letters, so the caller can work out how long the
 * reveal will take.
 */
export function splitIntoLetters(el: Element, startIndex = 0): number {
  let index = startIndex

  // Captured before the split, and restored as the element's accessible name
  // once its glyphs have been scattered into aria-hidden spans.
  const spoken = (el.textContent ?? '').replace(/\s+/g, ' ').trim()

  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent ?? ''
        if (!text) continue

        const frag = document.createDocumentFragment()
        for (const char of text) {
          const span = document.createElement('span')
          span.className = 'ct-letter'
          span.style.setProperty('--i', String(index++))
          span.textContent = char
          /*
           * Hidden from assistive technology, every one of them. A run of
           * per-character inline-blocks invites a screen reader to spell the
           * text out; the caller puts the real string back as an aria-label on
           * the container, so the whole phrase is announced once.
           *
           * An earlier version set aria-hidden="false" on spaces only, with a
           * comment about word breaks. That is the attribute's default value,
           * so it did precisely nothing.
           */
          span.setAttribute('aria-hidden', 'true')
          frag.appendChild(span)
        }
        child.replaceWith(frag)
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        walk(child)
      }
    }
  }

  walk(el)

  if (spoken) el.setAttribute('aria-label', spoken)

  return index - startIndex
}
