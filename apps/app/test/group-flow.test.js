// Flows over the pure group logic (groups.js, groupLink.js, report.js): the
// sequences the Cadeiras screens run, with the states the node can answer.
'use strict'

const test = require('brittle')
const groups = () => import('../src/groups.js')
const links = () => import('../src/groupLink.js')
const report = () => import('../src/report.js')

const G = 'ab'.repeat(32)
const ME = 'cd'.repeat(32)
const OTHER = 'ef'.repeat(32)

const msg = (writer, seq, text, extra = {}) => ({ writer, diary: writer, seq, at: '2026-10-31T10:00:' + String(seq % 60).padStart(2, '0') + '.000Z', text, hidden: false, replyTo: null, ...extra })
const read = (items, extra = {}) => ({ items, next: null, sealed: 0, epoch: null, state: 'ok', ...extra })
const cursor = (m) => ({ at: m.at, writer: m.writer, seq: m.seq })

test('late arrival: an older page that comes after a newer read is dropped', async (t) => {
  const { applyPage, itemsOf, EMPTY_PAGES } = await groups()
  const m4 = msg(OTHER, 4, 'quatro')
  const m3 = msg(OTHER, 3, 'três')
  const m2 = msg(OTHER, 2, 'dois')
  const m1 = msg(OTHER, 1, 'um')
  let store = applyPage(EMPTY_PAGES, read([m3], { next: cursor(m3) }))
  const before = store.next
  // A reload lands the newest page again (now with one more message).
  store = applyPage(store, read([m4, m3], { next: cursor(m2) }))
  t.alike(itemsOf(store).map((i) => i.seq), [4, 3], 'the reload replaced the pages')
  // The older page asked with the first cursor arrives late.
  const late = applyPage(store, read([m2, m1]), before)
  t.is(late.stale, true, 'stale')
  t.alike(itemsOf(late), [], 'the late rows are not shown')
  t.is(late.version, store.version, 'the version is kept')
  // The screen reloads from the newest page and recovers.
  const again = applyPage(late, read([m4, m3], { next: cursor(m2) }))
  t.is(again.stale, false)
  t.alike(itemsOf(again).map((i) => i.seq), [4, 3])
})

test('expired cursor: a changed epoch, sealed count or state drops older pages', async (t) => {
  const { applyPage, itemsOf, EMPTY_PAGES } = await groups()
  const m2 = msg(OTHER, 2, 'dois')
  const m1 = msg(OTHER, 1, 'um')
  const epoch = { writer: G, seq: 1 }
  const first = applyPage(EMPTY_PAGES, read([m2], { next: cursor(m2), epoch, sealed: 1 }))
  const ok = applyPage(first, read([m1], { epoch, sealed: 1 }), first.next)
  t.is(ok.stale, false, 'same version: the page is kept')
  t.alike(itemsOf(ok).map((i) => i.seq), [2, 1])
  t.is(applyPage(first, read([m1], { epoch: { writer: G, seq: 9 }, sealed: 1 }), first.next).stale, true, 'new epoch')
  t.is(applyPage(first, read([m1], { epoch, sealed: 0 }), first.next).stale, true, 'sealed count changed')
  t.is(applyPage(first, read([m1], { epoch, sealed: 1, state: 'locked' }), first.next).stale, true, 'state changed')
  t.is(applyPage(first, read([m1], { epoch, sealed: 1 }), { at: m1.at, writer: OTHER, seq: 77 }).stale, true, 'a cursor the store did not end on')
})

test('lost response: an UNCERTAIN post is reconciled by re-reading, never retried blind', async (t) => {
  const { reconcile } = await groups()
  const change = { action: 'post', diary: ME, text: 'oi', sentAt: Date.parse('2026-10-31T10:00:10.000Z') }
  const full = (items, extra = {}) => ({ items, next: null, state: 'ok', ...extra })
  t.is(reconcile(change, full([msg(ME, 11, 'oi')])), 'landed', 'it landed: no retry')
  t.is(reconcile(change, full([msg(ME, 3, 'oi')])), 'not-landed', 'an older identical text is not this post')
  t.is(reconcile(change, full([msg(OTHER, 9, 'oi')])), 'not-landed', 'another author does not count')
  t.is(reconcile(change, full([msg(ME, 11, 'oi', { hidden: true })])), 'not-landed', 'hidden does not count')
  t.is(reconcile(change, full([], { next: cursor(msg(OTHER, 1, 'x')) })), 'unknown', 'a partial read proves nothing')
  t.is(reconcile(change, full([], { state: 'rekey-pending' })), 'unknown', 'a state other than ok proves nothing')
  t.is(reconcile(change, { ...full([]), incomplete: true }), 'unknown', 'an incomplete read proves nothing')
  t.is(reconcile(change, null), 'unknown', 'no re-read: offer another read')
  t.is(reconcile({ ...change, diary: undefined }, full([])), 'unknown')
})

test('lost response: admit and rekey are reconciled before any retry', async (t) => {
  const { reconcile } = await groups()
  const W = '12'.repeat(32)
  const admit = { action: 'admit', member: OTHER, on: true, writer: W }
  const writer = (left) => ({ key: W, left })
  t.is(reconcile(admit, { members: [], requests: [{ member: OTHER }], writers: [writer(false)] }), 'not-landed', 'still requested')
  t.is(reconcile(admit, { members: [], requests: [], writers: [writer(false)] }), 'landed')
  t.is(reconcile(admit, { members: [], requests: [], writers: [] }), 'unknown', 'writer not seen yet')
  t.is(reconcile(admit, { members: [], requests: [] }), 'unknown', 'missing lists')
  const rekey = { action: 'rekey', epoch: { writer: G, seq: 1 } }
  t.is(reconcile(rekey, { epoch: { writer: G, seq: 1 }, state: 'ok' }), 'not-landed', 'same epoch')
  t.is(reconcile(rekey, { epoch: { writer: G, seq: 8 }, state: 'ok' }), 'landed', 'new epoch')
  t.is(reconcile(rekey, { epoch: { writer: G, seq: 8 }, state: 'locked' }), 'unknown', 'locked reads no epoch')
  t.is(reconcile(rekey, { epoch: null, state: 'ok' }), 'unknown')
})

test('hide: the row turns into the placeholder, reconciled on both sides', async (t) => {
  const { rowsOf, reconcile, HIDDEN_LABEL, can } = await groups()
  const rows = rowsOf([msg(OTHER, 2, '', { hidden: true }), msg(ME, 1, 'meu')])
  t.is(rows[1].hidden, true)
  t.is(rows[1].text, HIDDEN_LABEL)
  t.is(reconcile({ action: 'hide', writer: OTHER, seq: 2, on: true }, { items: [msg(OTHER, 2, '', { hidden: true })] }), 'landed')
  t.is(reconcile({ action: 'hide', writer: ME, seq: 1, on: true }, { items: [msg(ME, 1, 'meu')] }), 'not-landed')
  t.is(reconcile({ action: 'hide', writer: ME, seq: 1, on: false }, { items: [msg(ME, 1, 'meu')] }), 'landed', 'unhide')
  t.is(reconcile({ action: 'hide', writer: ME, seq: 7, on: true }, { items: [msg(ME, 1, 'meu')] }), 'unknown', 'row not in the read')
  t.ok(can('hide', 'member', { own: true }), 'authors hide their own')
  t.absent(can('hide', 'member', { own: false }), 'but not others')
  t.ok(can('hide', 'admin'))
})

test('ban: only staff or a community admin, reconciled by the member row', async (t) => {
  const { can, reconcile } = await groups()
  t.ok(can('ban', 'creator') && can('ban', 'admin'))
  t.absent(can('ban', 'member') || can('ban', 'requested') || can('ban', 'banned'))
  t.ok(can('ban', 'member', { communityAdmin: true }), 'delegated by the community')
  t.absent(can('ban', 'banned', { communityAdmin: true }), 'a banned caller gets nothing')
  const ban = { action: 'ban', member: OTHER, on: true }
  t.is(reconcile(ban, { members: [{ member: OTHER, banned: true }] }), 'landed')
  t.is(reconcile(ban, { members: [{ member: OTHER, banned: false }] }), 'not-landed')
  t.is(reconcile(ban, { members: [] }), 'not-landed', 'no row at all is not a ban')
  t.is(reconcile(ban, null), 'unknown')
  t.absent(can('post', 'banned'), 'a banned member cannot post')
})

test('locked: no rows, the locked label, and the version moves', async (t) => {
  const { rowsOf, stateLabel, STATE_LABELS, versionOf } = await groups()
  t.is(stateLabel('locked'), STATE_LABELS.locked)
  t.ok(/passkey/.test(stateLabel('locked')))
  t.is(stateLabel('ok'), '', 'no label when fine')
  t.alike(rowsOf(read([], { state: 'locked' }).items), [], 'a locked read has no rows')
  t.not(versionOf(read([], { state: 'locked' })), versionOf(read([])), 'locking is a version change')
})

test('rekey-pending: posting refused with the label, rekey offered only to roles that can', async (t) => {
  const { stateLabel, REKEY_PENDING_LABEL, can, roleLabel } = await groups()
  t.is(stateLabel('rekey-pending'), 'aguardando nova chave')
  t.is(REKEY_PENDING_LABEL, stateLabel('rekey-pending'))
  for (const role of ['creator', 'admin']) t.ok(can('rekey', role), role + ' can rekey')
  for (const role of ['member', 'requested', 'banned', 'left', 'pending']) t.absent(can('rekey', role), role + ' cannot')
  t.ok(can('rekey', 'member', { communityAdmin: true }), 'a community admin can')
  t.absent(can('rekey', 'pending', { communityAdmin: true }))
  t.is(roleLabel('creator'), 'criador')
  t.absent(can('nope', 'creator'), 'unknown action')
})

test('group links: parse and build round trip, and the address-bar cleanup', async (t) => {
  const { joinLink, parseJoinLink } = await groups()
  const { parseGroupPath, isGroupPath, captureGroupLink } = await links()
  t.is(joinLink(G.toUpperCase()), '/g/' + G, 'built lowercase')
  t.is(parseJoinLink(joinLink(G)), G, 'round trip')
  t.is(parseJoinLink('https://varanda.app/g/' + G + '?x=1#y'), G, 'with an origin, query and hash')
  t.is(parseGroupPath(joinLink(G)), G)
  t.is(parseGroupPath('/g/' + G.toUpperCase()), null, 'the path form is lowercase only')
  for (const bad of ['/g/' + G.slice(1), '/g/' + G + 'a', '/g/zz', '/x/' + G, '/g/' + G + '/extra', '', null, 5]) {
    t.is(parseJoinLink(bad), null, 'rejects ' + String(bad).slice(0, 20))
    t.is(parseGroupPath(bad), null)
  }
  t.ok(isGroupPath('/g/anything'))
  t.absent(isGroupPath('/'))
  const calls = []
  const history = { state: { s: 1 }, replaceState: (...a) => calls.push(a) }
  t.is(captureGroupLink({ location: { pathname: '/g/' + G, search: '?conta=1', hash: '#token=abc' }, history }), G)
  t.alike(calls, [[{ s: 1 }, '', '/?conta=1#token=abc']], 'search and hash kept byte for byte')
  t.is(captureGroupLink({ location: { pathname: '/g/bad', search: '', hash: '' }, history }), null, 'a bad key is cleaned and opens nothing')
  t.is(calls.length, 2)
  t.is(captureGroupLink({ location: { pathname: '/', search: '', hash: '' }, history }), null)
  t.is(calls.length, 2, 'other paths touch nothing')
})

test('report params of a private group message: writer, group, seq and the decrypted quote', async (t) => {
  const { reportParams, buildReportSend } = await report()
  const params = reportParams({ nonce: 'n1', target: OTHER, seq: 5, writer: ME, group: G, reason: 'spam', text: 'nota', quote: 'texto aberto neste aparelho\ud800' })
  t.is(params.writer, ME)
  t.is(params.group, G)
  t.is(params.seq, 5)
  t.is(params.target, OTHER)
  t.is(params.quote, 'texto aberto neste aparelho�', 'the quote is the local text, well formed')
  const diary = reportParams({ nonce: 'n1', target: OTHER, seq: 5, reason: 'spam', text: '', quote: 'q' })
  t.absent('writer' in diary || 'group' in diary, 'a diary post carries neither')
  t.absent('seq' in reportParams({ nonce: 'n1', target: OTHER, reason: 'spam', text: '' }), 'an account report has no seq')
  const sent = JSON.parse(buildReportSend({ member: ME, nonce: 'n1', target: OTHER, seq: 5, writer: ME, group: G, reason: 'spam', text: '', quote: params.quote, signature: 's' }).init.body)
  t.is(sent.writer, ME)
  t.is(sent.group, G)
  const plain = JSON.parse(buildReportSend({ member: ME, nonce: 'n1', target: OTHER, seq: 5, reason: 'spam', text: '', quote: 'q', signature: 's' }).init.body)
  t.absent('writer' in plain || 'group' in plain)
})
