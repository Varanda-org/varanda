// Flows over the pure group logic (groups.js, groupLink.js, report.js): the
// sequences the Comunidades screens run, with the states the node can answer.
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
  const { joinLink } = await groups()
  const { parseGroupPath, isGroupPath, captureGroupLink } = await links()
  t.is(joinLink(G.toUpperCase()), '/g/' + G, 'built lowercase')
  t.is(parseGroupPath(joinLink(G)), G, 'round trip')
  t.is(parseGroupPath('/g/' + G.toUpperCase()), null, 'the path form is lowercase only')
  for (const bad of ['/g/' + G.slice(1), '/g/' + G + 'a', '/g/zz', '/x/' + G, '/g/' + G + '/extra', '', null, 5]) {
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

const C = '12'.repeat(32)
const fs = require('fs')
const path = require('path')
const screen = (name) => fs.readFileSync(path.join(__dirname, '../src/screens', name), 'utf8')
const ui = (name) => fs.readFileSync(path.join(__dirname, '../src/ui', name), 'utf8')
const appSrc = (name) => fs.readFileSync(path.join(__dirname, '../src', name), 'utf8')

test('create community: Geral is listed first and the creator may add groups', async (t) => {
  const { can, GENERAL_LABEL, reconcile } = await groups()
  t.is(GENERAL_LABEL, 'Geral')
  const info = { community: C, groups: [{ group: G, name: 'Geral', role: 'creator', general: true }], incomplete: false }
  t.is(reconcile({ action: 'create', community: C, name: 'Geral' }, info), 'landed')
  t.ok(can('create', 'creator'))
})

test('join through /c/: the community link parses and a joined role counts as landed', async (t) => {
  const { reconcile, COMMUNITY_JOIN_LABELS } = await groups()
  const { parseCommunityPath, communityLink } = await links()
  t.is(parseCommunityPath(communityLink(C)), C)
  t.is(parseCommunityPath('/g/' + C), null, 'a group link is not a community link')
  t.is(reconcile({ action: 'community-join' }, { role: 'member' }), 'landed')
  t.is(reconcile({ action: 'community-join' }, { role: 'left' }), 'not-landed')
  t.is(reconcile({ action: 'community-join' }, {}), 'unknown')
  t.is(COMMUNITY_JOIN_LABELS.approval, 'entrada com aprovação')
})

test('Novo grupo is offered to the community creator only', async (t) => {
  const { can } = await groups()
  t.ok(can('create', 'creator'), 'creator')
  t.absent(can('create', 'admin'), 'admins moderate but do not create')
  for (const role of ['member', 'requested', 'banned', 'left', 'pending']) t.absent(can('create', role), role)
  t.absent(can('admin', 'admin'), 'only the creator manages admins')
})

test('orphan: the label exists and the screen disables the composer', async (t) => {
  const { ORPHAN_LABEL } = await groups()
  t.is(ORPHAN_LABEL, 'grupo sem comunidade')
  const src = screen('Grupo.js')
  t.ok(src.includes('Este grupo não pertence a nenhuma comunidade.'))
  t.ok(src.includes('&& !orphan'), 'canPost needs a community')
})

test('/g/ for a group this node lacks: the index names the community first', async (t) => {
  const { validGroup } = await import('../src/indexClient.js')
  const body = { kind: 'group', visibility: 'public', join: 'open', name: 'x', creator: ME, rootServed: true, community: C, attached: true, writers: [], next: null, indexing: false, complete: true }
  t.is(validGroup(body).community, C)
  const src = screen('Grupo.js')
  t.ok(src.includes('fetchGroup(group)') && src.includes('onOpenCommunity(key, { group })') && src.includes('shouldRedirectToCommunity'))
  t.ok(src.includes("'entre na comunidade primeiro'") && src.includes('Entrar na comunidade'))
})

test('admin by @nome refuses a non-member before any request', async (t) => {
  const src = screen('ComunidadeInfo.js')
  t.ok(src.includes('Essa pessoa ainda não é membro da comunidade.'))
  t.ok(src.indexOf('isCommunityMember(member)') < src.indexOf("'community.admin'"), 'membership is checked first')
  t.absent(src.includes('community.link'))
})

test('share never renders the URL as text', async (t) => {
  for (const f of ['ComunidadeInfo.js', 'GrupoAjustes.js']) {
    const src = screen(f)
    t.absent(/<Soft>\{(url|link0|path)\}/.test(src), f + ' does not print the link')
    t.ok((f === 'ComunidadeInfo.js' ? appSrc('communityShare.js') : src).includes('Link copiado.'), f)
  }
})

test('uncertain create: reconcile asks the community, never a blind retry', async (t) => {
  const { reconcile } = await groups()
  const change = { action: 'create', community: C, name: 'Novo' }
  t.is(reconcile(change, { community: C, groups: [{ name: 'Novo', role: 'creator' }] }), 'landed')
  t.is(reconcile(change, { community: C, groups: [] }), 'not-landed')
  t.is(reconcile(change, { community: C, groups: [], incomplete: true }), 'unknown')
  t.is(reconcile(change, { community: OTHER, groups: [] }), 'unknown')
})

test('leaving a community asks for the confirm text', async (t) => {
  t.ok(screen('ComunidadeInfo.js').includes('Sair da comunidade encerra sua participação em todos os grupos dela.'))
})

test('a creator leave that waits for group roots asks to leave anyway, skipping only that wait', async (t) => {
  const src = screen('ComunidadeInfo.js')
  t.ok(src.includes("const GROUPS_WAIT = 'aguarde a sincronização dos grupos da comunidade para sair'"))
  t.ok(src.includes('Alguns grupos desta comunidade ainda não chegaram a este aparelho. Sair mesmo assim?'))
  t.ok(src.includes('groups: [GROUPS_WAIT, FORCE_LEAVE_TEXT]'), 'the groups wait has its own text')
  t.ok(src.includes("label: 'Sair mesmo assim'"))
  t.absent(src.includes('force: true'), 'the app never skips every wait at once')
  t.ok(src.includes("label: isMember ? 'Sair' : 'Desistir', run: leave })"), 'the leave button goes through the wait check')
  t.ok(src.includes("label: 'Concluir saída', run: () => mutate('community.leave', { community }) })"), 'finishing a noted leave never forces')
})

test('a creator leave that waits for the community data asks to leave anyway, skipping only that wait', async (t) => {
  const src = screen('ComunidadeInfo.js')
  t.ok(src.includes("const ROOT_WAIT = 'este aparelho ainda não baixou tudo da comunidade: aguarde para sair'"))
  t.absent(src.includes("'aguarde a sincronização da comunidade para sair'"), 'the pending-path refusal is no wait: forcing it would fail the same way')
  t.ok(src.includes("const ROOT_FORCE_LEAVE_TEXT = 'Este aparelho ainda não baixou tudo desta comunidade. Sair mesmo assim? O que ainda não chegou aqui não vai contar.'"))
  t.ok(src.includes('root: [ROOT_WAIT, ROOT_FORCE_LEAVE_TEXT]'), 'the root wait has its own text')
})

test('a creator leave that waits for its other devices asks to leave anyway, skipping only that wait', async (t) => {
  const src = screen('ComunidadeInfo.js')
  t.ok(src.includes("const DEVICES_WAIT = 'aguarde a sincronização dos seus aparelhos nesta comunidade para sair'"))
  t.ok(src.includes("const DEVICES_FORCE_LEAVE_TEXT = 'Outro aparelho seu ainda não terminou de sincronizar esta comunidade. Sair mesmo assim? O que ele fez e ainda não chegou aqui pode deixar de valer.'"))
  t.ok(src.includes('devices: [DEVICES_WAIT, DEVICES_FORCE_LEAVE_TEXT]'), 'the devices wait has its own text')
})

test('each Sair mesmo assim adds its wait to force and a wait already accepted never prompts again', async (t) => {
  const src = screen('ComunidadeInfo.js')
  t.ok(src.includes("if (!err || err.code !== 'USAGE' || err.uncertain === true) return null"), 'only a sure refusal is a wait')
  t.ok(src.includes('return Object.keys(LEAVE_WAITS).find((name) => LEAVE_WAITS[name][0] === err.message) || null'))
  t.ok(src.includes('if (wait === null || (Array.isArray(params.force) && params.force.includes(wait))) throw err'), 'an accepted wait answered again is an error, never a loop')
  t.ok(src.includes("const leaveWith = (accepted) => mutate('community.leave', accepted.length > 0 ? { community, force: accepted } : { community }, () => { setInviting(false); setSection(null); setPanel(null) }, (wait) => setConfirm({"), 'force carries the waits accepted so far; a left member loses the invite form and panels')
  t.ok(screen('Comunidade.js').includes("if (inside(lastRole.current) && role !== null && !inside(role)) setJoinNote('')"), 'the list drops an old join note once the person left')
  t.ok(src.includes('run: () => leaveWith([...accepted, wait])'), 'plus the one just accepted')
  t.ok(src.includes('const leave = () => leaveWith([])'), 'the first try forces nothing')
})

test('a member whose group root has not arrived never loops between Grupo and Comunidade', async (t) => {
  const { shouldRedirectToCommunity, shouldOpenQueued } = await import('../src/groupRedirect.js')
  for (const role of ['creator', 'admin', 'member']) {
    t.absent(shouldRedirectToCommunity({ communityRole: role, refused: false }), role + ' stays on the group')
    // Comunidade seen as a member from the start: the queued group is never pushed back.
    t.absent(shouldOpenQueued({ queued: G, firstRole: role, role }), role + ' arrives as a member')
  }
  t.ok(shouldRedirectToCommunity({ communityRole: 'none', refused: false }), 'a stranger is sent to the community')
  t.ok(shouldRedirectToCommunity({ communityRole: 'member', refused: true }), 'a refused join opens the community')
  t.absent(shouldRedirectToCommunity({ communityRole: undefined, refused: false }), 'unknown role: wait')
  t.ok(shouldOpenQueued({ queued: G, firstRole: 'left', role: 'member' }), 'opens after a join that changed the role')
  t.absent(shouldOpenQueued({ queued: G, firstRole: 'left', role: 'requested' }), 'not before membership')
  t.absent(shouldOpenQueued({ queued: null, firstRole: 'left', role: 'member' }), 'nothing queued')
  t.absent(shouldOpenQueued({ queued: G, firstRole: null, role: 'member' }), 'first answer not seen yet')
})

test('a refused join redirects whatever role the node reports', async (t) => {
  const { shouldRedirectToCommunity } = await import('../src/groupRedirect.js')
  for (const communityRole of ['left', 'none', 'requested', undefined]) {
    t.ok(shouldRedirectToCommunity({ communityRole, refused: true, groupRole: 'left' }), 'refused with ' + communityRole)
  }
  t.absent(shouldRedirectToCommunity({ communityRole: 'none', refused: false, groupRole: 'left' }), 'a left group is not chased')
  t.absent(shouldRedirectToCommunity({ communityRole: 'member', refused: false }), 'a member still stays')
  t.ok(screen('Grupo.js').includes('groupRole: role'))
})

test('an uncertain post blocks a second send until the draft changes or the person asks again', async (t) => {
  const src = screen('Grupo.js')
  t.ok(src.includes('setPostHold(text)'), 'held when uncertain')
  t.ok(src.includes('left < 0 || postHold !== null'), 'Enviar is disabled while held')
  t.ok(src.includes('setDraft(t); setPostHold(null)'), 'editing lifts the hold')
  t.ok(src.includes('Confira se a mensagem já apareceu antes de enviar de novo.'))
  const { reconcile } = await groups()
  const change = { action: 'post', diary: ME, text: 'oi', sentAt: Date.parse('2026-10-31T10:00:10.000Z') }
  t.is(reconcile(change, { items: [], next: cursor(msg(OTHER, 1, 'x')), state: 'ok' }), 'unknown', 'unknown keeps the hold')
})

test('Grupo: bubbles with Responder, Copiar, Esconder, Banir and Denunciar under can(), and a real reply', async (t) => {
  const src = screen('Grupo.js')
  t.ok(src.includes('groupRows(rawItems, ownKey, now)') && src.includes('[rawItems, ownKey, today]'), 'rows come from groupRows and follow the day')
  t.ok(src.includes('<Bubble') && !src.includes('GroupMessageRow'), 'messages are bubbles')
  t.ok(src.includes("label: 'Responder'") && src.includes('setReplyKey(row.key)'), 'Responder sets the reply target')
  t.ok(src.includes("label: 'Copiar'"))
  t.ok(src.includes("label: row.hidden ? 'Mostrar' : 'Esconder'") && src.includes("can('hide', role, { own: mine })"), 'Esconder under can hide')
  t.ok(src.includes("label: 'Banir'") && src.includes("can('ban', role) && !!row.diary && !mine"), 'Banir under can ban, never oneself')
  t.ok(src.includes("label: 'Denunciar'") && src.includes("typeof onReport === 'function' && !!row.diary && !mine && !row.hidden"), 'Denunciar for others only, never a hidden message')
  t.ok(src.includes('replyTo: { writer: replyTo.writer, seq: replyTo.seq }'), 'group.post carries replyTo with exactly writer and seq')
  t.ok(src.includes("request('group.post', params)"))
  t.ok(src.includes("pageStatement('group-post', { group, text })"), 'a page statement keeps its shape')
  t.ok(src.includes('() => sendPost(text, replyTo)'), 'an uncertain retry resends the same reply, only when asked')
  t.ok(src.includes('replyPreview({ replyTo: key }, rawById)'), 'the quote reads only loaded raw items')
  t.ok(src.includes('quote={quote ?'), 'the quote reaches the bubble')
  t.ok(src.includes('reply={replyBar ?') && src.includes('onCancelReply={() => setReplyKey(null)}'), 'the composer shows the reply bar with Cancelar')
  t.ok(src.includes("icon: 'engrenagem', label: 'ajustes do grupo'"), 'one settings icon')
  t.ok(src.includes('<ChatHeader') && src.includes('membersLabel(info.members) || visibilityLabel(info.visibility)'), 'header subtitle is the member count')
  t.absent(/lida|entregue|digitando/i.test(src), 'no read, delivered or typing state')
  const { replyPreview } = await import('../src/group-screen.js')
  const byRef = new Map([[OTHER + ':2', msg(OTHER, 2, 'oi', { name: 'Bia' })], [OTHER + ':3', msg(OTHER, 3, '', { hidden: true })]])
  t.alike(replyPreview({ replyTo: OTHER + ':2' }, byRef), { name: 'Bia', text: 'oi' })
  t.is(replyPreview({ replyTo: OTHER + ':3' }, byRef).name, '', 'a hidden target reveals no name')
  t.is(replyPreview({ replyTo: OTHER + ':9' }, byRef), null, 'an unloaded target shows no quote')
})

test('the open Pedidos and Membros panel reloads with the community version and on refresh', async (t) => {
  const src = screen('ComunidadeInfo.js')
  t.ok(src.includes('loadPeopleRef.current(panelRef.current)'))
  t.ok(src.includes('if (panel) loadPeople(panel) }}'))
  const grupo = screen('Grupo.js')
  t.ok(grupo.includes('lookedUp.current = true') && grupo.indexOf('lookedUp.current = true') > grupo.indexOf('fetchGroup(group)'), 'lookup done only after an answer')
})

test('Comunidade offers Tirar da lista only on repair, never for Geral, behind a plain confirm', async (t) => {
  const src = screen('Comunidade.js')
  t.ok(src.includes('if (info.repair !== true || g.general === true) return <GroupRow'), 'only on repair and never for Geral')
  t.ok(src.includes("mutate('community.removeGroup', { community, group: g.group })"))
  t.ok(src.includes('Tirar este grupo da lista da comunidade? Ele deixa de aparecer aqui e ninguém mais escreve nele.'))
})

test('Comunidade offers Devolver à lista for each dropped group on repair, by name or a neutral label, behind a confirm', async (t) => {
  const src = screen('Comunidade.js')
  t.ok(src.includes('info.repair === true && Array.isArray(info.dropped)'), 'only on repair, from community.info dropped')
  t.ok(src.includes('<SectionHeader>Tirados da lista</SectionHeader>'))
  t.ok(src.includes("requestRef.current('group.info', { group: g })"), 'the name comes from group.info')
  t.ok(src.includes('displayText(droppedNames[g]) : DROPPED_LABEL'), 'a neutral label, never the key')
  t.ok(src.includes("const DROPPED_LABEL = 'Grupo tirado da lista'"))
  t.ok(src.includes("'Devolver este grupo à lista da comunidade?'"))
  t.ok(src.includes("mutate('community.removeGroup', { community, group: g, undo: true })"))
})

test('no em dash in the group screens and modules', async (t) => {
  const bad = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(js|json)$/.test(e.name) && fs.readFileSync(p, 'utf8').includes('\u2014')) bad.push(p)
    }
  }
  walk(path.join(__dirname, '../src/screens'))
  for (const f of ['groups.js', 'groupLink.js', 'indexClient.js', 'nav.js', 'tabs.js']) if (fs.readFileSync(path.join(__dirname, '../src', f), 'utf8').includes('\u2014')) bad.push(f)
  t.alike(bad, [])
})

test('the Comunidades tab has no paste field and the link parsers are gone', async (t) => {
  const src = screen('Comunidades.js')
  for (const gone of ['Entrar por link', 'parseEntry', 'parseJoinLink', 'parseCommunityJoinLink']) t.absent(src.includes(gone), gone)
  t.ok(src.includes('Crie uma comunidade, busque um grupo público ou abra o link de convite que alguém da comunidade mandou.'))
  const g = await groups()
  t.is(g.parseJoinLink, undefined)
  t.is(g.parseCommunityJoinLink, undefined)
})

test('a non-member sees an invite card with one join button, from the index too', async (t) => {
  const src = screen('Comunidade.js')
  t.ok(src.includes("const JOIN_PUBLIC_TEXT = 'Participar é público: sua entrada fica registrada no seu diário.'"))
  t.ok(src.includes("v.state === 'pending'") && src.includes('setJoinNote(JOIN_PENDING_TEXT)'))
  const a = src.indexOf('if (fromIndex) {')
  const fromIndex = src.slice(a, src.indexOf('} else if (info === null', a))
  t.ok(fromIndex.includes('<JoinCard') && fromIndex.includes('note={joinNote}') && fromIndex.includes('{checkBox}'))
  t.ok(src.includes("{ icon: 'compartilhar', label: 'Compartilhar', onPress: share }"), 'Compartilhar stays for everyone, as a header icon')
  t.absent(fromIndex.includes("label='Compartilhar'"), 'no second share button in the body')
  t.absent(fromIndex.includes("label='Entrar'"), 'the only join button is in the card')
  const held = src.slice(src.indexOf('const joinable ='))
  t.ok(held.includes('<JoinCard'), 'the held path keeps the invite card')
  const info = screen('ComunidadeInfo.js')
  t.ok(info.includes("label='Compartilhar'") && !info.includes('<JoinCard'), 'Compartilhar moved to the info screen, which never joins')
  t.absent(held.includes('joinWord') || held.includes("label='Entrar'") || held.includes("'Pedir entrada'"), 'no second join button beside the card')
})

test('invite by @nome: lookup before send, inviteText, the can gate, and no send from an effect', async (t) => {
  const com = screen('ComunidadeInfo.js')
  const inv = ui('InviteByName.js')
  const set = screen('GrupoAjustes.js')
  t.ok(inv.indexOf("'dm.lookup'") !== -1 && inv.indexOf("'dm.lookup'") < inv.indexOf("'dm.send'"), 'lookup comes before send')
  t.ok(inv.includes('INVITE_NO_DM') && inv.includes('INVITE_UNSURE') && inv.includes('INVITE_SENT'))
  t.ok(com.includes('inviteText({') && com.includes('<SectionHeader>Convidar</SectionHeader>'))
  t.ok(com.includes("can('invite', role, { memberInvite: info.memberInvite === true })"))
  t.ok(set.includes('inviteText({') && set.includes('<InviteByName') && set.includes('<SectionHeader>Convidar para o grupo</SectionHeader>'))
  t.ok(set.includes("can('invite', role, { memberInvite: info.memberInvite === true })"))
  t.ok(set.includes("request('community.info'"))
  t.ok(inv.includes("label='Tentar de novo'") && inv.includes('deliver(held.to, held.text, false, held.label)'), 'retry resends the same text, once, on a tap')
  for (const [name, src] of [['Comunidade.js', screen('Comunidade.js')], ['ComunidadeInfo.js', com], ['GrupoAjustes.js', set], ['ui/InviteByName.js', inv]]) {
    let at = src.indexOf('useEffect(')
    while (at !== -1) {
      const end = src.indexOf('\n  }, [', at)
      t.absent(src.slice(at, end === -1 ? at + 400 : end).includes("'dm.send'"), name + ': dm.send never runs in an effect')
      at = src.indexOf('useEffect(', at + 1)
    }
  }
})

test('invite by @nome: membership asked of the node, and a send cancels pending lookups', async (t) => {
  const com = screen('ComunidadeInfo.js')
  const set = screen('GrupoAjustes.js')
  const byName = ui('InviteByName.js')
  const inv = byName.slice(byName.indexOf('export function InviteByName'), byName.indexOf('return (', byName.indexOf('const invite = (member')))
  t.ok(inv.includes('isMember') && inv.indexOf('await isMember(to)') !== -1 && inv.indexOf('await isMember(to)') < inv.indexOf("'dm.lookup'"), 'isMember is awaited before dm.lookup')
  t.absent(inv.includes('isKnownMember'), 'no panel-bound member check')
  t.ok(com.includes('isMember={(m) => isCommunityMember(m)}'), 'Comunidade reuses isCommunityMember')
  t.ok(set.includes('isMember={isGroupMember}') && set.includes("request('group.members', { group, offset: page * PAGE, limit: PAGE })") && set.includes('page < 20'), 'GrupoAjustes pages group.members')
  const deliver = inv.slice(inv.indexOf('const deliver ='), inv.indexOf('const invite ='))
  t.ok(deliver.indexOf('resolveGen.current++') !== -1 && deliver.indexOf('resolveGen.current++') < deliver.indexOf('send.run('), 'a send starts by invalidating lookups')
  const sent = deliver.indexOf('setResult(INVITE_SENT)')
  t.ok(deliver.lastIndexOf('resolveGen.current++', sent) > deliver.indexOf('send.run('), 'success invalidates lookups too')
  const typing = inv.slice(inv.indexOf('const typeInput ='), inv.indexOf('const find ='))
  t.ok(typing.includes('editGen.current++'), 'typing bumps editGen')
  t.ok(deliver.indexOf('const edit = editGen.current') !== -1 && deliver.indexOf('const edit = editGen.current') < deliver.indexOf('send.run('), 'the tap reads editGen')
  const guard = deliver.indexOf('if (editGen.current === edit) {')
  const after = deliver.slice(deliver.indexOf('send.run('))
  const unguarded = after.slice(0, after.indexOf('if (editGen.current === edit) {')) + after.slice(after.indexOf('}', after.indexOf('search.clear()')))
  t.ok(guard > deliver.indexOf('send.run(') && guard < sent, 'success checks the edit generation')
  for (const clear of ["setInput('')", 'setCandidate(null)', 'search.clear()', 'setResolving(false)', 'resolveGen.current++']) t.absent(unguarded.includes(clear), clear + ' only when nothing was typed during the send')
  t.ok(deliver.slice(guard).includes('setResult(INVITE_SENT)'), 'the sent note always shows')
  t.ok(unguarded.includes('sentTo(who)'), 'after an edit the note names who got the invite')
  t.ok(deliver.includes("const who = editGen.current !== edit && typeof label === 'string' && label !== '' ? label : null"), 'a name only when the draft changed during the send')
  for (const note of ["who + ' ainda não usa as Conversas.", "who + ' já é membro.'", "'Não deu para confirmar se o convite para ' + who"]) t.ok(deliver.includes(note), 'named after an edit: ' + note)
  t.ok(byName.includes("const sentTo = (label) => 'Convite enviado para ' + label + ' pelas Conversas.'"), 'the named note')
  t.ok(deliver.includes('setHeld({ to, text, label })') && byName.includes('deliver(held.to, held.text, false, held.label)'), 'Tentar de novo keeps the name')
  t.ok(byName.includes('invite(candidate.member, candidate.label)') && byName.includes('invite(hit.author, label)'), 'every invite carries the name shown')
})

test('the community list opens the info screen and shows the newest line and unread count', async (t) => {
  const src = screen('Comunidade.js')
  t.ok(src.includes('onOpenInfo(community)'), 'the top bar opens Informações')
  t.ok(src.includes('lastLine(last)'), 'the newest message line')
  t.ok(src.includes("const own = line !== '' && lastIsOwn(last)") && src.includes('own={own}'), 'the own marker only on the last-message line')
  t.ok(src.includes("<Text style={styles.own}>{OWN_LABEL + ': '}</Text>"), 'the own marker is drawn apart from the line text')
  t.ok(src.includes("own: { color: colors.accent, fontWeight: '600' }"), 'styles.own')
  t.ok(src.includes("title={pending ? (indexName || 'Comunidade ainda chegando') : title}"), 'a pending community shows the index name when known')
  t.ok(src.includes("const indexName = idx.status === 'done' && needIndex && typeof idx.name === 'string' && idx.name !== ''"), 'the index name only from a finished index read, never a null name')
  t.ok(src.includes('unreadLabel(g.unread)'), 'the unread count')
  t.ok(src.includes("' não lidas'"), 'the row reads the count aloud')
  t.absent(src.includes('Sair mesmo assim'), 'leaving lives on the info screen')
  for (const gone of ['<InviteByName', "'community.admin'", "'community.leave'", "'community.invitePolicy'", "'community.members'"]) t.absent(src.includes(gone), gone)
  t.ok(src.includes('const lastSeen = useRef(seenTick)') && src.includes('was === false && isTop === true'), 'returning from a group re-reads the counts')
})

test('the info screen holds the leave path and never joins', async (t) => {
  const src = screen('ComunidadeInfo.js')
  t.ok(src.includes('Sair mesmo assim'))
  t.ok(src.includes('Concluir saída'))
  t.absent(src.includes('<JoinCard'))
  t.absent(src.includes("'community.join'"))
  t.ok(src.includes("import { InviteByName } from '../ui/InviteByName'"))
  t.ok(screen('GrupoAjustes.js').includes("import { InviteByName } from '../ui/InviteByName'"))
})

test('Grupo marks the group seen from one place, never from load, loadOlder or readNewest', async (t) => {
  const src = screen('Grupo.js')
  const first = src.indexOf("'group.seen'")
  t.ok(first !== -1 && src.indexOf("'group.seen'", first + 1) === -1, 'exactly once')
  const mark = src.slice(src.indexOf('const markSeen = useCallback('), src.indexOf('const load = useCallback('))
  t.ok(mark.includes("'group.seen'"), 'only markSeen calls it')
  const load = src.slice(src.indexOf('const load = useCallback('), src.indexOf('const loadRef = useRef(load)'))
  t.absent(load.includes('markSeen') || load.includes('group.seen'), 'a reload never marks by itself')
  t.ok(load.indexOf('paintedRef.current = mine') > load.indexOf('await readNewest()'), 'load records the read that painted')
  const olderAt = src.indexOf('const loadOlder = useCallback(')
  const older = src.slice(olderAt, src.indexOf('}, [readGroup, loadingMore, readNewest])', olderAt))
  t.ok(older.length > 0, 'loadOlder found')
  t.absent(older.includes('group.seen') || older.includes('markSeen'), 'not from loadOlder')
  const newestAt = src.indexOf('const readNewest = useCallback(')
  const newest = src.slice(newestAt, src.indexOf('}, [readGroup, commitRead, asPage.page])', newestAt))
  t.ok(newest.length > 0, 'readNewest found')
  t.absent(newest.includes('group.seen') || newest.includes('markSeen'), 'not from readNewest')
})

test('Grupo marks up to the newest painted row, never past it', async (t) => {
  const src = screen('Grupo.js')
  const mark = src.slice(src.indexOf('const markSeen = useCallback('), src.indexOf('const load = useCallback('))
  t.ok(mark.includes("request('group.seen', { group, upTo })"), 'sends the cut-off')
  const call = mark.indexOf("'group.seen'")
  t.ok(mark.indexOf('const upTo = cutRef.current') !== -1 && mark.indexOf('const upTo = cutRef.current') < call, 'reads the cut-off first')
  t.ok(mark.indexOf('if (upTo === null) return') !== -1 && mark.indexOf('if (upTo === null) return') < call, 'no cut-off: no request')
  t.absent(mark.includes('{ group })'), 'never a bare mark')
  const cut = src.slice(src.indexOf('const last = '), src.indexOf('const visible = node.visible !== false'))
  t.ok(cut.includes('rows[rows.length - 1]'), 'newest painted row')
  t.ok(cut.includes('cutRef.current = '), 'assigned every render')
  t.ok(cut.includes('{ at: last.at, writer: last.writer, seq: last.seq }'), 'cut-off shape')
  t.absent(cut.includes('rawItems') || cut.includes('hidden'), 'painted rows only, hidden ones kept')
})

test('Grupo marks only what shows: visible, on top, a reader, the latest read painted', async (t) => {
  const src = screen('Grupo.js')
  t.ok(src.includes('const visible = node.visible !== false'), 'follows the app visibility, as Mensagem')
  const effect = src.slice(src.indexOf('const visible = node.visible !== false'), src.indexOf('}, [asPage.page, visible, isTop, reader, lastId, loadedAt, loadError, markSeen])'))
  t.ok(effect.includes('if (asPage.page) return'), 'reading as a page never marks')
  t.ok(effect.includes("if (!visible || !isTop || !reader || lastId === null || loadedAt === null || loadError !== '') return"), 'hidden, buried, non-reader, empty, unloaded or failed: no mark')
  t.ok(src.indexOf('const lastId = ') < src.indexOf('const visible = node.visible !== false'), 'keyed on the newest message on screen, so any paint marks')
  t.ok(effect.includes('if (paintedRef.current !== seqRef.current) return'), 'a read in flight: no mark')
  t.ok(effect.indexOf('markSeen()') > effect.indexOf('if (paintedRef.current !== seqRef.current) return'), 'marks after both gates')
  t.absent(effect.includes('loadRef.current()'), 'no reload on uncover: the older pages stay')
  const app = fs.readFileSync(path.join(__dirname, '../App.js'), 'utf8')
  t.ok(/<Grupo group=\{entry\.key\} isTop=\{i === stack\.length - 1\}/.test(app), 'App passes isTop to Grupo')
})

test('Grupo tells the caller after every group.seen attempt, failed ones too', async (t) => {
  const src = screen('Grupo.js')
  const mark = src.slice(src.indexOf('const markSeen = useCallback('), src.indexOf('const load = useCallback('))
  const seen = mark.slice(mark.indexOf("'group.seen'"))
  const fin = seen.indexOf('} finally {')
  t.ok(fin !== -1 && seen.indexOf('onSeenRef.current(group)') > fin, 'onSeen runs in finally')
  t.absent(seen.slice(0, fin).includes('onSeenRef.current(group)'), 'not only on success')
})

test('Comunidade re-reads on any group version change, even when the list changed too', async (t) => {
  const src = screen('Comunidade.js')
  t.ok(src.includes("g.group + ':' + node.getGroupVersion(g.group)"), 'key:version pairs')
  t.ok(src.includes('if (lastGroupVersions.current === groupVersions) return'), 'returns only when nothing moved')
  t.absent(src.includes('was.keys !== groupKeys'), 'no early return on a key-set change')
})

test('a pending community still opens Informações, which shares it without member actions', async (t) => {
  const src = screen('Comunidade.js')
  const line = src.split('\n').find((l) => l.includes('const canInfo ='))
  t.ok(line && !line.includes("'pending'"), 'onOpenInfo is not gated on state')
  const info = screen('ComunidadeInfo.js')
  t.ok(info.includes("const header = pending ? '' :"), 'no meta for a pending answer')
  t.ok(info.includes('Aguardando a sincronização desta comunidade.'))
  t.ok(info.includes(": 'Comunidade'"), 'title fallback')
  const { can } = await groups()
  for (const action of ['invite', 'invitePolicy', 'admin', 'meta']) t.absent(can(action, 'pending', { memberInvite: true }), action + ' not for pending')
  t.ok(info.includes("const isMember = role === 'creator' || role === 'admin' || role === 'member'"), 'leave only for members')
})

test('Grupo: a reply survives a refresh and a confirmed uncertain send clears it', (t) => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/screens/Grupo.js'), 'utf8')
  t.ok(src.includes('/^([0-9a-f]{64}):([1-9][0-9]*)$/.exec(replyKey)'), 'the target comes from the key, not the loaded pages')
  t.ok(src.includes('(quoteOf(replyKey) || replyQuote)'), 'the reply bar keeps the quote taken at Responder')
  t.ok(src.includes("if (typeof change.replyKey === 'string') setReplyKey((k) => (k === change.replyKey ? null : k))"), 'a landed reply leaves reply mode')
})

test('Grupo: an own quote reads Você and a peer named Você never does', (t) => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/screens/Grupo.js'), 'utf8')
  t.ok(src.includes('name: mine && target.hidden !== true ? OWN_LABEL : peerQuoted'))
  t.ok(src.includes("const peerQuoted = readsAs(peerName, OWN_LABEL) ? (peerHandle || 'Pessoa') : peerName"))
  t.ok(src.includes('handle: mine || !target || target.hidden === true ? undefined : (peerHandle || undefined)'), 'a peer quote carries the verified @nome')
  t.ok(src.includes("const who = known.title === UNNAMED ? { ...known, title: 'Pessoa' } : known"), 'nothing known reads Pessoa, not sem nome')
})

test('Grupo: the verified handle rides beside the name and Copiar copies what is shown', (t) => {
  const fs = require('fs')
  const path = require('path')
  const src = fs.readFileSync(path.join(__dirname, '../src/screens/Grupo.js'), 'utf8')
  const bubble = fs.readFileSync(path.join(__dirname, '../src/ui/Bubble.js'), 'utf8')
  const dm = fs.readFileSync(path.join(__dirname, '../src/screens/Mensagem.js'), 'utf8')
  t.ok(src.includes('handle={mine ? undefined : who.subtitle}'))
  t.ok(bubble.includes("{' ' + displayText(handle)}"), 'the bubble draws the @nome')
  t.ok(src.includes('copyText(shareNav(), displayText(row.rawText, { multiline: true }))'))
  t.ok(dm.includes('copyText(shareNav(), displayText(item.rawText, { multiline: true }))'))
})

test('Grupo: mentions are tappable and the composer suggests pages with a chip', (t) => {
  const fs = require('fs')
  const path = require('path')
  const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8')
  t.ok(read('../src/screens/Grupo.js').includes("onOpenMention={typeof onOpenMention === 'function' ? onOpenMention : undefined}"))
  t.ok(read('../App.js').includes('onOpenMember={openMember} onOpenMention={mentionHandler} onReport={setReport} onSeen={bumpSeen}'))
  t.ok(read('../src/ui/ChatComposer.js').includes('mergeSuggestions(search.hits, [], mentionQuery'))
  t.ok(read('../src/screens/Publicar.js').includes('mergeSuggestions(search.hits, [], mentionQuery'))
  t.ok(read('../src/ui/MentionSuggest.js').includes("hit.chipLabel || 'Página'"))
})

test('Grupo sends photos through the composer flow and renders them with ChatMedia', (t) => {
  const src = screen('Grupo.js')
  t.ok(src.includes("import { ChatMedia } from '../ui/ChatMedia'"))
  t.ok(src.includes("chatMediaRefs('group', { diary: rawRow.diary, media: rawRow.media })"), 'refs from the raw group.read item')
  t.ok(src.includes('...(sealed ? { sealed: true } : {})'), 'a private group seals its uploads')
  t.ok(src.includes('retryChatSend({ op: held.op, request, onPhase: setMediaSend })'), 'the retry resends the held op')
  t.ok(src.includes('...(isPrivate && Array.isArray(raw.media) ? { media: raw.media } : {})'), 'report media only for a private group')
  t.absent(/https?:\/\//.test(ui('ChatMedia.js')), 'no http(s) source in ChatMedia')
  t.absent(/https?:\/\//.test(ui('AttachSheet.js')), 'no http(s) source in AttachSheet')
  t.ok(ui('AttachSheet.js').includes("{ key: 'gif', label: 'GIF', icon: 'imagem', planned: true }"), 'GIF slot kept, not shown')
  t.ok(ui('ChatComposer.js').includes("accessibilityLabel='Anexar'"))
  t.ok(ui('ChatComposer.js').includes("accessibilityLabel='Remover foto'"))
  for (const f of ['Grupo.js']) for (const w of ['lida', 'entregue', 'digitando']) t.absent(screen(f).includes(w), f + ': ' + w)
  const app = fs.readFileSync(path.join(__dirname, '../App.js'), 'utf8')
  t.ok(/useEffect\(\(\) => \{[^}]*clearChatMedia\(\)[^}]*\}, \[generation, locked\]\)/.test(app), 'cleared on lock and sign-out')
})

test('chatSend layout of 1 to 4 photos stays within 240 pt', async (t) => {
  const { chatMediaLayout } = await import('../src/chatSend.js')
  for (let n = 1; n <= 4; n++) {
    const l = chatMediaLayout(Array.from({ length: n }, () => ({ w: 800, h: 600 })))
    t.is(l.cells.length, n)
    t.ok(l.width <= 240)
  }
})

test('mediaPostLanded confirms an uncertain photo post only by text, reply and media identity', async (t) => {
  const { mediaPostLanded } = await import('../src/chatSend.js')
  const me = 'a'.repeat(64)
  const core = 'c'.repeat(64)
  const sentAt = Date.parse('2026-11-06T10:00:00.000Z')
  const pub = [{ core, start: 5, mime: 'image/jpeg' }]
  const sealed = [{ core, start: 9, key: 'k', sha256: 'f'.repeat(64) }]
  const at = '2026-11-06T10:00:01.000Z'
  const view = (items, next = null) => ({ items, next, state: 'ok' })
  const change = { diary: me, text: 'oi', sentAt, replyKey: null, media: pub }
  t.is(mediaPostLanded(change, view([{ diary: me, text: 'oi', at, media: [{ core, start: 5 }] }])), 'landed')
  t.is(mediaPostLanded(change, view([{ diary: me, text: 'oi', at, media: [{ core, start: 6 }] }])), 'not-landed', 'other photos')
  t.is(mediaPostLanded(change, view([{ diary: me, text: 'oi', at: '2026-11-06T09:00:00.000Z', media: [{ core, start: 5 }] }])), 'not-landed', 'older post')
  t.is(mediaPostLanded(change, view([{ diary: 'b'.repeat(64), text: 'oi', at, media: [{ core, start: 5 }] }])), 'not-landed', 'someone else')
  t.is(mediaPostLanded(change, view([], 'cursor')), 'unknown', 'a partial read proves nothing')
  const sc = { ...change, media: sealed }
  t.is(mediaPostLanded(sc, view([{ diary: me, text: 'oi', at, media: [{ core, start: 1, key: 'x', sha256: 'f'.repeat(64) }] }])), 'landed', 'sealed by sha256')
  t.is(mediaPostLanded({ ...change, replyKey: me + ':3' }, view([{ diary: me, text: 'oi', at, media: [{ core, start: 5 }] }])), 'not-landed', 'reply must match')
})

test('Grupo reconciles an uncertain photo post and binds its retry to the acting identity', (t) => {
  const src = screen('Grupo.js')
  t.ok(src.includes('mediaPostLanded({ diary: ownKey, text: held.text, sentAt: held.sentAt, replyKey: held.replyKey, media: held.op.params.media }, read)'))
  t.ok(src.includes("if (await mediaLanded(held) === 'landed')"), 'the retry checks first')
  t.ok(src.includes('if (held.acting !== actingIdRef.current)'), 'a retry as another identity is refused')
  t.ok(/useEffect\(\(\) => \{\n {4}if \(sendTokenRef\.current\) sendTokenRef\.current\.live = false[\s\S]{0,200}setMediaHold\(null\)[\s\S]{0,200}\}, \[actingId\]\)/.test(src), 'switching identity drops the held post')
  t.ok(src.includes("{mediaHold.checking ? null : <Pill label='tentar de novo'"), 'no retry while checking')
})

test('a stale pick is dropped and a long press on a photo opens the bubble actions', (t) => {
  const sheet = ui('AttachSheet.js')
  const gen = sheet.indexOf('const gen = genRef.current')
  const pick = sheet.indexOf('picked = await pickImages()')
  t.ok(gen > 0 && gen < pick, 'the generation is taken before the picker opens')
  t.ok(sheet.includes('if (gen !== genRef.current) return\n    if (!Array.isArray(picked)'), 'a stale result is dropped')
  t.ok(sheet.includes('revokeUrl(thumb)\n        continue'), 'a thumbnail made for a stale item is released')
  const media = ui('ChatMedia.js')
  t.is(media.split('onLongPress={onLongPress}').length - 1, 6, 'cells forward the long press (shown, tap to load, retry, and the voice cell twice)')
  t.ok(ui('Bubble.js').includes('cloneElement(media, { onLongPress: () => setOpen(true) })'))
})

test('Grupo sends a voice note through the composer flow and the bubble plays only local sources', (t) => {
  const src = screen('Grupo.js')
  t.ok(src.includes("import { composePlan, stagedVoice } from '../attach-plan'"))
  t.ok(src.includes('attachments: [stagedVoice(recording)]'), 'one voice item through composePlan')
  t.ok(src.includes("width: 0, height: 0, ms: f.ms, kind: 'voice', ...(sealed ? { sealed: true } : {})"), 'the group media path, sealed when private')
  t.ok(src.includes('onVoice={isTop && mediaApi !== null && canPost'), 'the microphone only where media can be posted, and only on top')
  const composer = ui('ChatComposer.js')
  t.ok(composer.includes("typeof onVoice === 'function' && online && editable && !sending && canRecordMp4()"), 'mic hidden without the capability')
  t.absent(/s[óo] na (vers[ãa]o )?web/i.test(composer), 'no web-only note')
  t.absent(composer.includes('Platform.OS === \'web\''), 'capability, not platform')
  for (const label of ["'Gravar mensagem de voz'", "'Parar'", "'Cancelar'", 'deslize para cancelar']) t.ok(composer.includes(label), label)
  t.ok(composer.includes('cancelRecording()'), 'a recording is dropped on leave, lock and background')
  t.ok(composer.includes("AppState.addEventListener('change'"))
  const bubble = ui('VoiceBubble.js')
  t.absent(/https?:\/\//.test(bubble), 'no http(s) literal in VoiceBubble')
  t.ok(bubble.includes("import { claimPlayback } from '../media/chatMedia'"), 'one active player at a time')
  t.ok(bubble.includes('createPlayer(uri)'))
  for (const label of ["'Reproduzir'", "'Pausar'", "'Mensagem de voz'", "'Mídia indisponível'"]) t.ok(bubble.includes(label), label)
  t.absent(/expo-av|react-native-sound|react-native-track-player|howler/.test(bubble), 'no third-party player')
  t.absent(/setTotal|p\.durationMs/.test(bubble), 'the total never comes from the player')
  t.ok(bubble.includes('const total = checkedMs(durationMs)'), 'the total is the checked item ms')
  t.ok(bubble.includes('Math.min(Math.round(ms), rpc.MAX_AUDIO_MS)'), 'no total above MAX_AUDIO_MS')
  t.ok(bubble.includes('stopAt.current = (total > 0 ? total : rpc.MAX_AUDIO_MS) + rpc.AUDIO_MS_TOLERANCE'), 'playback bound by the checked ms')
  t.ok(bubble.includes('const over = Number.isFinite(p.ms) ? p.ms > stopAt.current : deadline.current > 0 && Date.now() >= deadline.current\n      if (over && p.ended !== true) player.pause()'), 'the player pauses past the bound, by the wall clock when it reports no position')
  // The wall-clock backstop: armed by play() for the time left to the bound,
  // it pauses, rewinds and releases the claim even if no progress event comes.
  const toggle = bubble.slice(bubble.indexOf('const toggle = () =>'), bubble.indexOf('const seek = (event) =>'))
  t.ok(toggle.indexOf('startBackstop()') > 0 && toggle.indexOf('startBackstop()') < toggle.indexOf('player.play()'), 'play() arms the backstop')
  t.ok(toggle.includes('clearBackstop()\n      player.pause()'), 'a pause clears it')
  t.ok(bubble.includes('const left = Math.max(0, stopAt.current - posRef.current)\n    deadline.current = Date.now() + left\n    backstop.current = setTimeout(() => stopRef.current(), left)'), 'the timer runs for the time left to the bound')
  t.ok(bubble.includes('stopRef.current = () => {\n      player.pause()\n      finish()'), 'when it fires the note pauses')
  const finish = bubble.slice(bubble.indexOf('const finish = () =>'), bubble.indexOf('stopRef.current = () => {'))
  for (const step of ['clearBackstop()', 'setPos(0)', 'player.seek(0)', 'releaseClaim.current()']) t.ok(finish.includes(step), 'finish: ' + step)
  t.ok(bubble.includes('if (p.ended === true || over) {\n        finish()'), 'ended or over clears the backstop')
  t.ok(bubble.includes('claimRef.current = { pause: () => { clearBackstop(); player.pause() } }') && bubble.includes('claimPlayback(claimRef.current)'), 'a pause by another note clears it')
  const cleanup = bubble.slice(bubble.indexOf('return () => {\n      off()'), bubble.indexOf('}, [state, uri])'))
  t.ok(cleanup.includes('clearBackstop()') && cleanup.includes('player.release()'), 'release and unmount clear it')
  t.ok(bubble.includes('if (backstop.current !== null) startBackstop()'), 'a seek while playing re-arms it from the new position')
  t.ok(bubble.includes('durationLabel(shown)') && bubble.includes('const shown = Math.min(pos, '), 'the elapsed time never passes the total')
  t.ok(ui('ChatMedia.js').includes('<VoiceBubble'), 'ChatMedia renders a voice item as a VoiceBubble')
  for (const f of ['ChatComposer.js', 'VoiceBubble.js']) t.absent(ui(f).includes('\u2014'), f)
})

test('voice: one recording object per gesture, a move only updates the slide offset', (t) => {
  const composer = ui('ChatComposer.js')
  const setDx = composer.slice(composer.indexOf('const setDx = (next) =>'), composer.indexOf('return { rec, dx, elapsed'))
  t.ok(setDx.length > 0, 'setDx found')
  t.absent(setDx.includes('update('), 'a move never replaces the recording object')
  t.ok(setDx.includes('setDxValue(next)'), 'the offset lives apart')
  t.absent(/\bdx: 0\b/.test(composer), 'no dx in the recording object')
  t.ok(composer.includes('if (recRef.current !== r || !alive.current)'), 'begin still reads a replaced object as a cancel')
  t.ok(composer.includes('translateX: Math.min(0, voice.dx) / 2'))
})

test('voice: lock and background stop playback; lock sweeps the recorder cache', (t) => {
  const app = fs.readFileSync(path.join(__dirname, '../App.js'), 'utf8')
  t.ok(app.includes("import { clearChatMedia, onAppStateChange, stopPlayback } from './src/media/chatMedia'"))
  t.ok(app.includes("import { sweepVoiceCache } from './src/media/audio'"))
  t.ok(/useEffect\(\(\) => \{\n {4}stopPlayback\(\)\n {4}clearChatMedia\(\)\n {4}sweepVoiceCache\(\)\n {2}\}, \[generation, locked\]\)/.test(app), 'the lock effect')
  t.ok(app.includes("if (state === 'background') stopPlayback()\n      onAppStateChange(state, { canClear: true })"), 'background')
})
