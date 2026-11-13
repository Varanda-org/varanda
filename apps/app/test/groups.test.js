// Pure group logic (groups.js): merging, rows, roles, labels, join links,
// reconciliation of an uncertain mutation and read-page invalidation.
'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
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

test('rowsOf keeps line breaks and hands MentionText the raw text', async (t) => {
  const { rowsOf, HIDDEN_LABEL } = await load()
  const at = '2026-10-31T10:00:00.000Z'
  const [row] = rowsOf([{ writer: A, diary: A, seq: 1, at, text: 'oi\nhttps://a.com‮evil', hidden: false }])
  t.is(row.text, 'oi\nhttps://a.com�evil', 'line feed kept, direction mark escaped')
  t.is(row.rawText, 'oi\nhttps://a.com‮evil', 'the mark survives so links.js refuses the word')
  const [hidden] = rowsOf([{ writer: A, diary: A, seq: 2, at, text: 'segredo', hidden: true }])
  t.is(hidden.text, HIDDEN_LABEL)
  t.is(hidden.rawText, '')
  const source = readFileSync(join(__dirname, '../src/screens/Grupo.js'), 'utf8')
  t.ok(source.includes('rawText: row.hidden ? undefined : row.rawText'), 'Bubble gets the raw text for MentionText, never for a hidden row')
  const bubble = readFileSync(join(__dirname, '../src/ui/Bubble.js'), 'utf8')
  t.ok(bubble.includes('<MentionText text={shown}'), 'Bubble renders the shown text through MentionText')
  t.ok(bubble.includes('const shown = rich && !styled && embed !== null ? textWithoutHrefs(item.rawText, (href) => sameMusicPage(href, card.url)) : item.rawText'), 'the shown text is rawText minus only the player card\'s own link')
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
    creator: { post: 1, hide: 1, ban: 1, admit: 1, admin: 1, meta: 1, rekey: 1, leave: 1, create: 1 },
    admin: { post: 1, hide: 1, ban: 1, admit: 1, rekey: 1, leave: 1 },
    member: { post: 1, leave: 1 },
    requested: { leave: 1 },
    banned: {},
    left: {},
    pending: { leave: 1 }
  }
  for (const role of ROLES) {
    for (const action of ['post', 'hide', 'ban', 'admit', 'admin', 'meta', 'rekey', 'leave', 'create', 'link']) {
      t.is(can(action, role), table[role][action] === 1, role + ' ' + action)
    }
  }
  t.absent(can('fly', 'creator'))
  t.absent(can('post', 'boss'))
  t.absent(can('post', null))
})

test('can: invite and invitePolicy', async (t) => {
  const { can, ROLES } = await load()
  for (const role of ROLES) {
    const staff = role === 'creator' || role === 'admin'
    t.is(can('invitePolicy', role), staff, role + ' invitePolicy')
    t.is(can('invite', role), staff, role + ' invite')
    t.is(can('invite', role, { memberInvite: true }), staff || role === 'member', role + ' invite on')
  }
  t.absent(can('invite', null, { memberInvite: true }))
})

test('reconcile: invite-policy', async (t) => {
  const { reconcile } = await load()
  const c = { action: 'invite-policy', members: true }
  t.is(reconcile(c, { info: { memberInvite: true } }), 'landed')
  t.is(reconcile(c, { info: { memberInvite: false } }), 'not-landed')
  t.is(reconcile(c, { info: {} }), 'unknown')
  t.is(reconcile(c, {}), 'unknown')
  t.is(reconcile({ action: 'invite-policy', members: false }, { info: { memberInvite: false } }), 'landed')
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
  t.absent(can('create', 'member', { communityAdmin: true }), 'creation uses the community role')
  t.absent(can('post', 'left', { communityAdmin: true }))
})

test('labels in pt-BR', async (t) => {
  const { roleLabel, stateLabel, sealedLabel, visibilityLabel, joinLabel, membersLabel, REKEY_PENDING_LABEL, GENERAL_LABEL, ORPHAN_LABEL, COMMUNITY_JOIN_LABELS } = await load()
  t.is(GENERAL_LABEL, 'Geral')
  t.is(ORPHAN_LABEL, 'grupo sem comunidade')
  t.alike(COMMUNITY_JOIN_LABELS, { open: 'aberta a todos', approval: 'entrada com aprovação' })
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
  t.is(membersLabel(1), '1\u00a0membro')
  t.is(membersLabel(0), '0\u00a0membros')
  t.is(membersLabel(null), '')
})

test('no em dash in any label', async (t) => {
  const g = await load()
  const all = [...Object.values(g.ROLE_LABELS), ...Object.values(g.STATE_LABELS), ...Object.values(g.JOIN_LABELS), ...Object.values(g.COMMUNITY_JOIN_LABELS), g.GENERAL_LABEL, g.ORPHAN_LABEL, g.PRIVATE_LABEL, g.PUBLIC_LABEL, g.HIDDEN_LABEL, g.DEVICE_JOIN_LABEL, g.DEVICE_JOIN_TEXT, g.DEVICE_WAIT_TEXT, g.DEVICE_APPROVAL_TEXT, g.DEVICE_RESERVE_TEXT, g.DEVICE_PENDING_JOIN_TEXT]
  t.absent(all.some((s) => s.includes('\u2014')))
})

test('device join: this device writes, or the account still has to join here', async (t) => {
  const { needsDeviceJoin, writerOnDevice, canWriteHere, showNewGroup, authorityHere, DEVICE_STAFF_TEXT, DEVICE_ROOT_TEXT, rootAdminHere, deviceStaffNote, DEVICE_JOIN_LABEL, DEVICE_JOIN_TEXT, DEVICE_WAIT_TEXT, DEVICE_APPROVAL_TEXT, DEVICE_RESERVE_TEXT, DEVICE_PENDING_JOIN_TEXT, deviceReserveReached, reserveReachedAny, communityReserveReached, DEVICE_RESERVE_JOIN_TEXT, needsReserveConfirm } = await load()
  for (const role of ['member', 'admin', 'creator']) {
    t.ok(needsDeviceJoin({ role, writerHere: false }), role)
    t.absent(needsDeviceJoin({ role, writerHere: true }), role + ' already writes here')
    t.absent(needsDeviceJoin({ role }), role + ' field missing')
  }
  for (const role of ['requested', 'banned', 'left', 'pending']) {
    t.absent(needsDeviceJoin({ role, writerHere: false }), role)
  }
  t.absent(needsDeviceJoin(null))
  t.absent(needsDeviceJoin(undefined))

  t.absent(writerOnDevice({ role: 'member', writerHere: false }))
  t.ok(writerOnDevice({ writerHere: true }))
  t.ok(writerOnDevice({}))
  t.ok(writerOnDevice(null))
  t.ok(writerOnDevice({ writerHere: null }))

  t.absent(canWriteHere({ canWrite: false }))
  t.ok(canWriteHere({ canWrite: true }))
  t.ok(canWriteHere({ writerHere: false }))
  t.ok(canWriteHere({}))
  t.ok(canWriteHere(null))
  t.ok(canWriteHere({ canWrite: null }))

  t.ok(showNewGroup({ role: 'creator' }), 'rootHere missing')
  t.ok(showNewGroup({ role: 'creator', rootHere: true }))
  t.absent(showNewGroup({ role: 'creator', rootHere: false }))
  t.absent(showNewGroup({ role: 'admin' }))
  t.absent(showNewGroup({ role: 'admin', rootHere: true }))
  t.absent(showNewGroup({ role: 'member', rootHere: true }))
  t.absent(showNewGroup(null))

  t.ok(authorityHere({}), 'authorityHere missing')
  t.ok(authorityHere({ authorityHere: true }))
  t.absent(authorityHere({ authorityHere: false }))
  t.ok(authorityHere(null))
  t.absent(DEVICE_STAFF_TEXT.includes('\u2014'))
  t.absent(DEVICE_ROOT_TEXT.includes('\u2014'))
  t.is(DEVICE_ROOT_TEXT, 'Novo grupo, Ajustes e Quem pode convidar só funcionam no aparelho que criou a comunidade.')

  t.ok(rootAdminHere({}))
  t.ok(rootAdminHere(null))
  t.absent(rootAdminHere({ rootHere: false }))
  t.ok(rootAdminHere({ rootHere: false, repair: true }), 'repair writes through the live community writer')
  t.ok(rootAdminHere({ rootHere: true }))

  const creator = { owner: true, staff: true }
  t.is(deviceStaffNote({ role: 'creator', rootHere: false }, creator), 'root')
  t.is(deviceStaffNote({ role: 'creator', rootHere: false, authorityHere: false }, creator), 'root', 'one reason at a time')
  t.is(deviceStaffNote({ role: 'creator', rootHere: true, authorityHere: false }, creator), 'staff')
  t.is(deviceStaffNote({ role: 'creator', rootHere: false, repair: true }, creator), null)
  t.is(deviceStaffNote({ role: 'creator', rootHere: true }, creator), null)
  t.is(deviceStaffNote({ role: 'creator' }, creator), null, 'older node')
  t.is(deviceStaffNote({ role: 'admin', authorityHere: false }, { owner: false, staff: true }), 'staff')
  t.is(deviceStaffNote({ role: 'admin', rootHere: false }, { owner: false, staff: true }), null)
  t.is(deviceStaffNote({ role: 'admin', authorityHere: false, writerHere: false }, { owner: false, staff: true }), 'join', 'not participating yet beats the other notes')
  t.is(deviceStaffNote({ role: 'creator', writerHere: false, rootHere: false }, creator), 'join')
  t.is(deviceStaffNote({ role: 'member', writerHere: false }, { owner: false, staff: false }), null)
  t.is(deviceStaffNote({ role: 'member', authorityHere: false }, { owner: false, staff: false }), null)
  t.is(deviceStaffNote(null, creator), null)

  t.is(DEVICE_JOIN_LABEL, 'Participar neste aparelho')
  t.is(DEVICE_JOIN_TEXT, 'Sua conta já participa. Este aparelho costuma entrar sozinho depois da sincronização; se ainda não entrou, toque para participar por ele.')
  t.is(DEVICE_RESERVE_TEXT, 'Sua conta já usa quase todos os aparelhos permitidos aqui. Entrar por este aparelho gasta uma das últimas vagas, que não voltam.')
  t.absent(DEVICE_PENDING_JOIN_TEXT.includes('\u2014'))
  t.absent(deviceReserveReached({ writersBound: 5 }))
  t.ok(deviceReserveReached({ writersBound: 6 }))
  t.ok(deviceReserveReached({ writersBound: 8 }))
  t.absent(deviceReserveReached({}))
  t.absent(deviceReserveReached(null))
  t.absent(deviceReserveReached({ writersBound: 6.5 }))
  t.absent(deviceReserveReached({ writersBound: '6' }))
  t.ok(reserveReachedAny([0, 6]))
  t.absent(reserveReachedAny([5, undefined, '6', 5.5]))
  t.ok(needsReserveConfirm([2, 6], false))
  t.ok(needsReserveConfirm([6], undefined))
  t.absent(needsReserveConfirm([6], true))
  t.absent(needsReserveConfirm([5, undefined], false))
  t.absent(reserveReachedAny(null))
  t.ok(communityReserveReached({ writersBound: 2, generalWritersBound: 6 }))
  t.ok(communityReserveReached({ writersBound: 7 }))
  t.absent(communityReserveReached({ writersBound: 5, generalWritersBound: 5 }))
  t.absent(communityReserveReached(null))
  t.absent(DEVICE_RESERVE_JOIN_TEXT.includes('\u2014'))
  t.ok(DEVICE_RESERVE_JOIN_TEXT.includes('Participar neste aparelho'))
  t.is(DEVICE_WAIT_TEXT, 'Este aparelho ainda não pode escrever aqui. Aguarde a sincronização.')
  t.is(DEVICE_APPROVAL_TEXT, 'Este aparelho precisa da aprovação de um administrador para escrever.')
})

test('joinLink builds the path; the paste parsers are gone', async (t) => {
  const g = await load()
  const { joinLink } = g
  t.is(joinLink(A), '/g/' + A)
  t.is(joinLink(A.toUpperCase()), '/g/' + A)
  for (const bad of [null, 7, 'ab', A + 'a', 'zz'.repeat(32)]) t.is(joinLink(bad), null)
  t.is(g.parseJoinLink, undefined)
  t.is(g.parseCommunityJoinLink, undefined)
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
  t.is(reconcile({ action: 'link', community: C, on: true }, { info: { communities: [C] } }), 'unknown')
  t.is(reconcile({ action: 'link', community: C, on: true }, { info: { communities: [] } }), 'unknown', 'link is no longer supported')
  t.is(reconcile({ action: 'link', community: C, on: false }, { info: { communities: [] } }), 'unknown')
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

test('unreadLabel: empty below 1, the count up to 98, 99+ from 99', async (t) => {
  const { unreadLabel } = await load()
  for (const n of [0, -1, 1.5, NaN, null, undefined, '3']) t.is(unreadLabel(n), '', String(n))
  t.is(unreadLabel(1), '1')
  t.is(unreadLabel(98), '98')
  t.is(unreadLabel(99), '99+')
  t.is(unreadLabel(250), '99+')
})

test('lastLine: who said it and what, never a hidden preview', async (t) => {
  const { lastLine, HIDDEN_LABEL } = await load()
  t.is(lastLine(null), '')
  t.is(lastLine('oi'), '')
  t.is(lastLine(undefined), '')
  const hidden = lastLine({ hidden: true, preview: 'segredo', name: 'Ana', username: 'ana', mine: true })
  t.is(hidden, HIDDEN_LABEL)
  t.absent(hidden.includes('segredo') || hidden.includes('Ana') || hidden.includes('ana'))
  t.is(lastLine({ preview: 'oi', mine: true, name: 'Ana' }), 'oi', 'the own message carries no author in the text')
  t.is(lastLine({ preview: 'oi', name: 'Ana', username: 'ana' }), 'Ana: oi')
  t.is(lastLine({ preview: 'oi', name: '  ', username: 'ana' }), '@ana: oi')
  t.is(lastLine({ preview: 'oi' }), 'oi')
  t.is(lastLine({ preview: 'oi', name: '', username: '' }), 'oi')
  t.is(lastLine({ name: 'Ana' }), 'Ana: ')
  const flat = lastLine({ preview: 'a\nb\r\nc', name: 'Ana' })
  t.is(flat, 'Ana: a b c')
  t.absent(/[\n\r�]/.test(flat), 'a line break does not survive')
})

test('lastIsOwn: the own marker only for an own, visible message', async (t) => {
  const { lastIsOwn, lastLine, OWN_LABEL } = await load()
  t.is(OWN_LABEL, 'Você')
  t.is(lastIsOwn({ preview: 'oi', mine: true }), true)
  t.is(lastIsOwn({ preview: 'oi', mine: true, hidden: true }), false, 'a hidden message has no author')
  const fake = { preview: 'oi', name: 'Você', mine: false }
  t.is(lastLine(fake), 'Você: oi', 'a peer named Você stays in the text')
  t.is(lastIsOwn(fake), false, 'and never gets the own marker')
  t.is(lastIsOwn({ preview: 'oi', mine: 'true' }), false)
  for (const v of [null, undefined, 'oi', 1, true]) t.is(lastIsOwn(v), false, String(v))
})

test('groups.js stays pure: no React, react-native or Node built-ins', async (t) => {
  const fs = require('fs')
  const path = require('path')
  const src = fs.readFileSync(path.join(__dirname, '../src/groups.js'), 'utf8')
  const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])
  t.alike(imports.sort(), ['./chatPreview.js', './format.js', '@varanda/rpc'])
  const helper = fs.readFileSync(path.join(__dirname, '../src/chatPreview.js'), 'utf8')
  t.alike([...helper.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]), ['./richText.js', '@varanda/rpc'], 'the preview helper only reads the pure parser and the rpc text helpers')
  t.absent(/\b(require|process|Buffer)\b/.test(src.replace(/\/\/.*$/gm, '')))
  t.absent(src.includes('\u2014'))
})

test('reconcile: community join uses the role from community.info', async (t) => {
  const { reconcile } = await load()
  for (const role of ['member', 'requested', 'pending']) {
    t.is(reconcile({ action: 'community-join' }, { role }), 'landed', role)
    t.is(reconcile({ action: 'community-join' }, { role, incomplete: true }), 'unknown', 'incomplete ' + role)
  }
  for (const role of ['left', 'banned', 'creator', 'admin']) t.is(reconcile({ action: 'community-join' }, { role }), 'not-landed', role)
  t.is(reconcile({ action: 'community-join' }, { state: 'member' }), 'unknown')
  t.is(reconcile({ action: 'community-join' }, { role: null }), 'unknown')
})

test('reconcile: create matches the community, name and creator role', async (t) => {
  const { reconcile } = await load()
  const change = { action: 'create', community: C, name: 'Praia' }
  const row = { group: A, name: 'Praia', role: 'creator' }
  const view = { community: C, groups: [row], incomplete: false }
  t.is(reconcile(change, view), 'landed')
  t.is(reconcile(change, { ...view, groups: [null, { ...row, role: 'member' }, row] }), 'landed')
  t.is(reconcile(change, { ...view, incomplete: true }), 'unknown')
  t.is(reconcile(change, { ...view, community: B }), 'unknown', 'another catalogue proves nothing')
  t.is(reconcile(change, { ...view, groups: [] }), 'not-landed')
  t.is(reconcile(change, { ...view, groups: [{ ...row, name: 'Outra' }] }), 'not-landed')
  for (const role of ['admin', 'member', 'requested', 'banned', 'left', 'pending', null]) {
    t.is(reconcile(change, { ...view, groups: [{ ...row, role }] }), 'not-landed', String(role))
  }
  t.is(reconcile(change, { ...view, groups: null }), 'unknown')
  t.is(reconcile(change, {}), 'unknown')
  t.is(reconcile({ action: 'create', community: C }, view), 'unknown')
  t.is(reconcile({ action: 'create', name: 'Praia' }, view), 'unknown')
})

test('page mode: needs a page identity and the gate', async (t) => {
  const { pageMode } = await load()
  t.alike(pageMode({ acting: { kind: 'page', key: A }, on: true }), { page: true, key: A })
  t.is(pageMode({ acting: { kind: 'page', key: A }, on: false }).page, false, 'gate off acts as the member')
  t.is(pageMode({ acting: { kind: 'me' }, on: true }).page, false)
  t.is(pageMode({ acting: { kind: 'page', key: 'nope' }, on: true }).page, false)
  t.is(pageMode({}).page, false)
  t.is(pageMode().page, false)
})

test('page mode: a page never gets staff controls', async (t) => {
  const { canAsPage, pageCan } = await load()
  for (const a of ['create', 'ban', 'admit', 'admin', 'hide', 'meta', 'rekey', 'invite', 'invitePolicy']) {
    t.is(canAsPage(a), false, a)
    t.is(pageCan(a, 'creator'), false, a + ' even with a staff role')
  }
  t.is(pageCan('post', 'member'), true)
  t.is(pageCan('post', 'requested'), false)
  t.is(pageCan('leave', 'requested'), true)
  t.is(pageCan('leave', 'left'), false)
})

test('page mode: requested shows pedido enviado, unusable answers show nothing', async (t) => {
  const { pageRoleOf, pageRoleLabel } = await load()
  t.is(pageRoleOf({ state: 'requested' }), 'requested')
  t.is(pageRoleOf({ role: 'member' }), 'member')
  t.is(pageRoleOf({ role: 'left' }), 'left')
  t.is(pageRoleOf({ state: 'pending' }), null)
  t.is(pageRoleOf(null), null)
  t.is(pageRoleLabel('requested'), 'pedido enviado')
  t.is(pageRoleLabel('left'), '')
})

test('page mode: a missing service route is "em breve", an uncertain one is not', async (t) => {
  const { pageErrorText, isPageSoon, PAGE_SOON_TEXT } = await load()
  t.is(pageErrorText({ code: 'pedido-invalido', message: 'x' }), PAGE_SOON_TEXT)
  t.is(pageErrorText({ code: 'nao-encontrado', message: 'x' }), PAGE_SOON_TEXT)
  t.is(isPageSoon({ code: 'pedido-invalido', uncertain: true }), false, 'after a signature it is never "em breve"')
  t.is(pageErrorText({ code: 'limite', message: 'Limite atingido' }), 'Limite atingido')
  t.is(pageErrorText(null), 'Serviço indisponível')
})

test('page mode: read rows and communities are filtered', async (t) => {
  const { pageReadItems, pageCommunities } = await load()
  t.is(pageReadItems({ items: [{ writer: A, seq: 1 }, { writer: A }, null, { seq: 2 }] }).length, 1)
  t.alike(pageReadItems(null), [])
  t.alike(pageCommunities({ communities: [{ community: C }, { community: 'x' }, null] }), [{ community: C }])
  t.alike(pageCommunities({}), [])
})

test('reconcile post: a reply is confirmed only by a message answering the same target', async (t) => {
  const { reconcile } = await load()
  const D = 'd'.repeat(64)
  const W = 'a'.repeat(64)
  const at = new Date(Date.now()).toISOString()
  const sentAt = Date.parse(at)
  const earlier = { diary: D, text: 'ok', at, hidden: false, replyTo: { writer: W, seq: 1 } }
  const view = { items: [earlier], next: null, state: 'ok' }
  t.is(reconcile({ action: 'post', diary: D, text: 'ok', sentAt, replyKey: W + ':2' }, view), 'not-landed', 'the same text answering another message does not count')
  t.is(reconcile({ action: 'post', diary: D, text: 'ok', sentAt, replyKey: W + ':1' }, view), 'landed')
  t.is(reconcile({ action: 'post', diary: D, text: 'ok', sentAt, replyKey: null }, view), 'not-landed', 'a plain post is not confirmed by a reply')
  t.is(reconcile({ action: 'post', diary: D, text: 'ok', sentAt }, view), 'landed', 'without replyKey the old rule stays')
})

test('knownVisibility: from the info, or for a page from its epoch', async (t) => {
  const { knownVisibility } = await load()
  t.is(knownVisibility({ page: false, info: { visibility: 'public' }, epoch: null }), 'public')
  t.is(knownVisibility({ page: false, info: { visibility: 'private' }, epoch: null }), 'private')
  t.is(knownVisibility({ page: false, info: null, epoch: null }), null, 'no info yet: not known')
  t.is(knownVisibility({ page: false, info: {}, epoch: { writer: A, seq: 1 } }), null, 'a member\'s visibility never comes from the epoch')
  t.is(knownVisibility({ page: true, info: null, epoch: null }), 'public', 'a page with no epoch')
  t.is(knownVisibility({ page: true, info: null, epoch: { writer: A, seq: 1 } }), 'private', 'a page with an epoch')
})
