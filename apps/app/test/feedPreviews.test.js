// Reply previews on A Rua are posts already in the list. cheapRepliesMap walks
// that list; the screen must not ask the index or the node for more.
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
const mapFn = textOf(code, 'replyPreviewMap')
const hook = textOf(code, 'useReplyPreviews')
const props = textOf(code, 'socialRowProps')
const page = textOf(code, 'PageARua')
const member = textOf(code, 'MemberARua')
const preview = textOf(code, 'ARuaPreview')
const inputsAt = code.indexOf('const inputs = {')
const inputs = inputsAt < 0 ? '' : code.slice(inputsAt, code.indexOf('return cachedRow(', inputsAt))

const A = 'aa'.repeat(32)
const B = 'bb'.repeat(32)
const C = 'cc'.repeat(32)
const D = 'dd'.repeat(32)

const post = (author, seq, extra = {}) => ({
  kind: 'post',
  author,
  seq,
  at: '2026-10-20T10:00:00.000Z',
  text: 't' + seq,
  name: 'Ana',
  username: 'ana',
  replyTo: null,
  ...extra
})

const pads = (start) => Array.from({ length: 6 }, (_, i) => post(D, start + i, { text: 'p' + i }))

function compile (cheapRepliesMap) {
  const body = textOf(code, 'refOf') + '\n' + mapFn
  if (!body.includes('function replyPreviewMap')) return null
  try {
    // eslint-disable-next-line no-new-func
    return new Function('cheapRepliesMap', body + '\nreturn replyPreviewMap')(cheapRepliesMap)
  } catch {
    return null
  }
}

test('A Rua builds reply previews from cheapRepliesMap and adds no request', (t) => {
  t.ok(
    code.includes("import { cheapRepliesMap } from '../threadRows'") &&
    code.split("from '../indexClient'").length === 2,
    'cheapRepliesMap comes from ../threadRows and indexClient is not imported again'
  )
  t.ok(
    mapFn.includes('cheapRepliesMap(') &&
    !/\bcheapReplies\(/.test(mapFn) &&
    mapFn.includes('item.replyTo') &&
    !/\brequest\s*\(/.test(mapFn) &&
    !mapFn.includes('indexClient') &&
    !mapFn.includes('fetchCounts') &&
    !mapFn.includes('fetchMember') &&
    !mapFn.includes('node.request'),
    'the map walks loaded replyTo rows and does not request anything'
  )
  t.ok(hook.includes('useMemo(() => replyPreviewMap(items, prev.current, blocked), [items, blocked])') && hook.includes('useBlocks().keys'), 'the map is built once per items or block list change')
  t.ok(
    props.includes('const openThread = offers.thread ? () => live.h.onOpenThread({ ref, seed: post }) : undefined') &&
    props.includes('onOpen: openThread') &&
    props.includes('...(previews ? { replyPreviews: previews, onOpenPreviews: openThread } : {})'),
    'a non-empty list is passed with the handler that opens this post'
  )
  t.ok(inputs.includes('replyPreviews: previews'), 'the row cache includes the preview list')
  const pass = 'replyPreviews: replyPreviewsByRef.get(refOf('
  const espia = withoutComments(fs.readFileSync(path.join(__dirname, '../src/screens/Espiadinha.js'), 'utf8'))
  t.ok(
    page.includes('useReplyPreviews(items)') &&
    member.includes('useReplyPreviews(shownItems)') &&
    page.split(pass).length - 1 === 2 &&
    member.split(pass).length - 1 === 2 &&
    preview.length > 0 &&
    !preview.includes('replyPreviews') &&
    !preview.includes('useReplyPreviews') &&
    !espia.includes('cheapReplies') &&
    !espia.includes('replyPreviews'),
    'both live lists pass previews for the post and the repost; the preview and the Espiadinha do not'
  )
})

test('replyPreviewMap keeps distant loaded replies and stable arrays', async (t) => {
  const { cheapRepliesMap } = await import('../src/threadRows.js')
  const calls = []
  const replyPreviewMap = compile((list, refs, options) => {
    calls.push(...refs)
    return cheapRepliesMap(list, refs, options)
  })
  const parent = post(A, 1, { text: 'foco', name: 'Ana' })
  const near = []
  for (let i = 0; i < 5; i++) {
    near.push(post(B, i + 1, { replyTo: { author: A, seq: 1 }, text: 'perto' + i, name: 'Perto' }))
  }
  const far1 = post(C, 2, { replyTo: { author: A.toUpperCase(), seq: 1 }, text: 'longe', name: 'Lia' })
  const far2 = post(C, 3, { replyTo: { author: A, seq: 1 }, text: 'mais', name: null, username: 'lia' })
  const far3 = post(C, 4, { replyTo: { author: A, seq: 1 }, text: 'extra', name: 'Extra' })
  // D:4 is not a row. A walk of every replyTo would ask for it.
  const stray = post(C, 8, { replyTo: { author: D, seq: 4 }, text: 'outro', name: 'Outra' })
  const items = [parent, ...near, far1, far2, far3, stray]
  const key = A + ':1'
  const first = replyPreviewMap ? replyPreviewMap(items, null) : null
  t.ok(replyPreviewMap && calls.length === 1 && calls[0] === key, 'one walk, and not for a parent that is not loaded')
  t.alike(first && first.get(key), [
    { key: C + ':2', name: 'Lia', text: 'longe' },
    { key: C + ':3', name: 'lia', text: 'mais' }
  ])
  t.ok(first instanceof Map && !first.has(D + ':4') && !first.has(D + ':1'), 'no loaded reply, no entry')

  // The reply sits above its parent. The parent ref is only known once the
  // whole list has been seen, and the gap is outside the near window.
  const above = post(B, 9, { replyTo: { author: A, seq: 1 }, text: 'acima', name: 'Bo' })
  const onlyAbove = [...pads(1), above, ...pads(20), parent]
  const aboveMap = replyPreviewMap ? replyPreviewMap(onlyAbove, null) : null
  t.alike(aboveMap && aboveMap.get(key), [{ key: B + ':9', name: 'Bo', text: 'acima' }])

  const nearOnly = replyPreviewMap ? replyPreviewMap([parent, ...near], null) : null
  t.ok(nearOnly instanceof Map && nearOnly.size === 0, 'replies inside the near window stay rows, not previews')

  const orphan = [post(C, 8, { replyTo: { author: A, seq: 9 }, text: 'sumiu', name: 'Lia' })]
  const before = calls.length
  const orphanMap = replyPreviewMap ? replyPreviewMap(orphan, null) : null
  t.ok(replyPreviewMap && orphanMap instanceof Map && orphanMap.size === 0 && calls.length === before, 'an unloaded parent is not walked')

  const repostList = [
    parent,
    ...pads(1),
    { ...post(B, 9, { text: 'nao', name: 'Bia', replyTo: { author: A, seq: 1 } }), kind: 'repost' }
  ]
  const repostMap = replyPreviewMap ? replyPreviewMap(repostList, null) : null
  t.ok(repostMap instanceof Map && !repostMap.has(key), 'a repost wrapper is not a reply')

  const blankList = [
    parent,
    ...pads(1),
    post(C, 2, { replyTo: { author: A, seq: 1 }, text: '   ', name: 'Lia' })
  ]
  const blankMap = replyPreviewMap ? replyPreviewMap(blankList, null) : null
  t.ok(blankMap instanceof Map && blankMap.size === 0, 'a blank reply is not a preview')

  // The original is on screen only through a repost row.
  const viaRepost = [
    { ...post(D, 40, { text: '', name: 'Dani' }), kind: 'repost', to: { author: A, seq: 1 } },
    ...pads(6),
    post(C, 2, { replyTo: { author: A, seq: 1 }, text: 'longe', name: 'Lia' })
  ]
  const viaRepostMap = replyPreviewMap ? replyPreviewMap(viaRepost, null) : null
  t.alike(viaRepostMap && viaRepostMap.get(key), [{ key: C + ':2', name: 'Lia', text: 'longe' }], 'a reposted original gets its previews')

  const clone = items.map((item) => ({ ...item, replyTo: item.replyTo ? { ...item.replyTo } : null }))
  const second = replyPreviewMap ? replyPreviewMap(clone, first) : null
  t.ok(first && second && second.get(key) === first.get(key), 'unchanged lines keep the same array')
  const edited = clone.map((item) => (item.author === C && item.seq === 2 ? { ...item, text: 'novo' } : item))
  const third = replyPreviewMap ? replyPreviewMap(edited, second) : null
  t.ok(third && second && third.get(key) !== second.get(key) && third.get(key)[0].text === 'novo', 'a changed line replaces that array')

  const blockedMap = replyPreviewMap ? replyPreviewMap(items, null, new Set([C])) : null
  t.ok(blockedMap instanceof Map && !blockedMap.has(key), 'a blocked author does not preview')
  const unblockedMap = replyPreviewMap ? replyPreviewMap(items, null, new Set([D])) : null
  t.alike(unblockedMap && unblockedMap.get(key), first && first.get(key), 'another blocked key leaves the previews')

  const other = post(D, 1, { text: 'outro', name: 'Dina' })
  const otherReply = post(B, 30, { replyTo: { author: D, seq: 1 }, text: 'la', name: 'Bia' })
  const both = [...items, other, ...pads(50), otherReply]
  const bothMap = replyPreviewMap ? replyPreviewMap(both, first) : null
  t.ok(bothMap && first && bothMap.get(key) === first.get(key), 'another parent does not rebuild this array')
  t.alike(bothMap && bothMap.get(D + ':1'), [{ key: B + ':30', name: 'Bia', text: 'la' }])
  const empty = replyPreviewMap ? replyPreviewMap(null, null) : null
  t.ok(empty instanceof Map && empty.size === 0, 'a missing list is an empty map')
})

test('replyPreviewMap reads each row a bounded number of times', async (t) => {
  const { cheapRepliesMap } = await import('../src/threadRows.js')
  const replyPreviewMap = compile(cheapRepliesMap)
  // A long chain: every row replies to the one before it, so every row is a
  // parent with a loaded reply. One walk per parent reads n * n rows.
  const n = 600
  const rows = []
  for (let i = 1; i <= n; i++) rows.push(post(A, i, { replyTo: i > 1 ? { author: A, seq: i - 1 } : null }))
  let reads = 0
  const list = new Proxy(rows, {
    get (target, key) {
      if (typeof key === 'string' && /^[0-9]+$/.test(key)) reads++
      return target[key]
    }
  })
  const map = replyPreviewMap ? replyPreviewMap(list, null) : null
  t.ok(map instanceof Map && map.size === 0, 'neighbours are rows, not previews')
  t.ok(reads > 0 && reads <= 4 * n, 'about one read per row per pass (' + reads + ' for ' + n + ' rows)')
})
