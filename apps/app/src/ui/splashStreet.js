// The people on the still sidewalk of the splash scene: two lanes of walkers
// and a few figures standing about. The app splash, the web pre-splash overlay
// and the site landing are all generated from this module, so the three show
// the same cast moving the same way. Numbers are scene units at k = 1, y from
// the top of the 96-high near band. Shapes use the birdArt format and name
// palette keys of splashScene.js, so one drawing serves light and dark.

// Draw order is the order of `rows`: the back lane, the standing row, then the
// front lane passing in front of everyone.
//
// Both lanes walk at the same speed: two lanes of different speeds drift in
// and out of step, and for long stretches a narrow screen showed nobody at
// all. At one speed the lanes take turns, so a 320 or 390 wide screen has a
// walker in view most of the time (the occupancy test). The first mover of
// each lane is on screen at the first frame: the front walker about to leave
// on the right as the dog walker comes in beside it.
export const STREET = deepFreeze({
  band: 96,
  rows: [
    { name: 'back', feet: 52, scale: 0.875 },
    { name: 'standing', feet: 72, scale: 1 },
    { name: 'front', feet: 92, scale: 1 }
  ],
  // Track period and the margin past each edge where a walker turns around
  // unseen. The period covers scenes up to 1440 units at constant speed.
  track: { period: 1600, margin: 80 },
  lanes: {
    // Left to right.
    indo: {
      row: 'front',
      mirrored: false,
      speed: 40,
      ms: 40000,
      strideMs: 1000,
      movers: [
        { figure: 'caminhante', tint: 'planta', x: 292 },
        { figure: 'caminhante', tint: 'beiral', x: 1092 }
      ]
    },
    // Right to left: the same motion inside a container mirrored with
    // scaleX(-1), so x counts from the right edge and the art turns to face
    // left with no second code path.
    vindo: {
      row: 'back',
      mirrored: true,
      speed: 40,
      ms: 40000,
      strideMs: 800,
      movers: [
        { figure: 'passeador', tint: 'tinta', x: 4 },
        { figure: 'caminhante', tint: 'copa', x: 804 }
      ]
    }
  },
  // x is the figure's left edge as an offset from the scene centre, kept
  // inside +-150 so everyone fits a 320 wide screen. The kids face each other
  // with the ball at the first kid's feet.
  standing: [
    { figure: 'crianca', tint: 'beiral', x: -132, mirrored: false },
    { figure: 'crianca', tint: 'planta', x: -86, mirrored: true },
    { figure: 'bola', tint: 'tinta', x: -118, mirrored: false },
    { figure: 'roda', tint: 'tronco', x: 44, mirrored: false }
  ],
  // One loop for everyone standing: the chat swaps the raised arm once, the
  // kids hop in turn and the ball goes to the second kid and back.
  idle: { ms: 2400, poseCycles: 1, hop: 6, ballPeak: 14, ballTravel: 26, samples: 16 }
})

// The keys that reach 3:1 on pedra in both palettes; every torso, leg and dog
// is one of these so a figure never fades into the stones.
export const TINTS = deepFreeze(['tinta', 'planta', 'beiral', 'copa', 'tronco'])

// Closed paths, so only the joins need rounding; the limbs keep round feet
// and hands and their corners stay sharp, which reads as a shoe.
const OUTLINE = { fill: 'pedra', stroke: 'pedra', width: 3, join: 'round' }
const LIMB = { width: 3, cap: 'round' }
const LEG = { width: 3.5, cap: 'round' }

function circle (cx, cy, r) {
  return 'M' + (cx - r) + ' ' + cy + 'A' + r + ' ' + r + ' 0 1 0 ' + (cx + r) + ' ' + cy +
    'A' + r + ' ' + r + ' 0 1 0 ' + (cx - r) + ' ' + cy + 'Z'
}

// A torso with sloped shoulders, w wide and h tall, its top-left at x, y.
function torso (x, y, w, h) {
  return 'M' + (x + 1.5) + ' ' + y + 'H' + (x + w - 1.5) + 'L' + (x + w) + ' ' + (y + 1.5) + 'L' + (x + w - 0.5) + ' ' + (y + h) +
    'H' + (x + 0.5) + 'L' + x + ' ' + (y + 1.5) + 'Z'
}

function others (tint) {
  return TINTS.filter((k) => k !== tint && k !== 'copa')
}

// An adult seen side on, facing right, in a 20 wide column at dx. The legs
// are not here: they change with the pose.
const ADULT_HEAD = circle(11, 7, 5)
const ADULT_TORSO = torso(6.5, 13, 9, 15)
// Stride: back foot behind, front foot ahead. Passing: one leg straight, the
// other knee forward with its foot lifted behind.
const STRIDE = 'M10 28L6 44.5L8 45.5M12 28L16 45H18'
const PASSING = 'M11 28L12 45H14M11 28L14 36L10 42'
// One pale patch under both leg poses, so either pose has its edge.
const LEG_FAN = 'M8 27L3.5 46.5H18.5L14 27Z'

function caminhante (tint) {
  return {
    viewBox: '0 0 20 48',
    width: 20,
    height: 48,
    body: [
      { d: 'M8 2H14L16 4V28H2V20H6V4Z' + LEG_FAN, ...OUTLINE },
      { d: ADULT_HEAD, fill: 'tronco' },
      { d: ADULT_TORSO, fill: tint },
      // A shoulder bag: the strap across the chest and the bag on the hip.
      { d: 'M13 13L14.5 14.5L6 21.5L4.5 20.5ZM2.5 20.5H8V27H2.5Z', fill: 'sol' }
    ],
    a: [{ d: STRIDE, stroke: 'tinta', ...LEG }],
    b: [{ d: PASSING, stroke: 'tinta', ...LEG }]
  }
}

function passeador (tint) {
  return {
    viewBox: '0 0 52 48',
    width: 52,
    height: 48,
    body: [
      {
        d: 'M8 2H14L16 4V13L19 21Q30 32 42 28V24H48L50.5 28V31L48 33V40L48 46.5H28L29 39L28 34L27 24H31L32 31Q30 34 18 25L16 28H6V4Z' + LEG_FAN,
        ...OUTLINE
      },
      { d: ADULT_HEAD, fill: 'tronco' },
      { d: ADULT_TORSO, fill: tint },
      // The arm holding the lead and the dog's tail, up.
      { d: 'M12.5 15.5L17.5 22.5M31 32.5Q28 30.5 29 26', stroke: 'tronco', ...LIMB },
      // The lead sags from the hand to the collar.
      { d: 'M17.5 22.5Q30 33 43 30', stroke: 'beiral', ...LIMB },
      // The dog: body, head with the snout ahead, a dark ear and the collar.
      { d: 'M31 31H45L46.5 32.5V37.5L45 39H31L29.5 37.5V32.5ZM43 33V26.5L44.5 25H47.5L50.5 28.5L49.5 30H47.5L46.5 33Z', fill: 'tronco' },
      { d: 'M43.5 25.5L46 25.5L45 30.5L43.5 30Z', fill: 'tinta' },
      { d: 'M43 31H46.5L46.5 33H43Z', fill: 'sol' }
    ],
    a: [
      { d: STRIDE, stroke: 'tinta', ...LEG },
      { d: 'M45 38L47 45M44 38L42 45M33 38L35 45M32 38L30 45', stroke: 'tronco', ...LIMB }
    ],
    b: [
      { d: PASSING, stroke: 'tinta', ...LEG },
      { d: 'M44 38L45 45M44 38L43 45M32 38L33 45M32 38L31 45', stroke: 'tronco', ...LIMB }
    ]
  }
}

// Three adults in a chat: the outer two side on, facing in, the middle one
// facing us a step further back. The one on the right talks with a hand.
function roda (tint) {
  const [mid, right] = others(tint)
  const headL = circle(11, 7, 5)
  const headM = circle(28, 8.5, 5)
  const headR = circle(45, 7, 5)
  return {
    viewBox: '0 0 56 48',
    width: 56,
    height: 48,
    body: [
      {
        d: 'M8 2H14L16 4V46.5H6V4Z' +
          'M25 3.5H31L33.5 6V44.5H22.5V6Z' +
          'M42 2H48L50 4V46.5H40V4Z' +
          // The left one's forearm, then both arm poses on the right, so
          // either keeps its edge.
          'M13 15.5L16 22.5L20 20.5L19 19L15.5 20Z' +
          'M44 14L37 12V20L40 27H43Z',
        ...OUTLINE
      },
      { d: headL, fill: 'tinta' },
      { d: headM + headR, fill: 'tronco' },
      { d: torso(6.5, 13, 9, 15), fill: tint },
      { d: torso(22.5, 14.5, 11, 14.5), fill: mid },
      { d: torso(40.5, 13, 9, 15), fill: right },
      // Everyone's legs, and the left one's forearm held out as they talk.
      { d: 'M9.5 28V45M12.5 28V45H14M26 29V43M30 29V43M46.5 28V45M43.5 28V45H42M13.5 16L15.5 21.5L19.5 20', stroke: 'tinta', ...LEG }
    ],
    a: [{ d: 'M42.5 16L40.5 25.5', stroke: 'tronco', ...LIMB }],
    b: [{ d: 'M42.5 16L39 20.5L38.5 13.5', stroke: 'tronco', ...LIMB }]
  }
}

function crianca (tint) {
  const head = circle(7, 6, 4.5)
  return {
    viewBox: '0 0 14 30',
    width: 14,
    height: 30,
    body: [
      { d: 'M4.5 1.5H9.5L11.5 4V9L12.5 17.5L10.5 20L12 28.5H2L3.5 20L2.5 9V4Z', ...OUTLINE },
      { d: head, fill: 'tronco' },
      { d: torso(3.5, 11.5, 7, 8.5), fill: tint },
      // The legs and an arm out toward the ball.
      { d: 'M5.5 20L4 27M8.5 20L10 27M9.5 13.5L11 17', stroke: 'tinta', ...LIMB }
    ],
    a: [],
    b: []
  }
}

function bola () {
  return {
    viewBox: '0 0 6 6',
    width: 6,
    height: 6,
    body: [
      { d: circle(3, 3, 1.5), ...OUTLINE },
      { d: circle(3, 3, 1.5), fill: 'sol', stroke: 'tinta', width: 1.5 }
    ],
    a: [],
    b: []
  }
}

const BUILDERS = { caminhante, passeador, roda, crianca, bola }
const DEFAULT_TINT = { caminhante: 'planta', passeador: 'tinta', roda: 'tronco', crianca: 'beiral', bola: 'tinta' }
const ART = new Map()

// Art faces right. `body` never changes; `a` and `b` are the two poses of
// the part that moves, drawn after the body. Unknown tints fall back to the
// figure's default so a typo can never produce an unreadable fill.
export function figureArt (name, tint) {
  if (!Object.prototype.hasOwnProperty.call(BUILDERS, name)) return null
  const t = TINTS.includes(tint) ? tint : DEFAULT_TINT[name]
  const key = name + ':' + t
  if (!ART.has(key)) ART.set(key, deepFreeze(BUILDERS[name](t)))
  return ART.get(key)
}

export function streetMotion (reduced) {
  return reduced === true ? null : STREET
}

// Wider scenes stretch the track, so a walker always leaves past the far edge
// before it comes round again and never pops in on screen.
export function trackUnits (sceneUnits) {
  const { period, margin } = STREET.track
  const u = Number.isFinite(sceneUnits) && sceneUnits > 0 ? sceneUnits : 0
  return Math.max(period, u + 2 * margin)
}

function laneOf (lane) {
  return typeof lane === 'string' ? STREET.lanes[lane] : lane
}

// Where in its loop a mover starts: at t = 0 its left edge is at x when the
// track is the period.
export function moverPhase (lane, mover) {
  const { period, margin } = STREET.track
  return (mover.x + margin) / period
}

// A renderer starts the mover's loop this far in (a negative CSS delay, or
// the Animated value's start), so every mover is spread out from frame one.
export function moverDelayMs (lane, mover) {
  return Math.round(moverPhase(lane, mover) * laneOf(lane).ms)
}

// Opacities for pose a and b over one loop: `cycles` whole a-then-b swaps,
// each switch taking 0.001 of the loop, back on pose a at 1.
export function poseSwap (cycles) {
  const n = Number.isInteger(cycles) && cycles > 0 ? cycles : 1
  const input = [0]
  const a = [1]
  for (let j = 1; j <= 2 * n; j++) {
    const s = j / (2 * n)
    const before = j % 2 === 1 ? 1 : 0
    input.push(r4(s - 0.001), j === 2 * n ? 1 : r4(s))
    a.push(before, 1 - before)
  }
  return { input, a, b: a.map((v) => 1 - v) }
}

function r2 (n) {
  const v = Math.round(n * 100) / 100
  return v === 0 ? 0 : v
}

function r4 (n) {
  return Math.round(n * 10000) / 10000
}

function samples (fn) {
  const n = STREET.idle.samples
  const input = []
  const out = []
  for (let i = 0; i <= n; i++) {
    input.push(i / n)
    out.push(fn(i / n))
  }
  return { input, out }
}

// A kid's hop, y up negative. Kid 0 hops in the first half of the loop, kid 1
// in the second; the curve never goes below the feet line.
export function kidHop (i) {
  const { hop } = STREET.idle
  const from = i === 1 ? 0.5 : 0
  const s = samples((p) => {
    const q = p - from
    return q >= 0 && q <= 0.5 ? r2(-hop * Math.sin(2 * Math.PI * q)) : 0
  })
  return { input: s.input, y: s.out }
}

// The ball from the first kid to the second and back, one arc each way,
// resting at the first kid at 0 and 1 and never below the ground.
export function ballArc () {
  const { ballPeak, ballTravel } = STREET.idle
  const x = samples((p) => r2(ballTravel * (1 - Math.cos(2 * Math.PI * p)) / 2))
  const y = samples((p) => r2(-ballPeak * Math.abs(Math.sin(2 * Math.PI * p))))
  return { input: x.input, x: x.out, y: y.out }
}

function rowOf (name) {
  return STREET.rows.find((r) => r.name === name)
}

// Pixel boxes for the app, relative to the near band's top-left corner (the
// band is a clipping View). A mover's left edge at time t is
// start + ((phase + t / ms) mod 1) * track; mirrored lanes sit in a container
// flipped with scaleX(-1) that is as wide as the band.
export function streetLayout (layout) {
  const k = layout && Number.isFinite(layout.k) && layout.k > 0 ? layout.k : 1
  const width = layout && Number.isFinite(layout.width) && layout.width > 0 ? layout.width : 0
  const near = (layout && layout.near) || { y: 0, height: STREET.band * k }
  const { margin } = STREET.track
  const track = trackUnits(width / k) * k
  const movers = []
  for (const [name, lane] of Object.entries(STREET.lanes)) {
    const row = rowOf(lane.row)
    for (const mover of lane.movers) {
      const art = figureArt(mover.figure, mover.tint)
      const h = art.height * row.scale
      movers.push({
        lane: name,
        figure: mover.figure,
        tint: mover.tint,
        w: art.width * row.scale * k,
        h: h * k,
        top: (row.feet - h) * k,
        start: -margin * k,
        track,
        mirrored: lane.mirrored,
        phase: moverPhase(lane, mover),
        delayMs: moverDelayMs(lane, mover),
        ms: lane.ms,
        strideMs: lane.strideMs
      })
    }
  }
  const row = rowOf('standing')
  const standing = STREET.standing.map((s) => {
    const art = figureArt(s.figure, s.tint)
    return {
      figure: s.figure,
      tint: s.tint,
      left: width / 2 + s.x * k,
      top: (row.feet - art.height) * k,
      w: art.width * k,
      h: art.height * k,
      mirrored: s.mirrored
    }
  })
  return deepFreeze({
    band: { top: near.y, height: near.height, width },
    movers,
    standing
  })
}

function deepFreeze (value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key])
    Object.freeze(value)
  }
  return value
}
