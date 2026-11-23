'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const src = readFileSync(join(__dirname, '../src/screens/Grupo.js'), 'utf8')

const HOOK = /\buse(Ref|Memo|Callback|State|Effect|LayoutEffect)\(/

function helper (name) {
  const match = src.match(new RegExp('(?:export )?function ' + name + ' \\([^]*?\\n\\}'))
  if (!match) throw new Error('missing helper: ' + name)
  const calls = src.match(/const GROUP_ROW_CALLS = \[[^\]]*\]/)[0]
  // eslint-disable-next-line no-new-func
  return new Function(calls + '\n' + match[0].replace(/^export /, '') + '\nreturn ' + name)()
}

test('Grupo renders chat rows through one renderItem for the list life', (t) => {
  t.ok(src.includes('const renderItem = useCallback((info) => renderRef.current(info), [])'), 'stable renderItem reads the newest body')
  t.ok(src.includes('renderRef.current = ({ item: row }) => {'))
  t.ok(src.includes('const rowCalls = useMemo(() => liveGroupRowCalls(rowLive), [])'), 'one set of row calls for the list life')
  t.ok(src.includes('extraData={extra}'))
  t.absent(/extraData=\{\{/.test(src), 'no inline extraData object')
  t.ok(src.includes('const GroupRow = memo(function GroupRow ('), 'the row is memo')
  const rowEnd = src.indexOf('\n})\n', src.indexOf('const GroupRow = memo('))
  t.ok(rowEnd !== -1 && !/\n\}/.test(src.slice(src.indexOf('const GroupRow = memo('), rowEnd)), 'with the default shallow compare, row included')
  t.absent(src.includes('GroupMessage' + 'Row'))
})

test('the new hooks sit above the early return, outside the compiled slices', (t) => {
  const from = src.indexOf('  }, [reactionsDisabled, reactionContext])')
  const to = src.indexOf('  const reactionsFor', from)
  t.ok(from !== -1 && to > from)
  const block = src.slice(from, to)
  for (const pin of ['const rowLive = useRef(null)', 'const rowCalls = useMemo(', 'const renderRef = useRef(null)', 'const renderItem = useCallback', 'const extraMemo = useRef(null)', 'const listLive = useRef(null)']) {
    t.ok(block.includes(pin), pin)
  }
  const open = src.indexOf('  if (!open) {')
  const end = src.indexOf('\n}\n', open)
  t.ok(open !== -1 && end > open)
  t.absent(HOOK.test(src.slice(open, end)), 'no hook below the early return')
  const reactStart = src.indexOf('  const whoReactedRows =')
  t.absent(HOOK.test(src.slice(reactStart, open)), 'no hook in the reaction slices')
})

test('the composer is not a row input', (t) => {
  const extra = (src.match(/const extraDeps = \[[^\n]*/) || [''])[0]
  t.ok(extra, 'extraDeps is listed')
  t.absent(/\bdraft\b|\battachments\b|\blinkDraft\b|\bpost\b/.test(extra), 'extraData carries no composer state')
  const start = src.indexOf('  renderRef.current = ({ item: row }) => {')
  const body = src.slice(start, src.indexOf('\n  }\n', start))
  t.ok(body.length > 0)
  t.absent(/\bdraft\b|\battachments\b|\blinkDraft\b|\bpost\b/.test(body), 'renderItem reads no composer state')
})

test('row calls run the newest handler at call time', (t) => {
  const liveGroupRowCalls = helper('liveGroupRowCalls')
  const seen = []
  const live = { current: { toggleReaction: (k, e) => seen.push(['old', k, e]) } }
  const calls = liveGroupRowCalls(live)
  const toggle = calls.toggleReaction
  live.current = { toggleReaction: (k, e) => seen.push(['new', k, e]), scrollToKey: (k) => seen.push(['jump', k]), actionsOf: () => [{ label: 'Responder' }] }
  toggle('a', 'x')
  calls.scrollToKey('b')
  t.alike(seen, [['new', 'a', 'x'], ['jump', 'b']])
  t.alike(calls.actionsOf({}), [{ label: 'Responder' }])
  for (const name of ['profileFor', 'quoteOf', 'reactionsFor', 'showReactors', 'openReactionPicker']) t.is(typeof calls[name], 'function', name)
})

test('the row looks each sheet action up again when pressed', (t) => {
  const row = src.slice(src.indexOf('const GroupRow = memo('), src.indexOf('\n})\n', src.indexOf('const GroupRow = memo(')))
  t.ok(row.includes('calls.actionsOf(row).find((a) => a.label === action.label)'))
  t.ok(row.includes('actions={actions}'))
  t.ok(row.includes('} = calls'), 'handlers come from the live calls')
})

const OPEN = src.indexOf('  if (!open) {')
const HOOK_NAMES = new Set()
for (const m of src.slice(0, OPEN).matchAll(/\n {2}const (\w+|\{[^}]*\}) = use(?:Ref|Memo|Callback)\(/g)) {
  for (const name of m[1].replace(/[{}]/g, '').split(',')) HOOK_NAMES.add(name.trim().split(':').pop().trim())
}
const STATE_NAMES = new Set([...src.slice(0, OPEN).matchAll(/\n {2}const \[(\w+), set\w+\] = useState\(/g)].map((m) => m[1]))
const MODULE_NAMES = new Set([...src.matchAll(/\n(?:export )?(?:const|function) (\w+)/g)].map((m) => m[1]))
const IMPORTED = new Set([...src.matchAll(/^import \{([^}]*)\}/gm)].flatMap((m) => m[1].split(',').map((n) => n.trim())))

test('every GroupChatList prop keeps its identity across a keystroke', (t) => {
  const start = src.indexOf('<GroupChatList')
  t.ok(start !== -1, 'the chat list is the memoized GroupChatList')
  t.ok(src.includes('const GroupChatList = memo(RefreshableList)'))
  const tag = src.slice(start, src.indexOf('/>', start))
  const props = tag.split('\n').slice(1).map((l) => l.trim()).filter((l) => l && !l.startsWith('//'))
  t.ok(props.length >= 20, 'every prop read')
  const extraRef = (src.match(/\n {2}const extra = (\w+)\.current\n/) || [])[1]
  const stable = (name) => MODULE_NAMES.has(name) || IMPORTED.has(name) || HOOK_NAMES.has(name) || STATE_NAMES.has(name) || name === 'styles.thread' || (name === 'extra' && HOOK_NAMES.has(extraRef))
  for (const prop of props) {
    const m = prop.match(/^(\w+)(?:=(?:'[^']*'|\{(.*)\}))?$/)
    t.ok(m, 'plain prop: ' + prop)
    if (!m || m[2] === undefined) continue
    const value = m[2]
    t.absent(/=>|</.test(value), m[1] + ' is no inline function or element')
    const ternary = value.match(/^\w+ \? ([\w.]+) : ([\w.]+)$/)
    const names = ternary ? [ternary[1], ternary[2]] : [value]
    for (const name of names) t.ok(stable(name), m[1] + ': ' + name + ' is stable')
  }
})

test('extraData changes with everything a chat row reads from the screen', (t) => {
  const deps = (src.match(/const extraDeps = \[([^\]]*)\]/) || ['', ''])[1].split(',').map((n) => n.trim())
  t.ok(src.includes('if (!sameDeps(extraMemo.current, extraDeps)) extraMemo.current = { deps: extraDeps }'))
  t.ok(deps.includes('viewKey'), 'the derived row views are in')
  const start = src.indexOf('  renderRef.current = ({ item: row }) => {')
  const body = src.slice(start + '  renderRef.current'.length, src.indexOf('\n  }\n', start))
  const read = new Set(body
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'[^']*'/g, '')
    .replace(/\.\w+/g, '')
    .replace(/\b\w+=/g, '')
    .match(/\b[A-Za-z_]\w*\b/g))
  const local = new Set(['item', 'row', 'info', 'view', 'rowViews', 'const', 'return', 'null', 'undefined', 'true', 'false'])
  const screen = [...read].filter((name) => !local.has(name) && !MODULE_NAMES.has(name) && !IMPORTED.has(name))
  t.ok(screen.length >= 10, 'the body was parsed: ' + screen.join(' '))
  for (const name of screen) t.ok(deps.includes(name), name + ' is in extraDeps')
})
