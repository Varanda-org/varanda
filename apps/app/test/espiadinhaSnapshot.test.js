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
  const boot = section(PEEK, 'const [boot] = useState(() => {', 'const rawSocial = useSocial(')
  t.ok(boot.includes("const snapshot = binding !== null && hosted ? loadScreenSnapshot('espiadinha', binding) : null"), 'the snapshot is read once, for that binding')
  t.ok(init.includes('const rows = boot.snapshot.body.rows'), 'the rows come from that one read')
  t.ok(init.includes('seeded: true') && init.includes('unconfirmed: new Set(rows.map(peekKey))'), 'every stored row starts unconfirmed')
  t.absent(/loadedAt: (?!null)/.test(init), 'loadedAt stays null, so the warm and first read still run')
  const flush = section(PEEK, 'const flushSave = useCallback(', 'const armSave = useCallback(')
  t.ok(flush.includes('sameSnapshotBinding(armed.binding, bindingRef.current)'), 'the write needs the identity read before the request')
  const arm = section(PEEK, 'const armSave = useCallback(', 'const resave = useCallback(')
  t.ok(arm.includes('if (b === null) return'), 'no binding arms nothing')
  t.ok(arm.includes('armTimer(armedSave({ gen, generation: cacheGeneration(), wipe, refresh, deletions, binding: b, rows, meta }))'), 'a purge since the request arms a re-armed save at the current generation')
  t.absent(arm.includes('cacheGeneration() !== gen) return'), 'a purge during the read no longer leaves the page unsaved')
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
  t.ok(/if \(boot === null\) \{\s*retainRef\.current = \[\]/.test(init), 'nothing stored: no peek photo stays')
  t.ok(init.includes('retainRef.current = peekKeptEntries(rows, boot.snapshot.body.originals || null)'), 'stored rows: only their photos and their originals\' stay')
  t.ok(init.indexOf('if (binding === null) return base') < init.indexOf('retainRef.current'), 'only with a binding')
})

test('stored rows pass the block gate at render, not once', (t) => {
  const gate = section(PEEK, 'const items = useMemo(() => {', 'const notice = peekNotice(')
  t.ok(gate.includes('cachedRowsShown(cached, { loadState: blockLoad, blocked: blockKeys, muted: muteKeys, owner, authorsOf: storedAuthors })'), 'the fail-closed gate with every author a row and its stored originals name')
  t.ok(PEEK.includes('const storedAuthors = useMemo(() => storedRowAuthors(seedOriginals), [seedOriginals])'), 'over the seed\'s originals')
  t.ok(gate.includes('}, [allItems, unconfirmed, blockLoad, blockKeys, muteKeys, owner, storedAuthors])'), 'recomputed when block.list answers or a block arrives later')
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
  t.ok(load.includes('const stamp = { gen: null, wipe: null, refresh: null, deletions: null, binding: null }'))
  t.ok(send.indexOf('stamp.deletions = ownDeletions()') > 0 && send.indexOf('stamp.deletions = ownDeletions()') < request, 'the own deletions too')
  t.ok(send.indexOf('stamp.wipe = wipeEpoch()') > 0 && send.indexOf('stamp.wipe = wipeEpoch()') < request, 'the wipe count too')
  t.ok(load.includes('undefined, stamp)'), 'the first page read passes it')
  const hidden = section(load, 'if (quiet && !activeRef.current) {', 'return\n')
  t.ok(/at: Date\.now\(\),\s*stamp\s*\}/.test(hidden), 'a hidden warm page keeps its stamp')
  t.absent(hidden.includes('armSave') || hidden.includes('noteShown'), 'and is never stored by itself')
  t.ok(load.includes('noteShown(stamp, rows, pageMeta)'), 'a visible page is stored')
  const show = section(PEEK, 'const held = heldRef.current\n    if (held !== null && stateRef.current.loadedAt === null) {', 'const current = stateRef.current')
  t.ok(show.includes('noteShown(held.stamp, rows, held.meta)'), 'a warm page is stored when first shown')
  const note = section(PEEK, 'const noteShown = useCallback(', '}, [armSave])')
  t.ok(note.includes('if (stamp === null || stamp.binding === null) return'))
  t.ok(note.includes('lastLiveRef.current = { rows, meta, binding: stamp.binding, wipe: stamp.wipe, deletions: stamp.deletions }'))
  t.ok(note.includes('armSave(stamp.gen, stamp.binding, rows, meta, stamp.wipe, stamp.refresh, stamp.deletions)'))
  const resave = section(PEEK, 'const resave = useCallback(', '}, [armSave])')
  t.ok(resave.includes('sameSnapshotBinding(last.binding, bindingRef.current)'), 'a re-save needs the same identity')
  t.ok(resave.includes('last.wipe === wipeEpoch()'), 'and no wipe since its read')
})

test('the save waits for block.list, stores no cursor and retains the saved photos', (t) => {
  const flush = section(PEEK, 'const flushSave = useCallback(', 'const armSave = useCallback(')
  t.ok(flush.includes('if (b.live !== true) {'), 'not before this run\'s block.list answered')
  t.absent(flush.includes('b.loadState'), 'a stored block list (shown as ok) never lets a save through')
  t.ok(/const blocksLive = blocks\.live === true\s*useEffect\(\(\) => \{\s*if \(blocksLive && saveRef\.current !== null && saveRef\.current\.due\) flushSave\(\)\s*\}, \[blocksLive, flushSave\]\)/.test(PEEK), 'a held save flushes on the live answer, not on the stored list')
  t.ok(flush.includes('const rows = rowsToWrite(withoutFollowed(withoutBlockedRows(armed.rows, b.keys, peekRowAuthors), followedHereRef.current).slice(0, SAVE_ROWS_MAX), { armed, allowedKnown: !allowedAuthor(null), mayKeep: peekKeepAllowed, notDenied })'))
  t.ok(flush.includes("buildScreenSnapshot('espiadinha', { ...armed.binding, rows, originals, meta: armed.meta, blocked: b.keys, followed: [...followedHereRef.current.keys()] })"), 'rows, their originals and meta: no next')
  t.absent(/next/.test(flush), 'no cursor reaches the save')
  t.ok(flush.includes("saveScreenSnapshot('espiadinha', snapshot, armed.gen)"))
  t.ok(flush.includes('retainKept(PEEK_KINDS, peekRetainEntries({ saved: snapshot.body.rows, savedOriginals: snapshot.body.originals || null,'), 'the peek photos follow the saved rows and originals')
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
  t.ok(arua.includes("const quotePersist = quoteRef !== null ? social.persistOf(post.quote.author) || (strangerPersist === 'peek' || strangerPersist === 'copy' ? strangerPersist : false) : null"), 'a stranger quote follows the row\'s peek or copy')
  t.ok(arua.includes('persist: quotePersist,'), 'the quote carries it')
  t.ok(arua.includes('    quotePersist,\n'), 'and the row cache compares it')
  t.ok(PEEK.includes("const peekPersist = (item) => binding !== null && firstKeys !== null && firstKeys.has(peekKey(item)) ? 'peek' : false"), 'only first-page rows with a binding')
  t.is((PEEK.match(/strangerPersist: peekPersist\(item\)/g) || []).length, 4, 'post and repost rows pass it')
  const render = section(PEEK, "if (item.kind === 'repost') {", 'if (isCached(item))')
  t.is((render.match(/strangerPersist: peekPersist\(item\)/g) || []).length, 2, 'a first-page repost keeps its original\'s photos as peek, stored or live')
  const more = section(PEEK, 'const loadMore = useCallback(', '}, [active, hosted, peek, commit, ingest, unfollowed])')
  t.absent(more.includes('firstKeys'), 'rows loaded by scrolling are not first-page rows')
  const screens = fs.readdirSync(path.join(SRC, 'screens')).filter((f) => f.endsWith('.js') && f !== 'Espiadinha.js' && f !== 'ARua.js' && f !== 'Diario.js' && f !== 'Membro.js' && f !== 'Conversa.js')
  for (const f of screens) {
    const src = withoutComments(read('screens/' + f))
    t.absent(src.includes('strangerPersist'), f + ' passes no stranger persist')
  }
  t.absent(/strangerPersist\s*(?::|=(?!=))[^\n]*'peek'/.test(arua), 'A Rua never passes peek')
  const diario = withoutComments(read('screens/Diario.js'))
  t.absent(/strangerPersist\s*(?::|=(?!=))[^\n]*'peek'/.test(diario), 'the Diário never passes peek')
  const membro = withoutComments(read('screens/Membro.js'))
  t.absent(/strangerPersist\s*(?::|=(?!=))[^\n]*'peek'/.test(membro), 'Membro never passes peek')
  t.ok(withoutComments(read('screens/Conversa.js')).includes("strangerPersist === 'copy' ? 'copy' : false"), 'Conversa rows turn anything but copy into no keep')
})

test('stored rows never feed originals, and a save keeps the photos on screen', (t) => {
  const hold = section(PEEK, 'const holdLive = useCallback(', '}, [commit, unfollowed, replaceLive])')
  t.ok(hold.includes('return pageNeeds(withoutBlockedRows(kept, b.keys, peekRowAuthors), hold.unconfirmed)'), 'unconfirmed rows stay out of local')
  const flush = section(PEEK, 'const flushSave = useCallback(', '}, [])')
  t.ok(flush.includes('peekRetainEntries({ saved: snapshot.body.rows, savedOriginals: snapshot.body.originals || null, drawn: withoutBlockedRows(cur.items, b.keys, peekRowAuthors), firstKeys: cur.firstKeys, originalOf: drawnOf })'), 'retain covers the drawn first-page rows and the originals they draw')
  t.absent(flush.includes('peekKeptEntries(snapshot.body.rows))'), 'never the saved rows alone')
})

// Espiadinha.js's pure helpers, run from its text (it imports react-native);
// `deps` are the names each one reads from its imports.
function pure (name, deps = {}) {
  const start = PEEK.indexOf('export function ' + name + ' (')
  if (start < 0) throw new Error('missing ' + name)
  const body = PEEK.slice(start + 'export '.length, PEEK.indexOf('\n}\n', start) + 2)
  const names = Object.keys(deps)
  // eslint-disable-next-line no-new-func
  return new Function(...names, body + '\nreturn ' + name)(...names.map((n) => deps[n]))
}
const OTHER = '11'.repeat(32)
const PARENT = '22'.repeat(32)
const photo = { core: '12'.repeat(32), mime: 'image/jpeg', start: 1, blocks: 1, bytes: 1000, sha256: '34'.repeat(32), width: 1200, height: 900 }
const repost = (author, seq, to) => ({ kind: 'repost', author, name: null, username: null, seq, at: at(seq), to, text: null, replyTo: null, quote: null, media: null, preview: null, avatar: null, round: 1 })
const original = (author, seq, extra = {}) => ({ kind: 'post', author, name: null, username: null, seq, at: at(seq), text: 'o' + seq, replyTo: null, quote: null, media: null, preview: null, avatar: null, ...extra })
const binding = { origin: ORIGIN, association: ASSOC, owner: OWN, acting: ME }
const META = { diaries: 3, skipped: 0, incomplete: false }
const isTransient = (v) => !!v && v.transient === true

async function helpers () {
  const peek = await import('../src/peek.js')
  return {
    peek,
    storedRowAuthors: pure('storedRowAuthors', { peekRowAuthors: peek.peekRowAuthors, peekOriginalsOf: peek.peekOriginalsOf }),
    liveOriginalAt: pure('liveOriginalAt'),
    saveStep: pure('saveStep'),
    purgedRows: pure('purgedRows', { peekRowAuthors: peek.peekRowAuthors }),
    rowsToWrite: pure('rowsToWrite', { purgedRows: pure('purgedRows', { peekRowAuthors: peek.peekRowAuthors }) }),
    seedGuard: pure('seedGuard'),
    originalsMoved: pure('originalsMoved')
  }
}

test('the stored page seeds useSocial, so a stored repost and reply draw their originals and the parent\'s name', async (t) => {
  const boot = section(PEEK, 'const [boot] = useState(() => {', 'const { ingest } = social')
  t.ok(boot.includes('seed: peekSeedOf(snapshot.body)'), 'the seed is the stored body\'s')
  t.ok(boot.includes('const rawSocial = useSocial({ ownKey, onToast, seed: boot !== null ? boot.seed : null })'), 'useSocial gets it')
  t.ok(PEEK.indexOf('const [boot] = useState(') < PEEK.indexOf('const rawSocial = useSocial('), 'read before useSocial')
  const { buildScreenSnapshot } = await import('../src/screenSnapshot.js')
  const { parse, peekSeedOf } = await import('../src/peekSnapshot.js')
  const { shownOriginalOf } = await import('../src/foldRounds.js')
  const { replyMarkOf } = await import('../src/who.js')
  const post = original(OTHER, 5, { media: [photo] })
  const parent = original(PARENT, 7, { name: 'Ana' })
  const rows = [repost(STRANGER, 9, { author: OTHER, seq: 5 }), item(STRANGER, 8, { replyTo: { author: PARENT, seq: 7 } })]
  const snap = buildScreenSnapshot('espiadinha', { ...binding, rows, originals: { [OTHER + ':5']: post, [PARENT + ':7']: parent }, meta: META, blocked: new Set(), followed: [] })
  const seed = peekSeedOf(parse(snap.body))
  const stored = new Map(seed.originals)
  const shown = (ref) => shownOriginalOf(ref, { stored: stored.get(ref), isTransient, stale: new Map(), deleted: new Set(), isBlocked: () => false })
  t.is(shown(OTHER + ':5').text, 'o5', 'the repost draws its original at once')
  t.alike(shown(OTHER + ':5').media, [photo])
  t.is(replyMarkOf({ cached: undefined, parent: shown(PARENT + ':7'), pending: false }), 'Ana', 'the reply names its parent, not "…"')
  t.is(seed.counts.size, 0, 'no counts: the seeded-count set is empty and drops nothing')
})

test('a stored row whose stored original names a blocked author is not drawn; one with a missing original is', async (t) => {
  const { storedRowAuthors } = await helpers()
  const { cachedRowsShown } = await import('../src/cachedRows.js')
  const { peekRowAuthors } = await import('../src/peek.js')
  const quoted = original(OTHER, 5, { quote: { author: BLOCKED, seq: 2 } })
  const seeded = new Map([[OTHER + ':5', quoted], [BLOCKED + ':2', original(BLOCKED, 2)]])
  const viaQuote = repost(STRANGER, 9, { author: OTHER, seq: 5 })
  const missing = repost(STRANGER, 8, { author: PARENT, seq: 3 })
  const plain = item(STRANGER, 7)
  const gate = (authorsOf) => cachedRowsShown([viaQuote, missing, plain], { loadState: 'ok', blocked: new Set([BLOCKED]), muted: new Set(), owner: OWN, authorsOf }).map((r) => r.seq)
  t.alike(gate(storedRowAuthors(seeded)), [8, 7], 'the second-level blocked original hides its row; a repost with no stored original stays')
  t.alike(gate(peekRowAuthors), [9, 8, 7], 'the row\'s own refs alone would draw it')
  t.alike(gate(storedRowAuthors(null)), [9, 8, 7], 'no seed: only the row\'s refs')
  t.alike(cachedRowsShown([plain], { loadState: 'loading', blocked: null, muted: null, owner: OWN, authorsOf: storedRowAuthors(seeded) }), [], 'nothing before block.list')
})

test('a flush stores only this run\'s originals, never a blocked, pending or seed-only one, and retains their photos', async (t) => {
  const { liveOriginalAt, peek } = await helpers()
  const { buildScreenSnapshot } = await import('../src/screenSnapshot.js')
  const flush = section(PEEK, 'const flushSave = useCallback(', 'const armTimer = useCallback(')
  t.ok(flush.includes('const originals = peekOriginalsOf(rows, liveOriginalAt(socialRef.current.social.originals, seedOriginals, b.keys, ownDeletions() === armed.deletions ? null : own, notDenied))'), 'read at flush from the raw map')
  const store = section(flush, 'const rows = ', 'const snapshot = ')
  t.absent(store.includes('.original('), 'never through original(), which may give a seeded or stale copy')
  const seededCopy = original(OTHER, 5, { text: 'velho' })
  const quotedLive = original(PARENT, 3, { media: [photo] })
  const raw = new Map([
    [OTHER + ':5', seededCopy],
    [OTHER + ':6', original(OTHER, 6, { quote: { author: PARENT, seq: 3 } })],
    [PARENT + ':3', quotedLive],
    [BLOCKED + ':1', original(BLOCKED, 1)],
    [STRANGER + ':1', { transient: true }],
    [STRANGER + ':2', null]
  ])
  const at = liveOriginalAt(raw, new Map([[OTHER + ':5', seededCopy]]), new Set([BLOCKED]))
  t.is(at(OTHER + ':5'), null, 'the seeded copy useSocial still holds is not this run\'s read')
  t.is(at(BLOCKED + ':1'), null, 'a blocked author')
  t.is(at(STRANGER + ':1'), null, 'a transient failure')
  t.is(at(STRANGER + ':2'), null, 'unavailable')
  t.is(at(STRANGER + ':3'), null, 'not read yet')
  t.is(at(PARENT + ':3'), quotedLive)
  const rows = [
    repost(STRANGER, 9, { author: OTHER, seq: 5 }),
    repost(STRANGER, 8, { author: OTHER, seq: 6 }),
    item(STRANGER, 7, { quote: { author: BLOCKED, seq: 1 } }),
    item(STRANGER, 6, { replyTo: { author: STRANGER, seq: 2 } })
  ]
  const originals = peek.peekOriginalsOf(rows, at)
  t.alike(Object.keys(originals).sort(), [OTHER + ':6', PARENT + ':3'].sort(), 'the live original and what it quotes, nothing else')
  const kept = rows.filter((r) => r.seq !== 7)
  const snap = buildScreenSnapshot('espiadinha', { ...binding, rows: kept, originals, meta: META, blocked: new Set([BLOCKED]), followed: [] })
  t.alike(snap.body.rows.map((r) => r.seq), [9, 8, 6], 'a repost with a missing original stays')
  t.alike(Object.keys(snap.body.originals).sort(), [OTHER + ':6', PARENT + ':3'].sort())
  const entries = peek.peekRetainEntries({ saved: snap.body.rows, savedOriginals: snap.body.originals, drawn: [], firstKeys: null })
  t.ok(entries.some((e) => e.kind === 'peekPosts' && e.author === PARENT && e.d.sha256 === photo.sha256), 'the quoted original\'s photo is retained under its author')
  const before = peek.peekRetainEntries({ saved: snap.body.rows, drawn: [], firstKeys: null })
  t.absent(before.some((e) => e.author === PARENT), 'without the originals it would be deleted')
})

test('a held reopen reads the held live page\'s originals, so its save stores them', async (t) => {
  const held = section(PEEK, 'const ingestHeld = useCallback(', '}, [ingest, unfollowed])')
  t.ok(held.includes('const held = liveHeldRef.current'))
  t.ok(held.includes('ingest(pageNeeds(withoutBlockedRows(unfollowed(held.rows), blocksRef.current.keys, peekRowAuthors)))'), 'the live rows less blocked and followed ones, no reset')
  t.absent(held.includes('reset'), 'added to the reset ingest, never a second reset')
  const load = section(PEEK, 'const loadFirst = useCallback(', 'const loadMore = useCallback(')
  t.ok(/ingest\(\{ \.\.\.place\(rows, page\.next, isLastPeekPage\(page\), pageMeta, Date\.now\(\)\), reset: true \}\)\s*ingestHeld\(\)/.test(load), 'after the first page\'s reset ingest')
  t.ok(/ingest\(\{ \.\.\.pendingIngestRef\.current, reset: true \}\)\s*pendingIngestRef\.current = null\s*ingestHeld\(\)/.test(load), 'after a failed refresh\'s held needs')
  const show = section(PEEK, 'const stale = shouldReloadOnShow(', 'if (followsPending.current && current.loadedAt !== null)')
  t.ok(/ingest\(\{ \.\.\.pendingIngestRef\.current, reset: true \}\)\s*pendingIngestRef\.current = null\s*ingestHeld\(\)/.test(show), 'after a warm page\'s held needs on show')
  const hold = section(PEEK, 'const holdLive = useCallback(', '}, [commit, unfollowed, replaceLive])')
  t.ok(hold.includes('pageNeeds(withoutBlockedRows(kept, b.keys, peekRowAuthors), hold.unconfirmed)'), 'stored rows still start no local read')
  const { peek } = await helpers()
  const live = [repost(STRANGER, 9, { author: OTHER, seq: 5 }), item(STRANGER, 8, { quote: { author: PARENT, seq: 3 } })]
  const needs = peek.pageNeeds(live)
  t.alike(needs.need.sort(), [OTHER + ':5', PARENT + ':3'].sort(), 'the held page\'s originals are asked for')
})

test('a re-save follows an enriched original, never over an armed save', async (t) => {
  const { originalsMoved } = await helpers()
  const a = original(OTHER, 5)
  const richer = { ...a, name: 'Bia' }
  t.is(originalsMoved({ [OTHER + ':5']: a }, { [OTHER + ':5']: a }, new Map([[OTHER + ':5', a]])), false, 'nothing moved')
  t.is(originalsMoved({ [OTHER + ':5']: a }, { [OTHER + ':5']: richer }, new Map([[OTHER + ':5', richer]])), true, 'an enrichment (same ref, new object)')
  t.is(originalsMoved({}, { [OTHER + ':5']: a }, new Map([[OTHER + ':5', a]])), true, 'answered after the save')
  t.is(originalsMoved({ [OTHER + ':5']: a }, {}, new Map()), false, 'being read again')
  t.is(originalsMoved({ [OTHER + ':5']: a }, {}, new Map([[OTHER + ':5', { transient: true }]])), false, 'a transient failure')
  t.is(originalsMoved({ [OTHER + ':5']: a }, {}, new Map([[OTHER + ':5', null]])), true, 'gone')
  const effect = section(PEEK, 'const liveOriginals = social.social.originals', '}, [liveOriginals, seedOriginals, resave])')
  t.ok(effect.includes('if (saved === null || saveRef.current !== null || lastLiveRef.current === null) return'), 'not while a save is armed')
  t.ok(effect.includes('const now = peekOriginalsOf(saved.rows, liveOriginalAt(liveOriginals, seedOriginals, blocksRef.current.keys, ownDeletions() === last.deletions ? null : ownKeysOf(last.binding.owner, ownKeyRef.current), notDenied))'), 'the same rule as the flush')
  t.ok(effect.includes('if (originalsMoved(saved.originals, now, liveOriginals)) resave()'), 'the existing re-save')
  const flush = section(PEEK, 'const flushSave = useCallback(', 'const armTimer = useCallback(')
  t.ok(flush.includes('savedRef.current = { rows, originals }'), 'each flush records what it stored')
})

test('a purge since the request arms the save once more; a wipe or another identity drops it', async (t) => {
  const { saveStep } = await helpers()
  const armed = { gen: 1, wipe: 0, refresh: 4, retried: false }
  t.is(saveStep({ armed, gen: 1, wipe: 0, sameBinding: true, refresh: 4 }), 'write')
  t.is(saveStep({ armed, gen: 2, wipe: 0, sameBinding: true, refresh: 4 }), 'rearm', 'a purge: once more')
  t.is(saveStep({ armed: { ...armed, gen: 2, retried: true }, gen: 3, wipe: 0, sameBinding: true, refresh: 4 }), 'drop', 'only once')
  t.is(saveStep({ armed: { ...armed, gen: 2, retried: true }, gen: 2, wipe: 0, sameBinding: true, refresh: 4 }), 'write', 'the re-armed save writes')
  t.is(saveStep({ armed, gen: 2, wipe: 1, sameBinding: true, refresh: 4 }), 'drop', 'a wipe')
  t.is(saveStep({ armed, gen: 1, wipe: 1, sameBinding: true, refresh: 4 }), 'drop', 'a wipe even at the same generation')
  t.is(saveStep({ armed, gen: 1, wipe: 0, sameBinding: false, refresh: 4 }), 'drop', 'another identity')
  const flush = section(PEEK, 'const flushSave = useCallback(', 'const armTimer = useCallback(')
  t.ok(flush.includes('const step = saveStep({ armed, gen: cacheGeneration(), wipe: wipeEpoch(), sameBinding: sameSnapshotBinding(armed.binding, bindingRef.current), refresh: refreshRef.current })'))
  t.ok(flush.includes("if (step === 'rearm') armTimer({ ...armed, gen: cacheGeneration(), timer: null, due: false, retried: true })"), 'armed again with the generation now, filtered again at its flush')
  t.ok(flush.indexOf("if (step !== 'write') return") < flush.indexOf('const rows = '), 'nothing written otherwise')
  const arm = section(PEEK, 'const armSave = useCallback(', 'const resave = useCallback(')
  t.ok(arm.includes('armTimer(armedSave({ gen, generation: cacheGeneration(), wipe, refresh, deletions, binding: b, rows, meta }))'))
})

test('the Espiadinha marks its stored and its first live rows', (t) => {
  t.ok(PEEK.includes("import { perfMarks, useNode } from '../node'"))
  const snap = section(PEEK, 'const snapshotMarkedRef = useRef(false)', '}, [seeded, drawnCount])')
  t.ok(snap.includes('if (!seeded || drawnCount === 0 || snapshotMarkedRef.current) return'), 'once stored rows are drawn (past the block gate)')
  t.ok(snap.includes("perfMarks().mark('rows-snapshot:espiadinha')"))
  const note = section(PEEK, 'const noteShown = useCallback(', '}, [armSave])')
  t.ok(note.includes("perfMarks().mark('rows-live:espiadinha')"), 'when a first live page goes on screen')
  t.ok(note.indexOf("mark('rows-live:espiadinha')") < note.indexOf('if (stamp === null'), 'with or without a binding')
})

test('a deletion since the read drops a re-armed save', async (t) => {
  const { saveStep } = await helpers()
  const armed = { gen: 1, wipe: 0, refresh: 4, retried: false }
  t.is(saveStep({ armed, gen: 2, wipe: 0, sameBinding: true, refresh: 5 }), 'drop', 'App bumps refresh with every own deletion (and the generation)')
  t.is(saveStep({ armed: { ...armed, gen: 2, retried: true }, gen: 2, wipe: 0, sameBinding: true, refresh: 5 }), 'drop', 'a deletion during the re-armed delay')
  t.is(saveStep({ armed, gen: 1, wipe: 0, sameBinding: true, refresh: 5 }), 'write', 'a first save at its own generation is not held back (the refresh reload re-arms anyway)')
  const send = section(PEEK, 'const peek = useCallback(async (params, options, stamp) => {', '}, [request])')
  t.ok(send.indexOf('stamp.refresh = refreshRef.current') > 0 && send.indexOf('stamp.refresh = refreshRef.current') < send.indexOf("request('peek.read'"), 'read in the tick of the request')
  const resave = section(PEEK, 'const resave = useCallback(', '}, [armSave])')
  t.ok(resave.includes('armSave(cacheGeneration(), last.binding, last.rows, last.meta, last.wipe, refreshRef.current, last.deletions)'), 'a re-save is never a re-armed one, and keeps the own deletions of its read')
})

test('a re-armed save keeps out an author a purge removed since its read', async (t) => {
  const { purgedRows, liveOriginalAt, peek } = await helpers()
  const caches = await import('../src/localCaches.js')
  const flush = section(PEEK, 'const flushSave = useCallback(', 'const armTimer = useCallback(')
  t.ok(flush.includes('if (rows === null) return'), 'no allowed set for a re-arm, or nothing left: not written')
  t.ok(flush.includes('const notDenied = (a) => peekKeepAllowed(a) || allowedAuthor(a)'))
  const rows = [item(STRANGER, 9), item(FOLLOWED, 8), repost(STRANGER, 7, { author: OTHER, seq: 5 }), item(STRANGER, 6, { quote: { author: BLOCKED, seq: 2 } })]
  const notDenied = (a) => caches.peekKeepAllowed(a) || caches.allowedAuthor(a)
  const keep = () => purgedRows(rows, { mayKeep: caches.peekKeepAllowed, notDenied }).map((r) => r.seq)
  caches.setAllowedAuthors(null)
  t.ok(caches.allowedAuthor(null), 'no allowed set yet: the flush drops the re-arm')
  t.alike(keep(), [], 'and nothing of a stranger could pass anyway')
  caches.noteBlocksKnown(caches.wipeEpoch())
  // The follow list this list has not reconciled: FOLLOWED was followed
  // during the delay, and the purge recorded it.
  caches.keepOnlyAuthors(new Set([OWN, FOLLOWED]))
  t.alike(keep(), [9, 7, 6], 'the newly followed author\'s row is not put back')
  caches.dropAuthors([BLOCKED])
  t.alike(keep(), [9, 7], 'a block purge: no row naming the blocked author')
  const raw = new Map([[OTHER + ':5', original(OTHER, 5)], [BLOCKED + ':2', original(BLOCKED, 2)]])
  const at = liveOriginalAt(raw, null, new Set(), null, notDenied)
  t.is(at(BLOCKED + ':2'), null, 'nor an original of theirs, even before this list\'s blocks have it')
  t.is(at(OTHER + ':5'), raw.get(OTHER + ':5'), 'a stranger\'s original stays')
  t.alike(Object.keys(peek.peekOriginalsOf([repost(STRANGER, 7, { author: OTHER, seq: 5 }), item(STRANGER, 3, { quote: { author: BLOCKED, seq: 2 } })], at)), [OTHER + ':5'])
})

test('an own post is stored as an original, except one read before an own deletion, and never retained as a peek photo', async (t) => {
  const { liveOriginalAt, seedGuard, peek } = await helpers()
  const { buildScreenSnapshot } = await import('../src/screenSnapshot.js')
  const { parse, peekSeedOf } = await import('../src/peekSnapshot.js')
  const mine = original(OWN, 4, { media: [photo] })
  const raw = new Map([[OWN + ':4', mine], [OTHER + ':5', original(OTHER, 5)]])
  const at = liveOriginalAt(raw, null, new Set(), null)
  t.is(at(OWN + ':4'), mine, 'a stranger\'s repost of an own post stores it, so a reopen draws it at once')
  const rows = [repost(STRANGER, 9, { author: OWN, seq: 4 })]
  const snap = buildScreenSnapshot('espiadinha', { ...binding, rows, originals: peek.peekOriginalsOf(rows, at), meta: META, blocked: new Set(), followed: [] })
  t.alike(Object.keys(snap.body.originals), [OWN + ':4'], 'stored')
  const seeded = peekSeedOf(parse(snap.body)).originals
  const drawn = seedGuard((ref) => seeded.get(ref), seeded, { blocksOk: true, sameSeed: true, blocked: new Set([BLOCKED]) })
  t.alike(drawn(OWN + ':4'), mine, 'and seeded under this run\'s block list and binding')
  const afterDeletion = liveOriginalAt(raw, null, new Set(), new Set([OWN]))
  t.is(afterDeletion(OWN + ':4'), null, 'after an own deletion since the read, the raw map may hold the deleted post')
  t.is(afterDeletion(OTHER + ':5'), raw.get(OTHER + ':5'))
  t.is(liveOriginalAt(new Map([[OWN + ':4', { ...mine, author: OWN.toUpperCase() }]]), null, new Set(), new Set([OWN]))(OWN + ':4'), null, 'compared lowercase')
  const flush = section(PEEK, 'const flushSave = useCallback(', 'const armTimer = useCallback(')
  t.ok(flush.includes('const own = ownKeysOf(armed.binding.owner, ownKeyRef.current)'), 'the owner read with the page and the own key now')
  const drawnOf = section(flush, 'const drawnOf = (ref) => {', 'retainKept(')
  t.ok(drawnOf.includes('return own.has(a) || (b.keys && b.keys.has(a)) ? null : o'), 'no own photo retained for a drawn row')
  t.ok(flush.includes('originalOf: drawnOf }).filter((e) => !own.has(e.author)))'), 'nor for a saved own original: own photos are kept by their own kinds')
  const init = section(PEEK, 'const [state, setState] = useState(() => {', 'const { items: allItems')
  t.ok(init.includes('retainRef.current = peekKeptEntries(rows, boot.snapshot.body.originals || null).filter((e) => !own.has(e.author))'), 'the start retain leaves them out too')
  const entries = peek.peekRetainEntries({ saved: snap.body.rows, savedOriginals: snap.body.originals, drawn: [], firstKeys: null })
  t.ok(entries.some((e) => e.author === OWN), 'the unfiltered list would name the own photo as a peek one')
})

test('a purge during the first read arms a re-armed save at the current generation', async (t) => {
  const { saveStep, rowsToWrite } = await helpers()
  // eslint-disable-next-line no-new-func
  const armedSave = pure('armedSave')
  const page = { gen: 3, generation: 4, wipe: 0, refresh: 2, deletions: 1, binding, rows: [item(STRANGER, 1)], meta: META }
  const armed = armedSave(page)
  t.is(armed.gen, 4, 'at the generation now')
  t.is(armed.retried, true, 're-armed: no second chance after another purge')
  t.is(armed.deletions, 1)
  t.is(saveStep({ armed, gen: 4, wipe: 0, sameBinding: true, refresh: 2 }), 'write', 'it writes at the flush')
  t.is(saveStep({ armed, gen: 5, wipe: 0, sameBinding: true, refresh: 2 }), 'drop', 'a later purge drops it')
  t.is(saveStep({ armed, gen: 4, wipe: 1, sameBinding: true, refresh: 2 }), 'drop', 'a wipe drops it')
  t.is(saveStep({ armed, gen: 4, wipe: 0, sameBinding: true, refresh: 3 }), 'drop', 'an own deletion since the read (refresh) drops it')
  t.is(saveStep({ armed, gen: 4, wipe: 0, sameBinding: false, refresh: 2 }), 'drop', 'another identity drops it')
  t.is(rowsToWrite(page.rows, { armed, allowedKnown: false, mayKeep: () => true, notDenied: () => true }), null, 'with no allowed set known it is dropped, as any re-armed save')
  const plain = armedSave({ ...page, generation: 3 })
  t.is(plain.retried, false, 'no purge: a plain save')
  t.is(plain.gen, 3)
})

test('a seeded original is drawn only under this run\'s block list and the seed\'s identity', async (t) => {
  const { seedGuard } = await helpers()
  const seededPost = original(OTHER, 5)
  const seededBlocked = original(BLOCKED, 2)
  const livePost = original(OTHER, 6)
  const raw = new Map([[OTHER + ':5', seededPost], [BLOCKED + ':2', seededBlocked], [OTHER + ':6', livePost], [OTHER + ':7', null]])
  const seeded = new Map([[OTHER + ':5', seededPost], [BLOCKED + ':2', seededBlocked]])
  const original0 = (ref) => raw.get(ref)
  const before = seedGuard(original0, seeded, { blocksOk: false, sameSeed: true, blocked: new Set() })
  t.is(before(OTHER + ':5'), undefined, 'before block.list a live row naming a seeded ref does not draw it')
  t.is(before(OTHER + ':6'), livePost, 'this run\'s read is drawn')
  t.is(before(OTHER + ':7'), null, 'an answer of gone stays')
  const after = seedGuard(original0, seeded, { blocksOk: true, sameSeed: true, blocked: new Set([BLOCKED]) })
  t.is(after(OTHER + ':5'), seededPost, 'once it answered, a seeded original of no blocked author is drawn')
  t.is(after(BLOCKED + ':2'), undefined, 'a blocked one never')
  const renamed = { ...seededPost, author: BLOCKED }
  const byAuthor = seedGuard(() => renamed, new Map([[OTHER + ':5', renamed]]), { blocksOk: true, sameSeed: true, blocked: new Set([BLOCKED]) })
  t.is(byAuthor(OTHER + ':5'), undefined, 'the original\'s own author is checked too')
  const other = seedGuard(original0, seeded, { blocksOk: true, sameSeed: false, blocked: new Set() })
  t.is(other(OTHER + ':5'), undefined, 'never under another identity')
  t.is(seedGuard(original0, null, { blocksOk: false, sameSeed: false, blocked: null }), original0, 'no seed: original() as is')
  t.ok(PEEK.includes("const social = { ...rawSocial, original: seedGuard(rawSocial.original, seedOriginals, { blocksOk: blocks.loadState === 'ok', sameSeed: boot !== null && sameSnapshotBinding(boot.binding, binding), blocked: blocks.keys }) }"), 'the rows draw through it')
  const render = section(PEEK, "if (item.kind === 'repost') {", 'if (isCached(item))')
  t.ok(render.includes('const post = social.original(ref)'), 'a repost row')
  t.ok(PEEK.includes('const rowCache = useRowPropsCache(items, peekKey, { h: handlers, social })'), 'and the row cache (quotes, reply marks)')
  t.ok(PEEK.indexOf('const social = { ...rawSocial') < PEEK.indexOf('const socialRef = useRef(social)'), 'the retain reads the guarded one')
})

test('a re-save after a follow purge does not put the followed author\'s row back', async (t) => {
  const { rowsToWrite } = await helpers()
  const caches = await import('../src/localCaches.js')
  const flush = section(PEEK, 'const flushSave = useCallback(', 'const armTimer = useCallback(')
  t.ok(flush.includes('{ armed, allowedKnown: !allowedAuthor(null), mayKeep: peekKeepAllowed, notDenied })'), 'every flush, not only a re-armed one')
  const rows = [item(STRANGER, 9), item(FOLLOWED, 8)]
  const notDenied = (a) => caches.peekKeepAllowed(a) || caches.allowedAuthor(a)
  const write = (armed) => {
    const out = rowsToWrite(rows, { armed, allowedKnown: !caches.allowedAuthor(null), mayKeep: caches.peekKeepAllowed, notDenied })
    return out === null ? null : out.map((r) => r.seq)
  }
  const fresh = { retried: false }
  caches.setAllowedAuthors(null)
  t.is(write({ retried: true }), null, 'no allowed set: a re-armed save is dropped')
  t.alike(write(fresh), [9, 8], 'a first save or a re-save writes as it is')
  caches.noteBlocksKnown(caches.wipeEpoch())
  // FOLLOWED was followed elsewhere; this list reconciles it only when shown.
  caches.keepOnlyAuthors(new Set([OWN, FOLLOWED]))
  t.alike(write(fresh), [9], 'the re-save after the purge leaves the followed author out')
  t.alike(write({ retried: true }), [9], 'so does a re-armed one')
  t.is(rowsToWrite([item(FOLLOWED, 8)], { armed: fresh, allowedKnown: true, mayKeep: caches.peekKeepAllowed, notDenied }), null, 'nothing left: not written')
  t.alike(rowsToWrite([], { armed: fresh, allowedKnown: true, mayKeep: caches.peekKeepAllowed, notDenied }), [], 'an empty page stays as it was')
  caches.setAllowedAuthors(null)
})

test('originals that answer after the first save are stored by the re-save while the allowed set is unknown', async (t) => {
  const { rowsToWrite, liveOriginalAt, originalsMoved, peek } = await helpers()
  const caches = await import('../src/localCaches.js')
  const effect = section(PEEK, 'const liveOriginals = social.social.originals', '}, [liveOriginals, seedOriginals, resave])')
  t.ok(effect.includes('resave()'), 'the re-save arms like any save')
  const resave = section(PEEK, 'const resave = useCallback(', '}, [armSave])')
  t.ok(resave.includes('armSave('), 'through armSave')
  const arm = section(PEEK, 'const armSave = useCallback(', 'const resave = useCallback(')
  const armed = { gen: 1, wipe: 0, refresh: 4, binding, rows: null, meta: META, timer: null, due: false, retried: false }
  t.ok(arm.includes('armTimer(armedSave({ gen, generation: cacheGeneration(), wipe, refresh, deletions, binding: b, rows, meta }))'), 'this record, nothing else')
  t.is(pure('armedSave')({ gen: 1, generation: 1, wipe: 0, refresh: 4, deletions: 0, binding, rows: null, meta: META }).retried, false, 'at the generation of its call: a plain save')
  caches.setAllowedAuthors(null)
  t.ok(caches.allowedAuthor(null), 'A Rua has not set the allowed set yet')
  const notDenied = (a) => caches.peekKeepAllowed(a) || caches.allowedAuthor(a)
  const seeded = original(OTHER, 5, { text: 'velho' })
  const rows = [repost(STRANGER, 9, { author: OTHER, seq: 5 }), item(STRANGER, 8, { replyTo: { author: PARENT, seq: 3 } })]
  const store = (raw) => {
    const out = rowsToWrite(rows, { armed, allowedKnown: !caches.allowedAuthor(null), mayKeep: caches.peekKeepAllowed, notDenied })
    if (out === null) return null
    return { rows: out, originals: peek.peekOriginalsOf(out, liveOriginalAt(raw, new Map([[OTHER + ':5', seeded]]), new Set(), null, notDenied)) }
  }
  const first = store(new Map([[OTHER + ':5', seeded]]))
  t.alike(first.originals, {}, 'the first save: only the seeded copy, not stored')
  const live = new Map([[OTHER + ':5', original(OTHER, 5)], [PARENT + ':3', original(PARENT, 3)]])
  const now = peek.peekOriginalsOf(first.rows, liveOriginalAt(live, new Map([[OTHER + ':5', seeded]]), new Set(), null, notDenied))
  t.ok(originalsMoved(first.originals, now, live), 'the originals answered: a re-save')
  const next = store(live)
  t.ok(next !== null, 'the re-save is written')
  t.alike(Object.keys(next.originals).sort(), [OTHER + ':5', PARENT + ':3'].sort(), 'with the repost\'s post and the reply\'s parent')
})

test('every own deletion drops the own originals from the stored page, mounted or not', (t) => {
  const app = withoutComments(fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8'))
  const deleted = section(app, 'const deletedPost = useCallback(() => {', '}, [])')
  t.ok(deleted.includes('noteDeleted()'), 'the deletion bumps the generation first')
  t.ok(deleted.includes('dropOwnOriginals({ loadText: loadScreenSnapshotText, load: loadScreenSnapshot, save: saveScreenSnapshot, clear: clearScreenSnapshot }, cacheGeneration())'), 'then the stored page is rewritten at the generation now')
  t.ok(deleted.indexOf('noteDeleted()') < deleted.indexOf('dropOwnOriginals('), 'after the bump, so the write is not refused')
  t.ok(app.includes("import { dropOwnOriginals } from './src/peekSnapshot'"))
})
