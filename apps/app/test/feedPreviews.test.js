// A Rua folds comments into the card of their post (feedFold.js) in the
// member list, the page list and the cold-start preview. ARua.js loads React
// Native, so its pure parts are compiled from the source and the screens are
// checked on their text.
'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const srcPath = path.join(__dirname, '../src/screens/ARua.js')
const raw = fs.readFileSync(srcPath, 'utf8')

function withoutComments (src) {
  return src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')
}

// The text of the top-level `function <name>`, braces matched.
function fnText (src, name) {
  let start = src.indexOf('\nfunction ' + name + ' (')
  if (start < 0) {
    start = src.indexOf('\nexport function ' + name + ' (')
    if (start >= 0) start += 'export '.length
  }
  if (start < 0) throw new Error('no function ' + name)
  const open = src.indexOf('{', src.indexOf(')', start))
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(start + 1, i + 1)
  }
  throw new Error('unbalanced ' + name)
}

function textOf (src, name) {
  try {
    return fnText(src, name)
  } catch {
    return ''
  }
}

const code = withoutComments(raw)
const page = textOf(code, 'PageARua')
const member = textOf(code, 'MemberARua')
const preview = textOf(code, 'ARuaPreview')
const props = textOf(code, 'socialRowProps')
const inputsAt = code.indexOf('const inputs = {')
const inputs = inputsAt < 0 ? '' : code.slice(inputsAt, code.indexOf('return cachedRow(', inputsAt))
const useSocialText = (() => {
  const start = code.indexOf('\nexport function useSocial (')
  const end = code.indexOf('\nexport function socialRowProps (')
  return start < 0 || end < 0 ? '' : code.slice(start, end)
})()

const A = 'aa'.repeat(32)
const B = 'bb'.repeat(32)
const C = 'cc'.repeat(32)
const D = 'dd'.repeat(32)
const E = 'ee'.repeat(32)

const post = (author, seq, extra = {}) => ({
  kind: 'post',
  author,
  seq,
  at: '2026-10-20T10:00:00.000Z',
  text: 't' + seq,
  name: 'N' + author.slice(0, 2),
  username: null,
  replyTo: null,
  ...extra
})
const reply = (author, seq, to, extra = {}) => post(author, seq, { replyTo: { author: to.author, seq: to.seq }, ...extra })
const refOf = (item) => item.author + ':' + item.seq
const feedKey = (item) => item.author + ':' + item.seq
const TRANSIENT = Object.freeze({ transient: true })

// rowKeyOf ... keepFold, the pure fold helpers of ARua.js.
function compileHelpers (foldNeeds) {
  const start = code.indexOf('export function rowKeyOf')
  const endFn = textOf(code, 'keepFold')
  if (start < 0 || endFn === '') return null
  const end = code.indexOf(endFn) + endFn.length
  const body = code.slice(start, end).replace(/\nexport /g, '\n').replace(/^export /, '')
  // eslint-disable-next-line no-new-func
  return new Function('feedKey', 'foldNeeds', 'TRANSIENT', body + '\nreturn { rowKeyOf, foldWaits, keepFold }')(feedKey, foldNeeds, TRANSIENT)
}

async function helpers () {
  const fold = await import('../src/feedFold.js')
  const rounds = await import('../src/foldRounds.js')
  return { ...fold, ...rounds, ...compileHelpers(fold.foldNeeds) }
}

// socialRowProps with the screen's pure imports, the rest stubbed.
async function compileRowProps () {
  const { replyMarkOf } = await import('../src/who.js')
  const { cachedRow } = await import('../src/namesCache.js')
  const { commentedLabel, knownReplies } = await import('../src/feedFold.js')
  const body = [fnText(code, 'refOf'), fnText(code, 'withActions'), fnText(code, 'socialRowProps')].join('\n')
  // eslint-disable-next-line no-new-func
  return new Function('replyMarkOf', 'cachedRow', 'commentedLabel', 'knownReplies', 'pickAvatar', 'installationOrigin', 'postLink', 'actingPageKey', 'canDelete',
    body + '\nreturn socialRowProps')(replyMarkOf, cachedRow, commentedLabel, knownReplies, () => null, () => null, () => null, () => null, () => false)
}

function fakeSocial ({ originals = new Map(), counts = new Map(), indexing = false } = {}) {
  return {
    social: { flags: { indexing, complete: true }, counts, eng: { liked: new Set(), reposted: new Set() }, pending: new Map() },
    original: (ref) => originals.get(ref),
    transient: () => false,
    pending: () => false,
    persistOf: () => true,
    retry: () => {},
    toggle: () => {},
    notify: undefined
  }
}

test('A Rua takes its comment rows from feedFold and nothing else', (t) => {
  t.ok(code.includes("import { commentedLabel, dropFedReplies, dropOwnReplies, foldFeed, foldNeeds, keepOwnReply, knownReplies, previewName, withOwnReplies } from '../feedFold'"), 'feedFold is the source of the fold')
  t.ok(code.includes("import { onOwnReply, onOwnReplyGone } from '../ownReply'"), 'a confirmed reply is announced to the screens already open')
  t.ok(code.includes("import { FOLD_STRANGER_READS, foldOriginalOf, foldRounds, foldTracker, parentAsks, pendingOf, queueIngest, replayIngest, rootIngest, shownOriginalOf, staleOf } from '../foldRounds'"), 'foldRounds.js reads it')
  t.absent(/\nfunction staleOf \(/.test(code), 'no local copy of staleOf')
  for (const gone of ['replyPreviewMap', 'useReplyPreviews', 'cheapReplies', 'replyPreviewsByRef', "from '../threadRows'"]) {
    t.absent(code.includes(gone), gone + ' is gone')
  }
  t.absent(/\bfetchPost\b/.test(code), 'no thread read from A Rua')
  t.absent(/\bfetchRoda\b/.test(code), 'no roda read from A Rua')
  t.is(code.split("from '../indexClient'").length - 1, 1, 'no new index import')
  t.ok(code.includes('import { COUNTS_MAX, MAX_COOLDOWN_MS, fetchCounts, fetchMember, fetchMembers } from \'../indexClient\''), 'the index calls are the ones A Rua had')
  t.is(code.split("request('diary.peek'").length - 1, 1, 'one peek call site')
})

test('all three list paths derive their rows from one memoized fold', (t) => {
  t.ok(page.includes('const fold = useMemo(() => keepFold(foldFeed(items, foldOpts), foldRef.current, items), [items, foldOriginal, pending, ownKey, blockedKeys])'), 'the page list')
  t.ok(member.includes('const fold = useMemo(() => keepFold(foldFeed(foldItems, foldOpts), foldRef.current, foldItems), [foldItems, foldOriginal, pending, ownKey, foldHidden])'), 'the member list')
  t.ok(member.includes('const ownSent = useOwnSent(ownKey, shownItems)'), 'the member list holds a confirmed reply')
  t.ok(member.includes('const foldItems = useMemo(() => withOwnReplies(shownItems, ownSent, ownKey), [shownItems, ownSent, ownKey])'), 'joined for the fold, not stored in items')
  t.ok(preview.includes('const fold = useMemo(() => foldFeed(shown, { originalOf: view.original, pendingOf: view.pending, ownKey, blocked: foldHidden }), [shown, view, ownKey, foldHidden])'), 'the cold-start preview')
  for (const body of [member, preview]) {
    t.ok(body.includes('const foldHidden = useMemo(() => hiddenInFold(blockedKeys, mutes.keys), [blockedKeys, mutes.keys])'), 'the member list and the preview fold under the block and mute lists')
  }
  for (const [name, body, hidden] of [['page', page, 'blockedKeys'], ['member', member, 'foldHidden']]) {
    t.ok(body.includes('const foldOpts = { originalOf: foldOriginal, pendingOf: pending, ownKey, blocked: ' + hidden + ' }'), name + ': originalOf is social.foldOriginal, never the raw map')
    t.ok(body.includes('const { foldOriginal, pending } = social'), name + ': pendingOf is social.pending')
    t.ok(body.includes('const rows = fold.rows'), name + ': rows come from the fold')
    t.ok(body.includes('data={rows}') && body.includes('keyExtractor={rowKeyOf}'), name + ': the list shows them, keyed by row.key')
    t.ok(body.includes('useRowPropsCache(rows, rowKeyOf, { h: handlers, social })'), name + ': the props cache is pruned by the same keys')
    t.ok(body.includes("if (item.kind === 'comentarios') return foldRowView(item, {"), name + ': a fold row renders the root')
    t.is(body.split('fold: fold.attached.get(feedKey(item)) || null').length - 1, 2, name + ': posts and reposts get their attached lines by the row key')
    t.ok(body.includes('rowsRef.current = rows'), name + ': resolve orders against the folded rows')
  }
  t.ok(page.includes('const blockedKeys = useBlocks().keys'), 'the page list folds under the block list too')
  t.ok(preview.includes('data={rows}') && preview.includes('keyExtractor={rowKeyOf}'), 'the preview shows the folded rows')
  t.ok(preview.includes("if (item.kind === 'comentarios') {") && preview.includes('foldRowView(item, { social: view'), 'the preview renders fold rows')
  t.is(preview.split('fold: fold.attached.get(feedKey(item)) || null').length - 1, 2, 'and attached lines')
  t.absent(page.includes('keyExtractor={feedKey}') || member.includes('keyExtractor={feedKey}') || preview.includes('keyExtractor={feedKey}'), 'feedKey would give undefined:undefined for a fold row')
  const view = textOf(code, 'foldRowView')
  t.ok(view.includes("<RepostPlaceholder verb='comentou'"), 'a pending fold row is the commenter over a loading card')
  t.ok(view.includes('ref: item.root') && view.includes('rowKey: item.key') && view.includes('fold: item'), 'a fold row is its root, keyed by the row')
  t.absent(view.includes('.top'), 'nothing is drawn from a comment top (it may be a blocked author)')
})

test('a confirmed reply joins the member fold and a stale generation is dropped', (t) => {
  const hook = textOf(code, 'useOwnSent')
  t.ok(code.includes('const EMPTY = []'), 'one empty list to reset to')
  t.ok(hook.includes('const [sent, setSent] = useState(EMPTY)'), 'held in state for the screen')
  t.ok(hook.includes('setSent(EMPTY)') && hook.indexOf('setSent(EMPTY)') < hook.indexOf('onOwnReply('), 'an own key starts empty, then subscribes')
  t.ok(hook.includes('onOwnReply((item) => {'), 'subscribes to a confirmed reply')
  t.ok(hook.includes('if (item.gen !== cacheGeneration()) return'), 'a stale or null generation is dropped')
  t.ok(hook.includes('if (item.gen !== cacheGeneration()) return') && hook.indexOf('if (item.gen !== cacheGeneration()) return') < hook.indexOf('keepOwnReply(prev, item)'), 'dropped before it is kept')
  t.ok(hook.includes('setSent((prev) => dropFedReplies(keepOwnReply(prev, item), fedRef.current))'), 'keeps the reply unless the feed already carries it')
  t.ok(hook.includes("if (typeof ownKey !== 'string' || item.author !== ownKey.toLowerCase()) return") && hook.indexOf('item.author !== ownKey.toLowerCase()') < hook.indexOf('keepOwnReply(prev, item)'), 'only the member own replies take a slot')
  t.ok(hook.includes('const fedRef = useRef(items)') && hook.includes('fedRef.current = items'), 'reads the latest fed items')
  t.ok(hook.includes('onOwnReplyGone((refs) => setSent((prev) => dropOwnReplies(prev, refs)))'), 'subscribes to a reply leaving')
  t.ok(hook.includes('setSent((prev) => dropFedReplies(prev, items))') && hook.includes('}, [items])'), 'a reply the feed carries leaves the local list')
  t.ok(hook.includes('}, [ownKey])'), 'keyed on ownKey')
  const cleanup = hook.slice(hook.indexOf('return () =>'))
  t.ok(hook.includes('return () =>') && cleanup.includes('offReply()') && cleanup.includes('offGone()'), 'both removed on cleanup')
  t.absent(page.includes('useOwnSent') || preview.includes('useOwnSent'), 'the page list and the cold-start preview are unchanged')
})

test('a reply whose root resolved never stands alone, and own replies place no card', async (t) => {
  const { foldFeed, keepFold, rowKeyOf } = await helpers()
  const root = post(A, 1, { text: 'raiz' })
  const c1 = reply(B, 4, root, { text: 'oi' })
  const deep = reply(C, 9, c1, { text: 'fundo' })
  const mine = reply(E, 2, root, { text: 'meu' })
  const originals = new Map([[refOf(root), root]])
  const social = fakeSocial({ originals })
  const items = [deep, mine, c1]
  const out = keepFold(foldFeed(items, { originalOf: social.original, pendingOf: social.pending, ownKey: E, blocked: new Set() }), null, items)
  t.is(out.rows.length, 1, 'one card for the whole chain')
  const card = out.rows[0]
  t.is(card.kind, 'comentarios')
  t.is(rowKeyOf(card), 'c:' + refOf(root))
  t.is(card.post, root)
  t.alike(card.by.map((b) => b.author), [C, B], 'newest commenter first, never the own key')
  t.ok(card.lines.some((l) => l.name === 'Você'), 'the own reply is a line')
  t.alike(card.comments[0], { ref: refOf(deep), top: refOf(c1) }, 'focus is the newest comment and its top')
  const ownOnly = foldFeed([mine], { originalOf: social.original, ownKey: E })
  t.is(ownOnly.rows.length, 0, 'an own reply alone places no card')
  const plain = post(D, 3)
  t.is(rowKeyOf(plain), feedKey(plain), 'other rows keep feedKey')
})

test('keepFold returns last pass objects while the content is the same', async (t) => {
  const { foldFeed, keepFold } = await helpers()
  const root = post(A, 1)
  const c1 = reply(B, 4, root, { text: 'oi' })
  const originals = new Map([[refOf(root), root]])
  const opts = { originalOf: (ref) => originals.get(ref), ownKey: E }
  const items = [c1, post(D, 2)]
  const first = keepFold(foldFeed(items, opts), null, items)
  const second = keepFold(foldFeed(items, opts), first, items)
  t.is(second.rows, first.rows, 'same rows array')
  t.is(second.rows[0], first.rows[0], 'same fold row')
  const edited = [{ ...c1, text: 'novo' }, items[1]]
  const third = keepFold(foldFeed(edited, opts), second, edited)
  t.not(third.rows[0], second.rows[0], 'a changed line gives a new row')
  t.is(third.rows[0].by, second.rows[0].by, 'the unchanged commenters stay')
  t.is(third.rows[1], items[1], 'untouched items are the same objects')

  // Attached: the root is in the list above its comment.
  const withRoot = [root, c1]
  const a1 = keepFold(foldFeed(withRoot, opts), null, withRoot)
  t.is(a1.rows.length, 1, 'the comment joins the root row')
  const value = a1.attached.get(feedKey(root))
  t.ok(value && value.lines.length === 1, 'attached by the row key')
  const a2 = keepFold(foldFeed(withRoot, opts), a1, withRoot)
  t.is(a2.attached.get(feedKey(root)), value, 'the attached value stays')

  // A repost row holds it under its own wrapper key.
  const wrapper = { kind: 'repost', author: D, seq: 7, text: null, to: { author: A, seq: 1 } }
  const viaRepost = [wrapper, c1]
  const r = foldFeed(viaRepost, opts)
  t.ok(r.attached.has(feedKey(wrapper)) && !r.attached.has(refOf(root)), 'keyed by the repost wrapper, not by the original')

  // A pending row carries only its key: keepFold finds the reply for the line.
  const pendingOpts = { originalOf: () => undefined, pendingOf: () => true, ownKey: E }
  const lone = [reply(B, 8, { author: C, seq: 3 }, { name: 'Bia' })]
  const p1 = keepFold(foldFeed(lone, pendingOpts), null, lone)
  t.is(p1.rows[0].state, 'pending')
  t.is(p1.rows[0].reply, lone[0], 'the reply it stands for')
  const p2 = keepFold(foldFeed(lone, pendingOpts), p1, lone)
  t.is(p2.rows[0], p1.rows[0], 'and stays the same row')
})

test('a block re-derives the folded rows: the commenter leaves the header and the lines', async (t) => {
  const { foldFeed, keepFold, commentedLabel } = await helpers()
  const root = post(A, 1)
  const bia = reply(B, 4, root, { text: 'da bia', name: 'Bia' })
  const caio = reply(C, 5, root, { text: 'do caio', name: 'Caio' })
  const originals = new Map([[refOf(root), root]])
  const items = [bia, caio]
  const before = keepFold(foldFeed(items, { originalOf: (r) => originals.get(r), ownKey: E, blocked: new Set() }), null, items)
  t.is(commentedLabel(before.rows[0].by), 'Bia e Caio comentaram')
  // What the memo recomputes with when blockedKeys changes.
  const after = keepFold(foldFeed(items, { originalOf: (r) => originals.get(r), ownKey: E, blocked: new Set([B]) }), before, items)
  const card = after.rows.find((row) => row.kind === 'comentarios')
  t.is(commentedLabel(card.by), 'Caio comentou', 'Bia left the header')
  t.absent(card.lines.some((l) => l.text === 'da bia'), 'and the lines')
  t.not(after.rows, before.rows, 'a new list for FlatList')
  t.ok(/\[[^\]]*blockedKeys\]\)/.test(page.slice(page.indexOf('const fold = useMemo('))), 'blockedKeys is a dependency of the page fold')
  for (const body of [member, preview]) t.ok(/\[[^\]]*foldHidden\]\)/.test(body.slice(body.indexOf('const fold = useMemo('))), 'foldHidden (blockedKeys and the mutes) is a dependency of the fold')
})

test('socialRowProps draws a fold: header, lines, more line and the focused open', async (t) => {
  const socialRowProps = await compileRowProps()
  const root = post(A, 1, { text: 'raiz' })
  const fold = {
    by: [{ author: C, name: 'Caio' }, { author: B, name: 'Bia' }],
    lines: [{ key: C + ':9', name: 'Caio', text: 'oi' }, { key: B + ':4', name: 'Bia', text: 'olá' }],
    comments: [{ ref: C + ':9', top: B + ':4' }, { ref: B + ':4', top: B + ':4' }]
  }
  const opened = []
  const members = []
  const h = { onOpenThread: (x) => opened.push(x), onOpenMember: (a, s) => members.push([a, s]) }
  const ref = refOf(root)
  const counts = new Map([[ref, { replies: 5, likes: 0, reposts: 0, quotes: 0 }]])
  const base = { post: root, ref, profileOf: () => undefined, now: 0, ownKey: E, h }
  const p = socialRowProps({ ...base, social: fakeSocial({ counts }), fold })
  t.is(p.commentedBy.label, 'Caio e Bia comentaram')
  p.commentedBy.onOpen()
  t.alike(members, [[C, undefined]], 'the newest commenter profile')
  t.is(p.replyPreviews, fold.lines)
  t.is(p.previewsMore, 'Ver todos os 5 comentários', 'the known total over the lines shown')
  p.onOpenPreviews()
  p.onOpen()
  t.alike(opened, [{ ref, seed: root, focus: { ref: C + ':9', top: B + ':4' } }, { ref, seed: root }], 'previews open on the newest comment, the card on the post')
  t.is(p.level, 'post')

  const indexing = socialRowProps({ ...base, social: fakeSocial({ counts, indexing: true }), fold })
  t.is(indexing.previewsMore, 'Ver comentários', 'no total while the index is building')
  const few = socialRowProps({ ...base, social: fakeSocial({ counts: new Map([[ref, { replies: 2 }]]) }), fold })
  t.is(few.previewsMore, 'Ver comentários', 'a total that says no more than the lines')
  const unknown = socialRowProps({ ...base, social: fakeSocial(), fold })
  t.is(unknown.previewsMore, 'Ver comentários', 'an unknown total')

  const noThread = socialRowProps({ ...base, h: {}, social: fakeSocial({ counts }), fold })
  t.is(noThread.replyPreviews, fold.lines, 'the lines still show without a handler (the preview)')
  t.is(noThread.previewsMore, 'Ver todos os 5 comentários', 'and the more line, as plain text, so the card keeps its height')
  t.is(noThread.onOpenPreviews, undefined)
  t.is(noThread.commentedBy.onOpen, undefined, 'a plain header without a profile handler')

  const plain = socialRowProps({ ...base, social: fakeSocial({ counts }) })
  t.absent('replyPreviews' in plain || 'previewsMore' in plain || 'commentedBy' in plain, 'no fold, nothing added')
  const asReply = socialRowProps({ ...base, post: reply(B, 3, root), ref: B + ':3', social: fakeSocial() })
  t.is(asReply.level, 'comment', 'level comes from the post replyTo for every caller')

  const cache = new Map()
  const social = fakeSocial({ counts })
  const once = socialRowProps({ ...base, social, fold, cache, rowKey: 'c:' + ref })
  const again = socialRowProps({ ...base, social, fold: { ...fold }, cache, rowKey: 'c:' + ref })
  t.is(again, once, 'the same props while the fold says the same thing')
  t.is(again.commentedBy, once.commentedBy, 'commentedBy is built inside the cache')
  const moved = socialRowProps({ ...base, social, fold: { ...fold, by: [fold.by[1]] }, cache, rowKey: 'c:' + ref })
  t.not(moved, once, 'another header rebuilds')
  for (const field of ['folded,', 'replyPreviews: previews', 'previewsMore,', 'commentLabel,', 'commenter,', 'focusRef,', 'focusTop,']) t.ok(inputs.includes(field), 'cache input ' + field)
  t.ok(props.includes('replyPreviews: previews, previewsMore, ...(openPreviews ? { onOpenPreviews: openPreviews } : {})'), 'the more line comes with or without its handler')
})

test('socialRowProps raises a reply count to the direct replies the card shows', async (t) => {
  const socialRowProps = await compileRowProps()
  const root = post(A, 1, { text: 'raiz' })
  const ref = refOf(root)
  const fold = {
    by: [{ author: C, name: 'Caio' }, { author: B, name: 'Bia' }],
    lines: [{ key: C + ':9', name: 'Caio', text: 'oi' }, { key: B + ':4', name: 'Bia', text: 'olá' }],
    comments: [{ ref: C + ':9', top: C + ':9' }, { ref: B + ':4', top: B + ':4' }]
  }
  const base = { post: root, ref, profileOf: () => undefined, now: 0, ownKey: E, h: {}, fold }
  const stored = { replies: 0, likes: 3, reposts: 0, quotes: 0 }
  const raised = socialRowProps({ ...base, social: fakeSocial({ counts: new Map([[ref, stored]]) }) })
  t.is(raised.counts.replies, 2, 'two distinct tops raise a smaller index count')
  t.is(raised.counts.likes, 3, 'the other numbers stay')
  t.is(stored.replies, 0, 'the index object is left as it was')
  t.is(raised.previewsMore, 'Ver comentários', 'a total that says no more than the lines')
  const higher = socialRowProps({ ...base, social: fakeSocial({ counts: new Map([[ref, { replies: 5, likes: 0, reposts: 0, quotes: 0 }]]) }) })
  t.is(higher.counts.replies, 5, 'a larger index count stays')
  t.is(higher.previewsMore, 'Ver todos os 5 comentários', 'the more line still uses that total')
  const unknown = socialRowProps({ ...base, social: fakeSocial() })
  t.is(unknown.counts, null, 'an unknown total stays unknown')
  const indexing = socialRowProps({ ...base, social: fakeSocial({ counts: new Map([[ref, { replies: 0, likes: 0, reposts: 0, quotes: 0 }]]), indexing: true }) })
  t.is(indexing.counts, null, 'indexing stays unknown')
  t.ok(props.includes('const indexed = s.flags.indexing ? null : (s.counts.get(ref) || null)'), 'unknown while the index is building')
  t.ok(props.includes('const known = knownReplies(fold)'), 'what the card itself shows')
  t.ok(props.includes('const counts = indexed !== null && Number.isSafeInteger(indexed.replies) && known > indexed.replies ? { ...indexed, replies: known } : indexed'), 'raised only, never added')
})

test('the cold-start preview draws the more line of its fold rows as live does', async (t) => {
  const socialRowProps = await compileRowProps()
  const root = post(A, 1)
  const ref = refOf(root)
  const seed = { counts: new Map([[ref, { replies: 7, likes: 0, reposts: 0, quotes: 0 }]]), liked: new Set(), reposted: new Set(), originals: new Map([[ref, root]]) }
  // eslint-disable-next-line no-new-func
  const previewSocial = new Function('socialSeed', 'noop', fnText(code, 'previewSocial') + '\nreturn previewSocial')(() => seed, () => {})
  const view = previewSocial({ names: {}, items: [] })
  const fold = { by: [{ author: B, name: 'Bia' }], lines: [{ key: B + ':4', name: 'Bia', text: 'oi' }], comments: [{ ref: B + ':4', top: B + ':4' }] }
  const p = socialRowProps({ post: root, ref, social: view, profileOf: view.profileOf, now: 0, ownKey: E, h: {}, persist: true, fold })
  t.is(p.previewsMore, 'Ver todos os 7 comentários', 'the seed count, as the live list shows it')
  t.is(p.onOpenPreviews, undefined, 'and no tap: the preview sends nothing')
  const view2 = textOf(code, 'foldRowView')
  t.ok(view2.includes('socialRowProps(') && view2.includes('fold: item'), 'the preview fold rows go through the same props')
  t.ok(preview.includes("foldRowView(item, { social: view, profileOf: view.profileOf, now, ownKey, h: PREVIEW_HANDLERS, strangerPersist: 'copy' })"), 'the preview renders its fold rows that way, strangers from the copy store')
  t.ok(view2.includes('fold: item, strangerPersist })'), 'the fold row hands its stranger persist on')
  t.ok(member.includes("foldRowView(item, { social, profileOf: names.profileOf, now, ownKey, h: handlers, cache: rowCache, strangerPersist: 'copy' })"), 'the member\'s fold rows read stranger copies')
  t.ok(page.includes('foldRowView(item, { social, profileOf: names.profileOf, now, ownKey, h: handlers, cache: rowCache })'), 'the page\'s fold rows pass none')
})

// foldRowView compiled from its text, its two JSX returns turned into the
// props and null.
async function compileFoldRowView () {
  const socialRowProps = await compileRowProps()
  const body = fnText(code, 'foldRowView')
    .replace(/return <RepostPlaceholder [^\n]*\/>/, 'return null')
    .replace('return <PostRow {...socialRowProps(', 'return socialRowProps(')
    .replace(/\)\} \/>\n\}$/, ')\n}')
  // eslint-disable-next-line no-new-func
  return new Function('socialRowProps', 'previewName', body + '\nreturn foldRowView')(socialRowProps, () => '')
}

test('the cold-start preview\'s fold rows read a stranger root\'s photos from the copy store', async (t) => {
  const foldRowView = await compileFoldRowView()
  const call = /foldRowView\(item, (\{[^\n]*\})\)\n/.exec(preview)
  t.ok(call, 'the preview\'s fold row call')
  if (!call) return
  // eslint-disable-next-line no-new-func
  const optsOf = new Function('view', 'now', 'ownKey', 'PREVIEW_HANDLERS', 'return ' + call[1])
  const seed = { counts: new Map(), liked: new Set(), reposted: new Set(), originals: new Map() }
  // eslint-disable-next-line no-new-func
  const previewSocial = new Function('socialSeed', 'noop', fnText(code, 'previewSocial') + '\nreturn previewSocial')(() => seed, () => {})
  const view = previewSocial({ names: {}, items: [] })
  const root = post(C, 1, { media: [{}] })
  const item = { kind: 'comentarios', state: 'ready', post: root, root: refOf(root), key: 'f:' + refOf(root), by: [{ author: B, name: 'Bia' }], lines: [], comments: [] }
  const p = foldRowView(item, optsOf(view, 0, E, {}))
  t.is(p.persistMedia, 'copy', 'a stranger root: main kind first, then the copy kind, never main only')
  t.absent(/persist: true/.test(call[1]), 'never a forced persist: true')
  // The live member list's fold row gets the same answer for a stranger.
  const live = foldRowView(item, { social: { ...view, persistOf: () => false }, profileOf: view.profileOf, now: 0, ownKey: E, h: {}, strangerPersist: 'copy' })
  t.is(live.persistMedia, 'copy', 'as A Rua\'s member list keeps it')
})

test('ingest reads the fold only when asked to, and wires foldRounds.js', (t) => {
  t.ok(useSocialText.includes('reset = false, fold = false }) => {'), 'the flag is off by default')
  t.ok(textOf(code, 'pageNeeds').includes('authors, fold: true }'), "A Rua's page needs turn it on")
  for (const file of ['Busca.js', 'Espiadinha.js', 'Diario.js']) {
    const src = withoutComments(fs.readFileSync(path.join(__dirname, '../src/screens', file), 'utf8'))
    t.absent(/\bfold\b/.test(src), file + ' never passes it: it reads what it read before')
  }
  t.ok(useSocialText.includes('const { strangers, kin } = parentAsks(parents, { fold, strangers: hosted && online, isKnown, isBlocked })'), 'round 0 is planned by parentAsks (blocked filtered when folding)')
  t.ok(useSocialText.includes('for (const r of needed.concat(strangers)) seenRef.current.need.add(r)\n    for (const r of kin) seenRef.current.fold.add(r)'), 'fold asks go to their own set, not need')
  t.ok(useSocialText.includes('onAsk: (refs) => { for (const r of refs) seenRef.current.fold.add(r) },'), 'and so do the rounds asks')
  t.ok(useSocialText.includes('strangers: hosted && online,\n      onAsk'), 'the rounds gate strangers hosted and online')
  t.ok(useSocialText.includes('answered: firstRefs.concat(second),'), 'what this ingest read counts as answered')
  t.absent(useSocialText.includes('foldingRef'), 'the old guess ref is gone')
  t.absent(/originals\.set\(ref, null\)/.test(useSocialText.slice(useSocialText.indexOf('const ingestNow = useCallback('), useSocialText.indexOf('const ingestNowRef'))), 'ingest writes no give-up into the originals')
  t.ok(useSocialText.includes('dead.add(r)') && useSocialText.includes('return { dead }'), 'give-ups go to social.dead')
  t.ok(useSocialText.includes('if (reset) change(() => ({ flags: { indexing: false, complete: true }, dead: new Set() }))'), 'cleared on a refresh')
  t.absent(/\bfetch[A-Z]\w*\(/.test(fs.readFileSync(path.join(__dirname, '../src/foldRounds.js'), 'utf8')), 'no index request in the rounds')
})

test('a fold root that is no feed item gets counts and own state once per epoch', (t) => {
  t.ok(useSocialText.includes('const rootArgs = rootIngest(roots, { shown: shownRef.current, done: foldShownRef.current })\n    if (rootArgs !== null) ingestRef.current(rootArgs)'), 'through rootIngest: a plain ingest (no fold, so no loop)')
  t.is(useSocialText.split('foldShownRef.current = new Set()').length - 1, 2, 'once per epoch: a refresh and a follows drop clear it')
  t.ok(useSocialText.includes('ingestRef.current = ingest'))
})

test('the fold ingest starts its guess as soon as the follow list is known', (t) => {
  const body = useSocialText.slice(useSocialText.indexOf('const ingestNow = useCallback('), useSocialText.indexOf('const ingestNowRef'))
  const start = body.indexOf('if (fold === true) trackerRef.current.start({ budget: FOLD_STRANGER_READS, strangers: hosted && online, isBlocked })')
  t.ok(start > 0, 'the strangers rule and the budget')
  t.ok(start > body.indexOf('parentAsks(parents, {'), 'after the follow list is loaded')
  t.ok(start < body.indexOf('await pageEngagement(') && start < body.indexOf('await readEngagement('), 'before the engagement reads it waits on')
  t.ok(start < body.indexOf('await foldRounds({'), 'before the rounds')
})

test('a follows drop replays need alone and re-runs the fold under its own rules', (t) => {
  const effect = useSocialText.slice(useSocialText.indexOf('const seenFollows = useRef(followsVersion)'), useSocialText.indexOf('const acting = useActing()'))
  t.ok(effect.includes('seenRef.current = { need, local, fold: new Set() }'), 'the fold asks are dropped, not replayed as plain reads')
  t.ok(effect.includes('change(() => ({ originals: new Map(local), dead: new Set() }))'), 'and the dead set')
  t.ok(effect.includes('const args = replayIngest({ need, local }, foldOnRef.current)\n    if (args !== null) ingest(args)'), 'the fold re-runs over the posts at hand, with their parents')
  t.absent(effect.includes('seenRef.current.fold]') || effect.includes('...fold'), 'no fold ask goes back into need')
})

test('pending and foldOriginal are the pure rules of foldRounds.js, the stale map merged', (t) => {
  const pendingText = useSocialText.slice(useSocialText.indexOf('const pending = useCallback('), useSocialText.indexOf('const retry = useCallback('))
  t.ok(pendingText.includes('const pending = useCallback((ref) => pendingOf(ref, {'), 'pending is pendingOf')
  t.ok(pendingText.includes('guess: (author) => trackerRef.current.guess(author, { isKnown, isBlocked: isBlockedNow })'), 'guessing through the tracker')
  t.ok(pendingText.includes('const foldOriginal = useCallback((ref) => foldOriginalOf(ref, {'), 'foldOriginal is foldOriginalOf')
  t.ok(pendingText.includes('stale: staleRef.current,') && pendingText.includes('isBlocked: isBlockedNow'), 'over the stale map, block-aware')
  const merge = 'staleRef.current = staleOf(socialRef.current.originals, { dead: socialRef.current.dead, deleted: deletedRef.current, isTransient, prev: staleRef.current, isBlocked: isBlockedNow })'
  t.is(useSocialText.split(merge).length - 1, 2, 'merged at a reset and at a follows drop')
  t.absent(/\n {6}if \(mountedRef\.current\) change\(\(\) => \(\{\}\)\)/.test(useSocialText), 'no render forced after every ingest')
  t.ok(useSocialText.includes('onRender: () => { if (mountedRef.current) change(() => ({})) }'), 'only queueIngest asks for one, after a guess')
})

test('a pending comment row names its peer by the fold rule', (t) => {
  const view = textOf(code, 'foldRowView')
  t.ok(view.includes('const title = previewName(reply)'), 'previewName, not whoOf')
  t.ok(view.includes("const by = { author: reply.author, name: title !== '' ? title : null, username: null }"), 'the placeholder gets that title alone')
})

test('a refresh keeps the card while its chain is read again', async (t) => {
  const { foldFeed, foldOriginalOf } = await helpers()
  const root = post(A, 1)
  const mid = reply(C, 2, root)
  const c1 = reply(B, 4, mid, { name: 'Bia' })
  const c2 = reply(D, 5, mid, { name: 'Duda' })
  const items = [c1, c2]
  const stale = new Map([[refOf(root), root], [refOf(mid), mid]])
  const originals = new Map()
  const dead = new Set()
  let asked = new Set([refOf(mid), refOf(root)])
  const pending = (ref) => originals.get(ref) === undefined && !dead.has(ref) && asked.has(ref)
  const foldOriginal = (ref) => foldOriginalOf(ref, { stored: (r) => originals.get(r), isTransient: (i) => i === TRANSIENT, dead, stale, pending, isBlocked: () => false })
  const during = foldFeed(items, { originalOf: foldOriginal, pendingOf: pending, ownKey: E })
  t.is(during.rows.length, 1, 'one card, not one placeholder per comment')
  t.is(during.rows[0].key, 'c:' + refOf(root))
  const without = foldFeed(items, { originalOf: (ref) => originals.get(ref), pendingOf: pending, ownKey: E })
  t.is(without.rows.filter((r) => r.state === 'pending').length, 2, 'what the reset showed before')
  originals.set(refOf(mid), null)
  const answered = foldFeed(items, { originalOf: foldOriginal, pendingOf: pending, ownKey: E })
  t.is(answered.rows.filter((r) => r.kind === 'comentarios').length, 0, 'an unavailable answer wins: chip rows')
  originals.delete(refOf(mid))
  asked = new Set()
  const unasked = foldFeed(items, { originalOf: foldOriginal, pendingOf: pending, ownKey: E })
  t.is(unasked.rows.filter((r) => r.kind === 'comentarios').length, 0, 'only while the ref is read again')
})

test('on a core node a first row replying to a stranger still marks details ready and writes the snapshot', async (t) => {
  const { foldWaits, foldAsk, foldTracker } = await helpers()
  const { feedDetailsReady } = await import('../src/splashGate.js')
  const parent = { author: C, seq: 2 }
  const rows = [reply(A, 5, parent), post(B, 3)]
  const originals = new Map(rows.map((r) => [refOf(r), r]))
  const dead = new Set()
  const asked = new Set()
  const tracker = foldTracker()
  const isKnown = (a) => a === A || a === B
  // useSocial.pending, with this node's strangers rule (a core node).
  const pending = (ref) => {
    if (originals.get(ref) !== undefined) return false
    if (dead.has(ref)) return false
    if (asked.has(ref)) return true
    return tracker.guess(ref.slice(0, ref.indexOf(':')), { isKnown, isBlocked: () => false })
  }
  const ready = () => feedDetailsReady({
    authors: rows.map((r) => r.author),
    shown: rows.map(refOf),
    profileOf: () => null,
    originals: [].concat(foldWaits(rows, originals, pending, dead)),
    hasOriginal: (ref) => originals.has(ref),
    hasCount: () => false,
    countsSkipped: true
  })
  t.ok(ready(), 'nothing queued, never asked: never waited on')
  // A fold ingest is queued (the reset waits on follow.list before it
  // records its asks): the gate holds.
  tracker.queue()
  t.absent(ready(), 'queued: held before the asks are recorded')
  tracker.start({ budget: 8, strangers: false, isBlocked: () => false })
  t.ok(ready(), 'the rounds on a core node would not ask a stranger')
  const plan = foldAsk([C + ':2'], { isKnown, isBlocked: () => false, strangers: false, budget: 8 })
  for (const ref of plan.decline) dead.add(ref)
  tracker.stop()
  t.ok(ready(), 'declined into the dead set: ready while the ingest still runs')
  tracker.settle()
  t.ok(ready(), 'and after, with the originals unread')
  t.is(originals.get(C + ':2'), undefined)
  t.alike(foldWaits(rows, originals, pending, dead), [])
  t.alike(foldWaits(rows, originals, (ref) => ref === C + ':2', dead), [], 'dead ends the chain even for a later need')

  // Hosted and online: an asked read holds the gate until it answers, any way.
  const hosted = new Map(rows.map((r) => [refOf(r), r]))
  const waits = (ref) => ref === C + ':2' && hosted.get(ref) === undefined
  t.alike(foldWaits(rows, hosted, waits), [C + ':2'], 'asked and not answered')
  hosted.set(C + ':2', TRANSIENT)
  t.alike(foldWaits(rows, hosted, waits), [], 'a transient failure is an answer')

  const gates = code.split('.concat(foldWaits(rows, socialState.originals, social.pending, socialState.dead))').length - 1
  t.is(gates, 2, 'the boot cover and the snapshot write both count only asked fold reads, past the dead set')
})

test('indexByRef ties a fold row to its root and its comments', async (t) => {
  const body = [fnText(code, 'refOf'), fnText(code, 'indexByRef')].join('\n')
  // eslint-disable-next-line no-new-func
  const indexByRef = new Function('feedKey', 'TRANSIENT', body + '\nreturn indexByRef')(feedKey, TRANSIENT)
  const root = post(A, 1, { quote: { author: D, seq: 9 } })
  const card = { kind: 'comentarios', key: 'c:' + refOf(root), root: refOf(root), post: root, by: [], lines: [], comments: [{ ref: B + ':4', top: B + ':4' }] }
  const waiting = { kind: 'comentarios', state: 'pending', key: C + ':3', reply: reply(C, 3, { author: E, seq: 1 }) }
  const map = indexByRef([post(D, 2), card, waiting], new Map())
  t.alike(map.get(refOf(root)), [1], 'the root')
  t.alike(map.get(B + ':4'), [1], 'a comment')
  t.alike(map.get(D + ':9'), [1], 'what the root quotes')
  t.alike(map.get(E + ':1'), [2], 'the ancestor a pending row waits for')
  t.alike(map.get(C + ':3'), [2])
  t.absent(map.has('undefined:undefined'), 'no feedKey of a fold row')
})

test('socialRowProps passes thumbnails to photo rows and quotes, including legacy posts', async (t) => {
  const socialRowProps = await compileRowProps()
  const thumbs = [null, { untrusted: true }]
  const quoted = post(B, 2, { media: [{ photo: true }], thumbs })
  const root = post(A, 1, { media: [{ photo: true }], thumbs, quote: { author: B, seq: 2 } })
  const base = { post: root, ref: refOf(root), profileOf: () => null, now: 0, ownKey: E, h: {}, social: fakeSocial({ originals: new Map([[refOf(quoted), quoted]]) }) }
  const props = socialRowProps(base)
  t.is(props.thumbs, thumbs)
  t.is(props.quote.thumbs, thumbs)
  t.is(socialRowProps({ ...base, post: post(A, 3) }).thumbs, undefined)
})

test('useSocial batches all unknown authors before its limited diary reads', async (t) => {
  const { compileFunction } = require('node:vm')
  const { poolMap } = await import('../src/engagement.js')
  const { orderRefs } = await import('../src/visibleFirst.js')
  const keys = Array.from({ length: 25 }, (_, i) => (i + 1).toString(16).padStart(64, '0'))
  const refs = keys.map((key) => key + ':1')
  const calls = []
  const members = keys.map((author) => ({ ok: true, value: { author } }))
  const socialRef = { current: { originals: new Map() } }
  const mountedRef = { current: true }
  const epochRef = { current: 1 }
  const context = {
    useCallback: (fn) => fn,
    socialRef,
    mountedRef,
    epochRef,
    TRANSIENT,
    hasName: (item) => !!item.name,
    rowsRef: { current: [] },
    visibleRangeRef: { current: null },
    indexByRef: () => new Map(),
    orderRefs,
    visibleRowIndex: () => undefined,
    authorOfRef: (ref) => ref.split(':')[0],
    isKnown: () => false,
    hosted: true,
    online: true,
    loadFollows: async () => {},
    fetchMembers: async (authors) => { calls.push(authors); return members },
    poolMap,
    readAuthor: async (author, refs, member) => {
      t.is(member, members[keys.indexOf(author)], 'each diary read reuses its batch hint')
      return new Map(refs.map((ref) => [ref, post(author, 1)]))
    },
    change: (fn) => { socialRef.current = fn(socialRef.current) },
    resolveMany: () => {},
    scheduleNameRetry: () => {},
    request: () => {}
  }
  const from = raw.indexOf('  const resolve = useCallback(async (need, opts) => {')
  const to = raw.indexOf('  resolveRef.current = resolve', from)
  const resolve = compileFunction(raw.slice(from, to) + '\nreturn resolve', Object.keys(context))(...Object.values(context))
  t.is((await resolve(refs)).length, 25)
  t.alike(calls, [keys], 'the diary pool cannot split the member lookup into pairs')
  socialRef.current = { originals: new Map() }
  mountedRef.current = false
  t.alike(await resolve(refs), [])
  t.is(calls.length, 1, 'a closed screen sends no index batch')
})
