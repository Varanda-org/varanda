'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const load = () => import('../src/recadosView.js')

const OWNER = 'a1'.repeat(32)
const ME = 'b2'.repeat(32)
const W1 = 'c3'.repeat(32)
const row = (author, seq = 1) => ({ author, seq, ref: author + ':' + seq, text: 'oi', at: '2026-10-25T12:00:00.000Z', replyTo: null, via: 'following', mine: false })
const ids = (list) => list.map((a) => a.id)

test('on my page: reply, hide and report for a recado left by someone else', async (t) => {
  const v = await load()
  t.alike(ids(v.rowActions(row(W1), { owner: OWNER, self: OWNER })), ['reply', 'hide', 'report'])
  t.alike(v.rowActions(row(W1), { owner: OWNER, self: OWNER }).map((a) => a.label), ['Responder', 'Tirar da minha página', 'Denunciar a conta'])
})

test('on my page: my own recado only offers Apagar recado', async (t) => {
  const v = await load()
  t.alike(v.rowActions(row(OWNER), { owner: OWNER, self: OWNER }).map((a) => a.label), ['Apagar recado'])
})

test('on another page: delete my recado, report the others, never hide or reply', async (t) => {
  const v = await load()
  t.alike(ids(v.rowActions(row(ME), { owner: OWNER, self: ME })), ['delete'])
  t.alike(ids(v.rowActions(row(W1), { owner: OWNER, self: ME })), ['report'])
})

test('a blocked writer cannot be answered but can be reported or hidden', async (t) => {
  const v = await load()
  t.alike(ids(v.rowActions(row(W1), { owner: OWNER, self: OWNER, isBlocked: (k) => k === W1 })), ['hide', 'report'])
})

test('no identity or a malformed row gives no actions', async (t) => {
  const v = await load()
  t.alike(v.rowActions(row(W1), { owner: OWNER, self: null }), [])
  t.alike(v.rowActions(null, { owner: OWNER, self: OWNER }), [])
})

test('wall options are the three choices, in order, with the Ajustes labels', async (t) => {
  const v = await load()
  t.alike(v.wallOptions().map((o) => [o.id, o.label]), [['following', 'Quem eu sigo'], ['everyone', 'Todos'], ['nobody', 'Ninguém']])
  t.is(v.wallLabel('nobody'), 'Ninguém')
  t.is(v.wallLabel('x'), null)
  t.ok(v.validWall('everyone'))
  t.absent(v.validWall('all'))
  t.is(v.WALL_TITLE, 'Quem pode deixar recado')
})

test('the wall line says who may write, and nothing when unread', async (t) => {
  const v = await load()
  t.is(v.wallLine('following'), 'Só quem esta pessoa segue pode deixar recado aqui.')
  t.is(v.wallLine('everyone'), 'Qualquer pessoa pode deixar recado aqui.')
  t.is(v.wallLine('nobody'), 'Esta pessoa não está recebendo recados.')
  t.is(v.wallLine(null), null)
})

test('the composer shows only on another page and only when the gate allows', async (t) => {
  const v = await load()
  t.ok(v.composerShown({ ok: true }, OWNER, ME))
  t.absent(v.composerShown({ ok: true }, OWNER, OWNER))
  t.absent(v.composerShown({ ok: false, reason: 'nobody' }, OWNER, ME))
  t.absent(v.composerShown(null, OWNER, ME))
})

test('page notice: a read error first, then the page notice, else none', async (t) => {
  const v = await load()
  t.is(v.pageNotice({ notice: 'a' }, 'erro'), 'erro')
  t.is(v.pageNotice({ notice: 'a' }), 'a')
  t.is(v.pageNotice({ notice: null }), null)
  t.is(v.pageNotice(null), null)
})

test('empty kinds', async (t) => {
  const v = await load()
  t.is(v.emptyKind({ blocked: true, wall: 'following' }, false), 'blocked')
  t.is(v.emptyKind({ blocked: false, wall: 'nobody' }, false), 'nobody')
  t.is(v.emptyKind({ blocked: false, wall: null }, false), 'unread')
  t.is(v.emptyKind({ blocked: false, wall: 'everyone' }, true), 'own')
  t.is(v.emptyKind({ blocked: false, wall: 'everyone' }, false), 'other')
  t.ok(v.emptyBody('own').includes('sua página'))
})

test('mergeIndex appends new rows once, joins hides, keeps the first wall', async (t) => {
  const v = await load()
  const a = { rows: [{ author: W1, seq: 1, followSeq: 2 }], hides: [5], wall: 9, next: 'x', indexing: false, complete: true }
  const b = { rows: [{ author: W1, seq: 1, followSeq: 2 }, { author: ME, seq: 3, followSeq: null }], hides: [5, 6], wall: null, next: null, indexing: true, complete: false }
  const m = v.mergeIndex(a, b)
  t.is(m.rows.length, 2)
  t.alike(m.hides, [5, 6])
  t.is(m.wall, 9)
  t.is(m.next, null)
  t.ok(m.indexing)
  t.absent(m.complete)
  t.is(v.mergeIndex(null, b), b)
})

test('the wall note states the real reply rule and shows only under Quem eu sigo', async (t) => {
  const v = await load()
  t.is(v.WALL_NOTE, 'Vale para a sua página. Com "Quem eu sigo", quem recebeu um recado seu pode responder a ele, mesmo sem você seguir essa pessoa.')
  t.is(v.wallNote('following'), v.WALL_NOTE)
  t.is(v.wallNote('everyone'), null)
  t.is(v.wallNote('nobody'), null)
  t.is(v.wallNote(null), null)
  t.is(v.wallLabel('following'), 'Quem eu sigo')
})

test('hide copy and wall copy say the record is public in the diary', async (t) => {
  const v = await load()
  t.ok(v.HIDE_BODY.includes('registrado publicamente no seu diário'))
  t.ok(v.WALL_PUBLIC.includes('registrado publicamente no seu diário'))
})

test('a blocked row on my page keeps hide, gets no reply, and has its own label', async (t) => {
  const v = await load()
  const r = { ...row(W1), blocked: true, text: '' }
  const acts = ids(v.rowActions(r, { owner: OWNER, self: OWNER, isBlocked: (k) => k === W1 }))
  t.absent(acts.includes('reply'))
  t.ok(acts.includes('hide'))
  t.is(v.BLOCKED_ROW, 'recado de pessoa bloqueada')
})

test('withoutReadHides drops hide pointers the held peeks already cover', async (t) => {
  const v = await load()
  const peeks = new Map([[OWNER, [{ key: OWNER, entries: [{ seq: 5, record: {} }], invalid: [6] }]]])
  const index = { rows: [], hides: [5, 6, { seq: 7 }, { seq: 5 }, 8], wall: null }
  const out = v.withoutReadHides(index, peeks, OWNER)
  t.alike(out.hides, [{ seq: 7 }, 8])
  t.alike(index.hides, [5, 6, { seq: 7 }, { seq: 5 }, 8], 'the input is not changed')
  t.alike(v.withoutReadHides(index, new Map(), OWNER).hides, index.hides)
})

test('no count badge, no photo-grid word and no em dash in the view or the screen sources', async (t) => {
  for (const f of ['src/recadosView.js', 'src/screens/Recados.js', 'src/ui/ScrapRow.js']) {
    let text
    try { text = readFileSync(join(__dirname, '..', f), 'utf8') } catch { continue }
    t.absent(/mural/i.test(text), f + ' has no photo-grid word')
    t.absent(text.includes('\u2014'), f + ' has no em dash')
  }
})
