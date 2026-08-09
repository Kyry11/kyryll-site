/*
 * The cold open, and the nav reveal that echoes it later.
 *
 * The original ran both through the cooltext plugin — four levels of nested
 * onComplete callbacks for the splash, two more for the nav. The sequencing is
 * the same; it is just awaited instead.
 *
 * One addition: the original had no way out. The definition took roughly nine
 * seconds to play and then held for three more before the site appeared, with
 * no escape. There is a skip button now, and Escape or a click anywhere works
 * too — but the intro always plays. It is the front door of the site, and
 * quietly skipping it for returning visitors meant most loads never showed it.
 */

import { $, $$, fadeOut, isNarrow, prefersReducedMotion, splitIntoLetters, wait } from './dom'

/*
 * Per-letter stagger, in milliseconds.
 *
 * Slower than the 18 ms this port started with, which raced through the
 * definition in about three seconds — long enough to notice, too short to
 * read. At 34 ms the entry writes itself on over roughly seven seconds, which
 * is close to the original's own pace and gives the words time to land.
 */
const LETTER_STEP = 34

/** How long the finished definition holds on screen before the cross-fade. */
const HOLD_MS = 3000


export async function playSplash(): Promise<void> {
  const splash = $('#loading-splash')
  if (!splash) return

  const skip = $<HTMLButtonElement>('#splash-skip')

  // The only automatic skip left. Reduced motion is a stated accessibility
  // preference, and a letter-by-letter reveal is exactly what it is asking not
  // to see; everyone else gets the intro every time, with the skip button
  // right there if they have seen enough.
  if (prefersReducedMotion()) {
    await dismiss(splash, 400)
    return
  }

  const term = $('p.loading-term', splash)
  const definitions = $$('p.loading-definition', splash)

  // The term reveals first, then each definition line in turn — so the
  // stagger index has to keep running across all three elements.
  let index = 0
  let lastDelay = 0

  for (const el of [term, ...definitions]) {
    if (!el) continue
    const count = splitIntoLetters(el, index)
    index += count
    lastDelay = index * LETTER_STEP
  }

  splash.style.setProperty('--ct-step', `${LETTER_STEP}ms`)
  splash.setAttribute('data-reveal', '')

  const skipped = new Promise<void>((resolve) => {
    const done = (): void => resolve()

    skip?.addEventListener('click', done, { once: true })
    splash.addEventListener('click', (e) => {
      if (e.target !== skip) done()
    }, { once: true })

    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
        document.removeEventListener('keydown', onKey)
        done()
      }
    })
  })

  // Whichever comes first: the sequence finishing, or the visitor skipping it.
  await Promise.race([wait(lastDelay + HOLD_MS), skipped])

  await dismiss(splash, 1500)
}

async function dismiss(splash: HTMLElement, duration: number): Promise<void> {
  splash.setAttribute('data-leaving', '')
  await fadeOut(splash, duration)
  splash.remove()
}



/**
 * The nav wordmark writing itself on, once the scene has settled. "Kyryll"
 * reveals first and the three section links follow — the original used
 * cooltext animations "cool58" and "cool55" for exactly this.
 *
 * Only the intro copy of the nav is animated. The markup repeats the same list
 * inside all four sections, and on the desktop layout each copy belongs to its
 * own scene, so animating all four would fire the effect off-screen three
 * times over.
 *
 * The split and the reveal happen together, with a forced reflow between them
 * so the letters have a start value to animate from. Splitting earlier — at
 * boot — would mean deciding whether to animate before the window has been
 * laid out, and a window still reporting 0 width would skip the effect for
 * the rest of the session.
 */
/**
 * Splitting is separated from revealing, and has to happen before the content
 * column fades in.
 *
 * The nav is inside #container, so it faded up with everything else as ordinary
 * text — and then, ten seconds later, splitIntoLetters() replaced that text
 * with .ct-letter spans at opacity 0 and the nav vanished before animating back
 * in. Visitors saw it arrive, disappear, and arrive again. Splitting while the
 * column is still transparent means the letters are already in place and
 * already invisible, so the only appearance is the intended one.
 *
 * By the time this runs the splash has played and the window has been laid out,
 * so isNarrow() is answerable — which is what previously argued for splitting
 * late.
 */
let pending: { brand: HTMLElement; links: HTMLElement[]; brandLetters: number } | null = null

export function prepareNav(): void {
  if (prefersReducedMotion() || isNarrow()) return

  const intro = $('#intro')
  if (!intro) return

  const brand = $('.nav li.intro a', intro)
  const links = $$('.nav li.about a, .nav li.work a, .nav li.contact a', intro)

  if (!brand) return

  const brandLetters = splitIntoLetters(brand)
  brand.style.setProperty('--ct-step', '55ms')

  let index = 0
  for (const link of links) {
    index += splitIntoLetters(link, index)
    link.style.setProperty('--ct-step', '38ms')
  }

  pending = { brand, links, brandLetters }
}

export async function revealNav(): Promise<void> {
  // Null when prepareNav() declined — reduced motion, or the stacked layout,
  // where the nav is plain text and simply visible.
  if (!pending) return

  const { brand, links, brandLetters } = pending

  // Commit the split before switching the animation on, so the browser never
  // paints a frame of blank nav.
  void brand.offsetHeight

  brand.setAttribute('data-reveal', '')
  await wait(brandLetters * 55 + 200)

  for (const link of links) link.setAttribute('data-reveal', '')
}
