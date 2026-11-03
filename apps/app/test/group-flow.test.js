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

const C = '12'.repeat(32)
const fs = require('fs')
const path = require('path')
const screen = (name) => fs.readFileSync(path.join(__dirname, '../src/screens', name), 'utf8')

test('create community: Geral is listed first and the creator may add groups', async (t) => {
  const { can, GENERAL_LABEL, reconcile } = await groups()
  t.is(GENERAL_LABEL, 'Geral')
  const info = { community: C, groups: [{ group: G, name: 'Geral', role: 'creator', general: true }], incomplete: false }
  t.is(reconcile({ action: 'create', community: C, name: 'Geral' }, info), 'landed')
  t.ok(can('create', 'creator'))
})

test('join through /c/: the community link parses and a joined role counts as landed', async (t) => {
  const { parseCommunityJoinLink, reconcile, COMMUNITY_JOIN_LABELS } = await groups()
  t.is(parseCommunityJoinLink('https://varanda.app/c/' + C), C)
  t.is(parseCommunityJoinLink('/g/' + C), null, 'a group link is not a community link')
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
  const src = screen('Comunidade.js')
  t.ok(src.includes('Essa pessoa ainda não é membro da comunidade.'))
  t.ok(src.indexOf('isCommunityMember(member)') < src.indexOf("'community.admin'"), 'membership is checked first')
  t.absent(src.includes('community.link'))
})

test('share never renders the URL as text', async (t) => {
  for (const f of ['Comunidade.js', 'GrupoAjustes.js']) {
    const src = screen(f)
    t.absent(/<Soft>\{(url|link0|path)\}/.test(src), f + ' does not print the link')
    t.ok(src.includes('Link copiado.'), f)
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
  t.ok(screen('Comunidade.js').includes('Sair da comunidade encerra sua participação em todos os grupos dela.'))
})

test('a creator leave that waits for group roots asks to leave anyway, skipping only that wait', async (t) => {
  const src = screen('Comunidade.js')
  t.ok(src.includes("const GROUPS_WAIT = 'aguarde a sincronização dos grupos da comunidade para sair'"))
  t.ok(src.includes('Alguns grupos desta comunidade ainda não chegaram a este aparelho. Sair mesmo assim?'))
  t.ok(src.includes('groups: [GROUPS_WAIT, FORCE_LEAVE_TEXT]'), 'the groups wait has its own text')
  t.ok(src.includes("label: 'Sair mesmo assim'"))
  t.absent(src.includes('force: true'), 'the app never skips every wait at once')
  t.ok(src.includes("label: isMember ? 'Sair' : 'Desistir', run: leave })"), 'the leave button goes through the wait check')
  t.ok(src.includes("label: 'Concluir saída', run: () => mutate('community.leave', { community }) })"), 'finishing a noted leave never forces')
})

test('a creator leave that waits for the community data asks to leave anyway, skipping only that wait', async (t) => {
  const src = screen('Comunidade.js')
  t.ok(src.includes("const ROOT_WAIT = 'este aparelho ainda não baixou tudo da comunidade: aguarde para sair'"))
  t.absent(src.includes("'aguarde a sincronização da comunidade para sair'"), 'the pending-path refusal is no wait: forcing it would fail the same way')
  t.ok(src.includes("const ROOT_FORCE_LEAVE_TEXT = 'Este aparelho ainda não baixou tudo desta comunidade. Sair mesmo assim? O que ainda não chegou aqui não vai contar.'"))
  t.ok(src.includes('root: [ROOT_WAIT, ROOT_FORCE_LEAVE_TEXT]'), 'the root wait has its own text')
})

test('a creator leave that waits for its other devices asks to leave anyway, skipping only that wait', async (t) => {
  const src = screen('Comunidade.js')
  t.ok(src.includes("const DEVICES_WAIT = 'aguarde a sincronização dos seus aparelhos nesta comunidade para sair'"))
  t.ok(src.includes("const DEVICES_FORCE_LEAVE_TEXT = 'Outro aparelho seu ainda não terminou de sincronizar esta comunidade. Sair mesmo assim? O que ele fez e ainda não chegou aqui pode deixar de valer.'"))
  t.ok(src.includes('devices: [DEVICES_WAIT, DEVICES_FORCE_LEAVE_TEXT]'), 'the devices wait has its own text')
})

test('each Sair mesmo assim adds its wait to force and a wait already accepted never prompts again', async (t) => {
  const src = screen('Comunidade.js')
  t.ok(src.includes("if (!err || err.code !== 'USAGE' || err.uncertain === true) return null"), 'only a sure refusal is a wait')
  t.ok(src.includes('return Object.keys(LEAVE_WAITS).find((name) => LEAVE_WAITS[name][0] === err.message) || null'))
  t.ok(src.includes('if (wait === null || (Array.isArray(params.force) && params.force.includes(wait))) throw err'), 'an accepted wait answered again is an error, never a loop')
  t.ok(src.includes("const leaveWith = (accepted) => mutate('community.leave', accepted.length > 0 ? { community, force: accepted } : { community }, null, (wait) => setConfirm({"), 'force carries the waits accepted so far')
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

test('the open Pedidos and Membros panel reloads with the community version and on refresh', async (t) => {
  const src = screen('Comunidade.js')
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
