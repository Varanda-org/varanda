'use strict'

// apps/cli/lib/account/ai/exemplar-store.js: the human precedents of the AI
// report triage on disk. No network, injected clock.

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const test = require('brittle')
const { openExemplarStore, FILE, MAX_EXEMPLARS, DIM } = require('../lib/account/ai/exemplar-store')
const { tmpDir } = require('./helpers/net')

const T0 = Date.parse('2026-10-24T12:00:00.000Z')
const MODEL = 'Xenova/all-MiniLM-L6-v2@q8'

function clock (start = T0) {
  const c = { t: start, now: () => c.t }
  return c
}

function hex () {
  return crypto.randomBytes(32).toString('hex')
}

function rid () {
  return crypto.randomBytes(16).toString('base64url')
}

function vec (fill = 1) {
  return new Array(DIM).fill(fill)
}

function fields (extra = {}) {
  return {
    reportId: rid(),
    target: hex(),
    seq: 3,
    reason: 'spam',
    decision: 'bloquear',
    contentHash: hex(),
    text: 'compre já\nlink na bio',
    hasMedia: false,
    embedding: vec(),
    ...extra
  }
}

function setup (t, model = MODEL) {
  const dir = path.join(tmpDir(t), 'account')
  const c = clock()
  const open = (m = model) => openExemplarStore(dir, { now: c.now, model: m })
  return { dir, c, store: open(), open }
}

function throwsCode (t, fn, code, msg) {
  try {
    fn()
    t.fail(msg + ': returned')
  } catch (err) {
    t.is(err.code, code, msg)
  }
}

function filePath (dir) {
  return path.join(dir, FILE)
}

function onDisk (dir) {
  return JSON.parse(fs.readFileSync(filePath(dir), 'utf8'))
}

test('a missing file is created empty with the model; add, list, size', (t) => {
  const { dir, c, store } = setup(t)
  t.alike(onDisk(dir), { v: 1, model: MODEL, items: [] })
  t.is(fs.statSync(filePath(dir)).mode & 0o777, 0o600, 'file mode 0o600')
  const f = fields()
  const { exemplar, duplicate } = store.add(f)
  t.is(duplicate, false)
  t.ok(/^[A-Za-z0-9_-]{22}$/.test(exemplar.id), 'base64url id')
  t.is(exemplar.at, new Date(c.t).toISOString())
  t.is(exemplar.reportId, f.reportId)
  t.is(store.size(), 1)
  store.add(fields({ reason: 'outro', decision: 'descartar' }))
  t.is(store.list().length, 2)
  t.is(store.list({ reason: 'outro' }).length, 1)
  const copy = store.list()[0]
  copy.embedding[0] = 99
  t.is(store.list()[0].embedding[0], 1, 'list returns deep copies')
  t.is(onDisk(dir).items.length, 2)
  t.alike(Object.keys(onDisk(dir).items[0]), ['id', 'at', 'reportId', 'target', 'seq', 'reason', 'decision', 'contentHash', 'text', 'hasMedia', 'embedding'])
  throwsCode(t, () => store.list({ reason: 'ilegal' }), 'pedido-invalido', 'unknown reason filter')
})

test('a duplicate reportId returns the existing row without a write', (t) => {
  const { dir, store } = setup(t)
  const f = fields()
  const first = store.add(f).exemplar
  const before = fs.readFileSync(filePath(dir))
  const again = store.add({ ...f, decision: 'descartar' })
  t.is(again.duplicate, true)
  t.alike(again.exemplar, first)
  t.alike(fs.readFileSync(filePath(dir)), before, 'file unchanged')
  t.is(store.size(), 1)
})

test('ilegal, a 385-long embedding and other bad fields are refused', (t) => {
  const { dir, store } = setup(t)
  throwsCode(t, () => store.add(fields({ reason: 'ilegal' })), 'pedido-invalido', 'ilegal never copied')
  throwsCode(t, () => store.add(fields({ embedding: new Array(DIM + 1).fill(0) })), 'pedido-invalido', '385 numbers')
  throwsCode(t, () => store.add(fields({ embedding: vec(128) })), 'pedido-invalido', 'out of int8 range')
  throwsCode(t, () => store.add(fields({ embedding: vec(0.5) })), 'pedido-invalido', 'not integers')
  throwsCode(t, () => store.add(fields({ decision: 'aberta' })), 'pedido-invalido', 'bad decision')
  throwsCode(t, () => store.add(fields({ seq: 0 })), 'pedido-invalido', 'seq 0')
  throwsCode(t, () => store.add(fields({ seq: 100000 })), 'pedido-invalido', 'seq at MAX_LOG_BLOCKS')
  throwsCode(t, () => store.add(fields({ target: 'AB'.repeat(32) })), 'pedido-invalido', 'upper hex target')
  throwsCode(t, () => store.add(fields({ text: 'a\u0000b' })), 'pedido-invalido', 'unclean text')
  throwsCode(t, () => store.add(fields({ text: '\ud800' })), 'pedido-invalido', 'lone surrogate')
  throwsCode(t, () => store.add(fields({ text: 'x'.repeat(1001) })), 'pedido-invalido', 'over MAX_TEXT')
  throwsCode(t, () => store.add(fields({ extra: 1 })), 'pedido-invalido', 'unknown key')
  const f = fields()
  delete f.hasMedia
  throwsCode(t, () => store.add(f), 'pedido-invalido', 'missing key')
  t.ok(store.add(fields({ embedding: Int8Array.from(vec(-127)), text: '' })).exemplar, 'Int8Array and empty text accepted')
  t.is(onDisk(dir).items.length, 1)
})

test('an exemplars.json with one extra key is indisponivel and byte-identical', (t) => {
  const { dir, store, open } = setup(t)
  store.add(fields())
  const obj = onDisk(dir)
  obj.items[0].note = 'x'
  fs.writeFileSync(filePath(dir), JSON.stringify(obj))
  const before = fs.readFileSync(filePath(dir))
  const s = open()
  throwsCode(t, () => s.add(fields()), 'indisponivel', 'add')
  throwsCode(t, () => s.list(), 'indisponivel', 'list')
  throwsCode(t, () => s.size(), 'indisponivel', 'size')
  throwsCode(t, () => s.remove(obj.items[0].reportId), 'indisponivel', 'remove')
  throwsCode(t, () => s.removeTarget(obj.items[0].target), 'indisponivel', 'removeTarget')
  t.alike(fs.readFileSync(filePath(dir)), before, 'never rewritten')

  const top = { v: 1, model: MODEL, items: [], extra: true }
  fs.writeFileSync(filePath(dir), JSON.stringify(top))
  const before2 = fs.readFileSync(filePath(dir))
  throwsCode(t, () => open().add(fields()), 'indisponivel', 'extra top-level key')
  t.alike(fs.readFileSync(filePath(dir)), before2, 'never rewritten')
})

test('a symlinked data dir is refused', (t) => {
  const root = tmpDir(t)
  const real = path.join(root, 'real')
  fs.mkdirSync(real)
  const link = path.join(root, 'link')
  fs.symlinkSync(real, link)
  t.exception(() => openExemplarStore(link, { model: MODEL }))
  t.absent(fs.existsSync(path.join(real, FILE)), 'nothing written through the link')
})

test('the model is required and a different model is refused without a rewrite', (t) => {
  const { dir, store, open } = setup(t)
  t.exception.all(() => open(''), /model/)
  t.exception.all(() => open('m'.repeat(201)), /model/)
  t.exception.all(() => openExemplarStore(dir, {}), /model/)
  const f = fields()
  store.add(f)
  const before = fs.readFileSync(filePath(dir))
  const other = open('other-model')
  throwsCode(t, () => other.add(fields()), 'modelo', 'add')
  throwsCode(t, () => other.list(), 'modelo', 'list')
  throwsCode(t, () => other.remove(f.reportId), 'modelo', 'remove')
  throwsCode(t, () => other.removeTarget(f.target), 'modelo', 'removeTarget')
  t.is(other.size(), 1, 'size still counts')
  t.alike(fs.readFileSync(filePath(dir)), before, 'never rewritten')
})

test('an add over the cap drops the oldest by (at, id) in the same write', (t) => {
  const { dir, c, open } = setup(t)
  const items = []
  for (let i = 0; i < MAX_EXEMPLARS; i++) {
    items.push({
      id: rid(),
      at: new Date(T0 + (i === 5 ? -1000 : i) * 1000).toISOString(),
      reportId: rid(),
      target: hex(),
      seq: 1,
      reason: 'spam',
      decision: 'descartar',
      contentHash: hex(),
      text: '',
      hasMedia: false,
      embedding: vec(0)
    })
  }
  fs.writeFileSync(filePath(dir), JSON.stringify({ v: 1, model: MODEL, items }))
  const s = open()
  t.is(s.size(), MAX_EXEMPLARS)
  c.t = T0 + MAX_EXEMPLARS * 1000
  const { exemplar } = s.add(fields())
  t.is(s.size(), MAX_EXEMPLARS)
  const ids = new Set(onDisk(dir).items.map((r) => r.id))
  t.absent(ids.has(items[5].id), 'the oldest (by at) dropped')
  t.ok(ids.has(items[0].id), 'the next oldest kept')
  t.ok(ids.has(exemplar.id), 'the new row kept')
})

test('at the cap, a new row that sorts oldest is kept and the oldest other row goes', (t) => {
  const { dir, c, open } = setup(t)
  const items = []
  for (let i = 0; i < MAX_EXEMPLARS; i++) {
    items.push({
      id: rid(),
      at: new Date(T0 + 1000 + i).toISOString(),
      reportId: rid(),
      target: hex(),
      seq: 1,
      reason: 'spam',
      decision: 'descartar',
      contentHash: hex(),
      text: '',
      hasMedia: false,
      embedding: vec(0)
    })
  }
  fs.writeFileSync(filePath(dir), JSON.stringify({ v: 1, model: MODEL, items }))
  const s = open()
  c.t = T0 // before every stored row: the clock stepped back
  const { exemplar, duplicate } = s.add(fields())
  t.is(duplicate, false)
  const ids = new Set(onDisk(dir).items.map((r) => r.id))
  t.ok(ids.has(exemplar.id), 'the new row is on disk')
  t.absent(ids.has(items[0].id), 'the oldest other row dropped')
  t.is(s.size(), MAX_EXEMPLARS)
})

test('remove and removeTarget with and without decision', (t) => {
  const { dir, store } = setup(t)
  const target = hex()
  const a = store.add(fields({ target, decision: 'bloquear' })).exemplar
  store.add(fields({ target, decision: 'descartar' }))
  store.add(fields({ target, decision: 'bloquear' }))
  const other = store.add(fields()).exemplar

  t.is(store.remove(a.reportId), true)
  t.is(store.size(), 3)
  const before = fs.readFileSync(filePath(dir))
  t.is(store.remove(a.reportId), false, 'nothing left to remove')
  t.is(store.removeTarget(hex()), 0, 'unknown target')
  t.alike(fs.readFileSync(filePath(dir)), before, 'no write when nothing removed')
  throwsCode(t, () => store.remove('nope'), 'pedido-invalido', 'bad id')
  throwsCode(t, () => store.removeTarget(target, 'aberta'), 'pedido-invalido', 'bad decision')

  t.is(store.removeTarget(target, 'descartar'), 1)
  t.is(store.list().filter((r) => r.target === target).length, 1)
  t.is(store.removeTarget(target), 1)
  t.alike(onDisk(dir).items.map((r) => r.id), [other.id])
})
