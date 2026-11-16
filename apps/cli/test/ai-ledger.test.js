'use strict'

// apps/cli/lib/account/ai/ledger.js: the AI triage's derived ledger (report
// marks, verified-read cache). No network, injected clock.

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const test = require('brittle')
const { openLedger, FILE, LOG_FILE, DIM, MAX_REPORT_MARKS, MAX_READS } = require('../lib/account/ai/ledger')
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

function logPath (dir) {
  return path.join(dir, LOG_FILE)
}

function onDisk (dir) {
  return JSON.parse(fs.readFileSync(filePath(dir), 'utf8'))
}

function logLines (dir) {
  return fs.readFileSync(logPath(dir), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

// The marks a reopen would see: the snapshot, then the log lines whose
// header names the snapshot's token, then capped once.
function marksOnDisk (dir) {
  const snap = onDisk(dir)
  const out = { ...snap.reports }
  const lines = logLines(dir)
  if (lines[0].log !== snap.log) return out
  let last
  for (const { id, ...m } of lines.slice(1)) {
    out[id] = m
    last = id
  }
  const ids = Object.keys(out).filter((k) => k !== last)
  ids.sort((a, b) => out[a].at < out[b].at ? -1 : out[a].at > out[b].at ? 1 : a < b ? -1 : 1)
  const n = ids.length + (last ? 1 : 0) - MAX_REPORT_MARKS
  for (let i = 0; i < n; i++) delete out[ids[i]]
  return out
}

function isEmptyOnDisk (t, dir) {
  const d = onDisk(dir)
  t.alike(Object.keys(d), ['v', 'log', 'reports', 'reads'], 'v2 keys')
  t.is(d.v, 2)
  t.alike(d.reports, {})
  t.alike(d.reads, {})
  t.alike(logLines(dir), [{ log: d.log }], 'empty log under the snapshot token')
}

test('a missing file is created empty; mark merges and stamps at', (t) => {
  const { dir, c, ledger } = setup(t)
  isEmptyOnDisk(t, dir)
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
  t.alike(marksOnDisk(dir)[id], m2)
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
  t.is(Object.keys(marksOnDisk(dir)).length, MAX_REPORT_MARKS)
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
  obj.reports[id] = { ...ledger.get(id), extra: 1 }
  fs.writeFileSync(filePath(dir), JSON.stringify(obj))
  const bad = fs.readFileSync(filePath(dir))
  c.t = T0 + 42
  const l = open()
  t.is(l.get(id), null, 'starts over')
  isEmptyOnDisk(t, dir)
  const aside = path.join(dir, FILE + '.corrupt-' + (T0 + 42))
  t.alike(fs.readFileSync(aside), bad, 'the bad file kept aside byte-identical')
  t.ok(l.mark(id, { code: 'y' }), 'usable again')
})

test('a ledger still carrying a posts key is treated as corrupt', (t) => {
  const { dir, c, open } = setup(t)
  fs.writeFileSync(filePath(dir), JSON.stringify({ v: 1, reports: {}, reads: {}, posts: { [hex() + ':3']: true } }))
  c.t = T0 + 7
  const l = open()
  isEmptyOnDisk(t, dir)
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
  isEmptyOnDisk(t, dir)
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
  t.is(Object.keys(marksOnDisk(dir)).length, MAX_REPORT_MARKS)
  const freshRead = rid()
  const r = l.putRead(freshRead, readFields({ at: iso(T0 - 5000) }))
  t.alike(l.read(freshRead), r, 'new read kept despite an earlier at')
  t.is(l.read(readIdList[0]), null, 'oldest OTHER read dropped')
  t.is(l.readIds().length, MAX_READS)
})

function fileState (p) {
  const st = fs.statSync(p)
  return { bytes: fs.readFileSync(p), mtimeMs: st.mtimeMs, ino: st.ino }
}

function markRow (at, code = 'x') {
  return { at, code, retryAt: null, attempts: 0, exemplars: 0, suggestion: null, nearest: null }
}

test('a mark that changes nothing but at writes nothing and keeps the old at', async (t) => {
  const { dir, c, ledger } = setup(t)
  const id = rid()
  const m = ledger.mark(id, { code: 'decidida', exemplars: 3, nearest: 0.5 })
  const snap = fileState(filePath(dir))
  const log = fileState(logPath(dir))
  await new Promise((resolve) => setTimeout(resolve, 20))
  c.t += 60000
  t.alike(ledger.mark(id, { code: 'decidida', nearest: 0.5 }), m, 'stored row returned, old at')
  t.alike(ledger.get(id), m)
  t.alike(fileState(filePath(dir)), snap, 'triage.json untouched')
  t.alike(fileState(logPath(dir)), log, 'log untouched')
  t.is(ledger.mark(id, { nearest: 0.6 }).at, iso(c.t), 'a real change still stamps at')
})

test('a mark appends one compact line and never rewrites triage.json', (t) => {
  const { dir, c, ledger } = setup(t)
  const snap = fileState(filePath(dir))
  t.is(fs.statSync(logPath(dir)).mode & 0o777, 0o600, 'log mode 0o600')
  const a = rid()
  const b = rid()
  ledger.mark(a, { code: 'x' })
  c.t += 1000
  ledger.mark(b, { code: 'y', attempts: 2 })
  c.t += 1000
  const m = ledger.mark(a, { code: 'z' })
  t.alike(fileState(filePath(dir)), snap, 'snapshot byte-identical, same inode')
  const raw = fs.readFileSync(logPath(dir), 'utf8')
  t.is(raw.split('\n').length, 5, 'header + 3 lines + trailing newline')
  t.absent(raw.includes('\n  '), 'compact lines')
  t.alike(logLines(dir)[3], { id: a, ...m })
})

test('reopen replays the log over the snapshot, last line wins', (t) => {
  const { c, ledger, open } = setup(t)
  const a = rid()
  const b = rid()
  ledger.mark(a, { code: 'x' })
  ledger.putRead(b, readFields())
  c.t += 1000
  const mb = ledger.mark(b, { code: 'y' })
  c.t += 1000
  const ma = ledger.mark(a, { code: 'z', attempts: 4 })
  const l = open()
  t.alike(l.get(a), ma)
  t.alike(l.get(b), mb)
  t.ok(l.read(b))
})

test('a torn last line is dropped; a bad line in the middle is corruption', (t) => {
  const { dir, c, ledger, open } = setup(t)
  const a = rid()
  const ma = ledger.mark(a, { code: 'x' })
  fs.appendFileSync(logPath(dir), '{"id":"' + rid() + '","at":')
  const l = open()
  t.alike(l.get(a), ma, 'complete lines kept')
  t.is(fs.readFileSync(logPath(dir), 'utf8').endsWith('\n'), true, 'torn tail removed before the next append')
  c.t += 1000
  const b = rid()
  const mb = l.mark(b, { code: 'y' })
  const l2 = open()
  t.alike(l2.get(a), ma)
  t.alike(l2.get(b), mb)
  fs.appendFileSync(logPath(dir), 'garbage\n')
  const l4 = open()
  t.alike(l4.get(b), mb, 'an unparsable complete last line is dropped too')
  c.t += 1000
  l4.mark(rid(), { code: 'q' })
  const lines = fs.readFileSync(logPath(dir), 'utf8').split('\n')
  lines.splice(1, 0, '{"id":"bad"}')
  fs.writeFileSync(logPath(dir), lines.join('\n'))
  const badLog = fs.readFileSync(logPath(dir))
  c.t = T0 + 77
  const l3 = open()
  t.is(l3.get(b), null, 'starts over')
  isEmptyOnDisk(t, dir)
  t.alike(fs.readFileSync(path.join(dir, LOG_FILE + '.corrupt-' + (T0 + 77))), badLog, 'bad log kept aside')
  t.ok(fs.existsSync(path.join(dir, FILE + '.corrupt-' + (T0 + 77))), 'snapshot set aside with it')
})

test('compaction past 2 x MAX_REPORT_MARKS lines and on prune keeps every mark and the caps', (t) => {
  const { dir, c, open } = setup(t)
  const token = onDisk(dir).log
  const ids = []
  for (let i = 0; i < MAX_REPORT_MARKS + 5000; i++) ids.push(rid())
  const out = [JSON.stringify({ log: token })]
  for (let i = 0; i < 2 * MAX_REPORT_MARKS; i++) {
    out.push(JSON.stringify({ id: ids[i % ids.length], ...markRow(iso(T0 + i), i % 2 ? 'x' : 'y') }))
  }
  fs.writeFileSync(logPath(dir), out.join('\n') + '\n')
  const expected = marksOnDisk(dir)
  t.is(Object.keys(expected).length, MAX_REPORT_MARKS)
  const l = open()
  for (const id of Object.keys(expected)) {
    if (l.get(id) === null) t.fail('replay lost ' + id)
  }
  c.t = T0 + 10 * MAX_REPORT_MARKS
  const fresh = rid()
  const mf = l.mark(fresh, { code: 'novo' })
  t.alike(logLines(dir), [{ log: onDisk(dir).log }], 'log folded into the snapshot')
  t.not(onDisk(dir).log, token, 'new token')
  const snap = onDisk(dir).reports
  t.is(Object.keys(snap).length, MAX_REPORT_MARKS, 'cap held')
  t.alike(snap[fresh], mf)
  const evicted = Object.keys(expected).filter((id) => !snap[id])
  t.is(evicted.length, 1, 'exactly the oldest one evicted')
  const oldest = Object.keys(expected).sort((a, b) => expected[a].at < expected[b].at ? -1 : 1)[0]
  t.alike(evicted, [oldest])
  for (const id of Object.keys(snap)) {
    if (id !== fresh && JSON.stringify(snap[id]) !== JSON.stringify(expected[id])) t.fail('changed ' + id)
  }
  c.t += 1000
  const mg = l.mark(ids[0], { code: 'outro' })
  t.is(l.prune(), 0, 'nothing beyond the caps')
  t.is(logLines(dir).length, 1, 'prune folds the log')
  t.alike(onDisk(dir).reports[ids[0]], mg)
  const st = fileState(filePath(dir))
  t.is(l.prune(), 0)
  t.alike(fileState(filePath(dir)), st, 'nothing logged: prune writes nothing')
})

test('a v1 triage.json is migrated to v2 at open', (t) => {
  const { dir, open } = setup(t)
  const a = rid()
  const reports = { [a]: markRow(iso(T0 - 1000), 'decidida') }
  const reads = { [a]: { at: iso(T0 - 2000), ...readFields() } }
  fs.writeFileSync(filePath(dir), JSON.stringify({ v: 1, reports, reads }))
  fs.rmSync(logPath(dir))
  const l = open()
  t.alike(l.get(a), reports[a])
  t.alike(l.read(a), reads[a])
  const d = onDisk(dir)
  t.is(d.v, 2)
  t.alike(d.reports, reports, 'v1 marks become the snapshot')
  t.alike(d.reads, reads)
  t.alike(logLines(dir), [{ log: d.log }])
  t.alike(fs.readdirSync(dir).filter((n) => n.includes('corrupt')), [], 'nothing set aside')
})

test('a crash between the snapshot write and the log reset loses and replays nothing', (t) => {
  const { dir, c, ledger, open } = setup(t)
  const a = rid()
  const b = rid()
  ledger.mark(a, { code: 'x' })
  c.t += 1000
  ledger.mark(b, { code: 'y' })
  const staleLog = fs.readFileSync(logPath(dir))
  c.t += 1000
  const ma = ledger.mark(a, { code: 'z' })
  ledger.prune()
  // The snapshot was replaced but the old log survived the crash.
  fs.writeFileSync(logPath(dir), staleLog)
  const l = open()
  t.alike(l.get(a), ma, 'the stale log line for a is not replayed over the snapshot')
  t.ok(l.get(b))
  t.alike(logLines(dir), [{ log: onDisk(dir).log }], 'stale log replaced at open')
  c.t += 1000
  const mb = l.mark(b, { code: 'w' })
  t.alike(open().get(b), mb, 'later marks land in the new log')
})

test('a failed log header write after the snapshot is retried once', (t) => {
  const { dir, c, ledger, open } = setup(t)
  const a = rid()
  const b = rid()
  ledger.mark(a, { code: 'x' })
  // ENOSPC on the first temp file of the log header only.
  const realOpen = fs.openSync
  let failures = 1
  fs.openSync = function (p, ...rest) {
    if (failures > 0 && typeof p === 'string' && path.basename(p).startsWith('.' + LOG_FILE + '.')) {
      failures--
      const err = new Error('ENOSPC')
      err.code = 'ENOSPC'
      throw err
    }
    return realOpen.call(fs, p, ...rest)
  }
  let read
  try {
    read = ledger.putRead(b, readFields())
  } finally {
    fs.openSync = realOpen
  }
  t.is(failures, 0, 'the header write failed once')
  t.alike(logLines(dir), [{ log: onDisk(dir).log }], 'the log names the new snapshot')
  t.alike(ledger.read(b), read, 'the read was kept')
  c.t += 1000
  const ma = ledger.mark(a, { code: 'y' })
  t.alike(ma.code, 'y', 'the ledger still writes marks')
  const l = open()
  t.alike(l.get(a), ma, 'the later mark survives a reopen')
  t.alike(l.read(b), read)
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
