'use strict'

// The Espiadinha opens from its stored first page ('espiadinha' snapshot,
// src/peekSnapshot.js) and holds a live page behind 'ver novidades'.
// Espiadinha.js loads react-native, so the wiring is checked on its text;
// the save pipeline runs here on the pure modules.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const SRC = path.join(__dirname, '..', 'src')
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8')

function withoutComments (src) {
  return src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')
}

const PEEK = withoutComments(read('screens/Espiadinha.js'))

// The text from `start` to the next `end` after it.
function section (src, start, end) {
  const a = src.indexOf(start)
  if (a < 0) return ''
  const b = src.indexOf(end, a + start.length)
  return b < 0 ? src.slice(a) : src.slice(a, b)
}

const OWN = 'aa'.repeat(32)
const STRANGER = 'cc'.repeat(32)
const BLOCKED = 'dd'.repeat(32)
const FOLLOWED = 'bb'.repeat(32)
const ASSOC = 'ee'.repeat(32)
const ORIGIN = 'https://bora.varanda.app'
const ME = Object.freeze({ kind: 'me' })
const at = (n) => new Date(Date.UTC(2026, 10, 1, 0, 0, n)).toISOString()
const item = (author, seq, extra = {}) => ({ kind: 'post', author, name: null, username: null, seq, at: at(seq), text: 't' + seq, replyTo: null, quote: null, media: null, preview: null, avatar: null, round: 0, ...extra })

test('the stored page is read and written only with a member binding', (t) => {
  t.ok(PEEK.includes('const binding = memberSnapshotBinding({ node, acting, pageKey })'), 'the binding is the group snapshots\' one (null for a page actor, a locked session and the Vitrine)')
  const init = section(PEEK, 'const [state, setState] = useState(() => {', 'const { items: allItems')
  t.ok(init.includes('if (binding === null) return base'), 'no binding reads nothing')
  t.ok(init.includes("loadScreenSnapshot('espiadinha', binding)"), 'the snapshot is read for that binding')
  t.ok(init.includes('seeded: true') && init.includes('unconfirmed: new Set(rows.map(peekKey))'), 'every stored row starts unconfirmed')
  t.absent(/loadedAt: (?!null)/.test(init), 'loadedAt stays null, so the warm and first read still run')
  const flush = section(PEEK, 'const flushSave = useCallback(', 'const armSave = useCallback(')
  t.ok(flush.includes('sameSnapshotBinding(armed.binding, bindingRef.current)'), 'the write needs the identity read before the request')
  const arm = section(PEEK, 'const armSave = useCallback(', 'const resave = useCallback(')
  t.ok(arm.includes('if (b === null || cacheGeneration() !== gen) return'), 'no binding or a purge since the request arms nothing')
})

test('the web photo store follows the binding and the start keeps only the stored rows\' photos', (t) => {
  const effect = section(PEEK, 'keptStore.bindPeek(', '}, [bindingKey, commit, cancelSave])')
  t.ok(effect.includes('b === null ? null : { origin: b.origin, association: b.association, owner: b.owner }'), 'bindPeek gets the identity or null')
  t.ok(PEEK.includes('}, [bindingKey, commit, cancelSave])'), 'keyed on the binding')
  t.ok(effect.includes('retainKept(PEEK_KINDS, entries)'), 'the start retains')
  t.ok(effect.includes('retainRef.current = null'), 'once')
  t.ok(effect.includes('if (lastLiveRef.current !== null && !sameSnapshotBinding(lastLiveRef.current.binding, b)) lastLiveRef.current = null'), 'another identity never re-saves the last page')
  t.ok(PEEK.includes("const PEEK_KINDS = ['peekAvatars', 'peekPosts']"))
  t.ok(PEEK.includes("import { retainKept } from '../media/keptLoad'"), 'the keptLoad retain')
  t.absent(/keptStore\.retainKept/.test(PEEK), 'never the store\'s own retain')
  const init = section(PEEK, 'const [state, setState] = useState(() => {', 'const { items: allItems')
  t.ok(/if \(snapshot === null \|\| snapshot\.body\.rows\.length === 0\) \{\s*retainRef\.current = \[\]/.test(init), 'nothing stored: no peek photo stays')
  t.ok(init.includes('retainRef.current = peekKeptEntries(rows)'), 'stored rows: only their photos stay')
  t.ok(init.indexOf('if (binding === null) return base') < init.indexOf('retainRef.current'), 'only with a binding')
})

test('stored rows pass the block gate at render, not once', (t) => {
  const gate = section(PEEK, 'const items = useMemo(() => {', 'const notice = peekNotice(')
  t.ok(gate.includes('cachedRowsShown(cached, { loadState: blockLoad, blocked: blockKeys, muted: muteKeys, owner, authorsOf: peekRowAuthors })'), 'the fail-closed gate with every author a row names')
  t.ok(gate.includes('}, [allItems, unconfirmed, blockLoad, blockKeys, muteKeys, owner])'), 'recomputed when block.list answers or a block arrives later')
  t.ok(gate.includes('withoutFollowed('), 'then the follows made here')
  t.ok(PEEK.includes('const shownItems = notice === null ? items : []'), 'the list draws the gated rows')
  t.ok(PEEK.includes('} else if (loadedAt === null) {\n    empty = <View>{[0, 1, 2].map(row => <SkeletonRow key={row} />)}</View>'), 'the skeleton stays for an empty draw')
})

test('a stored row offers no action until a live page confirms it', (t) => {
  t.ok(PEEK.includes('const cachedRowProps = (args) => ({ ...socialRowProps({ ...args, h: {} }), onLike: undefined, onRepost: undefined, onNotice: undefined, onReport: undefined, seq: undefined, link: null })'), 'a cached row offers no save, share or other action')
  const render = section(PEEK, 'renderRef.current = ({ item }) => {', 'const offered =')
  t.ok(render.includes('if (isCached(item)) return <PostRow {...cachedRowProps('), 'a post row')
  t.ok(render.includes('if (cached) return <PostRow {...cachedRowProps('), 'a repost row')
  t.ok(render.includes('const followReposter = !cached && canFollow('), 'no seguir on a stored repost')
})

test('the generation and the binding are read in the tick of the request, and a page is stored only once shown', (t) => {
  const send = section(PEEK, 'const peek = useCallback(async (params, options, stamp) => {', '}, [request])')
  const gen = send.indexOf('stamp.gen = cacheGeneration()')
  const bind = send.indexOf('stamp.binding = bindingRef.current')
  const request = send.indexOf("request('peek.read'")
  t.ok(gen > 0 && bind > 0 && request > 0, 'all three present')
  t.ok(gen < request && bind < request, 'both before peek.read is sent')
  const load = section(PEEK, 'const loadFirst = useCallback(', 'const loadMore = useCallback(')
  t.ok(load.includes('const stamp = { gen: null, binding: null }'))
  t.ok(load.includes('undefined, stamp)'), 'the first page read passes it')
  const hidden = section(load, 'if (quiet && !activeRef.current) {', 'return\n')
  t.ok(/at: Date\.now\(\),\s*stamp\s*\}/.test(hidden), 'a hidden warm page keeps its stamp')
  t.absent(hidden.includes('armSave') || hidden.includes('noteShown'), 'and is never stored by itself')
  t.ok(load.includes('noteShown(stamp, rows, pageMeta)'), 'a visible page is stored')
  const show = section(PEEK, 'const held = heldRef.current\n    if (held !== null && stateRef.current.loadedAt === null) {', 'const current = stateRef.current')
  t.ok(show.includes('noteShown(held.stamp, rows, held.meta)'), 'a warm page is stored when first shown')
  const note = section(PEEK, 'const noteShown = useCallback(', '}, [armSave])')
  t.ok(note.includes('if (stamp === null || stamp.binding === null) return'))
  t.ok(note.includes('lastLiveRef.current = { rows, meta, binding: stamp.binding }'))
  t.ok(note.includes('armSave(stamp.gen, stamp.binding, rows, meta)'))
  const resave = section(PEEK, 'const resave = useCallback(', '}, [armSave])')
  t.ok(resave.includes('sameSnapshotBinding(last.binding, bindingRef.current)'), 'a re-save needs the same identity')
})

test('the save waits for block.list, stores no cursor and retains the saved photos', (t) => {
  const flush = section(PEEK, 'const flushSave = useCallback(', 'const armSave = useCallback(')
  t.ok(flush.includes("if (b.loadState !== 'ok') {"), 'not before block.list answered')
  t.ok(flush.includes('withoutFollowed(withoutBlockedRows(armed.rows, b.keys, peekRowAuthors), followedHereRef.current).slice(0, SAVE_ROWS_MAX)'))
  t.ok(flush.includes("buildScreenSnapshot('espiadinha', { ...armed.binding, rows, meta: armed.meta, blocked: b.keys, followed: [...followedHereRef.current.keys()] })"), 'rows and meta only: no next')
  t.absent(/next/.test(flush), 'no cursor reaches the save')
  t.ok(flush.includes("saveScreenSnapshot('espiadinha', snapshot, armed.gen)"))
  t.ok(flush.includes('retainKept(PEEK_KINDS, peekRetainEntries({ saved: snapshot.body.rows,'), 'the peek photos follow the saved rows')
  t.ok(PEEK.includes('const SAVE_DELAY_MS = 2000'))
  t.ok(PEEK.includes('useEffect(() => cancelSave, [cancelSave])'), 'unmount cancels the debounce')
  t.ok(/dropFollowed = \(author\) => \{[^}]*\}\)\s*resave\(\)/.test(PEEK), 'a follow made here re-saves')
})

test('the save pipeline drops blocked and followed authors and keeps no cursor', async (t) => {
  const { buildScreenSnapshot } = await import('../src/screenSnapshot.js')
  const { withoutBlockedRows } = await import('../src/cachedRows.js')
  const { peekRowAuthors, withoutFollowed } = await import('../src/peek.js')
  const rows = [item(STRANGER, 3), item(STRANGER, 2, { quote: { author: BLOCKED, seq: 1 } }), item(FOLLOWED, 4)]
  const blocked = new Set([BLOCKED])
  const followed = new Map([[FOLLOWED, 1]])
  const kept = withoutFollowed(withoutBlockedRows(rows, blocked, peekRowAuthors), followed).slice(0, 30)
  const binding = { origin: ORIGIN, association: ASSOC, owner: OWN, acting: ME }
  const meta = { diaries: 3, skipped: 0, incomplete: false }
  const snap = buildScreenSnapshot('espiadinha', { ...binding, rows: kept, meta, blocked, followed: [...followed.keys()] })
  t.ok(snap)
  t.alike(snap.body.rows.map((r) => r.seq), [3])
  t.alike(Object.keys(snap.body), ['rows', 'meta'])
  t.is(buildScreenSnapshot('espiadinha', { ...binding, rows: kept, meta, followed: [] }), null, 'without the block list nothing is built')
  t.is(buildScreenSnapshot('espiadinha', { ...binding, acting: { kind: 'page', key: 'ff'.repeat(32) }, rows: kept, meta, blocked, followed: [] }), null, 'never as a page actor')
})

test('a live page over stored rows is held, then swapped whole or appended at the end', (t) => {
  const hold = section(PEEK, 'const holdLive = useCallback(', '}, [commit, unfollowed, replaceLive])')
  t.ok(hold.includes("holdLivePage({ items: cur.items, unconfirmed: cur.unconfirmed, rows, blocksOk: b.loadState === 'ok' })"))
  t.ok(hold.includes('if (hold === null) return replaceLive(rows, next, atEnd, meta, at)'), 'before block.list answered the live page replaces')
  t.ok(hold.includes('liveHeldRef.current = { rows, next, atEnd, meta }'))
  t.ok(hold.includes('pill: hold.fresh') && hold.includes('next: null') && hold.includes('meta,'), 'the pill, no cursor of the stored rows, the live meta')
  const load = section(PEEK, 'const loadFirst = useCallback(', 'const loadMore = useCallback(')
  t.ok(load.includes('const place = stateRef.current.seeded ? holdLive : replaceLive'), 'the first live page over stored rows does not replace them')
  const show = section(PEEK, 'const held = heldRef.current\n    if (held !== null && stateRef.current.loadedAt === null) {', 'const current = stateRef.current')
  t.ok(show.includes('const place = stateRef.current.seeded ? holdLive : replaceLive'), 'a held warm page over stored rows is held too')
  const take = section(PEEK, 'const takeHeld = () => {', '\n  }\n')
  t.ok(take.includes('const taken = takePeekPage(rows)'), 'the pill swaps the page in whole')
  t.ok(take.includes('listRef.current.scrollToOffset({ offset: 0, animated: true })'), 'and goes to the top')
  t.ok(PEEK.includes("newItems={{ label: 'ver novidades', visible: pill && notice === null && items.length > 0, onPress: takeHeld }}"))
  t.ok(PEEK.includes('if (takesHeldPage({ held: liveHeldRef.current !== null, drawn: drawnCount })) takeHeldRef.current()'), 'an empty draw takes the held page')
  const more = section(PEEK, 'const loadMore = useCallback(', '}, [active, hosted, peek, commit, ingest, unfollowed])')
  t.is((more.match(/appendPeekPage\(\{ items: (current|stateRef\.current)\.items, unconfirmed: (current|stateRef\.current)\.unconfirmed, rows \}\)/g) || []).length, 2, 'both append paths confirm stored rows a page returns')
  t.ok(more.includes('next: held.next, atEnd: held.atEnd, expired: false, meta: held.meta, pill: false'), 'the end of the stored rows adopts the held cursor')
  t.ok(more.indexOf('const held = liveHeldRef.current') < more.indexOf('if (current.atEnd || current.expired || current.next === null) return'), 'before the cursor guard')
})

test('only the Espiadinha passes persist \'peek\', and only for its first page\'s own photos', (t) => {
  const arua = withoutComments(read('screens/ARua.js'))
  t.ok(arua.includes('fold = null, strangerPersist = false })'), 'off by default')
  t.ok(arua.includes('persistMedia: persist === true ? true : social.persistOf(post.author) || strangerPersist'))
  t.ok(arua.includes('persist: social.persistOf(post.quote.author),'), 'a quote is never kept as peek')
  t.ok(arua.includes('quotePersist: quoteRef !== null ? social.persistOf(post.quote.author) : null'))
  t.ok(PEEK.includes("const peekPersist = (item) => binding !== null && firstKeys !== null && firstKeys.has(peekKey(item)) ? 'peek' : false"), 'only first-page rows with a binding')
  t.is((PEEK.match(/strangerPersist: peekPersist\(item\)/g) || []).length, 2, 'post rows pass it')
  const render = section(PEEK, "if (item.kind === 'repost') {", 'if (isCached(item))')
  t.absent(render.includes('strangerPersist'), 'a repost\'s original is never kept as peek')
  const more = section(PEEK, 'const loadMore = useCallback(', '}, [active, hosted, peek, commit, ingest, unfollowed])')
  t.absent(more.includes('firstKeys'), 'rows loaded by scrolling are not first-page rows')
  const screens = fs.readdirSync(path.join(SRC, 'screens')).filter((f) => f.endsWith('.js') && f !== 'Espiadinha.js' && f !== 'ARua.js')
  for (const f of screens) {
    const src = withoutComments(read('screens/' + f))
    t.absent(src.includes('strangerPersist'), f + ' passes no stranger persist')
  }
  t.absent(/strangerPersist[^\n]*'peek'/.test(arua), 'A Rua never passes peek')
})

test('stored rows never feed originals, and a save keeps the photos on screen', (t) => {
  const hold = section(PEEK, 'const holdLive = useCallback(', '}, [commit, unfollowed, replaceLive])')
  t.ok(hold.includes('return pageNeeds(withoutBlockedRows(kept, b.keys, peekRowAuthors), hold.unconfirmed)'), 'unconfirmed rows stay out of local')
  const flush = section(PEEK, 'const flushSave = useCallback(', '}, [])')
  t.ok(flush.includes('peekRetainEntries({ saved: snapshot.body.rows, drawn: withoutBlockedRows(cur.items, b.keys, peekRowAuthors), firstKeys: cur.firstKeys })'), 'retain covers the drawn first-page rows')
  t.absent(flush.includes('peekKeptEntries(snapshot.body.rows))'), 'never the saved rows alone')
})
