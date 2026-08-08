/*
 * kyryll.com — faithful port of the 2012 site.
 *
 * The original was one 1258-line jQuery object plus ~350 KB of concatenated
 * plugins (cooltext, jrumble, label_better, scrollTo/localScroll, Cycle Lite,
 * TweenMax, Howler, FancyZoom) and three.js r62. Same site, same sequence,
 * no jQuery, no plugin bundle.
 *
 * The boot order is the one thing worth preserving exactly, because the whole
 * opening is a timed sequence:
 *
 *   1. cold open plays over everything                (splash)
 *   2. splash cross-fades out, #content fades in
 *   3. three seconds later fireworks go up and the ambient track starts
 *   4. the content column fades in over seven seconds
 *   5. clouds lift from black, the nav reveals letter by letter
 *   6. the flock starts flying
 */

import './styles/fonts.css'
import './styles/base.css'
import './styles/splash.css'
import './styles/layout.css'
import './styles/contact.css'
import './styles/responsive.css'
// TEMPORARY — canvas boundary overlay, inert unless ?debug is in the URL.
import './styles/debug.css'

import { playSplash, revealNav } from './modules/splash'
import { setupCloudsParallax, setupTreeline } from './modules/scenes'
import { setupNav } from './modules/nav'
import { setupCarousel } from './modules/carousel'
import { setupContactForm } from './modules/contact'
import { createAudio } from './modules/audio'
import { fadeIn, prefersReducedMotion, wait } from './modules/dom'

const content = document.getElementById('content')
const container = document.getElementById('container')

async function boot(): Promise<void> {
  if (!content || !container) return

  setupCanvasDebug()

  // Everything that does not depend on the intro finishing.
  setupTreeline()
  setupCloudsParallax()
  setupNav()
  setupCarousel()

  const audio = createAudio()
  setupContactForm()

  // Fetch and decode the track now, during the cold open, so it is ready the
  // moment the firework display burns out rather than stalling on cue.
  audio.prime()

  // Warm the envelope frames while the visitor is still reading the splash;
  // by the time they reach the contact form they are already decoded.
  void preloadEnvelopeFrames()

  await playSplash()

  content.hidden = false
  await fadeIn(content, 1500)

  void revealMainContent(audio)
}

async function revealMainContent(audio: ReturnType<typeof createAudio>): Promise<void> {
  if (!container) return

  const reduced = prefersReducedMotion()

  // The flock and the fireworks are the two continuous animations. Both are
  // loaded on demand so three.js never blocks the cold open.
  if (!reduced) {
    await wait(3000)

    void import('./modules/fireworks').then(({ startFireworks }) =>
      // The track proper waits for the sky to go quiet.
      startFireworks(() => audio.startTrack()),
    )
    audio.playFireworkStabs()
  }

  container.hidden = false
  // Force a reflow so the transition has a start value to animate from.
  // Deliberately not requestAnimationFrame: rAF is suspended in a background
  // tab, which would leave the column stuck at opacity 0.
  void container.offsetHeight
  container.setAttribute('data-visible', '')

  if (reduced) {
    document.getElementById('clouds')?.style.setProperty('background-color', 'transparent')

    /*
     * The track is cued here too.
     *
     * Reduced motion skips the firework display, and the display was the only
     * thing that ever called startTrack() — so wantsTrack stayed false, and
     * tryStart() bailed on every path including the speaker and the space bar.
     * Somebody who asks for less motion was silently denied the audio
     * altogether, with a control that appeared to do nothing.
     *
     * A motion preference says nothing about sound, so it is cued immediately
     * rather than waiting for a display that will not happen.
     */
    audio.startTrack()
    return
  }

  await wait(7000)

  await fadeCloudsFromBlack()

  await revealNav()

  const { startFlock } = await import('./modules/birds')
  startFlock()
}

/**
 * The clouds layer lifts from opaque black to transparent, which is what makes
 * the night sky appear behind the text already standing on it.
 *
 * Black is the layer's initial value in the stylesheet, not something set
 * here — see the note on #clouds in layout.css. The original stepped this in a
 * 20 ms setTimeout recursion, one hundred discrete alpha values; a transition
 * on the same property looks the same and costs nothing per frame.
 */
function fadeCloudsFromBlack(): Promise<void> {
  const clouds = document.getElementById('clouds')
  if (!clouds) return Promise.resolve()

  clouds.style.transition = 'background-color 2s linear'
  clouds.style.backgroundColor = 'rgba(0, 0, 0, 0)'

  return wait(2000)
}

/**
 * The four envelope plates used by the send animation. The original kicked
 * these off on a bare 30-second setTimeout; tying them to idle time means they
 * never compete with the opening sequence for bandwidth.
 */
function preloadEnvelopeFrames(): void {
  const frames = [
    '/img/envelope-flap-1.png',
    '/img/envelope-flap-2.png',
    '/img/envelope-flap-3.png',
    '/img/envelope-full.png',
  ]

  const load = (): void => {
    for (const src of frames) {
      const img = new Image()
      img.src = src
    }
  }

  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(load, { timeout: 30_000 })
  } else {
    setTimeout(load, 30_000)
  }
}

/*
 * TEMPORARY — canvas boundary overlay.
 *
 * Load with ?debug to outline the flock's two canvases and mark the seam
 * between them. Delete this function, its call above, and the debug.css import
 * to remove.
 */
function setupCanvasDebug(): void {
  if (!new URLSearchParams(location.search).has('debug')) return

  document.documentElement.setAttribute('data-debug-canvas', '')

  const seam = document.createElement('div')
  seam.id = 'debug-seam'

  const legend = document.createElement('div')
  legend.id = 'debug-legend'

  document.body.append(seam, legend)

  const update = (): void => {
    const main = document.getElementById('birdsMain')
    const footer = document.getElementById('birdsFooter')
    const treeline = document.getElementById('treeline')

    const rect = (el: HTMLElement | null): DOMRect | null => el?.getBoundingClientRect() ?? null
    const m = rect(main)
    const f = rect(footer)
    const t = rect(treeline)

    // The seam is where the main canvas ends. Before the flock starts there is
    // no canvas yet, so fall back to the geometry it will use: viewport height
    // minus a footer band one third of the viewport width tall.
    const w = document.documentElement.clientWidth
    const h = document.documentElement.clientHeight
    const seamY = m ? m.bottom : h - w / 3

    // Same measurement birds.ts uses to place the seam.
    let panelBottom: number | null = null
    for (const outer of document.querySelectorAll<HTMLElement>('.outer')) {
      const top = outer.getBoundingClientRect().top
      for (const child of outer.children) {
        const box = child.getBoundingClientRect()
        if (box.height === 0) continue
        panelBottom = Math.max(panelBottom ?? 0, box.bottom - top)
      }
    }

    seam.style.top = `${seamY}px`

    const row = (colour: string, label: string, value: string): string =>
      `<b style="color:${colour}"><span class="swatch"></span>${label}</b>  ${value}\n`

    legend.innerHTML =
      row('#4fd6ff', '#birdsMain   z10 ', m ? `0 → ${Math.round(m.bottom)}` : 'not started') +
      row('#ffd24f', '#treeline    z100', t ? `${Math.round(t.top)} → ${Math.round(t.bottom)}` : '—') +
      row('#ff5cf0', '#birdsFooter z101', f ? `${Math.round(f.top)} → ${Math.round(f.bottom)}` : 'not started') +
      row('#ff2d2d', 'seam             ', `y = ${Math.round(seamY)}`) +
      `\nviewport ${w}x${h}   plate top = h - w/3 = ${Math.round(h - w / 3)}` +
      `\nlowest panel edge: ${panelBottom === null ? '—' : Math.round(panelBottom)}` +
      `\nseam pushed down by: ${Math.round(seamY - (h - w / 3))}px` +
      (m && f
        ? `\ngap between canvases: ${Math.round(f.top - m.bottom)}px` +
          `\npanels clear of seam: ${panelBottom === null || panelBottom < seamY ? 'yes' : 'NO — birds will cross text'}`
        : '')
  }

  update()
  window.addEventListener('resize', update, { passive: true })
  // The canvases only appear once the flock starts, at the end of the opening
  // sequence, so keep re-reading until they do.
  const poll = window.setInterval(() => {
    update()
    if (document.getElementById('birdsFooter')) window.clearInterval(poll)
  }, 500)
}

/*
 * Nothing above may take the page down with it.
 *
 * #content and #container ship with `hidden` and are only unhidden inside
 * boot(), so any throw before that point left a permanently black page — and
 * there are real ways to throw: history.replaceState raises SecurityError in
 * an opaque origin, such as a sandboxed iframe without allow-same-origin.
 *
 * Two comments elsewhere argued that applying the scroll lock from script
 * meant a JS failure would "degrade to an ordinary scrollable page". That was
 * not true while a failure meant no page at all. It is true now.
 */
void boot().catch((error: unknown) => {
  console.error('kyryll.com: opening sequence failed, showing the site directly', error)
  revealWithoutSequence()
})

/** Last resort: no intro, no animation, but a readable, scrollable site. */
function revealWithoutSequence(): void {
  document.getElementById('loading-splash')?.remove()
  document.documentElement.removeAttribute('data-scroll-lock')

  if (content) {
    content.hidden = false
    content.style.opacity = '1'
  }

  if (container) {
    container.hidden = false
    container.setAttribute('data-visible', '')
  }

  const clouds = document.getElementById('clouds')
  if (clouds) {
    clouds.style.transition = 'none'
    clouds.style.backgroundColor = 'transparent'
  }
}
