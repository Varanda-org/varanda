'use strict'

const test = require('brittle')
const load = () => import('../src/group-screen.js')
const A = 'ab'.repeat(32)
const B = 'cd'.repeat(32)
const C = 'ef'.repeat(32)
const start = new Date(2026, 9, 10, 12).getTime()
const message = (writer, seq, offset = 0, extra = {}) => ({
  writer,
  diary: writer,
  seq,
  at: new Date(start + offset).toISOString(),
  text: 'Olá',
  ...extra
})

test('groupRows keeps oldest first, stable keys and the input unchanged', async (t) => {
  const { groupRows } = await load()
  const items = Object.freeze([
    Object.freeze(message(B, 1, 2000)),
    Object.freeze(message(A, 2, 1000)),
    Object.freeze(message(A, 1))
  ])
  const rows = groupRows(items, A)
  t.alike(rows.map((r) => r.key), [A + ':1', A + ':2', B + ':1'])
  t.alike(rows.map((r) => r.mine), [true, true, false])
  t.alike(rows.map((r) => r.shape), ['first', 'last', 'single'])
  t.absent(rows.some((r) => 'side' in r || 'showName' in r), 'no dead side/showName fields')
  t.alike(items.map((i) => i.seq), [1, 2, 1])
  t.is(groupRows([message(B, 1, 0, { diary: A })], A)[0].mine, true, 'ownership follows the diary, not the device writer')
  t.is(groupRows([message(A, 1, 0, { diary: B })], A)[0].mine, false)
  t.is(groupRows([message(A, 1, 0, { diary: null })], null)[0].mine, false)
  t.alike(groupRows(null, A), [])
  t.alike(groupRows([null, {}], A), [])
  t.is(groupRows([items[0], items[0]], A).length, 1)
})

test('groupRows groups by person (diary) and anchors the time limit at the first bubble', async (t) => {
  const { groupRows } = await load()
  const { DM_GROUP_MS } = await import('../src/dm-screen.js')
  const items = [
    message(A, 1),
    message(A, 2, DM_GROUP_MS / 2),
    message(A, 3, DM_GROUP_MS),
    message(A, 4, DM_GROUP_MS + 1),
    message(B, 1, DM_GROUP_MS + 2, { diary: A }),
    message(C, 1, DM_GROUP_MS + 3),
    message(A, 5, DM_GROUP_MS + 4)
  ]
  const rows = groupRows(items.reverse(), A)
  t.alike(rows.map((r) => r.shape), ['first', 'middle', 'last', 'first', 'last', 'single', 'single'], 'a second device of the same diary joins the run')
  t.alike(rows.map((r) => r.mine), [true, true, true, true, true, false, true])
})

test('groupRows marks local days and breaks runs at midnight or invalid times', async (t) => {
  const { groupRows } = await load()
  const at = (day, hour, minute) => new Date(2026, 9, day, hour, minute).toISOString()
  const rows = groupRows([
    message(A, 4, 0, { at: 'invalid' }),
    message(A, 3, 0, { at: at(11, 0, 1) }),
    message(A, 2, 0, { at: at(11, 0, 0) }),
    message(A, 1, 0, { at: at(10, 23, 59) })
  ], A)
  t.ok(rows[0].dayMark)
  t.ok(rows[1].dayMark)
  t.not(rows[0].dayMark, rows[1].dayMark)
  t.is(rows[2].dayMark, null)
  t.is(rows[3].dayMark, null)
  t.alike(rows.map((r) => r.shape), ['single', 'first', 'last', 'single'])
})

test('groupRows escapes peer text and discards hidden message content', async (t) => {
  const { groupRows } = await load()
  const { HIDDEN_LABEL } = await import('../src/groups.js')
  const rows = groupRows([
    message(A, 2, 1000, { hidden: true, text: 'não mostrar' }),
    message(B, 1, 0, { text: 'oi\n\u202e\ud800', replyTo: { writer: A, seq: 2 } })
  ], A)
  t.is(rows[0].text, 'oi\n\ufffd\ufffd')
  t.is(rows[0].rawText, 'oi\n\u202e\ud800', 'MentionText needs the original text to reject unsafe links')
  t.is(rows[0].replyTo, A + ':2')
  t.is(rows[1].text, HIDDEN_LABEL)
  t.is(rows[1].rawText, '')
})

test('replyPreview uses only loaded targets and hides both content and name', async (t) => {
  const { groupRows, replyPreview } = await load()
  const { HIDDEN_LABEL } = await import('../src/groups.js')
  const target = message(A, 1, 0, { name: 'Ana', text: 'Primeira mensagem' })
  const reply = message(B, 1, 1000, { replyTo: { writer: A, seq: 1 } })
  const byRef = new Map([[A + ':1', target]])
  t.alike(replyPreview(reply, byRef), { name: 'Ana', text: 'Primeira mensagem' })
  t.alike(replyPreview(groupRows([reply], A)[0], byRef), { name: 'Ana', text: 'Primeira mensagem' })
  t.is(replyPreview(reply, new Map([[B + ':1', target]])), null, 'the sequence alone cannot identify a target')
  t.is(replyPreview(message(B, 2), byRef), null)
  t.is(replyPreview(null, byRef), null)
  t.is(replyPreview({ replyTo: { writer: A, seq: '1' } }, byRef), null)
  byRef.set(A + ':1', { ...target, hidden: true })
  t.alike(replyPreview(reply, byRef), { name: '', text: HIDDEN_LABEL })
})

test('replyPreview escapes names and preserves raw text for the single UI parse', async (t) => {
  const { replyPreview } = await load()
  const preview = (target) => replyPreview({ replyTo: { writer: A, seq: 1 } }, new Map([[A + ':1', target]]))
  t.alike(preview({ name: 'Ana\u202e', text: 'um\r\n\ndois\rtrês\u2028quatro\u2029cinco\u0000\ud800' }), {
    name: 'Ana\ufffd',
    text: 'um\r\n\ndois\rtrês\u2028quatro\u2029cinco\u0000\ud800'
  })
  t.is(preview({ username: 'bia', text: '' }).name, 'bia', 'a known username supplies the name')
  t.is(preview({ name: '@Ana', text: null }).name, 'Ana')
  t.is(preview({}).text, '')
  t.is(preview({ text: 'a'.repeat(89) + '\ud800' + 'z' }).text, 'a'.repeat(89) + '\ud800' + 'z')
  t.is(preview({ text: 'a'.repeat(89) + '\udc00' + 'z' }).text, 'a'.repeat(89) + '\udc00' + 'z')
})

test('replyPreview leaves line clamping to the UI without cutting raw markup', async (t) => {
  const { replyPreview } = await load()
  const preview = (text) => replyPreview({ replyTo: A + ':1' }, new Map([[A + ':1', { name: 'Ana', text }]])).text
  t.is(preview('a'.repeat(89) + '😀' + 'z'), 'a'.repeat(89) + '😀' + 'z')
  t.is(preview('😀'.repeat(91)), '😀'.repeat(91))
  t.is(preview('a'.repeat(90)), 'a'.repeat(90))
  t.is(preview('a'.repeat(89) + '\r\n' + 'z'), 'a'.repeat(89) + '\r\n' + 'z', 'line breaks stay for the UI')
})

test('groupRows takes the clock, so a day change relabels hoje as ontem', async (t) => {
  const { groupRows } = await load()
  const A = 'a'.repeat(64)
  const at = new Date(2026, 9, 10, 12, 0).toISOString()
  const items = [{ writer: A, seq: 1, diary: A, text: 'oi', at, hidden: false, replyTo: null }]
  const sameDay = groupRows(items, A, new Date(2026, 9, 10, 23, 0).getTime())
  const nextDay = groupRows(items, A, new Date(2026, 9, 11, 0, 30).getTime())
  t.is(sameDay[0].dayMark, 'hoje')
  t.is(nextDay[0].dayMark, 'ontem')
})

test('person menus offer Conversar em particular, hosted and not for the own key', (t) => {
  const fs = require('fs')
  const path = require('path')
  const read = (f) => fs.readFileSync(path.join(__dirname, '../src/screens', f), 'utf8')
  const info = read('ComunidadeInfo.js')
  const grupo = read('Grupo.js')
  for (const src of [info, grupo]) {
    t.ok(src.includes('onMessage') && src.includes("label: 'Conversar em particular'"), 'accepts onMessage and has the row')
    t.ok(src.includes("typeof onMessage === 'function' &&"), 'gated on the prop')
    t.ok(/hosted && .*(!== ownKey)/.test(src), 'gated on hosted and the own key')
  }
  t.ok(grupo.includes('onMessage(row.diary)') && !grupo.includes('onMessage(row.writer)'), 'passes the verified diary, never the writer')
  t.ok(info.includes('onMessage(m.member)') && info.includes('onLongPress'), 'member rows open the menu on long press')
})

test('the community long-press sheet stays mounted while it closes', (t) => {
  // ActionsSheet runs the chosen action after its close animation and drops it
  // on unmount: closing must flip `open`, never unmount the sheet.
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'screens', 'ComunidadeInfo.js'), 'utf8')
  t.ok(src.includes('<ActionsSheet open={menuOpen} onClose={() => setMenuOpen(false)}'), 'closing flips open')
  t.absent(src.includes('setMenuMember(null)'), 'the member is not cleared on close')
})

test('a page in a private group: node read and seal, plain refusals', async (t) => {
  const { knownVisibility, pageGroupErrorText, sealRaced, PAGE_NO_KEY_TEXT, PAGE_GROUP_LOADING_TEXT, PAGE_REKEYING_TEXT } = await import('../src/groups.js')
  t.is(knownVisibility({ page: true, info: null, epoch: null, pagePrivate: true }), 'private', 'the service read says private')
  t.is(knownVisibility({ page: true, info: null, epoch: null }), 'public')
  t.is(pageGroupErrorText(new Error('sem chave da página')), PAGE_NO_KEY_TEXT)
  t.is(PAGE_NO_KEY_TEXT, 'Peça ao dono da página para enviar a chave')
  t.is(pageGroupErrorText(new Error('grupo não encontrado')), PAGE_GROUP_LOADING_TEXT)
  t.is(pageGroupErrorText(new Error('aguardando nova chave')), PAGE_REKEYING_TEXT)
  t.is(PAGE_REKEYING_TEXT, 'A chave deste grupo está sendo trocada')
  t.is(pageGroupErrorText(Object.assign(new Error('x'), { code: 'aguardando-chave' })), PAGE_REKEYING_TEXT)
  t.is(pageGroupErrorText(Object.assign(new Error('Limite atingido'), { code: 'limite' })), 'Limite atingido')
  t.ok(sealRaced({ code: 'sequencia' }))
  t.absent(sealRaced({ code: 'sequencia', uncertain: true }), 'an unknown outcome is never sealed again')
  t.absent(sealRaced({ code: 'limite' }))

  const fs = require('fs')
  const path = require('path')
  const grupo = fs.readFileSync(path.join(__dirname, '../src/screens/Grupo.js'), 'utf8')
  t.ok(grupo.includes("nodeRead: () => request('group.read', { ...op, page: asPage.key })"), 'the node reads as the page')
  t.ok(grupo.includes("seal: async () => request('group.seal', pageSealParams(await build(), asPage.key))"), 'sealed on the device')
  t.ok(grupo.includes("const build = vis === 'public' ? pagePublicOp(text, replyTo, snapshot) : pagePrivateOp(text, replyTo, snapshot, heldCard, keep)") && grupo.includes('pageSend(pagePost(vis, text, build), text, Date.now()'), 'posts go through postAsPage')
  t.absent(grupo.includes('read.private'), 'the service never decides the visibility')
  t.ok(grupo.includes("plain: async () => pageStatement('group-post', await build())()"), 'the plaintext post only through postAsPage')
  t.is(grupo.split("pageStatement('group-post'").length, 2, 'and nowhere else')
  t.ok(grupo.includes("seen === 'private' ? PAGE_NO_KEY_TEXT"), 'a private group with no page secrets asks for the key')
  t.ok(grupo.includes("pageCan('post', pageRole) && meta.state === 'ok' && pageVis !== null"), 'no composer until the node answers')
  t.ok(grupo.includes('onPress={() => sendPost(sealAgain.text, sealAgain.replyTo, sealAgain.card)}'), 'sealed again only on a tap, with its reply and card')
  const ajustes = fs.readFileSync(path.join(__dirname, '../src/screens/PaginaAjustes.js'), 'utf8')
  t.ok(ajustes.includes("action: 'group-rebox'") && ajustes.includes('Renovar chave dos grupos'), 'owner button')
  t.ok(ajustes.includes('A página saiu deste grupo para trocar a chave; peça para entrar de novo'), 'left groups are listed')
  t.absent(ajustes.includes('skipped'), 'the service answers only groups and left')
  t.ok(ajustes.includes('Renove a chave dos grupos privados da página') && ajustes.includes('reboxNeeded') && ajustes.includes('reboxPending'), 'owner card when a rebox is owed')
})

test('a lying service read never gets a private page post sent in the clear', async (t) => {
  const { readAsPage, postAsPage, pagePostVisibility } = await import('../src/groups.js')
  const G = 'aa'.repeat(32)
  const envelope = { kid: { writer: B, seq: 2 }, nonce: 'n', box: 'b', at: '2026-11-09T12:00:00.000Z', writer: B, seq: 5 }
  for (const service of [{ private: false, items: [] }, { items: [] }]) {
    const sent = []
    let seals = 0
    const { visibility, read } = await readAsPage({
      nodeRead: async () => ({ visibility: 'private', items: [message(A, 1)], role: 'member' }),
      serviceRead: async () => service
    })
    t.is(visibility, 'private')
    t.is(read.items.length, 1, 'the node read is shown')
    await postAsPage({ visibility, group: G, text: 'oi', seal: async () => { seals++; return envelope }, send: async (action, op) => sent.push({ action, op }), plain: async () => sent.push({ action: 'group-post' }) })
    t.is(seals, 1, 'one group.seal')
    t.is(sent.filter((c) => c.action === 'group-post').length, 0, 'zero group-post')
    t.alike(sent, [{ action: 'group-seal', op: { group: G, ...envelope } }])
  }

  // The node has not answered (or names no visibility): nothing is sent.
  for (const nodeRead of [async () => { throw new Error('grupo não encontrado') }, async () => ({ items: [] })]) {
    const { visibility, read } = await readAsPage({ nodeRead, serviceRead: async () => ({ private: false, items: [], role: 'member' }) })
    t.is(visibility, null)
    t.is(read.role, 'member', 'the service read still gives the role')
    const sent = []
    t.is(postAsPage({ visibility, group: G, text: 'oi', seal: async () => { throw new Error('no seal') }, send: async (a) => sent.push(a), plain: async () => sent.push('group-post') }), null)
    t.is(sent.length, 0)
  }

  // No page secrets here: a public group still posts in the clear through
  // the service; a private one keeps the composer closed.
  const noKey = (visibility) => async () => ({ items: [], next: null, hidden: 0, incomplete: false, sealed: 0, epoch: null, state: 'no-key', role: null, visibility })
  const pub = await readAsPage({ nodeRead: noKey('public'), serviceRead: async () => ({ items: [message(A, 1)], role: 'member' }) })
  t.is(pagePostVisibility(pub), 'public')
  t.is(pub.read.items.length, 1, 'the service read is shown')
  const plainSent = []
  await postAsPage({ visibility: pagePostVisibility(pub), group: G, text: 'oi', seal: async () => { throw new Error('no seal') }, send: async (a) => plainSent.push(a), plain: async () => plainSent.push('group-post') })
  t.alike(plainSent, ['group-post'], 'a public group with no page secrets posts through group-post')
  const priv = await readAsPage({ nodeRead: noKey('private'), serviceRead: async () => ({ items: [], role: 'member' }) })
  t.is(priv.visibility, 'private')
  t.is(priv.noKey, true)
  t.is(pagePostVisibility(priv), null, 'a private group with no page secrets stays closed')
  t.is(pagePostVisibility({ visibility: null, noKey: false }), null)

  // Plaintext only where the node read a public header.
  const sent = []
  const { visibility } = await readAsPage({ nodeRead: async () => ({ visibility: 'public', items: [] }), serviceRead: async () => ({ private: true, items: [] }) })
  t.is(visibility, 'public')
  await postAsPage({ visibility, group: G, text: 'oi', seal: async () => { throw new Error('no seal') }, send: async (action, op) => sent.push({ action, op }), plain: async () => sent.push({ action: 'group-post' }) })
  t.alike(sent, [{ action: 'group-post' }])
})

test('groupRows copies compact reactions only onto visible rows', async (t) => {
  const { groupRows } = await load()
  const reactions = Object.freeze([Object.freeze({ emoji: '👍', count: 2, mine: true, by: [A] })])
  const rows = groupRows([message(A, 2, 1000, { hidden: true, reactions }), message(A, 1, 0, { reactions })], A)
  t.alike(rows[0].reactions, [{ emoji: '👍', count: 2, mine: true }])
  t.not(rows[0].reactions, reactions)
  t.absent(Object.hasOwn(rows[1], 'reactions'))
  t.absent(Object.hasOwn(groupRows([message(A, 1)], A)[0], 'reactions'))
})

test('group quotes parse code and spoilers once at the UI boundary', async (t) => {
  const { replyPreview } = await load()
  const { plainOf } = await import('../src/richText.js')
  const preview = (text) => replyPreview({ replyTo: A + ':1' }, new Map([[A + ':1', { text }]])).text
  t.is(plainOf(preview('`*x*`')), '*x*')
  t.is(plainOf(preview('a ||segredo|| b')), 'a spoiler b')
  t.absent(plainOf(preview('a ||segredo|| b')).includes('segredo'))
})

test('groupRows ignores null and primitive reaction entries', async (t) => {
  const { groupRows } = await load()
  const reactions = [null, '👍', { emoji: '👍', count: 2, mine: false }]
  t.alike(groupRows([message(A, 1, 0, { reactions })], A)[0].reactions, [{ emoji: '👍', count: 2, mine: false }])
})

test('pageCommunityToEnter offers the community only for a definite fora-da-comunidade refusal', async (t) => {
  const { pageCommunityToEnter } = await import('../src/groups.js')
  const key = 'ab'.repeat(32)
  const refused = Object.assign(new Error('x'), { code: 'fora-da-comunidade' })
  t.is(pageCommunityToEnter({ error: refused, communityKey: key }), key)
  t.is(pageCommunityToEnter({ error: refused, communityKey: null }), null, 'community not known yet')
  t.is(pageCommunityToEnter({ error: Object.assign(new Error('x'), { code: 'fora-da-comunidade', uncertain: true }), communityKey: key }), null, 'uncertain')
  t.is(pageCommunityToEnter({ error: Object.assign(new Error('x'), { code: 'indisponivel' }), communityKey: key }), null, 'other error')
  t.is(pageCommunityToEnter({ error: null, communityKey: key }), null)
})

test('groupNameText uses a neutral fallback until visibility is known', async (t) => {
  const { groupNameText, PRIVATE_LABEL } = await import('../src/groups.js')
  t.is(groupNameText({ info: null, page: true, visibility: 'public' }), 'grupo')
  t.is(groupNameText({ info: null, page: true, visibility: null }), 'grupo')
  t.is(groupNameText({ info: null, page: true, visibility: 'private' }), PRIVATE_LABEL)
  t.is(groupNameText({ info: null, page: false, visibility: null }), 'grupo')
  t.is(groupNameText({ info: { name: 'Geral', visibility: 'private' }, page: true, visibility: null }), 'Geral')
  t.is(groupNameText({ info: { name: '', visibility: 'private' }, page: false, visibility: null }), PRIVATE_LABEL)
  t.is(groupNameText({ info: { name: '', visibility: 'public' }, page: false, visibility: null }), 'grupo')
  const hint = { name: 'Música', visibility: 'public' }
  t.is(groupNameText({ info: null, hint }), 'Música')
  t.is(groupNameText({ info: { name: 'Geral' }, hint }), 'Geral')
  t.is(groupNameText({ info: { name: '' }, hint }), 'Música')
  t.is(groupNameText({ info: null, page: true, visibility: null, hint }), 'Música')
  t.is(groupNameText({ info: null, hint: { name: '', visibility: 'public' } }), 'grupo')
  t.is(groupNameText({ info: null, hint: { name: null, visibility: 'private' } }), PRIVATE_LABEL)
  t.is(groupNameText({ info: null, page: true, visibility: null, hint: { visibility: 'private' } }), 'grupo')
  t.is(groupNameText({ info: { visibility: 'public' }, hint: { visibility: 'private' } }), 'grupo')
})

test('outsideNote keeps the node error on a non-hosted node and uses lookup status on a hosted node', async (t) => {
  const { outsideNote } = await import('../src/groups.js')
  const infoError = 'grupo não encontrado'
  for (const lookup of ['idle', 'loading', 'done', 'failed']) {
    t.is(outsideNote({ hosted: false, infoError, lookup }), infoError)
  }
  for (const lookup of ['idle', 'loading', 'done']) {
    t.is(outsideNote({ hosted: true, infoError, lookup }), '')
  }
  t.is(outsideNote({ hosted: true, infoError, lookup: 'failed' }), 'Não foi possível carregar este grupo agora.')
})

test('nextLookup keeps the last answer during refreshes and shows loading for an explicit retry', async (t) => {
  const { nextLookup } = await import('../src/groups.js')
  const idle = { status: 'idle', name: null, visibility: null }
  const loading = { status: 'loading', name: null, visibility: null }
  const failed = { status: 'failed', name: null, visibility: null }
  const done = { status: 'done', name: 'Música', visibility: 'public' }
  const ok = { type: 'ok', name: done.name, visibility: done.visibility }
  const start = { type: 'start', retry: false }
  const retry = { type: 'start', retry: true }
  const fail = { type: 'fail' }
  for (const state of [idle, loading, failed, done]) {
    Object.freeze(state)
    t.alike(nextLookup(state, { type: 'reset' }), idle)
    t.alike(nextLookup(state, retry), loading)
    t.alike(nextLookup(state, ok), done)
  }
  t.alike(nextLookup(idle, start), loading)
  for (const state of [loading, failed, done]) t.is(nextLookup(state, start), state)
  for (const state of [idle, loading, failed]) t.alike(nextLookup(state, fail), failed)
  t.is(nextLookup(done, fail), done)
  t.alike(nextLookup(done, { type: 'ok', name: null, visibility: 'private' }), { status: 'done', name: null, visibility: 'private' })
})

test('Grupo wires the page community path and the neutral name', (t) => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'screens', 'Grupo.js'), 'utf8')
  t.ok(src.includes('pageCommunityToEnter({ error: pageJoinError, communityKey })'))
  t.ok(src.includes('onOpenCommunity(pageEnterCommunity, { group })'), 'the page opens the community like a person')
  t.ok(src.includes("groupNameText({ info, page: asPage.page, visibility: pageSeen, hint: lookup.status === 'done' ? lookup : undefined })"))
})

test('Grupo drops stale group and community answers without clearing the new lookup', async (t) => {
  const { nextLookup } = await import('../src/groups.js')
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'screens', 'Grupo.js'), 'utf8')
  const start = src.indexOf('  useLayoutEffect(() => {')
  const end = src.indexOf('\n  // The community opens first', start)
  t.ok(start >= 0 && end > start, 'lookup effects found')

  const IDLE_LOOKUP = nextLookup(null, { type: 'reset' })
  const pending = new Map()
  const communities = []
  let lookup = IDLE_LOOKUP
  let activeGroup, cleanup, answerCommunity
  const lookBusy = { current: false }
  const render = require('vm').runInNewContext(`(group) => {${src.slice(start, end)}\n}`, {
    IDLE_LOOKUP,
    lookBusy,
    nextLookup,
    hosted: true,
    joinable: true,
    heldCommunity: null,
    request: (method, { community }) => {
      communities.push([method, community])
      return new Promise((resolve) => { answerCommunity = resolve })
    },
    version: 0,
    node: { online: true },
    lookupTick: 0,
    lookGroup: { current: null },
    lookedUp: { current: false },
    lookToken: { current: 0 },
    lookRetry: { current: false },
    useLayoutEffect: (effect, [group]) => {
      if (group === activeGroup) return
      if (cleanup) cleanup()
      activeGroup = group
      cleanup = effect()
    },
    useEffect: (effect) => effect(),
    setLookup: (update) => { lookup = typeof update === 'function' ? update(lookup) : update },
    setIndexCommunity: (key) => t.is(key, null, 'stale community is never set'),
    setIndexRole: (role) => t.is(role, undefined, 'stale role is never set'),
    fetchGroup: (group) => new Promise((resolve) => {
      t.absent(pending.has(group), 'one lookup per group in flight')
      pending.set(group, resolve)
    })
  })
  const answer = { ok: true, value: { name: 'Música', visibility: 'public', community: A } }
  const flush = () => new Promise(setImmediate)

  render(A)
  render(A)
  pending.get(A)(answer)
  await flush()
  t.is(lookup.status, 'done', 'a refresh during the fetch keeps the current answer valid')
  t.alike(communities, [['community.info', A]])
  render(B)
  answerCommunity({ role: 'member' })
  await flush()
  t.is(lookup.status, 'loading')
  t.is(lookBusy.current, true, 'old community answer cannot release the new fetch')
  render(C)
  pending.get(B)(answer)
  await flush()
  t.is(lookup.status, 'loading', 'the old fetch cannot update the new title')
  t.is(lookBusy.current, true, 'the old fetch cannot release the new fetch')
  cleanup()
  pending.get(C)(answer)
  await flush()
  t.is(lookup.status, 'loading', 'an unmounted screen receives no state update')
  t.is(lookBusy.current, false)
  t.alike(communities, [['community.info', A]], 'stale group answers never trigger a community read')
})

const OUTSIDE_GROUP = 'a'.repeat(64)

async function outsideGroup () {
  const { outsideAbout, outsideNote, roleOf } = await import('../src/groups.js')
  const { transformSync } = require('@babel/core')
  const { runInNewContext } = require('node:vm')
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/screens/Grupo.js'), 'utf8')
  const branch = src.slice(src.indexOf('  let outside = null'), src.indexOf('  const stateNotes ='))
  const { code } = transformSync(`(state) => {
    const { hosted, info, lookup, indexAbout = null } = state
    const role = roleOf(info, null)
    ${branch}
    return outside
  }`, {
    babelrc: false,
    configFile: false,
    plugins: [[require.resolve('@babel/plugin-transform-react-jsx'), { pragma: 'element' }]]
  })
  const lookRetry = { current: false }
  let loads = 0
  let tick = 0
  const render = runInNewContext(code, {
    outsideAbout,
    outsideNote,
    roleOf,
    group: OUTSIDE_GROUP,
    displayText: (text) => text,
    Label: 'Label',
    Text: 'Text',
    element: (type, props, ...children) => ({ type, props, children }),
    Skeleton: 'Skeleton',
    View: 'View',
    Soft: 'Soft',
    Pill: 'Pill',
    Btn: 'Btn',
    ErrorText: 'ErrorText',
    JOINABLE: [null, 'left', 'pending'],
    PENDING_TEXT: 'Aguardando sincronização deste grupo.',
    reader: false,
    loadedAt: 1,
    styles: {},
    node: { online: false },
    infoError: 'grupo não encontrado',
    isPrivate: false,
    orphan: false,
    needCommunity: false,
    arriving: false,
    enter: () => {},
    join: {},
    lookRetry,
    loadInfo: () => { loads++ },
    setLookupTick: (update) => { tick = update(tick) }
  })
  return { render, retryState: () => [lookRetry.current, loads, tick] }
}

const pendingGroup = { state: 'pending', community: null }
const indexFailure = 'Não foi possível carregar este grupo agora.'

test('Grupo shows the index skeleton only on a hosted node without group info', async (t) => {
  const { render } = await outsideGroup()
  const lookup = { status: 'loading' }
  t.is(render({ hosted: true, info: null, lookup }).type, 'Skeleton')
  t.is(render({ hosted: true, info: pendingGroup, lookup }).type, 'View')
  t.is(render({ hosted: false, info: null, lookup }).type, 'View')
})

test('Grupo offers a retry when an unknown group lookup fails', async (t) => {
  const { render, retryState } = await outsideGroup()
  const { children } = render({ hosted: true, info: null, lookup: { status: 'failed' } })
  t.ok(children.some((child) => child?.type === 'Soft' && child.children.includes(indexFailure)))
  const retry = children.find((child) => child?.type === 'Pill' && child.props.label === 'Tentar de novo')
  t.ok(retry)
  retry?.props.onPress()
  t.alike(retryState(), [true, 1, 1])
})

test('Grupo keeps a loaded pending group visible when its index lookup fails', async (t) => {
  const { render } = await outsideGroup()
  const { children } = render({ hosted: true, info: pendingGroup, lookup: { status: 'failed' } })
  t.ok(children.some((child) => child?.type === 'Soft' && child.children.includes('Aguardando sincronização deste grupo.')))
  t.absent(children.some((child) => child?.type === 'Soft' && child.children.includes(indexFailure)))
  t.absent(children.some((child) => child?.type === 'Pill' && child.props.label === 'Tentar de novo'))
})

test('Grupo shows the description first and labelled on the outside card, from the node or the index', async (t) => {
  const { render } = await outsideGroup()
  const described = (children) => {
    const block = children.find((child) => child?.type === 'View')
    if (!block) return null
    const label = block.children.find((child) => child?.type === 'Label')
    const text = block.children.find((child) => child?.type === 'Text')
    return { first: children.find(Boolean) === block, label: label?.children.join(''), text: text?.children.join(''), lines: text?.props.numberOfLines }
  }
  const held = { state: 'left', community: 'c'.repeat(64), visibility: 'public', about: 'Sobre o grupo.' }
  t.alike(described(render({ hosted: true, info: held, lookup: { status: 'idle' } }).children), { first: true, label: 'Descrição', text: 'Sobre o grupo.', lines: 3 }, 'held root: the node description')
  t.is(described(render({ hosted: true, info: { ...held, visibility: 'private' }, lookup: { status: 'idle' } }).children), null, 'private: hidden')
  t.is(described(render({ hosted: true, info: { ...held, about: null }, lookup: { status: 'done', visibility: 'public' }, indexAbout: { group: OUTSIDE_GROUP, about: 'Do índice.' } }).children), null, 'the node answer wins over the index')
  const unknown = { hosted: true, info: null, lookup: { status: 'done', visibility: 'public' } }
  t.is(described(render({ ...unknown, indexAbout: { group: OUTSIDE_GROUP, about: 'Do índice.' } }).children)?.text, 'Do índice.', 'unknown group: the index description')
  t.is(described(render({ ...unknown, indexAbout: { group: 'b'.repeat(64), about: 'Outro.' } }).children), null, 'stale answer for another group')
})

test('a page outside a private group it holds no key for still sees it named private', async (t) => {
  const { groupNameText, pagePostVisibility, PRIVATE_LABEL } = await import('../src/groups.js')
  t.is(pagePostVisibility({ visibility: 'private', noKey: true }), null, 'posting stays unknown without the key')
  t.is(groupNameText({ info: null, page: true, visibility: 'private' }), PRIVATE_LABEL)
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'screens', 'Grupo.js'), 'utf8')
  t.ok(src.includes('visibility: pageSeen'), 'the title uses the raw verified read, not the posting visibility')
  t.ok(src.includes('setPageSeen(seen)'))
})

test('a page that joined its community clears the stale refusal and the queued group opens from its join', (t) => {
  const grupo = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'screens', 'Grupo.js'), 'utf8')
  const comu = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'screens', 'Comunidade.js'), 'utf8')
  t.ok(/if \(pageRole !== 'member' && pageRole !== 'requested'\) return\s+setPageJoinError\(null\)/.test(grupo), 'member or requested clears the refusal')
  t.ok(grupo.includes('if (asPage.page && was === false && isTop === true) loadRef.current()'), 'reload when the group is on top again')
  t.ok(/setPageError\(''\)\n\s+setPageJoinError\(null\)\n\s+setPageRetry\(null\)\n\s+setSealAgain/.test(grupo), 'switching identity clears the join refusal')
  t.ok(comu.includes("pageRoleOf(answer) === 'member' && typeof onJoined === 'function') onJoined()"))
  t.ok(comu.includes('onJoined={openQueued}'))
})

test('a community read from the index offers a page its own join, never the person join', (t) => {
  const comu = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'screens', 'Comunidade.js'), 'utf8')
  const start = comu.indexOf('if (fromIndex) {')
  const end = comu.indexOf('} else if', start)
  t.ok(start > 0 && end > start, 'index branch found')
  const branch = comu.slice(start, end)
  t.ok(/\{asPage\.page\s+\? <PagePanel node=\{node\} community=\{community\} page=\{asPage\.key\} onJoined=\{openQueued\} \/>\s+: \(\s+<JoinCard/.test(branch), 'page mode shows PagePanel in place of JoinCard')
})

test('Grupo: a page in a public group posts media, replies, reacts and hides only its own', (t) => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/screens/Grupo.js'), 'utf8')
  t.ok(src.includes("pagesGroup(node, { member: await memberKeyOf(request, node), page: asPage.key, action: 'group-react'"), 'react as the page')
  t.ok(src.includes("action: 'group-hide'") && src.includes("pageCan('hide', pageRole, { own: mine })"), 'hide only its own')
  t.ok(src.includes("pageVis === 'public' ? { upload: pageUpload } : pageVis === 'private' && canSealPage ? { upload: pagePrivateUpload } : null"), 'page uploads: plain in a public group, sealed in a private one')
  t.ok(src.includes('request: sendRequest'), 'media goes through the page statement')
  t.ok(src.includes('forumOn = hosted && (asPage.page ? pageVis'), 'forum for a public page')
  t.absent(src.includes('replyKey !== null && !asPage.page'), 'a page can reply')
  t.ok(src.includes('if (actingIdRef.current !== acting) return'), 'a result for another identity is dropped')
})

test('Grupo: a page in a private group seals media, card, reply, reactions and hides', (t) => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/screens/Grupo.js'), 'utf8')
  const upload = src.slice(src.indexOf('const pagePrivateUpload = async'), src.indexOf('const pagePrivateOp ='))
  t.ok(upload.indexOf('pageVoice(') < upload.indexOf('sealer.sealPage('), 'a voice note is stripped before it is sealed')
  t.ok(upload.indexOf('sealer.sealPage(') < upload.indexOf("pagesStart({ member, action: 'media'"), 'sealed before any nonce is spent')
  t.ok(upload.includes('const op = sealedUploadOp({ group, item })') && upload.includes('bytes: cipher'), 'only the ciphertext goes up, under the group op')
  t.ok(upload.includes('privateItemOf(answer && answer.descriptor, item)') && upload.includes("throw new Error('resposta inesperada')"), 'a descriptor for other bytes stops the post')
  t.absent(upload.includes('retry'), 'an upload is never retried here')
  t.ok(src.includes('cardForSend(snapshot, { upload: pagePrivateUpload })'), 'the card thumbnail is sealed too')
  t.ok(src.includes('if (keep.op !== null) return keep.op'), 'the post is built once')
  t.ok(src.includes("sendRequest = asPage.page ? (pageVis === 'private' ? pageSealedRequest : pageGroupRequest) : request"), 'photo and voice posts are sealed as the page')
  t.ok(src.includes('const mediaVisibility = asPage.page ? pageVis'), 'the page media visibility is the node read')
  t.ok(src.includes("if (asPage.page && pageVisible === 'private') await pageSealSend({ react: { target, emoji } })"), 'a reaction is a sealed record')
  const react = src.slice(src.indexOf('async function toggleReaction'), src.indexOf("action: 'group-react'"))
  t.ok(react.includes('const pageVisible = asPage.page ? pageVisNow() : null') && react.indexOf('if (asPage.page && pageVisible === null) return') < react.indexOf('context.sending.add(key)'), 'a reaction in a group of unknown kind sends nothing and changes nothing')
  const hideFn = src.slice(src.indexOf('const hide = async'), src.indexOf('const ban = async'))
  t.ok(hideFn.indexOf('if (asPage.page && vis === null) return') > 0 && hideFn.indexOf('if (asPage.page && vis === null) return') < hideFn.indexOf('setCheck(null)'), 'a hide in a group of unknown kind sends nothing and changes nothing')
  const retry = src.slice(src.indexOf('const retryMedia = async'), src.indexOf('const cancelMedia = () =>'))
  t.ok(retry.includes('const how = heldPageSender(held, pageVisNow())') && retry.indexOf('if (how === null) {') < retry.indexOf('retryChatSend('), 'the held post picks its sender, from the node read of now')
  t.ok(retry.includes("how === 'sealed' ? pageSealedRequest : pageGroupRequest") && !retry.includes('sendRequest'), 'never the render-time sendRequest')
  t.ok(src.includes('{mediaHold.uncertain ? <Soft>{CHECK_UNKNOWN}</Soft> : null}'), 'the unknown-outcome note only for an uncertain hold')
  t.ok(src.includes('if (sealed) return await pageSealSend({ hide: { target, on } })'), 'a hide is a sealed record')
  t.ok(src.includes("const pageActs = asPage.page && pageCan('post', pageRole) && pageVis !== null"), 'reactions, hide and forward in a private group too')
  const done = src.slice(src.indexOf('const mediaDone = async'), src.indexOf('const sendMedia = async'))
  t.ok(done.includes("asPage.page && pageVis === 'private' && r.op && sealAgainAfter(r.error)") && done.includes('uncertain: false, sealed: true, retry: null'), 'a raced seal keeps the uploads and seals again only on a tap')
  t.ok(done.includes('uncertain: true, sealed: carriesPrivateItems(r.op && r.op.params)'), 'an uncertain hold knows whether it is sealed')
  const textSend = src.slice(src.indexOf('const pageSend = async'), src.indexOf('// Back from the community after the page joined it'))
  t.ok(textSend.includes('} else if (sealAgainAfter(err)) {') && !textSend.includes('sealRaced('), 'a text post keeps its uploaded card after a key change too, by the media path rule')
  t.ok(textSend.includes('card: again && again.keep ? again.keep.card : undefined'), 'the seal-again reuses the uploaded card')
  t.ok(src.includes("forumOn = hosted && (asPage.page ? pageVis === 'public'"), 'no forum, poll or event in a private group')
})

test('Grupo: a page creates a topic as itself, never as the person', (t) => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/screens/Grupo.js'), 'utf8')
  const fn = src.slice(src.indexOf('async function createTopic'), src.indexOf('// Versions restart at 0'))
  t.ok(fn.includes("action: 'group-post', op: pageGroupPostOp({ group, text, topic: true, poll: poll ? poll.options : undefined, event })"), 'signed page group-post')
  t.ok(fn.indexOf('asPage.page') < fn.indexOf("request('group.post'"), 'the page branch comes first')
  t.ok(fn.includes('publicGroupRefusal'), 'the word check stays')
  t.ok(fn.includes('actingIdRef.current !== acting'), 'a result for another identity is dropped')
})

test('Grupo: voice width/height 0, page reply once the visibility is read, held page topic retry, reply-aware reconcile', (t) => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/screens/Grupo.js'), 'utf8')
  t.ok(src.includes('mime, width: 0, height: 0, ms, bytes: bytes.byteLength'), 'audio upload op has width 0 and height 0')
  t.ok(src.includes('const replyOk = !asPage.page || pageVis !== null') && src.includes('canPost && replyOk && !row.hidden') && src.includes('replyKey !== null && replyOk'), 'a page replies once the node read the visibility')
  t.ok(src.includes('held.key === holdKey') && src.includes('await held.retry()') && src.includes('topicHold.current = { key: holdKey, retry: err.retry }'), 'the same signed topic is resent')
  t.ok(src.includes("settle({ action: 'post', diary: asPage.key, text, sentAt, replyKey: replyKeyOf }"), 'page reply reconciled with its replyKey')
})

test('Grupo: a page reads topics through group-topics and decides roots from the rows', (t) => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/screens/Grupo.js'), 'utf8')
  t.ok(src.includes("page: asPage.key, action: 'group-topics', op })"), 'the topics tab reads the service, with the cursor in op')
  t.ok(src.includes('mine !== topicSeq.current || actingIdRef.current !== acting'), 'a read for another identity is dropped')
  t.absent(src.includes('forumRefs'), 'topic roots are not decided from the topics list')
  t.ok(src.includes('chatView(rawItems) : null'), 'the chat uses the rows own topic marks')
  t.absent(src.includes("forumTab === 'topicos' || asPage.page"), 'the chat does not load topics')
})

test('Grupo: late results of another identity are dropped, a page hide keeps its signed retry', (t) => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/screens/Grupo.js'), 'utf8')
  const done = src.slice(src.indexOf('const mediaDone'))
  t.ok(done.indexOf('actingIdRef.current !== acting') < done.indexOf('setMediaSend(null)'), 'mediaDone checks the identity first')
  const hide = src.slice(src.indexOf('const hide = async'), src.indexOf('const ban = async'))
  t.ok(hide.includes('actingIdRef.current !== acting') && hide.indexOf('actingIdRef.current !== acting') < hide.indexOf('readNewest()'), 'hide drops a result for another identity')
  t.ok(hide.includes('signedRetry = err.retry') && hide.includes('await signedRetry()'), 'a page hide resends the same signed statement')
  t.ok(src.includes('JSON.stringify([acting, group, text,') && src.includes('}, [asPage.key, group])'), 'the topic hold is per group')
})

test('Grupo: a page voice note is stripped before it is hashed and uploaded', (t) => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/screens/Grupo.js'), 'utf8')
  const up = src.slice(src.indexOf('const pageUpload'), src.indexOf('const pageGroupRequest'))
  t.ok(up.includes('pageVoice({ bytes: given, ms: givenMs })') && up.includes('throw new TypeError(BAD_VOICE)'), 'prepared by pageVoice, refused when it is no voice note')
  t.ok(up.indexOf('pageVoice(') < up.indexOf('pagesStart('), 'before a nonce is spent')
  t.ok(up.includes('sha256(bytes)') && up.includes('bytes, origin })') && !up.includes('sha256(given)'), 'the stripped bytes are hashed and uploaded')
})
