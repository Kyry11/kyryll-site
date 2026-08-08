/*
 * The flock.
 *
 * A Reynolds boids simulation — separation, alignment, cohesion, wall
 * avoidance, and repulsion from the cursor — with each bird drawn as a
 * three-triangle mesh whose wing vertices oscillate with its own phase.
 *
 * The simulation is ported unchanged, tuning constants and all. The rendering
 * is not, because the r62 API it was written against no longer exists:
 *
 *   THREE.Geometry / Face3   removed in r125  -> BufferGeometry + index
 *   THREE.CanvasRenderer     removed in r97   -> WebGLRenderer
 *   computeCentroids()       removed in r78   -> gone, it was unused here
 *   mesh.position = vec      no longer allowed (position is read-only) -> copy
 *
 * The two canvases are deliberate and load-bearing.
 *
 * The original split the flock across #birdsMain and #birdsFooter, with two
 * cameras whose setViewOffset calls tile the viewport exactly: main covers the
 * top band, footer the bottom third. Geometrically that is one continuous
 * view, and an earlier pass here collapsed it into a single canvas on exactly
 * that reasoning — which was wrong.
 *
 * The split exists for stacking, not for geometry. Bird pixels have to sit at
 * two different z-indices:
 *
 *   #birdsMain    z 10   below the content column (70) — birds pass *behind*
 *                        the text
 *   #birdsFooter  z 101  above the treeline plate (100) — birds pass *in
 *                        front of* the city skyline
 *
 * No single element can be both. Collapsing them put the whole flock under the
 * skyline, so any bird that dropped toward the horizon disappeared into the
 * buildings.
 *
 * The skyline itself stays a separate element (#treeline, built during boot by
 * scenes.ts) rather than being this canvas's CSS background as it was in 2012 —
 * the flock starts only after the whole opening sequence, and the horizon must
 * not wait that long.
 */

import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three'

import { isNarrow, prefersReducedMotion } from './dom'

const BIRD_COUNT = 11

/* ---- boid --------------------------------------------------------------- */

class Boid {
  readonly position = new Vector3()
  readonly velocity = new Vector3()

  private readonly acceleration = new Vector3()
  private readonly scratch = new Vector3()

  private width = 500
  private height = 500
  private depth = 200

  private avoidWalls = false

  private readonly neighborhoodRadius = 100
  /*
   * Slower and lazier than the original's 4 / 0.1. At full speed the flock
   * crossed the viewport in a couple of seconds and the turns snapped; at this
   * pace you can actually follow a bird. The flocking behaviour is unchanged —
   * only how fast it plays out.
   */
  private readonly maxSpeed = 2.2
  private readonly maxSteerForce = 0.065

  setAvoidWalls(value: boolean): void {
    this.avoidWalls = value
  }

  setWorldSize(width: number, height: number, depth: number): void {
    this.width = width
    this.height = height
    this.depth = depth
  }

  run(boids: Boid[]): void {
    if (this.avoidWalls) {
      const { position } = this
      this.pushOffWall(-this.width, position.y, position.z)
      this.pushOffWall(this.width, position.y, position.z)
      this.pushOffWall(position.x, -this.height, position.z)
      this.pushOffWall(position.x, this.height, position.z)
      this.pushOffWall(position.x, position.y, -this.depth)
      this.pushOffWall(position.x, position.y, this.depth)
    }

    // The original only flocked on half the frames, at random. It reads as a
    // slight looseness in the formation and it halves the O(n^2) work.
    if (Math.random() > 0.5) this.flock(boids)

    this.move()
  }

  private pushOffWall(x: number, y: number, z: number): void {
    this.scratch.set(x, y, z)
    const steer = this.avoid(this.scratch)
    steer.multiplyScalar(5)
    this.acceleration.add(steer)
  }

  private flock(boids: Boid[]): void {
    this.acceleration.add(this.alignment(boids))
    this.acceleration.add(this.cohesion(boids))
    this.acceleration.add(this.separation(boids))
  }

  private move(): void {
    this.velocity.add(this.acceleration)

    const speed = this.velocity.length()
    if (speed > this.maxSpeed) this.velocity.divideScalar(speed / this.maxSpeed)

    this.position.add(this.velocity)
    this.acceleration.set(0, 0, 0)
  }

  private avoid(target: Vector3): Vector3 {
    const steer = new Vector3().copy(this.position).sub(target)
    return steer.multiplyScalar(1 / this.position.distanceToSquared(target))
  }

  repulse(target: Vector3): void {
    const distance = this.position.distanceTo(target)
    if (distance >= 150) return

    const steer = new Vector3().subVectors(this.position, target)
    steer.multiplyScalar(0.5 / distance)
    this.acceleration.add(steer)
  }

  private alignment(boids: Boid[]): Vector3 {
    const velSum = new Vector3()
    let count = 0

    for (const boid of boids) {
      if (Math.random() > 0.6) continue

      const distance = boid.position.distanceTo(this.position)
      if (distance > 0 && distance <= this.neighborhoodRadius) {
        velSum.add(boid.velocity)
        count++
      }
    }

    if (count > 0) {
      velSum.divideScalar(count)
      const length = velSum.length()
      if (length > this.maxSteerForce) velSum.divideScalar(length / this.maxSteerForce)
    }

    return velSum
  }

  private cohesion(boids: Boid[]): Vector3 {
    const posSum = new Vector3()
    let count = 0

    for (const boid of boids) {
      if (Math.random() > 0.6) continue

      const distance = boid.position.distanceTo(this.position)
      if (distance > 0 && distance <= this.neighborhoodRadius) {
        posSum.add(boid.position)
        count++
      }
    }

    if (count > 0) posSum.divideScalar(count)

    const steer = new Vector3().subVectors(posSum, this.position)
    const length = steer.length()
    if (length > this.maxSteerForce) steer.divideScalar(length / this.maxSteerForce)

    return steer
  }

  private separation(boids: Boid[]): Vector3 {
    const posSum = new Vector3()
    const repulse = new Vector3()

    for (const boid of boids) {
      if (Math.random() > 0.6) continue

      const distance = boid.position.distanceTo(this.position)
      if (distance > 0 && distance <= this.neighborhoodRadius) {
        repulse.subVectors(this.position, boid.position)
        repulse.normalize()
        repulse.divideScalar(distance)
        posSum.add(repulse)
      }
    }

    return posSum
  }
}

/* ---- bird geometry ------------------------------------------------------ */

/**
 * Eight vertices, three triangles: a body spike and two wings. Vertices 4 and
 * 5 are the wingtips — their y is rewritten every frame to flap.
 */
const BIRD_VERTICES = new Float32Array([
   5,  0,  0, // 0 nose
  -5, -2,  1, // 1
  -5,  0,  0, // 2 tail
  -5, -2, -1, // 3
   0,  2, -6, // 4 left wingtip
   0,  2,  6, // 5 right wingtip
   2,  0,  0, // 6
  -3,  0,  0, // 7
])

const BIRD_INDEX = [0, 2, 1, 4, 7, 6, 5, 6, 7]

const WINGTIP_LEFT_Y = 4 * 3 + 1
const WINGTIP_RIGHT_Y = 5 * 3 + 1

function createBirdGeometry(): BufferGeometry {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(BIRD_VERTICES.slice(), 3))
  geometry.setIndex(BIRD_INDEX)
  geometry.computeVertexNormals()
  return geometry
}

/* ---- scene -------------------------------------------------------------- */

interface Flock {
  stop(): void
}

let running: Flock | null = null

/** The skyline plate is a third of the viewport width tall, as in the original. */
const FOOTER_RATIO = 3

/** Clearance left between the lowest content panel and the seam. */
const SEAM_GAP = 10

/*
 * How far into the skyline plate the seam may be pushed.
 *
 * Measured from bgfooter.png (1920x640): no meaningful ink until 14% down
 * (that is the right-edge tree), and no solid skyline until 42%. Everything
 * above that is open sky, where a bird drawn *under* the plate is still fully
 * visible — so pushing the seam through the top 42% costs nothing at all.
 *
 * Past 42% the cost is only a sliver of buildings whose birds go behind rather
 * than in front, which reads as depth rather than as a fault. What genuinely
 * must not happen is the seam swallowing the *whole* skyline: that would put
 * every building in the under-plate canvas and lose the effect the two
 * canvases exist for. 70% is where that starts to bite.
 *
 * A tighter cap sounded safer and was worse — at 35% this clamped on ordinary
 * window sizes (1280x720 among them) and let birds back over the text, which
 * is the fault being fixed.
 */
const PLATE_CLEAR_RATIO = 0.7

export function startFlock(): Flock | null {
  if (running) return running
  if (prefersReducedMotion()) return null

  const content = document.getElementById('content')
  if (!content) return null

  // No WebGL (very old hardware, or a locked-down browser) — the site is
  // perfectly usable without birds, so fail quietly rather than throwing.
  let rendererMain: WebGLRenderer
  let rendererFooter: WebGLRenderer
  try {
    rendererMain = new WebGLRenderer({ alpha: true, antialias: true })
    rendererFooter = new WebGLRenderer({ alpha: true, antialias: true })
  } catch {
    return null
  }

  const canvasMain = rendererMain.domElement
  canvasMain.id = 'birdsMain'
  content.appendChild(canvasMain)

  const canvasFooter = rendererFooter.domElement
  canvasFooter.id = 'birdsFooter'
  content.appendChild(canvasFooter)

  const dpr = Math.min(window.devicePixelRatio, 2)
  rendererMain.setPixelRatio(dpr)
  rendererFooter.setPixelRatio(dpr)
  rendererMain.setClearColor(0x000000, 0)
  rendererFooter.setClearColor(0x000000, 0)

  const cameraMain = new PerspectiveCamera(75, 1, 1, 10000)
  const cameraFooter = new PerspectiveCamera(75, 1, 1, 10000)
  cameraMain.position.z = 450
  cameraFooter.position.z = 450

  /*
   * Where the two canvases meet.
   *
   * The naive answer is the top of the skyline plate — a third of the viewport
   * width up from the bottom, as the original had it. The trouble is that the
   * footer canvas sits *above* the content column, so anything it draws is
   * drawn over the text. On a short window the content panels reach below the
   * plate's top edge, and birds start flying across the middle of a paragraph.
   *
   * So the seam is placed below the lowest content panel instead, and only
   * falls back to the plate edge when the content sits higher than that. The
   * push is capped at PLATE_CLEAR_RATIO into the plate: past that point the
   * strip between the plate's top and the seam is drawn by the main canvas,
   * which is *underneath* the plate, and a bird there would disappear behind
   * the buildings.
   */
  function seamPosition(w: number, h: number): number {
    const plateTop = Math.max(0, h - w / FOOTER_RATIO)

    // The stacked layout has no skyline and puts the footer canvas at the same
    // depth as the main one, so there is nothing to solve for.
    if (isNarrow()) return plateTop

    const contentBottom = lowestPanelEdge()
    if (contentBottom === null) return plateTop

    const wanted = contentBottom + SEAM_GAP
    const limit = plateTop + (w / FOOTER_RATIO) * PLATE_CLEAR_RATIO

    return Math.round(Math.min(Math.max(plateTop, wanted), limit))
  }

  /**
   * The lowest edge any section's panels reach, measured from that section's
   * own top so it does not depend on where the page is scrolled.
   *
   * Returns null while the content column is still hidden during the opening
   * sequence, when every rectangle is zero.
   */
  function lowestPanelEdge(): number | null {
    let lowest = 0

    for (const outer of document.querySelectorAll<HTMLElement>('.outer')) {
      const top = outer.getBoundingClientRect().top

      for (const child of outer.children) {
        const box = child.getBoundingClientRect()
        if (box.height === 0) continue
        lowest = Math.max(lowest, box.bottom - top)
      }
    }

    return lowest > 0 ? lowest : null
  }

  /*
   * One frustum, two windows onto it. setViewOffset(fullW, fullH, x, y, w, h)
   * says "render the sub-rectangle at (x, y) of a full viewport this size", so
   * the two together reconstruct a single uncut view — a bird crossing the
   * boundary is continuous, it simply changes which element it is drawn into.
   */
  function layout(): void {
    const w = document.documentElement.clientWidth || window.innerWidth
    const h = document.documentElement.clientHeight || window.innerHeight

    const mainH = seamPosition(w, h)
    const footerH = Math.max(0, h - mainH)

    rendererMain.setSize(w, mainH)
    rendererFooter.setSize(w, footerH)

    cameraMain.aspect = w / h
    cameraMain.setViewOffset(w, h, 0, 0, w, mainH)
    cameraMain.updateProjectionMatrix()

    cameraFooter.aspect = w / h
    cameraFooter.setViewOffset(w, h, 0, mainH, w, footerH)
    cameraFooter.updateProjectionMatrix()

    // The footer canvas is positioned from the top, where the main one ends.
    canvasFooter.style.top = `${mainH}px`

    for (const boid of boids) boid.setWorldSize(h, w, 400)
  }

  const scene = new Scene()

  const boids: Boid[] = []
  const birds: Mesh<BufferGeometry, MeshBasicMaterial>[] = []
  const phases: number[] = []

  for (let i = 0; i < BIRD_COUNT; i++) {
    const boid = new Boid()

    boid.position.x = Math.random() * 400 - 800
    boid.position.y = Math.random() * 400 + 400
    boid.position.z = Math.random() * 400 - 200
    boid.velocity.x = Math.random() * 2 - 1
    boid.velocity.y = Math.random() * 2 - 1
    boid.velocity.z = Math.random() * 2 - 1
    boid.setAvoidWalls(true)

    // Note the argument order: the original passed (height, width, depth) into
    // a (width, height, depth) signature. That transposition is what gives the
    // flock its wide, shallow box, so it is preserved deliberately.
    boid.setWorldSize(window.innerHeight, window.innerWidth, 400)

    const bird = new Mesh(
      createBirdGeometry(),
      new MeshBasicMaterial({ color: Math.random() * 0xffffff, side: DoubleSide }),
    )

    boids.push(boid)
    birds.push(bird)
    phases.push(Math.floor(Math.random() * 62.83))
    scene.add(bird)
  }

  const pointer = new Vector3()

  const onPointerMove = (event: PointerEvent): void => {
    pointer.set(event.clientX - window.innerWidth / 2, -event.clientY + window.innerHeight / 2, 0)
    for (const boid of boids) {
      pointer.z = boid.position.z
      boid.repulse(pointer)
    }
  }

  const onResize = (): void => layout()

  layout()

  document.addEventListener('pointermove', onPointerMove, { passive: true })
  window.addEventListener('resize', onResize, { passive: true })

  let frame = 0

  const tick = (): void => {
    frame = requestAnimationFrame(tick)

    for (let i = 0; i < birds.length; i++) {
      const boid = boids[i]
      const bird = birds[i]
      if (!boid || !bird) continue

      boid.run(boids)

      // Depth fog: birds further back wash out toward the sky.
      const shade = (500 - boid.position.z) / 1000
      bird.material.color.setRGB(shade, shade, shade)

      bird.position.copy(boid.position)
      bird.rotation.y = Math.atan2(-boid.velocity.z, boid.velocity.x)
      bird.rotation.z = Math.asin(boid.velocity.y / boid.velocity.length())

      // Halved from the original. A wingbeat tuned to a bird moving twice as
      // fast reads as a frantic flutter at this pace.
      const phase = ((phases[i] ?? 0) + (Math.max(0, bird.rotation.z) + 0.1) * 0.5) % 62.83
      phases[i] = phase

      const positions = bird.geometry.getAttribute('position') as BufferAttribute
      const flap = Math.sin(phase) * 5
      positions.array[WINGTIP_LEFT_Y] = flap
      positions.array[WINGTIP_RIGHT_Y] = flap
      positions.needsUpdate = true
    }

    // Same scene, same frame, two views of it.
    rendererMain.render(scene, cameraMain)
    rendererFooter.render(scene, cameraFooter)
  }

  // Suspend the loop when the tab is hidden — otherwise it keeps a GPU busy
  // in a background tab indefinitely.
  const onVisibility = (): void => {
    if (document.hidden) {
      cancelAnimationFrame(frame)
    } else {
      frame = requestAnimationFrame(tick)
    }
  }
  document.addEventListener('visibilitychange', onVisibility)

  frame = requestAnimationFrame(tick)

  running = {
    stop(): void {
      cancelAnimationFrame(frame)
      document.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('resize', onResize)
      for (const bird of birds) {
        bird.geometry.dispose()
        bird.material.dispose()
      }
      rendererMain.dispose()
      rendererFooter.dispose()
      canvasMain.remove()
      canvasFooter.remove()
      running = null
    },
  }

  return running
}
