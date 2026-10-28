'use strict'

// apps/cli/lib/account/ai/ledger.js: the AI triage's derived ledger (report
// marks, verified-read cache). No network, injected clock.

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const test = require('brittle')
const { openLedger, FILE, DIM, MAX_REPORT_MARKS, MAX_READS } = require('../lib/account/ai/ledger')
const { tmpDir } = require('./helpers/net')

const T0 = Date.parse('2026-10-24T12:00:00.000Z')

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

function iso (ms) {
  return new Date(ms).toISOString()
}

function readFields (extra = {}) {
  return {
    target: hex(),
    seq: 7,
    contentHash: hex(),
    text: 'olá\nmundo',
    hasMedia: false,
    hasQuote: true,
    textCp: 9,
    truncated: false,
    embedding: new Array(DIM).fill(-3),
    ...extra
  }
}

function setup (t) {
  const dir = path.join(tmpDir(t), 'account')
  const c = clock()
  const open = () => openLedger(dir, { now: c.now })
  return { dir, c, ledger: open(), open }
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

test('a missing file is created empty; mark merges and stamps at', (t) => {
  const { dir, c, ledger } = setup(t)
  t.alike(onDisk(dir), { v: 1, reports: {}, reads: {} })
  t.is(fs.statSync(filePath(dir)).mode & 0o777, 0o600, 'file mode 0o600')
  const id = rid()
  t.is(ledger.get(id), null)
  throwsCode(t, () => ledger.mark(id, {}), 'pedido-invalido', 'a first mark names a code')
  const m = ledger.mark(id, { code: 'leitura-falhou', attempts: 1, retryAt: iso(T0 + 60000) })
  t.alike(m, { at: iso(T0), code: 'leitura-falhou', retryAt: iso(T0 + 60000), attempts: 1, exemplars: 0, suggestion: null, nearest: null })
  c.t += 1000
  const m2 = ledger.mark(id, { code: 'decidida', retryAt: null, exemplars: 12, suggestion: 'descartar', nearest: 0.91 })
  t.is(m2.attempts, 1, 'unnamed fields kept')
  t.is(m2.at, iso(T0 + 1000))
  t.alike(ledger.get(id), m2)
  t.alike(onDisk(dir).reports[id], m2)
  throwsCode(t, () => ledger.mark(id, { code: 'Maiúscula' }), 'pedido-invalido', 'code token')
  throwsCode(t, () => ledger.mark(id, { code: 'x'.repeat(33) }), 'pedido-invalido', 'code too long')
  throwsCode(t, () => ledger.mark(id, { nearest: 1.5 }), 'pedido-invalido', 'nearest range')
  throwsCode(t, () => ledger.mark(id, { attempts: -1 }), 'pedido-invalido', 'attempts')
  throwsCode(t, () => ledger.mark(id, { suggestion: 'talvez' }), 'pedido-invalido', 'suggestion')
  throwsCode(t, () => ledger.mark(id, { retryAt: 'amanhã' }), 'pedido-invalido', 'retryAt')
  throwsCode(t, () => ledger.mark(id, { at: iso(T0) }), 'pedido-invalido', 'at is the clock')
  throwsCode(t, () => ledger.mark(id, { extra: 1 }), 'pedido-invalido', 'unknown key')
  throwsCode(t, () => ledger.mark('bad', { code: 'x' }), 'pedido-invalido', 'bad id')
  t.alike(ledger.get(id), m2, 'refusals change nothing')
})

test('putRead, read, readIds, dropRead', (t) => {
  const { dir, c, ledger } = setup(t)
  const a = rid()
  const b = rid()
  const ra = ledger.putRead(a, readFields())
  t.is(ra.at, iso(T0), 'at defaults to the clock')
  const rb = ledger.putRead(b, readFields({ at: iso(T0 - 5000), embedding: null }))
  t.is(rb.at, iso(T0 - 5000), 'an explicit capture time is kept')
  t.is(rb.embedding, null)
  t.alike(ledger.read(a), ra)
  const copy = ledger.read(a)
  copy.embedding[0] = 5
  t.is(ledger.read(a).embedding[0], -3, 'read returns copies')
  t.alike(ledger.readIds().sort(), [a, b].sort())
  t.alike(Object.keys(onDisk(dir).reads[a]), ['at', 'target', 'seq', 'contentHash', 'text', 'hasMedia', 'hasQuote', 'textCp', 'truncated', 'embedding'])
  throwsCode(t, () => ledger.putRead(rid(), readFields({ embedding: new Array(DIM + 1).fill(0) })), 'pedido-invalido', '385 numbers')
  throwsCode(t, () => ledger.putRead(rid(), readFields({ text: 'a\u0007' })), 'pedido-invalido', 'unclean text')
  throwsCode(t, () => ledger.putRead(rid(), readFields({ seq: 0 })), 'pedido-invalido', 'seq')
  throwsCode(t, () => ledger.putRead(rid(), readFields({ extra: 1 })), 'pedido-invalido', 'unknown key')
  const missing = readFields()
  delete missing.truncated
  throwsCode(t, () => ledger.putRead(rid(), missing), 'pedido-invalido', 'missing key')
  c.t += 1000
  t.is(ledger.dropRead(a), true)
  t.is(ledger.dropRead(a), false)
  t.is(ledger.read(a), null)
  t.alike(ledger.readIds(), [b])
})

test('caps drop the oldest at', (t) => {
  const { dir, c, open } = setup(t)
  const reports = {}
  const reads = {}
  const markIds = []
  for (let i = 0; i < MAX_REPORT_MARKS; i++) {
    const id = rid()
    markIds.push(id)
    reports[id] = { at: iso(T0 + i), code: 'x', retryAt: null, attempts: 0, exemplars: 0, suggestion: null, nearest: null }
  }
  const readIdList = []
  for (let i = 0; i < MAX_READS; i++) {
    const id = rid()
    readIdList.push(id)
    reads[id] = { at: iso(T0 + (i === 3 ? -1 : i)), ...readFields({ embedding: null }) }
  }
  fs.writeFileSync(filePath(dir), JSON.stringify({ v: 1, reports, reads }))
  const l = open()
  t.is(l.prune(), 0, 'nothing beyond the caps')
  c.t = T0 + 10 * MAX_REPORT_MARKS
  const fresh = rid()
  l.mark(fresh, { code: 'novo' })
  t.is(l.get(markIds[0]), null, 'oldest mark dropped')
  t.ok(l.get(markIds[1]), 'next oldest kept')
  t.ok(l.get(fresh))
  t.is(Object.keys(onDisk(dir).reports).length, MAX_REPORT_MARKS)
  const freshRead = rid()
  l.putRead(freshRead, readFields())
  t.is(l.read(readIdList[3]), null, 'oldest read dropped (loses its cached text)')
  t.ok(l.read(readIdList[0]), 'next oldest kept')
  t.is(l.readIds().length, MAX_READS)
})

test('a corrupt triage.json is renamed aside and recreated empty', (t) => {
  const { dir, c, ledger, open } = setup(t)
  const id = rid()
  ledger.mark(id, { code: 'x' })
  const obj = onDisk(dir)
  obj.reports[id].extra = 1
  fs.writeFileSync(filePath(dir), JSON.stringify(obj))
  const bad = fs.readFileSync(filePath(dir))
  c.t = T0 + 42
  const l = open()
  t.is(l.get(id), null, 'starts over')
  t.alike(onDisk(dir), { v: 1, reports: {}, reads: {} })
  const aside = path.join(dir, FILE + '.corrupt-' + (T0 + 42))
  t.alike(fs.readFileSync(aside), bad, 'the bad file kept aside byte-identical')
  t.ok(l.mark(id, { code: 'y' }), 'usable again')
})

test('a ledger still carrying a posts key is treated as corrupt', (t) => {
  const { dir, c, open } = setup(t)
  fs.writeFileSync(filePath(dir), JSON.stringify({ v: 1, reports: {}, reads: {}, posts: { [hex() + ':3']: true } }))
  c.t = T0 + 7
  const l = open()
  t.alike(onDisk(dir), { v: 1, reports: {}, reads: {} })
  t.ok(fs.existsSync(path.join(dir, FILE + '.corrupt-' + (T0 + 7))), 'renamed aside')
  t.alike(l.readIds(), [])
})

test('unreadable JSON is renamed aside too; a failed recovery is indisponivel', (t) => {
  const { dir, c, open } = setup(t)
  fs.writeFileSync(filePath(dir), '{not json')
  c.t = T0 + 9
  open()
  t.ok(fs.existsSync(path.join(dir, FILE + '.corrupt-' + (T0 + 9))))
  // Every aside name for this millisecond taken: no free name, no recovery.
  for (let i = 1; i < 100; i++) fs.writeFileSync(path.join(dir, FILE + '.corrupt-' + (T0 + 9) + '-' + i), 'x')
  fs.writeFileSync(filePath(dir), '{not json')
  const l = open()
  throwsCode(t, () => l.get(rid()), 'indisponivel', 'get')
  throwsCode(t, () => l.readIds(), 'indisponivel', 'readIds')
  t.is(fs.readFileSync(filePath(dir), 'utf8'), '{not json', 'left alone')
})

test('a second recovery in the same millisecond never replaces the first aside copy', (t) => {
  const { dir, c, open } = setup(t)
  c.t = T0 + 11
  fs.writeFileSync(filePath(dir), 'first')
  open()
  fs.writeFileSync(filePath(dir), 'second')
  open()
  const base = path.join(dir, FILE + '.corrupt-' + (T0 + 11))
  t.is(fs.readFileSync(base, 'utf8'), 'first', 'earlier aside copy kept')
  t.is(fs.readFileSync(base + '-1', 'utf8'), 'second', 'next copy under -1')
  t.alike(onDisk(dir), { v: 1, reports: {}, reads: {} })
})

test('at the caps, the id being written is never evicted even when it sorts oldest', (t) => {
  const { dir, c, open } = setup(t)
  const reports = {}
  const reads = {}
  const markIds = []
  const readIdList = []
  for (let i = 0; i < MAX_REPORT_MARKS; i++) {
    const id = rid()
    markIds.push(id)
    reports[id] = { at: iso(T0 + 1000 + i), code: 'x', retryAt: null, attempts: 0, exemplars: 0, suggestion: null, nearest: null }
  }
  for (let i = 0; i < MAX_READS; i++) {
    const id = rid()
    readIdList.push(id)
    reads[id] = { at: iso(T0 + 1000 + i), ...readFields({ embedding: null }) }
  }
  fs.writeFileSync(filePath(dir), JSON.stringify({ v: 1, reports, reads }))
  const l = open()
  c.t = T0 // before every stored mark: the clock stepped back
  const fresh = rid()
  t.ok(l.mark(fresh, { code: 'novo' }))
  t.ok(l.get(fresh), 'new mark kept')
  t.is(l.get(markIds[0]), null, 'oldest OTHER mark dropped')
  t.is(Object.keys(onDisk(dir).reports).length, MAX_REPORT_MARKS)
  const freshRead = rid()
  const r = l.putRead(freshRead, readFields({ at: iso(T0 - 5000) }))
  t.alike(l.read(freshRead), r, 'new read kept despite an earlier at')
  t.is(l.read(readIdList[0]), null, 'oldest OTHER read dropped')
  t.is(l.readIds().length, MAX_READS)
})

test('a symlinked data dir is refused', (t) => {
  const root = tmpDir(t)
  const real = path.join(root, 'real')
  fs.mkdirSync(real)
  const link = path.join(root, 'link')
  fs.symlinkSync(real, link)
  t.exception(() => openLedger(link))
  t.absent(fs.existsSync(path.join(real, FILE)), 'nothing written through the link')
})
