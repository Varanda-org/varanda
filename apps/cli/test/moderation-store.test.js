'use strict'

// apps/cli/lib/account/moderation-store.js: reports, decisions, the pending
// change log and the published-snapshot mirror on disk. No network: keys,
// certificates and snapshots are made locally and the clock is injected.

const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createModeratorCert } = require('@varanda/core/lib/cert')
const { createSnapshot } = require('@varanda/core/lib/blocklist')
const {
  openModerationStore,
  FILE,
  MAX_REPORTS,
  MAX_PER_REPORTER_DAY,
  MAX_BLOCKED,
  NOTE_MAX,
  AI_ACTOR,
  MAX_APPEALS,
  APPEAL_WINDOW_MS
} = require('../lib/account/moderation-store')
const { tmpDir } = require('./helpers/net')

const T0 = Date.parse('2026-10-24T12:00:00.000Z')
const HOUR = 3600 * 1000
const MOD = 'mod@example.test'
const SIG = 'ab'.repeat(64)
const NONCE = 'n'.repeat(43)

function key () {
  return b4a.toString(crypto.keyPair().publicKey, 'hex')
}

function clock (start = T0) {
  const c = { t: start, now: () => c.t }
  return c
}

// One association, one certified moderator, snapshots signed by it.
function moderation (date = '2026-10-01T00:00:00.000Z') {
  const assoc = crypto.keyPair()
  const kp = crypto.keyPair()
  const cert = createModeratorCert({ moderator: b4a.toString(kp.publicKey, 'hex'), date }, assoc)
  const snap = (seq, blocked = []) => createSnapshot({ seq, date: new Date(T0).toISOString(), blocked }, kp, cert)
  return { assoc, kp, cert, association: cert.association, snap }
}

function setup (t) {
  const dir = path.join(tmpDir(t), 'account')
  const c = clock()
  const m = moderation()
  const open = () => openModerationStore(dir, { now: c.now, association: m.association })
  return { dir, c, m, store: open(), open }
}

function report (target, reporter = key(), extra = {}) {
  return { reporter, target, seq: 3, reason: 'spam', text: 'propaganda', quote: 'compre já', signature: SIG, nonce: NONCE, ...extra }
}

async function rejects (t, p, code, msg) {
  try {
    await p
    t.fail(msg + ': resolved')
  } catch (err) {
    t.is(err.code, code, msg)
  }
}

function throwsCode (t, fn, code, msg) {
  try {
    fn()
    t.fail(msg + ': returned')
  } catch (err) {
    t.is(err.code, code, msg)
  }
}

function onDisk (dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'))
}

test('a missing file is created empty, 0o600 in a 0o700 dir', async (t) => {
  const { dir, store } = setup(t)
  t.is(fs.statSync(dir).mode & 0o777, 0o700)
  t.is(fs.statSync(path.join(dir, FILE)).mode & 0o777, 0o600)
  const disk = onDisk(dir)
  t.is(disk.v, 3)
  t.alike(disk.appeals, {})
  t.alike(disk.pending, [])
  t.alike(disk.published, { snapshot: null, at: null, moderatorDate: '' })
  t.alike(store.stats(), { open: 0, appeals: 0, pending: 0, blocked: 0, publishedSeq: null })
  t.is(store.newestModeratorDate(), '')
})

test('add stores an open report; a repeat by the same reporter is a duplicate without a write', async (t) => {
  const { dir, store, c } = setup(t)
  const target = key()
  const reporter = key()
  const first = await store.add(report(target, reporter))
  t.is(first.duplicate, false)
  t.is(first.report.status, 'aberta')
  t.is(first.report.kind, 'post')
  t.is(first.report.at, new Date(T0).toISOString())
  t.ok(/^[A-Za-z0-9_-]{22}$/.test(first.report.id), 'base64url id')
  const before = fs.readFileSync(path.join(dir, FILE), 'utf8')
  c.t += 1000
  const again = await store.add(report(target, reporter))
  t.is(again.duplicate, true)
  t.is(again.report.id, first.report.id)
  t.is(fs.readFileSync(path.join(dir, FILE), 'utf8'), before, 'nothing written')
  const account = await store.add(report(target, reporter, { seq: null, quote: '' }))
  t.is(account.duplicate, false, 'an account report is another (target, seq)')
  t.is(account.report.kind, 'account')
  t.is(store.get(first.report.id).text, 'propaganda')
  t.is(store.get('nope'), null)
})

test('add re-validates every field', async (t) => {
  const { store } = setup(t)
  const target = key()
  const bad = [
    { target: target.toUpperCase() },
    { reporter: target },
    { seq: 0 },
    { seq: 100000 },
    { reason: 'spam ' },
    { text: 'x'.repeat(281) },
    { text: 'a\u202eb' },
    { text: 'a\nb' },
    { text: '\ud800' },
    { quote: 'q'.repeat(1001) },
    { seq: null, quote: 'q' },
    { signature: SIG.toUpperCase() },
    { nonce: 'short' }
  ]
  for (const extra of bad) {
    await rejects(t, store.add(report(target, key(), extra)), 'pedido-invalido', JSON.stringify(Object.keys(extra)))
  }
  const ok = await store.add(report(target, key(), { quote: 'linha 1\nlinha 2', text: 'x'.repeat(280) }))
  t.is(ok.duplicate, false, 'LF in a quote and 280 code points of text are fine')
})

test('list: open oldest first, decided newest first, with truncated', async (t) => {
  const { store, c } = setup(t)
  const ids = []
  for (let i = 0; i < 4; i++) {
    ids.push((await store.add(report(key()))).report.id)
    c.t += 1000
  }
  const open = store.list({ status: 'aberta' })
  t.alike(open.reports.map((r) => r.id), ids)
  t.is(open.truncated, false)
  const two = store.list({ status: 'aberta', limit: 2 })
  t.alike(two.reports.map((r) => r.id), ids.slice(0, 2))
  t.is(two.truncated, true)
  await store.decide(ids[0], { decision: 'descartar', by: MOD })
  c.t += 1000
  await store.decide(ids[2], { decision: 'descartar', by: MOD })
  const decided = store.list({ status: 'decidida' })
  t.alike(decided.reports.map((r) => r.id), [ids[2], ids[0]])
  t.alike(store.list().reports.map((r) => r.id), [ids[1], ids[3]])
  throwsCode(t, () => store.list({ status: 'todas' }), 'pedido-invalido', 'unknown status')
  throwsCode(t, () => store.list({ limit: 0 }), 'pedido-invalido', 'limit 0')
})

test('list: exclude leaves a member out before the cut, so truncated counts only the rest', async (t) => {
  const { store, c } = setup(t)
  const me = key()
  const others = []
  for (let i = 0; i < 2; i++) {
    await store.add(report(me, key()))
    c.t += 1000
    await store.add(report(key(), me))
    c.t += 1000
  }
  for (let i = 0; i < 3; i++) {
    others.push((await store.add(report(key(), key()))).report.id)
    c.t += 1000
  }
  const all = store.list({ limit: 5 })
  t.is(all.reports.length, 5)
  t.is(all.truncated, true, 'without exclude the own cases count')
  const page = store.list({ limit: 3, exclude: me })
  t.alike(page.reports.map((r) => r.id), others, 'the own cases (as target and as reporter) are not in the page')
  t.is(page.truncated, false, 'and do not make it look cut')
  const cut = store.list({ limit: 2, exclude: me })
  t.alike(cut.reports.map((r) => r.id), others.slice(0, 2))
  t.is(cut.truncated, true)
  t.is(store.list({ exclude: null }).reports.length, 7)
  throwsCode(t, () => store.list({ exclude: 7 }), 'pedido-invalido', 'exclude must be a string or null')
})

test('list: exclude keeps a group report whose group key is that member (the reporter chose it)', async (t) => {
  const { store } = setup(t)
  const me = key()
  const named = (await store.add(report(key(), key(), { writer: key(), group: me }))).report.id
  const other = (await store.add(report(key(), key(), { writer: key(), group: key() }))).report.id
  t.alike(store.list({ exclude: me }).reports.map((r) => r.id), [named, other])
})

test('per-reporter daily cap follows the injected clock', async (t) => {
  const { store, c } = setup(t)
  const reporter = key()
  for (let i = 0; i < MAX_PER_REPORTER_DAY; i++) {
    await store.add(report(key(), reporter))
    c.t += 60 * 1000
  }
  await rejects(t, store.add(report(key(), reporter)), 'limite-denuncias', 'over the cap')
  t.ok((await store.add(report(key()))).report, 'another reporter is not affected')
  c.t = T0 + 24 * HOUR + 1
  t.ok((await store.add(report(key(), reporter))).report, 'the oldest left the window')
})

test('a full store refuses with limite and keeps every row', async (t) => {
  const dir = path.join(tmpDir(t), 'account')
  const m = moderation()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const reports = {}
  const at = new Date(T0 - 30 * 24 * HOUR).toISOString()
  for (let i = 0; i < MAX_REPORTS; i++) {
    const id = ('r' + i).padEnd(22, '_')
    reports[id] = { id, at, kind: 'account', target: key(), seq: null, quote: '', reporter: key(), reason: 'spam', text: '', nonce: NONCE, signature: SIG, status: 'aberta', decidedBy: null, decidedAt: null, note: '' }
  }
  const state = { v: 1, reports, pending: [], published: { snapshot: null, at: null, moderatorDate: '' }, events: [] }
  fs.writeFileSync(path.join(dir, FILE), JSON.stringify(state), { mode: 0o600 })
  const store = openModerationStore(dir, { now: () => T0, association: m.association })
  await rejects(t, store.add(report(key())), 'limite', 'full')
  const dup = reports['r7'.padEnd(22, '_')]
  const again = await store.add({ reporter: dup.reporter, target: dup.target, seq: null, reason: 'spam', text: '', quote: '', signature: SIG, nonce: NONCE })
  t.is(again.duplicate, true, 'a retry still answers the duplicate')
  t.is(Object.keys(onDisk(dir).reports).length, MAX_REPORTS, 'no row evicted')
  t.is(store.stats().open, MAX_REPORTS)

  // Deciding one open report frees intake: decided reports stay on file but
  // no longer count toward the open cap.
  const first = reports['r0'.padEnd(22, '_')]
  await store.decide(first.id, { decision: 'descartar', by: MOD })
  const added = await store.add(report(key()))
  t.is(added.duplicate, false, 'a new report fits after one was decided')
  t.is(Object.keys(onDisk(dir).reports).length, MAX_REPORTS + 1, 'the decided report is kept')
})

test('decide bloquear merges reports of the same member into one pending block', async (t) => {
  const { store } = setup(t)
  const target = key()
  const a = (await store.add(report(target))).report
  const b = (await store.add(report(target))).report
  const first = await store.decide(a.id, { decision: 'bloquear', by: MOD, note: 'spam repetido' })
  t.is(first.report.status, 'bloquear')
  t.is(first.report.decidedBy, MOD)
  t.is(first.report.note, 'spam repetido')
  t.is(first.change.op, 'block')
  t.is(first.change.member, target)
  const second = await store.decide(b.id, { decision: 'bloquear', by: MOD })
  t.is(second.change.id, first.change.id, 'same change')
  const { changes } = store.pending()
  t.is(changes.length, 1)
  t.alike(changes[0].reportIds, [a.id, b.id])
  t.is(changes[0].claimedAt, null)
})

test('a group report round-trips writer and group; diary rows carry null', async (t) => {
  const { store, open } = setup(t)
  const target = key()
  const writer = key()
  const group = key()
  const diary = (await store.add(report(target))).report
  t.is(diary.writer, null)
  t.is(diary.group, null)
  const added = (await store.add(report(target, key(), { writer, group }))).report
  t.is(added.kind, 'post')
  t.is(added.writer, writer)
  t.is(added.group, group)
  const reopened = open()
  t.is(reopened.get(added.id).writer, writer)
  t.is(reopened.get(added.id).group, group)
  t.is(reopened.get(diary.id).writer, null)
  await rejects(t, store.add(report(target, key(), { writer })), 'pedido-invalido', 'writer without group')
  await rejects(t, store.add(report(target, key(), { group })), 'pedido-invalido', 'group without writer')
  await rejects(t, store.add(report(target, key(), { writer, group, seq: null, quote: '' })), 'pedido-invalido', 'writer without seq')
  await rejects(t, store.add(report(target, key(), { writer: writer.toUpperCase(), group })), 'pedido-invalido', 'upper-case writer')
})

test('dedupe key holds the writer: a diary post and group messages at one seq are distinct reports', async (t) => {
  const { store } = setup(t)
  const target = key()
  const reporter = key()
  const group = key()
  const w1 = key()
  const w2 = key()
  const diary = await store.add(report(target, reporter, { seq: 1 }))
  const first = await store.add(report(target, reporter, { seq: 1, writer: w1, group }))
  const second = await store.add(report(target, reporter, { seq: 1, writer: w2, group }))
  t.is(diary.duplicate, false)
  t.is(first.duplicate, false, 'group message at the diary seq')
  t.is(second.duplicate, false, 'another writer at seq 1')
  t.is(new Set([diary.report.id, first.report.id, second.report.id]).size, 3)
  const again = await store.add(report(target, reporter, { seq: 1, writer: w1, group }))
  t.is(again.duplicate, true)
  t.is(again.report.id, first.report.id)
})

test('decide with block grupo puts the group root key in the pending change', async (t) => {
  const { store } = setup(t)
  const target = key()
  const group = key()
  const diaryRow = (await store.add(report(target))).report
  const groupRow = (await store.add(report(target, key(), { writer: key(), group }))).report
  await rejects(t, store.decide(diaryRow.id, { decision: 'bloquear', by: MOD, block: 'grupo' }), 'pedido-invalido', 'grupo needs a group report')
  await rejects(t, store.decide(groupRow.id, { decision: 'bloquear', by: MOD, block: 'conta' }), 'pedido-invalido', 'unknown block target')
  const { change } = await store.decide(groupRow.id, { decision: 'bloquear', by: MOD, block: 'grupo' })
  t.is(change.op, 'block')
  t.is(change.member, group, 'the root key, not the author')
  t.alike(change.reportIds, [groupRow.id])
  const diary = await store.decide(diaryRow.id, { decision: 'bloquear', by: MOD })
  t.is(diary.change.member, target, 'default diario blocks the author')
})

test('an old v1 file is read with writer null and rewritten as v2', async (t) => {
  const dir = path.join(tmpDir(t), 'account')
  const m = moderation()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const id = 'old'.padEnd(22, '_')
  const target = key()
  const reporter = key()
  const row = { id, at: new Date(T0).toISOString(), kind: 'post', target, seq: 4, quote: 'q', reporter, reason: 'spam', text: '', nonce: NONCE, signature: SIG, status: 'aberta', decidedBy: null, decidedAt: null, note: '' }
  const state = { v: 1, reports: { [id]: row }, pending: [], published: { snapshot: null, at: null, moderatorDate: '' }, events: [] }
  fs.writeFileSync(path.join(dir, FILE), JSON.stringify(state), { mode: 0o600 })
  const store = openModerationStore(dir, { now: () => T0, association: m.association })
  t.alike(store.get(id), { ...row, writer: null, group: null, blocked: null })
  const again = await store.add({ reporter, target, seq: 4, reason: 'spam', text: '', quote: 'q', signature: SIG, nonce: NONCE })
  t.is(again.duplicate, true, 'an old diary row still dedupes')
  await store.decide(id, { decision: 'descartar', by: MOD })
  const disk = onDisk(dir)
  t.is(disk.v, 3)
  t.alike(disk.appeals, {})
  t.is(disk.reports[id].writer, null)
  t.is(disk.reports[id].group, null)
  t.is(disk.reports[id].blocked, null)
})

test('a v2 row written before the blocked field opens with blocked null', async (t) => {
  const { dir, m, store } = setup(t)
  const r = (await store.add(report(key()))).report
  await store.decide(r.id, { decision: 'bloquear', by: MOD })
  const disk = onDisk(dir)
  t.is(disk.reports[r.id].blocked, 'diario')
  delete disk.reports[r.id].blocked
  fs.writeFileSync(path.join(dir, FILE), JSON.stringify(disk), { mode: 0o600 })
  const reopened = openModerationStore(dir, { now: () => T0, association: m.association })
  t.is(reopened.get(r.id).blocked, null)
  t.is(reopened.stats().pending, 1)
})

test('a group block is remembered on the row: blocked() and humanReversed() follow the key actually blocked', async (t) => {
  const { store, m } = setup(t)
  const author = key()
  const group = key()
  const groupRow = (await store.add(report(author, key(), { writer: key(), group }))).report
  const g = await store.decide(groupRow.id, { decision: 'bloquear', by: MOD, block: 'grupo' })
  t.is(g.report.blocked, 'grupo')
  t.is(store.humanReversed(author), false, 'blocking the group reversed nothing about the author')
  await store.ack({ changeIds: [g.change.id], snapshot: m.snap(1, [group]), moderatorCert: m.cert })
  t.alike(store.blocked(), [{ member: group, reportIds: [groupRow.id], kind: 'grupo' }], 'the published group block carries its report')
  t.is(store.humanReversed(author), false, 'still false once the pending change is acked')

  const diaryRow = (await store.add(report(author))).report
  const d = await store.decide(diaryRow.id, { decision: 'bloquear', by: MOD })
  t.is(d.report.blocked, 'diario')
  await store.ack({ changeIds: [d.change.id], snapshot: m.snap(2, [group, author]), moderatorCert: m.cert })
  const byMember = Object.fromEntries(store.blocked().map((b) => [b.member, b.reportIds]))
  t.alike(byMember[author], [diaryRow.id], 'the account block does not claim the group report')
  t.alike(byMember[group], [groupRow.id])
  t.alike([...store.groupKeys()], [group], 'groupKeys: every key blocked as a group root, the author excluded')
  const discarded = (await store.add(report(key()))).report
  t.is((await store.decide(discarded.id, { decision: 'descartar', by: MOD })).report.blocked, null)
})

test('decide validates the note and refuses a decided report', async (t) => {
  const { store } = setup(t)
  const r = (await store.add(report(key()))).report
  await rejects(t, store.decide(r.id, { decision: 'bloquear', by: MOD, note: 'x'.repeat(NOTE_MAX + 1) }), 'pedido-invalido', 'long note')
  await rejects(t, store.decide(r.id, { decision: 'bloquear', by: MOD, note: 'a\u202eb' }), 'pedido-invalido', 'bidi in note')
  await rejects(t, store.decide(r.id, { decision: 'apagar', by: MOD }), 'pedido-invalido', 'unknown decision')
  t.is(store.get(r.id).status, 'aberta', 'still open after refusals')
  await store.decide(r.id, { decision: 'descartar', by: MOD, note: 'ok\nsem problema' })
  await rejects(t, store.decide(r.id, { decision: 'bloquear', by: MOD }), 'nao-encontrado', 'already decided')
  await rejects(t, store.decide('nope', { decision: 'bloquear', by: MOD }), 'nao-encontrado', 'unknown id')
})

test('descartar leaves a pending block of the same member untouched', async (t) => {
  const { store } = setup(t)
  const target = key()
  const a = (await store.add(report(target))).report
  const b = (await store.add(report(target))).report
  await store.decide(a.id, { decision: 'bloquear', by: MOD })
  const before = store.pending().changes
  const res = await store.decide(b.id, { decision: 'descartar', by: MOD })
  t.is(res.change, null)
  t.alike(store.pending().changes, before)
})

test('unblock of a pending block cancels it; unblock with nothing published is nao-encontrado', async (t) => {
  const { store } = setup(t)
  const target = key()
  await rejects(t, store.unblock(target, { by: MOD }), 'nao-encontrado', 'published null, nothing pending')
  const r = (await store.add(report(target))).report
  await store.decide(r.id, { decision: 'bloquear', by: MOD })
  const res = await store.unblock(target, { by: MOD })
  t.is(res.change, null)
  t.is(store.pending().changes.length, 0)
  t.is(store.get(r.id).status, 'bloquear', 'the decision stays recorded')
})

test('a pending unblock is cancelled by a later bloquear; unblock again makes one pending unblock (D6)', async (t) => {
  const { store, m } = setup(t)
  const target = key()
  await store.ack({ changeIds: [], snapshot: m.snap(1, [target]), moderatorCert: m.cert })
  t.alike(store.blocked(), [{ member: target, reportIds: [], kind: 'conta' }])
  const u = await store.unblock(target, { by: MOD })
  t.is(u.change.op, 'unblock')
  const r = (await store.add(report(target))).report
  const d = await store.decide(r.id, { decision: 'bloquear', by: MOD })
  t.is(d.change, null)
  t.is(store.pending().changes.length, 0, 'net zero')
  const again = await store.unblock(target, { by: MOD })
  t.is(again.change.op, 'unblock')
  t.is(store.pending().changes.length, 1)
  const twice = await store.unblock(target, { by: MOD })
  t.is(twice.change, null, 'already unblocking')
  t.is(store.pending().changes.length, 1)
})

test('bloquear of an already published member creates no change', async (t) => {
  const { store, m } = setup(t)
  const target = key()
  await store.ack({ changeIds: [], snapshot: m.snap(1, [target]), moderatorCert: m.cert })
  const r = (await store.add(report(target))).report
  const d = await store.decide(r.id, { decision: 'bloquear', by: MOD })
  t.is(d.change, null)
  t.is(store.pending().changes.length, 0)
  t.alike(store.blocked(), [{ member: target, reportIds: [r.id], kind: 'conta' }])
})

test('ack refuses a forged snapshot, an older seq and a block missing from the list', async (t) => {
  const { store, m, dir } = setup(t)
  const target = key()
  await store.ack({ changeIds: [], snapshot: m.snap(5), moderatorCert: m.cert })
  const r = (await store.add(report(target))).report
  const { change } = await store.decide(r.id, { decision: 'bloquear', by: MOD })
  const before = fs.readFileSync(path.join(dir, FILE), 'utf8')

  const forged = { ...m.snap(6, [target]), seq: 7 }
  await rejects(t, store.ack({ changeIds: [change.id], snapshot: forged, moderatorCert: m.cert }), 'assinatura-invalida', 'forged')
  const other = moderation()
  await rejects(t, store.ack({ changeIds: [change.id], snapshot: other.snap(6, [target]), moderatorCert: other.cert }), 'assinatura-invalida', 'another association')
  await rejects(t, store.ack({ changeIds: [change.id], snapshot: m.snap(4, [target]), moderatorCert: m.cert }), 'defasado', 'lower seq')
  await rejects(t, store.ack({ changeIds: [change.id], snapshot: m.snap(6), moderatorCert: m.cert }), 'pedido-invalido', 'block absent')
  await rejects(t, store.ack({ changeIds: ['unknown'], snapshot: m.snap(6, [target]), moderatorCert: m.cert }), 'pedido-invalido', 'unknown id')
  const strangerCert = createModeratorCert({ moderator: key(), date: '2026-10-01T00:00:00.000Z' }, m.assoc)
  await rejects(t, store.ack({ changeIds: [change.id], snapshot: m.snap(6, [target]), moderatorCert: strangerCert }), 'pedido-invalido', 'certificate of another moderator')
  t.is(fs.readFileSync(path.join(dir, FILE), 'utf8'), before, 'nothing written')
  t.is(store.pending().changes.length, 1)
})

test('a good ack clears the ids and stores the snapshot and moderatorDate; same snapshot with [] is ok', async (t) => {
  const { store, m, c, dir } = setup(t)
  const target = key()
  const r = (await store.add(report(target))).report
  const { change } = await store.decide(r.id, { decision: 'bloquear', by: MOD })
  c.t += HOUR
  const snap = m.snap(1, [target])
  const res = await store.ack({ changeIds: [change.id], snapshot: snap, moderatorCert: m.cert })
  t.alike(res, { ok: true, seq: 1 })
  t.alike(store.pending().changes, [])
  t.alike(store.pending().published.snapshot, snap)
  t.is(store.pending().published.at, new Date(T0 + HOUR).toISOString())
  t.is(store.newestModeratorDate(), m.cert.date)
  t.alike(store.stats(), { open: 0, appeals: 0, pending: 0, blocked: 1, publishedSeq: 1 })
  t.alike(onDisk(dir).published.snapshot, snap)
  const same = await store.ack({ changeIds: [], snapshot: snap, moderatorCert: m.cert })
  t.is(same.ok, true)
})

test('an ack may drop a blocked key that is in no listed change (the operator list is authoritative)', async (t) => {
  // The operator may have run `mod unblock <key>` outside the panel: a key
  // the snapshot drops (or adds) that no listed change names is accepted as
  // is; only the listed members are checked against the list.
  const { store, m } = setup(t)
  const other = key()
  const target = key()
  await store.ack({ changeIds: [], snapshot: m.snap(1, [other]), moderatorCert: m.cert })
  const r = (await store.add(report(target))).report
  const { change } = await store.decide(r.id, { decision: 'bloquear', by: MOD })
  const res = await store.ack({ changeIds: [change.id], snapshot: m.snap(2, [target]), moderatorCert: m.cert })
  t.is(res.ok, true)
  t.alike(store.blocked().map((b) => b.member), [target])

  // But a listed unblock whose member is still in the list is refused.
  const u = await store.unblock(target, { by: MOD })
  await rejects(t, store.ack({ changeIds: [u.change.id], snapshot: m.snap(3, [target]), moderatorCert: m.cert }), 'pedido-invalido', 'unblock still listed')
})

test('a claimed change is compensated, never deleted; the next apply acks both (D6)', async (t) => {
  const { store, m, c } = setup(t)
  const target = key()
  const r = (await store.add(report(target))).report
  const { change } = await store.decide(r.id, { decision: 'bloquear', by: MOD })
  c.t += 1000
  const pulled = await store.pull()
  t.alike(pulled.changes, [{ id: change.id, op: 'block', member: target, at: change.at, actor: 'pessoa' }])
  t.is(pulled.published.snapshot, null)
  t.is(store.pending().changes[0].claimedAt, new Date(T0 + 1000).toISOString())
  // Publication failed; the panel cancels the claimed block.
  const res = await store.cancel(change.id, { by: MOD })
  t.is(res.change.op, 'unblock')
  const again = await store.pull()
  t.alike(again.changes.map((x) => x.op), ['block', 'unblock'])
  // Acking only the later change would skip the block: refused.
  await rejects(t, store.ack({ changeIds: [res.change.id], snapshot: m.snap(1), moderatorCert: m.cert }), 'pedido-invalido', 'not a prefix')
  const ok = await store.ack({ changeIds: again.changes.map((x) => x.id), snapshot: m.snap(1), moderatorCert: m.cert })
  t.is(ok.ok, true)
  t.alike(store.pending().changes, [])
  t.alike(store.blocked(), [])
})

test('pull marks a change the AI decided with actor ia and never returns by', async (t) => {
  const { store } = setup(t)
  t.is(AI_ACTOR, 'ia')
  const target = key()
  const r = (await store.add(report(target))).report
  const { change } = await store.decide(r.id, { decision: 'bloquear', by: AI_ACTOR })
  // A human report joining the AI's unclaimed block keeps by 'ia'.
  const r2 = (await store.add(report(target))).report
  await store.decide(r2.id, { decision: 'bloquear', by: MOD })
  const human = key()
  const r3 = (await store.add(report(human))).report
  const h = (await store.decide(r3.id, { decision: 'bloquear', by: MOD })).change
  const pulled = await store.pull()
  t.alike(pulled.changes, [
    { id: change.id, op: 'block', member: target, at: change.at, actor: 'ia' },
    { id: h.id, op: 'block', member: human, at: h.at, actor: 'pessoa' }
  ])
  t.absent(JSON.stringify(pulled).includes('@'), 'never an e-mail')
})

test('humanReversed: a human cancel, compensation or unblock counts; the AI and descartar do not', async (t) => {
  const { store, m } = setup(t)
  const fresh = key()
  t.is(store.humanReversed(fresh), false, 'a fresh member')
  t.is(store.humanReversed('nao-hex'), false, 'an invalid member')
  t.is(store.humanReversed(fresh.toUpperCase()), false, 'upper hex is invalid')

  // Only a human descartar.
  const dropped = key()
  const rd = (await store.add(report(dropped))).report
  await store.decide(rd.id, { decision: 'descartar', by: MOD })
  t.is(store.humanReversed(dropped), false, 'descartar')

  // A pending block alone is not a reversal.
  const unclaimed = key()
  const ru = (await store.add(report(unclaimed))).report
  const cu = (await store.decide(ru.id, { decision: 'bloquear', by: AI_ACTOR })).change
  t.is(store.humanReversed(unclaimed), false, 'a pending block')
  // Cancel of an unclaimed block.
  await store.cancel(cu.id, { by: MOD })
  t.is(store.humanReversed(unclaimed), true, 'cancel of an unclaimed block')

  // Cancel of a claimed block (a compensating unblock).
  const claimed = key()
  const rc = (await store.add(report(claimed))).report
  const cc = (await store.decide(rc.id, { decision: 'bloquear', by: AI_ACTOR })).change
  await store.pull()
  t.is(store.humanReversed(claimed), false, 'a claimed block')
  await store.cancel(cc.id, { by: MOD })
  t.is(store.humanReversed(claimed), true, 'cancel of a claimed block')

  // An AI cancel event does not count (the worker never cancels; simulated
  // here), as long as the member is blocked again.
  const byAi = key()
  const ra = (await store.add(report(byAi))).report
  const ca = (await store.decide(ra.id, { decision: 'bloquear', by: AI_ACTOR })).change
  await store.cancel(ca.id, { by: AI_ACTOR })
  const ra2 = (await store.add(report(byAi))).report
  await store.decide(ra2.id, { decision: 'bloquear', by: AI_ACTOR })
  t.ok(store.pending().changes.some((c) => c.member === byAi && c.op === 'block'))
  t.is(store.humanReversed(byAi), false, 'an ia cancel event')

  // A panel unblock of a published member, before and after its publish.
  const listed = key()
  const rl = (await store.add(report(listed))).report
  await store.decide(rl.id, { decision: 'bloquear', by: MOD })
  let all = await store.pull()
  await store.ack({ changeIds: all.changes.map((c) => c.id), snapshot: m.snap(1, [listed, byAi]), moderatorCert: m.cert })
  t.is(store.humanReversed(listed), false, 'published')
  await store.unblock(listed, { by: MOD })
  t.is(store.humanReversed(listed), true, 'a pending unblock')
  all = await store.pull()
  await store.ack({ changeIds: all.changes.map((c) => c.id), snapshot: m.snap(2, [byAi]), moderatorCert: m.cert })
  t.alike(store.pending().changes, [])
  t.is(store.humanReversed(listed), true, 'after the unblock is published')
  t.is(store.humanReversed(byAi), false, 'still published')

  // Blocked outside the panel (`mod block`: in the snapshot, no report), then
  // unblocked from the panel: still reversed after the unblock is acked.
  const outside = key()
  all = await store.pull()
  await store.ack({ changeIds: all.changes.map((c) => c.id), snapshot: m.snap(3, [byAi, outside]), moderatorCert: m.cert })
  t.is(store.humanReversed(outside), false, 'blocked outside the panel')
  await store.unblock(outside, { by: MOD })
  all = await store.pull()
  await store.ack({ changeIds: all.changes.map((c) => c.id), snapshot: m.snap(4, [byAi]), moderatorCert: m.cert })
  t.alike(store.pending().changes, [])
  t.is(store.humanReversed(outside), true, 'panel unblock of an outside block, after ack')
  // A human bloquear decision's own 'pedido' is not an unblock request.
  t.is(store.humanReversed(byAi), false, 'still not reversed')
})

test('cancel of an unclaimed change deletes it', async (t) => {
  const { store } = setup(t)
  const target = key()
  const r = (await store.add(report(target))).report
  const { change } = await store.decide(r.id, { decision: 'bloquear', by: MOD })
  const res = await store.cancel(change.id, { by: MOD })
  t.is(res.change, null)
  t.alike(store.pending().changes, [])
  await rejects(t, store.cancel(change.id, { by: MOD }), 'nao-encontrado', 'gone')
})

test('cancel of a claimed change a later one already reverses is ja-revertido (D6)', async (t) => {
  const { store } = setup(t)
  const target = key()
  const r = (await store.add(report(target))).report
  const { change: block } = await store.decide(r.id, { decision: 'bloquear', by: MOD })
  await store.pull() // the operator claims the block
  const { change: unblock } = await store.unblock(target, { by: MOD })
  t.ok(unblock, 'the unblock is a new pending change')
  await rejects(t, store.cancel(block.id, { by: MOD }), 'ja-revertido', 'the block is already undone by the unblock')
  t.is(store.pending().changes.length, 2, 'nothing recorded')
  // Cancelling the unblock leaves the block (never cancelled) in force.
  await store.cancel(unblock.id, { by: MOD })
  t.alike(store.pending().changes.map((c) => c.id), [block.id])
})

test('a killed write leaves the previous moderation.json readable', async (t) => {
  const { dir, store, open } = setup(t)
  const kept = (await store.add(report(key()))).report
  const before = fs.readFileSync(path.join(dir, FILE), 'utf8')
  const rename = fs.renameSync
  fs.renameSync = () => { throw Object.assign(new Error('killed'), { code: 'EIO' }) }
  try {
    await rejects(t, store.add(report(key())), 'EIO', 'write killed')
  } finally {
    fs.renameSync = rename
  }
  t.is(fs.readFileSync(path.join(dir, FILE), 'utf8'), before)
  t.is(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')).length, 0, 'temp file removed')
  t.is(store.stats().open, 1, 'memory follows the file')
  const reopened = open()
  t.is(reopened.get(kept.id).id, kept.id)
  t.ok((await store.add(report(key()))).report, 'still writable')
})

test('a malformed file disables every method and is never replaced', async (t) => {
  const dir = path.join(tmpDir(t), 'account')
  const m = moderation()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, FILE)
  fs.writeFileSync(file, '{ not json', { mode: 0o600 })
  const store = openModerationStore(dir, { now: () => T0, association: m.association })
  await rejects(t, store.add(report(key())), 'indisponivel', 'add')
  await rejects(t, store.ack({ changeIds: [], snapshot: m.snap(1), moderatorCert: m.cert }), 'indisponivel', 'ack')
  await rejects(t, store.pull(), 'indisponivel', 'pull')
  for (const name of ['list', 'pending', 'stats', 'blocked', 'exportRows', 'newestModeratorDate', 'humanReversed']) {
    throwsCode(t, () => store[name](), 'indisponivel', name)
  }
  t.is(fs.readFileSync(file, 'utf8'), '{ not json', 'untouched')

  // A published snapshot that does not verify is malformed too.
  const bad = { v: 1, reports: {}, pending: [], published: { snapshot: { ...m.snap(1), seq: 2 }, at: null, moderatorDate: '' }, events: [] }
  fs.writeFileSync(file, JSON.stringify(bad))
  const again = openModerationStore(dir, { now: () => T0, association: m.association })
  throwsCode(t, () => again.stats(), 'indisponivel', 'unverified mirror')
})

// A well-formed file with one report, one pending change and one event, so
// a single field can be broken at a time.
async function wellFormed (t) {
  const { dir, store, m } = setup(t)
  const r = (await store.add(report(key()))).report
  await store.decide(r.id, { decision: 'bloquear', by: MOD })
  const disk = onDisk(dir)
  t.is(disk.pending.length, 1)
  t.ok(disk.events.length >= 2)
  return { dir, m, disk, reportId: r.id }
}

async function opensUnavailable (t, dir, m, state, msg) {
  const file = path.join(dir, FILE)
  fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 })
  const bytes = fs.readFileSync(file)
  const store = openModerationStore(dir, { now: () => T0, association: m.association })
  throwsCode(t, () => store.stats(), 'indisponivel', msg + ': stats')
  await rejects(t, store.add(report(key())), 'indisponivel', msg + ': add')
  await rejects(t, store.unblock(key(), { by: MOD }), 'indisponivel', msg + ': unblock')
  await rejects(t, store.pull(), 'indisponivel', msg + ': pull')
  t.alike(fs.readFileSync(file), bytes, msg + ': file bytes unchanged')
}

test('strict open: a report missing its signature makes the store unavailable and the file is kept', async (t) => {
  const { dir, m, disk, reportId } = await wellFormed(t)
  const state = structuredClone(disk)
  delete state.reports[reportId].signature
  await opensUnavailable(t, dir, m, state, 'no signature')
})

test('strict open: every report field, change and event is checked, never filtered', async (t) => {
  const { dir, m, disk, reportId } = await wellFormed(t)
  const cases = [
    ['missing nonce', (s) => { delete s.reports[reportId].nonce }],
    ['missing reason', (s) => { delete s.reports[reportId].reason }],
    ['missing seq', (s) => { delete s.reports[reportId].seq }],
    ['missing writer', (s) => { delete s.reports[reportId].writer }],
    ['group without writer', (s) => { s.reports[reportId].group = key() }],
    ['writer without group', (s) => { s.reports[reportId].writer = key() }],
    ['v1 file with a v2 row', (s) => { s.v = 1 }],
    ['blocked on an open row', (s) => { s.reports[reportId].blocked = 'diario'; s.reports[reportId].status = 'aberta' }],
    ['unknown blocked kind', (s) => { s.reports[reportId].blocked = 'conta' }],
    ['grupo blocked without a group', (s) => { s.reports[reportId].blocked = 'grupo' }],
    ['bad reason', (s) => { s.reports[reportId].reason = 'outra' }],
    ['upper-case signature', (s) => { s.reports[reportId].signature = SIG.toUpperCase() }],
    ['extra report key', (s) => { s.reports[reportId].email = 'x' }],
    ['decided without decidedAt', (s) => { s.reports[reportId].decidedAt = null }],
    ['malformed event', (s) => { s.events.push({ at: 'ontem', by: MOD, action: 'bloquear' }) }],
    ['event with an unknown key', (s) => { s.events[0].reporter = key() }],
    ['event that is not an object', (s) => { s.events.push(null) }],
    ['change without claimedAt', (s) => { delete s.pending[0].claimedAt }],
    ['change naming an unknown report', (s) => { s.pending[0].reportIds = ['x'.repeat(22)] }],
    ['moderatorDate without a snapshot', (s) => { s.published.moderatorDate = '2026-10-01T00:00:00.000Z' }],
    ['extra top-level key', (s) => { s.audit = [] }]
  ]
  for (const [msg, breakIt] of cases) {
    const state = structuredClone(disk)
    breakIt(state)
    await opensUnavailable(t, dir, m, state, msg)
  }
  // The untouched file still opens.
  fs.writeFileSync(path.join(dir, FILE), JSON.stringify(disk), { mode: 0o600 })
  const store = openModerationStore(dir, { now: () => T0, association: m.association })
  t.is(store.stats().pending, 1)
})

// MAX_BLOCKED keys published, then each path that could raise the net
// blocked count above it is refused with 'lotado' without changing anything.
async function fullList (t) {
  const s = setup(t)
  const keys = []
  for (let i = 0; i < MAX_BLOCKED; i++) keys.push(key())
  await s.store.ack({ changeIds: [], snapshot: s.m.snap(1, keys), moderatorCert: s.m.cert })
  t.is(s.store.stats().blocked, MAX_BLOCKED)
  return { ...s, keys }
}

async function refusedUnchanged (t, s, p, msg) {
  const before = fs.readFileSync(path.join(s.dir, FILE), 'utf8')
  const pendingBefore = s.store.pending().changes
  await rejects(t, p, 'lotado', msg)
  t.is(fs.readFileSync(path.join(s.dir, FILE), 'utf8'), before, msg + ': nothing written')
  t.alike(s.store.pending().changes, pendingBefore, msg + ': pending unchanged')
}

test('capacity: a new block over MAX_BLOCKED is lotado', async (t) => {
  const s = await fullList(t)
  const r = (await s.store.add(report(key()))).report
  await refusedUnchanged(t, s, s.store.decide(r.id, { decision: 'bloquear', by: MOD }), 'append block')
  t.is(s.store.get(r.id).status, 'aberta', 'the report stays open')
})

test('capacity: cancelling an unclaimed unblock that would overflow is lotado', async (t) => {
  const s = await fullList(t)
  const a = s.keys[0]
  const u = await s.store.unblock(a, { by: MOD })
  const r = (await s.store.add(report(key()))).report
  t.ok((await s.store.decide(r.id, { decision: 'bloquear', by: MOD })).change, 'B fits in the freed slot')
  await refusedUnchanged(t, s, s.store.cancel(u.change.id, { by: MOD }), 'cancel unclaimed unblock')
})

test('capacity: a bloquear that deletes an unclaimed unblock and would overflow is lotado', async (t) => {
  const s = await fullList(t)
  const a = s.keys[0]
  await s.store.unblock(a, { by: MOD })
  const rb = (await s.store.add(report(key()))).report
  await s.store.decide(rb.id, { decision: 'bloquear', by: MOD })
  const ra = (await s.store.add(report(a))).report
  await refusedUnchanged(t, s, s.store.decide(ra.id, { decision: 'bloquear', by: MOD }), 'bloquear deletes unblock')
  t.is(s.store.get(ra.id).status, 'aberta', 'the report stays open')
})

test('capacity: compensating a claimed unblock that would overflow is lotado', async (t) => {
  const s = await fullList(t)
  const a = s.keys[0]
  const u = await s.store.unblock(a, { by: MOD })
  await s.store.pull()
  const r = (await s.store.add(report(key()))).report
  await s.store.decide(r.id, { decision: 'bloquear', by: MOD })
  await refusedUnchanged(t, s, s.store.cancel(u.change.id, { by: MOD }), 'compensate claimed unblock')
})

test('exportRows filters by member; events hold no signature, reporter or note', async (t) => {
  const { store, m, dir } = setup(t)
  const target = key()
  const reporters = [key(), key()]
  const a = (await store.add(report(target, reporters[0]))).report
  await store.add(report(key(), reporters[1]))
  const { change } = await store.decide(a.id, { decision: 'bloquear', by: MOD, note: 'nota secreta' })
  await store.pull()
  await store.ack({ changeIds: [change.id], snapshot: m.snap(1, [target]), moderatorCert: m.cert })
  await store.unblock(target, { by: MOD })
  t.is(store.exportRows().length, 2)
  const rows = store.exportRows({ member: target })
  t.is(rows.length, 1)
  t.is(rows[0].status, 'bloquear')
  t.is(rows[0].note, 'nota secreta')

  const events = onDisk(dir).events
  t.ok(events.length >= 4)
  const text = JSON.stringify(events)
  t.absent(/[0-9a-f]{128}/i.test(text), 'no 128-hex string')
  for (const r of reporters) t.absent(text.includes(r), 'no reporter key')
  t.absent(text.includes('nota secreta'), 'no note')
  t.absent(text.includes(NONCE), 'no nonce')
  for (const e of events) t.ok(e.by === MOD || e.by === 'operador', 'by is the moderator or the operator')
  t.alike(events.map((e) => e.action), ['bloquear', 'pedido', 'enviado', 'aplicado', 'pedido'])
})

function appeal (member, extra = {}) {
  return { member, text: 'foi um engano', signature: SIG, nonce: NONCE, ...extra }
}

// A member blocked by MOD, the block still pending.
async function blockedMember (store, by = MOD) {
  const target = key()
  const r = (await store.add(report(target))).report
  await store.decide(r.id, { decision: 'bloquear', by })
  return target
}

test('appeal: only a blocked member appeals; a retry of the open one answers the same row', async (t) => {
  const { store, dir, open } = setup(t)
  const free = key()
  await rejects(t, store.addAppeal(appeal(free)), 'nao-bloqueado', 'not blocked')
  const target = await blockedMember(store)
  const a = await store.addAppeal(appeal(target))
  t.is(a.duplicate, false)
  t.is(a.appeal.status, 'aberta')
  t.is(a.appeal.member, target)
  t.is(a.appeal.text, 'foi um engano')
  const again = await store.addAppeal(appeal(target, { text: 'outro texto', nonce: 'm'.repeat(43) }))
  t.is(again.duplicate, true)
  t.is(again.appeal.id, a.appeal.id)
  t.is(again.appeal.text, 'foi um engano', 'the first words stay')
  t.is(store.stats().appeals, 1)
  t.is(onDisk(dir).v, 3)
  t.alike(open().getAppeal(a.appeal.id), a.appeal, 'survives a reopen')
  t.is(store.getAppeal('nope'), null)
})

test('appeal: shape checks', async (t) => {
  const { store } = setup(t)
  const target = await blockedMember(store)
  const bad = [
    { member: 'zz' },
    { text: 'x'.repeat(1001) },
    { text: 'a\u0000b' },
    { text: 'lone \ud800' },
    { signature: 'zz' },
    { nonce: 'curto' }
  ]
  for (const extra of bad) await rejects(t, store.addAppeal(appeal(target, extra)), 'pedido-invalido', JSON.stringify(extra).slice(0, 30))
  t.is(store.stats().appeals, 0)
  const ok = await store.addAppeal(appeal(target, { text: '' }))
  t.is(ok.appeal.text, '', 'empty words are allowed')
})

test('appeal: one per member per 30 days, open or decided', async (t) => {
  const { store, c } = setup(t)
  const target = await blockedMember(store)
  const a = await store.addAppeal(appeal(target))
  await store.decideAppeal(a.appeal.id, { decision: 'negar', by: 'outro@example.test' })
  await rejects(t, store.addAppeal(appeal(target)), 'limite-recursos', 'same day')
  c.t += APPEAL_WINDOW_MS - HOUR
  await rejects(t, store.addAppeal(appeal(target)), 'limite-recursos', 'just inside the window')
  c.t += 2 * HOUR
  const next = await store.addAppeal(appeal(target))
  t.is(next.duplicate, false)
  t.not(next.appeal.id, a.appeal.id)
})

test('appeal: the window counts denied appeals only; a new block after an accepted one appeals at once', async (t) => {
  const { store } = setup(t)
  const target = await blockedMember(store)
  const a = await store.addAppeal(appeal(target))
  await store.decideAppeal(a.appeal.id, { decision: 'aceitar', by: 'outro@example.test' })
  await rejects(t, store.addAppeal(appeal(target)), 'nao-bloqueado', 'unblocked')
  const r = (await store.add(report(target))).report
  await store.decide(r.id, { decision: 'bloquear', by: MOD })
  const next = await store.addAppeal(appeal(target, { nonce: 'n'.repeat(43) }))
  t.is(next.duplicate, false, 'the accepted appeal ended its block')
  t.not(next.appeal.id, a.appeal.id)
})

test('appeal: an open appeal is closed when the key stops being blocked', async (t) => {
  const { store, dir } = setup(t)
  const target = await blockedMember(store)
  const a = await store.addAppeal(appeal(target))
  await store.unblock(target, { by: MOD })
  const closed = store.getAppeal(a.appeal.id)
  t.is(closed.status, 'encerrado')
  t.is(closed.decidedBy, MOD)
  t.is(store.stats().appeals, 0, 'nothing left waiting')
  t.is(onDisk(dir).events.filter((e) => e.action === 'recurso-encerrado').length, 1)
  await rejects(t, store.addAppeal(appeal(target)), 'nao-bloqueado', 'not blocked, not "already open"')
  const r = (await store.add(report(target))).report
  await store.decide(r.id, { decision: 'bloquear', by: MOD })
  const again = await store.addAppeal(appeal(target, { nonce: 'n'.repeat(43) }))
  t.is(again.duplicate, false, 'a new block gets its own appeal')
  t.not(again.appeal.id, a.appeal.id)
  t.alike(store.listAppeals({ status: 'decidida' }).appeals.map((x) => x.id), [a.appeal.id], 'closed ones list as decided')
})

test('appeal: cancelling the block and the operator dropping the key close the open appeal too', async (t) => {
  const { store, m } = setup(t)
  const pending = await blockedMember(store)
  const a = await store.addAppeal(appeal(pending))
  await store.cancel(store.pending().changes[0].id, { by: MOD })
  t.is(store.getAppeal(a.appeal.id).status, 'encerrado', 'pending block cancelled')

  const listed = key()
  await store.ack({ changeIds: [], snapshot: m.snap(1, [listed]), moderatorCert: m.cert })
  const b = await store.addAppeal(appeal(listed))
  await store.ack({ changeIds: [], snapshot: m.snap(2, []), moderatorCert: m.cert })
  const closed = store.getAppeal(b.appeal.id)
  t.is(closed.status, 'encerrado', 'dropped from the published list')
  t.is(closed.decidedBy, 'operador')
})

test('appeal: the desk is bounded', async (t) => {
  const { store, dir, m } = setup(t)
  const target = await blockedMember(store)
  const disk = onDisk(dir)
  for (let i = 0; i < MAX_APPEALS; i++) {
    const id = String(i).padStart(22, 'a')
    disk.appeals[id] = { id, at: new Date(T0).toISOString(), member: key(), text: '', nonce: NONCE, signature: SIG, status: 'aberta', decidedBy: null, decidedAt: null, note: '' }
  }
  fs.writeFileSync(path.join(dir, FILE), JSON.stringify(disk), { mode: 0o600 })
  const full = openModerationStore(dir, { now: () => T0, association: m.association })
  t.is(full.stats().appeals, MAX_APPEALS)
  await rejects(t, full.addAppeal(appeal(target)), 'limite', 'full')
})

test('appeal: aceitar of a pending block cancels it; of a published block appends an unblock', async (t) => {
  const { store, m } = setup(t)
  const pendingBlock = await blockedMember(store)
  const a = await store.addAppeal(appeal(pendingBlock))
  const accepted = await store.decideAppeal(a.appeal.id, { decision: 'aceitar', by: 'outro@example.test', note: 'conferi' })
  t.is(accepted.appeal.status, 'aceito')
  t.is(accepted.appeal.decidedBy, 'outro@example.test')
  t.is(accepted.appeal.note, 'conferi')
  t.is(accepted.change, null, 'net zero: the unclaimed block is dropped')
  t.is(store.pending().changes.length, 0)

  const listed = key()
  await store.ack({ changeIds: [], snapshot: m.snap(1, [listed]), moderatorCert: m.cert })
  const b = await store.addAppeal(appeal(listed))
  const res = await store.decideAppeal(b.appeal.id, { decision: 'aceitar', by: 'outro@example.test' })
  t.is(res.change.op, 'unblock')
  t.is(res.change.member, listed)
  t.alike(store.pending().changes.map((x) => [x.op, x.member]), [['unblock', listed]])
  t.is(store.stats().appeals, 0)
})

test('appeal: negar only closes the case', async (t) => {
  const { store } = setup(t)
  const target = await blockedMember(store)
  const pendingBefore = store.pending().changes
  const a = await store.addAppeal(appeal(target))
  const res = await store.decideAppeal(a.appeal.id, { decision: 'negar', by: 'outro@example.test', note: 'mantido' })
  t.is(res.appeal.status, 'negado')
  t.is(res.change, null)
  t.alike(store.pending().changes, pendingBefore)
  await rejects(t, store.decideAppeal(a.appeal.id, { decision: 'aceitar', by: MOD }), 'nao-encontrado', 'already decided')
  await rejects(t, store.decideAppeal('nope', { decision: 'aceitar', by: MOD }), 'nao-encontrado', 'unknown id')
})

test('appeal: decision shape checks change nothing', async (t) => {
  const { store, dir } = setup(t)
  const target = await blockedMember(store)
  const a = await store.addAppeal(appeal(target))
  const before = JSON.stringify(onDisk(dir))
  await rejects(t, store.decideAppeal(a.appeal.id, { decision: 'bloquear', by: MOD }), 'pedido-invalido', 'report decision')
  await rejects(t, store.decideAppeal(a.appeal.id, { decision: 'negar', by: '' }), 'pedido-invalido', 'empty by')
  await rejects(t, store.decideAppeal(a.appeal.id, { decision: 'negar', by: MOD, note: 'x'.repeat(NOTE_MAX + 1) }), 'pedido-invalido', 'long note')
  t.is(JSON.stringify(onDisk(dir)), before)
})

test('appeal: listAppeals orders, pages and hides the cases a moderator may not see', async (t) => {
  const { store, c } = setup(t)
  const mine = key()
  const first = await blockedMember(store, 'um@example.test')
  c.t += HOUR
  const second = await blockedMember(store, 'dois@example.test')
  c.t += HOUR
  const third = await blockedMember(store, 'um@example.test')
  const ids = []
  for (const member of [first, second, third]) {
    ids.push((await store.addAppeal(appeal(member))).appeal.id)
    c.t += HOUR
  }
  t.alike(store.listAppeals().appeals.map((a) => a.id), ids, 'open: oldest first')
  t.alike(store.listAppeals({ limit: 2 }).appeals.map((a) => a.id), ids.slice(0, 2))
  t.is(store.listAppeals({ limit: 2 }).truncated, true)
  t.alike(store.listAppeals({ exclude: second }).appeals.map((a) => a.id), [ids[0], ids[2]], 'own case')
  t.alike(store.listAppeals({ excludeBy: 'um@example.test' }).appeals.map((a) => a.id), [ids[1]], 'the blocker')
  t.alike(store.blockedBy(first), ['um@example.test'])
  t.alike(store.blockedBy(mine), [])
  t.is(store.listAppeals({ excludeBy: 'um@example.test', limit: 1 }).truncated, false, 'truncated counts only what is visible')
  await store.decideAppeal(ids[1], { decision: 'negar', by: 'um@example.test' })
  c.t += HOUR
  await store.decideAppeal(ids[0], { decision: 'negar', by: 'dois@example.test' })
  t.alike(store.listAppeals({ status: 'decidida' }).appeals.map((a) => a.id), [ids[0], ids[1]], 'decided: newest first')
  t.alike(store.listAppeals().appeals.map((a) => a.id), [ids[2]])
  throwsCode(t, () => store.listAppeals({ status: 'x' }), 'pedido-invalido', 'status')
  throwsCode(t, () => store.listAppeals({ limit: 0 }), 'pedido-invalido', 'limit')
})

test('appeal: the AI is not a person who blocked, and an accepted appeal counts as a human reversal', async (t) => {
  const { store } = setup(t)
  const target = await blockedMember(store, AI_ACTOR)
  t.alike(store.blockedBy(target), [], 'ai blocks name nobody')
  const a = await store.addAppeal(appeal(target))
  t.is(store.humanReversed(target), false)
  await store.decideAppeal(a.appeal.id, { decision: 'aceitar', by: MOD })
  t.is(store.humanReversed(target), true, 'the AI never re-blocks it')
})

test('appeal: events carry the appeal id, never its words, signature or nonce', async (t) => {
  const { store, dir } = setup(t)
  const target = await blockedMember(store)
  const a = await store.addAppeal(appeal(target, { text: 'palavras privadas' }))
  await store.decideAppeal(a.appeal.id, { decision: 'aceitar', by: 'outro@example.test', note: 'nota privada' })
  const events = onDisk(dir).events
  t.alike(events.map((e) => e.action), ['bloquear', 'pedido', 'recurso-aceito', 'cancelado'])
  const text = JSON.stringify(events)
  t.ok(text.includes(a.appeal.id))
  for (const secret of ['palavras privadas', 'nota privada', SIG, NONCE]) t.absent(text.includes(secret), 'no ' + secret.slice(0, 8))
})

test('appeal: v2 files read with no appeals; a malformed appeal row makes the store indisponivel', async (t) => {
  const { dir, m } = setup(t)
  const v2 = { v: 2, reports: {}, pending: [], published: { snapshot: null, at: null, moderatorDate: '' }, events: [] }
  fs.writeFileSync(path.join(dir, FILE), JSON.stringify(v2), { mode: 0o600 })
  const store = openModerationStore(dir, { now: () => T0, association: m.association })
  t.alike(store.listAppeals(), { appeals: [], truncated: false })
  const target = await blockedMember(store)
  await store.addAppeal(appeal(target))
  const disk = onDisk(dir)
  t.is(disk.v, 3)

  const [id, row] = Object.entries(disk.appeals)[0]
  const broken = [
    { ...row, status: 'ok' },
    { ...row, note: 'x' },
    { ...row, signature: 'zz' },
    { ...row, extra: 1 },
    { ...row, member: 'zz' },
    { ...row, id: 'x'.repeat(22) }
  ]
  for (const bad of broken) {
    fs.writeFileSync(path.join(dir, FILE), JSON.stringify({ ...disk, appeals: { [id]: bad } }), { mode: 0o600 })
    const reopened = openModerationStore(dir, { now: () => T0, association: m.association })
    throwsCode(t, () => reopened.listAppeals(), 'indisponivel', JSON.stringify(Object.keys(bad)))
  }
  fs.writeFileSync(path.join(dir, FILE), JSON.stringify({ ...disk, appeals: [] }), { mode: 0o600 })
  throwsCode(t, () => openModerationStore(dir, { now: () => T0, association: m.association }).listAppeals(), 'indisponivel', 'appeals not an object')
  const { appeals, ...noAppeals } = disk
  fs.writeFileSync(path.join(dir, FILE), JSON.stringify(noAppeals), { mode: 0o600 })
  throwsCode(t, () => openModerationStore(dir, { now: () => T0, association: m.association }).listAppeals(), 'indisponivel', 'v3 without appeals')
})
