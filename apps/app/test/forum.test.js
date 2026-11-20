'use strict'

// Pure forum model (forum.js): titles, the topic list order, the chat view.
const test = require('brittle')

const load = () => import('../src/forum.js')

const A = 'aa'.repeat(32)
const B = 'bb'.repeat(32)
const NOW = Date.parse('2026-11-15T12:00:00.000Z')
const iso = (m) => new Date(NOW - m * 60000).toISOString()

test('the title is the first non-empty line, cut with an ellipsis', async (t) => {
  const { topicTitle, TITLE_MAX, UNTITLED } = await load()
  t.is(topicTitle('\n  \n Horário da feira \nmais texto'), 'Horário da feira')
  t.is(topicTitle(''), UNTITLED)
  t.is(topicTitle(null), UNTITLED)
  const long = topicTitle('x'.repeat(200))
  t.is(Array.from(long).length, TITLE_MAX)
  t.ok(long.endsWith('…'))
  t.is(topicTitle('y'.repeat(TITLE_MAX)), 'y'.repeat(TITLE_MAX), 'at the cap stays whole')
})

test('ago and the last reply label', async (t) => {
  const { ago, lastReplyLabel } = await load()
  t.is(ago(iso(0), NOW), 'agora')
  t.is(ago(iso(5), NOW), 'há 5 min')
  t.is(ago(iso(180), NOW), 'há 3 h')
  t.is(ago(iso(60 * 48), NOW), 'há 2 d')
  t.is(ago('lixo', NOW), '')
  t.is(lastReplyLabel({ replies: 0 }, NOW), 'sem respostas')
  t.is(lastReplyLabel({ replies: 2, last: iso(5) }, NOW), 'última resposta há 5 min')
  t.is(lastReplyLabel({ replies: 2 }, NOW), 'última resposta')
})

test('the list keeps the server order and a reply never bumps', async (t) => {
  const { topicList } = await load()
  const rows = topicList([
    { writer: A, diary: A, seq: 1, at: iso(300), text: 'velho', replies: 9, last: iso(1) },
    { writer: A, diary: A, seq: 2, at: iso(10), text: 'novo', replies: 0, last: null },
    { writer: B, diary: A, seq: 2, at: iso(10), text: 'mesmo instante', replies: 0, last: null },
    { writer: B, diary: B, seq: 3, at: iso(10), text: 'mesmo escritor', replies: 0, last: null },
    { writer: A, diary: A, seq: 2, at: iso(10), text: 'duplicado' },
    { writer: 'xx', seq: 3, at: iso(1), text: 'ruim' },
    { author: A, seq: 5, at: iso(1), text: 'forma antiga' },
    { writer: A, seq: 4, at: 'nope', text: 'sem data' }
  ], NOW)
  t.alike(rows.map((r) => r.key), [A + ':1', A + ':2', B + ':2', B + ':3'], 'the answer order is kept, no re-sort')
  t.is(rows[0].lastReplyLabel, 'última resposta há 1 min')
  t.is(rows[0].last, iso(1))
  t.is(rows[1].lastReplyLabel, 'sem respostas')
  t.is(rows[1].last, null)
  t.is(rows[1].title, 'novo')
  t.is(rows[2].diary, A)
  t.alike(topicList(null, NOW), [])
})

test('the chat follows the topic marks of group.read and hides what is inside a topic', async (t) => {
  const { chatView } = await load()
  const m = (writer, seq, topic, text = 't' + seq, replyTo = null) => ({ writer, seq, replyTo, text, topic })
  const R = { writer: A, seq: 1, poll: true }
  const messages = [
    m(B, 1, null),
    m(A, 1, R, 'Assunto\ncorpo'),
    m(B, 2, R, 't2', { writer: A, seq: 1 }),
    m(A, 3, R, 't3', { writer: B, seq: 2 }),
    m(B, 4, null, 't4', { writer: B, seq: 1 }),
    m(A, 5, null, 't5', { writer: A, seq: 9 })
  ]
  const view = chatView(messages)
  t.alike(view.map((v) => v.kind + ':' + v.ref), ['message:' + B + ':1', 'topic:' + A + ':1', 'message:' + B + ':4', 'message:' + A + ':5'])
  t.is(view[1].title, 'Assunto')
  t.is(view[1].poll, true)
  t.is(chatView([m(A, 1, { writer: A, seq: 1, poll: false })])[0].poll, false)
  t.alike(chatView([m(B, 7, { writer: A, seq: 1, poll: false })]), [], 'an item of a topic whose root is not on the page stays hidden')
  t.is(chatView(messages, [A + ':99']).length, 4, 'the marks win over topicRefs')
})

test('without marks the chat walks the replyTo chain', async (t) => {
  const { chatView } = await load()
  const m = (writer, seq, replyTo = null, text = 't' + seq) => ({ writer, seq, replyTo, text })
  const messages = [
    m(B, 1),
    m(A, 1, null, 'Assunto\ncorpo'),
    m(B, 2, { writer: A, seq: 1 }),
    m(A, 3, { writer: B, seq: 2 }),
    m(B, 4, { writer: B, seq: 1 }),
    m(A, 5, { writer: A, seq: 9 })
  ]
  const view = chatView(messages, new Set([A + ':1']))
  t.alike(view.map((v) => v.kind + ':' + v.ref), ['message:' + B + ':1', 'topic:' + A + ':1', 'message:' + B + ':4', 'message:' + A + ':5'])
  t.is(view[1].title, 'Assunto')
  t.is(chatView(messages, [A + ':1']).length, 4, 'an array of refs works too')
  t.is(chatView(messages, new Set()).length, messages.length, 'no topics, a normal chat')
  const loop = [m(A, 1, { writer: B, seq: 1 }), m(B, 1, { writer: A, seq: 1 })]
  t.is(chatView(loop, new Set([A + ':9'])).length, 2, 'a reply loop ends')
  t.alike(chatView(null, null), [])
})

const item = (writer, seq, extra = {}) => ({ writer, diary: writer, seq, at: iso(seq), text: 't' + seq, hidden: false, ...extra })
const R = (seq) => ({ writer: A, seq })

test('a hidden topic root is listed as moderated, with the label the chat uses', async (t) => {
  const { topicList, HIDDEN_LABEL } = await load()
  const { HIDDEN_LABEL: chat } = await import('../src/groups.js')
  t.is(HIDDEN_LABEL, chat, 'same words as a hidden chat post')
  const rows = topicList([{ writer: A, diary: A, seq: 1, at: iso(5), text: '', hidden: true, replies: 2, last: iso(1) }, { writer: A, diary: A, seq: 2, at: iso(4), text: 'Assunto\nmais', hidden: false, replies: 0 }], NOW)
  t.is(rows[0].title, HIDDEN_LABEL)
  t.is(rows[0].hidden, true)
  t.is(rows[0].text, '')
  t.is(rows[1].title, 'Assunto')
  t.is(rows[1].hidden, false)
  t.is(rows[1].text, 'Assunto\nmais')
})

test('seenCut is the newest item of the read, hidden from the chat or not', async (t) => {
  const { seenCut, chatView } = await load()
  // newest first: a reply inside a topic is the newest item and the chat hides it
  const reply = item(B, 9, { topic: { writer: A, seq: 1, poll: false }, replyTo: R(1) })
  const root = item(A, 1, { topic: { writer: A, seq: 1, poll: false } })
  const plain = item(A, 2, { topic: null })
  const items = [reply, plain, root]
  t.alike(chatView(items).map((v) => v.ref), [A + ':2', A + ':1'], 'the chat does not paint the reply')
  t.alike(seenCut(items), { at: reply.at, writer: B, seq: 9 })
  t.is(seenCut([]), null)
  t.is(seenCut(null), null)
  t.is(seenCut([{ writer: A, seq: 1 }]), null, 'no at')
})

test('a topic thread pages older replies by the cursor and never repeats an item', async (t) => {
  const { threadOf, keepsTail } = await load()
  const cur = (i) => ({ at: i.at, writer: i.writer, seq: i.seq })
  const head = { items: [item(B, 30), item(B, 29), item(B, 28)], next: cur(item(B, 28)) }
  t.alike(threadOf(head, null), { items: head.items, next: head.next })
  const tail = { items: [item(B, 28), item(B, 27), item(A, 1)], next: null }
  const all = threadOf(head, tail)
  t.alike(all.items.map((i) => i.seq), [30, 29, 28, 27, 1], 'the overlap is dropped')
  t.is(all.next, null, 'the root page was the last')
  t.alike(threadOf({ items: head.items, next: null }, tail).items.map((i) => i.seq), [30, 29, 28], 'a head with nothing older ignores a tail')
  t.alike(threadOf(head, { items: [item(B, 27)], next: cur(item(B, 27)) }).next, cur(item(B, 27)))
  t.alike(threadOf(null, null), { items: [], next: null })
  // a fresh newest page keeps the older pages only while it still reaches the old head
  t.ok(keepsTail(head, { items: [item(B, 31), item(B, 30), item(B, 29), item(B, 28)], next: head.next }))
  t.absent(keepsTail(head, { items: [item(B, 40), item(B, 39)], next: head.next }), 'a gap drops them')
  t.absent(keepsTail(null, head))
})

test('the reply box does not depend on the root being on the page held', async (t) => {
  const { replyAllowed } = await load()
  t.absent(replyAllowed({ loaded: false, rootItem: null, navRoot: null }), 'nothing read yet')
  t.ok(replyAllowed({ loaded: true, rootItem: null, navRoot: { hidden: false, text: 'x' } }), 'root on an older page, known visible')
  t.ok(replyAllowed({ loaded: true, rootItem: null, navRoot: null }), 'unknown: the node refuses a hidden root anyway')
  t.absent(replyAllowed({ loaded: true, rootItem: null, navRoot: { hidden: true, text: '' } }), 'known hidden')
  t.ok(replyAllowed({ loaded: true, rootItem: item(A, 1), navRoot: { hidden: true, text: '' } }), 'the page wins')
  t.absent(replyAllowed({ loaded: true, rootItem: item(A, 1, { hidden: true }), navRoot: null }))
})

test('Topico reads older pages with the cursor and gates replies on the thread, not the root item', (t) => {
  const fs = require('fs')
  const path = require('path')
  const src = fs.readFileSync(path.join(__dirname, '../src/screens/Topico.js'), 'utf8')
  t.ok(/readThread\(\{ group, topic: root, before \}\)/.test(src), 'older page by the cursor')
  t.ok(src.includes('replyAllowed({ loaded: read !== null, rootItem, navRoot })'), 'composer gate')
  t.absent(/isTop && rootItem &&/.test(src), 'the composer no longer needs the root item')
  t.absent(src.includes('claimedTotals'), 'a group poll is folded by the own node: no seeder notice')
  t.ok(src.includes('label={DENOUNCE}') && src.includes('onReport'), 'Denunciar on the root and the replies')
  t.ok(src.includes('canReport(rootItem)') && src.includes('canReport(item)'))
  t.ok(src.includes("publicGroupRefusal('public', text)"), 'the word check runs on a reply')
  t.absent(src.includes('\u2014'))
  const grupo = fs.readFileSync(path.join(__dirname, '../src/screens/Grupo.js'), 'utf8')
  t.ok(grupo.includes('const seenAt = seenCut(rawItems)') && grupo.includes('cutRef.current = seenAt'), 'Grupo: the seen mark comes from the raw read, not the painted rows')
})

test('the module is pure and has no em dash or method names', async (t) => {
  const fs = require('fs')
  const src = fs.readFileSync(require('path').join(__dirname, '../src/forum.js'), 'utf8')
  t.absent(/\bimport\b[^\n]*from/.test(src), 'no imports')
  t.absent(src.includes('\u2014'))
  t.absent(/'(topic|group|diary)\.[a-z]+'/.test(src))
})
