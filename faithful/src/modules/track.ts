/*
 * Visit tracking, as the 2012 site had it.
 *
 * The original called an endpoint on every section change and the server
 * emailed the result — a visitor id, a visit count, the date of the first
 * visit. The port removed it; this puts it back, pointed at /api/track.
 *
 * Three things it must never do, because it is the least important code on the
 * page and runs on the same thread as everything that matters:
 *
 *   - block anything. Beacons are fired and forgotten; no await reaches the
 *     caller and no response is ever read.
 *   - throw. Every path is wrapped, including the storage reads, which fail in
 *     private browsing.
 *   - repeat itself. Arriving at a scene twice in a row is one visit to it, not
 *     two, and the server only accepts ten events an hour anyway.
 */

const ENDPOINT = '/api/track'
const KEY = 'kyryll:visitor'

interface Visitor {
  id: string
  visits: number
  first: string
}

let visitor: Visitor | null = null
let lastSection = ''

/**
 * Reads the visitor record, creating one on a first visit and counting this
 * page load as a visit.
 *
 * Storage failures are not worth a broken page: private browsing throws on
 * access, and the answer there is to track the session anonymously rather than
 * not at all.
 */
function identify(): Visitor {
  const fresh = (): Visitor => ({
    id: crypto.randomUUID?.() ?? String(Math.random()).slice(2),
    visits: 1,
    first: new Date().toISOString().slice(0, 10),
  })

  try {
    const stored = window.localStorage.getItem(KEY)
    const parsed: unknown = stored === null ? null : JSON.parse(stored)

    const record =
      parsed !== null && typeof parsed === 'object' && 'id' in parsed
        ? (parsed as Visitor)
        : fresh()

    if (stored !== null) record.visits = Number(record.visits ?? 0) + 1

    window.localStorage.setItem(KEY, JSON.stringify(record))
    return record
  } catch {
    return fresh()
  }
}

/**
 * Fires one beacon. Never awaited, never inspected.
 *
 * sendBeacon is preferred because it survives the page being closed, which is
 * exactly when the last event of a visit happens. It is not universally
 * available for this, so fetch with keepalive is the fallback — same property,
 * more caveats.
 */
function beacon(payload: Record<string, unknown>): void {
  try {
    const body = JSON.stringify(payload)

    if (typeof navigator.sendBeacon === 'function') {
      // A Blob rather than a string, so the content type is application/json
      // and the endpoint's own guard is satisfied.
      const sent = navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }))
      if (sent) return
    }

    void fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => undefined)
  } catch {
    // Tracking is never a reason for anything else to stop.
  }
}

function send(event: string, section = ''): void {
  if (!visitor) return

  beacon({
    event,
    section,
    referrer: document.referrer,
    visitor: visitor.id,
    visits: visitor.visits,
    first: visitor.first,
  })
}

/** Records the arrival. Called once, after the opening sequence. */
export function setupTracking(): void {
  visitor = identify()
  send('arrived')
}

/**
 * Records a move to a scene.
 *
 * Called from nav.ts wherever the current section is committed, so it covers
 * both clicking the nav and scrolling on the stacked layout. The repeat guard
 * matters more there: the observer fires on every crossing, and without it a
 * visitor drifting over a boundary would spend the hour's allowance in seconds.
 */
export function trackSection(id: string): void {
  if (!visitor || id === lastSection) return
  lastSection = id
  send('section', id)
}
