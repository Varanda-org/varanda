// Reply row helpers (threadRows.js): labels, chips, merges, and cheap reply
// previews taken only from a list already loaded.
'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const load = () => import('../src/threadRows.js')

const A = 'aa'.repeat(32)
const B = 'bb'.repeat(32)
const C = 'cc'.repeat(32)
const D = 'dd'.repeat(32)

const refOf = (author, seq) => author + ':' + seq

const post = (author, seq, extra = {}) => ({
  kind: 'post',
  author,
  seq,
  at: '2026-10-20T10:00:00.000Z',
  text: 't' + seq,
  replyTo: null,
  name: 'Ana',
  username: 'ana',
  ...extra
})

test('parseRef, target and sameTarget keep their checks', async (t) => {
  const { parseRef, target, sameTarget } = await import('../src/thread.js')
  const ref = refOf(A, 3)
  t.alike(parseRef(ref), { author: A, seq: 3 })
  t.is(parseRef('nope'), null)
  t.is(parseRef(A.toUpperCase() + ':3'), null, 'still no lowercase of its own')
  const raw = { author: A, seq: 0 }
  const copy = target(raw)
  t.alike(copy, { author: A, seq: 0 })
  t.not(copy, raw, 'target copies')
  t.is(target({ author: 'zz', seq: 1 }), null)
  t.is(target({ author: A, seq: -1 }), null)
  t.is(target(null), null)
  t.ok(sameTarget(parseRef(ref), target({ author: A, seq: 3 })))
  t.is(sameTarget(parseRef(ref), target({ author: A, seq: 4 })), false)
  t.is(sameTarget(null, null), false)
})

test('row module imports the thread helpers and does not fetch', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '../src/threadRows.js'), 'utf8')
  t.ok(src.includes("import { parseRef, target } from './thread.js'"))
  t.is(src.includes("from 'react'"), false)
  t.is(src.includes('react-native'), false)
  t.is(src.includes("from 'node:"), false)
})

test('the thread layout lives in roda.js: no nested reply rows here', async (t) => {
  const mod = await load()
  t.is(mod.threadRows, undefined, 'commentRows (roda.js) lays out comments and rodas')
  t.is(mod.deeperOf, undefined)
  t.alike(Object.keys(mod).sort(), ['cheapReplies', 'cheapRepliesMap', 'childLabel', 'compareAtSeq', 'mergeChildren', 'replyChip', 'withOwnReply'])
})

test('mergeChildren dedupes by ref, orders by at, author, seq and returns a new map', async (t) => {
  const { mergeChildren } = await load()
  const parentRef = refOf(A, 1)
  const early = post(B, 2, { at: '2026-10-20T09:00:00.000Z', text: 'cedo' })
  const later = post(C, 1, { at: '2026-10-20T12:00:00.000Z', text: 'tarde' })
  // Same instant written two ways: as strings '.000Z' sorts before 'Z'.
  const tieA5 = post(A, 5, { at: '2026-01-01T00:00:00Z', text: 'a5' })
  const tieA2 = post(A, 2, { at: '2026-01-01T00:00:00.000Z', text: 'a2' })
  const tieD1 = post(D, 1, { at: '2026-01-01T00:00:00.000Z', text: 'd1' })
  const dup = post(B, 2, { at: '2026-10-20T08:00:00.000Z', text: 'copia' })
  const otherRef = refOf(D, 9)
  const other = post(D, 9)
  const prev = new Map([[otherRef, [other]]])
  const out = mergeChildren(prev, parentRef, [later, early, dup, tieD1, tieA5, tieA2, { text: 'lixo' }])
  t.ok(out instanceof Map)
  t.not(out, prev)
  t.is(prev.has(parentRef), false)
  t.is(prev.get(otherRef)[0], other)
  t.is(out.get(otherRef), prev.get(otherRef), 'an untouched parent keeps its list')
  t.alike(out.get(parentRef).map((i) => i.text), ['a2', 'a5', 'd1', 'cedo', 'tarde'],
    'same instant orders by author then seq, as the reply index does, not by the date string')
  t.is(out.get(parentRef)[3], early, 'the first copy of a ref wins')

  const again = mergeChildren(out, parentRef, [dup, post(C, 4, { at: '2026-10-20T13:00:00.000Z', text: 'nova' })])
  t.is(again.get(parentRef)[3], early)
  t.not(again.get(parentRef), out.get(parentRef))
  t.is(again.get(parentRef).at(-1).text, 'nova')
  t.is(mergeChildren(out, 'nope', [later]).get(parentRef), out.get(parentRef))
  t.is(mergeChildren(out, parentRef, null).get(parentRef), out.get(parentRef), 'a bad page does not wipe')

  const fromObject = mergeChildren({ [parentRef]: [later, early] }, parentRef, [])
  t.alike(fromObject.get(parentRef).map((i) => i.text), ['cedo', 'tarde'])
})

test('withOwnReply inserts a just-sent reply once', async (t) => {
  const { withOwnReply } = await load()
  const a = post(A, 1, { at: '2026-10-20T10:00:00.000Z' })
  const b = post(B, 2, { at: '2026-10-20T12:00:00.000Z' })
  const mid = post(C, 3, { at: '2026-10-20T11:00:00.000Z', text: 'novo' })
  const list = [a, b]
  const out = withOwnReply(list, mid)
  t.alike(list.map((i) => i.seq), [1, 2])
  t.alike(out.map((i) => i.seq), [1, 3, 2])
  t.not(out, list)
  const copy = post(C, 3, { text: 'outra', at: '2026-10-21T11:00:00.000Z' })
  t.is(withOwnReply(out, copy), out, 'the same ref is not inserted again')
  t.is(out[1].text, 'novo')
  t.is(withOwnReply(list, { text: 'sem ref' }), list)
  t.alike(withOwnReply(null, mid).map((i) => i.seq), [3])
  const newest = post(D, 4, { at: '2026-10-20T13:00:00.000Z' })
  t.alike(withOwnReply(list, newest).map((i) => i.seq), [1, 2, 4])
  const sameAt = post(D, 5, { at: a.at })
  t.alike(withOwnReply([a], sameAt).map((i) => i.seq), [1, 5])
  // Index order at one instant: aa:10, bb:1. A sent cc:5 goes after both.
  const aa10 = post(A, 10, { at: a.at })
  const bb1 = post(B, 1, { at: a.at })
  const cc5 = post(C, 5, { at: a.at })
  t.alike(withOwnReply([aa10, bb1], cc5).map((i) => i.author + ':' + i.seq), [A + ':10', B + ':1', C + ':5'],
    'a just-sent reply lands where the index will put it')
})

test('childLabel names the expander in pt-BR', async (t) => {
  const { childLabel } = await load()
  t.is(childLabel(1, false), 'Ver 1 resposta')
  t.is(childLabel(1, true), 'Ocultar respostas')
  t.is(childLabel(2, false), 'Ver 2 respostas')
  t.is(childLabel(0, false), 'Ver 0 respostas')
  t.is(childLabel(12, false), 'Ver 12 respostas')
  t.is(childLabel(null, false), 'Ver respostas')
  t.is(childLabel(undefined, false), 'Ver respostas')
  t.is(childLabel(1.5, false), 'Ver respostas')
  t.is(childLabel(-1, false), 'Ver respostas')
  t.is(childLabel(null, true), 'Ocultar respostas')
  t.is(childLabel(2, 'yes'), 'Ver 2 respostas')
})

test('replyChip prefers @username, then the name, then a bare label', async (t) => {
  const { replyChip } = await load()
  t.is(replyChip({ username: 'ana', name: 'Ana' }), 'Respondendo a @ana')
  t.is(replyChip({ username: '@ana', name: 'Ana' }), 'Respondendo a @ana')
  t.is(replyChip({ username: '', name: 'Ana' }), 'Respondendo a Ana')
  t.is(replyChip({ username: '   ', name: 'Ana Maria' }), 'Respondendo a Ana Maria')
  t.is(replyChip({ username: null, name: 'Ana' }), 'Respondendo a Ana')
  t.is(replyChip({ name: 'Ana' }), 'Respondendo a Ana')
  t.is(replyChip({}), 'Respondendo')
  t.is(replyChip(), 'Respondendo')
  t.is(replyChip({ username: 'ana\u202e' }), 'Respondendo a @ana\ufffd')
  t.is(replyChip({ name: 'Ana\u0001' }), 'Respondendo a Ana\ufffd')
  t.is(replyChip({ username: 'ana\u202e' }).includes('\u202e'), false)
  t.is(replyChip({ name: 'Ana\u0001' }).includes('\u0001'), false)
})

test('cheapReplies takes distant loaded replies and skips the near window', async (t) => {
  const { cheapReplies } = await load()
  const parent = post(A, 1, { text: 'foco' })
  const near = []
  for (let i = 0; i < 5; i++) {
    near.push(post(B, i + 1, { replyTo: { author: A, seq: 1 }, text: 'perto' + i, name: 'Perto' }))
  }
  const other = post(C, 1, { replyTo: { author: D, seq: 1 }, text: 'outra', name: 'Outra' })
  const far1 = post(C, 2, { replyTo: { author: A, seq: 1 }, text: 'longe\u0001', name: 'Lia\u202e' })
  const far2 = post(C, 3, { replyTo: refOf(A, 1), text: 'a\nb', name: null, username: 'lia' })
  const far3 = post(C, 4, { replyTo: { author: A, seq: 1 }, text: 'extra', name: 'Extra' })
  const items = [parent, ...near, other, far1, far2, far3]
  const out = cheapReplies(items, refOf(A, 1))
  t.is(out.length, 2, 'default max is 2')
  t.alike(out.map((r) => r.key), [refOf(C, 2), refOf(C, 3)])
  t.is(out[0].name, 'Lia\ufffd')
  t.is(out[0].text, 'longe\ufffd')
  t.is(out[0].name.includes('\u202e'), false)
  t.is(out[0].text.includes('\u0001'), false)
  t.is(out[1].name, 'lia')
  t.is(out[1].text, 'a\nb', 'a line break in the post text stays')
  t.is(out.some((r) => r.text.startsWith('perto')), false, 'distance 1 to 5 is inside the default window')
  t.is(out.some((r) => r.key === refOf(C, 1)), false, 'a far row aimed at another post is not a reply here')
  t.is(typeof out.then, 'undefined')

  const custom = cheapReplies(items, refOf(A, 1), { skipNear: 0, max: 1 })
  t.alike(custom, [{ key: refOf(B, 1), name: 'Perto', text: 'perto0' }])

  const upper = cheapReplies(items, refOf(A, 1).toUpperCase(), { max: 1 })
  t.is(upper[0].key, refOf(C, 2))

  t.alike(cheapReplies([far1, far2, far3], refOf(A, 1)), [], 'no parent row, so distance is unknown')
  t.alike(cheapReplies(items, 'nope'), [])
  t.alike(cheapReplies(null, refOf(A, 1)), [])
  t.alike(cheapReplies(items, refOf(A, 1), { max: 0 }), [], 'a max of 0 is a cap, not the default')
  t.alike(cheapReplies([...items, far1], refOf(A, 1), { max: 4 }).map((r) => r.key), [refOf(C, 2), refOf(C, 3), refOf(C, 4)])

  const ghost = post(A, 1, { text: 'copia' })
  const echo = post(B, 6, { replyTo: { author: A, seq: 1 }, text: 'eco', name: 'Eco' })
  const gap = Array.from({ length: 6 }, (_, i) => post(D, i + 30, { text: 'g' }))
  t.alike(cheapReplies([ghost, ...gap, parent, echo], refOf(A, 1)), [], 'near a later copy of the parent is still near')

  const above = post(B, 9, { replyTo: { author: A, seq: 1 }, text: 'acima', name: 'Bo' })
  const below = post(C, 9, { replyTo: { author: A, seq: 1 }, text: 'abaixo', name: 'Ca' })
  const pads = Array.from({ length: 9 }, (_, i) => post(D, i + 1, { text: 'p' }))
  const after = Array.from({ length: 6 }, (_, i) => post(D, i + 20, { text: 'q' }))
  const beside = post(B, 7, { replyTo: { author: A, seq: 1 }, text: 'colada', name: 'Bo' })
  const found = cheapReplies([above, ...pads, parent, beside, ...after, below], refOf(A, 1), { skipNear: 5, max: 3 })
  t.alike(found.map((r) => r.text), ['acima', 'abaixo'])

  const textReply = post(C, 21, { replyTo: { author: A, seq: 1 }, text: 'texto', name: 'Ca' })
  const gap6 = Array.from({ length: 6 }, (_, i) => post(D, i + 60, { text: 'r' }))
  const wrapper = { ...post(D, 50, { text: '' }), kind: 'repost', to: { author: A, seq: 1 } }
  t.alike(cheapReplies([wrapper, ...gap6, textReply], refOf(A, 1)).map((r) => r.text), ['texto'],
    'a repost row of the parent marks where the parent is')
  const photo1 = post(B, 20, { replyTo: { author: A, seq: 1 }, text: '  ', name: 'Foto' })
  const photo2 = post(B, 21, { replyTo: { author: A, seq: 1 }, text: '', name: 'Foto' })
  t.alike(cheapReplies([parent, ...gap6, photo1, photo2, textReply], refOf(A, 1)).map((r) => r.text), ['texto'],
    'photo-only replies do not use up the slots')
  const wrapReply = { ...post(C, 20, { replyTo: { author: A, seq: 1 }, text: 'nao' }), kind: 'repost', to: { author: D, seq: 99 } }
  t.alike(cheapReplies([parent, ...gap6, wrapReply, textReply], refOf(A, 1)).map((r) => r.text), ['texto'],
    'a repost wrapper is not a reply')
})

test('cheapRepliesMap: one walk for many parents, cheapReplies rules kept', async (t) => {
  const { cheapReplies, cheapRepliesMap } = await import('../src/threadRows.js')
  const A = 'a'.repeat(64)
  const B = 'b'.repeat(64)
  const C = 'c'.repeat(64)
  const row = (author, seq, extra = {}) => ({ kind: 'post', author, seq, at: '2026-10-20T10:00:00.000Z', text: author[0] + seq, name: 'N' + seq, ...extra })
  const pad = (from) => Array.from({ length: 7 }, (_, i) => row(C, from + i))
  const list = [
    row(A, 1),
    ...pad(100),
    row(B, 1, { replyTo: { author: A, seq: 1 } }),
    row(B, 2, { replyTo: A.toUpperCase() + ':1' }),
    row(B, 3, { replyTo: { author: A, seq: 1 }, text: '' }),
    { ...row(B, 4, { replyTo: { author: A, seq: 1 } }), kind: 'repost', to: { author: A, seq: 2 } },
    row(B, 8, { replyTo: { author: A, seq: 2 } }),
    ...pad(200),
    row(B, 5, { replyTo: { author: A, seq: 2 } }),
    row(B, 1, { replyTo: { author: A, seq: 1 } }),
    row(B, 6, { replyTo: { author: A, seq: 1 } }),
    row(B, 7, { replyTo: { author: A, seq: 3 } })
  ]
  const map = cheapRepliesMap(list, [A + ':1', A.toUpperCase() + ':2', A + ':3', 'nada', B + ':1'])
  const keys = (lines) => (lines || []).map((l) => l.key)
  t.alike(keys(map.get(A + ':1')), [B + ':1', B + ':2'], 'two lines in list order, a blank skipped')
  t.alike(keys(map.get(A + ':2')), [B + ':5'], 'a repost row places its original; the reply beside it is a row')
  t.alike(map.get(A + ':3'), [], 'a parent that is not in the list gets no lines')
  t.alike(map.get(B + ':1'), [], 'no reply, no lines')
  t.ok(!map.has('nada') && map.size === 4, 'an invalid ref is left out')
  t.alike(cheapReplies(list, A.toUpperCase() + ':1'), map.get(A + ':1'), 'cheapReplies is the one-ref case')
  t.alike(cheapRepliesMap(list, []), new Map())
  t.alike(cheapRepliesMap(null, [A + ':1']).get(A + ':1'), [])
  t.alike(keys(cheapRepliesMap(list, [A + ':1'], { max: 3 }).get(A + ':1')), [B + ':1', B + ':2', B + ':6'], 'a repeat of a shown key is skipped')
})

// Conversa's rowProps with a row cache (Conversa.js loads react-native, so
// the function runs from its source text with stubbed imports).
function sourceFn (src, name) {
  let start = src.indexOf('\nexport function ' + name + ' (')
  if (start >= 0) start += '\nexport '.length
  else {
    start = src.indexOf('\nfunction ' + name + ' (')
    if (start < 0) throw new Error('no function ' + name)
    start += 1
  }
  const open = src.indexOf('{', src.indexOf(')', start))
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1)
  }
  throw new Error('unbalanced ' + name)
}

async function cachedRowProps () {
  const conversa = fs.readFileSync(path.join(__dirname, '../src/screens/Conversa.js'), 'utf8')
  const { cachedRow } = await import('../src/namesCache.js')
  const { canDelete } = await import('../src/deletion.js')
  // eslint-disable-next-line no-new-func
  return new Function(
    'cachedRow', 'canDelete', 'postLink', 'actingPageKey', 'installationOrigin', 'pickAvatar', 'replyNameOf', 'postAt',
    [sourceFn(conversa, 'refOf'), sourceFn(conversa, 'identityOf'), sourceFn(conversa, 'rowProps'), 'return rowProps'].join('\n')
  )(cachedRow, canDelete, () => null, () => null, () => null, () => null, (p) => (p ? p.name : null), () => null)
}

const engOf = (over = {}) => ({ counts: new Map(), state: { liked: new Set(), reposted: new Set() }, pending: new Map(), toggle () {}, ...over })

test('Conversa rowProps: a cached row keeps its props until what it shows changes', async (t) => {
  const rowProps = await cachedRowProps()
  const cache = new Map()
  const item = post(B, 2, { replyTo: { author: C, seq: 1 } })
  const names = { profileOf: () => null }
  const calls = []
  const handlersA = { onOpenThread () {}, onOpenMember () {}, onReply: (x) => calls.push(['old', x.ref]), onDelete: () => calls.push('old delete') }
  const base = { item, names, peeked: null, now: 1, ownKey: B, follows: null, cache, rowKey: 'r' }
  const eng = engOf()
  const first = rowProps({ ...base, eng, handlers: handlersA })
  t.is(rowProps({ ...base, eng, handlers: { ...handlersA } }), first, 'a new handlers object alone keeps the props')
  t.is(rowProps({ ...base, eng, handlers: handlersA, extra: { replyToName: null, onOpenParent: undefined } }) === first, false, 'extra values are inputs')

  // Handlers of a later render run, though the props object is the old one.
  const handlersB = { ...handlersA, onReply: (x) => calls.push(['new', x.ref]), onDelete: () => calls.push('new delete') }
  const same = rowProps({ ...base, eng, handlers: handlersB })
  same.onReply()
  same.onDelete()
  t.alike(calls, [['new', B + ':2'], 'new delete'], 'reply and delete call the newest handlers')

  const liked = engOf({ state: { liked: new Set([B + ':2']), reposted: new Set() } })
  const afterLike = rowProps({ ...base, eng: liked, handlers: handlersB })
  t.ok(afterLike !== same && afterLike.liked === true, 'a reaction rebuilds the row')
  const counted = engOf({ state: liked.state, counts: new Map([[B + ':2', { replies: 1, likes: 1, reposts: 0, quotes: 0 }]]) })
  const withCounts = rowProps({ ...base, eng: counted, handlers: handlersB })
  t.ok(withCounts !== afterLike && withCounts.counts.likes === 1, 'new counts rebuild the row')
  const refetched = engOf({ state: liked.state, counts: new Map([[B + ':2', { replies: 1, likes: 1, reposts: 0, quotes: 0 }]]) })
  t.is(rowProps({ ...base, eng: refetched, handlers: handlersB }), withCounts, 'equal counts in new objects keep the props')

  const toggles = []
  const live = engOf({ state: liked.state, counts: refetched.counts, toggle: (kind, ref) => toggles.push([kind, ref]) })
  rowProps({ ...base, eng: live, handlers: handlersB }).onLike()
  t.alike(toggles, [['like', B + ':2']], 'like toggles on the newest engagement')

  const named = rowProps({ ...base, eng: live, handlers: handlersB, names: { profileOf: (k) => (k === C ? { name: 'Cida' } : null) } })
  t.ok(named.replyToName === 'Cida', 'a profile learned later rebuilds the reply chip')
  const noDelete = rowProps({ ...base, eng: live, handlers: { ...handlersB, onDelete: undefined }, names: { profileOf: (k) => (k === C ? { name: 'Cida' } : null) } })
  t.is(noDelete.onDelete, undefined, 'a handler no longer offered drops its button')

  const uncached = rowProps({ ...base, cache: undefined, eng: live, handlers: handlersB })
  t.ok(uncached !== rowProps({ ...base, cache: undefined, eng: live, handlers: handlersB }), 'without a cache every call builds')
})

test('Conversa rowProps: repost and quoting rows keep their props over the same peeks', async (t) => {
  const conversa = fs.readFileSync(path.join(__dirname, '../src/screens/Conversa.js'), 'utf8')
  const { cachedRow } = await import('../src/namesCache.js')
  const { canDelete } = await import('../src/deletion.js')
  const { assembleMember } = await import('../src/thread.js')
  const memoLine = conversa.split('\n').find((line) => line.startsWith('const postsByPeek = ')) || ''
  // eslint-disable-next-line no-new-func
  const { rowProps, postAt } = new Function(
    'cachedRow', 'canDelete', 'postLink', 'actingPageKey', 'installationOrigin', 'pickAvatar', 'replyNameOf', 'assembleMember',
    [memoLine, sourceFn(conversa, 'refOf'), sourceFn(conversa, 'parseRef'), sourceFn(conversa, 'postAt'), sourceFn(conversa, 'identityOf'), sourceFn(conversa, 'rowProps'), 'return { rowProps, postAt }'].join('\n')
  )(cachedRow, canDelete, () => null, () => null, () => null, () => null, () => null, assembleMember)
  const at = '2026-11-01T10:00:00.000Z'
  const peeked = new Map([[C, { key: C, entries: [{ seq: 1, record: { type: 'post', text: 'original', at, replyTo: null } }], profile: null, username: null }]])
  const cache = new Map()
  const names = { profileOf: () => null }
  const handlers = { onOpenThread () {}, onOpenMember () {} }
  const base = { names, peeked, now: 1, ownKey: A, follows: null, eng: null, handlers, cache }
  // Membro's repost row: the original comes from postAt on every render.
  const repost = () => rowProps({ ...base, item: postAt(peeked, C + ':1'), extra: { repostedBy: null }, rowKey: 'repost:3' })
  t.is(repost(), repost(), 'a repost row keeps its props')
  const quoting = post(B, 2, { quote: { author: C, seq: 1 } })
  const quoted = () => rowProps({ ...base, item: quoting, rowKey: 'post:2' })
  const first = quoted()
  t.is(first.quote.text, 'original', 'the quote shows the original')
  t.is(quoted(), first, 'a quoting row keeps its props')
  // A merged peek is a new object: the row shows what it now holds.
  peeked.set(C, { ...peeked.get(C), entries: [{ seq: 1, record: { type: 'post', text: 'original', at, replyTo: null } }] })
  t.ok(quoted() !== first, 'a new peek rebuilds the row')
})
