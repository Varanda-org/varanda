'use strict'

// Rows (avatars, photos, link cards, chat media, music cards, the list's
// pull-to-refresh) must not subscribe to the whole node value: it is rebuilt
// on every sync, online and visible flag, and each flip would redraw every
// row. They read useHosted(), the node handle (memoized on hosted, request,
// media, accountOrigin and syncNow only) and the member key context. The
// handle is not an identity signal (request keeps one identity for the whole
// session): music cards and media keep identities apart through the member
// key context and their identity-keyed caches, rendered in the same commit.
// node.js loads React, so its text is checked and its pure parts are run.
const test = require('brittle')
const fs = require('fs')
const path = require('path')
const read = (file) => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')
const strip = (src) => src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')
const between = (src, from, to) => {
  const start = src.indexOf(from)
  const end = src.indexOf(to, start + from.length)
  return start >= 0 && end > start ? src.slice(start, end) : ''
}

const ROWS = ['ui/Avatar.js', 'ui/MediaView.js', 'ui/LinkCard.js', 'ui/ChatMedia.js', 'ui/MusicPlayerCard.js', 'ui/MomentReactionPreview.js', 'ui/RefreshableList.js']
const node = strip(read('node.js'))

test('no row component reads the whole node value', (t) => {
  for (const file of ROWS) {
    t.absent(/\buseNode\(/.test(strip(read(file))), file + ' does not call useNode()')
  }
})

test('each row reads only what it uses', (t) => {
  for (const file of ['ui/Avatar.js', 'ui/MediaView.js']) {
    const src = strip(read(file))
    t.ok(src.includes('const hosted = useHosted()'), file + ' reads the hosted flag')
    t.ok(src.includes('const canFetch = !keptOnly && hosted === true'), file + ' fetches only on a hosted node')
  }
  for (const file of ['ui/LinkCard.js', 'ui/ChatMedia.js', 'ui/MomentReactionPreview.js', 'ui/RefreshableList.js']) {
    t.ok(strip(read(file)).includes('useNodeHandle()'), file + ' reads the handle')
  }
  t.ok(strip(read('ui/RefreshableList.js')).includes('const syncNow = node && node.syncNow'), 'pull-to-refresh takes syncNow from the handle')
  {
    const file = 'ui/MusicPlayerCard.js'
    const src = strip(read(file))
    t.ok(src.includes('const node = useNodeHandle()'), file + ' reads the handle')
    t.ok(src.includes('const member = useMemberKey()'), file + ' reads the member key primitive')
    t.ok(src.includes('const enabled = musicOriginOf(node) !== null'), file + ' gives musicOriginOf the hosted flag it reads')
    t.ok(src.includes('const origin = node.accountOrigin || musicOriginOf(node)'), file + ' origin from the handle')
    t.ok(src.includes('const request = node.request'), file + ' request from the handle')
    t.absent(src.includes('passkey'), file + ' no longer reads the passkey object')
  }
})

test('the handle memo depends on exactly the five fields', (t) => {
  const text = between(node, 'function useHandle', '\n}\n') + '\n}'
  t.ok(text.length > 20, 'useHandle found')
  const calls = []
  const useMemo = (fn, deps) => { calls.push(deps); return fn() }
  // eslint-disable-next-line no-new-func
  const useHandle = new Function('useMemo', text + '\nreturn useHandle')(useMemo)
  const request = () => {}
  const media = { read: () => {} }
  const syncNow = () => {}
  const handle = useHandle(true, request, media, 'https://conta.test', syncNow)
  t.is(calls.length, 1)
  t.alike(calls[0], [true, request, media, 'https://conta.test', syncNow], 'deps are hosted, request, media, accountOrigin, syncNow')
  t.alike(Object.keys(handle).sort(), ['accountOrigin', 'hosted', 'media', 'request', 'syncNow'])
  t.is(handle.request, request)
  t.is(handle.media, media)
  t.is(handle.syncNow, syncNow)
  t.ok(/useMemo\(\(\) => \(\{ hosted, request, media, accountOrigin, syncNow \}\), \[hosted, request, media, accountOrigin, syncNow\]\)/.test(text), 'nothing else in the deps')
})

test('the member key is the lowercased public key, or null', (t) => {
  const text = between(node, 'export function memberKeyOf', '\n}\n').replace('export ', '') + '\n}'
  // eslint-disable-next-line no-new-func
  const memberKeyOf = new Function(text + '\nreturn memberKeyOf')()
  t.is(memberKeyOf({ status: { publicKey: 'AB'.repeat(32) } }), 'ab'.repeat(32))
  t.is(memberKeyOf({ status: { publicKey: 'cd'.repeat(32) } }), 'cd'.repeat(32))
  t.is(memberKeyOf(null), null)
  t.is(memberKeyOf({ status: null }), null)
  t.is(memberKeyOf({ status: { publicKey: 7 } }), null)
})

test('both providers supply the handle and the member key', (t) => {
  t.ok(node.includes('const NodeHandleContext = createContext(null)'))
  t.ok(node.includes('const MemberKeyContext = createContext(null)'), 'no member without a provider')
  for (const hook of ['useNodeHandle', 'useMemberKey']) t.ok(node.includes('export function ' + hook + ' ()'), hook + ' exported')
  const rows = between(node, 'function RowContexts', '\n}\n')
  t.ok(rows.includes('<NodeHandleContext.Provider value={handle}>'))
  t.absent(node.includes('OnlineContext'), 'no online context: no row reads it')
  t.ok(rows.includes('<MemberKeyContext.Provider value={memberKey}>'))

  const vitrine = between(node, 'function VitrineNodeProvider', 'function LiveNodeProvider')
  t.ok(vitrine.includes('const syncNow = useCallback(() => Promise.resolve(), [])'), 'a stable vitrine syncNow')
  t.absent(/syncNow: \(\) =>/.test(vitrine), 'no inline syncNow arrow')
  t.ok(vitrine.includes('const handle = useHandle(true, vitrineRequest, value.media, value.accountOrigin, syncNow)'))
  t.ok(vitrine.includes('<RowContexts handle={handle} memberKey={memberKeyOf(value.passkey)}>'))

  const live = node.slice(node.indexOf('function LiveNodeProvider'))
  t.ok(live.includes('const handle = useHandle(hosted, request, rowMedia, accountOrigin, syncNow)'))
  t.ok(live.includes('const memberKey = memberKeyOf(passkey)'), 'the key follows the passkey status, so an account switch reaches it')
  t.ok(live.includes('<RowContexts handle={handle} memberKey={memberKey}>'))
})

test('useNode() stays the full node value for screens', (t) => {
  t.ok(/export function useNode \(\) \{\s*return useContext\(NodeContext\)\s*\}/.test(node))
})
