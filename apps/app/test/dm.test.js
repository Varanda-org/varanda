'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const load = () => import('../src/dm.js')

test('dm.js exports the list helpers, the thread and the labels', async (t) => {
  const dm = await load()
  t.alike(Object.keys(dm).sort(), [
    'LABELS', 'UNSURE_SEND', 'requestsDot', 'selectorItems', 'sortConversations', 'splitFolders', 'tabDot', 'threadOf'
  ].sort())
  const imports = readFileSync(join(__dirname, '../src/dm.js'), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('import '))
  t.alike(imports, ["import rpc from '@varanda/rpc'"])
})

test('selectorItems lists Mensagens then Comunidades', async (t) => {
  const { selectorItems } = await load()
  const first = selectorItems()
  t.alike(first, [
    { id: 'mensagens', label: 'Mensagens' },
    { id: 'comunidades', label: 'Comunidades' }
  ])
  first[0].label = 'alterado'
  t.is(selectorItems()[0].label, 'Mensagens', 'each call returns its own list')
})

test('LABELS are the approved Portuguese', async (t) => {
  const { LABELS } = await load()
  t.ok(Object.isFrozen(LABELS))
  t.alike(LABELS, {
    accept: 'Aceitar',
    decline: 'Recusar',
    block: 'Bloquear mensagens',
    unblock: 'Desbloquear mensagens',
    delete: 'Apagar conversa neste aparelho',
    report: 'Denunciar',
    reply: 'Responder',
    message: 'Mensagem',
    newMessage: 'Nova mensagem',
    requests: 'Pedidos de mensagem',
    emptyInbox: 'Nenhuma conversa ainda. Abra o perfil de alguém e toque em Mensagem.',
    emptyRequests: 'Nenhum pedido de mensagem',
    requestNote: 'Até você aceitar, quem enviou não sabe se você leu',
    noBox: 'Esta pessoa ainda não recebe mensagens. Assim que ela abrir o Varanda com a versão nova, dá para escrever.',
    blockedSend: 'Você bloqueou esta pessoa',
    selfSend: 'Não é possível enviar para si',
    noStamps: 'O limite de envio de hoje acabou',
    tooLong: 'Mensagem longa demais',
    sent: 'Enviada',
    uncertain: 'Não deu para confirmar o envio. Tentar de novo manda a mesma mensagem.',
    deletedQuote: 'respondendo a uma mensagem apagada neste aparelho',
    olderQuote: 'respondendo a uma mensagem anterior',
    reportNote: 'Só esta mensagem e a conta de quem enviou vão para a moderação. Nada mais da conversa.'
  })
})

test('sortConversations orders by at descending, then peer ascending', async (t) => {
  const { sortConversations } = await load()
  const zz = { peer: 'zz', at: '2026-05-03T00:00:00.000Z' }
  const cc = { peer: 'cc', at: '2026-05-02T00:00:00.000Z' }
  const bb = { peer: 'bb', at: '2026-05-02T00:00:00.000Z' }
  const aa = { peer: 'aa', at: '2026-05-01T00:00:00.000Z' }
  const input = Object.freeze([cc, aa, bb, zz])
  const sorted = sortConversations(input)
  t.alike(sorted.map((item) => item.peer), ['zz', 'bb', 'cc', 'aa'])
  t.is(sorted[0], zz, 'rows keep their identity')
  t.is(input[0], cc, 'the input order stays')
  const tieA = { peer: 'aa', at: '2026-05-01T00:00:00.000Z', n: 1 }
  const tieB = { peer: 'aa', at: '2026-05-01T00:00:00.000Z', n: 2 }
  t.alike(sortConversations([tieB, tieA]).map((item) => item.n), [2, 1], 'equal rows keep arrival order')
  const missing = { peer: 'a' }
  const bad = { peer: 'b', at: 'not-a-date' }
  t.alike(sortConversations([missing, bad, aa]).map((item) => item.peer), ['aa', 'a', 'b'])
  t.alike(sortConversations(null), [])
  t.alike(sortConversations([null, aa, 'x']).map((item) => item.peer), ['aa'])
})

test('splitFolders separates inbox and requests and drops anything else', async (t) => {
  const { splitFolders } = await load()
  const a = { peer: 'a', folder: 'inbox' }
  const b = { peer: 'b', folder: 'request' }
  const c = { peer: 'c', folder: 'inbox' }
  const d = { peer: 'd', folder: 'other' }
  const e = { peer: 'e' }
  const split = splitFolders([a, b, null, c, d, e, 'x'])
  t.alike(split.inbox, [a, c])
  t.alike(split.requests, [b])
  t.is(split.inbox[0], a)
  t.alike(splitFolders(null), { inbox: [], requests: [] })
  t.alike(splitFolders({ folder: 'inbox' }), { inbox: [], requests: [] })
})

test('tabDot and requestsDot are booleans and never a count', async (t) => {
  const { tabDot, requestsDot, splitFolders } = await load()
  const many = [{ unread: true }, { unread: true }, { unread: true }, { unread: true }]
  const dot = tabDot({ inbox: many, requests: [] })
  t.is(dot, true)
  t.is(typeof dot, 'boolean')
  t.is(tabDot({ inbox: [], requests: [] }), false)
  t.is(tabDot({ inbox: [{ unread: false }], requests: [{ unread: false }] }), false)
  t.is(tabDot({ inbox: [], requests: [{ unread: true }] }), true)
  t.is(tabDot({ inbox: [{ unread: 5 }], requests: [{ unread: 2 }] }), false, 'a number is not a dot')
  t.is(tabDot(null), false)
  t.is(tabDot({}), false)
  const requestsDotOn = requestsDot(many)
  t.is(requestsDotOn, true)
  t.is(typeof requestsDotOn, 'boolean')
  t.is(requestsDot([]), false)
  t.is(requestsDot([{ unread: false }]), false)
  t.is(requestsDot([{ unread: 9 }, { unread: 9 }]), false)
  t.is(requestsDot(null), false)
  t.is(requestsDot(4), false)
  const split = splitFolders([
    { peer: 'a', folder: 'inbox', unread: false },
    { peer: 'b', folder: 'request', unread: true }
  ])
  t.is(tabDot(split), true)
  t.is(requestsDot(split.requests), true)
  t.is(tabDot({ inbox: split.inbox, requests: [] }), false)
})

test('threadOf is oldest first and resolves replyTo to the quoted text or null', async (t) => {
  const { threadOf, LABELS } = await load()
  const raw = { id: 'm1', at: '2026-05-01T00:00:00.000Z', text: 'primeira\u202e', replyTo: null }
  const messages = [
    { id: 'm3', at: '2026-05-03T00:00:00.000Z', text: 'terceira', replyTo: 'm1' },
    raw,
    { id: 'm2', at: '2026-05-02T00:00:00.000Z', text: 'segunda', replyTo: 'gone' },
    { id: 'm4', at: '2026-05-04T00:00:00.000Z', text: 'quarta', replyTo: 'm5' },
    { id: 'm5', at: '2026-05-02T12:00:00.000Z', text: 'secreto', replyTo: null, deleted: true },
    { text: 'sem id' },
    null
  ]
  const rows = threadOf(messages)
  t.alike(rows.map((row) => row.id), ['m1', 'm2', 'm5', 'm3', 'm4'])
  t.alike(rows[0], {
    id: 'm1',
    at: '2026-05-01T00:00:00.000Z',
    text: 'primeira\ufffd',
    deleted: false,
    replyTo: null
  })
  t.is(raw.text, 'primeira\u202e', 'the input text stays raw')
  t.is(raw.replyTo, null)
  t.is(rows[1].replyTo, LABELS.olderQuote, 'a quote outside the loaded rows is neutral')
  t.alike(rows[2], {
    id: 'm5',
    at: '2026-05-02T12:00:00.000Z',
    text: '',
    deleted: true,
    replyTo: null
  })
  t.is(rows[3].replyTo, 'primeira\ufffd')
  t.is(rows[4].replyTo, LABELS.deletedQuote)
  const tied = threadOf([
    { id: 'b', at: '2026-05-01T00:00:00.000Z', text: 'bee', replyTo: null },
    { id: 'a', at: '2026-05-01T00:00:00.000Z', text: 'ay', replyTo: 'b' }
  ])
  t.alike(tied.map((row) => row.id), ['a', 'b'])
  t.is(tied[0].replyTo, 'bee')
  t.alike(threadOf(null), [])
  t.alike(threadOf([{ id: '', at: '2026-05-01T00:00:00.000Z', text: 'x' }]), [])
  const lines = threadOf([
    { id: 'l1', at: '2026-05-01T00:00:00.000Z', text: 'uma\nduas', replyTo: null },
    { id: 'l2', at: '2026-05-02T00:00:00.000Z', text: 'ok', replyTo: 'l1' }
  ])
  t.is(lines[0].text, 'uma\nduas', 'a line break in a message survives')
  t.is(lines[1].replyTo, 'uma\nduas', 'and in the quoted text')
  // A shared id quotes the message of the smaller sender key, on both
  // participants' devices (mine flips between them, the keys do not).
  const small = 'a'.repeat(64)
  const big = 'b'.repeat(64)
  const shared = threadOf([
    { id: 'x', from: big, at: '2026-05-01T00:00:00.000Z', text: 'da chave maior', replyTo: null, mine: true },
    { id: 'x', from: small, at: '2026-05-02T00:00:00.000Z', text: 'da chave menor', replyTo: null, mine: false },
    { id: 'r', from: small, at: '2026-05-03T00:00:00.000Z', text: 'resposta', replyTo: 'x', mine: false }
  ])
  t.is(shared[2].replyTo, 'da chave menor', 'a shared id quotes the smaller sender key')
  const otherDevice = threadOf([
    { id: 'x', from: small, at: '2026-05-01T00:00:00.000Z', text: 'da chave menor', replyTo: null, mine: true },
    { id: 'x', from: big, at: '2026-05-02T00:00:00.000Z', text: 'da chave maior', replyTo: null, mine: false },
    { id: 'r', from: small, at: '2026-05-03T00:00:00.000Z', text: 'resposta', replyTo: 'x', mine: true }
  ])
  t.is(otherDevice[2].replyTo, 'da chave menor', 'the same quote on the other device, whatever the order')
})

test('dm.js has no read, delivery or typing words and no em dash', async (t) => {
  const { LABELS } = await load()
  const src = readFileSync(join(__dirname, '../src/dm.js'), 'utf8')
  for (const word of ['lida', 'entregue', 'digitando']) {
    t.absent(src.includes(word), word)
    for (const text of Object.values(LABELS)) t.absent(text.includes(word), text + ' / ' + word)
  }
  t.absent(src.includes('\u2014'))
  for (const text of Object.values(LABELS)) t.absent(text.includes('\u2014'), text)
})
