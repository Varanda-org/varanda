'use strict'

// A private chat opens from its stored tail ('mensagens' snapshot,
// src/privateSnapshot.js). Mensagem.js loads react-native, so the wiring is
// checked on its text and its pure helpers are evaluated from that text; the
// save pipeline runs here on the pure modules.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const SRC = path.join(__dirname, '..', 'src')
const RAW = fs.readFileSync(path.join(SRC, 'screens', 'Mensagem.js'), 'utf8')

function withoutComments (src) {
  return src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')
}

const MSG = withoutComments(RAW)

// The text from `start` to the next `end` after it.
function section (src, start, end) {
  const a = src.indexOf(start)
  if (a < 0) return ''
  const b = src.indexOf(end, a + start.length)
  return b < 0 ? src.slice(a) : src.slice(a, b)
}

const loadRules = () => import('../src/screenSnapshot.js')
const loadPrivate = () => import('../src/privateSnapshot.js')

// The screen's own pure helpers, run from its source.
async function helpers () {
  const { messageKey } = await import('../src/dm-screen.js')
  const body = section(MSG, 'const SAVE_ROWS_MAX = 30', 'export function initialMessage').replace(/export function/g, 'function')
  // eslint-disable-next-line no-new-func
  return new Function('messageKey', body + '\nreturn { seededThread, isSeeded, storedMessage, savedRows, withoutSeeded, seededKeys, settledThread, dropThread, tailToSave, shownRaw, NO_ROWS, SAVE_ROWS_MAX }')(messageKey)
}

const OWN = 'aa'.repeat(32)
const PEER = 'bb'.repeat(32)
const OTHER = 'cc'.repeat(32)
const ASSOC = 'ee'.repeat(32)
const ORIGIN = 'https://bora.varanda.app'
const ME = Object.freeze({ kind: 'me' })
const BIND = Object.freeze({ origin: ORIGIN, association: ASSOC, owner: OWN, acting: ME })
const at = (n) => new Date(Date.UTC(2026, 10, 1, 0, 0, n)).toISOString()
const hex = (n, len) => n.toString(16).padStart(len, '0')
const dmItem = (extra = {}) => ({ id: '12'.repeat(32), key: '34'.repeat(32), nonce: '56'.repeat(24), chunks: 1, bytes: 1000, sha256: '78'.repeat(32), mime: 'image/jpeg', w: 800, h: 600, ms: 0, ...extra })
const message = (n, extra = {}) => ({ id: hex(n, 32), from: PEER, text: 'mensagem ' + n, replyTo: null, fwd: 0, at: at(n), mine: false, media: null, card: null, ...extra })
const cardWithImage = () => ({ url: 'https://exemplo.com.br/a', host: 'exemplo.com.br', title: 'Título', desc: 'desc', image: dmItem({ id: '9a'.repeat(32) }) })

test('stored rows seed the thread for the member binding only, and loaded stays false', (t) => {
  t.ok(MSG.includes('const binding = old === null ? memberSnapshotBinding({ node, acting, pageKey }) : null'), 'no binding for a page actor, an old Página key or the Vitrine')
  const init = section(MSG, 'const [raw, setRaw] = useState(() => {', 'const [next, setNext]')
  t.ok(init.includes('if (binding === null) return []'), 'no binding reads nothing')
  t.ok(init.includes("seededThread(loadScreenSnapshot('mensagens', binding), peer)"), 'the peer\'s entry of the snapshot seeds raw')
  t.ok(MSG.includes('const seedOnly = useMemo(() => seededKeys(raw), [raw])'), 'seedOnly holds the key of every unconfirmed row')
  t.absent(/setLoaded/.test(init), 'the seed never sets loaded')
  t.ok(MSG.includes('const [loaded, setLoaded] = useState(false)'), 'loaded starts false')
  const thread = section(MSG, 'const readThread = useCallback(async () => {', 'const reactionGate =')
  t.ok(/setLoaded\(true\)/.test(thread), 'only dm.thread sets loaded')
})

test('dm.seen never runs from a cached paint', (t) => {
  const seen = section(MSG, 'const jump = jumpState(', 'const userScroll = useCallback(')
  t.ok(seen.includes("if (!ready || !loaded || !visible || !isTop || newest === '' || !placed) {"), 'the seen effect returns while loaded is false')
  t.ok(seen.includes('}, [ready, loaded, visible, isTop, peer, newest, placed, endShown, upTo])'), 'and reruns when loaded changes')
  const landing = section(MSG, 'useEffect(() => {\n    if (!loaded || newest === \'\'', '}, [loaded, newest, gestureRows')
  t.ok(landing.length > 0, 'the landing waits for loaded too')
  t.ok(MSG.includes('const plan = loaded ? openPlan('), 'the open plan waits for loaded')
})

test('the seeded rows are drawn all or nothing over the block.list state', async (t) => {
  const line = MSG.split('\n').find((l) => l.includes('const seedShown = '))
  t.ok(line, 'the gate is computed at render')
  const expr = line.slice(line.indexOf('=') + 1).trim()
  // eslint-disable-next-line no-new-func
  const shown = new Function('blocks', 'peer', 'return ' + expr)
  const blocks = (loadState, keys = []) => ({ loadState, has: (k) => keys.includes(k) })
  t.is(shown(blocks('pending'), PEER), false, 'pending: hidden')
  t.is(shown(blocks('failed'), PEER), false, 'failed: hidden')
  t.is(shown(blocks('ok'), PEER), true, 'ok without the peer: drawn')
  t.is(shown(blocks('ok', [PEER]), PEER), false, 'ok with the peer blocked: hidden')
  t.is(shown(blocks('ok', [OTHER]), PEER), true, 'another key blocked: drawn')
  t.ok(MSG.includes('const gestureRows = useMemo(() => threadRows(shownRaw(raw, loaded, seedShown)), [raw, loaded, seedShown])'), 'the list draws through shownRaw')
  t.ok(MSG.indexOf('const seedShown = ') < MSG.indexOf('const gestureRows = '), 'computed before the rows')
  t.ok(MSG.includes('if (!loaded) empty = <Skeleton />'), 'and the skeleton fills an empty list')

  const { shownRaw, seededThread, NO_ROWS } = await helpers()
  const seeded = seededThread({ body: { threads: { [PEER]: { savedAt: 1, messages: [message(1), message(2)] } } } }, PEER)
  t.is(shownRaw(seeded, false, true), seeded, 'gate passed before dm.thread: the stored rows')
  t.is(shownRaw(seeded, false, false), NO_ROWS, 'gate closed before dm.thread: nothing (skeleton)')
  t.is(shownRaw(seeded, true, true), seeded, 'gate passed after dm.thread: every row')
})

test('a failed read never opens the gate for stored rows', async (t) => {
  // readThread sets loaded after its catch too: the stored rows stay out
  // while block.list is pending, failed or holds the peer.
  const thread = section(MSG, 'const readThread = useCallback(async () => {', 'const reactionGate =')
  t.ok(/\} catch \(err\) \{[\s\S]*setLoaded\(true\)\n {2}\}, \[dm, peer, commitRead\]\)/.test(thread), 'loaded turns true after a failure (the reason this gate exists)')
  const { shownRaw, seededThread } = await helpers()
  const seeded = seededThread({ body: { threads: { [PEER]: { savedAt: 1, messages: [message(1), message(2)] } } } }, PEER)
  t.alike(shownRaw(seeded, true, false), [], 'failed read with the gate closed: no stored row')
  // A live page kept beside older stored rows: only the live ones show.
  const mixed = [...seeded, message(3), message(4)]
  t.alike(shownRaw(mixed, true, false).map((m) => m.id), [hex(3, 32), hex(4, 32)], 'gate closed after a live page: live rows only')
  t.is(shownRaw(mixed, true, true), mixed, 'gate open: all of them')
})

test('a seeded card never loads a provider player', (t) => {
  const row = section(MSG, 'const MessageRow = memo(function MessageRow (', 'const makeStyles')
  t.ok(row.includes("plainCard={seeded || folder === 'request'}"), 'a seeded row draws its card plain, before the folder is known')
  t.absent(row.includes("plainCard={folder === 'request'}"), 'not only in a request')
  const bubble = fs.readFileSync(path.join(SRC, 'ui', 'Bubble.js'), 'utf8')
  t.ok(bubble.includes('const embed = card !== null && plainCard !== true ? embedOf(card.url) : null'), 'plainCard is what keeps the player out')
  t.is((bubble.match(/<MusicEmbedCard /g) || []).length, 1, 'and the player has no other path in Bubble')
  t.ok(bubble.includes('{embed !== null\n                      ? <MusicEmbedCard '), 'drawn only from embed')
})

test('a block arriving later removes the stored thread and saves', (t) => {
  t.ok(MSG.includes('const peerBlocked = blocked || blocks.has(peer)'), 'the dm.thread flag or block.list')
  const effect = section(MSG, 'useEffect(() => {\n    if (!peerBlocked) return', '}, [peerBlocked, bindingKey, cancelSave, dropStored])')
  t.ok(effect.includes('cancelSave()') && effect.includes('dropStored()'), 'cancels a pending save and drops the entry')
  const drop = section(MSG, 'const dropStored = useCallback(() => {', '}, [peer])')
  t.ok(drop.includes('dropThread({'), 'dropThread')
  t.ok(drop.includes('remove: removeThread'), 'removeThread')
  t.ok(drop.includes("saveScreenSnapshot('mensagens', snapshot, cacheGeneration())"), 'then a save')
  t.ok(drop.includes("clearScreenSnapshot('mensagens')"), 'a refused rewrite clears the kind (fail closed)')
  const flush = section(MSG, 'const flushSave = useCallback(() => {', 'const armSave = useCallback(')
  t.ok(flush.includes('if (blockedRef.current || b.has(peer)) {') && flush.includes('dropStored()'), 'a blocked peer is never saved')
  t.ok(flush.indexOf("if (b.loadState !== 'ok')") < flush.indexOf('buildScreenSnapshot'), 'nothing is saved before block.list answered')
  const del = section(MSG, "if (state === 'deleted') {", 'onBack()')
  t.ok(del.includes('dropStored()'), 'a deleted conversation leaves the device too')
})

test('stored media stubs are painted as pending placeholders', async (t) => {
  const { seededThread, isSeeded } = await helpers()
  const stub = { mime: 'image/jpeg', w: 800, h: 600, ms: 0 }
  const snapshot = { body: { threads: { [PEER]: { savedAt: 1, messages: [message(1, { media: [stub] }), message(2), message(3, { media: { unavailable: true } })] } } } }
  const rows = seededThread(snapshot, PEER)
  t.is(rows.length, 3)
  t.alike(rows[0].media, [{ ...stub, pending: true }], 'every stub pending')
  t.is(rows[1].media, null, 'text rows unchanged')
  t.ok(rows.every(isSeeded), 'every row is marked unconfirmed')
  t.absent(Object.keys(rows[0]).includes('seedOnly'), 'the mark is not enumerable')
  t.absent(isSeeded({ ...rows[0] }), 'a derived copy is not marked')
  const withCard = seededThread({ body: { threads: { [PEER]: { savedAt: 1, messages: [message(4, { card: { url: 'https://a.b', host: 'a.b', title: 'T', desc: '', image: { mime: 'image/jpeg' } } })] } } } }, PEER)
  t.is(withCard[0].card.image, null, 'no card image to read a thumbnail from')
  t.alike(rows[2].media, { unavailable: true }, 'unavailable unchanged')
  t.alike(seededThread(snapshot, OTHER), [], 'another peer\'s entry is not read')
  t.alike(seededThread(null, PEER), [], 'no snapshot')
  t.alike(seededThread({ body: { threads: Object.create({ [PEER]: { messages: [message(1)] } }) } }, PEER), [], 'own entries only')
})

test('a seeded row offers no action and no thumbnail read', (t) => {
  t.ok(MSG.includes('rawById: new Map(raw.filter((m) => !isSeeded(m)).map((m) => [messageKey(m), m]))'), 'no reaction: canReact finds no reactable row')
  t.ok(MSG.includes('if (rows[index] && seedOnly.has(rows[index].key)) return null'), 'no offer answer')
  t.ok(MSG.includes('seeded={seedOnly.has(item.key)}'), 'the row knows')
  const row = section(MSG, 'const MessageRow = memo(function MessageRow (', 'const makeStyles')
  t.ok(row.includes('readOnly: oldKeyView,') && row.includes('const readOnly = oldKeyView || seeded'), 'read-only like an old Página key')
  t.ok(row.includes("if (!readOnly) actions.push({ icon: 'responder'"), 'no reply')
  t.ok(row.includes('canForward && !readOnly ? dmForwardSource'), 'no forward')
  t.ok(row.includes('reportable && !readOnly'), 'no report')
  t.ok(row.includes('const offerRow = item.deleted || seeded ||'), 'no offer pill')
  t.ok(row.includes('const link = seeded ? null :') && row.includes('const listing = seeded ? null :'), 'no invite or listing action')
})

test('live pages confirm rows, and unconfirmed rows leave before an older page', async (t) => {
  const thread = section(MSG, 'const readThread = useCallback(async () => {', 'const reactionGate =')
  t.ok(thread.includes('const held = settledThread(refreshThread(rawRef.current, page), page, r.next)'), 'the newest page merges in place, no pill, and a complete page settles stored rows')
  const older = section(MSG, 'const loadOlder = async () => {', 'olderLive.current =')
  const drop = older.indexOf('rawRef.current = rawRef.current.filter((m) => m.seedOnly !== true)')
  t.ok(drop > 0 && drop < older.indexOf('mergeMessages('), 'unconfirmed rows dropped before the older page merges')
  const reset = section(MSG, 'if (seenPage.current === pageKey) return', '}, [pageKey, cancelSave])')
  t.ok(reset.includes('cancelSave()') && reset.includes('setRaw([])') && reset.includes('seedBinding.current = null'), 'the identity reset drops seeded rows and the save')

  const { seededThread, seededKeys, withoutSeeded } = await helpers()
  const { refreshThread, mergeMessages } = await import('../src/dm-screen.js')
  const stored = { body: { threads: { [PEER]: { savedAt: 1, messages: [message(1), message(2), message(3, { media: [{ mime: 'image/jpeg', w: 1, h: 1, ms: 0 }] }), message(5)] } } } }
  const seeded = seededThread(stored, PEER)
  t.is(seededKeys(seeded).size, 4)
  // The live page holds 3 (with its real media), 4 and 6: 5 is inside its
  // span and gone from the node, 1 and 2 are strictly older.
  const page = [message(3, { media: [dmItem()] }), message(4), message(6)]
  const held = refreshThread(seeded, page).messages
  t.alike(held.map((m) => m.id), [1, 2, 3, 4, 6].map((n) => hex(n, 32)), 'page rows win, the dropped row leaves, older rows stay')
  t.alike([...seededKeys(held)], [1, 2].map((n) => PEER + ':' + hex(n, 32)), 'only rows the page did not return stay unconfirmed')
  t.absent(held.some((m) => Array.isArray(m.media) && m.media.some((i) => i.pending === true)), 'the live copy replaces the pending placeholder')
  const merged = mergeMessages([message(0)], withoutSeeded(held))
  t.is(seededKeys(merged).size, 0, 'nothing unconfirmed beside the older page')
  t.is(withoutSeeded(page), page, 'nothing seeded: same array')
})

test('no media id, key or nonce reaches the builder input', async (t) => {
  const { savedRows, storedMessage, SAVE_ROWS_MAX } = await helpers()
  const flush = section(MSG, 'const flushSave = useCallback(() => {', 'const armSave = useCallback(')
  t.ok(flush.includes('peer, messages, blocked: b.keys })'), 'the builder gets the mapped rows and the block list')
  t.ok(section(MSG, 'export function tailToSave (raw) {', '\n}').includes('const rows = savedRows(raw)'), 'mapped through savedRows')
  const { seededThread } = await helpers()
  const raw = [message(1, { media: [dmItem(), dmItem({ mime: 'audio/mp4', w: 0, h: 0, ms: 4000 })] }), message(2, { card: cardWithImage(), local: { key: 'x' } })]
  for (let n = 3; n <= 39; n++) raw.push(message(n))
  raw.push(...seededThread({ body: { threads: { [PEER]: { savedAt: 1, messages: [message(40)] } } } }, PEER))
  const rows = savedRows(raw)
  t.is(rows.length, SAVE_ROWS_MAX, 'the last 30 rows')
  t.is(rows[rows.length - 1].id, hex(39, 32), 'seeded rows left out')
  const one = storedMessage(raw[0])
  t.alike(one.media, [{ mime: 'image/jpeg', w: 800, h: 600, ms: 0 }, { mime: 'audio/mp4', w: 0, h: 0, ms: 4000 }])
  const two = storedMessage(raw[1])
  t.is(two.card.image, null, 'the card image item is dropped')
  t.absent('local' in two, 'only message fields')
  const text = JSON.stringify([one, two])
  t.absent(/"key"|"nonce"|"sha256"|"chunks"/.test(text), 'no blob secret or descriptor')
  t.absent(text.includes('12'.repeat(32)) || text.includes('9a'.repeat(32)), 'no blob id')

  const { buildScreenSnapshot, parseScreenSnapshot } = await loadRules()
  const snap = buildScreenSnapshot('mensagens', { ...BIND, previous: null, peer: PEER, messages: [one, two], blocked: [] })
  t.ok(snap, 'the codec builds it')
  const back = parseScreenSnapshot(JSON.stringify(snap), 'mensagens', BIND)
  t.is(back.body.threads[PEER].messages.length, 2)
  t.absent(buildScreenSnapshot('mensagens', { ...BIND, previous: null, peer: PEER, messages: [one], blocked: [PEER] }).body.threads[PEER], 'a blocked peer is never kept by the codec either')
})

test('the generation and the binding are read before the request and checked at write', (t) => {
  const newest = section(MSG, 'const readNewest = useCallback(async () => {', '}, [readThread, armSave])')
  const stamp = newest.indexOf('const stamp = { gen: cacheGeneration(), binding: bindingRef.current }')
  t.ok(stamp > 0 && stamp < newest.indexOf('const run = readThread()'), 'stamped in the tick that sends dm.thread')
  t.ok(newest.includes('if (gen === genRef.current && rawRef.current !== before && live.current) armSave(stamp)'), 'armed only when that read committed')
  t.ok(MSG.includes('    readNewest()\n  }, [ready, readNewest, node.dmVersion])'), 'every newest read goes through it')
  const thread = section(MSG, 'const readThread = useCallback(async () => {', 'const reactionGate =')
  t.ok(/const gen = \+\+genRef\.current\n\s*try \{\n\s*const r = await dm\('dm\.thread'/.test(thread), 'readThread bumps genRef synchronously before its request')
  t.ok(thread.includes('rawRef.current = held.messages'), 'and puts a new array on commit')
  const arm = section(MSG, 'const armSave = useCallback((stamp) => {', 'const blockLoad =')
  t.ok(arm.includes('if (stamp.binding === null || cacheGeneration() !== stamp.gen) return'), 'no binding or a purge since arms nothing')
  t.ok(arm.includes('SAVE_DELAY_MS'), 'debounced')
  t.ok(MSG.includes('const SAVE_DELAY_MS = 2000'), 'two seconds')
  const flush = section(MSG, 'const flushSave = useCallback(() => {', 'const armSave = useCallback(')
  t.ok(flush.includes('const now = memberSnapshotBinding({ node: nodeRef.current, acting: actingRef.current, pageKey: pageKeyRef.current })'), 'the binding is recomputed at write time')
  t.ok(flush.includes('cacheGeneration() !== armed.gen || !sameSnapshotBinding(armed.binding, now)'), 'same generation and identity')
  t.ok(flush.includes("saveScreenSnapshot('mensagens', snapshot, armed.gen)"), 'saved with the stamped generation, not retried')
  t.ok(MSG.includes('useEffect(() => cancelSave, [cancelSave])'), 'unmount cancels the debounce')
  const send = section(MSG, 'const send = async (text', 'const retryHeld = async')
  t.ok(send.indexOf('const stamp = { gen: cacheGeneration(), binding: bindingRef.current }') < send.indexOf('post.run('), 'a send stamps before it starts')
  t.ok(send.includes('if (livePage.current) armSave(stamp)'), 'and arms only after a live newest page')
})

test('an action after a failed read never saves over the stored tail', async (t) => {
  t.ok(MSG.includes('const livePage = useRef(false)'), 'false on open')
  const thread = section(MSG, 'const readThread = useCallback(async () => {', 'const reactionGate =')
  t.ok(thread.includes('rawRef.current = held.messages\n      livePage.current = true'), 'set only where a newest page commits')
  t.is((MSG.match(/livePage\.current = true/g) || []).length, 1, 'and nowhere else')
  const reset = section(MSG, 'if (seenPage.current === pageKey) return', '}, [pageKey, cancelSave])')
  t.ok(reset.includes('livePage.current = false'), 'the identity reset clears it')
  t.absent(/loadedRef/.test(MSG), 'loaded (true after a failure too) arms nothing')
  t.is((MSG.match(/if \(live\.current && livePage\.current\) armSave\(stamp\)/g) || []).length, 2, 'photo and voice sends too')
  const flush = section(MSG, 'const flushSave = useCallback(() => {', 'const armSave = useCallback(')
  t.ok(flush.includes('const messages = tailToSave(rawRef.current)\n    if (messages === null) return'), 'the write skips a tail of stored rows only')

  const { tailToSave, seededThread } = await helpers()
  const seeded = seededThread({ body: { threads: { [PEER]: { savedAt: 1, messages: [message(1), message(2)] } } } }, PEER)
  t.is(tailToSave(seeded), null, 'only stored rows: nothing to write')
  t.alike(tailToSave([]), [], 'an empty live thread still clears')
  t.alike(tailToSave([...seeded, message(3)]).map((m) => m.id), [hex(3, 32)], 'live rows are written')
})

test('removeThread drops only the peer\'s thread from the stored body', async (t) => {
  const { removeThread } = await loadPrivate()
  const { buildScreenSnapshot } = await loadRules()
  const snap = buildScreenSnapshot('mensagens', { ...BIND, previous: null, peer: PEER, messages: [message(1)], blocked: [] })
  const other = buildScreenSnapshot('mensagens', { ...BIND, previous: snap.body, peer: OTHER, messages: [message(2, { from: OTHER })], blocked: [] })
  const dropped = buildScreenSnapshot('mensagens', { ...BIND, previous: removeThread(other.body, PEER), blocked: [] })
  t.alike(Object.keys(dropped.body.threads), [OTHER], 'only the other thread stays')
})

test('a dropped thread whose rewrite did not stick clears the whole kind', async (t) => {
  const { dropThread } = await helpers()
  const { removeThread } = await loadPrivate()
  const { buildScreenSnapshot, parseScreenSnapshot } = await loadRules()
  const snap = buildScreenSnapshot('mensagens', { ...BIND, previous: null, peer: PEER, messages: [message(1)], blocked: [] })
  const both = buildScreenSnapshot('mensagens', { ...BIND, previous: snap.body, peer: OTHER, messages: [message(2, { from: OTHER })], blocked: [] })
  const store = (write) => {
    const s = { text: JSON.stringify(both), cleared: 0 }
    s.io = {
      load: () => s.text === null ? null : parseScreenSnapshot(s.text, 'mensagens', { ...BIND, acting: ME }),
      save: (snapshot) => { if (write) s.text = JSON.stringify(snapshot); return true },
      clear: () => { s.text = null; s.cleared++ },
      build: (input) => buildScreenSnapshot('mensagens', input),
      remove: removeThread
    }
    return s
  }
  t.ok(store(true).io.load() !== null, 'the fixture parses')
  const ok = store(true)
  dropThread(ok.io, BIND, PEER, [])
  t.is(ok.cleared, 0, 'a write that sticks keeps the other threads')
  t.alike(Object.keys(ok.io.load().body.threads), [OTHER], 'only the peer leaves')
  const lost = store(false)
  dropThread(lost.io, BIND, PEER, [])
  t.is(lost.text, null, 'a save that claimed success but wrote nothing clears the kind')
  const none = store(true)
  dropThread(none.io, BIND, 'dd'.repeat(32), [])
  t.is(none.cleared, 0, 'no thread for the peer: nothing changes')
  const failed = store(true)
  const load = failed.io.load
  let reads = 0
  failed.io.load = (b) => reads++ === 0 ? null : load(b)
  dropThread(failed.io, BIND, PEER, [])
  t.is(failed.cleared, 1, 'a read that fails (null) clears the kind instead of keeping the thread')
})

test('a complete newest page drops stored rows it did not return', async (t) => {
  const { seededThread, seededKeys, settledThread } = await helpers()
  const { refreshThread } = await import('../src/dm-screen.js')
  const stored = { body: { threads: { [PEER]: { savedAt: 1, messages: [message(1), message(2), message(4)] } } } }
  const page = [message(4), message(6)]
  const partial = settledThread(refreshThread(seededThread(stored, PEER), page), page, 'cursor')
  t.alike(partial.messages.map((m) => m.id), [1, 2, 4, 6].map((n) => hex(n, 32)), 'an older page may exist: older stored rows stay')
  t.ok(partial.keepOlder)
  const done = settledThread(refreshThread(seededThread(stored, PEER), page), page, null)
  t.alike(done.messages.map((m) => m.id), [4, 6].map((n) => hex(n, 32)), 'nothing older on the node: stored rows it did not return leave')
  t.is(seededKeys(done.messages).size, 0, 'none stays pending')
  t.is(done.keepOlder, false, 'the older cursor resets')
  const live = { messages: [message(0), message(4), message(6)], keepOlder: true }
  t.is(settledThread(live, page, null), live, 'confirmed live rows stay untouched')
})

test('a seeded momento reaction never draws the live preview', (t) => {
  const row = section(MSG, 'const MessageRow = memo(function MessageRow (', 'const makeStyles')
  t.ok(row.includes('moment={pageKey === null && !seeded && !item.deleted && isMomentReaction(item)'), 'no moment.lookup or image read before dm.thread answers')
})
