'use strict'

// The splash scene geometry (src/ui/splashScene.js), a pure ES module that
// both the react-native-svg component and the static HTML overlay draw from;
// import() loads it here through Node's module syntax detection.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const load = () => import('../src/ui/splashScene.js')
const SRC = path.join(__dirname, '../src/ui/splashScene.js')
const ASSETS = path.join(__dirname, '../../site/public/assets')

// Absolute commands only (the module writes no relative ones). For A only
// the end point is a coordinate; the radii and flags are not.
function parse (d) {
  const subpaths = []
  let cur = null
  let last = [0, 0]
  for (const m of d.matchAll(/([MLCQAZHV])([^MLCQAZHV]*)/gi)) {
    const cmd = m[1]
    const nums = (m[2].match(/-?\d*\.?\d+/g) || []).map(Number)
    if (cmd === 'M') {
      cur = { points: [] }
      subpaths.push(cur)
    }
    if (cmd === 'Z') continue
    const pts = []
    if (cmd === 'H') for (const x of nums) pts.push([x, last[1]])
    else if (cmd === 'V') for (const y of nums) pts.push([last[0], y])
    else if (cmd === 'A') for (let i = 0; i + 6 < nums.length; i += 7) pts.push([nums[i + 5], nums[i + 6]])
    else for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]])
    for (const p of pts) {
      cur.points.push(p)
      last = p
    }
  }
  return subpaths
}

function tiles (m) {
  return {
    near: m.nearTile(),
    saoPaulo: m.spMapTile(),
    far: m.farTile(),
    varanda: m.varandaArt(),
    tree: m.treeArt(),
    bird: m.birdArt(),
    butterfly: m.butterflyArt()
  }
}

function box (tile) {
  const [, , w, h] = tile.viewBox.split(' ').map(Number)
  return { w, h }
}

function svgPaths (file) {
  const svg = fs.readFileSync(path.join(ASSETS, file), 'utf8')
  return [...svg.matchAll(/<path\b([^>]*)>/g)].map((m) => ({
    d: /\bd="([^"]*)"/.exec(m[1])[1],
    fill: (/\bfill="([^"]*)"/.exec(m[1]) || [])[1],
    opacity: (/fill-opacity="([^"]*)"/.exec(m[1]) || [])[1]
  }))
}

test('splashScene: pure and deterministic', async (t) => {
  const src = fs.readFileSync(SRC, 'utf8')
  for (const banned of ["from 'react", 'require(', 'node:', 'Math.random', 'Date']) {
    t.absent(src.includes(banned), 'no ' + banned)
  }
  t.absent(src.includes('\u2014'), 'no em dash')
  const m = await load()
  t.alike(m.nearTile(), m.nearTile())
  t.alike(m.spMapTile(), m.spMapTile())
  t.alike(m.nearTiles(), m.nearTiles())
  t.alike(m.farTile(), m.farTile())
  t.alike(m.varandaArt(), m.varandaArt())
  for (const art of [m.treeArt(), m.birdArt(), m.butterflyArt()]) {
    t.ok(Object.isFrozen(art.shapes[0]), art.viewBox + ' is frozen')
  }
  t.ok(Object.isFrozen(m.BIRDS[0]))
  t.ok(Object.isFrozen(m.SKY_STOPS[0]) && Object.isFrozen(m.SUN_STOPS[0]), 'gradient stops are frozen')
  t.ok(Object.isFrozen(m.nearTile().shapes[0]), 'tiles are frozen')
  t.ok(Object.isFrozen(m.CHAIR_PATHS[0]), 'chair paths are frozen')
  t.ok(Object.isFrozen(m.SCENE))
  const mesh = { w: 96, h: 96, cols: 12, rows: 12, seed: 7, jitter: 1 }
  t.is(m.jointMesh(mesh), m.jointMesh(mesh), 'same seed, same mesh')
  t.not(m.jointMesh(mesh), m.jointMesh({ ...mesh, seed: 8 }), 'the seed matters')
})

test('splashScene: path data is plain and stays in its box', async (t) => {
  const m = await load()
  for (const [name, tile] of Object.entries(tiles(m))) {
    const { w, h } = box(tile)
    for (const s of tile.shapes) {
      t.ok(/^[MLCQAZHV0-9 .,-]+$/i.test(s.d), name + ': path alphabet')
      t.absent(s.d.includes('NaN'), name + ': no NaN')
      const margin = (s.width || 0) / 2 + 1.5
      const pts = parse(s.d).flatMap((sp) => sp.points)
      const out = pts.filter(([x, y]) => x < -margin || x > w + margin || y < -margin || y > h + margin)
      t.alike(out, [], name + ': inside ' + w + 'x' + h)
      for (const [x, y] of pts) {
        if (Math.round(x * 10) !== x * 10 || Math.round(y * 10) !== y * 10) {
          t.fail(name + ': ' + x + ',' + y + ' has more than one decimal')
        }
      }
    }
  }
})

test('splashScene: araucária rosette', async (t) => {
  const m = await load()
  const near = m.nearTile()
  t.is(near.width, 96)
  t.is(near.height, 96)
  const [disc, spokes, wedges, joints] = near.shapes
  t.is(disc.fill, 'tinta')
  t.is(parse(disc.d).length, 1, 'one centre disc')
  t.is(spokes.stroke, 'tinta')
  t.is(spokes.cap, 'round')
  t.is(spokes.join, 'round')
  t.ok(spokes.width >= 3.5, 'thick arms')
  const arms = parse(spokes.d)
  t.is(arms.length, 9, 'nine spokes')
  t.is(parse(wedges.d).length, 9, 'nine wedges')
  t.is(joints.stroke, 'junta')

  const turns = arms.map(({ points }) => {
    const [a, b] = points
    const [c, d] = points.slice(-2)
    const u = [b[0] - a[0], b[1] - a[1]]
    const v = [d[0] - c[0], d[1] - c[1]]
    return (u[0] * v[1] - u[1] * v[0]) / (Math.hypot(...u) * Math.hypot(...v))
  })
  for (const s of turns) t.ok(Math.abs(s) > Math.sin(10 * Math.PI / 180), 'the arm bends (a hook, not a ray)')
  t.ok(turns.every((s) => s > 0) || turns.every((s) => s < 0), 'every hook turns the same way')

  // Each arm starts near the centre and ends near the rim.
  for (const { points } of arms) {
    const r = ([x, y]) => Math.hypot(x - 48, y - 48)
    t.ok(r(points[0]) < 10, 'arm starts by the centre')
    t.ok(r(points[points.length - 1]) > 34, 'arm reaches the rim')
  }
})

test('splashScene: only the joints cross the tile seam', async (t) => {
  const m = await load()
  for (const tile of [...m.nearTiles(), m.farTile()]) {
    const { w } = box(tile)
    for (const s of tile.shapes) {
      if (s.fill !== 'tinta' && s.stroke !== 'tinta') continue
      if (s.d === m.WAVE_PATH) continue
      const half = (s.width || 0) / 2
      for (const [x] of parse(s.d).flatMap((sp) => sp.points)) {
        t.ok(x - half >= 2 && x + half <= w - 2, 'ink clear of the seam at x = ' + x)
      }
    }
  }
})

// Every joint that runs out past the right edge picks up again at the left
// edge of the next tile, at the same height, so the tiled strip shows no seam.
test('splashScene: joint mesh is seamless in x', async (t) => {
  const m = await load()
  const meshes = [
    { w: 96, d: m.nearTile().shapes[3].d },
    { w: 96, d: m.spMapTile().shapes[1].d },
    { w: 96, d: m.jointMesh({ w: 96, h: 96, cols: 12, rows: 12, seed: 11, jitter: 1.8, stagger: true }) },
    { w: 320, d: m.farTile().shapes[1].d },
    { w: 50, d: m.jointMesh({ w: 50, h: 30, cols: 5, rows: 3, seed: 3, jitter: 1.5 }) }
  ]
  for (const { w, d } of meshes) {
    const segs = parse(d).flatMap(({ points }) => points.slice(1).map((p, i) => [points[i], p]))
    const ends = segs.flat().filter(([x]) => x > w - 3)
    t.ok(ends.length > 0, 'some joints reach the right edge')
    for (const [x, y] of ends) {
      const match = segs.flat().some(([qx, qy]) => Math.abs(qx - (x - w)) < 0.05 && Math.abs(qy - y) < 0.05)
      t.ok(match, 'joint end ' + x + ',' + y + ' continues at x = ' + (x - w))
    }
  }
})

test('splashScene: art copied from the site', async (t) => {
  const m = await load()
  const wave = svgPaths('mar-largo.svg').find((p) => p.d.startsWith('M0 34C40 34 56 6 80 6'))
  t.ok(wave, 'mar-largo.svg has the wave band')
  t.is(m.WAVE_PATH, wave.d)
  t.is(m.farTile().shapes[0].d, m.WAVE_PATH)
  t.is(m.farTile().shapes[0].fill, 'tinta')
  t.is(m.farTile().viewBox, '0 0 320 120')
  t.is(m.farTile().width, 128)
  t.is(m.farTile().height, 48)

  const chair = svgPaths('cadeira.svg')
  t.is(chair.length, 21)
  t.is(m.CHAIR_VIEWBOX, '0 0 256 256')
  t.alike(m.CHAIR_PATHS.map((p) => ({ d: p.d, fill: p.fill })), chair.map((p) => ({ d: p.d, fill: p.fill })))
  t.alike(m.CHAIR_PATHS.map((p) => p.fillOpacity), chair.map((p) => p.opacity === undefined ? undefined : Number(p.opacity)))
})

test('splashScene: palettes', async (t) => {
  const m = await load()
  const light = m.scenePalette('light')
  const dark = m.scenePalette('dark')
  t.alike(Object.keys(dark).sort(), Object.keys(light).sort())
  for (const key of ['pedra', 'tinta', 'junta', 'parede', 'telha', 'beiral', 'madeira', 'planta', 'meioFio', 'asfalto', 'ceuTopo', 'ceuOuro', 'ceuLaranja', 'ceuCoral', 'ceuAmeixa', 'ceuNoite', 'solNucleo', 'solMeio', 'sol', 'tronco', 'copa']) {
    t.ok(/^#[0-9a-f]{6}$/.test(light[key]) && /^#[0-9a-f]{6}$/.test(dark[key]), key + ' in both')
  }
  t.is(light.parede, '#f3ede2')
  t.is(dark.parede, '#f3ede2', 'the wall behind the chair stays lit')
  t.is(light.pedra, '#f3ede2')
  t.is(light.tinta, '#1f2a24')
  t.is(light.telha, '#e8805a')
  const lum = (hex) => [1, 3, 5].reduce((s, i) => s + parseInt(hex.slice(i, i + 2), 16), 0)
  t.is(light.sol, '#f2b705', 'the stripe yellow')
  t.absent('asa' in light, 'the blue wing is gone')
  t.absent(['ceu', 'ceuMeio', 'ceuClaro'].some((key) => key in light), 'the flat blue steps are gone')
  // The landing's sunset (apps/site/public/styles.css .heroi) by day.
  t.alike(m.SKY_STOPS.map((s) => light[s.key]), ['#fbf8f3', '#f7b267', '#f09a5f', '#e8805a', '#8a4e7a', '#2b2a4a'])
  t.alike(m.SUN_STOPS.map((s) => light[s.key]), ['#ffe2a8', '#ffc77c', '#f7b267', '#f7b267'])
  // At night the band leaves the dark page and darkens no further than a night blue.
  const night = m.SKY_STOPS.map((s) => dark[s.key])
  t.is(night[0], '#101010', 'the night starts at the dark page')
  t.is(night[night.length - 1], '#1c2b3b', 'and ends at the night blue')
  for (let i = 1; i < night.length; i++) t.ok(lum(night[i]) > lum(night[i - 1]), 'the night lightens toward the floor at stop ' + i)
  for (const key of Object.keys(light)) {
    if (key !== 'parede' && key !== 'letra') t.ok(lum(dark[key]) < lum(light[key]), key + ' dims in dark')
  }
  for (const [name, tile] of Object.entries(tiles(m))) {
    for (const s of tile.shapes) {
      for (const k of [s.fill, s.stroke]) if (k !== undefined) t.ok(k in light, name + ': ' + k + ' is a palette key')
    }
  }
})

test('splashScene: scene sizes and scale', async (t) => {
  const m = await load()
  const S = m.SCENE
  t.is(S.rua + S.kerb + S.near + S.far + S.floor + S.wall + S.roof + S.sky, m.SCENE_HEIGHT)
  t.is(m.SCENE_HEIGHT, 440)
  t.is(m.varandaArt().width, S.varandaWidth)
  t.is(m.varandaArt().height, S.roof + S.wall + S.floor)
  for (const { k } of m.SCALE_STEPS) {
    t.ok(Number.isInteger(96 * k), 'near tile whole at k ' + k)
    t.ok(Number.isInteger(128 * k), 'far tile whole at k ' + k)
  }
  for (let h = 320; h <= 1000; h++) {
    if (m.SCENE_HEIGHT * m.sceneScale(h) + 110 > h) t.fail('scene leaves no room at height ' + h)
  }
  t.is(m.sceneScale(700), 1)
  t.is(m.sceneScale(600), 1)
  t.is(m.sceneScale(599), 0.75)
  t.is(m.sceneScale(440), 0.75)
  t.is(m.sceneScale(439), 0.5)
  t.is(m.sceneScale(330), 0.5)
  t.is(m.sceneScale(329), 0.375)
  const at1 = m.sceneLayout({ width: 390, height: 844 })
  t.is(at1.k, 1)
  t.is(at1.height, 440)
  t.is(at1.nearCount, 7)
  t.is(at1.farCount, 5)
  t.alike(at1.varanda, { x: 79, y: 80, w: 232, h: 174 })
  const at75 = m.sceneLayout({ width: 390, height: 500 })
  t.is(at75.k, 0.75)
  t.is(at75.height, 330)
  t.is(at75.nearCount, 8)
  t.is(at75.farCount, 6)
})

test('splashScene: tiles stay lean for the static overlay', async (t) => {
  const m = await load()
  const size = JSON.stringify(m.nearTiles()).length + JSON.stringify(m.farTile()).length
  t.ok(size <= 13000, 'near sequence + far tiles are ' + size + ' characters')
})

test('splashScene: São Paulo state map', async (t) => {
  const m = await load()
  const sp = m.spMapTile()
  t.is(sp.width, 96)
  t.is(sp.height, 96)
  t.is(sp.viewBox, '0 0 96 96')
  t.is(sp.shapes.length, 2)
  const [map, joints] = sp.shapes
  t.is(map.fill, 'tinta')
  t.is(map.stroke, undefined, 'filled, not stroked')
  t.ok(map.d.trim().endsWith('Z'), 'closed')
  const subs = parse(map.d)
  t.is(subs.length, 1, 'one path')
  const pts = subs[0].points
  t.ok(pts.length >= 20, 'enough vertices to read as the state')
  t.ok(pts.every(([x, y]) => x >= 2 && x <= 94 && y >= 2 && y <= 94), 'all points inside 2..94')
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const wide = Math.max(...xs) - Math.min(...xs)
  const tall = Math.max(...ys) - Math.min(...ys)
  t.ok(wide > tall, 'wider than tall')
  t.ok(wide >= 76 && wide <= 82, 'about 80 units wide, got ' + wide)
  t.ok(Math.abs((Math.max(...xs) + Math.min(...xs)) / 2 - 48) <= 1, 'centred in x')
  t.ok(Math.abs((Math.max(...ys) + Math.min(...ys)) / 2 - 48) <= 1, 'centred in y')
  const west = pts.reduce((a, b) => (b[0] < a[0] ? b : a))
  t.alike(west, pts[0], 'the leftmost point is the western tip, where the outline starts')
  const others = pts.filter((p) => p !== west).map((p) => p[0])
  t.ok(Math.min(...others) - west[0] >= 3, 'the western tip is pointed')
  // The south-east coast runs down to the south-west: the lowest point lies
  // west of the eastern tip.
  const east = pts.reduce((a, b) => (b[0] > a[0] ? b : a))
  const south = pts.reduce((a, b) => (b[1] > a[1] ? b : a))
  t.ok(south[0] < east[0] && south[1] > east[1], 'diagonal coast from the east tip down to the south')
  t.is(joints.stroke, 'junta')
  t.is(joints.width, m.nearTile().shapes[3].width)
  t.is(joints.d, m.nearTile().shapes[3].d, 'the araucaria joint mesh, so the joints run on across the seam')
  const src = fs.readFileSync(SRC, 'utf8')
  t.ok(src.includes('Mirthes Bernardes'), 'credits the designer')
})

test('splashScene: near sequence', async (t) => {
  const m = await load()
  t.alike([...m.NEAR_SEQUENCE], ['araucaria', 'saoPaulo'])
  t.ok(Object.isFrozen(m.NEAR_SEQUENCE))
  const seq = m.nearTiles()
  t.ok(Object.isFrozen(seq))
  t.is(seq.length, m.NEAR_SEQUENCE.length)
  t.is(seq[0], m.nearTile(), 'the araucária first')
  t.is(seq[1], m.spMapTile(), 'then São Paulo')
  for (const tile of seq) {
    t.is(tile.width, 96)
    t.is(tile.height, 96)
    t.is(tile.viewBox, seq[0].viewBox)
    t.ok(Object.isFrozen(tile.shapes[0]))
    for (const s of tile.shapes) {
      if (s.fill === undefined) t.ok(s.stroke !== undefined, 'a fill-less shape is stroked')
      else t.is(s.stroke, undefined, 'a filled shape has no stroke')
    }
  }
})

// Hand-set stones: the short joints of alternate rows sit half a stone apart,
// and no two in a row share one x, so the mesh never reads as a grid.
test('splashScene: near tiles share one joint mesh across motif seams', async (t) => {
  const m = await load()
  // Each mesh is seamless with itself; only a shared mesh makes the joints run
  // on where one motif meets the next.
  const joints = m.nearTiles().map((tile) => tile.shapes[tile.shapes.length - 1])
  t.ok(joints.length > 1, 'more than one motif')
  for (const j of joints) t.alike(j, joints[0])
})

test('splashScene: near joints look hand-set', async (t) => {
  const m = await load()
  for (const tile of m.nearTiles()) {
    const joints = tile.shapes[tile.shapes.length - 1]
    const segs = parse(joints.d).filter(({ points }) => points.length === 2)
    t.is(segs.length, 12 * 12, 'one short joint per stone')
    const mid = segs.map(({ points: [a, b] }) => ({ x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, lean: b[0] - a[0] }))
    const row = (r) => mid.filter((s) => Math.floor(s.y / 8) === r).map((s) => s.x).sort((a, b) => a - b)
    // Mean distance of a row's joints from the nearest multiple of 8.
    const offGrid = (xs) => xs.reduce((s, x) => s + Math.abs((((x + 4) % 8) + 8) % 8 - 4), 0) / xs.length
    for (let r = 0; r < 12; r += 2) {
      t.ok(offGrid(row(r)) < 1.6 && offGrid(row(r + 1)) > 2.4, 'rows ' + r + ' and ' + (r + 1) + ' are staggered')
    }
    t.ok(mid.filter((s) => Math.abs(s.lean) >= 0.5).length > segs.length / 3, 'joints lean')
    for (const { points: [a, b] } of segs) {
      t.ok(a[0] >= 0.5 && b[0] >= 0.5 && a[0] <= 92.9 && b[0] <= 92.9, 'short joint inside the tile')
    }
  }
})

test('splashScene: strip loops match the slide speed', async (t) => {
  const m = await load()
  const { SLIDES } = await import('../src/ui/splashMotion.js')
  t.is(SLIDES.near.tile, m.nearTile().width, 'SLIDES near tile is the near tile width')
  t.is(SLIDES.far.tile, m.farTile().width, 'SLIDES far tile is the far tile width')
  const n = m.NEAR_SEQUENCE.length
  for (const { k } of m.SCALE_STEPS) {
    const loops = m.stripLoops(k)
    t.alike(loops, {
      near: { distance: SLIDES.near.tile * n * k, ms: SLIDES.near.ms * n },
      far: { distance: SLIDES.far.tile * k, ms: SLIDES.far.ms }
    })
    t.ok(Number.isInteger(loops.near.distance) && Number.isInteger(loops.far.distance), 'whole pixels at k ' + k)
    t.is(loops.near.ms / (loops.near.distance / k), SLIDES.near.ms / SLIDES.near.tile, 'same near speed per tile')
    t.is(loops.far.ms / (loops.far.distance / k), SLIDES.far.ms / SLIDES.far.tile, 'same far speed per tile')
  }
  t.ok(Object.isFrozen(m.stripLoops(1)))
})

function chairBox (paths) {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  for (const p of paths) {
    for (const { points } of parse(p.d)) {
      for (const [x, y] of points) {
        b.minX = Math.min(b.minX, x)
        b.minY = Math.min(b.minY, y)
        b.maxX = Math.max(b.maxX, x)
        b.maxY = Math.max(b.maxY, y)
      }
    }
  }
  return b
}

test('splashScene: chair bbox constant', async (t) => {
  const m = await load()
  t.alike({ ...m.CHAIR_BBOX }, chairBox(m.CHAIR_PATHS))
  t.ok(Object.isFrozen(m.CHAIR_BBOX))
})

test('splashScene: scene layout boxes', async (t) => {
  const m = await load()
  const S = m.SCENE
  const VB_H = S.roof + S.wall + S.floor
  const heights = [320, 329, 330, 380, 439, 440, 520, 599, 600, 844]
  t.alike([...new Set(heights.map(m.sceneScale))].sort(), m.SCALE_STEPS.map((s) => s.k).sort(), 'every scale step')
  for (const width of [320, 360, 390, 430, 768, 1280]) {
    for (const height of heights) {
      const L = m.sceneLayout({ width, height })
      const tag = width + 'x' + height
      const k = L.k
      const nums = [
        L.height, L.varanda.x, L.varanda.y, L.varanda.w, L.varanda.h, L.chair.x, L.chair.y, L.chair.size,
        L.sky.y, L.sky.height, L.sun.x, L.sun.y, L.sun.size,
        L.tree.x, L.tree.y, L.tree.w, L.tree.h, L.butterfly.x, L.butterfly.y, L.butterfly.w, L.butterfly.h,
        ...L.birds.flatMap((b) => [b.y, b.w, b.h]),
        ...['far', 'near', 'kerb', 'rua'].flatMap((r) => [L[r].y, L[r].height])
      ]
      if (!nums.every(Number.isInteger)) t.fail(tag + ': whole pixels ' + nums.join(','))
      t.is(L.height, m.SCENE_HEIGHT * k, tag + ': block height')
      // Rows stack top to bottom with no gap and fill the block.
      t.is(L.varanda.y, Math.round(S.sky * k), tag + ': open sky above the roof')
      t.is(L.far.y, L.varanda.y + L.varanda.h, tag + ': far under the varanda')
      t.is(L.near.y, L.far.y + L.far.height, tag + ': near under far')
      t.is(L.kerb.y, L.near.y + L.near.height, tag + ': kerb under near')
      t.is(L.rua.y, L.kerb.y + L.kerb.height, tag + ': rua under kerb')
      t.is(L.rua.y + L.rua.height, L.height, tag + ': rua ends the block')
      t.is(L.far.height, S.far * k, tag + ': far strip is one tile tall')
      t.is(L.near.height, S.near * k, tag + ': near strip is one tile tall')
      t.ok(L.kerb.height >= 1, tag + ': kerb shows')
      t.ok(Math.abs(L.varanda.x + L.varanda.w / 2 - width / 2) <= 0.5, tag + ': varanda centred')
      t.ok(Math.abs(L.varanda.w / L.varanda.h - S.varandaWidth / VB_H) < 0.01, tag + ': varanda keeps its shape')

      // The varanda art as a renderer fits it (meet, centred), then the
      // chair's visible drawing inside its own box.
      const s = Math.min(L.varanda.w / S.varandaWidth, L.varanda.h / VB_H)
      const vx = L.varanda.x + (L.varanda.w - S.varandaWidth * s) / 2
      const vy = L.varanda.y + (L.varanda.h - VB_H * s) / 2
      const u = L.chair.size / 256
      const B = m.CHAIR_BBOX
      const art = { x0: L.chair.x + u * B.minX, x1: L.chair.x + u * B.maxX, y0: L.chair.y + u * B.minY, y1: L.chair.y + u * B.maxY }
      t.ok(Math.abs((art.x0 + art.x1) / 2 - (vx + s * S.varandaWidth / 2)) <= 1, tag + ': chair centred on the varanda')
      const floorTop = vy + s * (S.roof + S.wall)
      t.ok(art.y1 >= floorTop && art.y1 <= floorTop + s * S.floor, tag + ': feet on the floor')
      const ratio = (art.x1 - art.x0) / (s * (208 - 24))
      t.ok(ratio >= 0.38 && ratio <= 0.42, tag + ': chair width ratio ' + ratio.toFixed(3))
      t.ok(art.x0 >= vx + s * 24 && art.x1 <= vx + s * 186, tag + ': chair inside the posts, clear of the plant')
      t.ok(art.y0 >= vy + s * S.roof, tag + ': chair under the roof')

      const loops = m.stripLoops(k)
      t.ok(L.nearCount * S.near * k >= width + loops.near.distance, tag + ': near strip covers a full loop')
      t.ok(L.farCount * 128 * k >= width + loops.far.distance, tag + ': far strip covers a full loop')
      t.is(L.nearCount, Math.ceil(width / (96 * k)) + m.NEAR_SEQUENCE.length, tag + ': near count')
    }
  }
})

test('splashScene: lettering is the lockup word', async (t) => {
  const m = await load()
  const L = m.LETTERING
  t.ok(Object.isFrozen(L) && Object.isFrozen(L.letters[0]), 'frozen')
  t.is(L.letters.map((l) => l.char).join(''), 'VARANDA')
  const svg = fs.readFileSync(path.join(ASSETS, 'logo-lockup.svg'), 'utf8')
  const group = /<g transform="translate\(202\.891 99\.791\) scale\(1\.1\)"[^>]*>([\s\S]*?)<\/g>/.exec(svg)
  t.ok(group, 'the lockup still has its lettering group')
  const paths = [...group[1].matchAll(/<path\b[^>]*\bd="([^"]*)"/g)]
  t.is(paths.length, 1, 'one lettering path')
  t.is(L.letters.map((l) => l.d).join(''), paths[0][1], 'verbatim, in order')
  t.alike(L.letters.map((l) => parse(l.d).length), [1, 2, 3, 2, 1, 2, 2], 'subpaths per letter')
  const [minX, minY, w, h] = L.viewBox.split(' ').map(Number)
  let prev = -Infinity
  for (const l of L.letters) {
    t.ok(/^[MQZ0-9 .-]+$/.test(l.d), l.char + ': only M, Q and Z')
    const pts = parse(l.d).flatMap((s) => s.points)
    const lx = Math.min(...pts.map((p) => p[0]))
    t.ok(lx > prev, l.char + ' starts right of the letter before')
    prev = lx
    for (const [x, y] of pts) {
      if (x < minX || x > minX + w || y < minY || y > minY + h) t.fail(l.char + ': ' + x + ',' + y + ' outside the viewBox')
    }
  }
  t.is(m.SCENE.letteringHeight, 34)
})

test('splashScene: lettering ink follows the lockups', async (t) => {
  const m = await load()
  t.is(m.scenePalette('light').letra, '#1f2a24', 'lockup ink, as the chair frame')
  t.is(m.scenePalette('dark').letra, '#fbf8f3', 'cream, as lockup-dark.svg')
})

// Where the sky band, the sun, the birds, the tree and the butterfly sit,
// at every scale step and from a narrow phone to a desktop.
test('splashScene: sky, tree and flyers', async (t) => {
  const m = await load()
  const { FLYERS } = await import('../src/ui/splashMotion.js')
  const S = m.SCENE
  t.is(m.BIRDS.length, FLYERS.birds.length, 'one timing per bird')
  for (const width of [320, 360, 390, 430, 768, 1280]) {
    for (const height of [320, 380, 440, 500, 600, 844]) {
      const L = m.sceneLayout({ width, height })
      const tag = width + 'x' + height
      const k = L.k
      const V = L.varanda

      t.alike({ ...L.sky }, { y: 0, height: L.far.y }, tag + ': the band runs from the block top to the street')

      t.is(L.tree.y + L.tree.h, L.far.y, tag + ': the tree stands on the floor line')
      t.ok(L.tree.x + L.tree.w / 2 < V.x + V.w / 2, tag + ': the tree is left of the varanda centre')
      t.ok(L.tree.x + L.tree.w / 2 < V.x + 14 * k + 10 * k, tag + ': the trunk is no further right than the left post')
      t.ok(Math.abs(L.tree.h / V.h - 1.2) < 0.03, tag + ': the tree is about 1.2 varandas tall')
      t.ok(L.tree.y >= 0, tag + ': the crown stays inside the block')

      // The setting sun rises behind the roof, as on the landing: centred on
      // the varanda, its centre just under the roof's top edge.
      const sun = { x: L.sun.x, y: L.sun.y, w: L.sun.size, h: L.sun.size }
      const cx = sun.x + sun.w / 2
      const cy = sun.y + sun.h / 2
      t.ok(Math.abs(cx - (V.x + V.w / 2)) <= 1, tag + ': the sun is centred on the varanda')
      t.ok(cy > V.y && cy < V.y + S.roof * k, tag + ': its centre is at the roof line')
      t.ok(sun.y >= L.sky.y && sun.y + sun.h <= L.sky.y + L.sky.height, tag + ': the glow box is inside the band')
      t.ok(sun.x >= 0 && sun.x + sun.w <= width, tag + ': and on screen')

      L.birds.forEach((b, i) => {
        const bob = FLYERS.birds[i].bob * k
        t.ok(b.w >= 14 * k - 0.5 && b.w <= 20 * k + 0.5, tag + ': bird ' + i + ' is small')
        t.ok(b.y - bob >= 0 && b.y + b.h + bob <= V.y, tag + ': bird ' + i + ' flies in the band above the roof')
      })

      const s = V.w / S.varandaWidth
      const bf = L.butterfly
      t.ok(bf.x >= V.x + 218 * s - 0.5, tag + ': the butterfly rests outside the right post')
      t.ok(bf.x - FLYERS.butterfly.dx * k <= V.x + 218 * s + 4 * k, tag + ': and drifts by the plant')
      t.ok(bf.y >= V.y + S.roof * s && bf.y + bf.h <= L.far.y, tag + ': at the height of the plant')
    }
  }
})

// The word and the bar sit centred in the space above the scene block (Splash
// gives the scene its height as a bottom margin), so they can never cover it.
test('splashScene: the word and the bar never overlap the scene', async (t) => {
  const m = await load()
  const word = m.SCENE.letteringHeight + 8 + 8 + 4
  for (const height of [844, 700, 600, 500, 440, 380]) {
    const L = m.sceneLayout({ width: 390, height })
    const free = height - L.height
    t.ok(free >= 110, height + ': ' + free + ' px above the scene')
    const bottom = (free + word) / 2
    t.ok(bottom + 24 <= free, height + ': the bar ends at least 24 px above the sky')
    for (const art of [L.tree, L.varanda, { y: L.sun.y }, ...L.birds]) t.ok(art.y >= 0, height + ': no art above the block top')
    t.ok(L.sun.y + L.sun.size <= L.far.y, height + ': the glow stays in the band')
  }
})

test('splashScene: an araucária, not a generic tree', async (t) => {
  const m = await load()
  const tree = m.treeArt()
  const [trunk, crown] = tree.shapes
  t.is(trunk.fill, 'tronco')
  t.is(crown.fill, 'copa')
  const tiers = parse(crown.d)
  t.is(tiers.length, 4, 'four tiers of branches')
  const span = (sp) => {
    const xs = sp.points.map((p) => p[0])
    return Math.max(...xs) - Math.min(...xs)
  }
  const top = (sp) => Math.min(...sp.points.map((p) => p[1]))
  for (let i = 1; i < tiers.length; i++) {
    t.ok(span(tiers[i]) < span(tiers[i - 1]), 'tier ' + i + ' is narrower than the one above')
    t.ok(top(tiers[i]) > top(tiers[i - 1]), 'tier ' + i + ' sits lower')
  }
  t.ok(/H/.test(crown.d.split('M')[1]), 'the top tier is closed by a flat edge')
  const trunkTop = Math.min(...parse(trunk.d)[0].points.map((p) => p[1]))
  t.ok(trunkTop < top(tiers[tiers.length - 1]) + 20, 'the trunk runs up into the crown')
  t.ok(Math.max(...parse(trunk.d)[0].points.map((p) => p[1])) === tree.height, 'the trunk reaches the ground')
})

test('splashScene: sun, birds and butterfly', async (t) => {
  const m = await load()
  t.absent('sunArt' in m, 'no rayed sun')
  const bird = m.birdArt().shapes
  t.is(bird.length, 1)
  t.is(bird[0].fill, undefined, 'stroke only')
  t.is(bird[0].stroke, 'tinta')
  const b = m.butterflyArt()
  t.alike(b.shapes.map((s) => s.fill || s.stroke), ['sol', 'telha', 'tinta', 'tinta'], 'two wing pairs and an ink body')
  // The body is on the centre line, so a scaleX flap folds the wings onto it.
  for (const { points } of parse(b.shapes[2].d)) for (const [x] of points) t.is(x, b.width / 2)
})

// Both renderers draw the band and the glow from these stops, so their shape
// is pinned here.
test('splashScene: sunset and sun stops', async (t) => {
  const m = await load()
  for (const [name, stops] of [['sky', m.SKY_STOPS], ['sun', m.SUN_STOPS]]) {
    t.is(stops[0].offset, 0, name + ' starts at 0')
    t.is(stops[stops.length - 1].offset, 1, name + ' ends at 1')
    for (let i = 1; i < stops.length; i++) t.ok(stops[i].offset > stops[i - 1].offset, name + ' offsets rise at ' + i)
  }
  t.is(m.SKY_STOPS[0].key, 'ceuTopo', 'the band starts at the page cream')
  t.is(m.scenePalette('light').ceuTopo, '#fbf8f3')
  t.is(m.scenePalette('light')[m.SKY_STOPS[m.SKY_STOPS.length - 1].key], '#2b2a4a', 'and ends at dusk navy on the floor line')
  t.alike(m.SUN_STOPS.map((s) => s.opacity), [1, 1, 0.55, 0], 'the glow fades out at its edge')
})

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))

function luminance (c) {
  const lin = (v) => {
    v /= 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])
}

function contrast (a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

// The band's colour at t (0 top, 1 floor line), mixed in sRGB as a gradient is.
function skyAt (m, palette, t) {
  const stops = m.SKY_STOPS
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i].offset) {
      const f = (t - stops[i - 1].offset) / (stops[i].offset - stops[i - 1].offset)
      const a = rgb(palette[stops[i - 1].key])
      const b = rgb(palette[stops[i].key])
      return a.map((v, j) => v + (b[j] - v) * f)
    }
  }
  return rgb(palette[stops[stops.length - 1].key])
}

// The butterfly flies over the plum and navy now: each wing pair keeps 3:1
// against the sky behind it, wherever its drift takes it.
test('splashScene: the butterfly reads on the sunset', async (t) => {
  const m = await load()
  const { FLYERS } = await import('../src/ui/splashMotion.js')
  const light = m.scenePalette('light')
  const art = m.butterflyArt()
  const wings = art.shapes.slice(0, 2).map((s) => {
    const ys = parse(s.d).flatMap((sp) => sp.points.map((p) => p[1]))
    return { fill: s.fill, y0: Math.min(...ys), y1: Math.max(...ys) }
  })
  for (const height of [380, 440, 500, 600, 844]) {
    const L = m.sceneLayout({ width: 390, height })
    const bf = L.butterfly
    const u = bf.h / art.height
    const dy = FLYERS.butterfly.dy * L.k
    for (const w of wings) {
      let min = Infinity
      for (const y of [bf.y + w.y0 * u - dy, bf.y + w.y1 * u - dy, bf.y + w.y0 * u + dy, bf.y + w.y1 * u + dy]) {
        min = Math.min(min, contrast(rgb(light[w.fill]), skyAt(m, light, (y - L.sky.y) / L.sky.height)))
      }
      t.ok(min >= 3, height + ': ' + w.fill + ' wings at ' + min.toFixed(2) + ':1')
    }
  }
})
