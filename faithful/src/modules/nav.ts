/*
 * Navigation: vertical between the four scenes, horizontal within each one.
 *
 * The original used jQuery.scrollTo + localScroll for both axes, plus a
 * `calculateNavMarginOffset` function containing this comment:
 *
 *     return parentHeight * 0.293 - 243.679;
 *     // linear version with no cap based on my MacBook Air 13' inch and MacBook Pro 17'
 *
 * That formula pins the nav to the bottom of the viewport by regression
 * through two laptops the author happened to own, and goes negative below
 * 832px tall. It is kept verbatim — it is load-bearing for how the scenes are
 * framed, and no cleaner rule reproduces the same composition. The only change
 * is clamping it at zero, which is the branch the original had commented out
 * directly above it.
 *
 * Everything else is a faithful port — same history entries, same `.important`
 * and `.scrolled` bookkeeping — except that both scroll durations are longer
 * than the original's. See the constants below.
 */

import { $, $$, isNarrow, prefersReducedMotion } from './dom'

const SECTIONS = ['intro', 'about', 'work', 'contact'] as const
type SectionId = (typeof SECTIONS)[number]

/*
 * Scene changes are meant to be travelled, not teleported through — you are
 * moving between four composed views, and the parallax only reads if it has
 * time to happen. The original used 2000 ms vertically and 1500 ms
 * horizontally; both are stretched here.
 */
const VERTICAL_MS = 3200
const HORIZONTAL_MS = 2200

let currentSection: SectionId = 'intro'

/*
 * Bumped whenever a new scroll starts, so any frame loop still running from a
 * previous one sees a stale token and stands down. jQuery.scrollTo, which the
 * original used, stopped the in-flight animation for you; a bare rAF loop does
 * not, and two of them writing window.scrollY from different origins toward
 * different targets makes the page visibly oscillate for the rest of the
 * duration.
 */
let scrollToken = 0

/** The same guard for the horizontal pane cycler. */
let paneToken = 0

export function setupNav(): void {
  positionNavBlocks()
  applyScrollLock()

  // Observers are wired once. The resize handler only re-measures.
  const publishNavHeight = trackNavHeight()

  window.addEventListener('resize', () => {
    positionNavBlocks()
    applyScrollLock()
    publishNavHeight()
  }, { passive: true })

  wireSectionLinks()
  wireSubnavs()
  wirePaneLinks()
  trackCurrentSection()

  history.replaceState({ section: 'intro' }, '')

  window.addEventListener('popstate', (e) => {
    const state = e.state as { section?: string } | null
    if (state?.section && isSectionId(state.section)) {
      scrollToSection(state.section, { push: false })
    }
  })
}

function isSectionId(value: string): value is SectionId {
  return (SECTIONS as readonly string[]).includes(value)
}

/**
 * Publishes the docked nav's height as --nav-height.
 *
 * On the stacked layout the nav is `position: fixed`, so it covers whatever a
 * scroll lands on. Its height is not a constant that can be hard-coded: the
 * links wrap, so it is 68px at 390px wide and 102px at 320px. A guessed 5rem
 * cleared the first and not the second, and the About sub-navigation arrived
 * completely hidden underneath it.
 *
 * Measured and republished on resize, so both the column's top padding and the
 * scroll-margin on every target derive from what the nav actually is.
 *
 * Called exactly once, and returns the measurement function for the resize
 * handler to call. Calling this per resize instead built a fresh
 * ResizeObserver every time and never disconnected the last one — eight resize
 * events left more than thirty live observers, all recomputing and writing the
 * same custom property, and a rotating phone would keep adding to them.
 */
function trackNavHeight(): () => void {
  const nav = $('#intro .nav')
  if (!nav) return () => undefined

  const publish = (): void => {
    // Zero on the desktop layout, where the nav is in flow and scrolls away.
    const height = isNarrow() ? Math.round(nav.getBoundingClientRect().height) : 0
    document.documentElement.style.setProperty('--nav-height', `${height}px`)
  }

  publish()

  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(publish)
    observer.observe(nav)
    // The root as well as the nav. A window that has not been laid out yet
    // reports zero width, isNarrow() reads that as desktop, and the first
    // measurement publishes 0 — the nav's own box may never change afterwards
    // to trigger a correction.
    observer.observe(document.documentElement)
  }

  return publish
}

/**
 * How far a scroll target must clear the fixed nav, in pixels.
 *
 * Measured live rather than read back from --nav-height: the variable is for
 * CSS, and a stale or not-yet-published value here would put the target under
 * the nav with no way to tell.
 */
function navClearance(): number {
  if (!isNarrow()) return 0

  const nav = $('#intro .nav')
  if (!nav) return 0

  return Math.round(nav.getBoundingClientRect().height) + 12
}

/**
 * The original did not let you scroll.
 *
 * `body { overflow: hidden }` plus a `touchmove` preventDefault meant the four
 * scenes were reachable only through the nav, each arrival animated. That is
 * not an oversight to be corrected — it is why the site reads as a sequence of
 * composed views rather than a long page, and why the parallax always lands
 * where it was framed to land.
 *
 * Applied from script rather than in the stylesheet on purpose: if the
 * JavaScript fails, a visitor is left with an ordinary scrollable page instead
 * of a 4000px document they can only see the top of.
 *
 * The stacked layout below --stage-width scrolls normally; there is nothing to
 * cycle through there.
 */
function applyScrollLock(): void {
  document.documentElement.toggleAttribute('data-scroll-lock', !isNarrow())
}

/**
 * Each scene is 1000px tall but the nav should sit near the bottom of whatever
 * viewport it is in, so the copy underneath it clears the treeline.
 *
 * The constants are the original's, unchanged. Clamped at zero because the
 * expression goes negative below 832px tall, which the 2012 code guarded
 * against with a capped variant it left commented out.
 */
function positionNavBlocks(): void {
  const navs = $$('.nav')
  if (isNarrow()) {
    for (const nav of navs) nav.style.marginBottom = ''
    return
  }

  const margin = Math.max(0, window.innerHeight * 0.293 - 243.679)

  for (const nav of navs) nav.style.marginBottom = `${margin}px`
}

/* ---- vertical: between scenes ------------------------------------------ */

function wireSectionLinks(): void {
  for (const link of $$<HTMLAnchorElement>('.nav a, .welcome a[href^="#"], .folio a[href^="#"]')) {
    const target = link.getAttribute('href')?.slice(1)
    if (!target || !isSectionId(target)) continue

    link.addEventListener('click', (e) => {
      e.preventDefault()
      scrollToSection(target, { push: true })
    })
  }
}

function scrollToSection(id: SectionId, opts: { push: boolean }): void {
  const section = document.getElementById(id)
  if (!section) return

  markCurrent(id)

  if (opts.push && id !== currentSection) {
    history.pushState({ section: id }, '')
  }
  currentSection = id

  // scroll-margin-top handles scrollIntoView, but this is a manual scroll and
  // has to subtract the fixed nav itself.
  animateWindowScroll(Math.max(0, section.offsetTop - navClearance()))
}

function markCurrent(id: SectionId): void {
  for (const outer of $$('.outer')) outer.classList.remove('important')
  document.getElementById(id)?.classList.add('important')

  for (const li of $$('.nav li')) {
    li.toggleAttribute('data-current', li.classList.contains(id))
  }
}

/**
 * Keeps the nav highlight honest when the visitor scrolls by hand rather than
 * clicking. The original only ever updated it on click, so scrolling left the
 * previous section marked current.
 */
function trackCurrentSection(): void {
  const sections = SECTIONS.map((id) => document.getElementById(id)).filter(
    (el): el is HTMLElement => el !== null,
  )
  if (sections.length === 0) return

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const id = entry.target.id
        if (isSectionId(id)) {
          currentSection = id
          markCurrent(id)
        }
      }
    },
    { rootMargin: '-45% 0px -45% 0px' },
  )

  for (const section of sections) observer.observe(section)
}

/* ---- horizontal: between panes within a scene -------------------------- */

function wireSubnavs(): void {
  for (const outer of $$('.outer')) {
    const content = $('.content', outer)
    const subnav = $('.subnav', outer)
    if (!content || !subnav) continue

    for (const link of $$<HTMLAnchorElement>('a[href^="#"]', subnav)) {
      link.addEventListener('click', (e) => {
        e.preventDefault()
        const id = link.getAttribute('href')?.slice(1)
        if (!id) return

        for (const marked of $$('.scrolled', subnav)) marked.classList.remove('scrolled')
        link.classList.add('scrolled')
        link.blur()

        scrollPaneIntoView(content, id)
      })
    }
  }
}

/** The prev / next / testimonial links inside the panes themselves. */
function wirePaneLinks(): void {
  for (const outer of $$('.outer')) {
    const content = $('.content', outer)
    if (!content) continue

    for (const link of $$<HTMLAnchorElement>('.sub a[href^="#"]', content)) {
      const id = link.getAttribute('href')?.slice(1)
      if (!id || !$(`#${CSS.escape(id)}`, content)) continue

      link.addEventListener('click', (e) => {
        e.preventDefault()
        scrollPaneIntoView(content, id)
        syncSubnavHighlight(outer, id)
      })
    }
  }
}

function scrollPaneIntoView(content: HTMLElement, id: string): void {
  const pane = $(`#${CSS.escape(id)}`, content)
  if (!pane) return

  // Stacked layout: the panes are in normal flow, so let the browser do it.
  if (isNarrow()) {
    pane.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' })
    return
  }

  /*
   * offsetLeft/offsetTop are measured from the nearest *positioned* ancestor,
   * which here is `.section`, not the `.content` box that actually scrolls.
   *
   * That broke the About pane entirely. Its three `.section` blocks each
   * `clear: both`, so they stack vertically inside `.content` — Professional
   * and Education and Mission Statement sit side by side in the first, and
   * Personal and Hobby Projects are in the second and third, *below*. Every
   * pane is offsetTop 0 within its own section, so the vertical half of the
   * scroll was always 0 and those two were unreachable.
   *
   * Measuring the pane against the content box and adding the current scroll
   * gives the true target on both axes, whatever the ancestors are doing.
   */
  const contentBox = content.getBoundingClientRect()
  const paneBox = pane.getBoundingClientRect()

  animateScroll(
    content,
    content.scrollLeft + (paneBox.left - contentBox.left),
    content.scrollTop + (paneBox.top - contentBox.top),
  )
}

function syncSubnavHighlight(outer: HTMLElement, id: string): void {
  const subnav = $('.subnav', outer)
  if (!subnav) return

  const match = $<HTMLAnchorElement>(`a[href="#${CSS.escape(id)}"]`, subnav)
  if (!match) return

  for (const marked of $$('.scrolled', subnav)) marked.classList.remove('scrolled')
  match.classList.add('scrolled')
}

/**
 * The vertical journey between scenes.
 *
 * `scroll-behavior: smooth` is not used: its duration is the browser's to
 * choose and is far too brisk for a 1000px scene change, and like every other
 * frame-driven animation it does not progress in a hidden tab.
 */
function animateWindowScroll(toTop: number): void {
  if (prefersReducedMotion() || document.hidden) {
    window.scrollTo(0, toTop)
    return
  }

  const fromTop = window.scrollY
  if (Math.abs(toTop - fromTop) < 1) return

  const token = ++scrollToken
  const start = performance.now()
  let done = false

  const settle = (): void => {
    if (done || token !== scrollToken) return
    done = true
    window.scrollTo(0, toTop)
  }

  const step = (now: number): void => {
    if (done || token !== scrollToken) return

    const t = Math.min(1, (now - start) / VERTICAL_MS)
    // Ease in and out, so departure and arrival are both unhurried.
    const eased = 0.5 - Math.cos(t * Math.PI) / 2

    window.scrollTo(0, fromTop + (toTop - fromTop) * eased)

    if (t < 1) requestAnimationFrame(step)
    else done = true
  }

  requestAnimationFrame(step)
  setTimeout(settle, VERTICAL_MS + 120)
}

/**
 * Both axes at once, which is what jQuery.scrollTo's `axis: "xy"` did. Element
 * scrolling cannot use scroll-behavior here because the two axes need to move
 * together on the same easing curve.
 */
function animateScroll(el: HTMLElement, toLeft: number, toTop: number): void {
  // Nothing to animate to, or nobody watching. `document.hidden` matters
  // because rAF is suspended in a background tab: without this the callback
  // never fires, the scroll never advances, and the pane the visitor asked for
  // simply never arrives — they come back to the tab still looking at the old
  // one.
  if (prefersReducedMotion() || document.hidden) {
    el.scrollLeft = toLeft
    el.scrollTop = toTop
    return
  }

  const fromLeft = el.scrollLeft
  const fromTop = el.scrollTop
  const token = ++paneToken
  const start = performance.now()

  let done = false

  const settle = (): void => {
    if (done || token !== paneToken) return
    done = true
    el.scrollLeft = toLeft
    el.scrollTop = toTop
  }

  const step = (now: number): void => {
    if (done || token !== paneToken) return

    const t = Math.min(1, (now - start) / HORIZONTAL_MS)
    // swing easing, jQuery's default and what the original inherited
    const eased = 0.5 - Math.cos(t * Math.PI) / 2

    el.scrollLeft = fromLeft + (toLeft - fromLeft) * eased
    el.scrollTop = fromTop + (toTop - fromTop) * eased

    if (t < 1) requestAnimationFrame(step)
    else done = true
  }

  requestAnimationFrame(step)

  // Backstop. If the tab is hidden partway through, or the frame loop is
  // starved, the destination is still reached — arriving late beats never.
  setTimeout(settle, HORIZONTAL_MS + 120)
}

