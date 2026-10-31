// Pure group logic (groups.js): merging, rows, roles, labels, join links,
// reconciliation of an uncertain mutation and read-page invalidation.
'use strict'

const test = require('brittle')
const load = () => import('../src/groups.js')

const A = 'ab'.repeat(32)
const B = 'cd'.repeat(32)
const C = 'ef'.repeat(32)

test('mergePages: by key, no duplicates, stable, first value wins', async (t) => {
  const { mergePages } = await load()
  const m = (w, seq, extra = {}) => ({ writer: w, seq, text: 'x', ...extra })
  const out = mergePages([[m(A, 3), m(A, 2)], { items: [m(A, 2, { text: 'changed' }), m(B, 1)] }, [m(A, 3)]])
  t.alike(out.map((i) => i.writer + ':' + i.seq), [A + ':3', A + ':2', B + ':1'])
  t.is(out[1].text, 'x', 'the first copy is kept')
  const writers = mergePages([{ writers: [{ key: A }, { key: B }] }, { writers: [{ key: B }, { key: C }] }])
  t.alike(writers.map((w) => w.key), [A, B, C])
  const members = mergePages([{ members: [{ member: A }] }, { members: [{ member: A }, { member: B }] }])
  t.is(members.length, 2)
  const rows = mergePages([[{ group: A, writer: B, seq: 1 }, { group: A, writer: C, seq: 2 }, { group: C, writer: B, seq: 1 }]])
  t.is(rows.length, 2, 'group rows are keyed by group')
  t.alike(mergePages(null), [])
  t.alike(mergePages([null, 7, [null, {}, 'x']]), [])
})

test('rowsOf: newest at the bottom, names never raw keys, hidden placeholder', async (t) => {
  const { rowsOf, HIDDEN_LABEL } = await load()
  const items = [
    { writer: A, diary: A, seq: 5, at: '2026-10-31T10:00:00.000Z', text: 'oi‮', replyTo: { writer: B, seq: 2 }, hidden: false, name: 'Ana', username: 'ana' },
    { writer: B, diary: B, seq: 2, at: '2026-10-31T09:00:00.000Z', text: '', replyTo: null, hidden: true, name: null, username: 'bia' },
    { writer: C, diary: C, seq: 1, at: '2026-10-31T08:00:00.000Z', text: 'primeira', replyTo: null, hidden: false, name: null, username: null }
  ]
  const rows = rowsOf(items, { [C]: 'Carla' })
  t.alike(rows.map((r) => r.id), [C + ':1', B + ':2', A + ':5'], 'oldest first, newest last')
  t.is(rows[2].author, 'Ana')
  t.is(rows[1].author, '@bia')
  t.is(rows[0].author, 'Carla', 'the names map fills in')
  t.is(rows[1].text, HIDDEN_LABEL)
  t.is(rows[1].hidden, true)
  t.is(rows[2].replyTo, B + ':2')
  t.absent(rows[2].text.includes('‮'), 'peer text goes through displayText')
  const anon = rowsOf([{ writer: A, diary: A, seq: 1, at: 'x', text: 'a', replyTo: null, hidden: false, name: null, username: null }])
  t.is(anon[0].author, 'abababab', 'short key, never the full key')
  t.absent(JSON.stringify(anon).includes(A + A), 'no raw 64 hex author')
  t.is(rowsOf([{ writer: A, diary: A, seq: 1, text: 'a' }, { writer: A, diary: A, seq: 1, text: 'b' }]).length, 1, 'duplicates dropped')
  t.alike(rowsOf([{ text: 'no writer' }, null]), [])
  t.alike(rowsOf(null), [])
})

test('roleOf: from info.role, pending state, creator or writers', async (t) => {
  const { roleOf } = await load()
  t.is(roleOf({ role: 'admin' }, A), 'admin')
  for (const role of ['creator', 'admin', 'member', 'requested', 'banned', 'left', 'pending']) t.is(roleOf({ role }, null), role)
  t.is(roleOf({ state: 'pending' }, A), 'pending')
  t.is(roleOf({ creator: A, writers: [] }, A), 'creator')
  t.is(roleOf({ creator: B, writers: [{ diary: A, left: false }, { diary: A, left: true }] }, A), 'member')
  t.is(roleOf({ creator: B, writers: [{ diary: A, left: true }] }, A), 'left')
  t.is(roleOf({ creator: B, writers: [{ diary: C, left: false }] }, A), null, 'no relation')
  t.is(roleOf({ role: 'boss' }, A), null)
  t.is(roleOf(null, A), null)
  t.is(roleOf({ creator: A }, 'ab'), null, 'a bad own key matches nothing')
})

test('can: every action per role', async (t) => {
  const { can, ROLES } = await load()
  const table = {
    creator: { post: 1, hide: 1, ban: 1, admit: 1, admin: 1, meta: 1, rekey: 1, leave: 1, link: 1 },
    admin: { post: 1, hide: 1, ban: 1, admit: 1, rekey: 1, leave: 1 },
    member: { post: 1, leave: 1 },
    requested: { leave: 1 },
    banned: {},
    left: {},
    pending: { leave: 1 }
  }
  for (const role of ROLES) {
    for (const action of ['post', 'hide', 'ban', 'admit', 'admin', 'meta', 'rekey', 'leave', 'link']) {
      t.is(can(action, role), table[role][action] === 1, role + ' ' + action)
    }
  }
  t.absent(can('fly', 'creator'))
  t.absent(can('post', 'boss'))
  t.absent(can('post', null))
})

test('can: own messages and community admins', async (t) => {
  const { can } = await load()
  t.ok(can('hide', 'member', { own: true }), 'an author hides their own message')
  t.absent(can('hide', 'left', { own: true }), 'a hide written after leaving is withdrawn by the fold')
  t.absent(can('hide', 'banned', { own: true }))
  t.absent(can('hide', 'member'), 'but not another one')
  t.absent(can('hide', 'requested', { own: true }))
  t.absent(can('hide', 'pending', { own: true }))
  for (const action of ['hide', 'ban', 'admit', 'rekey']) {
    t.ok(can(action, 'member', { communityAdmin: true }), 'community admin ' + action)
    t.absent(can(action, 'banned', { communityAdmin: true }))
  }
  t.absent(can('admin', 'member', { communityAdmin: true }), 'creator only')
  t.absent(can('meta', 'admin', { communityAdmin: true }))
  t.absent(can('post', 'left', { communityAdmin: true }))
})

test('labels in pt-BR', async (t) => {
  const { roleLabel, stateLabel, sealedLabel, visibilityLabel, joinLabel, membersLabel, REKEY_PENDING_LABEL } = await load()
  t.is(roleLabel('creator'), 'criador')
  t.is(roleLabel('admin'), 'administrador')
  t.is(roleLabel('requested'), 'pedido enviado')
  t.is(roleLabel('x'), '')
  t.is(stateLabel('rekey-pending'), 'aguardando nova chave')
  t.is(REKEY_PENDING_LABEL, 'aguardando nova chave')
  t.is(stateLabel('ok'), '')
  t.ok(stateLabel('locked').length > 0)
  t.is(sealedLabel(0), '')
  t.is(sealedLabel(1), '1 mensagem cifrada')
  t.is(sealedLabel(7), '7 mensagens cifradas')
  t.is(sealedLabel(-1), '')
  t.is(sealedLabel('3'), '')
  t.is(visibilityLabel('private'), 'grupo privado')
  t.is(visibilityLabel('public'), 'grupo público')
  t.is(joinLabel('approval'), 'entrada com aprovação')
  t.is(joinLabel('x'), '')
  t.is(membersLabel(1), '1 membro')
  t.is(membersLabel(0), '0 membros')
  t.is(membersLabel(null), '')
})

test('no em dash in any label', async (t) => {
  const g = await load()
  const all = [...Object.values(g.ROLE_LABELS), ...Object.values(g.STATE_LABELS), ...Object.values(g.JOIN_LABELS), g.PRIVATE_LABEL, g.PUBLIC_LABEL, g.HIDDEN_LABEL]
  t.absent(all.some((s) => s.includes('\u2014')))
})

test('joinLink and parseJoinLink', async (t) => {
  const { joinLink, parseJoinLink } = await load()
  t.is(joinLink(A), '/g/' + A)
  t.is(joinLink(A.toUpperCase()), '/g/' + A)
  for (const bad of [null, 7, 'ab', A + 'a', 'zz'.repeat(32)]) t.is(joinLink(bad), null)
  t.is(parseJoinLink('/g/' + A), A)
  t.is(parseJoinLink(' /g/' + A.toUpperCase() + '/ '), A)
  t.is(parseJoinLink('https://varanda.example/g/' + A + '?x=1#y'), A)
  t.is(parseJoinLink(joinLink(B)), B, 'round trip')
  for (const bad of ['/g/' + A + 'a', '/g/ab', '/x/' + A, 'g/' + A, '/g/' + A + '/extra', '//evil.example/g/' + A, 'javascript:/g/' + A, '', null, 3]) {
    t.is(parseJoinLink(bad), null, String(bad))
  }
})

test('reconcile: join and leave', async (t) => {
  const { reconcile } = await load()
  for (const state of ['member', 'requested', 'pending']) t.is(reconcile({ action: 'join' }, { state }), 'landed', state)
  t.is(reconcile({ action: 'join' }, { state: 'left' }), 'not-landed')
  t.is(reconcile({ action: 'join' }, { state: 'banned' }), 'not-landed')
  t.is(reconcile({ action: 'leave' }, { state: 'left' }), 'landed')
  t.is(reconcile({ action: 'leave' }, { state: 'member' }), 'not-landed')
  t.is(reconcile({ action: 'join' }, {}), 'unknown')
})

test('reconcile: post', async (t) => {
  const { reconcile } = await load()
  const sentAt = Date.parse('2026-10-31T10:00:10.000Z')
  const change = { action: 'post', diary: C, text: 'oi', sentAt }
  const mine = { writer: A, diary: C, text: 'oi', seq: 5, at: '2026-10-31T10:00:10.500Z', hidden: false }
  const full = (items, over = {}) => ({ items, next: null, state: 'ok', ...over })
  t.is(reconcile(change, full([mine])), 'landed')
  t.is(reconcile(change, full([{ ...mine, writer: B }])), 'landed', 'any device of the diary: the screens never know the writer')
  t.is(reconcile(change, full([{ ...mine, at: '2026-10-31T10:00:08.500Z' }])), 'landed', 'inside the 2 s clock slack')
  t.is(reconcile(change, full([mine], { next: { at: 'x', writer: A, seq: 1 } })), 'landed', 'found on a first page of many')
  t.is(reconcile(change, full([{ ...mine, at: '2026-10-31T10:00:07.000Z' }])), 'not-landed', 'an older identical text is not this post')
  t.is(reconcile(change, full([{ ...mine, diary: B }])), 'not-landed', 'another author')
  t.is(reconcile(change, full([{ ...mine, text: 'tchau' }])), 'not-landed')
  t.is(reconcile(change, full([{ ...mine, hidden: true }])), 'not-landed')
  t.is(reconcile(change, full([{ ...mine, at: 'nope' }])), 'not-landed', 'an unreadable stamp never matches')
  t.is(reconcile(change, full([])), 'not-landed')
  t.is(reconcile(change, full([], { next: { at: 'x', writer: A, seq: 1 } })), 'unknown', 'a paged read does not prove absence')
  t.is(reconcile(change, full([], { state: 'locked' })), 'unknown')
  t.is(reconcile(change, { items: [] }), 'unknown', 'no cursor information')
  t.is(reconcile({ action: 'post', diary: C, text: 'oi' }, full([mine])), 'unknown', 'no send time')
  t.is(reconcile({ action: 'post', text: 'oi', sentAt }, full([mine])), 'unknown', 'no diary')
  t.is(reconcile({ ...change, writer: A, afterSeq: 4 }, full([mine])), 'landed', 'old fields are harmless')
  t.is(reconcile(change, { incomplete: true, items: [] }), 'unknown', 'an incomplete read never allows a retry')
  t.is(reconcile(change, {}), 'unknown')
})

test('reconcile: hide, admit, ban, admin', async (t) => {
  const { reconcile } = await load()
  const items = [{ writer: A, seq: 2, hidden: true }, { writer: A, seq: 3, hidden: false }]
  t.is(reconcile({ action: 'hide', writer: A, seq: 2, on: true }, { items }), 'landed')
  t.is(reconcile({ action: 'hide', writer: A, seq: 3, on: true }, { items }), 'not-landed')
  t.is(reconcile({ action: 'hide', writer: A, seq: 2, on: false }, { items }), 'not-landed')
  t.is(reconcile({ action: 'hide', writer: A, seq: 9, on: true }, { items }), 'unknown')
  const members = [{ member: B, admin: true, banned: false }, { member: C, admin: false, banned: true }]
  t.is(reconcile({ action: 'admin', member: B, on: true }, { members }), 'landed')
  t.is(reconcile({ action: 'admin', member: B, on: false }, { members }), 'not-landed')
  t.is(reconcile({ action: 'ban', member: C, on: true }, { members }), 'landed')
  t.is(reconcile({ action: 'ban', member: C, on: false }, { members }), 'not-landed')
  t.is(reconcile({ action: 'ban', member: A, on: false }, { members }), 'unknown', 'an unban of someone not listed')
  t.is(reconcile({ action: 'ban', member: A, on: true }, { members }), 'not-landed')
  t.is(reconcile({ action: 'admit', member: A, on: false }, { members }), 'landed')
  t.is(reconcile({ action: 'admit', member: B, on: true }, {}), 'unknown')
  const admit = { action: 'admit', member: B, writer: C, on: true }
  const writers = [{ key: C, left: false }]
  t.is(reconcile(admit, { members, requests: [], writers }), 'landed')
  t.is(reconcile(admit, { members, requests: [{ member: B }], writers }), 'not-landed', 'a new device of an admitted member is still a request')
  t.is(reconcile(admit, { members, requests: [], writers: [] }), 'unknown', 'the writer is not counted')
  t.is(reconcile(admit, { members, requests: [], writers: [{ key: C, left: true }] }), 'unknown')
  t.is(reconcile(admit, { members }), 'unknown', 'a members row alone proves nothing')
  t.is(reconcile({ action: 'admit', member: B, on: true }, { members, requests: [], writers }), 'unknown', 'no writer given')
})

test('reconcile: meta, rekey, link and bad input', async (t) => {
  const { reconcile } = await load()
  t.is(reconcile({ action: 'meta', name: 'Novo' }, { info: { name: 'Novo', join: 'open' } }), 'landed')
  t.is(reconcile({ action: 'meta', name: 'Novo', join: 'approval' }, { info: { name: 'Novo', join: 'open' } }), 'not-landed')
  t.is(reconcile({ action: 'meta', join: 'approval' }, { info: { name: 'x', join: 'approval' } }), 'landed')
  t.is(reconcile({ action: 'meta', name: 'x' }, {}), 'unknown')
  const before = { writer: A, seq: 2 }
  t.is(reconcile({ action: 'rekey', epoch: before }, { epoch: { writer: A, seq: 9 }, state: 'ok' }), 'landed')
  t.is(reconcile({ action: 'rekey', epoch: before }, { epoch: { writer: A, seq: 2 }, state: 'ok' }), 'not-landed')
  t.is(reconcile({ action: 'rekey', epoch: null }, { epoch: null, state: 'ok' }), 'unknown', 'no epoch read proves nothing')
  t.is(reconcile({ action: 'rekey', epoch: before }, { epoch: null, state: 'locked', incomplete: false }), 'unknown', 'a locked node reads no epoch')
  t.is(reconcile({ action: 'rekey', epoch: before }, { epoch: { writer: A, seq: 9 }, state: 'locked' }), 'unknown')
  t.is(reconcile({ action: 'rekey', epoch: before }, {}), 'unknown')
  t.is(reconcile({ action: 'link', community: C, on: true }, { info: { communities: [C] } }), 'landed')
  t.is(reconcile({ action: 'link', community: C, on: true }, { info: { communities: [] } }), 'unknown', 'a one-sided success never shows')
  t.is(reconcile({ action: 'link', community: C, on: false }, { info: { communities: [] } }), 'landed')
  t.is(reconcile({ action: 'link', community: C, on: false }, { info: { communities: [C] } }), 'unknown')
  t.is(reconcile({ action: 'rekey', epoch: undefined }, { epoch: { writer: A, seq: 9 }, state: 'ok' }), 'unknown', 'no epoch seen before')
  t.is(reconcile({ action: 'rekey', epoch: null }, { epoch: { writer: A, seq: 9 }, state: 'ok' }), 'unknown')
  t.is(reconcile({ action: 'link', community: C, on: true }, { info: {} }), 'unknown')
  t.is(reconcile({ action: 'fly' }, { state: 'member' }), 'unknown')
  t.is(reconcile(null, {}), 'unknown')
  t.is(reconcile({ action: 'join' }, null), 'unknown')
})

test('read pages: the newest page replaces, older pages append on the cursor', async (t) => {
  const { EMPTY_PAGES, applyPage, itemsOf, versionOf, cursorKey } = await load()
  const it = (seq) => ({ writer: A, diary: A, seq, at: '2026-10-31T10:00:0' + seq + '.000Z', text: 't' + seq, hidden: false })
  const cur = (seq) => ({ at: '2026-10-31T10:00:0' + seq + '.000Z', writer: A, seq })
  const read = (items, next, over = {}) => ({ items, next, hidden: 0, incomplete: false, sealed: 0, epoch: null, state: 'ok', ...over })
  let store = applyPage(EMPTY_PAGES, read([it(5), it(4)], cur(4)))
  t.alike(itemsOf(store).map((i) => i.seq), [5, 4])
  store = applyPage(store, read([it(3), it(2)], cur(2)), cur(4))
  t.alike(itemsOf(store).map((i) => i.seq), [5, 4, 3, 2])
  t.is(store.stale, false)
  t.ok(Object.isFrozen(store))
  const refreshed = applyPage(store, read([it(6), it(5)], cur(5)))
  t.alike(itemsOf(refreshed).map((i) => i.seq), [6, 5], 'a fresh newest page drops the older ones')
  t.is(cursorKey(null), null)
  t.is(cursorKey(cur(4)), '2026-10-31T10:00:04.000Z|' + A + '|4')
  t.is(versionOf(read([], null)), '-|ok|0')
  t.is(applyPage(EMPTY_PAGES, null), EMPTY_PAGES)
  t.is(applyPage(EMPTY_PAGES, { items: 'x' }), EMPTY_PAGES)
})

test('read pages: a stale cursor or a changed version drops older pages', async (t) => {
  const { EMPTY_PAGES, applyPage, itemsOf } = await load()
  const it = (seq) => ({ writer: A, diary: A, seq, at: '2026-10-31T10:00:0' + seq + '.000Z', text: 't', hidden: false })
  const cur = (seq) => ({ at: '2026-10-31T10:00:0' + seq + '.000Z', writer: A, seq })
  const read = (items, next, over = {}) => ({ items, next, hidden: 0, incomplete: false, sealed: 0, epoch: null, state: 'ok', ...over })
  const store = applyPage(EMPTY_PAGES, read([it(5), it(4)], cur(4)))
  const stale = applyPage(store, read([it(2)], null), cur(3))
  t.is(stale.stale, true, 'the cursor is not the one the store ended on')
  t.alike(itemsOf(stale), [], 'nothing is shown from a page that does not continue')
  const rekeyed = applyPage(store, read([it(3)], null, { epoch: { writer: B, seq: 1 } }), cur(4))
  t.is(rekeyed.stale, true, 'a new epoch changes the version')
  t.alike(itemsOf(rekeyed), [])
  const sealed = applyPage(store, read([it(3)], null, { sealed: 2 }), cur(4))
  t.is(sealed.stale, true, 'more sealed messages change the version')
  const locked = applyPage(store, read([], null, { state: 'locked' }), cur(4))
  t.is(locked.stale, true)
  const noNext = applyPage(applyPage(EMPTY_PAGES, read([it(1)], null)), read([it(0)], null), cur(1))
  t.is(noNext.stale, true, 'a store with no cursor accepts no older page')
  const again = applyPage(stale, read([it(6)], cur(6)))
  t.is(again.stale, false, 'a newest page recovers')
  t.alike(itemsOf(again).map((i) => i.seq), [6])
})

test('groups.js stays pure: no React, react-native or Node built-ins', async (t) => {
  const fs = require('fs')
  const path = require('path')
  const src = fs.readFileSync(path.join(__dirname, '../src/groups.js'), 'utf8')
  const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])
  t.alike(imports.sort(), ['./format.js', '@varanda/rpc'])
  t.absent(/\b(require|process|Buffer)\b/.test(src.replace(/\/\/.*$/gm, '')))
  t.absent(src.includes('\u2014'))
})
