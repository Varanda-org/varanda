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
  APPEAL_WINDOW_MS,
  OWNER_ACTOR
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

test('a listing report round-trips after a restart with the diary report keys', async (t) => {
  const { store, open } = setup(t)
  const target = key()
  const { report: r, duplicate } = await store.add(report(target, key(), { kind: 'listing', seq: 4, quote: 'bicicleta' }))
  t.is(duplicate, false)
  t.is(r.kind, 'listing')
  t.alike(Object.keys(r).sort(), ['at', 'blocked', 'decidedAt', 'decidedBy', 'group', 'id', 'kind', 'nonce', 'note', 'quote', 'reason', 'reporter', 'seq', 'signature', 'status', 'target', 'text', 'writer'])
  const reopened = open().get(r.id)
  t.is(reopened.kind, 'listing')
  t.is(reopened.seq, 4)
  t.is(reopened.writer, null)
  t.is(reopened.group, null)
  t.is(reopened.quote, 'bicicleta')
  await rejects(t, store.add(report(target, key(), { kind: 'listing', seq: null, quote: '' })), 'pedido-invalido', 'listing without seq')
  await rejects(t, store.add(report(target, key(), { kind: 'listing', writer: key(), group: key() })), 'pedido-invalido', 'listing with writer')
  await rejects(t, store.add(report(target, key(), { kind: 'post' })), 'pedido-invalido', 'an explicit kind other than listing')
})

test('dedupe key holds the kind: a post and a listing at one seq are distinct reports', async (t) => {
  const { store } = setup(t)
  const target = key()
  const reporter = key()
  const post = await store.add(report(target, reporter, { seq: 1 }))
  const listing = await store.add(report(target, reporter, { seq: 1, kind: 'listing' }))
  t.is(listing.duplicate, false)
  t.not(listing.report.id, post.report.id)
  const again = await store.add(report(target, reporter, { seq: 1, kind: 'listing' }))
  t.is(again.duplicate, true)
  t.is(again.report.id, listing.report.id)
  const postAgain = await store.add(report(target, reporter, { seq: 1 }))
  t.is(postAgain.report.id, post.report.id)
})

test('a listing row on disk loads; one with a writer, an anexo or no seq is refused and the file kept', async (t) => {
  const mutations = [
    (r) => ({ ...r, seq: null, quote: '' }),
    (r) => ({ ...r, writer: key(), group: key() }),
    (r) => ({ ...r, anexo: { mime: 'image/png', size: 1, sha256: 'ab'.repeat(32) } }),
    (r) => ({ ...r, kind: 'anuncio' })
  ]
  for (const mutate of mutations) {
    const { dir, store, open } = setup(t)
    const { report: r } = await store.add(report(key(), key(), { kind: 'listing' }))
    t.is(open().get(r.id).kind, 'listing', 'the written file loads')
    const disk = onDisk(dir)
    disk.reports[r.id] = mutate(disk.reports[r.id])
    const bytes = JSON.stringify(disk)
    fs.writeFileSync(path.join(dir, FILE), bytes)
    const bad = open()
    throwsCode(t, () => bad.list(), 'indisponivel', 'store refuses the row')
    await rejects(t, bad.add(report(key())), 'indisponivel', 'add refused')
    t.is(fs.readFileSync(path.join(dir, FILE), 'utf8'), bytes, 'never rewritten')
  }
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
  for (let i = 0; i < MAX_BLOCKED; i++) keys.push(b4a.toString(crypto.randomBytes(32), 'hex'))
  await s.store.ack({ changeIds: [], snapshot: s.m.snap(1, keys), moderatorCert: s.m.cert })
  t.is(s.store.stats().blocked, MAX_BLOCKED)
  return { ...s, keys }
}

test('capacity: the mirror holds MAX_BLOCKED (16384) keys and reopens from disk', async (t) => {
  t.is(MAX_BLOCKED, 16384)
  const s = await fullList(t)
  t.is(s.open().stats().blocked, MAX_BLOCKED, 'moderation.json read back whole')
})

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

test('isBlocked and reportIdsAbout follow every change, a reopened store included', async (t) => {
  const { store, m, open } = setup(t)
  const target = key()
  const other = key()
  t.absent(store.isBlocked(target))
  t.alike(store.reportIdsAbout(target), [])
  const a = (await store.add(report(target))).report
  t.alike(store.reportIdsAbout(target), [a.id], 'a new report is seen at once')
  const b = (await store.add(report(target))).report
  await store.add(report(other))
  t.alike(store.reportIdsAbout(target).sort(), [a.id, b.id].sort())
  const { change } = await store.decide(a.id, { decision: 'bloquear', by: MOD })
  t.absent(store.isBlocked(target), 'a pending block is not published yet')
  await store.pull()
  await store.ack({ changeIds: [change.id], snapshot: m.snap(1, [target]), moderatorCert: m.cert })
  t.ok(store.isBlocked(target), 'published')
  t.absent(store.isBlocked(other))
  const u = await store.unblock(target, { by: MOD })
  await store.pull()
  await store.ack({ changeIds: [u.change.id], snapshot: m.snap(2, []), moderatorCert: m.cert })
  t.absent(store.isBlocked(target), 'the unblock is seen at once')
  const again = open()
  t.alike(again.reportIdsAbout(target).sort(), [a.id, b.id].sort())
  for (const k of [target, other]) t.is(store.isBlocked(k), store.blocked().some((x) => x.member === k), 'same answer as blocked()')
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

test('appeal: the 30 days run from the denial, not from the sending', async (t) => {
  const { store, c } = setup(t)
  const target = await blockedMember(store)
  const a = await store.addAppeal(appeal(target))
  c.t += 25 * 24 * HOUR
  await store.decideAppeal(a.appeal.id, { decision: 'negar', by: 'outro@example.test' })
  c.t += 6 * 24 * HOUR
  await rejects(t, store.addAppeal(appeal(target)), 'limite-recursos', 'day 31 of the sending is day 6 after the denial')
  c.t += 25 * 24 * HOUR
  t.is((await store.addAppeal(appeal(target))).duplicate, false, 'past 30 days after the denial')
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

function dmReport (target, reporter = key(), extra = {}) {
  return { reporter, target, reason: 'assedio', text: '', quote: 'mensagem ruim', signature: SIG, nonce: NONCE, ...extra }
}

test('a dm report is stored with its own keys: target and quote, no seq, writer or group', async (t) => {
  const { dir, store, open } = setup(t)
  const target = key()
  const reporter = key()
  const { report: r, duplicate } = await store.addDm(dmReport(target, reporter))
  t.is(duplicate, false)
  t.is(r.kind, 'dm')
  t.is(r.target, target)
  t.is(r.quote, 'mensagem ruim')
  t.alike(Object.keys(r).sort(), ['at', 'blocked', 'decidedAt', 'decidedBy', 'id', 'kind', 'nonce', 'note', 'quote', 'reason', 'reporter', 'signature', 'status', 'target', 'text'])
  t.is(onDisk(dir).reports[r.id].seq, undefined)
  const again = await store.addDm(dmReport(target, reporter))
  t.is(again.duplicate, true, 'same open quote by the same reporter')
  t.is(again.report.id, r.id)
  t.is(open().get(r.id).kind, 'dm', 'reopens')
})

test('addDm refuses a missing or own target and an empty quote', async (t) => {
  const { store } = setup(t)
  const reporter = key()
  await rejects(t, store.addDm(dmReport(undefined, reporter)), 'pedido-invalido', 'no target')
  await rejects(t, store.addDm(dmReport(reporter, reporter)), 'pedido-invalido', 'own target')
  await rejects(t, store.addDm(dmReport(key(), reporter, { quote: '' })), 'pedido-invalido', 'empty quote')
  await rejects(t, store.addDm(dmReport(key(), reporter, { reason: 'x' })), 'pedido-invalido', 'reason')
})

test('dm reports share the per-reporter daily budget', async (t) => {
  const { store } = setup(t)
  const reporter = key()
  for (let i = 0; i < MAX_PER_REPORTER_DAY - 1; i++) await store.add(report(key(), reporter))
  await store.addDm(dmReport(key(), reporter))
  await rejects(t, store.addDm(dmReport(key(), reporter, { quote: 'outra' })), 'limite-denuncias', 'dm over the cap')
  await rejects(t, store.add(report(key(), reporter)), 'limite-denuncias', 'post over the cap')
})

test('a dm row on disk with seq, writer or group, without target or with target === reporter is invalid', async (t) => {
  const mutations = [
    (r) => ({ ...r, seq: null }),
    (r) => ({ ...r, writer: null, group: null }),
    (r) => { const o = { ...r }; delete o.target; return o },
    (r) => ({ ...r, target: r.reporter }),
    (r) => ({ ...r, quote: '' })
  ]
  for (const mutate of mutations) {
    const { dir, store, open } = setup(t)
    const { report: r } = await store.addDm(dmReport(key()))
    const disk = onDisk(dir)
    disk.reports[r.id] = mutate(disk.reports[r.id])
    fs.writeFileSync(path.join(dir, FILE), JSON.stringify(disk))
    throwsCode(t, () => open().list(), 'indisponivel', 'store refuses the row')
  }
})

test('bloquear on a dm report blocks the target like an account report; grupo is refused', async (t) => {
  const { store } = setup(t)
  const target = key()
  const { report: r } = await store.addDm(dmReport(target))
  await rejects(t, store.decide(r.id, { decision: 'bloquear', by: MOD, block: 'grupo' }), 'pedido-invalido', 'no group')
  const { report: decided, change } = await store.decide(r.id, { decision: 'bloquear', by: MOD })
  t.is(decided.blocked, 'diario')
  t.is(change.member, target)
  t.is(change.op, 'block')
  t.alike(change.reportIds, [r.id])
})

test('a group report again with an image is a new report; the same image again is a duplicate', async (t) => {
  const { store } = setup(t)
  const target = key()
  const reporter = key()
  const writer = key()
  const group = key()
  const bytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3])
  const sha256 = require('node:crypto').createHash('sha256').update(bytes).digest('hex')
  const plain = await store.add(report(target, reporter, { writer, group, quote: '' }))
  t.is(plain.duplicate, false)
  const withImage = await store.add(report(target, reporter, { writer, group, quote: '', anexo: { bytes, mime: 'image/gif', sha256 } }))
  t.is(withImage.duplicate, false, 'the image is new evidence, not a repeat')
  t.not(withImage.report.id, plain.report.id)
  const again = await store.add(report(target, reporter, { writer, group, quote: '', anexo: { bytes, mime: 'image/gif', sha256 } }))
  t.is(again.duplicate, true)
  t.is(again.report.id, withImage.report.id)
})

test('the anexo file is written whole even when writeSync writes in pieces', async (t) => {
  const { store, dir } = setup(t)
  const bytes = new Uint8Array(4096).map((_, i) => i & 0xff)
  const sha256 = require('node:crypto').createHash('sha256').update(bytes).digest('hex')
  const realWrite = fs.writeSync
  fs.writeSync = (fd, buf, off = 0, len = buf.length - off, pos) => realWrite(fd, buf, off, Math.min(len, 1000), pos)
  let res
  try {
    res = await store.add(report(key(), key(), { writer: key(), group: key(), quote: '', anexo: { bytes, mime: 'image/gif', sha256 } }))
  } finally {
    fs.writeSync = realWrite
  }
  const file = path.join(dir, 'report-media', res.report.id)
  t.alike(new Uint8Array(fs.readFileSync(file)), bytes, 'every byte landed')
})

test('a failed sync of the media directory takes the anexo file back', async (t) => {
  const { store, dir } = setup(t)
  const bytes = new Uint8Array([1, 2, 3, 4])
  const sha256 = require('node:crypto').createHash('sha256').update(bytes).digest('hex')
  const mediaDir = path.join(dir, 'report-media')
  const realOpen = fs.openSync
  let armed = true
  fs.openSync = (p, ...rest) => {
    if (armed && p === mediaDir) {
      armed = false
      const err = new Error('io')
      err.code = 'EIO'
      throw err
    }
    return realOpen(p, ...rest)
  }
  try {
    await rejects(t, store.add(report(key(), key(), { writer: key(), group: key(), quote: '', anexo: { bytes, mime: 'image/gif', sha256 } })), 'EIO', 'the add fails')
  } finally {
    fs.openSync = realOpen
  }
  const left = fs.existsSync(mediaDir) ? fs.readdirSync(mediaDir) : []
  t.alike(left, [], 'no orphan file outside the cap')
})

test('requestDeletion queues a titular block the panel cannot cancel; pull marks it titular', async (t) => {
  const { store } = setup(t)
  const ana = key()
  const r = await store.requestDeletion(ana)
  t.is(r.kind, 'novo')
  t.is(r.change.op, 'block')
  t.is(r.change.by, OWNER_ACTOR)
  t.alike(r.change.reportIds, [])
  const again = await store.requestDeletion(ana)
  t.alike(again, { change: null, kind: 'igual' }, 'already pending: nothing new')
  try {
    await store.cancel(r.change.id, { by: MOD })
    t.fail('cancelled')
  } catch (err) {
    t.is(err.code, 'conta-excluida', 'the panel cannot cancel a deletion')
  }
  const pulled = await store.pull()
  t.alike(pulled.changes, [{ id: r.change.id, op: 'block', member: ana, at: r.change.at, actor: 'titular' }])
  try {
    await store.cancel(r.change.id, { by: MOD })
    t.fail('compensated')
  } catch (err) {
    t.is(err.code, 'conta-excluida', 'nor compensate it once claimed')
  }
  t.is(store.pending().changes.length, 1)
})

test('requestDeletion over a moderator block still pending pins its own titular block', async (t) => {
  const { store } = setup(t)
  const target = key()
  const { report: row } = await store.add(report(target))
  await store.decide(row.id, { decision: 'bloquear', by: MOD })
  const r = await store.requestDeletion(target)
  t.is(r.kind, 'novo')
  t.is(r.change.by, OWNER_ACTOR, 'the owner block joins the pending one')
  const changes = store.pending().changes
  t.is(changes.length, 2)
  t.alike(await store.requestDeletion(target), { change: null, kind: 'igual' }, 'idempotent')
  // A moderator cancelling the earlier block leaves the owner's.
  const earlier = changes.find((c) => c.by === MOD)
  await store.cancel(earlier.id, { by: MOD })
  t.alike(store.pending().changes.map((c) => c.by), [OWNER_ACTOR])
  try {
    await store.unblock(target, { by: MOD })
    t.fail('unblocked')
  } catch (err) {
    t.is(err.code, 'conta-excluida', 'unblock cannot drop the owner block')
  }
  const pulled = await store.pull()
  t.alike(pulled.changes.map((c) => c.actor), ['titular'], 'mod apply --yes sees a person-requested block')
})

test('requestDeletion over an AI block pins a titular block, so mod apply --yes signs it', async (t) => {
  const { store } = setup(t)
  const target = key()
  const { report: row } = await store.add(report(target))
  await store.decide(row.id, { decision: 'bloquear', by: AI_ACTOR })
  await store.requestDeletion(target)
  const pulled = await store.pull()
  t.alike(pulled.changes.map((c) => c.actor), ['ia', 'titular'])
})

test('requestDeletion of a key already in the published list adds nothing', async (t) => {
  const { store, m } = setup(t)
  const target = key()
  const { report: row } = await store.add(report(target))
  const { change } = await store.decide(row.id, { decision: 'bloquear', by: MOD })
  await store.pull()
  await store.ack({ changeIds: [change.id], snapshot: m.snap(1, [target]), moderatorCert: m.cert })
  t.alike(await store.requestDeletion(target), { change: null, kind: 'igual' })
  t.is(store.pending().changes.length, 0)
})

test('appeal: an Excluir conta block pending is not appealable and an open appeal cannot undo it', async (t) => {
  const { store } = setup(t)
  const target = await blockedMember(store)
  const a = await store.addAppeal(appeal(target))
  await store.requestDeletion(target)
  await rejects(t, store.decideAppeal(a.appeal.id, { decision: 'aceitar', by: 'outra@example.test' }), 'conta-excluida', 'accepting would drop the deletion')
  t.is(store.getAppeal(a.appeal.id).status, 'aberta', 'still open')
  const denied = await store.decideAppeal(a.appeal.id, { decision: 'negar', by: 'outra@example.test' })
  t.is(denied.appeal.status, 'negado', 'denying touches no change')
  t.ok(store.pending().changes.some((c) => c.member === target && c.by === OWNER_ACTOR))
  const other = key()
  await store.requestDeletion(other)
  await rejects(t, store.addAppeal(appeal(other)), 'conta-excluida', 'no appeal over the owner own request')
})

test('reopen: refuses an unknown id, an open report, a human decision and the AI or owner as actor', async (t) => {
  const { dir, store } = setup(t)
  const open = (await store.add(report(key()))).report
  const human = (await store.add(report(key()))).report
  await store.decide(human.id, { decision: 'descartar', by: MOD })
  const ai = (await store.add(report(key()))).report
  await store.decide(ai.id, { decision: 'descartar', by: AI_ACTOR })
  const before = fs.readFileSync(path.join(dir, FILE), 'utf8')
  await rejects(t, store.reopen('A'.repeat(22), { by: MOD }), 'nao-encontrado', 'unknown id')
  await rejects(t, store.reopen(42, { by: MOD }), 'nao-encontrado', 'not a string')
  await rejects(t, store.reopen(open.id, { by: MOD }), 'ja-revertido', 'an open report')
  await rejects(t, store.reopen(human.id, { by: MOD }), 'sem-permissao', 'a person decided it')
  await rejects(t, store.reopen(ai.id, { by: AI_ACTOR }), 'pedido-invalido', 'the AI never reopens')
  await rejects(t, store.reopen(ai.id, { by: OWNER_ACTOR }), 'pedido-invalido', 'nor the owner actor')
  await rejects(t, store.reopen(ai.id, {}), 'pedido-invalido', 'no actor')
  await rejects(t, store.reopen(ai.id, { by: 'a\nb' }), 'pedido-invalido', 'a dirty actor')
  t.is(fs.readFileSync(path.join(dir, FILE), 'utf8'), before, 'no refusal writes')
  t.is(store.get(ai.id).status, 'descartar')
})

test('reopen: an AI discard goes back to the open queue with its decision cleared and a reaberto event', async (t) => {
  const { dir, store, c, open } = setup(t)
  const r = (await store.add(report(key()))).report
  await store.decide(r.id, { decision: 'descartar', by: AI_ACTOR, note: 'parecido com casos descartados' })
  c.t += HOUR
  const { report: back } = await store.reopen(r.id, { by: MOD })
  t.is(back.status, 'aberta')
  t.is(back.decidedBy, null)
  t.is(back.decidedAt, null)
  t.is(back.note, '')
  t.is(back.blocked, null)
  t.alike(store.list({ status: 'aberta' }).reports.map((x) => x.id), [r.id], 'listed as open again')
  t.is(store.list({ status: 'decidida' }).reports.length, 0)
  const last = onDisk(dir).events.at(-1)
  t.alike(last, { at: new Date(T0 + HOUR).toISOString(), by: MOD, action: 'reaberto', reportId: r.id })
  t.alike(store.reopenedIds(), [r.id])
  await rejects(t, store.reopen(r.id, { by: 'outra@example.test' }), 'ja-revertido', 'a second reopen')
  const again = open()
  t.is(again.get(r.id).status, 'aberta', 'the reopened row survives a restart')
  t.alike(again.reopenedIds(), [r.id])
  t.alike(again.get(r.id).reopened, { at: new Date(T0 + HOUR).toISOString(), action: 'descartar', decidedAt: new Date(T0).toISOString() }, 'the marker names the undone AI decision')
})

test('reopen: the marker keeps the AI off once the reaberto event aged out', async (t) => {
  const { dir, store, m, c } = setup(t)
  const r = (await store.add(report(key()))).report
  await store.decide(r.id, { decision: 'bloquear', by: AI_ACTOR })
  c.t += HOUR
  await store.reopen(r.id, { by: MOD })
  // Every event about the row gone, as when MAX_EVENTS splices them.
  const disk = onDisk(dir)
  disk.events = disk.events.filter((e) => e.reportId !== r.id)
  fs.writeFileSync(path.join(dir, FILE), JSON.stringify(disk), { mode: 0o600 })
  const later = openModerationStore(dir, { now: c.now, association: m.association })
  t.alike(later.reopenedIds(), [r.id], 'still listed as reopened')
  await rejects(t, later.decide(r.id, { decision: 'bloquear', by: AI_ACTOR }), 'nao-encontrado', 'the AI is refused')
  t.is(later.get(r.id).status, 'aberta')
  const { report: done } = await later.decide(r.id, { decision: 'descartar', by: MOD })
  t.alike(done.reopened, later.get(r.id).reopened, 'a person decision keeps the marker')
  t.is(done.reopened.action, 'bloquear')
  const again = openModerationStore(dir, { now: c.now, association: m.association })
  t.is(again.get(r.id).reopened.action, 'bloquear', 'the marker survives a restart')
})

test('reopen: a malformed reopened marker makes the store unavailable', async (t) => {
  const { dir, store, m } = setup(t)
  const r = (await store.add(report(key()))).report
  await store.decide(r.id, { decision: 'descartar', by: AI_ACTOR })
  await store.reopen(r.id, { by: MOD })
  const disk = onDisk(dir)
  const row = disk.reports[r.id]
  const at = row.reopened.at
  const broken = [
    { ...row, reopened: null },
    { ...row, reopened: { at, action: 'descartar' } },
    { ...row, reopened: { ...row.reopened, extra: 1 } },
    { ...row, reopened: { ...row.reopened, action: 'aberta' } },
    { ...row, reopened: { ...row.reopened, at: 'ontem' } },
    { ...row, reopened: { ...row.reopened, decidedAt: null } },
    { ...row, status: 'bloquear', decidedBy: AI_ACTOR, decidedAt: at, blocked: 'diario' }
  ]
  for (const bad of broken) {
    fs.writeFileSync(path.join(dir, FILE), JSON.stringify({ ...disk, reports: { [r.id]: bad } }), { mode: 0o600 })
    const reopened = openModerationStore(dir, { now: () => T0, association: m.association })
    throwsCode(t, () => reopened.get(r.id), 'indisponivel', JSON.stringify(bad.reopened) + ' ' + bad.decidedBy)
  }
  fs.writeFileSync(path.join(dir, FILE), JSON.stringify({ ...disk, reports: { [r.id]: { ...row, status: 'descartar', decidedBy: MOD, decidedAt: at } } }), { mode: 0o600 })
  t.is(openModerationStore(dir, { now: () => T0, association: m.association }).get(r.id).decidedBy, MOD, 'a person decision on a reopened row is valid')
})

test('reopen: an AI block stays blocked, nothing is cancelled, published or pulled differently', async (t) => {
  const { store, m } = setup(t)
  const target = key()
  const r = (await store.add(report(target))).report
  const { change } = await store.decide(r.id, { decision: 'bloquear', by: AI_ACTOR })
  const pendingBefore = store.pending()
  await store.reopen(r.id, { by: MOD })
  t.alike(store.pending(), pendingBefore, 'the AI block change is still pending, untouched')
  const pulled = await store.pull()
  t.alike(pulled.changes, [{ id: change.id, op: 'block', member: target, at: change.at, actor: 'ia' }], 'pull is unchanged')
  await store.ack({ changeIds: [change.id], snapshot: m.snap(1, [target]), moderatorCert: m.cert })
  t.ok(store.blocked().some((b) => b.member === target), 'still blocked once published')
  // A published AI block, reopened: still in the list, nothing pending.
  const other = key()
  const r2 = (await store.add(report(other))).report
  const c2 = (await store.decide(r2.id, { decision: 'bloquear', by: AI_ACTOR })).change
  await store.pull()
  await store.ack({ changeIds: [c2.id], snapshot: m.snap(2, [target, other]), moderatorCert: m.cert })
  await store.reopen(r2.id, { by: MOD })
  t.is(store.pending().changes.length, 0, 'no unblock was queued')
  t.ok(store.blocked().some((b) => b.member === other), 'the published block stands')
})

test('reopen: the AI can no longer decide the reopened report; a person can', async (t) => {
  const { store } = setup(t)
  const r = (await store.add(report(key()))).report
  await store.decide(r.id, { decision: 'descartar', by: AI_ACTOR })
  await store.reopen(r.id, { by: MOD })
  await rejects(t, store.decide(r.id, { decision: 'bloquear', by: AI_ACTOR }), 'nao-encontrado', 'the AI is refused')
  t.is(store.get(r.id).status, 'aberta')
  t.is(store.pending().changes.length, 0, 'no block was queued')
  if (store.get(r.id).status !== 'aberta') return
  const { report: done } = await store.decide(r.id, { decision: 'descartar', by: MOD })
  t.is(done.decidedBy, MOD)
  await rejects(t, store.reopen(r.id, { by: MOD }), 'sem-permissao', 'a person decision is final here')
})

test('reopen: a person blocking a reopened AI block report never lists it twice in the change', async (t) => {
  const { store, open } = setup(t)
  const target = key()
  const r = (await store.add(report(target))).report
  const { change } = await store.decide(r.id, { decision: 'bloquear', by: AI_ACTOR })
  await store.reopen(r.id, { by: MOD })
  const res = await store.decide(r.id, { decision: 'bloquear', by: MOD })
  t.alike(res.change.reportIds, [r.id], 'the unclaimed change keeps the id once')
  const again = open()
  t.alike(again.pending().changes.map((x) => [x.id, x.reportIds]), [[change.id, [r.id]]], 'the store reloads usable')
  t.is(again.get(r.id).status, 'bloquear')

  // Claimed by the operator first: the change is left as pulled.
  const other = key()
  const r2 = (await store.add(report(other))).report
  const c2 = (await store.decide(r2.id, { decision: 'bloquear', by: AI_ACTOR })).change
  await store.pull()
  await store.reopen(r2.id, { by: MOD })
  const res2 = await store.decide(r2.id, { decision: 'bloquear', by: MOD })
  t.is(res2.change, null, 'a claimed change is not joined')
  const later = open()
  t.alike(later.pending().changes.find((x) => x.id === c2.id).reportIds, [r2.id], 'the claimed change keeps the id once')
})

test('reopen: humanReversed remembers a reopened AI block a person later undid, once its events aged out', async (t) => {
  const { dir, store, m, c } = setup(t)
  const target = key()
  const r = (await store.add(report(target))).report
  const { change } = await store.decide(r.id, { decision: 'bloquear', by: AI_ACTOR })
  await store.pull()
  await store.ack({ changeIds: [change.id], snapshot: m.snap(1, [target]), moderatorCert: m.cert })
  await store.reopen(r.id, { by: MOD })
  await store.decide(r.id, { decision: 'descartar', by: MOD })
  t.is(store.humanReversed(target), false, 'still published')
  await store.unblock(target, { by: MOD })
  const all = await store.pull()
  await store.ack({ changeIds: all.changes.map((x) => x.id), snapshot: m.snap(2, []), moderatorCert: m.cert })
  t.alike(store.pending().changes, [])
  // Every event about the member and the row gone, as when MAX_EVENTS splices them.
  const disk = onDisk(dir)
  disk.events = disk.events.filter((e) => e.member !== target && e.reportId !== r.id)
  fs.writeFileSync(path.join(dir, FILE), JSON.stringify(disk), { mode: 0o600 })
  const later = openModerationStore(dir, { now: c.now, association: m.association })
  t.is(later.get(r.id).status, 'descartar')
  t.is(later.humanReversed(target), true, 'the reopened AI block row still counts')
})

test('held: published and pending blocks count, a pending unblock does not lift, an owner deletion block counts', async (t) => {
  const { store, m } = setup(t)
  const target = key()
  const leaver = key()
  t.absent(store.held(target), 'nothing at all')
  t.absent(store.held('nope'), 'an invalid member is false')
  const { report: row } = await store.add(report(target))
  const { change } = await store.decide(row.id, { decision: 'bloquear', by: MOD })
  t.ok(store.held(target), 'a pending moderator block holds')
  await store.ack({ changeIds: [change.id], snapshot: m.snap(1, [target]), moderatorCert: m.cert })
  t.ok(store.held(target), 'published')
  const u = await store.unblock(target, { by: MOD })
  t.ok(store.held(target), 'a pending unblock does not let go: it may still be cancelled')
  await store.ack({ changeIds: [u.change.id], snapshot: m.snap(2, []), moderatorCert: m.cert })
  t.absent(store.held(target), 'unblocked')

  const del = await store.requestDeletion(target)
  t.ok(store.held(target), 'the owner block, pending, holds')
  await store.requestDeletion(leaver)
  t.ok(store.held(leaver), 'so does one with no report behind it')
  // Once published, the owner block is in the snapshot like any other.
  await store.ack({ changeIds: [del.change.id], snapshot: m.snap(3, [target]), moderatorCert: m.cert })
  t.ok(store.held(target), 'a published key is held whoever asked')
  t.is(store.pending().changes.length, 1, 'read-only: nothing else changed')
})

test('held: a lift waiting next to the claimed block it lifts still holds, and lets go once both publish', async (t) => {
  const { store, m } = setup(t)
  const target = key()
  const { report: row } = await store.add(report(target))
  const { change } = await store.decide(row.id, { decision: 'bloquear', by: MOD })
  await store.pull()
  const lift = await store.unblock(target, { by: MOD })
  t.is(lift.change.op, 'unblock', 'appended: the block is claimed')
  t.ok(store.held(target), 'still held while both wait')
  await store.ack({ changeIds: [change.id], snapshot: m.snap(1, [target]), moderatorCert: m.cert })
  t.ok(store.held(target), 'the block published, the lift still waits')
  await store.ack({ changeIds: [lift.change.id], snapshot: m.snap(2, []), moderatorCert: m.cert })
  t.absent(store.held(target), 'both published')
})

test('blockReportsAfter: counts the bloquear reports decided at or after since, all of them with null', async (t) => {
  const { store, c } = setup(t)
  const target = key()
  const other = key()
  t.is(store.blockReportsAfter(target, null), 0)
  const a = (await store.add(report(target))).report
  const b = (await store.add(report(target))).report
  const d = (await store.add(report(target))).report
  const o = (await store.add(report(other))).report
  await store.decide(a.id, { decision: 'bloquear', by: MOD })
  c.t += HOUR
  const mid = new Date(c.t).toISOString()
  c.t += 1000
  await store.decide(b.id, { decision: 'bloquear', by: AI_ACTOR })
  await store.decide(d.id, { decision: 'descartar', by: MOD })
  await store.decide(o.id, { decision: 'bloquear', by: MOD })
  t.is(store.blockReportsAfter(target, null), 2, 'descartar and another member do not count')
  t.is(store.blockReportsAfter(target, mid), 1, 'only the one decided after since')
  t.is(store.blockReportsAfter(target, new Date(c.t).toISOString()), 1, 'decided at since counts')
  t.is(store.blockReportsAfter(target, new Date(c.t + 1).toISOString()), 0, 'decided before since does not')
  t.is(store.blockReportsAfter('nope', null), 0)
  t.exception.all(() => store.blockReportsAfter(target, '2026-10-24'), TypeError)
  t.exception.all(() => store.blockReportsAfter(target, undefined), TypeError)
  await store.reopen(b.id, { by: MOD })
  t.is(store.blockReportsAfter(target, mid), 0, 'a report a person reopened no longer counts')
})

const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3])
function gif () {
  return { bytes: GIF, mime: 'image/gif', sha256: require('node:crypto').createHash('sha256').update(GIF).digest('hex') }
}

// Every pending change acked into snapshot `seq` listing `blocked`.
async function applyAll (store, m, seq, blocked) {
  const pulled = await store.pull()
  await store.ack({ changeIds: pulled.changes.map((x) => x.id), snapshot: m.snap(seq, blocked), moderatorCert: m.cert })
}

test('forgetDeleted: reports about the member, its appeals, events and anexos go; a report it filed against a key still blocked is stripped', async (t) => {
  const { dir, store, m, c, open } = setup(t)
  const D = key()
  const [T1, T2, T3, T4, Y, Z, W, G2, G3] = [key(), key(), key(), key(), key(), key(), key(), key(), key()]
  const aboutDiary = (await store.add(report(D, key(), { seq: null, quote: '' }))).report
  const aboutPost = (await store.add(report(D))).report
  const aboutImage = (await store.add(report(D, key(), { writer: W, group: G2, quote: '', anexo: gif() }))).report
  const groupBlock = (await store.add(report(D, key(), { writer: W, group: G2 }))).report
  const filedBlocked = (await store.addDm({ reporter: D, target: T1, reason: 'assedio', text: 'me ameaçou', quote: 'vou te achar', signature: SIG, nonce: NONCE, anexo: gif() })).report
  const filedDiscarded = (await store.add(report(T2, D))).report
  const filedUnblocked = (await store.add(report(T3, D))).report
  const filedOpen = (await store.add(report(T4, D))).report
  const filedGroup = (await store.add(report(Y, D, { writer: key(), group: G3 }))).report
  const other = (await store.add(report(Z))).report
  await store.decide(aboutPost.id, { decision: 'bloquear', by: MOD })
  await store.decide(groupBlock.id, { decision: 'bloquear', by: MOD, block: 'grupo' })
  await store.decide(filedBlocked.id, { decision: 'bloquear', by: MOD, note: 'ameaça' })
  await store.decide(filedDiscarded.id, { decision: 'descartar', by: MOD })
  await store.decide(filedUnblocked.id, { decision: 'bloquear', by: MOD })
  await store.decide(filedGroup.id, { decision: 'bloquear', by: MOD, block: 'grupo' })
  await applyAll(store, m, 1, [D, G2, T1, T3, G3])
  await store.unblock(T3, { by: MOD })
  await applyAll(store, m, 2, [D, G2, T1, G3])
  const appealOf = (await store.addAppeal(appeal(D))).appeal
  const appealT1 = (await store.addAppeal(appeal(T1))).appeal
  // A change still waiting for the operator, about someone else.
  await store.decide(other.id, { decision: 'bloquear', by: MOD })
  const media = path.join(dir, 'report-media')
  t.ok(fs.existsSync(path.join(media, aboutImage.id)))
  const before = onDisk(dir)
  t.ok(before.events.some((e) => e.member === D), 'events name the member before')

  t.is(store.holdsDeleted(D), true)
  t.is(store.holdsDeleted(key()), false, 'a key the desk holds nothing about')
  c.t += 180 * 24 * HOUR
  const res = await store.forgetDeleted(D)
  t.alike({ ...res, events: res.events > 0 }, { stale: false, reports: 4, stripped: 2, records: 2, appeals: 1, events: true, deferred: 0, kept: 1, files: 1, filesLeft: 0 })

  for (const r of [aboutDiary, aboutPost, aboutImage, filedOpen]) t.is(store.get(r.id), null, 'gone: ' + r.id)
  for (const r of [filedDiscarded, filedUnblocked]) {
    const row = store.get(r.id)
    t.alike([row.reporter, row.text, row.quote, row.status], [null, '', '', r === filedDiscarded ? 'descartar' : 'bloquear'], 'a record: ' + r.id)
  }
  t.ok(store.get(groupBlock.id) !== null, 'a group block about the member stands')
  t.ok(store.get(other.id) !== null)
  t.is(store.getAppeal(appealOf.id), null)
  t.ok(store.getAppeal(appealT1.id) !== null)
  t.absent(fs.existsSync(path.join(media, aboutImage.id)), 'the anexo of a removed row is gone')
  t.ok(fs.existsSync(path.join(media, filedBlocked.id)), 'the stripped row keeps its anexo')

  const stripped = store.get(filedBlocked.id)
  t.is(stripped.reporter, null)
  t.is(stripped.text, '')
  t.is(stripped.nonce, null)
  t.is(stripped.signature, null)
  t.is(stripped.stripped, '2027-04-01T00:00:00.000Z', 'the month of the sweep, not its instant')
  t.absent(Object.hasOwn(onDisk(dir), 'forgetMedia'), 'the files are gone, and so is the list')
  t.alike([stripped.target, stripped.reason, stripped.quote, stripped.status, stripped.decidedBy, stripped.note, stripped.blocked], [T1, 'assedio', 'vou te achar', 'bloquear', MOD, 'ameaça', 'diario'])
  t.ok(store.anexoOf(filedBlocked.id) !== null, 'the anexo still reads')
  t.is(store.get(filedGroup.id).reporter, null, 'a group block the member filed is stripped too')
  t.ok(store.list({ status: 'decidida' }).reports.some((r) => r.id === filedBlocked.id), 'listed without a reporter')
  t.alike(store.blocked().find((b) => b.member === T1).reportIds, [filedBlocked.id], 'the block still rests on it')
  t.alike(store.exportRows({ member: T1 }).map((r) => r.reporter), [null])

  const after = onDisk(dir)
  t.is(JSON.stringify(after.published), JSON.stringify(before.published), 'the published snapshot is untouched')
  t.is(JSON.stringify(after.pending), JSON.stringify(before.pending), 'pending changes are untouched')
  const gone = new Set([aboutDiary.id, aboutPost.id, aboutImage.id, filedOpen.id])
  t.absent(after.events.some((e) => e.member === D || gone.has(e.reportId) || e.appealId === appealOf.id), 'no event names the member or a removed row')
  t.ok(after.events.some((e) => e.reportId === filedBlocked.id), 'the decision of a stripped row stays')

  const bytes = fs.readFileSync(path.join(dir, FILE))
  t.is(store.holdsDeleted(D), false, 'nothing left to do')
  const again = await store.forgetDeleted(D)
  t.alike(again, { stale: false, reports: 0, stripped: 0, records: 0, appeals: 0, events: 0, deferred: 0, kept: 1, files: 0, filesLeft: 0 })
  t.alike(fs.readFileSync(path.join(dir, FILE)), bytes, 'a second call writes nothing')

  const reopened = open()
  t.alike(reopened.get(filedBlocked.id), stripped, 'a stripped row reads back')
  // The reporter budget never counts a stripped row.
  t.is((await reopened.add(report(key(), D))).duplicate, false)
})

// Rows filed less than a day ago wait (the daily reporter budget counts them).
function aged (c) {
  c.t += 25 * HOUR
}

test('forgetDeleted: a row a pending change names waits for the ack, and holds the other rows about the member', async (t) => {
  const { dir, store, m, c } = setup(t)
  const D = key()
  // An older, unnamed, dismissed row about the same member.
  const other = (await store.add(report(D, key(), { seq: 7 }))).report
  await store.decide(other.id, { decision: 'descartar', by: MOD })
  const r = (await store.add(report(D))).report
  await store.decide(r.id, { decision: 'bloquear', by: MOD })
  aged(c)
  const events = onDisk(dir).events
  t.ok(events.some((e) => e.member === D))
  t.ok(events.some((e) => e.reportId === other.id), 'the dismissed row has its event')
  t.is(store.holdsDeleted(D), false, 'only deferred rows, whose events stay: no work')
  const first = await store.forgetDeleted(D)
  t.is(first.deferred, 2)
  t.is(first.reports, 0)
  t.is(first.events, 0)
  t.ok(store.get(r.id) !== null)
  t.ok(store.get(other.id) !== null, 'the unnamed row about the member waits with it')
  t.alike(onDisk(dir).events, events, 'humanReversed still reads the events about the member in order')
  await applyAll(store, m, 1, [D])
  t.is(store.holdsDeleted(D), true)
  t.is((await store.forgetDeleted(D)).reports, 2)
  t.is(store.get(r.id), null)
  t.is(store.get(other.id), null, 'after the ack the unnamed row goes too')
  t.absent(onDisk(dir).events.some((e) => e.member === D || e.reportId === other.id || e.reportId === r.id), 'after the ack the events go with the rows')
  t.alike(store.blocked().map((b) => b.member), [D], 'the key stays on the list')
})

test('forgetDeleted: a deferred row keeps the events about the member while its appeal goes in the same call', async (t) => {
  const { dir, store, open, c } = setup(t)
  const D = key()
  const r = (await store.add(report(D))).report
  await store.decide(r.id, { decision: 'bloquear', by: MOD })
  const ap = (await store.addAppeal(appeal(D))).appeal
  aged(c)
  const res = await store.forgetDeleted(D)
  t.alike([res.deferred, res.appeals, res.reports, res.events], [1, 1, 0, 0])
  t.is(store.getAppeal(ap.id), null, 'the appeal goes now')
  t.ok(store.get(r.id) !== null, 'the named row waits')
  t.ok(onDisk(dir).events.some((e) => e.member === D), 'the events about the member wait with it')
  t.ok(open().get(r.id) !== null, 'the file reads back')
})

test('forgetDeleted: a row is about the member through its target only, never its group writer', async (t) => {
  const { dir, store, m, c } = setup(t)
  const D = key()
  const T = key()
  const r = (await store.add(report(T, key(), { writer: D, group: key(), quote: '', anexo: gif() }))).report
  await store.decide(r.id, { decision: 'bloquear', by: MOD })
  await applyAll(store, m, 1, [T])
  // An open report of a live, unblocked author whose writer key is D.
  const open = (await store.add(report(key(), key(), { writer: D, group: key() }))).report
  aged(c)
  const before = onDisk(dir)
  t.is(store.holdsDeleted(D), false, 'a writer key names no member')
  const res = await store.forgetDeleted(D)
  t.alike([res.reports, res.stripped, res.records, res.files], [0, 0, 0, 0])
  t.ok(store.get(r.id) !== null, 'the row stays')
  t.ok(store.get(open.id) !== null, 'an open row stays too')
  t.is(store.get(r.id).reporter, before.reports[r.id].reporter)
  t.ok(fs.existsSync(path.join(dir, 'report-media', r.id)), 'its anexo stays')
  t.alike(onDisk(dir).events, before.events, 'its events stay')
})

test('forgetDeleted: a group block about the member stays while the group is published or a pending change blocks it; a cancelled unblock finds it', async (t) => {
  const { dir, store, m, c } = setup(t)
  const D = key()
  const G = key()
  const r = (await store.add(report(D, key(), { writer: key(), group: G, quote: '', anexo: gif() }))).report
  await store.decide(r.id, { decision: 'bloquear', by: MOD, block: 'grupo' })
  aged(c)
  t.is((await store.forgetDeleted(D)).kept, 1, 'a pending block blocks the group')
  await applyAll(store, m, 1, [G])
  t.is((await store.forgetDeleted(D)).kept, 1)
  const { change } = await store.unblock(G, { by: MOD })
  const events = onDisk(dir).events
  t.is(store.holdsDeleted(D), false, 'a pending unblock leaves it: the group is still published')
  t.is((await store.forgetDeleted(D)).kept, 1)
  await store.cancel(change.id, { by: MOD })
  t.ok(store.get(r.id) !== null, 'the cancel finds the row')
  t.ok(fs.existsSync(path.join(dir, 'report-media', r.id)), 'and its anexo')
  t.ok(onDisk(dir).events.length >= events.length && events.every((e) => onDisk(dir).events.some((x) => JSON.stringify(x) === JSON.stringify(e))), 'and its events')
  t.alike(store.blocked().find((b) => b.member === G).reportIds, [r.id])
  await store.unblock(G, { by: MOD })
  await applyAll(store, m, 2, [])
  const res = await store.forgetDeleted(D)
  t.alike([res.kept, res.reports, res.files], [0, 1, 1])
  t.is(store.get(r.id), null, 'the group is no longer blocked: the row goes')
})

test('forgetDeleted: a kept row whose reporter is due too is stripped, whatever the order of the members', async (t) => {
  for (const order of [0, 1]) {
    const { store, m, c } = setup(t)
    const [A, B, GA, GB] = [key(), key(), key(), key()]
    const ra = (await store.add(report(A, B, { writer: key(), group: GA }))).report
    const rb = (await store.add(report(B, A, { writer: key(), group: GB }))).report
    await store.decide(ra.id, { decision: 'bloquear', by: MOD, block: 'grupo' })
    await store.decide(rb.id, { decision: 'bloquear', by: MOD, block: 'grupo' })
    await applyAll(store, m, 1, [GA, GB])
    aged(c)
    const res = await store.forgetDeleted(order === 0 ? [A, B] : [B, A])
    t.alike([res.kept, res.stripped, res.reports], [2, 2, 0], 'order ' + order)
    for (const r of [ra, rb]) {
      const row = store.get(r.id)
      t.alike([row.reporter, row.text, row.nonce, row.signature, row.status], [null, '', null, null, 'bloquear'])
    }
    t.is(store.holdsDeleted([A, B]), false, 'a second pass has nothing to do')
  }
})

test('forgetDeleted: a decided report the member filed about a live target becomes a record; decidedBefore still sees it', async (t) => {
  const { dir, store, c, open } = setup(t)
  const D = key()
  const T = key()
  const dismissed = (await store.add(report(T, D, { seq: 7 }))).report
  await store.decide(dismissed.id, { decision: 'descartar', by: MOD, note: 'não é spam' })
  aged(c)
  const res = await store.forgetDeleted(D)
  t.alike([res.records, res.reports, res.stripped], [1, 0, 0])
  const row = store.get(dismissed.id)
  t.alike([row.reporter, row.text, row.quote, row.nonce, row.signature], [null, '', '', null, null], 'no content left')
  t.alike([row.target, row.seq, row.kind, row.status, row.decidedBy, row.note, row.reason], [T, 7, 'post', 'descartar', MOD, 'não é spam', 'spam'])
  t.ok(onDisk(dir).events.some((e) => e.reportId === dismissed.id), 'its decision event stays')
  // As ai/worker.js decidedBefore reads it.
  const fresh = (await store.add(report(T, key(), { seq: 7 }))).report
  t.ok(store.exportRows({ member: T }).some((r) => r.id !== fresh.id && r.kind === 'post' && r.writer === null && r.seq === 7 && r.status !== 'aberta'), 'a new report of that post is an appeal')
  t.alike(open().get(dismissed.id), row, 'a record reads back')
  t.is(store.holdsDeleted(D), false)
})

test('forgetDeleted: a block the member filed whose key is no longer blocked becomes a record, without its anexo; humanReversed still holds', async (t) => {
  const { dir, store, m, c, open } = setup(t)
  const D = key()
  const T = key()
  const r = (await store.addDm({ reporter: D, target: T, reason: 'assedio', text: 'x', quote: 'y', signature: SIG, nonce: NONCE, anexo: gif() })).report
  await store.decide(r.id, { decision: 'bloquear', by: MOD })
  await applyAll(store, m, 1, [T])
  // The operator's own unblock: no panel change or event, so only the row
  // itself (a block whose key is no longer listed) answers humanReversed.
  await store.ack({ changeIds: [], snapshot: m.snap(2, []), moderatorCert: m.cert })
  aged(c)
  t.is(store.humanReversed(T), true)
  const res = await store.forgetDeleted(D)
  t.alike([res.records, res.files], [1, 1])
  const row = store.get(r.id)
  t.alike([row.reporter, row.quote, row.status, Object.hasOwn(row, 'anexo')], [null, '', 'bloquear', false])
  t.absent(fs.existsSync(path.join(dir, 'report-media', r.id)), 'the anexo file is gone')
  t.is(store.anexoOf(r.id), null)
  t.is(store.humanReversed(T), true, 'the undone block is still remembered')
  t.ok(onDisk(dir).events.some((e) => e.reportId === r.id), 'its decision event stays')
  t.alike(open().get(r.id), row, 'a dm record reads back')
})

test('forgetDeleted: a stripped row becomes a record once its key is no longer blocked, never on a pending unblock', async (t) => {
  const { dir, store, m, c, open } = setup(t)
  const D = key()
  const T = key()
  const r = (await store.addDm({ reporter: D, target: T, reason: 'assedio', text: 'x', quote: 'y', signature: SIG, nonce: NONCE, anexo: gif() })).report
  await store.decide(r.id, { decision: 'bloquear', by: MOD })
  await applyAll(store, m, 1, [T])
  aged(c)
  t.is((await store.forgetDeleted(D)).stripped, 1)
  const file = path.join(dir, 'report-media', r.id)
  const stripped = store.get(r.id)
  t.is(stripped.quote, 'y')
  t.ok(fs.existsSync(file))
  t.is(store.holdsDeleted(key()), false, 'its key is still blocked')
  const { change } = await store.unblock(T, { by: MOD })
  const events = onDisk(dir).events
  t.is(store.holdsDeleted(key()), false, 'a pending unblock leaves it')
  await store.forgetDeleted(key())
  await store.cancel(change.id, { by: MOD })
  t.alike(store.get(r.id), stripped, 'the cancel finds the row as it was')
  t.ok(fs.existsSync(file), 'and its anexo')
  t.ok(events.every((e) => onDisk(dir).events.some((x) => JSON.stringify(x) === JSON.stringify(e))), 'and its events')
  await store.unblock(T, { by: MOD })
  await applyAll(store, m, 2, [])
  // Any due member's pass finds it: the row no longer names its reporter.
  t.is(store.holdsDeleted(key()), true)
  const res = await store.forgetDeleted(key())
  t.alike([res.records, res.reports, res.files], [1, 0, 1])
  const row = store.get(r.id)
  t.alike([row.quote, Object.hasOwn(row, 'anexo'), row.stripped], ['', false, stripped.stripped])
  t.absent(fs.existsSync(file), 'the anexo goes')
  t.ok(onDisk(dir).events.some((e) => e.reportId === r.id), 'its decision event stays')
  t.is(store.holdsDeleted(key()), false)
  t.alike(open().get(r.id), row, 'a dm record reads back')
})

test('forgetDeleted: a row filed less than a day ago waits, so the daily reporter budget holds', async (t) => {
  const { store, c } = setup(t)
  const D = key()
  const R = key()
  for (let i = 0; i < MAX_PER_REPORTER_DAY; i++) await store.add(report(D, R, { seq: i + 1 }))
  c.t += 23 * HOUR
  t.is(store.holdsDeleted(D), false)
  t.is((await store.forgetDeleted(D)).reports, 0)
  await rejects(t, store.add(report(key(), R)), 'limite-denuncias', 'the budget still counts them')
  c.t += 2 * HOUR
  t.is((await store.forgetDeleted(D)).reports, MAX_PER_REPORTER_DAY)
})

test('forgetDeleted: several members in one write', async (t) => {
  const { dir, store, c } = setup(t)
  const [A, B] = [key(), key()]
  const ra = (await store.add(report(A))).report
  const rb = (await store.add(report(B))).report
  aged(c)
  const writes = []
  const real = fs.renameSync
  fs.renameSync = function (from, to) {
    if (to === path.join(dir, FILE)) writes.push(to)
    return real.apply(this, arguments)
  }
  t.teardown(() => { fs.renameSync = real })
  t.is(store.holdsDeleted([A, B]), true)
  t.is((await store.forgetDeleted([A, B])).reports, 2)
  fs.renameSync = real
  t.is(writes.length, 1, 'one persisted write')
  t.is(store.get(ra.id), null)
  t.is(store.get(rb.id), null)
  throwsCode(t, () => store.holdsDeleted([]), 'pedido-invalido', 'holdsDeleted: empty list')
  throwsCode(t, () => store.holdsDeleted([A, 'x']), 'pedido-invalido', 'holdsDeleted: a bad key')
  await rejects(t, store.forgetDeleted([]), 'pedido-invalido', 'empty list')
  await rejects(t, store.forgetDeleted([A, 'x']), 'pedido-invalido', 'a bad key')
})

test('forgetDeleted: a write since the caller read revision() makes it stale, with nothing written', async (t) => {
  const { dir, store, m, c } = setup(t)
  const D = key()
  const r = (await store.add(report(D))).report
  aged(c)
  const seen = store.revision()
  const other = (await store.add(report(key()))).report
  t.ok(store.revision() > seen)
  const bytes = fs.readFileSync(path.join(dir, FILE))
  t.alike(await store.forgetDeleted(D, { revision: seen }), { stale: true, reports: 0, stripped: 0, records: 0, appeals: 0, events: 0, deferred: 0, kept: 0, files: 0, filesLeft: 0 })
  t.alike(fs.readFileSync(path.join(dir, FILE)), bytes, 'nothing written')
  const beforeDecide = store.revision()
  await store.decide(other.id, { decision: 'bloquear', by: MOD })
  t.is((await store.forgetDeleted(D, { revision: beforeDecide })).stale, true, 'a decision landed since')
  const beforeAck = store.revision()
  await applyAll(store, m, 1, [other.target])
  t.is((await store.forgetDeleted(D, { revision: beforeAck })).stale, true, 'an ack landed since')
  const res = await store.forgetDeleted(D, { revision: store.revision() })
  t.alike([res.stale, res.reports], [false, 1])
  t.is(store.get(r.id), null)
})

test('reopen: a stripped row cannot reopen (an open report needs its reporter)', async (t) => {
  const { dir, store, m, c } = setup(t)
  const D = key()
  const T = key()
  const r = (await store.add(report(T, D))).report
  await store.decide(r.id, { decision: 'bloquear', by: AI_ACTOR })
  await applyAll(store, m, 1, [T])
  aged(c)
  await store.forgetDeleted(D)
  const bytes = fs.readFileSync(path.join(dir, FILE))
  await rejects(t, store.reopen(r.id, { by: MOD }), 'sem-permissao', 'refused')
  t.alike(fs.readFileSync(path.join(dir, FILE)), bytes, 'nothing written')
  t.is(store.get(r.id).status, 'bloquear')
})

test('forgetDeleted: an anexo whose unlink failed after the write is listed on disk and removed by the next call', async (t) => {
  const { dir, store, open, c } = setup(t)
  const D = key()
  const r = (await store.add(report(D, key(), { writer: key(), group: key(), quote: '', anexo: gif() }))).report
  aged(c)
  const file = path.join(dir, 'report-media', r.id)
  const real = fs.unlinkSync
  let failures = 0
  fs.unlinkSync = function (target) {
    if (target === file && failures === 0) {
      failures++
      const err = new Error('EIO')
      err.code = 'EIO'
      throw err
    }
    return real.apply(this, arguments)
  }
  t.teardown(() => { fs.unlinkSync = real })
  const res = await store.forgetDeleted(D)
  fs.unlinkSync = real
  t.alike([res.reports, res.files, res.filesLeft], [1, 0, 1])
  t.ok(fs.existsSync(file), 'the unlink failed')
  t.alike(onDisk(dir).forgetMedia, [r.id], 'the file is listed on disk')
  // As after a restart.
  const later = open()
  t.is(later.get(r.id), null)
  t.is(later.holdsDeleted(D), true, 'the listed file is work')
  t.alike(await later.forgetDeleted(D), { stale: false, reports: 0, stripped: 0, records: 0, appeals: 0, events: 0, deferred: 0, kept: 0, files: 1, filesLeft: 0 })
  t.absent(fs.existsSync(file))
  t.absent(Object.hasOwn(onDisk(dir), 'forgetMedia'), 'the list is cleared')
  t.is(later.holdsDeleted(D), false)
  const disk = onDisk(dir)
  for (const [name, list] of [['a bad id', ['x']], ['a repeat', [r.id, r.id]], ['not a list', r.id]]) {
    fs.writeFileSync(path.join(dir, FILE), JSON.stringify({ ...disk, forgetMedia: list }), { mode: 0o600 })
    throwsCode(t, () => open().stats(), 'indisponivel', 'refused: ' + name)
  }
})

test('forgetDeleted: a listed file already gone (a crash before the clearing write) clears from the list', async (t) => {
  const { dir, store, open, c } = setup(t)
  const D = key()
  const r = (await store.add(report(D, key(), { writer: key(), group: key(), quote: '', anexo: gif() }))).report
  aged(c)
  const file = path.join(dir, 'report-media', r.id)
  const real = fs.unlinkSync
  fs.unlinkSync = function (target) {
    if (target === file) {
      const err = new Error('EIO')
      err.code = 'EIO'
      throw err
    }
    return real.apply(this, arguments)
  }
  try {
    await store.forgetDeleted(D)
  } finally {
    fs.unlinkSync = real
  }
  t.alike(onDisk(dir).forgetMedia, [r.id])
  // The unlink landed, the clearing write did not.
  fs.unlinkSync(file)
  const later = open()
  t.is(later.holdsDeleted(D), true, 'the listed id is work')
  const res = await later.forgetDeleted(D)
  t.alike([res.files, res.filesLeft], [0, 0], 'nothing to unlink, nothing left')
  t.absent(Object.hasOwn(onDisk(dir), 'forgetMedia'), 'the list is cleared')
  t.is(later.holdsDeleted(D), false)
})

test('forgetDeleted: a failed sync of report-media after the unlinks keeps the list for the next pass', async (t) => {
  const { dir, store, c } = setup(t)
  const D = key()
  const r = (await store.add(report(D, key(), { writer: key(), group: key(), quote: '', anexo: gif() }))).report
  aged(c)
  const mediaDir = path.join(dir, 'report-media')
  const file = path.join(mediaDir, r.id)
  const realOpen = fs.openSync
  let armed = false
  fs.openSync = function (p) {
    if (armed && p === mediaDir) {
      armed = false
      const err = new Error('EIO')
      err.code = 'EIO'
      throw err
    }
    return realOpen.apply(this, arguments)
  }
  const realUnlink = fs.unlinkSync
  fs.unlinkSync = function (target) {
    if (target === file) armed = true
    return realUnlink.apply(this, arguments)
  }
  t.teardown(() => { fs.openSync = realOpen; fs.unlinkSync = realUnlink })
  const res = await store.forgetDeleted(D)
  fs.openSync = realOpen
  fs.unlinkSync = realUnlink
  t.is(res.reports, 1)
  t.absent(fs.existsSync(file), 'the unlink ran')
  t.alike(onDisk(dir).forgetMedia, [r.id], 'an unsynced unlink keeps the id listed')
  t.is(res.filesLeft, 1)
  t.is(store.holdsDeleted(D), true)
  const again = await store.forgetDeleted(D)
  t.is(again.filesLeft, 0)
  t.absent(Object.hasOwn(onDisk(dir), 'forgetMedia'), 'the next pass syncs and clears it')
})

test('forgetDeleted: a missing or older moderation.json never deletes a file in report-media', async (t) => {
  const { dir, m, c, open } = setup(t)
  const media = path.join(dir, 'report-media')
  fs.mkdirSync(media, { recursive: true, mode: 0o700 })
  const stray = path.join(media, 'a'.repeat(22))
  fs.writeFileSync(stray, GIF, { mode: 0o600 })
  // Missing: the store starts empty over files it does not know.
  fs.rmSync(path.join(dir, FILE))
  const fresh = open()
  t.is(fresh.holdsDeleted(key()), false, 'no work')
  t.is((await fresh.forgetDeleted(key())).files, 0)
  t.ok(fs.existsSync(stray), 'the file stays')
  // Older: a valid file that never held the row.
  const r = (await fresh.add(report(key(), key(), { writer: key(), group: key(), quote: '', anexo: gif() }))).report
  const withRow = onDisk(dir)
  const older = { ...withRow, reports: {} }
  fs.writeFileSync(path.join(dir, FILE), JSON.stringify(older), { mode: 0o600 })
  const back = openModerationStore(dir, { now: c.now, association: m.association })
  aged(c)
  t.is((await back.forgetDeleted(key())).files, 0)
  t.ok(fs.existsSync(path.join(media, r.id)), 'a row the file lost keeps its anexo')
  t.ok(fs.existsSync(stray))
  // A listed id whose row holds an anexo keeps that file.
  fs.writeFileSync(path.join(dir, FILE), JSON.stringify({ ...withRow, forgetMedia: [r.id] }), { mode: 0o600 })
  const listed = open()
  t.is(listed.holdsDeleted(key()), true)
  t.is((await listed.forgetDeleted(key())).files, 0)
  t.ok(fs.existsSync(path.join(media, r.id)), 'the row still holds it')
  t.absent(Object.hasOwn(onDisk(dir), 'forgetMedia'), 'and the list is cleared')
})

test('forgetDeleted: a stripped row is dated by the month of the sweep', async (t) => {
  const { store, m, c } = setup(t)
  const D = key()
  const T = key()
  const r = (await store.add(report(T, D))).report
  await store.decide(r.id, { decision: 'bloquear', by: MOD })
  await applyAll(store, m, 1, [T])
  c.t = Date.parse('2027-01-31T23:59:59.999Z')
  await store.forgetDeleted(D)
  t.is(store.get(r.id).stripped, '2027-01-01T00:00:00.000Z')
})

test('forgetDeleted: a pending unblock behind a claimed block keeps the evidence, named or not', async (t) => {
  const { dir, store, c } = setup(t)
  const D = key()
  const T = key()
  const dm = () => ({ reporter: D, target: T, reason: 'assedio', text: 'x', quote: 'y', signature: SIG, nonce: NONCE, anexo: gif() })
  const named = (await store.addDm(dm())).report
  const unnamed = (await store.addDm({ ...dm(), quote: 'z' })).report
  const G = key()
  const owner = key()
  const groupNamed = (await store.add(report(owner, key(), { writer: key(), group: G, quote: '', anexo: gif() }))).report
  const groupUnnamed = (await store.add(report(owner, key(), { writer: key(), group: G, seq: 4, quote: '', anexo: gif() }))).report
  await store.decide(named.id, { decision: 'bloquear', by: MOD })
  await store.decide(groupNamed.id, { decision: 'bloquear', by: MOD, block: 'grupo' })
  await store.pull()
  // After the claim the key is already net blocked: no change names these.
  await store.decide(unnamed.id, { decision: 'bloquear', by: MOD })
  await store.decide(groupUnnamed.id, { decision: 'bloquear', by: MOD, block: 'grupo' })
  t.alike(store.pending().changes.map((x) => x.reportIds.length), [1, 1])
  const unblockT = (await store.unblock(T, { by: MOD })).change
  const unblockG = (await store.unblock(G, { by: MOD })).change
  aged(c)
  const res = await store.forgetDeleted([D, owner])
  t.alike([res.stripped, res.records, res.reports, res.kept], [2, 0, 0, 2])
  await store.cancel(unblockT.id, { by: MOD })
  await store.cancel(unblockG.id, { by: MOD })
  for (const [r, quote] of [[named, 'y'], [unnamed, 'z']]) {
    const row = store.get(r.id)
    t.alike([row.reporter, row.quote, row.status], [null, quote, 'bloquear'], 'stripped, quote kept: ' + quote)
    t.ok(store.anexoOf(r.id) !== null, 'its anexo reads')
    t.ok(fs.existsSync(path.join(dir, 'report-media', r.id)), 'its file stays')
  }
  for (const r of [groupNamed, groupUnnamed]) {
    t.ok(store.get(r.id) !== null, 'the group row stays')
    t.ok(store.anexoOf(r.id) !== null, 'with its anexo')
  }
})

test('forgetDeleted: a dismissed row the member filed that a pending block still names waits as it is', async (t) => {
  const { store, m, c } = setup(t)
  const D = key()
  const T = key()
  const r = (await store.addDm({ reporter: D, target: T, reason: 'assedio', text: 'x', quote: 'y', signature: SIG, nonce: NONCE, anexo: gif() })).report
  await store.decide(r.id, { decision: 'bloquear', by: AI_ACTOR })
  await store.reopen(r.id, { by: MOD })
  await store.decide(r.id, { decision: 'descartar', by: MOD })
  t.alike(store.pending().changes[0].reportIds, [r.id], 'the AI block still names it')
  aged(c)
  const before = store.get(r.id)
  const res = await store.forgetDeleted(D)
  t.alike([res.deferred, res.records, res.stripped], [1, 0, 0])
  t.alike(store.get(r.id), before, 'untouched')
  await applyAll(store, m, 1, [T])
  t.is((await store.forgetDeleted(D)).records, 1, 'after the ack it becomes a record')
})

test('forgetDeleted: a stripped row, or a block of a due reporter, that a pending change names keeps its content', async (t) => {
  const { dir, store, m, c, open } = setup(t)
  const [D, T, D2, T2] = [key(), key(), key(), key()]
  const dm = (reporter, target) => ({ reporter, target, reason: 'assedio', text: 'x', quote: 'y', signature: SIG, nonce: NONCE, anexo: gif() })
  const r = (await store.addDm(dm(D, T))).report
  const r2 = (await store.addDm(dm(D2, T2))).report
  await store.decide(r.id, { decision: 'bloquear', by: MOD })
  await store.decide(r2.id, { decision: 'bloquear', by: MOD })
  await applyAll(store, m, 1, [T, T2])
  aged(c)
  await store.forgetDeleted(D)
  await store.ack({ changeIds: [], snapshot: m.snap(2, []), moderatorCert: m.cert })
  // A change naming both rows without blocking their keys.
  const disk = onDisk(dir)
  disk.pending.push({ id: 'c'.repeat(22), op: 'unblock', member: key(), by: MOD, at: new Date(c.t).toISOString(), reportIds: [r.id, r2.id], claimedAt: null })
  fs.writeFileSync(path.join(dir, FILE), JSON.stringify(disk), { mode: 0o600 })
  const later = open()
  const before = later.get(r.id)
  const res = await later.forgetDeleted([key(), D2])
  t.alike([res.records, res.stripped], [0, 1])
  t.alike(later.get(r.id), before, 'the stripped row keeps quote and anexo')
  const row = later.get(r2.id)
  t.alike([row.reporter, row.quote, row.status], [null, 'y', 'bloquear'], 'the named block is stripped, not made a record')
  t.ok(later.anexoOf(r2.id) !== null, 'with its anexo')
})

test('forgetDeleted: a recent row about the member waits alone, with its own events', async (t) => {
  const { dir, store, m, c } = setup(t)
  const D = key()
  const old = (await store.add(report(D))).report
  await store.decide(old.id, { decision: 'bloquear', by: MOD })
  await applyAll(store, m, 1, [D])
  aged(c)
  const fresh = (await store.add(report(D, key(), { seq: 9 }))).report
  await store.decide(fresh.id, { decision: 'descartar', by: MOD })
  t.ok(onDisk(dir).events.some((e) => e.member === D), 'events about the member before the pass')
  t.is((await store.forgetDeleted(D)).reports, 1)
  t.is(store.get(old.id), null, 'the older row goes')
  t.absent(onDisk(dir).events.some((e) => e.member === D || e.reportId === old.id), 'and the events about the member')
  t.ok(store.get(fresh.id) !== null, 'the recent row waits')
  t.ok(onDisk(dir).events.some((e) => e.reportId === fresh.id), 'with its own events')
  aged(c)
  t.is((await store.forgetDeleted(D)).reports, 1)
  t.absent(onDisk(dir).events.some((e) => e.reportId === fresh.id), 'then they go')
})

test('forgetDeleted: a fresh report about a due member before every pass never holds the older rows', async (t) => {
  const { dir, store, m, c } = setup(t)
  const D = key()
  const olds = []
  for (let i = 0; i < 2; i++) {
    const r = (await store.add(report(D, key(), { seq: i + 1, writer: key(), group: key(), quote: '', anexo: gif() }))).report
    await store.decide(r.id, { decision: 'bloquear', by: MOD })
    olds.push(r)
  }
  const plain = (await store.add(report(D))).report
  await store.decide(plain.id, { decision: 'bloquear', by: MOD })
  await applyAll(store, m, 1, [D])
  t.ok(onDisk(dir).events.some((e) => e.member === D), 'events about the member')
  aged(c)
  let previous = null
  for (let pass = 0; pass < 3; pass++) {
    const fresh = (await store.add(report(D, key(), { seq: 10 + pass }))).report
    await store.forgetDeleted(D)
    for (const r of [...olds, plain]) t.is(store.get(r.id), null, 'pass ' + pass + ': an older row is gone')
    for (const r of olds) t.absent(fs.existsSync(path.join(dir, 'report-media', r.id)), 'pass ' + pass + ': its anexo file is gone')
    const events = onDisk(dir).events
    t.absent(events.some((e) => e.member === D || [...olds, plain].some((r) => e.reportId === r.id)), 'pass ' + pass + ': and the events')
    if (previous !== null) t.is(store.get(previous.id), null, 'pass ' + pass + ': the previous fresh row is gone')
    t.ok(store.get(fresh.id) !== null, 'pass ' + pass + ': only the fresh row waits')
    previous = fresh
    c.t += 24 * HOUR + 1
  }
})

test('forgetDeleted: a record leaves with its target', async (t) => {
  const { store, c } = setup(t)
  const D = key()
  const T = key()
  const r = (await store.add(report(T, D))).report
  await store.decide(r.id, { decision: 'descartar', by: MOD })
  aged(c)
  t.is((await store.forgetDeleted(D)).records, 1)
  t.is(store.holdsDeleted(D), false)
  const res = await store.forgetDeleted(T)
  t.is(res.reports, 1)
  t.is(store.get(r.id), null, 'the record goes once its target is due')
})

test('forgetDeleted: the events of an open row the member filed go with it', async (t) => {
  const { dir, store, c } = setup(t)
  const D = key()
  const T = key()
  const r = (await store.add(report(T, D))).report
  await store.decide(r.id, { decision: 'descartar', by: AI_ACTOR })
  await store.reopen(r.id, { by: MOD })
  t.ok(onDisk(dir).events.filter((e) => e.reportId === r.id).length >= 2, 'a decision and a reaberto event')
  aged(c)
  t.is((await store.forgetDeleted(D)).reports, 1)
  t.absent(onDisk(dir).events.some((e) => e.reportId === r.id), 'its events go')
})

test('a stripped row on disk must be a decided row without reporter, comment, nonce or signature; only a block keeps content', async (t) => {
  const { dir, store, c, m } = setup(t)
  const target = key()
  const D = key()
  const r = (await store.add(report(target, D))).report
  await store.decide(r.id, { decision: 'bloquear', by: MOD })
  aged(c)
  await store.forgetDeleted(D)
  const good = onDisk(dir)
  t.is(good.reports[r.id].reporter, null)
  const reopen = () => openModerationStore(dir, { now: c.now, association: m.association })
  const bad = [
    ['reporter', (row) => { row.reporter = D }],
    ['text', (row) => { row.text = 'x' }],
    ['nonce', (row) => { row.nonce = NONCE }],
    ['signature', (row) => { row.signature = SIG }],
    ['dismissed with a quote', (row) => { row.status = 'descartar'; row.blocked = null }],
    ['open', (row) => { row.status = 'aberta'; row.blocked = null; row.quote = ''; row.decidedBy = null; row.decidedAt = null; row.note = '' }],
    ['date', (row) => { row.stripped = 'ontem' }],
    ['marker', (row) => { delete row.stripped }]
  ]
  for (const [name, edit] of bad) {
    const disk = JSON.parse(JSON.stringify(good))
    edit(disk.reports[r.id])
    fs.writeFileSync(path.join(dir, FILE), JSON.stringify(disk), { mode: 0o600 })
    throwsCode(t, () => reopen().stats(), 'indisponivel', 'refused: ' + name)
  }
  const record = JSON.parse(JSON.stringify(good))
  Object.assign(record.reports[r.id], { status: 'descartar', blocked: null, quote: '' })
  fs.writeFileSync(path.join(dir, FILE), JSON.stringify(record), { mode: 0o600 })
  t.is(reopen().get(r.id).status, 'descartar', 'a dismissed record reads')
  fs.writeFileSync(path.join(dir, FILE), JSON.stringify(good), { mode: 0o600 })
  t.is(reopen().get(r.id).reporter, null, 'the good file reads')
})
