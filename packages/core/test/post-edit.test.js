'use strict'

const test = require('brittle')
const { postRecord, postEditRecord, deleteRecord, validRecordCopy } = require('../lib/records')
const { applyDeletes } = require('../lib/deletion')
const { buildFeed } = require('../lib/feed')
const { editsOf, editsOfCopies, editPlan, admitsText, editable, foldEdit, newestEdit, liveEditSeqs } = require('../lib/post-edit')

const AT = '2026-01-01T00:00:00.000Z'
const LATER = '2026-06-01T00:00:00.000Z'
const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const PHOTO = { core: 'c'.repeat(64), mime: 'image/jpeg', start: 1, blocks: 1, bytes: 100, sha256: 'd'.repeat(64), width: 10, height: 10 }
const CARD = { url: 'https://example.com/a', host: 'example.com', title: 'T', desc: '', image: null }

// Entries of a diary: index = seq, block 0 a placeholder (only posts matter).
function diary (records) {
  return [{ seq: 0, record: null }, ...records.map((record, i) => ({ seq: i + 1, record }))]
}

function current (entries, seq) {
  const e = editsOf(applyDeletes(entries)).get(seq)
  return e === undefined ? null : e.record.text
}

test('post-edit: the highest block wins, whatever at says (ordering)', (t) => {
  const entries = diary([
    postRecord({ text: 'Original', at: AT }),
    postEditRecord({ seq: 1, text: 'Primeira', at: LATER }),
    postEditRecord({ seq: 1, text: 'Segunda', at: AT })
  ])
  t.is(current(entries, 1), 'Segunda', 'a backdated later block still wins')
  const shuffled = [entries[3], entries[0], entries[2], entries[1]]
  t.is(editsOf(shuffled).get(1).record.text, 'Segunda', 'input order does not matter')
  t.is(editsOf(entries).get(1).seq, 3)
})

test('post-edit: a tombstoned edit falls back, a deleted post takes no edit', (t) => {
  const base = [
    postRecord({ text: 'Original', at: AT }),
    postEditRecord({ seq: 1, text: 'Primeira', at: AT }),
    postEditRecord({ seq: 1, text: 'Segunda', at: AT })
  ]
  t.is(current(diary([...base, deleteRecord({ seq: 3, at: AT })]), 1), 'Primeira', 'next lower edit')
  t.is(current(diary([...base, deleteRecord({ seq: 3, at: AT }), deleteRecord({ seq: 2, at: AT })]), 1), null, 'as written')
  const gone = applyDeletes(diary([...base, deleteRecord({ seq: 1, at: AT })]))
  t.is(editsOf(gone).size, 0, 'no edit applies to a deleted post')
})

test('post-edit: forgery, an edit only targets its own diary', (t) => {
  const a = diary([postRecord({ text: 'De A', at: AT })])
  const b = diary([postRecord({ text: 'De B', at: AT }), postEditRecord({ seq: 1, text: 'Falsa', at: AT })])
  const { items } = buildFeed({ logs: [{ key: A, entries: a }, { key: B, entries: b }], association: null, now: Date.parse(LATER) })
  const ofA = items.find((i) => i.author === A)
  t.is(ofA.text, 'De A', "B's edit names seq 1 of B, never A's post")
  t.absent('edited' in ofA)
  t.is(items.find((i) => i.author === B).text, 'Falsa')
})

test('post-edit: targets that take no edit', (t) => {
  const poll = { type: 'post', text: 'Qual?', at: AT, replyTo: null, poll: ['Sim', 'Não'] }
  const entries = diary([
    { type: 'profile', name: 'N', bio: '', at: AT },
    postEditRecord({ seq: 1, text: 'x', at: AT }),
    postEditRecord({ seq: 2, text: 'y', at: AT }),
    poll,
    postEditRecord({ seq: 4, text: 'Outra pergunta', at: AT })
  ])
  t.is(validRecordCopy(poll, 4) !== null, true, 'fixture poll is valid')
  t.is(editsOf(entries).size, 0, 'profile, edit and poll are not edited')
  t.absent(editable(validRecordCopy(poll, 4)))
})

test('post-edit: text bounds follow the post', (t) => {
  const plain = validRecordCopy(postRecord({ text: 'Texto', at: AT }), 1)
  const photo = validRecordCopy(postRecord({ text: 'Legenda', media: [PHOTO], at: AT }), 1)
  t.absent(admitsText(plain, 1, ''), 'a text post keeps a text')
  t.ok(admitsText(photo, 1, ''), 'a photo post may lose its caption')
  t.absent(admitsText(plain, 1, 'x'.repeat(1001)))
  const entries = diary([postRecord({ text: 'Texto', at: AT }), postEditRecord({ seq: 1, text: '', at: AT })])
  t.is(current(entries, 1), null, 'an empty edit of a text post is skipped')
})

test('post-edit: only the text changes, a stale link card goes', (t) => {
  const reply = postRecord({ text: 'Resposta', at: AT, replyTo: { author: B, seq: 4 } })
  const withCard = postRecord({ text: 'Veja https://example.com/a', at: AT, preview: CARD })
  const entries = diary([
    reply,
    withCard,
    postEditRecord({ seq: 1, text: 'Resposta corrigida', at: LATER }),
    postEditRecord({ seq: 2, text: 'Link removido', at: LATER })
  ])
  const edits = editsOf(entries)
  t.alike(edits.get(1).record.replyTo, { author: B, seq: 4 }, 'replyTo kept')
  t.is(edits.get(1).record.at, AT, 'at kept, so the feed order does not move')
  t.absent('preview' in edits.get(2).record, 'card dropped when its URL left the text')
  const kept = editsOf(diary([withCard, postEditRecord({ seq: 1, text: 'Ainda https://example.com/a', at: AT })]))
  t.alike(kept.get(1).record.preview, CARD, 'card kept while the URL stays')
})

test('post-edit: editPlan', (t) => {
  const entries = diary([
    postRecord({ text: 'Original', at: AT }),
    { type: 'profile', name: 'N', bio: '', at: AT },
    postEditRecord({ seq: 1, text: 'Primeira', at: AT })
  ])
  const copies = applyDeletes(entries).map(({ seq, record }) => ({ seq, record: validRecordCopy(record, seq) }))
  t.alike(editPlan({ copies, to: 9, length: 4, text: 'x', at: AT }), { refuse: 'bad-ref' })
  t.alike(editPlan({ copies, to: 2, length: 4, text: 'x', at: AT }), { refuse: 'not-a-post' })
  t.alike(editPlan({ copies, to: 1, length: 4, text: '', at: AT }), { refuse: 'text' })
  t.alike(editPlan({ copies, to: 1, length: 4, text: 'Primeira', at: AT }), { unchanged: true, seq: 3 })
  const plan = editPlan({ copies, to: 1, length: 4, text: 'Segunda', at: AT })
  t.alike(plan.records, [postEditRecord({ seq: 1, text: 'Segunda', at: AT }), deleteRecord({ seq: 3, at: AT })], 'new edit plus the tombstone of the old one')
  t.alike(plan.supersede, [3])
  t.alike(liveEditSeqs(copies, 1), [3])
})

test('post-edit: hostile input never throws', (t) => {
  t.is(editsOf(null).size, 0)
  t.is(editsOfCopies([null, 1, { seq: 'x' }, { seq: 2, record: { get type () { throw new Error('boom') } } }]).size, 0)
  t.absent(admitsText(null, 1, 'x'))
})

test('post-edit: seeder pointer fold', (t) => {
  const map = new Map()
  t.ok(foldEdit(map, 1, 5))
  t.ok(foldEdit(map, 1, 3))
  t.is(newestEdit(map, 1), 5)
  t.is(newestEdit(map, 2), null)
  t.absent(foldEdit(map, 0, 1))
  t.absent(foldEdit(new Map([[1, 2]]), 2, 3, { maxPosts: 1 }), 'full map fails closed')
})
