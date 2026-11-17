'use strict'

// The sidewalk cast (src/ui/splashStreet.js), a pure ES module that the app
// splash, the web overlay and the landing are generated from; import() loads
// it here through Node's module syntax detection.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const load = () => import('../src/ui/splashStreet.js')
const scene = () => import('../src/ui/splashScene.js')
const SRC = path.join(__dirname, '../src/ui/splashStreet.js')
const FIGURES = ['caminhante', 'passeador', 'roda', 'crianca', 'bola']
const ACCENTS = ['sol', 'telha']

// Absolute commands only. For A only the end point is a coordinate; circles
// are returned with their radius so heads can be measured.
function parse (d) {
  const subpaths = []
  let cur = null
  let last = [0, 0]
  for (const m of d.matchAll(/([MLCQAZHV])([^MLCQAZHV]*)/gi)) {
    const cmd = m[1]
    const nums = (m[2].match(/-?\d*\.?\d+/g) || []).map(Number)
    if (cmd === 'M') {
      cur = { points: [], radius: null }
      subpaths.push(cur)
    }
    if (cmd === 'Z') continue
    const pts = []
    if (cmd === 'H') for (const x of nums) pts.push([x, last[1]])
    else if (cmd === 'V') for (const y of nums) pts.push([last[0], y])
    else if (cmd === 'A') {
      for (let i = 0; i + 6 < nums.length; i += 7) pts.push([nums[i + 5], nums[i + 6]])
      cur.radius = nums[0]
    } else for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]])
    for (const p of pts) {
      cur.points.push(p)
      last = p
    }
  }
  return subpaths
}

function bbox (shape) {
  const pts = parse(shape.d).flatMap((s) => s.points)
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }
}

function allShapes (art) {
  return [...art.body, ...art.a, ...art.b]
}

// WCAG relative luminance and contrast ratio.
function lum (hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

function contrast (a, b) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

// A mover's left edge (in its lane's own direction) at time t.
function leftAt (m, lane, mover, sceneUnits, t) {
  const { margin } = m.STREET.track
  const track = m.trackUnits(sceneUnits)
  const p = m.moverPhase(lane, mover) + t / lane.ms
  return -margin + (p - Math.floor(p)) * track
}

function rowScale (m, lane) {
  return m.STREET.rows.find((r) => r.name === lane.row).scale
}

test('splashStreet: pure, deterministic and frozen', async (t) => {
  const src = fs.readFileSync(SRC, 'utf8')
  for (const banned of ['import ', "from 'react", 'require(', 'node:', 'Math.random', 'Date']) {
    t.absent(src.includes(banned), 'no ' + banned)
  }
  t.absent(src.includes('\u2014'), 'no em dash')
  t.absent(fs.readFileSync(__filename, 'utf8').includes('\u2014'), 'no em dash in the test')
  const m = await load()
  t.ok(Object.isFrozen(m.STREET) && Object.isFrozen(m.STREET.lanes.indo.movers[0]), 'STREET is deep frozen')
  t.ok(Object.isFrozen(m.STREET.idle) && Object.isFrozen(m.STREET.standing[0]))
  for (const name of FIGURES) {
    const art = m.figureArt(name)
    t.is(m.figureArt(name), art, name + ' is built once')
    t.ok(Object.isFrozen(art) && Object.isFrozen(art.body[0]) && Object.isFrozen(art.a), name + ' is frozen')
  }
  t.alike(m.streetLayout({ k: 1, width: 390, near: { y: 10, height: 96 } }), m.streetLayout({ k: 1, width: 390, near: { y: 10, height: 96 } }))
  t.ok(Object.isFrozen(m.streetLayout({ k: 1, width: 390 }).movers[0]), 'layout is frozen')
  t.is(m.figureArt('nobody'), null)
  t.is(m.figureArt('caminhante', 'sol'), m.figureArt('caminhante'), 'an accent can never be a torso')
})

test('splashStreet: figures, sizes and poses', async (t) => {
  const m = await load()
  const sizes = { caminhante: [20, 48], passeador: [52, 48], roda: [56, 48], crianca: [14, 30], bola: [6, 6] }
  for (const [name, [w, h]] of Object.entries(sizes)) {
    const art = m.figureArt(name)
    t.alike([art.width, art.height, art.viewBox], [w, h, '0 0 ' + w + ' ' + h], name)
  }
  for (const name of ['caminhante', 'passeador', 'roda']) {
    const art = m.figureArt(name)
    t.ok(art.a.length > 0 && art.a.length === art.b.length, name + ' has two poses')
    t.not(JSON.stringify(art.a), JSON.stringify(art.b), name + ' poses differ')
  }
  t.is(m.figureArt('passeador').a.length, 2, 'the person and the dog both step')
  for (const name of ['crianca', 'bola']) t.alike([m.figureArt(name).a, m.figureArt(name).b], [[], []])
  t.is(m.figureArt('caminhante').height * 0.375, 18, 'an adult is 18 px at the smallest k')
  for (const tint of m.TINTS) {
    t.ok(allShapes(m.figureArt('caminhante', tint)).some((s) => s.fill === tint), 'tint ' + tint + ' is the torso')
  }
})

test('splashStreet: path data is plain and stays in its box', async (t) => {
  const m = await load()
  for (const name of FIGURES) {
    const art = m.figureArt(name)
    for (const s of allShapes(art)) {
      t.ok(/^[MLQAZHV0-9 .-]+$/.test(s.d), name + ': path alphabet')
      t.absent(s.d.includes('NaN'), name + ': no NaN')
      const pts = parse(s.d).flatMap((sp) => sp.points)
      const out = pts.filter(([x, y]) => x < 0 || x > art.width || y < 0 || y > art.height)
      t.alike(out, [], name + ': inside ' + art.viewBox)
      for (const [x, y] of pts) {
        if (Math.round(x * 10) !== x * 10 || Math.round(y * 10) !== y * 10) {
          t.fail(name + ': ' + x + ',' + y + ' has more than one decimal')
        }
      }
    }
    // The outline's own stroke stays inside too, so no renderer clips it.
    for (const sp of parse(art.body[0].d)) {
      for (const [x, y] of sp.points) {
        const r = sp.radius ? 1.5 + sp.radius : 1.5
        t.ok(x >= 1.5 && x <= art.width - 1.5 && y >= 1.5 && y <= art.height - 1.5 && (!sp.radius || r <= art.width), name + ': outline edge inside')
      }
    }
  }
  const json = JSON.stringify(FIGURES.map((n) => m.figureArt(n)))
  t.ok(json.length < 3500, 'all art is ' + json.length + ' characters')
})

test('splashStreet: every key exists in both palettes', async (t) => {
  const m = await load()
  const { scenePalette } = await scene()
  for (const scheme of ['light', 'dark']) {
    const pal = scenePalette(scheme)
    for (const name of FIGURES) {
      for (const tint of m.TINTS) {
        for (const s of allShapes(m.figureArt(name, tint))) {
          for (const key of [s.fill, s.stroke].filter(Boolean)) {
            t.ok(/^#[0-9a-f]{6}$/.test(pal[key]), scheme + ' has ' + key)
          }
        }
      }
    }
  }
})

test('splashStreet: readability rules', async (t) => {
  const m = await load()
  const { scenePalette } = await scene()
  // (2) Every main colour reaches 3:1 on the stones in both schemes.
  for (const scheme of ['light', 'dark']) {
    const pal = scenePalette(scheme)
    for (const key of m.TINTS) {
      t.ok(contrast(pal[key], pal.pedra) >= 3, scheme + ': ' + key + ' on pedra ' + contrast(pal[key], pal.pedra).toFixed(2))
    }
  }
  for (const name of FIGURES) {
    for (const tint of m.TINTS) {
      const art = m.figureArt(name, tint)
      // (1) The outline first, pale, wide enough to be an edge on black.
      const [outline] = art.body
      t.alike([outline.fill, outline.stroke, outline.width, outline.join], ['pedra', 'pedra', 3, 'round'], name + ': outline')
      const rest = allShapes(art).filter((s) => s !== outline)
      t.absent(rest.some((s) => s.fill === 'pedra' || s.stroke === 'pedra'), name + ': one outline only')
      const main = rest.filter((s) => !ACCENTS.includes(s.fill) && !ACCENTS.includes(s.stroke))
      for (const s of main) {
        for (const key of [s.fill, s.stroke].filter(Boolean)) t.ok(m.TINTS.includes(key), name + ': main colour ' + key)
      }
      // (3) Accents are small and touch a dark fill.
      for (const s of rest.filter((s) => ACCENTS.includes(s.fill) || ACCENTS.includes(s.stroke))) {
        if (name === 'bola') {
          t.alike([s.fill, s.stroke, s.width], ['sol', 'tinta', 1.5], 'the ball is sol with an ink edge')
          continue
        }
        t.absent(s.stroke, name + ': accents are fills')
        const b = bbox(s)
        for (const sp of parse(s.d)) {
          const xs = sp.points.map((p) => p[0])
          const ys = sp.points.map((p) => p[1])
          t.ok(Math.max(...xs) - Math.min(...xs) <= 10 && Math.max(...ys) - Math.min(...ys) <= 9, name + ': accent is small')
        }
        const touches = main.some((o) => {
          const c = bbox(o)
          return b.x0 <= c.x1 + 1 && c.x0 <= b.x1 + 1 && b.y0 <= c.y1 + 1 && c.y0 <= b.y1 + 1
        })
        t.ok(touches, name + ': accent next to a dark fill')
      }
      // (4) Strokes are at least 3, heads at least 9 across.
      for (const s of rest) if (s.stroke && name !== 'bola') t.ok(s.width >= 3, name + ': stroke ' + s.width)
      if (name === 'bola') continue
      const heads = main.filter((s) => s.fill).flatMap((s) => parse(s.d)).filter((sp) => sp.radius)
      t.ok(heads.length >= (name === 'roda' ? 3 : 1), name + ': has heads')
      for (const h of heads) t.ok(2 * h.radius >= 9, name + ': head ' + 2 * h.radius + ' across')
    }
  }
})

test('splashStreet: rows, lanes and track', async (t) => {
  const m = await load()
  const { STREET } = m
  t.alike(STREET.rows.map((r) => [r.name, r.feet, r.scale]), [['back', 52, 0.875], ['standing', 72, 1], ['front', 92, 1]])
  t.alike(STREET.track, { period: 1600, margin: 80 })
  const { period: P } = STREET.track
  t.alike([STREET.lanes.indo.row, STREET.lanes.indo.mirrored], ['front', false])
  t.alike([STREET.lanes.vindo.row, STREET.lanes.vindo.mirrored], ['back', true])
  t.ok(STREET.lanes.vindo.movers.some((v) => v.figure === 'passeador'), 'the dog walker comes the other way')
  for (const [name, lane] of Object.entries(STREET.lanes)) {
    t.is(lane.ms, P / lane.speed * 1000, name + ': ms follows the speed')
    t.ok(Number.isInteger(lane.ms / lane.strideMs), name + ': whole strides per crossing')
    t.is(lane.movers.length, 2)
    t.is(Math.abs(lane.movers[1].x - lane.movers[0].x), P / 2, name + ': half a track apart')
    const [a, b] = lane.movers
    const gap = Math.abs(a.x - b.x) % P
    const widest = Math.max(...lane.movers.map((v) => m.figureArt(v.figure).width))
    t.ok(Math.min(gap, P - gap) > widest, name + ': movers never overlap')
    for (const mover of lane.movers) {
      t.ok(m.TINTS.includes(mover.tint))
      const phase = m.moverPhase(name, mover)
      t.ok(phase >= 0 && phase < 1)
      t.is(m.moverPhase(lane, mover), phase, 'a lane by name or object')
      t.is(m.moverDelayMs(lane, mover), Math.round(phase * lane.ms), 'delay agrees with phase')
      t.is(leftAt(m, lane, mover, 390, 0), mover.x, 'at rest a mover is at its x')
    }
  }
  t.is(m.trackUnits(390), 1600)
  t.is(m.trackUnits(1440), 1600)
  t.is(m.trackUnits(3000), 3160)
  t.is(m.trackUnits(NaN), 1600)
  t.is(m.streetMotion(false), STREET)
  t.is(m.streetMotion(true), null, 'reduced motion keeps the street still')
})

test('splashStreet: someone is walking on a narrow screen', async (t) => {
  const m = await load()
  const lanes = Object.values(m.STREET.lanes)
  for (const W of [320, 390]) {
    // First frame: one mover per lane in view.
    for (const lane of lanes) {
      const seen = lane.movers.filter((v) => {
        const w = m.figureArt(v.figure).width * rowScale(m, lane)
        const left = leftAt(m, lane, v, W, 0)
        return left > -w && left < W
      })
      t.is(seen.length, 1, W + ': one mover per lane on the first frame')
    }
    const loop = Math.max(...lanes.map((l) => l.ms))
    t.ok(lanes.every((l) => loop % l.ms === 0), 'the lanes share a loop')
    const N = 2000
    let seen = 0
    for (let i = 0; i < N; i++) {
      const tt = i / N * loop
      const any = lanes.some((lane) => lane.movers.some((v) => {
        const w = m.figureArt(v.figure).width * rowScale(m, lane)
        const left = leftAt(m, lane, v, W, tt)
        return left > -w && left < W
      }))
      if (any) seen++
    }
    t.ok(seen / N >= 0.75, W + ': a walker in view ' + (100 * seen / N).toFixed(1) + '% of the time')
  }
})

test('splashStreet: standing figures and the idle loop', async (t) => {
  const m = await load()
  const { STREET } = m
  const [kid0, kid1, ball, roda] = STREET.standing
  t.alike([kid0.figure, kid1.figure, ball.figure, roda.figure], ['crianca', 'crianca', 'bola', 'roda'])
  t.alike([kid0.x, kid1.x, roda.x], [-132, -86, 44])
  t.alike([kid0.mirrored, kid1.mirrored], [false, true], 'the kids face each other')
  const w = (s) => m.figureArt(s.figure).width
  t.is(ball.x, kid0.x + w(kid0), 'the ball rests at the first kid')
  t.is(ball.x + STREET.idle.ballTravel, kid1.x - w(ball), 'and travels to the second')
  const groups = [[kid0.x, kid1.x + w(kid1)], [roda.x, roda.x + w(roda)]]
  for (const [a, b] of groups) t.ok(a >= -150 && b <= 150, 'inside +-150, so a 320 screen fits it')
  t.ok(groups[0][1] < groups[1][0], 'the groups do not overlap')

  // Every top stays at y >= 4, hop and ball arc included.
  const { idle } = STREET
  for (const lane of Object.values(STREET.lanes)) {
    const row = STREET.rows.find((r) => r.name === lane.row)
    for (const v of lane.movers) t.ok(row.feet - m.figureArt(v.figure).height * row.scale >= 4)
  }
  t.ok(72 - 30 - idle.hop >= 4 && 72 - 6 - idle.ballPeak >= 4 && 72 - 48 >= 4)

  t.is(idle.ms, 2400)
  const swap = m.poseSwap(idle.poseCycles)
  t.alike([swap.input[0], swap.a[0], swap.b[0]], [0, 1, 0], 'pose a at rest')
  t.alike([swap.input.at(-1), swap.a.at(-1), swap.b.at(-1)], [1, 1, 0], 'back on pose a at the end')
  for (let i = 1; i < swap.input.length; i++) {
    t.ok(swap.input[i] > swap.input[i - 1], 'input increases')
    if (swap.a[i] !== swap.a[i - 1]) t.ok(swap.input[i] - swap.input[i - 1] <= 0.0011, 'switches within 0.001')
  }
  t.ok(swap.a.every((v, i) => v + swap.b[i] === 1))
  const many = m.poseSwap(50)
  t.is(many.a.filter((v, i) => i > 0 && v !== many.a[i - 1]).length, 100, '50 cycles, 100 switches')

  for (const i of [0, 1]) {
    const hop = m.kidHop(i)
    t.is(hop.input.length, 17)
    t.alike([hop.y[0], hop.y.at(-1)], [0, 0], 'kid ' + i + ' rests at both ends')
    t.ok(hop.y.every((y) => y <= 0 && y >= -idle.hop), 'never below the feet')
    t.is(Math.min(...hop.y), -idle.hop)
    const half = hop.input.map((p, j) => [p, hop.y[j]]).filter(([, y]) => y < 0)
    t.ok(half.every(([p]) => i === 0 ? p < 0.5 : p > 0.5), 'kid ' + i + ' hops in its half')
  }
  const arc = m.ballArc()
  t.is(arc.input.length, 17)
  t.alike([arc.x[0], arc.y[0], arc.x.at(-1), arc.y.at(-1)], [0, 0, 0, 0], 'the ball rests at the first kid')
  t.is(Math.max(...arc.x), idle.ballTravel)
  t.is(Math.min(...arc.y), -idle.ballPeak)
  t.ok(arc.y.every((y) => y <= 0), 'never below the ground')
})

test('splashStreet: layout boxes stay inside the near band', async (t) => {
  const m = await load()
  const { sceneLayout, SCALE_STEPS } = await scene()
  for (const step of SCALE_STEPS) {
    for (const width of [320, 390, 768, 1280]) {
      const l = sceneLayout({ width, height: step.minHeight + 1 })
      t.is(l.k, step.k)
      const s = m.streetLayout(l)
      const k = l.k
      t.alike(s.band, { top: l.near.y, height: l.near.height, width }, 'band')
      t.ok(Math.abs(s.band.height - 96 * k) < 1e-9)
      t.is(s.movers.length, 4)
      for (const v of s.movers) {
        t.ok(v.top >= 0 && v.top + v.h <= s.band.height + 1e-9, width + '@' + k + ': ' + v.figure + ' inside the band')
        t.is(v.start, -80 * k)
        t.is(v.track, m.trackUnits(width / k) * k)
        t.is(v.mirrored, v.lane === 'vindo')
        t.ok(Number.isInteger(v.delayMs) && v.delayMs >= 0 && v.delayMs < v.ms)
      }
      for (const b of s.standing) {
        t.ok(b.left >= 0 && b.left + b.w <= width, width + '@' + k + ': ' + b.figure + ' inside the width')
        t.ok(b.top >= 0 && b.top + b.h <= s.band.height + 1e-9, width + '@' + k + ': ' + b.figure + ' inside the band')
      }
    }
  }
  const s = m.streetLayout(sceneLayout({ width: 390, height: 800 }))
  const walker = s.movers[0]
  t.alike([walker.w, walker.h, walker.top], [20, 48, 44], 'front walker, feet on 92')
  const back = s.movers.find((v) => v.figure === 'passeador')
  t.alike([back.w, back.h, back.top], [45.5, 42, 10], 'back lane at 0.875, feet on 52')
  t.is(s.standing[3].left, 195 + 44)
})
