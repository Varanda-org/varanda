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

test('Bubble keeps a quote clear of the hover chevron only when there are actions', (t) => {
  const bubble = readFileSync(join(__dirname, '../src/ui/Bubble.js'), 'utf8')
  t.ok(bubble.includes('quoteWithChevron'), 'the quote style for the chevron exists')
  t.ok(/style=\{\[styles\.quote, rows\.length > 0 && styles\.quoteWithChevron\]\}/.test(bubble), 'the quote View takes it only under rows.length > 0')
  t.ok(bubble.includes("accessibilityLabel='ações da mensagem'"), 'the chevron keeps its label')
})

test('Mensagem shows a removable post context chip and sends it only as composed text', (t) => {
  const src = readFileSync(join(__dirname, '../src/screens/Mensagem.js'), 'utf8')
  t.ok(src.includes("<IconAction icon='fechar' label='remover contexto' onPress={() => setContext(null)} />"), 'the chip is removable')
  t.ok(src.includes('const [context, setContext] = useState(null)') && src.includes('const [draft, setDraft] = useState(() => initialMessage(initial).draft)'), 'the chip is apart from the draft')
  t.ok(src.includes('usedIntents.current.has(intent.id)') && src.includes('onIntentUsed(intent.id)'), 'an intent is used once')
  t.ok(src.includes('const outgoing = context !== null ? composeText(context, draft) : draft'), 'composeText on Enviar')
  t.ok(src.includes("if (context !== null && draft.trim() === '') return undefined"), 'never without the typed text')
  // contextExcerpt runs displayText after flattening the text and dropping links.
  t.ok(src.includes('{contextExcerpt(context.text)}'), 'the preview is the safe excerpt that is sent')
  t.absent(/replyTo:\s*(intent|context)/.test(src), 'replyTo never comes from the intent')
  t.absent(src.includes('intent.context.seq') || src.includes('context.seq'), 'the post reference never reaches dm.send')
})

test('Mensagem takes an intent only on top of the stack', (t) => {
  const src = readFileSync(join(__dirname, '../src/screens/Mensagem.js'), 'utf8')
  t.ok(src.includes("if (!isTop || !intent || typeof intent.id !== 'string' || usedIntents.current.has(intent.id)) return"), 'a buried conversation neither shows nor uses an intent')
  t.ok(src.includes('}, [isTop, intent, peer, onIntentUsed])'), 'the intent is read again when the screen comes on top')
  const app = readFileSync(join(__dirname, '../App.js'), 'utf8')
  t.ok(app.includes('<Mensagem peer={entry.key} intent={i === stack.length - 1 ? intentsRef.current.get(entry.key) : undefined}'), 'App hands the intent to the top Mensagem only')
  t.absent(app.includes('intent={intentsRef.current.get(entry.key)}'), 'never to every mounted Mensagem')
})

test('Mensagem names the post by an absolute date and retries the held text', (t) => {
  const src = readFileSync(join(__dirname, '../src/screens/Mensagem.js'), 'utf8')
  t.ok(src.includes('{contextLabel(context, now)}'), 'the chip title is the absolute date')
  t.absent(src.includes('relativeTime(context.at'), 'never a relative time on the chip')
  t.ok(src.includes('const attempt = sendAttempt(hold, draft, context, outgoing)') && src.includes('sendPlan(hold, attempt, quoteId)'), 'an unchanged draft retries the held text')
})

test('Mensagem gives the composer the budget left after the chip prefix', (t) => {
  const src = readFileSync(join(__dirname, '../src/screens/Mensagem.js'), 'utf8')
  t.ok(src.includes("const budget = MAX_TEXT - (context !== null ? countChars(composeText(context, '.')) - 1 : 0)"), 'the budget subtracts the prefix')
  t.ok(src.includes('const left = budget - countChars(draft)'), 'Enviar uses the same budget')
  t.ok(src.includes('max={budget}'), 'the counter uses the same budget')
  const composer = readFileSync(join(__dirname, '../src/ui/ChatComposer.js'), 'utf8')
  t.ok(composer.includes('max = MAX_TEXT,') && composer.includes('const left = max - countChars(text)'), 'the composer counts from max, MAX_TEXT by default')
})

test('the context chip keeps its date with large text and blocks voice notes', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'screens', 'Mensagem.js'), 'utf8')
  // The date tells two photos apart: the title may wrap, never be cut to one line.
  if (!src.includes('<Text style={styles.chipTitle} numberOfLines={2}>')) throw new Error('chip title must wrap to two lines')
  // A voice note would go without the context and leave the chip behind.
  if (!src.includes('attachments.items.length === 0 && context === null ? sendVoice : null')) throw new Error('no voice note while a context chip waits')
})

test('the chip shows the excerpt the message will carry, never the raw post text', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'screens', 'Mensagem.js'), 'utf8')
  if (src.includes('displayText(context.text)')) throw new Error('raw post text in the chip (newlines become U+FFFD, links differ from the sent text)')
  if (!src.includes('{contextExcerpt(context.text)}</Text>')) throw new Error('the chip must show contextExcerpt')
})

test('a held send that lands later keeps a draft whose chip changed', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'screens', 'Mensagem.js'), 'utf8')
  if (!src.includes("if (typed !== text && contextRef.current === ctx) setDraft((d) => (d === typed ? '' : d))")) throw new Error('the typed draft is cleared only while its chip is unchanged')
})

test('a photo send that lands later keeps a draft whose chip changed', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'screens', 'Mensagem.js'), 'utf8')
  if (!src.includes("if (contextRef.current === ctx) setDraft((d) => (d === typed ? '' : d))")) throw new Error('the photo path clears the typed draft only while its chip is unchanged')
})

test('a page retry keeps a draft whose chip was removed', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'screens', 'Mensagem.js'), 'utf8')
  if (!src.includes("if (contextRef.current === (hold.ctx || null)) setDraft('')")) throw new Error('the page retry clears the draft only while its chip is unchanged')
})

// The owned screen exports these pure rules; extracting them avoids loading React Native.
function screenHelper (file, name, deps = {}) {
  const source = readFileSync(join(__dirname, '../src/screens/' + file + '.js'), 'utf8')
  const match = source.match(new RegExp('(?:export )?function ' + name + ' \\([^]*?\\n\\}'))
  if (!match) throw new Error('missing helper: ' + name)
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(deps), match[0].replace(/^export /, '') + '\nreturn ' + name)(...Object.values(deps))
}

async function listingHelpers () {
  const { listingLinkOf } = await import('../src/feiraChat.js')
  const { parseRich, plainOf } = await import('../src/richText.js')
  const cardBesideSpoilers = screenHelper('../ui/RichText', 'cardBesideSpoilers')
  const visibleListingLink = screenHelper('Mensagem', 'visibleListingLink', { listingLinkOf, plainOf, parseRich, cardBesideSpoilers })
  const listingLinkForRow = screenHelper('Mensagem', 'listingLinkForRow', { visibleListingLink })
  return { visibleListingLink, listingLinkForRow }
}

test('Mensagem listing pill recognizes text, stored cards and fragments only on this installation', async (t) => {
  const { listingLinkForRow } = await listingHelpers()
  const origin = 'https://bora.varanda.app'
  const url = origin + '/f/' + HEX('a') + '/7'
  const ref = { author: HEX('a'), seq: 7 }
  t.alike(listingLinkForRow({ rawText: 'Veja: ' + url }, origin), ref)
  t.alike(listingLinkForRow({ rawText: 'Tenho interesse', card: { url } }, origin), ref)
  t.alike(listingLinkForRow({ rawText: url + '#oferta=5000' }, origin), ref)
  t.alike(listingLinkForRow({ card: { url: url + '#oferta=5000&resposta=recusada' } }, origin), ref)
  const foreign = 'https://outra.example/f/' + HEX('a') + '/7'
  t.is(listingLinkForRow({ rawText: foreign }, origin), null)
  t.is(listingLinkForRow({ card: { url: foreign } }, origin), null)
  t.is(listingLinkForRow({ deleted: true, rawText: url, card: { url } }, origin), null)
  t.is(listingLinkForRow(null, origin), null)
  const src = readFileSync(join(__dirname, '../src/screens/Mensagem.js'), 'utf8')
  t.ok(src.includes("<Pill label='Ver anúncio' onPress={() => onOpenListing(listing.author, listing.seq)}"), 'opening is an explicit navigation tap')
  t.ok(src.includes('row.listingLink = listingLinkForRow({ ...row, card: cardOf.get(row.key) }, origin)'), 'stored card URL reaches the same rule')
  t.ok(src.includes('showListingReplies(rows, pageKey !== null ? pageKey : ownKey) && !hold'), 'quick replies use the listing author rule')
  t.ok(src.includes('quickReplies().map((text) => <Pill'), 'chips use the shared replies')
})

test('a listing link covered by a spoiler gives no pill and no offer target', async (t) => {
  const { visibleListingLink, listingLinkForRow } = await listingHelpers()
  const { offerTarget } = await import('../src/feiraOffer.js')
  const origin = 'https://bora.varanda.app'
  const url = origin + '/f/' + HEX('a') + '/7'
  const ref = { author: HEX('a'), seq: 7 }
  const card = { url, title: 'Bike' }
  t.is(listingLinkForRow({ rawText: 'oi ||veja ' + url + ' aqui||' }, origin), null, 'a link only inside a spoiler: no pill')
  t.is(listingLinkForRow({ rawText: 'oi ||veja ' + url + ' aqui||', card }, origin), null, 'nor through the card the bubble hides')
  t.is(listingLinkForRow({ rawText: 'oi ||segredo||', card }, origin), null, 'a card beside a spoiler and no visible link: hidden, no pill')
  t.alike(listingLinkForRow({ rawText: 'veja ' + url + ' ||segredo||', card }, origin), ref, 'the visible link keeps its pill')
  t.alike(listingLinkForRow({ rawText: '```\na\n' + url + '\n```' }, origin), ref, 'a later code line counts as the bubble shows it')
  const seller = HEX('a')
  const msgs = [
    { id: 'm1', from: seller, text: 'veja ' + url, card: null },
    { id: 'm2', from: seller, text: '||outro ' + origin + '/f/' + HEX('a') + '/9 aqui||', card: { url: origin + '/f/' + HEX('a') + '/9', title: 'Oculto' } }
  ]
  t.alike(offerTarget(msgs, seller, origin, (m) => visibleListingLink(m.text, m.card, origin)), { author: seller, seq: 7, title: '' }, 'the offer goes to the newest visible listing, not the covered one')
  const src = readFileSync(join(__dirname, '../src/screens/Mensagem.js'), 'utf8')
  t.ok(src.includes('const linkOfMsg = (m) => visibleListingLink(m.text, m.card, origin)'), 'the offer input reads the same rule')
  t.ok(src.includes('return visibleListingLink(row.rawText, row.card, origin)'), 'the pill reads the same rule')
})

test('Mensagem quick replies show to whoever did not author the newest listing link', (t) => {
  const showListingReplies = screenHelper('Mensagem', 'showListingReplies')
  const seller = HEX('a')
  const buyer = HEX('b')
  const card = (mine) => ({ listingLink: { author: seller, seq: 7 }, mine })
  const plain = { listingLink: null, mine: true }
  t.is(showListingReplies([], buyer), false)
  t.is(showListingReplies([plain], buyer), false)
  t.is(showListingReplies([card(true)], buyer), true, 'the buyer sent the seller card: the buyer sees the replies')
  t.is(showListingReplies([card(false)], seller), false, 'the seller receiving that card does not')
  t.is(showListingReplies([card(true)], seller), false, 'the seller sharing their own card does not')
  t.is(showListingReplies([card(false)], buyer), true, 'the buyer receiving the seller card does')
  t.is(showListingReplies([{ listingLink: { author: buyer, seq: 1 }, mine: true }, card(false), plain], buyer), true, 'the newest link decides')
  t.is(showListingReplies([card(true)], seller.toUpperCase()), true, 'keys compare as given')
  t.is(showListingReplies([card(true)]), false, 'no identity: no replies')
})

test('Mensagem initial snapshot stays editable, sends its DM thumbnail once and drops the card for photos', async (t) => {
  const linkCard = await import('../src/linkCard.js')
  const { previewTarget } = await import('../src/preview.js')
  const { displayText, validateParams } = require('@varanda/rpc')
  const initialMessage = screenHelper('Mensagem', 'initialMessage', { ...linkCard, previewTarget, displayText })
  const url = 'https://bora.varanda.app/f/' + HEX('a') + '/7'
  const initial = {
    draft: 'Olá! ' + url,
    card: { url, host: 'bora.varanda.app', title: 'Bicicleta', desc: 'Produto', thumb: { bytes: new Uint8Array([1, 2]), mime: 'image/jpeg', width: 2, height: 1 } }
  }
  const state = initialMessage(initial)
  t.is(state.draft, initial.draft)
  t.alike(initialMessage(null), { draft: '', card: linkCard.linkDraftIdle() })
  const edited = 'Tenho uma pergunta: ' + url
  const snapshot = linkCard.freezeSnapshot(state.card, edited)
  t.ok(snapshot)
  t.is(snapshot.thumb.bytes, initial.card.thumb.bytes, 'the shell thumbnail survives without a fetch')
  t.is(linkCard.freezeSnapshot(state.card, 'Sem link'), null, 'editing away the URL drops the card')
  const dismissed = linkCard.linkDraftStep(state.card, { type: 'dismiss' })
  t.is(linkCard.freezeSnapshot(dismissed, state.draft), null)
  const photo = linkCard.photoDropsCard(state.card, true)
  t.is(linkCard.freezeSnapshot(photo, state.draft), null)
  t.is(linkCard.freezeSnapshot(linkCard.photoDropsCard(photo, false), state.draft), null, 'removing the photo does not revive the card')
  const { composePlan } = await plans()
  const target = { kind: 'dm', to: HEX('b') }
  let uploads = 0
  const card = await linkCard.cardForSend(snapshot, { upload: async () => { uploads++; return dmItem(1) } })
  const params = composePlan({ text: edited, target, card }).send().params
  t.is(uploads, 1)
  t.alike(Object.keys(params.card).sort(), ['desc', 'host', 'image', 'title', 'url'])
  t.ok(validateParams('dm.send', params).ok, 'the actual RPC validator accepts the stored thumbnail')
  const { stagedOf } = await chatSend()
  const attachments = stagedOf([{ bytes: new Uint8Array([1]), mime: 'image/jpeg', width: 1, height: 1 }])
  t.exception(() => composePlan({ text: edited, target, card, attachments }), 'card and attachments remain mutually exclusive')
  const src = readFileSync(join(__dirname, '../src/screens/Mensagem.js'), 'utf8')
  t.ok(src.includes('mediaApi.putDm({ bytes: t.bytes, mime: t.mime, width: t.width, height: t.height, to: peer })'), 'the upload is bound to the destination')
  t.ok(src.includes('card = await cardForSend(snapshot,'), 'initial snapshots use the existing send path')
  t.ok(src.includes("linkDraftStep(s, { type: 'photo' })"), 'staging a photo drops the initial snapshot')
})

test('Mensagem discards initial state across identity changes, including switching back', (t) => {
  const messageEntry = screenHelper('Mensagem', 'messageEntry')
  const initial = { draft: 'rascunho', card: { url: 'https://bora.varanda.app' } }
  const first = messageEntry(null, 'member-a', initial)
  t.is(first.initial, initial)
  t.is(messageEntry(first, 'member-a', initial), first)
  const page = messageEntry(first, 'page-a', initial)
  t.is(page.initial, null)
  const member = messageEntry(page, 'member-b', initial)
  t.is(member.initial, null)
  t.is(messageEntry(member, 'member-a', initial).initial, null, 'the original snapshot is never restored')
  const src = readFileSync(join(__dirname, '../src/screens/Mensagem.js'), 'utf8')
  t.ok(src.includes("key={identity + ':' + props.peer}"), 'identity and peer changes remount the whole composer and its holds')
  t.ok(src.includes('if (!live.current) return null'), 'an upload finishing after unmount cannot send')
  t.ok(src.includes('if (!live.current) return\n'), 'a late send answer cannot restore a held message')
})

test('Conversar is offered only for an open page on a hosted node with pages enabled', (t) => {
  const canConverse = screenHelper('Membro', 'canConverseWithPage')
  const open = { page: true, closed: false, moved: false, hosted: true, enabled: true }
  t.is(canConverse(open), true)
  for (const flags of [{ page: false }, { closed: true }, { moved: true }, { hosted: false }, { hosted: 1 }, { enabled: false }]) {
    t.is(canConverse({ ...open, ...flags }), false)
  }
  const src = readFileSync(join(__dirname, '../src/screens/Membro.js'), 'utf8')
  t.absent(src.includes('PAGE_NO_DM'))
  const anuncioSrc = readFileSync(join(__dirname, '../src/screens/Anuncio.js'), 'utf8')
  const sheetSrc = readFileSync(join(__dirname, '../src/ui/PageNoticeSheet.js'), 'utf8')
  t.ok(src.includes('<PageNoticeSheet') && anuncioSrc.includes('<PageNoticeSheet'), 'the profile and the listing show the shared page notice sheet')
  t.ok(sheetSrc.includes('{PAGE_DM_NOTICE}') && sheetSrc.includes('<ConfirmStack'), 'the sheet shows the notice over a full-width confirm stack')
  t.ok(sheetSrc.includes("request('dm.lookup', { member: page })") && sheetSrc.includes('{inactive ? <Soft>{PAGE_DM_NOT_ACTIVE}</Soft> : null}'), 'a page without device-held keys gets the extra line')
  t.ok(anuncioSrc.includes('listing.page === true && !pageNoticeSeen(pageNoticeStore(), listing.author)'), 'Conversar on a page listing shows the same notice first')
  t.ok(src.includes("<Pill icon='mensagem' label='Conversar' onPress={openPageConversation}"))
  t.ok(src.includes('onPress={() => onOpenListings(author)}'))
  t.ok(src.includes("const listingsRow = node.hosted === true && !(isPage && lifecycle.moved) && typeof onOpenListings === 'function'"), 'listings require a hosted node and stay hidden on a moved page')
})

test('the page conversation notice persists per device and page key on both storage adapters', async (t) => {
  const { pageNoticeKey, pageNoticeSeen, notePageNotice } = await import('../src/pageNotice.js')
  const seenStore = new Map()
  const fake = { getItem: (k) => seenStore.get(k) || null, setItem: (k, v) => seenStore.set(k, v) }
  t.absent(pageNoticeSeen(fake, HEX('a')))
  notePageNotice(fake, HEX('a'))
  t.ok(pageNoticeSeen(fake, HEX('a')), 'shown once per page key')
  t.absent(pageNoticeSeen(fake, HEX('b')))
  t.absent(pageNoticeSeen({ getItem: () => { throw new Error('x') } }, HEX('a')), 'a failing store shows the notice again')
  const a = pageNoticeKey(HEX('a'))
  const b = pageNoticeKey(HEX('b'))
  t.not(a, b)
  t.is(pageNoticeKey('../invalid'), null)
  for (const platform of ['web', 'native']) {
    const data = new Map()
    const store = { getItem: (key) => data.get(key) || null, setItem: (key, value) => data.set(key, value) }
    class File {
      constructor (root, name) { this.name = root + '/' + name }
      get exists () { return data.has(this.name) }
      create () { data.set(this.name, '') }
      textSync () { return data.get(this.name) }
      write (text) { data.set(this.name, text) }
    }
    const pageNoticeStore = screenHelper('../pageNoticeStore.' + platform, 'pageNoticeStore', {
      globalThis: { localStorage: store },
      File,
      Paths: { document: '/device' }
    })
    t.is(pageNoticeStore().getItem(a), null, platform + ': first visit needs the sheet')
    pageNoticeStore().setItem(a, '1')
    t.is(pageNoticeStore().getItem(a), '1', platform + ': a new adapter remembers confirmation')
    t.is(pageNoticeStore().getItem(b), null, platform + ': another page needs its own sheet')
    if (platform === 'native') t.is(data.get('/device/' + a + '.json'), '1', 'one file per page key')
  }
  const src = readFileSync(join(__dirname, '../src/screens/Membro.js'), 'utf8')
  t.ok(src.includes("import { pageNoticeStore } from '../pageNoticeStore'"))
  t.absent(src.includes('Platform.OS'))
  t.absent(src.includes('expo-file-system'))
})

test('the web page notice tolerates unavailable storage and denied reads or writes', (t) => {
  const denied = () => { throw new Error('storage denied') }
  for (const globalThis of [
    {},
    { get localStorage () { return denied() } },
    { localStorage: { getItem: denied, setItem: denied } }
  ]) {
    const pageNoticeStore = screenHelper('../pageNoticeStore.web', 'pageNoticeStore', { globalThis })
    t.is(pageNoticeStore().getItem('notice'), null)
    t.execution(() => pageNoticeStore().setItem('notice', '1'))
  }
})

test('pageReadKind tells a page from a person from an unknown read', async (t) => {
  const { pageReadKind } = await import('../src/pageNotice.js')
  const key = 'a'.repeat(64)
  const base = { page: key, gen: null, owner: null, closed: false, movedTo: null, complete: true }
  t.is(pageReadKind({ ...base, gen: 1 }, key), 'page')
  t.is(pageReadKind({ ...base, owner: 'b'.repeat(64) }, key), 'page')
  t.is(pageReadKind({ ...base, closed: true }, key), 'page')
  t.is(pageReadKind({ ...base, movedTo: 'c'.repeat(64) }, key), 'page')
  t.is(pageReadKind({ ...base, gen: 1, complete: false }, key), 'page')
  t.is(pageReadKind(base, key), 'person')
  t.is(pageReadKind({ ...base, complete: false }, key), 'unknown')
  t.is(pageReadKind(null, key), 'unknown')
  t.is(pageReadKind(undefined, key), 'unknown')
  t.is(pageReadKind(new Error('boom'), key), 'unknown')
  t.is(pageReadKind({ ...base, gen: 1 }, 'd'.repeat(64)), 'unknown')
})

test('pageDmPlan opens, refuses, notices or goes direct', async (t) => {
  const { pageDmPlan } = await import('../src/pageNotice.js')
  const hint = { page: true, closed: false, moved: false }
  t.is(pageDmPlan({ hint: null, read: 'person', seen: false, canConverse: true }), 'open')
  t.is(pageDmPlan({ hint: null, read: 'unknown', seen: false, canConverse: true }), 'open')
  t.is(pageDmPlan({ hint: { ...hint, page: false }, read: 'unknown', seen: false, canConverse: true }), 'open')
  t.is(pageDmPlan({ hint, read: 'person', seen: false, canConverse: true }), 'open')
  t.is(pageDmPlan({ hint: null, read: 'page', seen: false, canConverse: false }), 'refuse')
  t.is(pageDmPlan({ hint: null, read: 'page', seen: false, canConverse: true }), 'notice')
  t.is(pageDmPlan({ hint: null, read: 'page', seen: true, canConverse: true }), 'direct')
  t.is(pageDmPlan({ hint: null, read: 'page', seen: true, canConverse: false }), 'refuse')
  t.is(pageDmPlan({ hint, read: 'page', seen: false, canConverse: false }), 'refuse')
  t.is(pageDmPlan({ hint, read: 'unknown', seen: false, canConverse: true }), 'notice')
  t.is(pageDmPlan({ hint, read: 'unknown', seen: true, canConverse: true }), 'direct')
  // The seeder's hint alone never refuses: a person's messages stay open.
  t.is(pageDmPlan({ hint: { ...hint, closed: true }, read: 'unknown', seen: false, canConverse: false }), 'notice')
  t.is(pageDmPlan({ hint: { ...hint, moved: true }, read: 'unknown', seen: true, canConverse: false }), 'direct')
})

test('pageNotice.js stays pure and the notice ends with a period', async (t) => {
  const { PAGE_DM_NOTICE, PAGE_DM_NOT_ACTIVE } = await import('../src/pageNotice.js')
  t.ok(PAGE_DM_NOTICE.endsWith('.'))
  t.is(PAGE_DM_NOTICE, 'As mensagens desta conversa são cifradas entre você e quem administra a página. A associação não lê.')
  t.is(PAGE_DM_NOT_ACTIVE, 'Esta página ainda não ativou as Conversas privadas. Sua mensagem chega quando ela ativar.')
  t.absent(/pode ler/.test(PAGE_DM_NOTICE), 'no custody caveat')
  const src = readFileSync(join(__dirname, '../src/pageNotice.js'), 'utf8')
  t.absent(src.split('\n').some((l) => l.startsWith('import ')))
})

test('openMessage checks whether a post author is a page before the context chip', (t) => {
  const src = readFileSync(join(__dirname, '../App.js'), 'utf8')
  const start = src.indexOf('const openMessage = useCallback(')
  const end = src.indexOf('const intentUsed', start)
  t.ok(start !== -1 && end > start, 'openMessage slice found')
  const slice = src.slice(start, end)
  t.ok(slice.includes("request('page.read', { key })"), 'asks the node for the page')
  t.ok(slice.includes('fetchMember('), 'asks the member index for the page hint')
  t.ok(slice.includes('pageDmPlan('), 'one plan decides')
  t.ok(slice.includes("showToast('Esta página não recebe mensagens.')"), 'a closed or moved page refuses')
  t.ok(slice.includes("if (plan === 'direct') return pushScreen({ screen: 'mensagem', key, params: {} })"), 'a page opens with no context')
  t.ok(slice.includes('if (pageDmPending.current === key) return'), 'a double tap waits for the first')
  t.ok(slice.includes('if (ownKeyRef.current !== pressOwn || nodeEpochRef.current !== pressEpoch) return'), 'a late answer after a lock or identity change is dropped')
  t.ok(src.includes('const pageDmGen = useRef(0)'), 'lookup generations persist across renders')
  t.ok(slice.includes('const pressGen = ++pageDmGen.current'), 'a lookup captures a new generation')
  t.ok(slice.indexOf('if (pageDmPending.current === key) return') < slice.indexOf('const pressGen = ++pageDmGen.current'), 'a double tap preserves the pending generation')
  t.ok(/if \(!\(options && options.context && typeof key === 'string'\)\) \{\s*pageDmGen.current\+\+\s*pageDmPending.current = null\s*return open\(\)/.test(slice), 'an immediate conversation supersedes pending lookups')
  t.ok(/if \(prof && prof.page === true\) \{\s*pageDmGen.current\+\+\s*pageDmPending.current = null\s*return decide\(/.test(slice), 'a known page supersedes pending lookups')
  t.ok(/\.then\(\(\[hint, r\]\) => \{\s*if \(pageDmGen.current !== pressGen\) return/.test(slice), 'superseded completions return before learning or deciding')
  t.ok(slice.includes('setTimeout(() => resolve(null), 2500)'), 'a slow lookup becomes no answer after 2500 ms')
  t.ok(slice.includes('Promise.race([') && slice.includes('.finally(() => clearTimeout(timer))'), 'the timeout races the lookup and is cleared on completion')
  t.ok(slice.includes('Promise.all([bounded(hintP), bounded(readP)])'), 'both parallel lookups have a timeout')
  t.ok(src.includes("import Membro, { canConverseWithPage } from './src/screens/Membro'"))
  const learn = slice.indexOf('names.learnMany(')
  const guard = slice.indexOf("if (read === 'page') {")
  t.ok(guard !== -1 && learn > guard, 'only a node-verified page is remembered as a page')
  t.absent(slice.includes('hint !== null)'), 'the seeder hint alone never reaches the names cache')
  t.is(slice.split('names.learnMany(').length, 2, 'one guarded learn')
  t.ok(/useEffect\(\(\) => \{\s*intentsRef\.current\.clear\(\)\s*setPageDmAsk\(null\)\s*pageDmPending\.current = null\s*\}, \[ownKey, nodeEpoch\]\)/.test(src), 'a lock or identity switch closes the page notice and drops the pending lookup')
})

test('pageNotActivated reads the page\'s published dm-key', async (t) => {
  const { pageNotActivated } = await import('../src/pageNotice.js')
  t.is(pageNotActivated({ box: null, gen: null }), true, 'no key')
  t.is(pageNotActivated({ box: 'a'.repeat(64), gen: 1 }), false, 'a gen 1 key may be a new activated page')
  t.is(pageNotActivated({ box: 'a'.repeat(64), gen: 2 }), false)
  t.is(pageNotActivated(null), false, 'an unknown read shows nothing extra')
})
