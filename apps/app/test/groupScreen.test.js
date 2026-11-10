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
  t.alike(rows.map((r) => r.side), ['mine', 'mine', 'theirs'])
  t.alike(rows.map((r) => r.shape), ['first', 'last', 'single'])
  t.alike(rows.map((r) => r.showName), [true, false, true])
  t.alike(items.map((i) => i.seq), [1, 2, 1])
  t.is(groupRows([message(B, 1, 0, { diary: A })], A)[0].side, 'mine', 'ownership follows the diary, not the device writer')
  t.is(groupRows([message(A, 1, 0, { diary: B })], A)[0].side, 'theirs')
  t.is(groupRows([message(A, 1, 0, { diary: null })], null)[0].side, 'theirs')
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
  t.alike(rows.map((r) => r.showName), [true, false, false, true, false, true, true])
  t.alike(rows.map((r) => r.side), ['mine', 'mine', 'mine', 'mine', 'mine', 'theirs', 'mine'])
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
  t.alike(rows.map((r) => r.showName), [true, true, false, true])
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

test('replyPreview collapses line breaks and escapes names and lone surrogates', async (t) => {
  const { replyPreview } = await load()
  const preview = (target) => replyPreview({ replyTo: { writer: A, seq: 1 } }, new Map([[A + ':1', target]]))
  t.alike(preview({ name: 'Ana\u202e', text: 'um\r\n\ndois\rtrês\u2028quatro\u2029cinco\u0000\ud800' }), {
    name: 'Ana\ufffd',
    text: 'um dois três quatro cinco\ufffd\ufffd'
  })
  t.is(preview({ username: 'bia', text: '' }).name, 'bia', 'a known username supplies the name')
  t.is(preview({ name: '@Ana', text: null }).name, 'Ana')
  t.is(preview({}).text, '')
  t.is(preview({ text: 'a'.repeat(89) + '\ud800' + 'z' }).text, 'a'.repeat(89) + '\ufffd')
  t.is(preview({ text: 'a'.repeat(89) + '\udc00' + 'z' }).text, 'a'.repeat(89) + '\ufffd')
})

test('replyPreview clips at 90 code points without splitting an emoji', async (t) => {
  const { replyPreview } = await load()
  const preview = (text) => replyPreview({ replyTo: A + ':1' }, new Map([[A + ':1', { name: 'Ana', text }]])).text
  t.is(preview('a'.repeat(89) + '😀' + 'z'), 'a'.repeat(89) + '😀')
  t.is(preview('😀'.repeat(91)), '😀'.repeat(90))
  t.is(preview('a'.repeat(90)), 'a'.repeat(90))
  t.is(preview('a'.repeat(89) + '\r\n' + 'z'), 'a'.repeat(89) + ' ', 'line breaks collapse before clipping')
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
  t.ok(grupo.includes("seal: (t) => request('group.seal', { group, page: asPage.key, text: t })"), 'sealed on the device')
  t.ok(grupo.includes('pageSend(pagePost(vis, text), text, Date.now())'), 'posts go through postAsPage')
  t.absent(grupo.includes('read.private'), 'the service never decides the visibility')
  t.ok(grupo.includes("plain: pageStatement('group-post', { group, text })"), 'the plaintext post only through postAsPage')
  t.is(grupo.split("pageStatement('group-post'").length, 2, 'and nowhere else')
  t.ok(grupo.includes("seen === 'private' ? PAGE_NO_KEY_TEXT"), 'a private group with no page secrets asks for the key')
  t.ok(grupo.includes("pageCan('post', pageRole) && meta.state === 'ok' && pageVis !== null"), 'no composer until the node answers')
  t.ok(grupo.includes('onPress={() => sendPost(sealAgain)}'), 'sealed again only on a tap')
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
