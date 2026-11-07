'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const load = () => import('../src/dm.js')

test('dm.js exports the list helpers, the thread and the labels', async (t) => {
  const dm = await load()
  t.alike(Object.keys(dm).sort(), [
    'LABELS', 'UNSURE_SEND', 'requestsDot', 'sortConversations', 'splitFolders', 'tabDot', 'threadOf'
  ].sort())
  const imports = readFileSync(join(__dirname, '../src/dm.js'), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('import '))
  t.alike(imports, ["import rpc from '@varanda/rpc'"])
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

test('the chat screens and components have no read, delivery or typing words', (t) => {
  for (const file of ['../src/screens/Mensagem.js', '../src/ui/Bubble.js', '../src/ui/ChatComposer.js', '../src/ui/ActionsSheet.js', '../src/ui/ChatMedia.js', '../src/ui/AttachSheet.js', '../src/ui/ForwardSheet.js']) {
    const src = readFileSync(join(__dirname, file), 'utf8')
    for (const word of ['lida', 'entregue', 'digitando']) t.absent(src.includes(word), file + ': ' + word)
    t.absent(src.includes('\u2014'), file)
  }
})

const chatSend = () => import('../src/chatSend.js')
const plans = () => import('../src/attach-plan.js')
const HEX = (c) => c.repeat(64)
const MSG = 'ab'.repeat(16)

test('chatMediaLayout: one keeps its aspect, two side by side, three and four in a grid, never past 240', async (t) => {
  const { chatMediaLayout, CHAT_MEDIA_MAX_WIDTH } = await chatSend()
  t.is(CHAT_MEDIA_MAX_WIDTH, 240)
  const one = chatMediaLayout([{ w: 400, h: 200 }])
  t.alike(one, { width: 240, height: 120, cells: [{ left: 0, top: 0, width: 240, height: 120 }] })
  t.is(chatMediaLayout([{ w: 100, h: 1000 }]).height, 480, 'a tall image is clamped to 1:2')
  t.is(chatMediaLayout([{}]).height, 240, 'unknown size is square')
  const two = chatMediaLayout([{}, {}])
  t.is(two.cells.length, 2)
  t.is(two.cells[0].width + two.cells[1].width + 2, 240)
  t.is(two.cells[1].left, 240 - two.cells[1].width)
  const three = chatMediaLayout([{}, {}, {}])
  t.is(three.cells[2].width, 240, 'the third one is wide')
  t.is(three.cells[2].top, three.cells[0].height + 2)
  const four = chatMediaLayout([{}, {}, {}, {}])
  t.is(four.cells.length, 4)
  for (const layout of [one, two, three, four]) {
    for (const c of layout.cells) t.ok(c.left + c.width <= 240, 'inside the width')
  }
  t.is(chatMediaLayout([]), null)
  t.is(chatMediaLayout([{}, {}, {}, {}, {}]), null)
  t.is(chatMediaLayout([{}], 1000).width, 240, 'a wider column still stops at 240')
  t.is(chatMediaLayout([{}], 200).width, 200)
})

test('chatMediaRefs names the DM sender, message and index, and the group diary', async (t) => {
  const { chatMediaRefs, itemSize } = await chatSend()
  const a = { id: 'x', w: 3, h: 2 }
  const b = { unavailable: true }
  t.alike(chatMediaRefs('dm', { from: HEX('a'), id: MSG, media: [a, b] }), [
    { kind: 'dm', from: HEX('a'), id: MSG, index: 0, item: a },
    { kind: 'dm', from: HEX('a'), id: MSG, index: 1, item: b }
  ])
  t.alike(chatMediaRefs('group', { diary: HEX('b'), media: [a] }), [{ kind: 'group', diary: HEX('b'), item: a }])
  t.alike(chatMediaRefs('dm', { from: HEX('a'), id: MSG }), [])
  t.alike(chatMediaRefs('group', { media: [a] }), [], 'no diary, no ref')
  t.is(chatMediaRefs('dm', { from: HEX('a'), id: MSG, media: [a, a, a, a, a] }).length, 4)
  t.alike(itemSize({ w: 3, h: 2 }), { w: 3, h: 2 })
  t.alike(itemSize({ width: 5, height: 4 }), { w: 5, h: 4 })
  t.alike(itemSize(null), { w: null, h: null })
})

test('boundedFile reads the bounds before an upload and takes their size', async (t) => {
  const { boundedFile } = await chatSend()
  const bytes = new Uint8Array([1, 2, 3])
  const calls = []
  const ok = boundedFile({ bytes, mime: 'image/gif', width: 1, height: 1 }, (b, m) => { calls.push(m); return { width: 9, height: 7 } })
  t.alike(calls, ['image/gif'])
  t.is(ok.bytes, bytes, 'GIF bytes are kept as they are')
  t.is(ok.width, 9)
  t.is(ok.height, 7)
  t.is(boundedFile({ bytes, mime: 'image/jpeg' }, () => null), null)
  t.is(boundedFile({ bytes, mime: 'image/jpeg' }, () => { throw new Error('x') }), null)
  t.is(boundedFile({ bytes, mime: 'image/svg+xml' }, () => ({ width: 1, height: 1 })), null)
  t.is(boundedFile({ bytes: new Uint8Array(0), mime: 'image/png' }, () => ({ width: 1, height: 1 })), null)
  // The real bounds from @varanda/rpc refuse what is not an image.
  t.is(boundedFile({ bytes, mime: 'image/png' }), null)
})

function dmItem (n) {
  return { id: n.toString(16).padStart(64, '0'), key: HEX('a'), nonce: 'c'.repeat(48), chunks: 1, bytes: 144, sha256: HEX('a'), mime: 'image/jpeg', w: 4, h: 3, ms: 0 }
}

test('runChatSend: idle -> uploading -> sending -> done, uploads in order, one request', async (t) => {
  const { runChatSend, stagedOf } = await chatSend()
  const { composePlan } = await plans()
  const files = [{ bytes: new Uint8Array([1]), mime: 'image/jpeg', width: 4, height: 3 }, { bytes: new Uint8Array([2]), mime: 'image/gif', width: 4, height: 3 }]
  const plan = composePlan({ text: 'oi', attachments: stagedOf(files), target: { kind: 'dm', to: HEX('d') } })
  const phases = []
  const uploaded = []
  const sent = []
  const r = await runChatSend({
    plan,
    files,
    upload: async (file, i) => { uploaded.push(file); return dmItem(i + 1) },
    request: async (method, params) => { sent.push({ method, params }); return { id: MSG } },
    onPhase: (p) => phases.push(p.phase)
  })
  t.is(r.phase, 'done')
  t.alike(uploaded, files, 'in order, the same bytes')
  t.is(sent.length, 1)
  t.is(sent[0].method, 'dm.send')
  t.is(sent[0].params.media.length, 2)
  t.alike(phases, ['uploading', 'uploading', 'sending', 'done'])
})

test('runChatSend: a failed upload sends nothing; Cancelar before the send discards', async (t) => {
  const { runChatSend, stagedOf } = await chatSend()
  const { composePlan } = await plans()
  const files = [{ bytes: new Uint8Array([1]), mime: 'image/jpeg', width: 4, height: 3 }]
  const target = { kind: 'group', group: HEX('e'), visibility: 'private' }
  let sent = 0
  const failed = await runChatSend({
    plan: composePlan({ text: '', attachments: stagedOf(files), target }),
    files,
    upload: async () => { throw new Error('sem rede') },
    request: async () => { sent++ }
  })
  t.is(failed.phase, 'failed')
  t.is(failed.error.message, 'sem rede')
  t.is(sent, 0)
  let alive = true
  const cancelled = await runChatSend({
    plan: composePlan({ text: '', attachments: stagedOf(files), target }),
    files,
    upload: async () => { alive = false; return {} },
    request: async () => { sent++ },
    live: () => alive
  })
  t.is(cancelled.phase, 'cancelled')
  t.is(sent, 0, 'nothing is sent after Cancelar')
})

test('runChatSend: an uncertain send keeps the exact op and only an explicit retry resends it', async (t) => {
  const { runChatSend, retryChatSend, stagedOf } = await chatSend()
  const { composePlan } = await plans()
  const files = [{ bytes: new Uint8Array([1]), mime: 'image/jpeg', width: 4, height: 3 }]
  const sent = []
  let uploads = 0
  const unsure = Object.assign(new Error('?'), { uncertain: true })
  const first = await runChatSend({
    plan: composePlan({ text: 'legenda', attachments: stagedOf(files), target: { kind: 'dm', to: HEX('d') } }),
    files,
    upload: async () => { uploads++; return dmItem(1) },
    request: async (method, params) => { sent.push({ method, params }); throw unsure }
  })
  t.is(first.phase, 'uncertain')
  t.is(sent.length, 1, 'no automatic second request')
  const phases = []
  const again = await retryChatSend({
    op: first.op,
    request: async (method, params) => { sent.push({ method, params }); return {} },
    onPhase: (p) => phases.push(p.phase)
  })
  t.is(again.phase, 'done')
  t.is(uploads, 1, 'the retry uploads nothing again')
  t.is(sent.length, 2)
  t.alike(sent[1], sent[0], 'the same method and params')
  t.alike(phases, ['sending', 'done'])
  const custom = await runChatSend({
    plan: composePlan({ text: 'x', attachments: [], target: { kind: 'dm', to: HEX('d') } }),
    request: async () => { throw new Error('talvez') },
    uncertain: (err) => err.message === 'talvez'
  })
  t.is(custom.phase, 'uncertain', 'the caller decides what reads as uncertain')
})

test('chat media files never name an http(s) image source and no presence words', (t) => {
  for (const file of ['../src/ui/ChatMedia.js', '../src/ui/AttachSheet.js', '../src/chatSend.js', '../src/ui/ForwardSheet.js']) {
    const src = readFileSync(join(__dirname, file), 'utf8')
    t.absent(/https?:\/\//.test(src), file + ': no http(s) literal')
    for (const word of ['lida', 'entregue', 'digitando']) t.absent(src.includes(word), file + ': ' + word)
    t.absent(src.includes('\u2014'), file)
  }
})

test('Mensagem sends a voice note on the blob channel and keeps the photo send state machine', (t) => {
  const src = readFileSync(join(__dirname, '../src/screens/Mensagem.js'), 'utf8')
  t.ok(src.includes('attachments: [stagedVoice(recording)]'), 'one voice item through composePlan')
  t.ok(src.includes("mediaApi.putDm({ bytes: f.bytes, mime: f.mime, width: 0, height: 0, ms: f.ms, kind: 'voice', to: peer })"), 'the DM blob channel, one blob per destination')
  const worklet = readFileSync(join(__dirname, '../worklet/web-node.js'), 'utf8')
  t.ok(worklet.includes('function putMedia ({ name, mime, width, height, ms, kind, to })') && worklet.includes('{ mime, width, height, ms, kind, to })'), 'the native handler keeps the destination')
  t.ok(src.includes("mediaDone(r, '', quoteId)"), 'the same commit and hold as photos')
  t.ok(src.includes('onVoice={isTop && canAttach && !hold && mediaHold === null'), 'no recording while a send is held or under a pushed screen')
  const composer = readFileSync(join(__dirname, '../src/ui/ChatComposer.js'), 'utf8')
  t.ok(composer.includes("const micOn = typeof onVoice === 'function'"), 'no onVoice hides the microphone')
  t.ok(composer.includes('if (!micOn && voiceNow.current.recRef.current !== null) voiceNow.current.finish(false)'), 'and drops a recording')
  const bubble = readFileSync(join(__dirname, '../src/ui/VoiceBubble.js'), 'utf8')
  t.absent(/https?:\/\//.test(bubble), 'VoiceBubble: no http(s) literal')
  for (const word of ['lida', 'entregue', 'digitando']) t.absent(bubble.includes(word), 'VoiceBubble: ' + word)
})

test('Mensagem offers Encaminhar and marks forwarded messages without the original author', (t) => {
  const src = readFileSync(join(__dirname, '../src/screens/Mensagem.js'), 'utf8')
  t.ok(src.includes("label: 'Encaminhar'"), 'the long press action')
  t.ok(src.includes('const canForward = pageKey === null && unlocked'), 'never as a page')
  t.ok(src.includes('<ForwardSheet'), 'the sheet')
  t.ok(src.includes('forwarded={!item.deleted && fwdOf.get(item.key) === 1}'), 'fwd 1 from dm.thread shows the line')
  t.ok(src.includes('dmForwardSource(item.rawText, mediaOf.get(item.key))'), 'expired media maps to an unavailable item')
  t.ok(src.includes('if (forwardSource !== null) {'), 'no Encaminhar when nothing is left to forward')
  t.absent(src.includes('media: Array.isArray(media) ? media : []'), 'expired media never becomes a plain text forward')
  const bubble = readFileSync(join(__dirname, '../src/ui/Bubble.js'), 'utf8')
  t.ok(bubble.includes("<Icon name='encaminhar'") && bubble.includes('FORWARDED_LABEL'), 'Encaminhada with the encaminhar icon')
})
