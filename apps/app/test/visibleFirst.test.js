'use strict'

// Rows on screen are resolved before the rows below them and the rows above.
// orderRefs is pure; A Rua and RefreshableList are checked on their source
// because those modules load React Native.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const load = () => import('../src/visibleFirst.js')
const read = (file) => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')

const at = (map) => (ref) => map[ref]

test('orderRefs puts the range first, then below, then above, each in row order', async (t) => {
  const { orderRefs } = await load()
  const indexOf = at({ a: 0, b: 1, c: 2, d: 3, e: 4 })
  const range = { first: 1, last: 2 }
  // b and c are on screen, d and e are below, a is above. z and y are not rows.
  t.alike(
    orderRefs(['z', 'e', 'a', 'c', 'b', 'd', 'y'], indexOf, range),
    ['b', 'c', 'd', 'e', 'a', 'z', 'y']
  )
  // The ends of the range are on screen. Same index keeps the given order.
  t.alike(orderRefs(['q', 'c', 'p', 'a'], at({ q: 1, p: 1, c: 2, a: 0 }), range), ['q', 'p', 'c', 'a'])
  t.alike(orderRefs(['c', 'a', 'b'], indexOf, { first: 0, last: 0 }), ['a', 'b', 'c'], 'only the first row is inside')
  t.alike(orderRefs(['a', 'b', 'c'], indexOf, { first: 2, last: 2 }), ['c', 'a', 'b'], 'only the last row is inside')
  t.alike(orderRefs(['c', 'a', 'b'], indexOf, { first: 0, last: 4 }), ['a', 'b', 'c'], 'a range over every row is row order')
  // 10 is below 2. Numeric order, not lexicographic.
  t.alike(orderRefs(['a', 'b'], at({ a: 10, b: 2 }), { first: 0, last: 0 }), ['b', 'a'])
})

test('orderRefs with no range returns row order and leaves unplaced refs last', async (t) => {
  const { orderRefs } = await load()
  const indexOf = at({ a: 2, b: 0, c: 2, d: 1 })
  t.alike(orderRefs(['a', 'z', 'c', 'b', 'd', 'y'], indexOf, null), ['b', 'd', 'a', 'c', 'z', 'y'])
  t.alike(orderRefs(['a', 'z', 'c', 'b', 'd', 'y'], indexOf, undefined), ['b', 'd', 'a', 'c', 'z', 'y'])
  t.alike(orderRefs(['b', 'a'], indexOf), ['b', 'a'], 'a missing range argument')
  // Not a window: first past last, or bounds that are not finite numbers.
  for (const range of [{ first: 3, last: 1 }, { first: 0 }, { last: 1 }, { first: '0', last: '2' }, {}, 2, '1']) {
    t.alike(orderRefs(['a', 'b', 'z'], at({ a: 1, b: 0 }), range), ['b', 'a', 'z'], 'not a range: ' + JSON.stringify(range))
  }
  t.alike(orderRefs(['m', 'n'], () => undefined, { first: 0, last: 3 }), ['m', 'n'], 'no row index stays in given order')
  t.alike(orderRefs(['m', 'n'], null, { first: 0, last: 0 }), ['m', 'n'], 'no indexOf')
})

test('orderRefs ignores a non-finite index and does not mutate its input', async (t) => {
  const { orderRefs } = await load()
  const refs = Object.freeze(['a', 'b', 'c', 'd', 'e'])
  let calls = 0
  const indexOf = (ref) => {
    calls++
    if (ref === 'a') return 0
    if (ref === 'b') return NaN
    if (ref === 'c') return Infinity
    if (ref === 'd') return '1'
    if (ref === 'e') return 1.5
    return undefined
  }
  const out = orderRefs(refs, indexOf, { first: 1, last: 2 })
  t.alike(out, ['e', 'a', 'b', 'c', 'd'])
  t.not(out, refs, 'a new array')
  t.alike(refs, ['a', 'b', 'c', 'd', 'e'], 'input stays frozen in place')
  t.is(calls, refs.length, 'one lookup per ref')
  calls = 0
  t.alike(orderRefs([], indexOf, { first: 0, last: 1 }), [])
  t.alike(orderRefs(null, indexOf, null), [])
  t.is(calls, 0, 'nothing to look up')
  // Same index, fractional, inside a fractional window.
  t.alike(
    orderRefs(['b', 'a', 'c'], at({ a: 1.5, b: 0.5, c: 1.5 }), { first: 1, last: 2 }),
    ['a', 'c', 'b']
  )
})

test("A Rua's resolve orders todo with orderRefs before grouping authors", (t) => {
  const src = read('screens/ARua.js')
  t.ok(src.includes("import { orderRefs } from '../visibleFirst'"), 'orderRefs comes from the pure module')
  const start = src.indexOf('const resolve = useCallback(async (need, opts) => {')
  t.ok(start > 0, 'resolve is found')
  const body = src.slice(start, src.indexOf('resolveRef.current = resolve', start))
  t.ok(body.includes('orderRefs(todo,'), 'resolve calls orderRefs on todo')
  t.ok(body.indexOf('orderRefs(todo,') < body.indexOf('const byAuthor = new Map()'), 'before authors are grouped')
  t.ok(body.indexOf('for (const ref of ordered)') < body.indexOf('byAuthor.set(author'), 'the group walk is the ordered one')
  t.ok(body.includes('visibleRangeRef'), 'the visible range is read from its ref')
  t.ok(body.includes('rowsRef'), 'row indices come from the list ref')
  const names = body.lastIndexOf('for (const ref of ordered)')
  t.ok(names > body.indexOf('const byAuthor = new Map()') && names < body.indexOf('resolveMany(unnamed)'), 'resolveMany hears the visible authors first')
  t.is(src.split('onViewableItemsChanged={onViewableItemsChanged}').length - 1, 2, 'the member list and the page list report the range')
  t.is(src.split('const visibleRangeRef = useRef(null)').length - 1, 2, 'each live list keeps its own range')
  t.ok(src.includes('rowsRef.current = shownItems'), 'the member list on screen')
  t.ok(src.includes('rowsRef.current = items'), 'the page list on screen')
  // Ordering does not add, drop or repeat a read.
  t.is(src.split("request('diary.peek'").length - 1, 1, 'one diary.peek call site')
  t.is(src.split('fetchCounts(').length - 1, 1, 'counts stay one fetch path per page')
  t.is(src.split("request('log.read'").length - 1, 1, 'the fallback read is unchanged')
  const counts = src.slice(src.indexOf('Promise.all(chunks(refs, COUNTS_MAX)'), src.indexOf('if (reset) await loadFollows()'))
  t.absent(counts.includes('orderRefs'), 'counts are not reordered')
})

test('RefreshableList forwards a stable onViewableItemsChanged and a constant viewabilityConfig', (t) => {
  const src = read('ui/RefreshableList.js')
  t.ok(src.indexOf('const VIEWABILITY_CONFIG = Object.freeze(') > 0)
  t.ok(src.indexOf('const VIEWABILITY_CONFIG = Object.freeze(') < src.indexOf('export function RefreshableList'), 'one config for every list')
  t.ok(src.includes('onViewableRef.current = onViewableItemsChanged'), 'the latest caller is read from a ref')
  t.ok(src.includes('const onViewable = useRef((info) => {'), 'the FlatList callback is created once')
  t.ok(src.includes("useRef(typeof onViewableItemsChanged === 'function').current"), 'whether to track is fixed for the life of the list')
  const flat = src.slice(src.indexOf('<FlatList'), src.indexOf('/>', src.indexOf('<FlatList')))
  t.ok(flat.includes('onViewableItemsChanged={trackViewable ? onViewable : undefined}'), 'forwarded when the caller passed one')
  t.ok(flat.includes('viewabilityConfig={trackViewable ? VIEWABILITY_CONFIG : undefined}'), 'the constant config goes with it')
  t.absent(/onViewableItemsChanged=\{\(/.test(flat), 'not an inline callback FlatList would reject on the next render')
})
