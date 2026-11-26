'use strict'

// Grupo opens from its stored tail ('grupoMensagens', src/privateSnapshot.js)
// while group.read answers. Grupo.js loads react-native, so the wiring is
// checked on its text; its three pure helpers are lifted from that text and
// run here with the save pipeline on the pure modules.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const SRC_TEXT = fs.readFileSync(path.join(__dirname, '..', 'src', 'screens', 'Grupo.js'), 'utf8')

function withoutComments (src) {
  return src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')
}

const GRUPO = withoutComments(SRC_TEXT)

// The text from `start` to the next `end` after it.
function section (src, start, end) {
  const a = src.indexOf(start)
  if (a < 0) return ''
  const b = src.indexOf(end, a + start.length)
  return b < 0 ? src.slice(a) : src.slice(a, b)
}

// A top-level function of Grupo.js, evaluated on its own (it uses no import).
function lift (name) {
  const body = section(SRC_TEXT, 'function ' + name + ' (', '\n}\n')
  if (body === '') throw new Error('missing ' + name)
  return new Function(body + '\n}\nreturn ' + name)() // eslint-disable-line no-new-func
}

const groupCacheItem = lift('groupCacheItem')
const seededItem = lift('seededItem')
const seededShown = lift('seededShown')
const CACHE_ITEMS_MAX = Number(/const CACHE_ITEMS_MAX = (\d+)/.exec(GRUPO)[1])

const loadRules = () => import('../src/screenSnapshot.js')
const loadPrivate = () => import('../src/privateSnapshot.js')
const loadGroups = () => import('../src/groups.js')

const OWN = 'aa'.repeat(32)
const MEMBER = 'bb'.repeat(32)
const BLOCKED = 'cc'.repeat(32)
const ASSOC = 'ee'.repeat(32)
const G1 = '33'.repeat(32)
const WRITER = '77'.repeat(32)
const BLOCKED_WRITER = '88'.repeat(32)
const ORIGIN = 'https://bora.varanda.app'
const ME = Object.freeze({ kind: 'me' })
const NOW = Date.now()
const at = (n) => new Date(Date.UTC(2026, 10, 1, 0, 0, n)).toISOString()

const privateItem = { core: '99'.repeat(32), mime: 'application/octet-stream', start: 1, blocks: 1, bytes: 32768, sha256: '78'.repeat(32), key: '34'.repeat(32), nonce: '56'.repeat(24), plainMime: 'image/png', plainSha256: '9a'.repeat(32), w: 640, h: 480, ms: 0 }
const publicVoice = { core: '99'.repeat(32), mime: 'audio/mp4', start: 1, blocks: 1, bytes: 20000, sha256: '78'.repeat(32), width: 0, height: 0, ms: 4000 }
const sealedCard = { url: 'https://exemplo.com.br/a', host: 'exemplo.com.br', title: 'Título', desc: 'desc', image: privateItem }
// A live group.read item, with what the codec does not keep (topic marks).
const liveItem = (seq, extra = {}) => ({ writer: WRITER, diary: MEMBER, seq, at: at(seq), text: 'grupo ' + seq, replyTo: null, fwd: 0, media: null, card: null, hidden: false, name: 'Bia', username: 'bia', topic: false, ...extra })

function hasSecret (v) {
  if (v === null || typeof v !== 'object') return false
  if (Array.isArray(v)) return v.some(hasSecret)
  return Object.keys(v).some((k) => k === 'key' || k === 'nonce' || hasSecret(v[k]))
}

test('the stored tail is read only with a member binding, as one page of pending media', async (t) => {
  t.ok(GRUPO.includes('const binding = memberSnapshotBinding({ node, acting, pageKey: pageKeyNow })'), 'null as a page, locked or signed out')
  const init = section(GRUPO, 'const [store, setStore] = useState(() => {', '\n  })\n')
  t.ok(init.includes('if (binding === null) return EMPTY_PAGES'), 'no binding reads nothing')
  t.ok(init.includes("loadScreenSnapshot('grupoMensagens', binding)"))
  t.ok(init.includes('Object.prototype.hasOwnProperty.call(groups, group)'), 'only this group\'s own entry')
  t.ok(init.includes('applyPage(EMPTY_PAGES, { items: entry.items.map(seededItem) })'), 'one page, every media stub pending')
  t.ok(GRUPO.includes('const liveRef = useRef(false)'))

  const stub = { mime: 'image/png', w: 640, h: 480, ms: 0 }
  const seeded = seededItem({ ...liveItem(1), media: [stub, { mime: 'audio/mp4', w: 0, h: 0, ms: 4000 }] })
  t.alike(seeded.media, [{ ...stub, pending: true }, { mime: 'audio/mp4', w: 0, h: 0, ms: 4000, pending: true }], 'ChatMedia shows Carregando mídia')
  const plain = liveItem(2)
  t.is(seededItem(plain), plain, 'a row without media is kept as it is')

  const { applyPage, itemsOf } = await loadGroups()
  const store = applyPage(applyPage({ version: '', pages: [], next: null, stale: false }, { items: [] }), { items: [seeded] })
  t.is(store.next, null, 'no cursor: older pages only after a live read')
  t.is(itemsOf(store)[0].media[0].pending, true)
})

test('the gate: stored rows only once block.list answered, never a blocked diary', (t) => {
  const items = [liveItem(3), liveItem(2, { diary: BLOCKED, writer: BLOCKED_WRITER }), liveItem(1, { diary: OWN })]
  const blocked = new Set([BLOCKED])
  t.alike(seededShown(items, 'pending', blocked), [], 'pending: the skeleton shows')
  t.alike(seededShown(items, 'failed', blocked), [], 'failed: fail closed')
  t.alike(seededShown(items, 'ok', blocked).map((i) => i.seq), [3, 1], 'ok: the blocked member goes by diary')
  t.alike(seededShown(items, 'ok', new Set([BLOCKED_WRITER])).map((i) => i.seq), [3, 2, 1], 'a writer key is not a block')
  t.alike(seededShown(items, 'ok', null), [], 'no list object: nothing')

  const gate = section(GRUPO, 'const live = liveRef.current', 'const seedShown')
  t.ok(gate.includes('const rawItems = useMemo(() => (live ? itemsOf(store) : seededShown(itemsOf(store), blockLoad, blockKeys)), [store, live, blockLoad, blockKeys])'), 'at render, on every block change; nothing filtered after a live read')
  t.ok(GRUPO.includes('const seedShown = !live && rawItems.length > 0'))
  t.ok(GRUPO.includes('const listed = reader || seedShown'))
  t.ok(GRUPO.includes('data={listed ? rows : NO_ROWS}'), 'the list draws the gated rows before group.info answers')
  t.ok(GRUPO.includes('for (const row of listed ? rows : NO_ROWS) {'), 'the row views follow the same rows')
  t.ok(GRUPO.includes('else if (loadedAt === null) empty = <Skeleton />'), 'the skeleton stays for an empty draw')
})

test('stored rows read for another identity or before a lock leave on a binding change', (t) => {
  t.ok(SRC_TEXT.includes('const seedBinding = useRef(binding)') && SRC_TEXT.includes('const bindingKey = bindingKeyOf(binding)'), 'the binding of the stored tail is kept')
  const at = SRC_TEXT.indexOf('if (seedBinding.current === null || sameSnapshotBinding(seedBinding.current, binding)) return')
  t.ok(at > 0, 'compared on every binding change')
  const body = SRC_TEXT.slice(at, SRC_TEXT.indexOf('}, [bindingKey])', at))
  t.ok(body.includes('if (liveRef.current) return') && body.includes('setStore(EMPTY_PAGES)'), 'unless a live read replaced them, the stored rows leave')
})

test('a cached paint never sends group.seen', (t) => {
  const mark = section(GRUPO, 'const markSeen = useCallback(async () => {', '}, [request, group])')
  t.ok(/^const markSeen = useCallback\(async \(\) => \{\s*if \(!liveRef\.current\) return\s*const upTo = cutRef\.current/.test(mark), 'markSeen returns at once before a live read')
  t.ok(mark.indexOf('if (!liveRef.current) return') < mark.indexOf("request('group.seen'"))
  t.ok(GRUPO.includes('if (!placed) cutRef.current = null\n  else if (!live) cutRef.current = null\n  else if (endShown)'), 'the cut never advances from stored rows')
})

test('a live read replaces the stored tail and sets liveRef', async (t) => {
  const newest = section(GRUPO, 'const readNewest = useCallback(async () => {', 'const markSeen = useCallback(')
  t.ok(newest.indexOf('liveRef.current = true') > newest.indexOf('if (!walks.current(walk.token)) return read'), 'only after a read that commits')
  t.ok(newest.indexOf('liveRef.current = true') < newest.indexOf('setStore((prev) => mergeNewest(prev, read))'), 'in the same tick as the store')
  const commit = section(GRUPO, 'const commitRead = useCallback((read, before) => {', '}, [noteRead])')
  t.ok(commit.includes('liveRef.current = true'))
  const change = section(GRUPO, 'const liveGroup = useRef(group)', '}, [group, cancelSave])')
  t.ok(change.includes('liveRef.current = false') && change.includes('cancelSave()'), 'another group starts over and cancels the save')

  const { applyPage, mergeNewest, itemsOf, EMPTY_PAGES } = await loadGroups()
  const seeded = applyPage(EMPTY_PAGES, { items: [liveItem(5), liveItem(4), liveItem(3)].map((i) => seededItem({ ...i, media: [{ mime: 'image/png', w: 1, h: 1 }] })) })
  const read = { items: [liveItem(6), liveItem(5)], next: { at: at(5), writer: WRITER, seq: 5 } }
  const merged = mergeNewest(seeded, read)
  t.alike(itemsOf(merged).map((i) => i.seq), [6, 5], 'no stored row survives the first live read')
  t.absent(itemsOf(merged).some((i) => Array.isArray(i.media)), 'no pending stub stays')
})

test('a stored row offers no action until liveRef is true', (t) => {
  const actions = section(GRUPO, 'const actionsOf = (row) => {', 'const mine = row.mine === true')
  t.ok(actions.includes('if (!live) return []'), 'no reply, forward, hide, report')
  t.ok(GRUPO.includes('reactionViewRef.current = { disabled: reactionsDisabled || !live,'), 'toggle and picker refuse a stored row')
  t.ok(GRUPO.includes('reactionsDisabled={reactionsDisabled || !live}'), 'the chips and quick reactions are disabled on it')
  t.ok(/const extraDeps = \[[^\]]*\blive\]/.test(GRUPO), 'the rows redraw when the live read lands')
  const hide = section(GRUPO, 'const hide = async (row, on) => {', 'const vis')
  t.ok(hide.includes('if (!liveRef.current) return'), 'hide sends nothing')
})

test('the stored row keeps no media key or nonce, and the card has no image', async (t) => {
  const item = liveItem(1, { media: [privateItem], card: sealedCard, replyTo: { writer: WRITER, seq: 0, extra: 1 }, reactions: [{ emoji: '👍', count: 2, mine: false, who: [] }] })
  const out = groupCacheItem(item)
  t.absent(hasSecret(out), 'no key or nonce anywhere in the builder input')
  t.alike(out.media, [{ mime: 'image/png', w: 640, h: 480, ms: 0 }], 'a private item as its plain stub')
  t.is(out.card.image, null)
  t.alike(out.replyTo, { writer: WRITER, seq: 0 })
  t.alike(out.reactions, [{ emoji: '👍', count: 2, mine: false }])
  t.absent('topic' in out, 'marks are not stored')
  t.alike(groupCacheItem(liveItem(2, { media: [publicVoice] })).media, [{ mime: 'audio/mp4', w: 0, h: 0, ms: 4000 }], 'a public voice note')
  const bare = groupCacheItem({ writer: WRITER, diary: MEMBER, seq: 3, at: at(3), text: 't', replyTo: null, media: null, card: null })
  t.is(bare.fwd, 0)
  t.is(bare.hidden, false)
  t.is(bare.name, null)
  t.is(bare.username, null)

  const p = await loadPrivate()
  const s = await loadRules()
  const body = p.putGroup(null, G1, [out], NOW)
  const snap = s.buildScreenSnapshot('grupoMensagens', { origin: ORIGIN, association: ASSOC, owner: OWN, acting: ME, previous: body, blocked: [] })
  t.ok(snap, 'the codec accepts it')
  t.absent(hasSecret(snap))
  t.ok(s.parseScreenSnapshot(JSON.stringify(snap), 'grupoMensagens', { origin: ORIGIN, association: ASSOC, owner: OWN, acting: ME }))
})

test('the save stores the newest 26 of the answer, even after two older pages', async (t) => {
  const { applyPage, itemsOf, EMPTY_PAGES } = await loadGroups()
  const p = await loadPrivate()
  const s = await loadRules()
  const page = (from) => Array.from({ length: 26 }, (_, i) => liveItem(from - i))
  const newest = { items: page(100), next: { at: at(75), writer: WRITER, seq: 75 } }
  let store = applyPage(EMPTY_PAGES, newest, null)
  store = applyPage(store, { items: page(74), next: { at: at(49), writer: WRITER, seq: 49 } }, newest.next)
  store = applyPage(store, { items: page(48), next: null }, { at: at(49), writer: WRITER, seq: 49 })
  t.is(itemsOf(store).length, 78, 'history is loaded')
  const read = { items: page(101) }
  const saved = read.items.slice(0, CACHE_ITEMS_MAX)
  const body = p.putGroup(null, G1, saved.map(groupCacheItem), NOW)
  const snap = s.buildScreenSnapshot('grupoMensagens', { origin: ORIGIN, association: ASSOC, owner: OWN, acting: ME, previous: body, blocked: [BLOCKED] })
  t.alike(snap.body.groups[G1].items.map((i) => i.seq), Array.from({ length: 26 }, (_, i) => 101 - i), 'the newest 26')

  const newestFn = section(GRUPO, 'const readNewest = useCallback(async () => {', 'const markSeen = useCallback(')
  t.ok(newestFn.includes('armSave(stamp, read)'), 'the answer itself')
  t.ok(section(GRUPO, 'const armSave = useCallback(', '}, [group, cancelSave, flushSave])').includes('newest: read.items.slice(0, CACHE_ITEMS_MAX)'), 'a slice of the answer')
  t.absent(/armSave\([^)]*itemsOf\(/.test(GRUPO), 'never a slice of the loaded store')
  t.is(CACHE_ITEMS_MAX, 26)
})

test('the save is blocked-filtered, generation- and binding-bound, debounced and cancelled', async (t) => {
  const newestFn = section(GRUPO, 'const readNewest = useCallback(async () => {', 'const markSeen = useCallback(')
  const stampAt = newestFn.indexOf('const stamp = saveStamp()')
  const ask = newestFn.indexOf('read = await readGroup()')
  t.ok(stampAt > 0 && stampAt < ask, 'generation and binding captured before the request')
  const stamp = section(GRUPO, 'const saveStamp = useCallback(', '}), [])')
  t.ok(stamp.includes('gen: cacheGeneration()'))
  t.ok(stamp.includes('binding: memberSnapshotBinding({ node: nodeRef.current, acting: actingRef.current, pageKey: pageKeyRef.current })'))

  const arm = section(GRUPO, 'const armSave = useCallback(', '}, [group, cancelSave, flushSave])')
  t.ok(arm.includes('if (stamp.binding === null || cacheGeneration() !== stamp.gen || !Array.isArray(read.items)) return'), 'a purge since the request arms nothing')
  t.ok(arm.includes('CACHE_SAVE_MS'))
  t.ok(/const CACHE_SAVE_MS = 2000\n/.test(GRUPO), 'a 2 s debounce')

  const flush = section(GRUPO, 'const flushSave = useCallback(', 'const armSave = useCallback(')
  t.ok(flush.includes("if (b.loadState !== 'ok') {"), 'waits for block.list')
  t.ok(flush.includes('const now = memberSnapshotBinding({ node: nodeRef.current, acting: actingRef.current, pageKey: pageKeyRef.current })'), 'the identity is read again at write time')
  t.ok(flush.includes('if (cacheGeneration() !== armed.gen || !sameSnapshotBinding(armed.binding, now)) return'))
  t.ok(flush.includes('putGroup(current === null ? null : current.body, armed.group, armed.newest.map(groupCacheItem), Date.now())'))
  t.ok(flush.includes("buildScreenSnapshot('grupoMensagens', { ...armed.binding, previous: body, blocked: b.keys })"), 'blocked diaries are left out')
  t.ok(flush.includes("saveScreenSnapshot('grupoMensagens', snapshot, armed.gen)"))
  t.absent(/flushSave\(\)[^\n]*catch|setTimeout\(flushSave/.test(flush), 'a refused save is not retried')
  t.ok(GRUPO.includes('useEffect(() => () => cancelSave(), [cancelSave])'), 'unmount cancels')

  const s = await loadRules()
  const p = await loadPrivate()
  const body = p.putGroup(null, G1, [liveItem(2, { diary: BLOCKED, writer: BLOCKED_WRITER }), liveItem(1)].map(groupCacheItem), NOW)
  const snap = s.buildScreenSnapshot('grupoMensagens', { origin: ORIGIN, association: ASSOC, owner: OWN, acting: ME, previous: body, blocked: new Set([BLOCKED]) })
  t.alike(snap.body.groups[G1].items.map((i) => i.seq), [1], 'nothing of a blocked member is stored')
  t.is(s.buildScreenSnapshot('grupoMensagens', { origin: ORIGIN, association: ASSOC, owner: OWN, acting: { kind: 'page', key: 'ff'.repeat(32), name: 'Loja', username: 'loja' }, previous: body, blocked: [] }), null, 'never as a page')
})

test('leaving, a ban or a group gone removes its stored tail', async (t) => {
  const forget = section(GRUPO, 'const forgetGroup = useCallback(() => {', '}, [group, cancelSave])')
  t.ok(forget.includes('cancelSave()'), 'a pending save cannot bring it back')
  t.ok(forget.includes('if (b === null) return'))
  t.ok(forget.includes('const body = removeGroup(current.body, group)'))
  t.ok(forget.includes("if (snapshot === null || !saveScreenSnapshot('grupoMensagens', snapshot, cacheGeneration())) clearScreenSnapshot('grupoMensagens')"), 'a failed rewrite drops the kind')
  const load = section(GRUPO, '} else if (fresh) {', '\n    }\n')
  t.ok(load.includes('setStore(EMPTY_PAGES)') && load.includes('forgetGroup()'), 'only on a fresh group.info with no reading role')
  t.absent(/catch \(err\) \{[^}]*forgetGroup/.test(GRUPO), 'a failed read never removes it')

  const p = await loadPrivate()
  const s = await loadRules()
  const G2 = '44'.repeat(32)
  let body = p.putGroup(null, G1, [groupCacheItem(liveItem(1))], NOW)
  body = p.putGroup(body, G2, [groupCacheItem(liveItem(2))], NOW)
  const left = p.removeGroup(body, G1)
  const snap = s.buildScreenSnapshot('grupoMensagens', { origin: ORIGIN, association: ASSOC, owner: OWN, acting: ME, previous: left, blocked: [] })
  t.alike(Object.keys(snap.body.groups), [G2], 'only that group goes')
})
