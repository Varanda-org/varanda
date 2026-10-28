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
  AI_ACTOR
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
  t.is(disk.v, 1)
  t.alike(disk.pending, [])
  t.alike(disk.published, { snapshot: null, at: null, moderatorDate: '' })
  t.alike(store.stats(), { open: 0, pending: 0, blocked: 0, publishedSeq: null })
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
  t.alike(store.blocked(), [{ member: target, reportIds: [] }])
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
  t.alike(store.blocked(), [{ member: target, reportIds: [r.id] }])
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
  t.alike(store.stats(), { open: 0, pending: 0, blocked: 1, publishedSeq: 1 })
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
