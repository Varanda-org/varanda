// Momentos screens (src/screens/Momentos.js, src/ui/MomentosStrip.js, the
// Momento mode of Publicar, A Rua, Diário, App and tabs) read as source text,
// plus the pure seen store and helpers (src/momentSeen.js) and its web store.
'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const APP = join(__dirname, '..')
const read = (rel) => readFileSync(join(APP, rel), 'utf8')
const VIDEO_END_GRACE_MS = Number(/export const VIDEO_END_GRACE_MS = (\d+)/.exec(read('src/moments.js'))[1])
const code = (rel) => read(rel).replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')
const loadSeen = () => import('../src/momentSeen.js')
const loadTabs = () => import('../src/tabs.js')

// The pure pruneRings of Momentos.js, run without React: the function's own
// source evaluated alone (it uses nothing else from the module).
function loadPrune () {
  const src = read('src/screens/Momentos.js')
  const start = src.indexOf('export function pruneRings')
  const body = fnBody(src, 'export function pruneRings')
  // eslint-disable-next-line no-new-func
  return new Function(src.slice(start + 'export '.length, src.indexOf('{', start)) + body + '\nreturn pruneRings')()
}

const A = 'ab'.repeat(32)
const B = 'cd'.repeat(32)
const C = 'ef'.repeat(32)

function fnBody (src, start) {
  const at = src.indexOf(start)
  if (at < 0) return null
  const open = src.indexOf('{', src.indexOf(')', at))
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1)
  }
  return null
}

test('the viewer has no likes and no view counts', (t) => {
  const src = read('src/screens/Momentos.js')
  t.absent(src.includes('coracao'), 'no coracao icon')
  t.absent(/like\.set|curtid|visualiza|views?Count|viewCount/i.test(code('src/screens/Momentos.js')), 'no likes or view counts')
  t.absent(read('src/ui/MomentosStrip.js').includes('coracao'), 'strip: no coracao')
})

test('the viewer: text through displayText, reply through canReply and openMessage', (t) => {
  const src = read('src/screens/Momentos.js')
  t.ok(src.includes('displayText(item.text, { multiline: true })'), 'moment text through displayText')
  t.absent(/\{item\.text\}/.test(src), 'never the raw text')
  t.ok(src.includes('canReply(node)'), 'reply bar gated by canReply')
  t.ok(src.includes('onMessage(author, { context: replyContext(item, author) })'), 'openMessage with the reply context')
  t.ok(src.includes("<Pill label='Responder' icon='mensagem' onPress={reply} />"), 'one Responder pill with the mensagem icon')
  t.ok(src.includes("export const OWN_NOTE = 'O momento sai dos servidores em até 7 dias.'"), 'own note covers photos and videos')
  t.ok(src.includes("export const DELETE_TITLE = 'Apagar momento?'"), 'delete confirmation title')
  t.ok(src.includes("request('moment.delete', { to: target.ref })"), 'moment.delete')
  t.ok(src.includes('<ConfirmStack'), 'ConfirmStack pattern')
  t.ok(src.includes("export const PHOTO_UNAVAILABLE = 'Foto indisponível'"), 'unavailable photo text')
  t.ok(src.includes("media.read({ kind: 'moment', author, seq })"), 'photo through node.media.read')
  t.ok(src.includes('holdMsOf(item, musicStarted)') && src.includes('progressOf(') && src.includes('ringOrder('), 'pure module helpers used')
  t.ok(src.includes('segmentMs(item, photo.ms)') && src.includes('progressOf(') && src.includes('ringOrder('), 'pure module helpers used')
  t.ok(src.includes('mark(itemKey)'), 'each viewed item marked seen')
  t.ok(src.includes("backgroundColor: '#000000'"), 'black background')
})

test('auto-advance respects reduced motion and pauses', (t) => {
  const src = read('src/screens/Momentos.js')
  t.ok(src.includes('AccessibilityInfo.isReduceMotionEnabled()'), 'reads the system setting')
  t.ok(src.includes("addEventListener('reduceMotionChanged'"), 'follows changes')
  t.ok(src.includes('export function autoAdvanceOn (reduce) {\n  return reduce === false\n}'), 'only when known not reduced')
  t.ok(src.includes("const paused = !isTop || node.visible === false || item === null || photo.phase === 'loading' || held || dragging || menuOpen || deleting !== null || musicClosed"), 'paused while hidden, pressed, dragged, in a menu or deleting')
  t.ok(src.includes('active: isTop && node.visible !== false && item !== null && !held && !dragging && !menuOpen && deleting === null') && src.includes('const running = active && loaded && autoOn'), 'paused while hidden, pressed, dragged, in a menu or deleting')
  t.ok(src.includes('onPressIn={handleTapPressIn}') && src.includes('    setHeld(true)\n  }') && src.includes('onPressOut={() => setHeld(false)}'), 'press holds')
})

test('the delete uncertain path never resends', (t) => {
  const src = read('src/screens/Momentos.js')
  const body = fnBody(src, 'const confirm = async () =>')
  t.ok(body !== null)
  t.is((body.match(/request\(/g) || []).length, 1, 'one request')
  t.ok(body.includes('if (pending || uncertain || !target) return'), 'no second press after uncertain')
  t.ok(body.includes('if (err && err.uncertain === true) setUncertain(true)'), 'uncertain recorded')
})

test('Publicar: Momento mode is one photo, putMoment then moment.create', (t) => {
  const src = read('src/screens/Publicar.js')
  t.ok(src.includes("export const MODES = [{ id: 'post', label: 'Publicação' }, { id: 'moment', label: 'Momento' }]"), 'Publicação | Momento')
  t.ok(src.includes('<Segmented options={MODES}'), 'Segmented switch')
  t.ok(src.includes('const momentOn = canPublishMoment(node) && !replyProp && !quote && asPage === null'), 'gated on the capability')
  t.ok(src.includes('files.length === 1'), 'exactly one photo')
  t.ok(src.includes('export const MOMENT_TEXT_MAX = 200'), '200 code points')
  t.ok(src.includes('maxLength={MOMENT_FIELD_MAX}') && src.includes('export const MOMENT_FIELD_MAX = 2 * MOMENT_TEXT_MAX'), 'UTF-16 worst case')
  const send = fnBody(src, 'const send = async () => {\n    if (busyRef.current || !valid)')
  t.ok(send !== null, 'moment send found')
  const put = send.indexOf('node.media.putMoment(')
  const create = send.indexOf("node.request('moment.create', { text, media: itemRef.current, ...chosen })")
  t.ok(put > 0 && create > put, 'putMoment then moment.create')
  t.ok(send.includes('refusalOf(text)') && send.indexOf('refusalOf(text)') < put, 'the word check runs before putMoment')
  t.ok(send.includes('bytes: file.bytes.slice()'), 'putMoment gets a copy (it wipes its buffer)')
  t.is((send.match(/moment\.create/g) || []).length, 1, 'one create per press')
  t.ok(send.includes('setHeld(true)') && send.includes('MOMENT_UNCERTAIN'), 'uncertain holds the draft')
  t.ok(src.includes('const valid = !held &&'), 'a held draft cannot be sent again')
  t.ok(send.includes('isLocked(err)') && send.includes('MOMENT_LOCKED'), 'locked key asks for the passkey')
  t.ok(send.includes('MEDIA_STALE') && send.includes('itemRef.current = null'), 'stale item is put again on the next press')
  t.ok(src.includes('DRAFT_KEPT'), 'post draft kept')
})

test('every surface is gated on node.hosted, never Platform.OS', (t) => {
  for (const rel of ['src/screens/Momentos.js', 'src/ui/MomentosStrip.js', 'src/momentSeen.js']) {
    t.absent(code(rel).includes('Platform'), rel + ': no Platform')
  }
  t.ok(read('src/screens/Momentos.js').includes('const hosted = node.hosted === true'), 'useMoments hosted only')
  t.ok(read('src/screens/Momentos.js').includes('if (node.hosted !== true ||'), 'viewer hosted only')
  t.ok(read('src/ui/MomentosStrip.js').includes("if (hosted !== true || !data || data.phase === 'off') return null"), 'strip hosted only')
  t.ok(read('src/ui/MomentosStrip.js').includes("if (hosted !== true || !data || data.phase !== 'ready') return null"), 'Diário section hosted only')
  t.ok(read('src/screens/ARua.js').includes('hosted={node.hosted === true}'), 'A Rua passes hosted')
  t.ok(read('src/screens/Diario.js').includes('hosted={node.hosted === true}'), 'Diário passes hosted')
})

test('App, nav and tabs wire the viewer', async (t) => {
  const app = read('App.js')
  t.ok(app.includes("pushScreen({ screen: 'momentos', key: key.toLowerCase(), params: {} })"), 'openMomentos')
  t.ok(app.includes("if (entry.screen === 'momentos') {"), 'stack branch')
  t.ok(app.includes('onOpenMomentos={openMomentos}'), 'A Rua and Diário open it')
  const { showPostButton } = await loadTabs()
  t.absent(showPostButton({ tab: 'rua', screen: 'momentos' }), 'no publish button on the viewer')
  t.ok(app.includes('{barsHidden ? null : <TabBar') && app.includes('const barsHidden = stacked || viewerLeaving'), 'no tab bar over a stacked screen')
  const strip = read('src/ui/MomentosStrip.js')
  t.ok(strip.includes("label={'momentos de ' + name}") && strip.includes("'seu momento'"), 'ring labels')
  t.ok(strip.includes("<Text style={styles.ringName} numberOfLines={1} ellipsizeMode='tail' maxFontSizeMultiplier={ROW_CAP}>{name}</Text>"), 'names on one line at a fixed size')
  t.ok(strip.includes("export const OWN_LIVE_TITLE = 'Seus momentos (24 h)'") && strip.includes("'Momentos anteriores (' + n + ')'"), 'Diário section titles')
  t.ok(strip.includes("label: 'Apagar', danger: true") && strip.includes('<MoreButton'), 'past moments: Apagar behind MoreButton')
})

test('seen store: valid ids only, once each, capped, persisted', async (t) => {
  const { createMomentSeenStore, isSeenId, seenListOf, withSeen, SEEN_MAX } = await loadSeen()
  t.ok(isSeenId(A + ':1'))
  t.absent(isSeenId(A + ':0'))
  t.absent(isSeenId(A.toUpperCase() + ':1'))
  t.absent(isSeenId(A + ':01'))
  t.alike(seenListOf([A + ':1', A + ':1', 'x', 3]), [A + ':1'])
  t.alike(withSeen([A + ':1'], B + ':2'), [A + ':1', B + ':2'])
  const many = Array.from({ length: SEEN_MAX + 5 }, (_, i) => A + ':' + (i + 1))
  t.is(seenListOf(many).length, SEEN_MAX)
  t.is(seenListOf(many)[0], A + ':6', 'oldest dropped')
  let stored = null
  const store = createMomentSeenStore({ read: () => stored, write: (raw) => { stored = raw } })
  t.alike(await store.load(), [])
  const heard = []
  const off = store.subscribe((list) => heard.push(list))
  t.ok(await store.mark(A + ':1'))
  t.absent(await store.mark('nope'))
  t.ok(await store.mark(A + ':1'), 'already seen')
  off()
  t.alike(JSON.parse(stored), [A + ':1'])
  t.is(heard.length, 1, 'one change heard')
  const again = createMomentSeenStore({ read: () => stored, write: () => {} })
  t.alike(await again.load(), [A + ':1'])
  const broken = createMomentSeenStore({ read: () => '{', write: () => {} })
  t.alike(await broken.load(), [])
})

test('momentsOf, liveAuthors, stripShown, ringSeen, canPublishMoment', async (t) => {
  const { momentsOf, liveAuthors, stripShown, ringSeen, canPublishMoment } = await loadSeen()
  const now = Date.parse('2026-11-07T12:00:00.000Z')
  const at = (h) => new Date(now - h * 3600000).toISOString()
  const item = (k, seq, h) => ({ seq, ref: k + ':' + seq, text: 't', at: at(h), media: {} })
  const r = momentsOf({
    authors: [{ author: B, items: [item(B, 2, 1), { bad: true }] }, { author: A, items: [item(A, 1, 1)] }, { author: 'x', items: [] }],
    own: [item(A, 3, 2)],
    past: [{ seq: 1, ref: A + ':1', text: 'old', at: at(30) }]
  }, A)
  t.alike(r.authors.map((a) => a.author), [B], 'own key and malformed authors left out')
  t.is(r.authors[0].items.length, 1)
  t.is(r.own.length, 1)
  t.is(r.past.length, 1)
  t.alike(momentsOf(null), { authors: [], own: [], past: [] })
  const live = liveAuthors([{ author: B, items: [item(B, 1, 25)] }, { author: C, items: [item(C, 1, 23), item(C, 2, 25)] }], now)
  t.alike(live.map((a) => [a.author, a.items.length]), [[C, 1]], 'expired items and empty authors dropped')
  t.absent(stripShown({ hosted: false, authors: [{}], own: [{}], canPublish: true }), 'never off hosted')
  t.absent(stripShown({ hosted: true, authors: [], own: [], canPublish: false }))
  t.ok(stripShown({ hosted: true, authors: [], own: [], canPublish: true }))
  t.ok(stripShown({ hosted: true, authors: [{}], own: [], canPublish: false }))
  t.ok(ringSeen([item(B, 1, 1)], [B + ':1']))
  t.absent(ringSeen([item(B, 1, 1), item(B, 2, 1)], [B + ':1']))
  t.absent(ringSeen([], []))
  t.ok(canPublishMoment({ hosted: true, media: { putMoment () {} } }))
  t.absent(canPublishMoment({ hosted: false, media: { putMoment () {} } }))
  t.absent(canPublishMoment({ hosted: true, media: null }))
})

test('web seen store reads and writes localStorage', async (t) => {
  const mem = new Map()
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) }
  t.teardown(() => { delete globalThis.localStorage })
  const { STORAGE_KEY } = await loadSeen()
  const web = await import('../src/momentSeenStore.web.js')
  t.alike(await web.loadMomentSeen(), [])
  await web.markMomentSeen(C + ':4')
  t.alike(JSON.parse(mem.get(STORAGE_KEY)), [C + ':4'])
})

test('review 1: the viewer runs, marks seen and closes only on top', (t) => {
  const src = read('src/screens/Momentos.js')
  t.ok(src.includes('function Viewer ({ entry, ownKey, isTop = true,'), 'isTop prop')
  t.ok(src.includes("if (itemKey !== '' && isTop && photo.phase !== 'loading') mark(itemKey)"), 'seen only on top')
  t.ok(src.includes('const running = active && loaded && autoOn') && src.includes('&& !musicWaiting,'), 'auto-advance only when unpaused and audio is not starting')
  t.ok(src.includes('active: isTop && node.visible !== false') && src.includes('const running = active && loaded && autoOn'), 'auto-advance only on top and visible')
  t.ok(src.includes("if (closingRef.current || !isTopRef.current || typeof onBack !== 'function') return"), 'goBack only on top')
  t.ok(read('App.js').includes('<Momentos entry={entry} ownKey={ownKey} isTop={i === stack.length - 1}'), 'App passes the top flag')
})

test('review 2: expired items leave the open viewer', (t) => {
  const src = read('src/screens/Momentos.js')
  t.ok(src.includes('const now = useNow(EXPIRY_TICK_MS)') && src.includes('export const EXPIRY_TICK_MS = 15000'), 'clock ticks while open')
  t.ok(src.includes('(expiresIn(it.at, now) > 0 &&') && src.includes('}, [now, rings, prune, hold, listed])'), 'each tick drops expired items')
  const pruneRings = loadPrune()
  const it = (a, n, live) => ({ ref: a + ':' + n, live })
  const keep = (x) => x.live
  const rings = [
    { author: A, items: [it(A, 1, true), it(A, 2, false), it(A, 3, true)], start: 0 },
    { author: B, items: [it(B, 1, false)], start: 0 },
    { author: C, items: [it(C, 1, true)], start: 0 }
  ]
  t.is(pruneRings(rings, { ring: 0, item: 0 }, () => true), null, 'nothing dropped')
  t.alike(pruneRings(rings, { ring: 0, item: 1 }, keep).pos, { ring: 0, item: 1 }, 'expired current item: the next one of the ring')
  t.alike(pruneRings(rings, { ring: 0, item: 2 }, keep).pos, { ring: 0, item: 1 }, 'a later item keeps its place')
  const moved = pruneRings(rings, { ring: 1, item: 0 }, keep)
  t.alike(moved.pos, { ring: 1, item: 0 }, 'emptied ring: the next ring takes its place')
  t.is(moved.rings[1].author, C)
  t.alike(pruneRings([rings[1]], { ring: 0, item: 0 }, keep), { close: true }, 'nothing left: close')
  t.alike(pruneRings([rings[0], rings[1]], { ring: 1, item: 0 }, keep), { close: true }, 'last ring emptied: close')
})

test('review 3: pulling A Rua also reloads the moments', (t) => {
  const src = read('src/screens/ARua.js')
  t.ok(src.includes('onRefresh={handleRefresh}'), 'the list refreshes through handleRefresh')
  t.ok(src.includes('const handleRefresh = () => {\n    reloadMoments()\n    return loadNewest()\n  }'), 'moments reload with the feed')
})

test('review 4: Trocar foto keeps the staged photo until a new one is picked', (t) => {
  const src = read('src/screens/Publicar.js')
  const body = fnBody(src, 'const pick = useCallback(async () =>')
  t.ok(body !== null)
  t.absent(body.includes('clearPhoto()'), 'no clear before the picker')
  t.ok(body.includes('replacingRef.current = items.length > 0 ? items.map((it) => it.id) : null'), 'old ids remembered')
  t.ok(src.includes('if (before !== null && fresh.length > 0) {'), 'old photo dropped only once a new one arrived')
})

test('review 5: a momento publish keeps the post draft and its photos', (t) => {
  const src = read('src/screens/Publicar.js')
  const send = fnBody(src, 'const sendMoment = async () =>')
  t.ok(send.indexOf('keepPostOnCloseRef.current = true') < send.indexOf("onPublished('moment', null)"), 'flag set before the shell closes the sheet')
  const close = src.slice(src.indexOf('    if (open) return\n    setEmojiOpen(false)'))
  t.ok(close.indexOf('if (keepPostOnCloseRef.current) {') < close.indexOf('removeItems(Array.from(liveRef.current))'), 'the close skips the photo cleanup')
  t.ok(src.includes("export const DRAFT_KEPT = 'Seu rascunho da publicação continua guardado.'"), 'the promise stays true')
})

test('review 6: only an increase of the request counter selects Momento', (t) => {
  const src = read('src/screens/Publicar.js')
  t.ok(src.includes("if (momentRequest > was) {\n      momentAskedRef.current = true\n      setMode('moment')"), 'an increase only')
  t.absent(src.includes('if (momentRequest === lastMomentRequest.current) return'), 'not any change')
})

test('round 3, 1: a close during the upload cancels moment.create', (t) => {
  const src = read('src/screens/Publicar.js')
  t.ok(src.includes('const moment = useMomentDraft({ node, member: me?.publicKey, open, active: open === true && momentMode })'), 'the draft knows when it is shown')
  t.ok(src.includes('if (!active) genRef.current++'), 'a close or mode switch moves the generation')
  const send = fnBody(src, 'const send = async () => {\n    if (busyRef.current || !valid)')
  const check = send.indexOf('if (gen !== genRef.current) return false')
  t.ok(send.indexOf('const gen = genRef.current') < send.indexOf('node.media.putMoment('), 'generation taken before the upload')
  t.ok(check > send.indexOf('node.media.putMoment(') && check < send.indexOf("node.request('moment.create'"), 'checked after the upload, before moment.create')
})

test('round 3, 2: pruneRings moves each ring start back by the items dropped before it', (t) => {
  const pruneRings = loadPrune()
  const it = (a, n, live) => ({ ref: a + ':' + n, live })
  const rings = [
    { author: A, items: [it(A, 1, true)], start: 0 },
    { author: B, items: [it(B, 1, false), it(B, 2, true), it(B, 3, true)], start: 1 }
  ]
  const r = pruneRings(rings, { ring: 0, item: 0 }, (x) => x.live)
  t.alike(r.rings[1].items.map((x) => x.ref), [B + ':2', B + ':3'])
  t.is(r.rings[1].start, 0, 'still the first unseen item, none skipped')
  const later = pruneRings([{ author: B, items: [it(B, 1, true), it(B, 2, false), it(B, 3, true)], start: 1 }, rings[0]], { ring: 1, item: 0 }, (x) => x.live)
  t.is(later.rings[0].start, 1, 'a dropped start item hands over to the next one')
})

test('round 3, 3: a moment request opens the composer as the person', (t) => {
  const app = read('App.js')
  const body = fnBody(app, 'const openMomentComposer = () =>')
  t.ok(body.includes('actingAs.me()'), 'page identity cleared for the open')
  t.ok(body.indexOf('actingAs.me()') < body.indexOf('setComposer('), 'before the composer opens')
})

test('round 4, 1: a create that finishes after a close never closes another composer', (t) => {
  const src = read('src/screens/Publicar.js')
  const send = fnBody(src, 'const send = async () => {\n    if (busyRef.current || !valid)')
  const create = send.indexOf("node.request('moment.create'")
  const after = send.indexOf('return gen === genRef.current')
  t.ok(after > create, 'generation checked again after moment.create')
  t.ok(send.indexOf('momentsChanged()', create) < after, 'moments still refresh')
  const wrap = fnBody(src, 'const sendMoment = async () =>')
  t.ok(wrap.indexOf('if (await moment.send()) {') < wrap.indexOf("onPublished('moment', null)"), 'onPublished only on a current success')
})

test('round 4, 2: seen only once the photo showed or failed', (t) => {
  const src = read('src/screens/Momentos.js')
  t.ok(src.includes("if (itemKey !== '' && isTop && photo.phase !== 'loading') mark(itemKey)"), 'not while loading')
  t.ok(src.includes('}, [itemKey, mark, isTop, photo.phase])'), 'runs again when the photo settles')
})

test('round 4, 3: playback stays held until the menu action ran', (t) => {
  const src = read('src/screens/Momentos.js')
  t.ok(src.includes('<ActionsSheet open={menuShown} onClose={closeMenu} actions={menuActions} />'), 'sheet and hold are separate')
  const close = fnBody(src, 'const closeMenu = () =>')
  t.absent(/setMenuOpen\(false\)\s*\n\s*\}/.test(close.split('setTimeout')[0]), 'closing the sheet does not release the hold at once')
  t.ok(close.includes('setTimeout(() => setMenuOpen(false), MENU_SETTLE_MS)'), 'released only after the action window')
  t.ok(src.includes('export const MENU_SETTLE_MS = 1000'), 'longer than the 700 ms ActionsSheet wait')
  const at = src.indexOf("label: 'Apagar',\n        danger: true,\n        onPress: () => {")
  t.ok(at > 0, 'the menu action')
  const act = src.slice(at, at + 300)
  t.ok(act.indexOf('setDeleting(menuTargetRef.current || item)') >= 0 && act.indexOf('setDeleting(menuTargetRef.current || item)') < act.indexOf('setMenuOpen(false)'), 'deleting holds playback before the menu hold ends')
  t.ok(read('src/ui/ActionsSheet.js').includes("Platform.OS === 'android' ? 320 : 700"), 'ActionsSheet still waits at most 700 ms')
})

test('verifier: closing the composer returns it to Publicação', (t) => {
  const src = readFileSync(join(__dirname, '../src/screens/Publicar.js'), 'utf8')
  t.absent(src.includes("useEffect(() => { if (!open) setMode('post') }, [open])"), 'no reset on the close (the sliding sheet kept its mode)')
  t.ok(src.includes("if (!momentAskedRef.current) setMode('post')") && src.indexOf('momentAskedRef.current = true') < src.indexOf("if (!momentAskedRef.current) setMode('post')"), 'each opening starts in Publicação unless a moment request came with it')
})

// The pure helpers of a screen file evaluated alone, as loadPrune does.
function loadFn (rel, start, name, prelude = '') {
  const src = read(rel)
  const at = src.indexOf(start)
  // eslint-disable-next-line no-new-func
  return new Function('displayText', prelude + src.slice(at + 'export '.length, src.indexOf('{', at)) + fnBody(src, start) + '\nreturn ' + name)
}

test('visual 1, 1: both composers avoid the keyboard with a measured offset', (t) => {
  const src = read('src/screens/Publicar.js')
  const wrap = fnBody(src, 'export function SheetKeyboard ({ children })')
  t.ok(wrap !== null, 'one wrapper')
  t.ok(wrap.includes("behavior='padding' keyboardVerticalOffset={top} enabled={avoidKeyboard}"), 'padding on Android, offset by the measured top')
  t.ok(wrap.includes('useKeyboardAvoidEnabled()'), 'Android pads only while the keyboard is open')
  t.ok(wrap.includes('view.measureInWindow(') && !wrap.includes("Platform.OS !== 'android'"), 'measured on iOS too')
  t.ok(wrap.includes("Keyboard.addListener('keyboardDidShow', measure)"), 'measured again when the keyboard opens')
  t.absent(src.includes("behavior={Platform.OS === 'ios' ? 'padding' : undefined}"), 'no composer left without Android padding')
  t.is((src.match(/<SheetKeyboard>/g) || []).length, 2, 'Momento and Publicação use it')
  t.ok(src.includes("keyboardDismissMode: 'interactive'") && src.includes('onLayout={momentView.handleLayout}') && src.includes('onContentSizeChange={momentView.handleContentSizeChange}'), 'the Momento body scrolls')
  const hook = fnBody(src, 'function useKeepInView (on, caretAtEnd = null, givenFieldRef = null)')
  const keep = fnBody(hook, 'const keep = useCallback(() =>')
  const scroll = fnBody(hook, 'const scrollIntoView = useCallback(() =>')
  t.ok(keep.includes('if (!focusRef.current || !view) return') && keep.includes('scrollIntoView()'), 'typing scrolls only while focused')
  t.ok(scroll && scroll.includes('scrollToEnd('), 'the shared helper scrolls the counter and hints into view')
})

test('Momento reveals the field and measured counter without focusing after a photo', (t) => {
  const src = read('src/screens/Publicar.js')
  const hook = fnBody(src, 'function useKeepInView (on, caretAtEnd = null, givenFieldRef = null)')
  const reveal = fnBody(hook, 'const reveal = useCallback(')
  t.ok(reveal, 'the hook exposes reveal')
  if (!reveal) return
  t.absent(reveal.includes('focusRef.current'), 'reveal does not depend on focus')
  t.ok(src.includes('ref={momentView.tailRef}') && src.includes("onLayout={(e) => momentView.handleTailLayout(e, 'body')}"), 'the counter reports its node and nested layout')
  const frames = []
  const scrolls = []
  const measurements = []
  let target = 300
  const useKeepInView = new Function('useRef', 'useCallback', 'useEffect', 'nextFrame', 'layoutOf', 'livePositions', 'keepInView', 'return function (on, caretAtEnd = null, givenFieldRef = null) ' + hook)( // eslint-disable-line no-new-func
    (current) => ({ current }), (fn) => fn, () => {}, (fn) => frames.push(fn),
    (e) => e.nativeEvent.layout, () => null,
    (size) => { measurements.push(size); return target }
  )
  const view = useKeepInView(true)
  const layout = (y, height) => ({ nativeEvent: { layout: { y, height } } })
  view.scrollRef.current = { scrollTo: (to) => scrolls.push(to), scrollToEnd: () => scrolls.push('end') }
  view.at('body')(layout(40, 600))
  view.at('field')(layout(300, 142))
  view.handleTailLayout(layout(450, 20), 'body')
  view.handleLayout(layout(0, 340))
  view.handleContentSizeChange(375, 700)
  view.defer()
  t.is(scrolls.length, 0, 'layout and typing do not scroll an unfocused field')
  t.is(frames.length, 0, 'defer still requires focus')
  view.reveal()
  t.alike(scrolls, [{ y: 300, animated: true }], 'reveal scrolls without a focus event')
  t.alike(measurements[0], { fieldY: 340, fieldHeight: 142, contentHeight: 700, viewHeight: 340, atEnd: false, tailBottom: 510 }, 'the nested counter uses content coordinates')
  view.handleFocus()
  view.defer()
  frames.shift()()
  t.alike(measurements[1], measurements[0], 'typing and reveal share their measurements')
  view.handleBlur()
  target = 'end'
  view.reveal()
  t.is(scrolls[2], 'end', 'reveal shares the scroll-to-end fallback')
  view.scrollRef.current = null
  view.reveal()
  t.is(scrolls.length, 3, 'an unmounted view is ignored')
})

test('Momento photo reveal runs once when ready and cancels on close or mode change', (t) => {
  const src = read('src/screens/Publicar.js')
  const effect = fnBody(src, 'useEffect(() => {\n    if (!open || !momentMode || !staged')
  t.ok(effect && effect.includes('momentView.reveal()'), 'the Momento effect reveals the photo caption')
  if (!effect) return
  t.ok(src.includes('const staged = moment.photo.items[0] || null') && src.includes('[open, momentMode, staged, moment.photo.ready, momentView.reveal]'), 'photo identity, readiness, sheet and mode drive cleanup')
  const run = new Function('open', 'momentMode', 'staged', 'moment', 'momentView', 'revealedMomentPhotoRef', 'nextFrame', effect) // eslint-disable-line no-new-func
  const frames = []
  const shown = []
  const ref = { current: null }
  const photo = { id: 1 }
  const replacement = { id: 2 }
  const schedule = (staged, ready = true, open = true, mode = true) => run(open, mode, staged, { photo: { ready } }, { reveal: () => shown.push(staged) }, ref, (fn) => frames.push(fn))
  schedule(null)
  schedule(photo, false)
  schedule(photo, true, false)
  schedule(photo, true, true, false)
  t.is(frames.length, 0, 'no reveal without a ready photo in an open Momento')
  const close = schedule(photo)
  t.is(shown.length, 0, 'waits for the next layout frame')
  close()
  frames.shift()()
  t.is(shown.length, 0, 'closing before the frame cancels reveal')
  const switchMode = schedule(photo)
  switchMode()
  frames.shift()()
  t.is(shown.length, 0, 'switching mode cancels reveal too')
  schedule(photo)
  frames.shift()()
  schedule(photo)
  t.alike(shown, [photo], 'a ready photo reveals once, even after reopening')
  t.is(frames.length, 0, 'the same photo queues no more work')
  schedule(replacement)
  frames.shift()()
  t.alike(shown, [photo, replacement], 'a replacement reveals again')
})

test('visual 1, 2: a swipe down closes once and never also steps', (t) => {
  const src = read('src/screens/Momentos.js')
  const close = fnBody(src, 'const close = useCallback(() =>')
  t.ok(close.includes('if (closingRef.current ||') && close.indexOf('closingRef.current = true') < close.indexOf('onBack()'), 'close runs once')
  t.ok(src.includes('onPanResponderGrant: () => {\n      draggedRef.current = true'), 'a drag marks itself')
  t.is((src.match(/onPress=\{\(e\) => \{ if \(!draggedRef\.current && !movedSincePressIn\(e\)\) step\('(?:prev|next)'\) \}\}/g) || []).length, 2, 'both halves ignore the press a drag ends with')
  t.is((src.match(/onPressIn=\{handleTapPressIn\}/g) || []).length, 3, 'the next press clears it (both halves and the caption)')
  t.ok(src.includes('draggedRef.current = false\n    pressStartRef.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY }'), 'and remembers where it started')
})

test('visual 1, 3: light status bar while the viewer is on top', (t) => {
  const app = read('App.js')
  t.ok(app.includes("const viewerOnTop = step === 'pronto' && topEntry !== null && topEntry.screen === 'momentos'"), 'viewer on top')
  t.ok(app.includes('statusBarStyle(scheme, { overBand: light || viewerOnTop })'), 'light over the black viewer, the scheme again after')
  t.absent(/const bandShown = [^\n]*viewerOnTop/.test(app), 'no band colour for the viewer')
})

test('visual 1, 4: the reply context names a moment', async (t) => {
  const { replyContext } = await import('../src/moments.js')
  t.is(replyContext({ seq: 1, at: '2026-11-07T12:00:00.000Z', text: '' }, A).kind, 'moment')
})

test('visual 1, 5: white note and time', (t) => {
  const src = read('src/screens/Momentos.js')
  t.absent(src.includes("backgroundColor: 'rgba(0,0,0,0.55)'") || src.includes("backgroundColor: 'rgba(0,0,0,0.25)'"), 'no hard-edged band')
  t.ok(src.includes("note: { flex: 1, minWidth: 160, color: 'rgba(255,255,255,0.8)', ...TEXT_SHADOW }") && src.includes("time: { ...type.postMeta, color: 'rgba(255,255,255,0.8)', ...TEXT_SHADOW }"), 'note and time in white at 0.8')
})

test('visual 1, 6 and 7: ring names are the first word, the plus ring has no ring', (t) => {
  const strip = read('src/ui/MomentosStrip.js')
  const ringName = loadFn('src/ui/MomentosStrip.js', 'export function ringName (title)', 'ringName')((x) => x)
  t.is(ringName('João Nascimento'), 'João')
  t.is(ringName('  Cecília  Ramos '), 'Cecília')
  t.is(ringName('@andre'), '@andre')
  t.is(ringName(null), '')
  t.ok(strip.includes('name={ringName(name)}') && strip.includes("label={'momentos de ' + name}"), 'first word shown, full name read')
  t.absent(code('src/ui/MomentosStrip.js').includes('adjustsFontSizeToFit'), 'no unbounded shrink')
  t.ok(strip.includes("strip: { flexDirection: 'row', gap: 8,"), 'gap 8 between rings')
  t.ok(strip.includes("borderColor: plus ? 'transparent' :"), 'no ring colour on the plus ring')
  t.ok(strip.includes("label={own.length === 0 ? 'novo momento' : 'seu momento'}"), 'plus ring labelled novo momento')
})

test('visual 1, 8: deleting the only own moment closes the viewer', (t) => {
  const closesAfterDelete = loadFn('src/screens/Momentos.js', 'export function closesAfterDelete (ring, own, target)', 'closesAfterDelete')()
  const one = { author: A, items: [{ ref: A + ':1' }] }
  t.ok(closesAfterDelete(one, A, { ref: A + ':1' }), 'own ring emptied: close')
  t.absent(closesAfterDelete({ author: A, items: [{ ref: A + ':1' }, { ref: A + ':2' }] }, A, { ref: A + ':1' }), 'own ring keeps one: stay')
  t.absent(closesAfterDelete({ author: B, items: [{ ref: B + ':1' }] }, A, { ref: B + ':1' }), 'not the own ring')
  const src = read('src/screens/Momentos.js')
  const removed = fnBody(src, 'const removed = useCallback((target) =>')
  t.ok(removed.indexOf('closesAfterDelete(rings[pos.ring], own, target)) return close()') < removed.indexOf('prune('), 'checked before the prune')
})

test('visual 1, 9 to 11: Momento box height, Diário rows, past delete body', (t) => {
  const pub = read('src/screens/Publicar.js')
  t.ok(pub.includes('export const MOMENT_MIN_HEIGHT = 5 * 24 + 20 + 2') && pub.includes('export const MOMENT_MAX_HEIGHT = 6 * 24 + 20 + 2') && pub.includes('minHeight: MOMENT_MIN_HEIGHT, maxHeight: MOMENT_MAX_HEIGHT'), 'about five lines, inner scroll past six')
  const strip = read('src/ui/MomentosStrip.js')
  t.ok(strip.includes("<Icon name='imagem' size={20} color={colors.soft} />"), 'past row: imagem icon')
  t.absent(fnBody(strip, 'export function DiarioMoments').includes("<Icon name='lixeira'"), 'no trash icon on a row')
  t.ok(strip.includes('<Text style={styles.rowText} numberOfLines={1} maxFontSizeMultiplier={ROW_CAP}>{OWN_LIVE_TITLE}</Text>') && strip.includes('<Text style={styles.rowText} numberOfLines={1} maxFontSizeMultiplier={ROW_CAP}>{PAST_TITLE}</Text>'), 'row titles capped on one line')
  t.ok(strip.includes('<Text style={styles.meta} maxFontSizeMultiplier={ROW_CAP}>{String(past.length)}</Text>'), 'the count apart, never cut')
  const src = read('src/screens/Momentos.js')
  t.ok(src.includes("export const DELETE_BODY_PAST = 'O momento sai do seu diário. Já não aparece para ninguém.'"), 'past body covers photos and videos')
  t.ok(src.includes('{target && expiresIn(target.at) === 0 ? DELETE_BODY_PAST : DELETE_BODY}'), 'chosen by the 24-hour end')
})

test('visual 2, 1: solid scrims behind the text, a real gradient past it, a text shadow', (t) => {
  const scrim = read('src/ui/Scrim.js')
  t.ok(scrim.includes("export const scrimColor = (alpha) => 'rgba(0,0,0,' + alpha + ')'"))
  const scrimGradient = loadFn('src/ui/Scrim.js', 'export function scrimGradient (edge, alpha)', 'scrimGradient', "const scrimColor = (alpha) => 'rgba(0,0,0,' + alpha + ')';")()
  t.is(scrimGradient('top', 0.55), 'linear-gradient(to bottom, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 100%)', 'top: solid side first')
  t.is(scrimGradient('bottom', 0.6), 'linear-gradient(to top, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0) 100%)', 'bottom: solid side last')
  t.ok(scrim.includes("const imageKey = Platform.OS === 'web' ? 'backgroundImage' : 'experimental_backgroundImage'"), 'CSS gradient on web, experimental_backgroundImage on iOS and Android')
  t.ok(scrim.includes("{edge === 'top' ? [solid, ramp] : [ramp, solid]}"), 'solid part at the edge, fade towards the photo')
  t.absent(scrim.includes('flex: 1, backgroundColor'), 'no equal bands')
  const src = read('src/screens/Momentos.js')
  t.ok(src.includes('export const TOP_SCRIM = { alpha: 0.55, fade: 32 }') && src.includes('export const BOTTOM_SCRIM = { alpha: 0.6, fade: 48 }'), 'solid 0.55 at the top, 0.6 at the bottom')
  t.absent(src.includes('bandsOf'), 'the stacked bands are gone')
  t.ok(src.includes("<Scrim edge='top' alpha={TOP_SCRIM.alpha} fade={TOP_SCRIM.fade} style={styles.topScrim} />") && src.includes("<Scrim edge='bottom' alpha={BOTTOM_SCRIM.alpha} fade={BOTTOM_SCRIM.fade} style={styles.bottomScrim} />"), 'both scrims')
  t.ok(src.includes("topScrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: -TOP_SCRIM.fade }"), 'top: solid to the header row bottom, fade past it')
  t.ok(src.includes("bottomScrim: { position: 'absolute', top: -BOTTOM_SCRIM.fade, left: 0, right: 0, bottom: 0 }"), 'bottom: fade above the content, solid behind it')
  t.ok(src.includes("const TEXT_SHADOW = { textShadowColor: 'rgba(0,0,0,0.6)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4 }"), 'text shadow')
  for (const style of ['name: {', 'time: {', 'text: {', 'note: {']) {
    const at = src.indexOf('  ' + style, src.indexOf('const makeStyles'))
    t.ok(src.slice(at, src.indexOf('\n', at)).includes('...TEXT_SHADOW'), style + ' shadowed')
  }
})

test('visual 2, 2: iOS composers inset for the keyboard, the Momento end scrolls into view', (t) => {
  const src = read('src/screens/Publicar.js')
  t.ok(src.includes("const IOS_SCROLL_INSETS = Platform.OS === 'ios'"), 'iOS only')
  const wrap = fnBody(src, 'export function SheetKeyboard ({ children })')
  t.ok(wrap.indexOf('if (IOS_SCROLL_INSETS) return <View style={styles.flex}>{children}</View>') < wrap.indexOf('<KeyboardAvoidingView'), 'no padding on iOS, Android keeps the measured padding')
  t.ok(src.includes("keyboardShouldPersistTaps: 'handled',\n  keyboardDismissMode: 'interactive',\n  ...(IOS_SCROLL_INSETS ? { automaticallyAdjustKeyboardInsets: true } : {})"), 'the ScrollView insets itself on iOS')
  t.is((src.match(/\{\.\.\.COMPOSER_SCROLL\}/g) || []).length, 2, 'Momento and Publicação')
  const hook = fnBody(src, 'function useKeepInView (on, caretAtEnd = null, givenFieldRef = null)')
  const defer = fnBody(hook, 'const defer = useCallback(() =>')
  t.ok(defer.includes('if (!focusRef.current) return') && defer.includes('nextFrame(() => keep())') && src.includes('globalThis.requestAnimationFrame(fn)'), 'deferred a frame, only while focused')
  t.ok(hook.includes("Keyboard.addListener('keyboardDidShow', (e) => {") && hook.includes('defer()'), 'on the keyboard opening')
  t.ok(src.includes('onChangeText={typeMoment}') && fnBody(src, 'const typeMoment = (value) =>').includes('momentView.defer()'), 'on every keystroke')
})

test('visual 2, 3 to 5: the delete acts on the menu item, follows the node list, cannot be swiped away mid-delete', (t) => {
  const src = read('src/screens/Momentos.js')
  const open = fnBody(src, 'const openMenu = () =>')
  t.ok(open.includes('menuTargetRef.current = item'), 'the item captured when the menu opens')
  t.ok(src.includes('const hold = deleting !== null ? deleting.ref : menuOpen ? itemKey : null'), 'the item under the menu or the sheet is held')
  t.ok(src.includes('const keep = (it) => it.ref === hold || (expiresIn(it.at, now) > 0 && (listed === null || listed.has(it.ref)))'), 'prune by expiry and by membership, never the held item')
  const listedRefs = loadFn('src/screens/Momentos.js', 'export function listedRefs (data)', 'listedRefs')()
  t.is(listedRefs({ phase: 'loading' }), null, 'nothing before an answer')
  const refs = listedRefs({ phase: 'ready', own: [{ ref: A + ':1' }], authors: [{ author: B, items: [{ ref: B + ':2' }] }] })
  t.alike([...refs].sort(), [A + ':1', B + ':2'].sort(), 'own and followed refs')
  const pruneRings = loadPrune()
  const rings = [{ author: A, items: [{ ref: A + ':1' }, { ref: A + ':2' }], start: 0 }]
  t.alike(pruneRings(rings, { ring: 0, item: 0 }, (it) => refs.has(it.ref)).rings[0].items, [{ ref: A + ':1' }], 'a moment gone from the list leaves the rings')
  t.ok(src.includes('<Sheet open={open} onClose={pending ? () => {} : onClose} dismissable={!pending} title={DELETE_TITLE}>'), 'no swipe-down while pending')
  t.ok(src.includes('onClose={() => setDeleting(null)}'), 'any other dismissal clears deleting')
})

test('visual 2, 6: no tab bar or publish button over the closing viewer', (t) => {
  const app = read('App.js')
  t.ok(app.includes("const viewerLeaving = leavingEntry !== null && leavingEntry.screen === 'momentos'"), 'the popped entry is the viewer')
  t.ok(app.includes('const fabShown = !viewerLeaving && showPostButton('), 'no publish button during its pop')
})

test('visual 2, 7 and 8: the Momento field grows on the web, the past row says expanded', (t) => {
  const pub = read('src/screens/Publicar.js')
  const momentFieldHeight = loadFn('src/screens/Publicar.js', 'export function momentFieldHeight (contentHeight)', 'momentFieldHeight', 'const MOMENT_MIN_HEIGHT = 142; const MOMENT_MAX_HEIGHT = 166;')()
  t.is(momentFieldHeight(40), 142, 'never below five lines')
  t.is(momentFieldHeight(150.2), 153, 'the content plus its border')
  t.is(momentFieldHeight(164), 166, 'six lines plus the border: no inner scroll')
  t.is(momentFieldHeight(400), 166, 'never past six lines')
  t.is(momentFieldHeight(NaN), 142)
  t.ok(pub.includes("const GROW_BY_CONTENT = Platform.OS === 'web'"), 'web only')
  t.ok(pub.includes('style={[styles.momentInput, GROW_BY_CONTENT && { height: momentHeight }]}') && pub.includes('onContentSizeChange={growMoment}'), 'height from the content size')
  t.ok(read('src/ui/MomentosStrip.js').includes('aria-expanded={expanded}'), 'aria-expanded for react-native-web')
})

test('visual 3, 1: a close the stack ignored never stays latched on top', (t) => {
  const src = read('src/screens/Momentos.js')
  t.ok(src.includes('const CLOSE_RELEASE_MS = STACK_MS + 150') && src.includes("import { STACK_MS } from '../stackMotion'"), 'released after the stack slide time')
  t.ok(src.includes('if (isTop) {\n      closingRef.current = false\n      setMusicClosed(false)\n    }\n  }, [isTop])'), 'close and music released when the viewer is on top again')
  const close = fnBody(src, 'const close = useCallback(() =>')
  t.ok(close.indexOf('closingRef.current = true') < close.indexOf('setTimeout(') && close.indexOf('setTimeout(') < close.indexOf('onBack()'), 'the release timer starts with the close')
  const timer = close.slice(close.indexOf('setTimeout('))
  t.ok(timer.indexOf('if (!isTopRef.current) return') < timer.indexOf('closingRef.current = false'), 'only while still the top screen (a real pop leaves it latched)')
  t.ok(timer.includes('drag.setValue(0)') && timer.includes('setDragging(false)'), 'an ignored swipe-down close puts the photo back')
  t.ok(src.includes('useEffect(() => () => clearTimeout(closeTimer.current), [])'), 'timer cleared on unmount')
})

test('visual 3, 2: the caption scrolls inside 40% of the window, scrims never leave a band', (t) => {
  const src = read('src/screens/Momentos.js')
  t.ok(src.includes('export const CAPTION_MAX_SHARE = 0.4') && src.includes('const share = Math.round(height * CAPTION_MAX_SHARE)'), 'about 40% of the window')
  t.ok(src.includes('style={[styles.caption, { maxHeight: captionMax }]}') && src.includes('caption: { flexGrow: 0 },'), 'capped, sized by its text below the cap')
  t.ok(src.includes('scrollEnabled={captionScrolls}') && src.includes('const captionScrolls = captionHeight > captionMax'), 'scrolls only when it overflows')
  t.ok(src.includes('<Text style={styles.text} selectable={false}>{text}</Text>\n                </Pressable>\n              </ScrollView>'), 'the caption text inside the scroll')
  t.ok(src.includes('g.dy > 12 && g.dy > Math.abs(g.dx) * 1.5 && !(captionTouchRef.current && captionOffsetRef.current > 0)'), 'a drag down on a scrolled caption scrolls it back, never closes')
  const scrimsMeet = loadFn('src/screens/Momentos.js', 'export function scrimsMeet (topEnd, bottomStart)', 'scrimsMeet', 'const TOP_SCRIM = { alpha: 0.55, fade: 32 }; const BOTTOM_SCRIM = { alpha: 0.6, fade: 48 }; const SCRIM_MIN_CLEAR = 96;')()
  t.absent(scrimsMeet(120, 500), 'far apart: two fades')
  t.ok(scrimsMeet(120, 199), 'closer than both fades: solid')
  t.ok(scrimsMeet(120, 295), 'a strip of photo under 96 between the fades still merges (no light band)')
  t.absent(scrimsMeet(120, 296), 'both fades plus 96 of clear photo: two fades')
  t.absent(scrimsMeet(NaN, 300), 'unmeasured: the fades')
  t.ok(src.includes('{meet ? <View style={[styles.fullScrim, { backgroundColor: scrimColor(BOTTOM_SCRIM.alpha) }]} pointerEvents=\'none\' /> : null}'), 'one solid scrim when they meet')
  t.ok(src.includes("{meet ? null : <Scrim edge='top'") && src.includes("{meet ? null : <Scrim edge='bottom'"), 'the fades dropped then')
  t.ok(src.includes('onLayout={(e) => setTopEnd(e.nativeEvent.layout.y + e.nativeEvent.layout.height)}') && src.includes('onLayout={(e) => setBottomHeight(e.nativeEvent.layout.height)}') && src.includes('const bottomStart = frameHeight - bottomHeight'), 'measured with onLayout, from sizes that fire on every resize')
  t.absent(/\bPlatform\b/.test(code('src/screens/Momentos.js')), 'no Platform in the viewer')
})

test('visual 3, 3 and 4: both composers keep the field and its counter in view', (t) => {
  // Destructured parameters: the function source whole, through its body.
  const pubSrc = read('src/screens/Publicar.js')
  const head = 'export function keepInView ({ fieldY, fieldHeight, contentHeight, viewHeight, atEnd = false, tailBottom = NaN })'
  t.ok(pubSrc.includes('export const KEEP_GAP = 8'), 'an 8 pt gap')
  // eslint-disable-next-line no-new-func
  const keepInView = new Function('const KEEP_GAP = 8; const CARET_LINE = 32;\n' + head.slice('export '.length) + ' ' + fnBody(pubSrc, head) + '\nreturn keepInView')()
  t.is(keepInView({ fieldY: 100, fieldHeight: 142, contentHeight: 500, viewHeight: 600 }), 'end', 'everything fits: the end, as round 3')
  t.is(keepInView({ fieldY: 100, fieldHeight: 142, contentHeight: 900, viewHeight: 300 }), 92, 'large text: the field pinned 8 under the top, never under the header')
  t.is(keepInView({ fieldY: 4, fieldHeight: 142, contentHeight: 900, viewHeight: 300 }), 0, 'never above the start')
  t.is(keepInView({ fieldY: 100, fieldHeight: 800, contentHeight: 1200, viewHeight: 300 }), null, 'a field taller than the view: the native caret tracking')
  t.is(keepInView({ fieldY: 100, fieldHeight: 800, contentHeight: 1200, viewHeight: 300, atEnd: true }), 'end', 'with the caret at the end: the end, so the toolbar and counter show (reopened draft)')
  t.is(keepInView({ fieldY: 100, fieldHeight: 280, contentHeight: 700, viewHeight: 300, atEnd: true, tailBottom: 450 }), 150, 'field fits, its toolbar row does not: scrolled to show the row (Android 1.3, 14 lines)')
  t.is(keepInView({ fieldY: 100, fieldHeight: 120, contentHeight: 900, viewHeight: 300, atEnd: true, tailBottom: 700 }), 188, 'photos between them: never past the caret line')
  t.is(keepInView({ fieldY: 100, fieldHeight: 280, contentHeight: 700, viewHeight: 300, tailBottom: 450 }), 92, 'caret not at the end: the field pinned, as before')
  t.is(keepInView({ fieldY: NaN, fieldHeight: 142, contentHeight: 900, viewHeight: 300 }), 'end', 'unmeasured: the end')
  const src = read('src/screens/Publicar.js')
  const hook = fnBody(src, 'function useKeepInView (on, caretAtEnd = null, givenFieldRef = null)')
  t.ok(hook.includes('view.scrollTo({ y: to, animated: true })') && hook.includes('view.scrollToEnd({ animated: true })'), 'pinned or the end')
  t.ok(hook.includes('m.current.keyboard = IOS_SCROLL_INSETS ? keyboardHeight(e) : 0') && hook.includes('viewHeight: s.view - s.keyboard'), 'iOS: the keyboard inset leaves the visible part')
  t.ok(src.includes('const momentView = useKeepInView(momentMode)') && src.includes('const postView = useKeepInView(open && !momentMode, postCaretAtEnd, inputRef)'), 'one per composer, the post one knows when its caret is at the end')
  t.ok(src.includes("<View style={styles.momentBody} onLayout={momentView.at('body')}>") && src.includes("onLayout={momentView.at('field')}"), 'Momento: field y from the body and the field')
  t.ok(src.includes("<View style={styles.compose} onLayout={postView.at('compose')}>") && src.includes("<View style={styles.composeBody} onLayout={postView.at('composeBody')}>") && src.includes("onLayout={postView.at('field')}"), 'Publicação: field y through its wrappers')
  t.ok(src.includes('onChangeText={typePost}') && fnBody(src, 'const typePost = (value) =>').includes('postView.defer()'), 'Publicação: every keystroke and paste')
  t.ok(src.includes('ref={postView.scrollRef}') && src.includes('onContentSizeChange={postView.handleContentSizeChange}'), 'Publicação: the body scroll measured')
  t.ok(src.includes('onFocus={postView.handleFocus}') && src.includes('onFocus={momentView.handleFocus}'), 'only while focused')
})

test('visual 4: a new moment starts its caption at the top; text is never mouse-selected', (t) => {
  const src = readFileSync(join(__dirname, '../src/screens/Momentos.js'), 'utf8')
  t.ok(src.includes('key={itemKey}') && src.includes('captionOffsetRef.current = 0'), 'the caption scroll resets per moment')
  t.ok(src.includes('<Text style={styles.text} selectable={false}>{text}</Text>'), 'caption not selectable')
  t.ok(src.includes('<Text style={styles.name} numberOfLines={1} selectable={false}>'), 'name not selectable')
})

test('review 4: an undecodable photo shows Foto indisponível', (t) => {
  const src = readFileSync(join(__dirname, '../src/screens/Momentos.js'), 'utf8')
  t.ok(src.includes('onError={handlePhotoError}') && src.includes('const handlePhotoError = photo.fail'), 'the Image reports a decode failure')
  t.ok(src.includes("const fail = useCallback(() => setState((s) => (s.key === key ? { key, phase: 'off', uri: null } : s)), [key])"), 'which turns the photo off')
})

test('visual 4 (iOS XXXL): the caption cap leaves the header and the bar free', (t) => {
  const src = readFileSync(join(__dirname, '../src/screens/Momentos.js'), 'utf8')
  const head = 'export function captionCap ({ height, topEnd, barHeight = 0, bottomPad = 0 })'
  const captionCap = new Function('const CAPTION_MAX_SHARE = 0.4; const CAPTION_CLEAR = 24; const CAPTION_MIN = 72;\n' + head.slice('export '.length) + ' ' + fnBody(src, head) + '\nreturn captionCap')() // eslint-disable-line no-new-func
  t.is(captionCap({ height: 800, topEnd: NaN }), 320, 'unmeasured: 40% of the window')
  t.is(captionCap({ height: 800, topEnd: 100, barHeight: 60, bottomPad: 40 }), 320, 'room to spare: still 40%')
  t.is(captionCap({ height: 800, topEnd: 300, barHeight: 160, bottomPad: 40 }), 276, 'largest text: only the room between the header and the bar')
  t.is(captionCap({ height: 600, topEnd: 400, barHeight: 160, bottomPad: 40 }), 72, 'never below about three lines')
  t.ok(src.includes('const captionMax = captionCap({ height: win.height, topEnd, barHeight: barHeight + (playbackControls ? playbackHeight + 12 : 0), bottomPad: insets.bottom + 12 })'), 'the viewer uses it')
})

test('visual 4 (Android): a drag down on a scrolling caption at its top closes', (t) => {
  const src = readFileSync(join(__dirname, '../src/screens/Momentos.js'), 'utf8')
  t.ok(src.includes('captionStartRef.current = { y: e.nativeEvent.pageY, atTop: captionOffsetRef.current <= 0 }'), 'the touch remembers where it started and whether the caption was at its top')
  t.ok(src.includes('if (start !== null && start.atTop && captionOffsetRef.current <= 0 && e.nativeEvent.pageY - start.y > CLOSE_DRAG) close()'), 'and closes past the same distance as the photo swipe')
  t.ok(src.includes('onTouchStart={handleCaptionTouchStart}') && src.includes('onTouchEnd={handleCaptionTouchEnd}'), 'wired on the caption')
})

test('visual 5 (web): the moment publish does not flip the closing sheet; a bad photo error sits under the tile', (t) => {
  const src = readFileSync(join(__dirname, '../src/screens/Publicar.js'), 'utf8')
  const send = src.slice(src.indexOf('const sendMoment = async () => {'), src.indexOf('const handlePickMoment'))
  t.absent(send.includes("setMode('post')"), 'no mode flip while the sheet slides away')
  t.ok(src.includes("{staged && staged.status === 'invalid' ? <ErrorText>{staged.error || 'não foi possível abrir a foto'}</ErrorText> : null}"), 'the error under the tile')
})

test('visual 5 (iOS): the caption is a tap zone, previous on the left and next on the right', (t) => {
  const src = readFileSync(join(__dirname, '../src/screens/Momentos.js'), 'utf8')
  t.ok(src.includes("onPress={(e) => { if (!draggedRef.current && !movedSincePressIn(e)) step(e.nativeEvent.pageX < win.width / 2 ? 'prev' : 'next') }}"), 'a tap on the caption steps by its side')
  const cap = src.slice(src.indexOf('<ScrollView\n                key={itemKey}'), src.indexOf('</ScrollView>', src.indexOf('<ScrollView\n                key={itemKey}')))
  t.ok(cap.includes('onPressIn={handleTapPressIn}') && cap.includes('onPressOut={() => setHeld(false)}') && cap.includes('delayLongPress={250}'), 'a hold on the caption pauses like the halves')
})

test('visual 5 (Android): a cancelled caption drag that went down from the top closes', (t) => {
  const src = readFileSync(join(__dirname, '../src/screens/Momentos.js'), 'utf8')
  t.ok(src.includes('onTouchMove={handleCaptionTouchMove}') && src.includes('onTouchCancel={handleCaptionTouchCancel}'), 'moves and the cancel are followed')
  t.ok(src.includes('if (start === null || !start.atTop || !Number.isFinite(start.lastY) || start.lastY - start.y <= CAPTION_PULL) return'), 'only a drag down that started at the top')
  t.ok(src.includes('setTimeout(() => { if (captionOffsetRef.current <= 0) close() }, CAPTION_PULL_SETTLE_MS)'), 'closes once the caption shows it did not scroll')
  t.ok(src.includes('useEffect(() => () => clearTimeout(captionPullTimer.current), [])'), 'never after the viewer is gone')
})

test('visual 6 (web): a quick drag is not a tap; the viewer root mounts fresh to be measured', (t) => {
  const src = readFileSync(join(__dirname, '../src/screens/Momentos.js'), 'utf8')
  t.ok(src.includes('const TAP_SLOP = 10') && src.includes('return Math.abs(e.nativeEvent.pageX - start.x) > TAP_SLOP || Math.abs(e.nativeEvent.pageY - start.y) > TAP_SLOP'), 'a press that moved past 10 is no tap')
  t.ok(src.includes("<View key='stage' style={styles.root} onLayout={(e) => setFrameHeight(e.nativeEvent.layout.height)}>"), 'the root is its own element, so its height is observed on the web')
})

test('visual 6 (iOS): a caption tap that steps never leaves the next moment held', (t) => {
  const src = readFileSync(join(__dirname, '../src/screens/Momentos.js'), 'utf8')
  const effect = src.slice(src.indexOf('captionOffsetRef.current = 0\n'), src.indexOf('}, [itemKey])'))
  t.ok(effect.includes('setHeld(false)'), 'the hold is cleared whenever the moment changes')
})

test('visual 7 (iOS): a published moment keeps its form while the sheet slides away', (t) => {
  const src = readFileSync(join(__dirname, '../src/screens/Publicar.js'), 'utf8')
  const send = src.slice(src.indexOf("await node.request('moment.create'"), src.indexOf('} catch (err) {', src.indexOf("await node.request('moment.create'")))
  t.absent(send.includes('reset()'), 'no reset on success')
  t.ok(send.includes('publishedRef.current = true'), 'only marked published')
  t.ok(src.includes('if (open && !wasOpenRef.current && publishedRef.current) {\n      publishedRef.current = false\n      reset()'), 'emptied on the next opening')
})

test('visual 7 (web): presses start at once; each composer mode owns its ScrollView', (t) => {
  const src = readFileSync(join(__dirname, '../src/screens/Momentos.js'), 'utf8')
  t.is((src.match(/delayPressIn=\{0\}\n\s+onPressIn=\{handleTapPressIn\}/g) || []).length, 3, 'the halves and the caption take the press start from the pointer down (web delays it 50 ms by default)')
  const pub = readFileSync(join(__dirname, '../src/screens/Publicar.js'), 'utf8')
  t.ok(pub.includes("key='moment'\n            ref={momentView.scrollRef}") && pub.includes("key='post'\n          ref={postView.scrollRef}"), 'Momento and Publicação mount their own ScrollView')
  t.ok(pub.includes("if (typeof view.getScrollableNode === 'function' && !view.getScrollableNode()) return"), 'and never scroll a view whose node is gone')
})

test('visual 7 (Android): the post toolbar row is measured for the keep-in-view', (t) => {
  const pub = readFileSync(join(__dirname, '../src/screens/Publicar.js'), 'utf8')
  t.ok(pub.includes('<View ref={postView.tailRef} style={styles.counterRow} onLayout={postView.handleTailLayout}>'), 'the toolbar and counter row reports its bottom')
  t.ok(pub.includes('atEnd, tailBottom })') && pub.includes('const tailBottom = live ? live.tailBottom : s.tailBottom'), 'and keepInView uses it')
})

test('visual 8 (web): keep-in-view reads live positions; a drag on the header opens no profile', (t) => {
  const pub = readFileSync(join(__dirname, '../src/screens/Publicar.js'), 'utf8')
  const head = 'export function livePositions (view, fieldNode, tailNode)'
  const livePositions = new Function(head.slice('export '.length) + ' ' + fnBody(pub, head) + '\nreturn livePositions')() // eslint-disable-line no-new-func
  const rect = (top, height) => ({ getBoundingClientRect: () => ({ top, height, bottom: top + height }) })
  const scroll = { ...rect(50, 300), scrollTop: 100 }
  t.is(livePositions({ getScrollableNode: () => 123 }, rect(0, 10), null), null, 'native: a number node, the measured layout stands')
  t.is(livePositions({}, rect(0, 10), null), null, 'no scrollable node: the measured layout')
  t.is(livePositions({ getScrollableNode: () => scroll }, null, null), null, 'no field node: the measured layout')
  t.alike(livePositions({ getScrollableNode: () => scroll }, rect(112, 142), rect(300, 44)), { fieldY: 162, fieldHeight: 142, tailBottom: 394 }, 'content coordinates: the rect minus the origin, plus the scroll')
  t.ok(pub.includes('ref={momentView.fieldRef}') && pub.includes('useKeepInView(open && !momentMode, postCaretAtEnd, inputRef)') && pub.includes('<View ref={postView.tailRef} style={styles.counterRow}'), 'both composers hand their nodes in')
  const src = readFileSync(join(__dirname, '../src/screens/Momentos.js'), 'utf8')
  t.ok(src.includes('onPress={(e) => { if (!movedSincePressIn(e)) openProfile() }}'), 'the header opens the profile only on a real tap')
})

test('visual 9 (web): the post caret is read from the field and starts at the end of a saved draft', (t) => {
  const pub = readFileSync(join(__dirname, '../src/screens/Publicar.js'), 'utf8')
  t.ok(pub.includes("if (node && typeof node.selectionStart === 'number' && typeof node.value === 'string') return node.selectionStart >= node.value.length"), 'caret at the end, from the live field (the selection event lags a keystroke)')
  t.ok(pub.includes('selRef.current = { start: end, end }\n        setForcedSel({ start: end, end })'), 'a field mounted with a draft starts its caret at the end')
  t.ok(pub.includes("if (end > 0 && node && typeof node.selectionStart === 'number') {"), 'only where the field has its own selection (the web)')
})

test('visual 10 (web): a long draft shows its caret line; closing freezes the viewer', (t) => {
  const pub = readFileSync(join(__dirname, '../src/screens/Publicar.js'), 'utf8')
  t.ok(pub.includes('setForcedSel({ start: end, end })\n        // A long draft: show the caret line, not the top of the text.\n        node.scrollTop = node.scrollHeight'), 'the field scrolls to the caret at the end')
  const src = readFileSync(join(__dirname, '../src/screens/Momentos.js'), 'utf8')
  t.ok(src.includes('if (rings === null || closingRef.current) return'), 'no prune while the viewer closes')
})

test('momentsOf keeps valid music through repeated cleaning and drops malformed music', async (t) => {
  const { momentsOf } = await loadSeen()
  const { holdMsOf, MUSIC_HOLD_MS } = await import('../src/moments.js')
  const plain = { seq: 1, ref: A + ':1', text: 't', at: '2026-11-07T10:00:00.000Z', media: {} }
  for (const music of [undefined, null, { p: 'audius', id: 'abc', start: -1 }, { p: 'other', id: 'abc', start: 0 }, { p: 'audius', id: 'abc', start: 30 }]) {
    const item = music === undefined ? plain : { ...plain, music }
    const answer = { authors: [{ author: A, items: [item] }], own: [item], past: [item] }
    const cleaned = momentsOf(answer, B)
    const valid = music?.p === 'audius' && music.start === 30
    const expected = valid ? { ...plain, music: { id: 'abc', start: 30 } } : plain
    t.alike(cleaned, { authors: [{ author: A, items: [expected] }], own: [expected], past: [expected] })
    t.alike(momentsOf(cleaned, B), cleaned)
    if (valid) t.is(holdMsOf(cleaned.authors[0].items[0], true), MUSIC_HOLD_MS)
    else t.absent(Object.hasOwn(cleaned.own[0], 'music'))
  }
})

// The real hooks and JSX, with local host elements and deterministic effects.
// Cleanups run before the next effects, as they do on a React commit.
function hookHost (source, name, deps, setup = '') {
  const { transformSync } = require('@babel/core')
  const slots = []
  let cursor, dirty, output, props
  let pending = []
  const changed = (old, values) => !old || values.some((v, i) => !Object.is(v, old.values[i]))
  const memo = (fn, values) => {
    const at = cursor++
    if (changed(slots[at], values)) slots[at] = { values, value: fn() }
    return slots[at].value
  }
  const bindings = {
    React: { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }) },
    useState: (initial) => {
      const at = cursor++
      if (!(at in slots)) slots[at] = { value: typeof initial === 'function' ? initial() : initial }
      return [slots[at].value, (value) => {
        const next = typeof value === 'function' ? value(slots[at].value) : value
        if (!Object.is(slots[at].value, next)) { slots[at].value = next; dirty = true }
      }]
    },
    useRef: (initial) => {
      const at = cursor++
      if (!(at in slots)) slots[at] = { current: initial }
      return slots[at]
    },
    useMemo: memo,
    useCallback: (fn, values) => memo(() => fn, values),
    useEffect: (fn, values) => {
      const at = cursor++
      if (changed(slots[at], values)) pending.push({ at, fn, values })
    },
    ...deps
  }
  const input = source.replace(/^import .+\n/gm, '').replace(/export default /g, '').replace(/\bexport /g, '')
  const compiled = transformSync(input, { configFile: false, babelrc: false, plugins: ['@babel/plugin-transform-react-jsx'] }).code
  // eslint-disable-next-line no-new-func
  const component = new Function(...Object.keys(bindings), compiled + '\n' + setup + '\nreturn ' + name)(...Object.values(bindings))
  const render = (next = props) => {
    props = next
    let turns = 0
    do {
      if (++turns > 30) throw new Error('render loop')
      dirty = false
      cursor = 0
      pending = []
      output = component(props)
      for (const effect of pending) slots[effect.at]?.cleanup?.()
      for (const { at, fn, values } of pending) slots[at] = { values, cleanup: fn() }
    } while (dirty)
    return output
  }
  return {
    render,
    flush: async () => {
      for (let i = 0; i < 20; i++) { await Promise.resolve(); render() }
      return output
    },
    unmount: () => { for (const slot of slots) slot?.cleanup?.() }
  }
}

function functionSource (source, name) {
  const start = source.indexOf('function ' + name + ' (')
  const body = fnBody(source, 'function ' + name + ' (')
  return source.slice(start, source.indexOf(body, start)) + body
}

function treeNodes (tree) {
  return tree && typeof tree === 'object' ? [tree, ...tree.children.flatMap(treeNodes)] : []
}

function clock () {
  let id = 0
  let now = Date.now()
  const jobs = new Map()
  return {
    now: () => now,
    setTimeout: (fn, ms) => { jobs.set(++id, { fn, ms, at: now + ms }); return id },
    clearTimeout: (key) => jobs.delete(key),
    fire: (ms) => { for (const [key, job] of [...jobs]) if (job.ms === ms) { jobs.delete(key); job.fn() } },
    has: (ms) => [...jobs.values()].some((job) => job.ms === ms),
    advance: (ms) => {
      const end = now + ms
      for (;;) {
        const next = [...jobs].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        const [key, job] = next
        now = job.at
        jobs.delete(key)
        job.fn()
      }
      now = end
    }
  }
}

test('momento music gates are policy and capability based, with no viewer probe or strip catalog', (t) => {
  const composer = code('src/screens/Publicar.js')
  const viewer = code('src/screens/Momentos.js')
  t.is((composer.match(/node\.request\('node\.info', \{\}\)/g) || []).length, 1, 'one probe site in the composer')
  t.absent(viewer.includes('node.info'), 'the viewer trusts the parsed music record, without probing')
  t.ok(composer.includes('info?.momentMusic === true'), 'capability must explicitly answer true')
  for (const src of [composer, viewer]) {
    t.ok(src.includes('policy.moments !== true'), 'separate operator switch')
    t.ok(src.includes('await audiusReady({ member, origin })'), 'linked member readiness')
    t.ok(src.includes('musicOriginOf(node)'), 'capability origin')
  }
  t.ok(viewer.includes('momentMusicOf(item)'), 'only a valid music item plays')
  t.absent(viewer.includes('AUTO_ADVANCE_MS'), 'durations come from the pure photo/music and video helpers')
  t.ok(composer.includes("modes={['snippet']}"), 'moment picker only offers snippets')
  t.ok(composer.includes('displayText(moment.music.item.title)') && composer.includes('displayText(moment.music.item.artist)'), 'provider text is sanitized')
  t.absent(/audius|MusicPicker|MomentMusic/.test(code('src/ui/MomentosStrip.js')), 'the strip never asks the catalog')
})

test('composer probes once per epoch only after opening a hosted momento with policy on', async (t) => {
  const source = read('src/screens/Publicar.js')
  const { musicOriginOf } = await import('../src/music.js')
  const calls = []
  let policy = { moments: false }
  let ready = true
  let answer = { momentMusic: true }
  const node = { epoch: 1, hosted: true, request: async (method, args) => { calls.push([method, args]); if (answer instanceof Error) throw answer; return answer } }
  let policies = 0
  const host = hookHost(functionSource(source, 'useMomentMusicAvailable'), 'run', {
    musicOriginOf,
    audiusPolicy: async () => { policies++; return policy },
    audiusReady: async () => ready
  }, 'function run ({ node, active }) { return useMomentMusicAvailable(node, "member", active) }')
  t.teardown(host.unmount)
  host.render({ node, active: false })
  t.absent(await host.flush())
  t.is(policies, 0, 'no policy or capability request during boot')
  host.render({ node, active: true })
  t.absent(await host.flush(), 'policy off')
  t.alike(calls, [], 'policy off never probes')
  policy = { moments: true }
  host.render({ node, active: false })
  host.render({ node, active: true })
  t.ok(await host.flush())
  t.alike(calls, [['node.info', {}]])
  host.render({ node, active: false })
  host.render({ node, active: true })
  t.ok(await host.flush())
  t.is(calls.length, 1, 'reopening reuses the capability')
  host.render({ node: { ...node, request: async () => { throw new Error('must reuse the epoch') } }, active: true })
  t.ok(await host.flush(), 'a new callback in the same epoch reuses the probe')
  answer = new Error('offline')
  host.render({ node: { ...node, epoch: 2 }, active: true })
  t.absent(await host.flush(), 'failed probe hides music')
  host.render({ node: { ...node, epoch: 2 }, active: false })
  host.render({ node: { ...node, epoch: 2 }, active: true })
  t.absent(await host.flush())
  t.is(calls.length, 2, 'failed probe is also cached')
  answer = {}
  host.render({ node: { ...node, epoch: 3 }, active: true })
  t.absent(await host.flush(), 'missing capability is off')
  answer = { momentMusic: true }
  ready = false
  host.render({ node: { ...node, epoch: 4 }, active: true })
  t.absent(await host.flush(), 'readiness is required')
  host.render({ node: { ...node, epoch: 5, hosted: false }, active: true })
  t.absent(await host.flush(), 'non-hosted node is off')
  t.is(calls.length, 4, 'non-hosted node never probes')
})

test('a policy response after closing the composer never probes the node', async (t) => {
  const source = read('src/screens/Publicar.js')
  const { musicOriginOf } = await import('../src/music.js')
  let resolvePolicy
  let probes = 0
  const node = { hosted: true, epoch: 1, request: () => { probes++; return { momentMusic: true } } }
  const host = hookHost(functionSource(source, 'useMomentMusicAvailable'), 'run', {
    musicOriginOf,
    audiusPolicy: () => new Promise((resolve) => { resolvePolicy = resolve }),
    audiusReady: async () => true
  }, 'function run ({ node, active }) { return useMomentMusicAvailable(node, "member", active) }')
  t.teardown(host.unmount)
  host.render({ node, active: true })
  host.render({ node, active: false })
  resolvePolicy({ moments: true })
  t.absent(await host.flush())
  t.is(probes, 0)
})

async function viewerHost ({ music = true, policy = true, ready = true, reduce = false, photo = 'ok', media = null } = {}) {
  const moments = await import('../src/moments.js')
  const seen = await import('../src/momentSeen.js')
  const { musicOriginOf } = await import('../src/music.js')
  const timers = clock()
  const animations = []
  const node = { hosted: true, epoch: 1, request: () => { throw new Error('unexpected viewer request') } }
  const item = (seq) => ({ seq, ref: A + ':' + seq, at: new Date().toISOString(), text: '', media, ...(music ? { music: { id: 'abc', start: 30 } } : {}) })
  const data = { phase: 'ready', authors: [], own: [item(2), item(1)] }
  const seenState = { loaded: true, seen: [], mark () {} }
  const env = { node, reduce, photo, back: 0, policyCalls: 0, opened: [] }
  class Value {
    constructor (value) { this.value = value }
    setValue (value) { this.value = value }
    stopAnimation (fn) { fn(this.value) }
    interpolate () { return this.value }
  }
  const elements = ['ActivityIndicator', 'Image', 'Pressable', 'ScrollView', 'Text', 'View', 'ActionsSheet', 'Avatar', 'Icon', 'Pill', 'Scrim', 'IconAction', 'MomentMusic', 'Soft', 'VideoPlayer']
  const deps = {
    ...moments,
    ...seen,
    ...timers,
    Date: class extends Date { static now () { return timers.now() } },
    displayText: require('@varanda/rpc').displayText,
    whoOf: (await import('../src/who.js')).whoOf,
    ...Object.fromEntries(elements.map((name) => [name, name])),
    musicOriginOf,
    audiusPolicy: async () => { env.policyCalls++; return typeof policy === 'function' ? policy() : { moments: policy } },
    audiusReady: async () => typeof ready === 'function' ? ready() : ready,
    useNode: () => node,
    useStyles: () => ({}),
    useTheme: () => ({ colors: {} }),
    useNames: () => null,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
    useWindowDimensions: () => ({ height: 800, width: 400 }),
    useNow: () => Date.now(),
    mocked: { data, seenState, env },
    Animated: {
      Value,
      View: 'Animated.View',
      timing: (value, opts) => {
        const animation = { value, duration: opts.duration, active: false, start (fn) { this.active = true; this.finish = fn }, stop () { this.active = false } }
        animations.push(animation)
        return animation
      }
    },
    Easing: { linear: 'linear' },
    PanResponder: { create: () => ({ panHandlers: {} }) },
    STACK_MS: 200,
    scrimColor: () => '#000000',
    relativeTime: () => '',
    openExternal: (url) => env.opened.push(url)
  }
  const setup = 'useMoments = () => mocked.data; useMomentSeen = () => mocked.seenState; useMotionReduced = () => mocked.env.reduce; useMomentPhoto = () => ({ phase: mocked.env.photo })'
  const host = hookHost(read('src/screens/Momentos.js'), 'Viewer', deps, setup)
  host.render({ entry: { key: A }, ownKey: A, onBack: () => { env.back++ } })
  await host.flush()
  return {
    ...host,
    ...env,
    timers,
    animations,
    env,
    music: () => treeNodes(host.render()).find((n) => n.type === 'MomentMusic'),
    button: (label) => treeNodes(host.render()).find((n) => n.props.accessibilityLabel === label || n.props.label === label),
    animation: () => animations.findLast((a) => a.active)
  }
}

test('viewer starts its 15 s hold with audio and resumes the remaining hold after a press or menu', async (t) => {
  const h = await viewerHost()
  t.teardown(h.unmount)
  t.ok(h.music(), 'music mounted')
  t.is(h.music().props.member, A)
  t.is(h.music().props.origin, undefined, 'installation origin')
  t.absent(h.animation(), 'waiting for audio, no segment yet')
  t.ok(h.timers.has(3000))
  h.music().props.onStart()
  h.render()
  t.is(h.animation().duration, 15000)
  t.absent(h.timers.has(3000), 'start cancels fallback timer')
  h.animation().value.setValue(0.4)
  h.button('próximo momento').props.onPressIn({ nativeEvent: { pageX: 300, pageY: 50 } })
  h.render()
  t.ok(h.music().props.paused, 'press pauses audio')
  t.absent(h.animation())
  h.button('próximo momento').props.onPressOut()
  h.render()
  t.absent(h.music().props.paused)
  t.is(h.animation().duration, 9000, '60% of 15 s remains')
  h.animation().value.setValue(0.6)
  h.button('mais ações').props.onPress()
  h.render()
  t.ok(h.music().props.paused, 'menu pauses audio')
  treeNodes(h.render()).find((n) => n.type === 'ActionsSheet').props.onClose()
  h.timers.fire(1000)
  h.render()
  t.is(h.animation().duration, 6000, '40% of 15 s remains after the menu')
  h.music().props.onOpenExternal('https://audius.co/track')
  h.render()
  t.ok(h.music().props.paused, 'attribution pauses viewer and audio')
  t.alike(h.env.opened, ['https://audius.co/track'])
})

test('viewer replaces the keyed music on item change and pauses it immediately on close', async (t) => {
  const h = await viewerHost()
  t.teardown(h.unmount)
  const first = h.music()
  h.music().props.onStart()
  h.render()
  h.button('próximo momento').props.onPress({ nativeEvent: {} })
  h.render()
  t.not(h.music().props.key, first.props.key, 'a different React key unmounts the previous player')
  t.absent(h.animation(), 'next item waits for its own onStart')
  t.ok(h.timers.has(3000))
  h.button('momento anterior').props.onPress({ nativeEvent: {} })
  h.render()
  t.is(h.music().props.key, first.props.key)
  t.absent(h.animation(), 'returning to a previous item also waits for its new player')
  h.button('fechar momentos').props.onPress()
  h.render()
  t.ok(h.music()?.props.paused, 'paused before the closing slide')
  t.is(h.music()?.props.key, first.props.key, 'closing does not remount the player')
  t.absent(h.animation())
  t.absent(h.timers.has(3000), 'closing cancels the fallback')
  t.is(h.env.back, 1)
})

test('viewer falls back to 5 s on unavailable or a 3 s wait, and restarts at zero on a late start', async (t) => {
  const h = await viewerHost()
  t.teardown(h.unmount)
  h.timers.fire(3000)
  h.render()
  t.is(h.animation().duration, 5000)
  h.animation().value.setValue(0.5)
  h.music().props.onStart()
  h.render()
  t.is(h.animation().duration, 15000)
  t.is(h.animation().value.value, 0, 'late start gets a full segment')
  h.music().props.onUnavailable()
  h.render()
  t.is(h.animation().duration, 5000, 'audio failure restores a plain segment')
  t.is(h.animation().value.value, 0)
})

test('viewer keeps plain moments and disabled music silent at AUTO_ADVANCE_MS', async (t) => {
  const { AUTO_ADVANCE_MS } = await import('../src/moments.js')
  for (const options of [{ music: false }, { policy: false }, { ready: false }]) {
    const h = await viewerHost(options)
    t.absent(h.music(), JSON.stringify(options))
    t.is(h.animation().duration, AUTO_ADVANCE_MS)
    if (options.music === false) t.is(h.env.policyCalls, 0, 'plain photo makes no music request')
    h.unmount()
  }
})

test('reduced motion allows one mounted snippet without any auto-advance', async (t) => {
  const h = await viewerHost({ reduce: true })
  t.teardown(h.unmount)
  const key = h.music().props.key
  t.absent(h.music().props.paused, 'reduced motion does not mute audio')
  h.music().props.onStart()
  h.render()
  t.absent(h.animation())
  t.is(h.music().props.key, key, 'no remount to replay the snippet')
  t.absent(h.timers.has(3000))
  t.is(h.env.back, 0)
})

test('momento sends only a chosen music reference, checks author text and never resends an uncertain create', async (t) => {
  const source = read('src/screens/Publicar.js')
  const { momentMusicOf } = await import('../src/moments.js')
  const calls = []
  const checked = []
  let available = true
  let uncertain = false
  const photo = { files: [{ bytes: new Uint8Array([1]), mime: 'image/jpeg', width: 1, height: 1 }], ready: true, items: [], clear () {}, remove () {} }
  const node = {
    online: true,
    passkey: { status: { unlocked: true } },
    media: { putMoment: async () => { calls.push('put'); return { id: 'photo' } } },
    request: async (method, body) => { calls.push({ method, body }); if (uncertain) throw Object.assign(new Error('offline'), { uncertain: true }) }
  }
  const input = source.slice(source.indexOf('export const MOMENT_TEXT_MAX'), source.indexOf('function useMomentMusicAvailable')) + functionSource(source, 'useMomentDraft')
  const h = hookHost(input, 'useMomentDraft', {
    momentMusicOf,
    useMomentMusicAvailable: () => available,
    useChatAttachments: () => photo,
    useVideoDraft: () => ({ state: { phase: 'empty', file: null }, draft: { state: { phase: 'empty', file: null }, clear () {} } }),
    ...(await import('../src/videoCompose.js')),
    pickVideo: null,
    prepareVideo: null,
    refusalOf: (text) => { checked.push(text); return '' },
    momentsChanged () {},
    LOCKED_MESSAGE: 'locked',
    errorText: () => 'erro'
  })
  t.teardown(h.unmount)
  const props = { node, member: A, open: true, active: true }
  h.render(props)
  t.ok(await h.render().send())
  t.absent(Object.hasOwn(calls.at(-1).body, 'music'), 'no choice omits music, never null')
  const choice = { ref: { kind: 'snippet', id: 'abc', start: 30 }, item: { title: 'provider title', artist: 'provider artist' } }
  h.render().pickMusic(choice)
  h.render().setText('author caption')
  t.ok(await h.render().send())
  t.alike(calls.at(-1), { method: 'moment.create', body: { text: 'author caption', media: { id: 'photo' }, music: { p: 'audius', id: 'abc', start: 30 } } })
  t.alike(checked, ['', 'author caption'], 'provider metadata never goes to refusalOf')
  available = false
  t.ok(await h.render().send())
  t.absent(Object.hasOwn(calls.at(-1).body, 'music'), 'a closed gate omits the saved choice')
  available = true
  h.render().setMusic(null)
  t.ok(await h.render().send())
  t.absent(Object.hasOwn(calls.at(-1).body, 'music'), 'removed choice is omitted')
  h.render().pickMusic(choice)
  uncertain = true
  t.absent(await h.render().send())
  t.ok(h.render().held)
  const count = calls.length
  t.absent(await h.render().send())
  t.is(calls.length, count, 'uncertain create is never repeated')
  h.render().reset()
  t.is(h.render().music, null, 'discard clears the music draft')
})

test('T22 fix 1: a saved music chip and its remove button follow the send gate', (t) => {
  const src = read('src/screens/Publicar.js')
  const chip = src.indexOf('<View style={styles.momentMusicChip}>')
  const jsx = src.slice(src.lastIndexOf('\n              {', chip), src.indexOf('\n              <TextInput', chip))
  const h = hookHost('function Chip ({ moment }) { return <>' + jsx + '</> }', 'Chip', {
    View: 'View', Text: 'Text', Pill: 'Pill', styles: {}, displayText: (s) => s
  })
  t.teardown(h.unmount)
  const music = { item: { title: 'Faixa', artist: 'Artista' } }
  const closed = treeNodes(h.render({ moment: { music, musicAvailable: false } }))
  t.absent(closed.some((n) => n.type === 'View'), 'saved choice hidden while the gate is closed')
  t.absent(closed.some((n) => n.props.accessibilityLabel === 'Remover música'), 'remove button hidden too')
  let removed = false
  const opened = treeNodes(h.render({ moment: { music, musicAvailable: true, removeMusic: () => { removed = true } } }))
  t.ok(opened.some((n) => n.type === 'Text'), 'chip returns when the gate opens')
  opened.find((n) => n.props.accessibilityLabel === 'Remover música').props.onPress()
  t.ok(removed)
})

test('T22 fix 2: the attribution hold releases on visibility return or the popup grace', async (t) => {
  const h = await viewerHost()
  t.teardown(h.unmount)
  h.music().props.onStart()
  h.render()
  h.animation().value.setValue(0.4)
  h.music().props.onOpenExternal('https://audius.co/track')
  h.render()
  t.ok(h.music().props.paused)
  t.absent(h.animation(), 'link holds the segment')
  h.node.visible = false
  h.render()
  h.timers.advance(5000)
  h.render()
  t.ok(h.music().props.paused, 'no grace release while away')
  h.node.visible = true
  h.render()
  t.absent(h.music().props.paused, 'return releases the link hold')
  t.is(h.animation()?.duration, 9000, 'the remaining segment resumes')
  h.music().props.onOpenExternal('https://audius.co/track')
  h.render()
  h.timers.advance(999)
  h.render()
  t.ok(h.music().props.paused, 'popup grace holds for 1000 ms')
  h.timers.advance(1)
  h.render()
  t.absent(h.music().props.paused, 'a popup or blocked open cannot latch the hold')
  t.is(h.animation()?.duration, 9000)
})

function deferred () {
  let resolve, reject
  const promise = new Promise((_resolve, _reject) => { resolve = _resolve; reject = _reject })
  return { promise, resolve, reject }
}

test('T22 fix 3: pending policy holds zero and an off answer starts the photo segment once', async (t) => {
  const policy = deferred()
  const h = await viewerHost({ policy: () => policy.promise })
  t.teardown(h.unmount)
  t.absent(h.music())
  t.is(h.animations.length, 0, 'no bar starts before policy answers')
  h.timers.advance(700)
  h.render()
  t.absent(h.animation(), 'still at zero')
  policy.resolve({ moments: false })
  await h.flush()
  t.is(h.animation()?.duration, 5000)
  t.is(h.animation()?.value.value, 0)
  t.is(h.animations.length, 1, 'off starts the segment exactly once')
  h.timers.advance(8000)
  h.render()
  t.is(h.animations.length, 1, 'no delayed fallback restarts the segment')
})

test('T22 fix 3: late policy or readiness never restarts a fallback; only onStart does', async (t) => {
  for (const stage of ['policy', 'ready']) {
    const answer = deferred()
    const h = await viewerHost({ [stage]: () => answer.promise })
    t.is(h.animations.length, 0, stage + ': pending holds zero')
    h.timers.advance(3000)
    h.render()
    t.is(h.animation()?.duration, 5000, stage + ': bounded wait')
    t.is(h.animations.length, 1)
    const segment = h.animation()
    if (segment) segment.value.setValue(0.4)
    answer.resolve(stage === 'policy' ? { moments: true } : true)
    await h.flush()
    t.ok(h.music(), stage + ': ready mounts audio')
    t.is(h.animation(), segment, stage + ': late answer preserves the running segment')
    t.is(h.animation()?.value.value, 0.4)
    t.is(h.animations.length, 1)
    h.music().props.onStart()
    h.render()
    t.is(h.animation()?.duration, 15000, 'actual audio starts a new full hold')
    t.is(h.animation()?.value.value, 0)
    h.unmount()
  }
})

test('T22 fix 3: policy and readiness failures end the pending wait', async (t) => {
  for (const stage of ['policy', 'ready']) {
    const answer = deferred()
    const h = await viewerHost({ [stage]: () => answer.promise })
    t.is(h.animations.length, 0)
    answer.reject(new Error('offline'))
    await h.flush()
    t.absent(h.music())
    t.is(h.animation()?.duration, 5000, stage + ': failure starts the plain segment')
    t.absent(h.timers.has(3000))
    h.unmount()
  }
})

test('T22 fix 4: restarting the first music item remounts it and waits for its new start', async (t) => {
  const h = await viewerHost()
  t.teardown(h.unmount)
  const key = h.music().props.key
  h.timers.advance(1000)
  h.music().props.onStart()
  h.render()
  h.animation().value.setValue(0.4)
  h.button('momento anterior').props.onPress({ nativeEvent: {} })
  h.render()
  t.not(h.music().props.key, key, 'restart gets a fresh snippet mount')
  t.absent(h.animation(), 'restart waits for the new onStart')
  t.ok(h.timers.has(3000), 'fresh start budget')
  h.music().props.onStart()
  h.render()
  t.is(h.animation()?.duration, 15000)
  t.is(h.animation()?.value.value, 0)
})

test('T22 round 2: a node epoch change waits for the remounted audio with a fresh budget', async (t) => {
  let policy = { moments: true }
  const h = await viewerHost({ policy: () => policy })
  t.teardown(h.unmount)
  h.timers.advance(1000)
  h.music().props.onStart()
  h.render()
  const first = h.animation()
  t.is(first.duration, 15000)
  first.value.setValue(0.4)
  const answer = deferred()
  policy = answer.promise
  h.node.epoch++
  h.render()
  t.absent(h.music(), 'pending policy unmounts the previous snippet')
  t.absent(h.animation(), 'reconnect waits instead of running a photo segment')
  t.is(first.value.value, 0, 'waiting resets the bar to zero')
  t.ok(h.timers.has(3000), 'reconnect replenishes the start wait budget')
  h.timers.advance(2200)
  h.render()
  t.absent(h.animation(), 'the previous mount spent none of the new budget')
  answer.resolve({ moments: true })
  await h.flush()
  t.is(h.env.policyCalls, 2)
  t.ok(h.music(), 'policy answer mounts a fresh snippet')
  t.absent(h.animation(), 'positive policy alone cannot start the 15 s hold')
  t.is(first.value.value, 0)
  h.timers.advance(799)
  h.render()
  t.absent(h.animation(), 'the fresh budget covers policy and audio')
  h.music().props.onStart()
  h.render()
  t.is(h.animation()?.duration, 15000, 'the remounted audio starts its own full hold')
  t.is(h.animation()?.value.value, 0)
  h.timers.advance(1)
  h.render()
  t.is(h.animation()?.duration, 15000, 'onStart cancels the new wait timer')
})

test('T22 fix 5: returning on top releases a close ignored before a profile push', async (t) => {
  const h = await viewerHost()
  t.teardown(h.unmount)
  h.music().props.onStart()
  h.render()
  h.button('fechar momentos').props.onPress()
  const props = { entry: { key: A }, ownKey: A, onBack: () => { h.env.back++ } }
  h.render({ ...props, isTop: false })
  h.timers.advance(350)
  h.render()
  t.ok(h.music()?.props.paused)
  h.render({ ...props, isTop: true })
  t.ok(h.music())
  t.absent(h.music()?.props.paused, 'top clears musicClosed even after the timer returned')
  t.ok(h.animation(), 'the bar resumes')
})

test('T22 fix 6: slow photos spend no music wait budget and presses keep the remainder', async (t) => {
  const h = await viewerHost({ photo: 'loading' })
  t.teardown(h.unmount)
  t.ok(h.music().props.paused)
  h.timers.advance(8000)
  h.render()
  t.absent(h.animation())
  h.env.photo = 'ok'
  h.render()
  t.absent(h.animation(), 'loaded photo still waits for audio')
  t.ok(h.timers.has(3000), 'photo loading spent none of the budget')
  h.timers.advance(800)
  h.button('próximo momento').props.onPressIn({ nativeEvent: { pageX: 300, pageY: 50 } })
  h.render()
  h.timers.advance(6000)
  h.button('próximo momento').props.onPressOut()
  h.render()
  t.absent(h.animation(), 'a long press does not expire the wait')
  t.ok(h.timers.has(2200), 'only the 800 unpaused ms were spent')
  h.timers.advance(2199)
  h.render()
  t.absent(h.animation())
  h.timers.advance(1)
  h.render()
  t.is(h.animation()?.duration, 5000, 'unpaused exhaustion falls back')
  t.is(h.animations.length, 1, 'the photo segment starts once')
})

test('T22 fix 6: pending policy and audio share a budget across hidden, menu and stack pauses', async (t) => {
  const answer = deferred()
  const h = await viewerHost({ policy: () => answer.promise })
  t.teardown(h.unmount)
  h.timers.advance(600)
  h.node.visible = false
  h.render()
  h.timers.advance(4000)
  h.node.visible = true
  h.render()
  t.ok(h.timers.has(2400), 'background preserves the pending policy budget')
  answer.resolve({ moments: true })
  await h.flush()
  t.ok(h.music())
  t.ok(h.timers.has(2400), 'policy answer does not replenish the budget')
  h.timers.advance(400)
  h.button('mais ações').props.onPress()
  h.render()
  h.timers.advance(4000)
  treeNodes(h.render()).find((n) => n.type === 'ActionsSheet').props.onClose()
  h.timers.advance(1000)
  h.render()
  t.ok(h.timers.has(2000), 'menu and its settling time spend none')
  const props = { entry: { key: A }, ownKey: A }
  h.render({ ...props, isTop: false })
  h.timers.advance(4000)
  h.render({ ...props, isTop: true })
  t.ok(h.timers.has(2000), 'covered viewer preserves the remainder')
  h.timers.advance(2000)
  h.render()
  t.is(h.animation()?.duration, 5000)
  t.is(h.animations.length, 1)
})

test('T22 fix 7: an ignored close pauses the same snippet and resumes the remaining bar', async (t) => {
  const h = await viewerHost()
  t.teardown(h.unmount)
  const key = h.music().props.key
  h.music().props.onStart()
  h.render()
  h.animation().value.setValue(0.4)
  h.button('fechar momentos').props.onPress()
  h.render()
  t.ok(h.music(), 'music stays mounted through musicClosed')
  t.is(h.music()?.props.key, key)
  t.ok(h.music()?.props.paused, 'closing pauses the existing snippet')
  t.absent(h.animation())
  h.timers.advance(350)
  h.render()
  t.is(h.music()?.props.key, key, 'ignored close resumes without remount')
  t.absent(h.music()?.props.paused)
  t.is(h.animation()?.duration, 9000, 'same remaining bar, with no new onStart')
})

function momentHook (name, signature, deps = {}) {
  const slots = []
  let cursor = 0
  let pending = []
  let dirty = false
  let args
  let result
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
  const hooks = {
    useRef (value) {
      const i = cursor++
      if (!slots[i]) slots[i] = { current: value }
      return slots[i]
    },
    useState (value) {
      const i = cursor++
      if (!slots[i]) slots[i] = { value }
      return [slots[i].value, (next) => {
        const value = typeof next === 'function' ? next(slots[i].value) : next
        if (!Object.is(value, slots[i].value)) { slots[i].value = value; dirty = true }
      }]
    },
    useMemo (fn, dependencies) {
      const i = cursor++
      if (!slots[i] || !same(slots[i].deps, dependencies)) slots[i] = { value: fn(), deps: dependencies }
      return slots[i].value
    },
    useEffect (fn, dependencies) {
      const i = cursor++
      if (!slots[i] || !same(slots[i].deps, dependencies)) {
        pending.push({ i, fn, cleanup: slots[i]?.cleanup })
        slots[i] = { deps: dependencies }
      }
    }
  }
  hooks.useCallback = (fn, dependencies) => hooks.useMemo(() => fn, dependencies)
  const scope = { ...hooks, ...deps }
  const body = fnBody(read('src/screens/Momentos.js'), 'function ' + name)
  const hook = new Function(...Object.keys(scope), 'return function (' + signature + ') ' + body)(...Object.values(scope)) // eslint-disable-line no-new-func
  const render = (...next) => {
    if (next.length) args = next
    do {
      dirty = false
      cursor = 0
      result = hook(...args)
      const effects = pending
      pending = []
      for (const effect of effects) effect.cleanup?.()
      for (const effect of effects) slots[effect.i].cleanup = effect.fn()
    } while (dirty)
    return result
  }
  return {
    render,
    get value () { return result },
    unmount () { for (const slot of slots) slot.cleanup?.() }
  }
}

function playbackHarness (overrides = {}) {
  let now = 0
  let serial = 0
  const timers = new Map()
  const animations = []
  const steps = []
  const later = (fn, ms) => { const id = ++serial; timers.set(id, { at: now + ms, fn }); return id }
  const cancel = (id) => timers.delete(id)
  const Animated = {
    Value: class {
      constructor (value) { this.value = value }
      setValue (value) { this.value = value }
      stopAnimation (cb) { cb(this.value) }
    },
    timing (value, config) {
      const from = value.value
      const start = now
      let timer
      let onComplete
      const anim = {
        duration: config.duration,
        start (onFinish) {
          onComplete = onFinish
          timer = later(() => { value.setValue(1); onFinish({ finished: true }) }, config.duration)
        },
        stop () {
          cancel(timer)
          value.setValue(from + (1 - from) * Math.min(1, (now - start) / config.duration))
          onComplete({ finished: false })
        },
        finishLate () { onComplete({ finished: true }) }
      }
      animations.push(anim)
      return anim
    }
  }
  const h = momentHook('useMomentPlayback', '{ itemKey, ms, video, loaded, active, autoOn, step, control }', { Animated, Easing: { linear: 'linear' }, setTimeout: later, clearTimeout: cancel, VIDEO_END_GRACE_MS })
  let props = { itemKey: A + ':1', ms: 15000, video: true, loaded: true, active: true, autoOn: true, step: (dir) => steps.push(dir), ...overrides }
  h.render(props)
  return {
    ...h,
    get value () { return h.value },
    animations,
    steps,
    render (patch = {}) { props = { ...props, ...patch }; return h.render(props) },
    tick (ms) {
      const until = now + ms
      while (true) {
        const due = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        now = due[1].at
        timers.delete(due[0])
        due[1].fn()
        h.render(props)
      }
      now = until
    }
  }
}

test('video moments use the item duration and the existing Animated clock', async (t) => {
  const { segmentMs } = await import('../src/moments.js')
  const video = { media: { mime: 'video/mp4', ms: 15000 } }
  t.is(segmentMs(video, 8000), 8000, 'the read duration wins')
  const h = playbackHarness({ ms: segmentMs(video) })
  t.teardown(h.unmount)
  t.absent(h.value.playing, 'waits for ready')
  t.is(h.animations.length, 0)
  h.value.handleReady({ durationMs: 15000 })
  h.render()
  t.ok(h.value.playing)
  t.is(h.animations[0].duration, 15000)
  h.tick(14999)
  t.is(h.steps.length, 0)
  h.tick(1)
  t.alike(h.steps, ['next'])
  h.value.handleEnd()
  h.value.handleEnd()
  t.is(h.steps.length, 1, 'timer and repeated player ends advance once')
  h.render({ itemKey: A + ':2', video: false, ms: segmentMs({ media: { mime: 'image/jpeg' } }, 12000) })
  t.is(h.animations.at(-1).duration, 5000, 'photos keep five seconds')
  h.tick(5000)
  t.is(h.steps.length, 2)
})

test('video hold resumes from the last player position; photos keep elapsed time', (t) => {
  const h = playbackHarness()
  t.teardown(h.unmount)
  h.value.handleReady({ durationMs: 15000 })
  h.render()
  h.tick(3000)
  h.value.handleProgress({ ms: 2750, playing: true })
  h.render({ active: false })
  t.absent(h.value.playing, 'hold pauses the picture')
  t.ok(Math.abs(h.value.progress.value - 2750 / 15000) < 1e-12, 'bar follows last reported position on hold')
  h.value.handleProgress({ ms: 2900, playing: false })
  h.tick(20000)
  t.is(h.steps.length, 0)
  h.render({ active: true })
  t.ok(h.value.playing)
  t.is(h.animations.at(-1).duration, 12100, 'pause event refines the remaining time')
  h.tick(12100)
  t.is(h.steps.length, 0, 'the resumed player is still playing when the clock ends')
  h.value.handleEnd()
  t.is(h.steps.length, 1)
  h.render({ itemKey: A + ':2', ms: 5000, video: false })
  h.tick(2000)
  h.render({ active: false })
  h.tick(10000)
  h.render({ active: true })
  t.is(h.animations.at(-1).duration, 3000, 'photo resumes its remaining three seconds')
})

test('a video still playing when the clock ends waits for its end, within a bound', async (t) => {
  const h = playbackHarness()
  t.teardown(h.unmount)
  h.value.handleReady({ durationMs: 15000 })
  h.render()
  h.tick(14000)
  h.value.handleProgress({ ms: 13700, playing: true })
  h.tick(1000)
  t.is(h.steps.length, 0, 'the clock does not cut a playing video')
  h.value.handleEnd()
  t.alike(h.steps, ['next'])
  h.tick(VIDEO_END_GRACE_MS + 1)
  t.is(h.steps.length, 1, 'the grace timer cannot advance again after onEnd')

  h.render({ itemKey: B + ':1' })
  h.value.handleReady({ durationMs: 15000 })
  h.render()
  h.tick(14000)
  h.value.handleProgress({ ms: 13800, playing: true })
  h.tick(1000)
  t.is(h.steps.length, 1, 'the clock waits for the player end')
  h.tick(VIDEO_END_GRACE_MS - 1)
  t.is(h.steps.length, 1, 'the wait lasts until the grace deadline')
  h.tick(1)
  t.is(h.steps.length, 2, 'the grace deadline advances without onEnd')

  h.render({ itemKey: A + ':3' })
  h.value.handleReady({ durationMs: 15000 })
  h.render()
  h.tick(14000)
  h.value.handleProgress({ ms: 13900, playing: true })
  h.tick(1000)
  t.is(h.steps.length, 2, 'the next video also waits for its end')
  h.render({ active: false })
  h.value.handleProgress({ ms: 13900, playing: false })
  h.tick(20000)
  t.is(h.steps.length, 2, 'a hold cancels the pending grace timer')
  h.render({ active: true })
  t.is(h.animations.at(-1).duration, 15000 - 13900, 'resume uses the last player position')
  h.tick(15000 - 13900)
  t.is(h.steps.length, 2, 'the pause a hold causes does not skip the wait after release')
  h.tick(VIDEO_END_GRACE_MS)
  t.is(h.steps.length, 3)

  h.render({ itemKey: A + ':4' })
  h.value.handleReady({ durationMs: 15000 })
  h.render()
  h.tick(14000)
  h.value.handleProgress({ ms: 15400, playing: true })
  h.tick(1000)
  t.is(h.steps.length, 3, 'a player past the clamped segment still gets its end')
  h.value.handleEnd()
  t.is(h.steps.length, 4)

  h.render({ itemKey: B + ':2' })
  h.value.handleReady({ durationMs: 15000 })
  h.render()
  h.value.handleProgress({ ms: 5000, playing: false })
  const duration = h.animations.at(-1).duration
  h.tick(duration - 1)
  t.is(h.steps.length, 4, 'a paused last report still waits for the clock')
  h.tick(1)
  t.is(h.steps.length, 5, 'a paused last report advances on the clock without grace')

  h.render({ itemKey: B + ':3' })
  h.value.handleReady({ durationMs: 15000 })
  h.render()
  h.tick(14000)
  h.value.handleProgress({ ms: 14900, playing: true })
  h.render({ active: false })
  h.value.handleProgress({ ms: 15000, playing: false })
  h.value.handleEnd()
  h.render()
  t.is(h.steps.length, 5, 'an end during a hold does not advance yet')
  h.render({ active: true })
  h.tick(0)
  t.is(h.steps.length, 6, 'release after the end advances without the grace')

  const { VIDEO_END_GRACE_MS: grace } = await import('../src/moments.js')
  const { VIDEO_MS_TOLERANCE } = require('@varanda/rpc')
  t.ok(grace > VIDEO_MS_TOLERANCE, 'the grace covers container tolerance and player start lag')
  t.is(grace, VIDEO_END_GRACE_MS, 'the harness uses the exported grace')
})

test('late video callbacks cannot affect the next visit, even to the same item', (t) => {
  const h = playbackHarness()
  t.teardown(h.unmount)
  const old = h.value
  old.handleReady({ durationMs: 15000 })
  h.render()
  const animation = h.animations[0]
  old.handleEnd()
  t.is(h.steps.length, 1, 'player end can advance first')
  animation.finishLate()
  t.is(h.steps.length, 1, 'timer cannot advance it again')
  h.render({ itemKey: B + ':1' })
  h.render({ itemKey: A + ':1' })
  old.handleReady({ durationMs: 15000 })
  old.handleEnd()
  old.handleProgress({ ms: 15000, playing: false })
  old.handleSoundRefused()
  old.handlePlayBlocked()
  animation.finishLate()
  h.render()
  t.is(h.steps.length, 1, 'late end is ignored')
  t.absent(h.value.playing, 'old ready does not start the new visit')
  t.absent(h.value.muted, 'old sound refusal is ignored')
  t.absent(h.value.blocked, 'old playback block is ignored')
  t.is(h.value.progress.value, 0, 'old progress is ignored')
  h.render({ autoOn: false })
  old.handleEnd()
  h.render()
  t.is(h.value.progress.value, 0, 'late end cannot fill the reduced-motion bar')
  h.value.handlePlayBlocked()
  h.render()
  old.handlePlayBlocked()
  h.render()
  t.ok(h.value.blocked, 'old block cannot overwrite the current block')
  old.handlePlay()
  h.render()
  t.ok(h.value.blocked, 'old play cannot clear the current block')
})

test('a never-ready video advances two seconds after loading plus its duration', (t) => {
  const h = playbackHarness({ loaded: false })
  t.teardown(h.unmount)
  h.tick(10000)
  t.is(h.animations.length, 0, 'no clock before the file arrives')
  h.render({ loaded: true })
  h.tick(1999)
  t.is(h.animations.length, 0)
  h.tick(1)
  t.ok(h.value.playing, 'ready timeout allows playback and the clock')
  t.is(h.animations[0].duration, 15000)
  h.tick(14999)
  t.is(h.steps.length, 0)
  h.tick(1)
  t.is(h.steps.length, 1)
})

test('reduced motion requires Reproduzir and never starts the auto-advance timer', (t) => {
  const h = playbackHarness({ autoOn: false })
  t.teardown(h.unmount)
  h.value.handleReady({ durationMs: 15000 })
  h.tick(20000)
  t.absent(h.value.playing)
  t.is(h.animations.length, 0)
  h.value.handlePlay()
  h.render()
  t.ok(h.value.playing, 'explicit play starts the picture')
  t.is(h.animations.length, 0, 'explicit play does not start the clock')
  h.value.handleProgress({ ms: 6000, playing: true })
  t.is(h.value.progress.value, 0.4, 'progress drives the bar')
  h.render({ active: false })
  t.absent(h.value.playing, 'hold also pauses manual playback')
  h.render({ active: true })
  t.ok(h.value.playing)
  h.value.handleEnd()
  h.render()
  t.absent(h.value.playing)
  t.ok(h.value.ended, 'end offers the next button')
  t.is(h.value.progress.value, 1)
  h.tick(30000)
  t.is(h.steps.length, 0, 'end and elapsed time never advance')
  h.render({ itemKey: A + ':2' })
  t.absent(h.value.playing, 'the next item needs its own press')
})

test('video sound falls back to muted and a new item starts with sound', (t) => {
  const h = playbackHarness()
  t.teardown(h.unmount)
  t.absent(h.value.muted)
  h.value.handleSoundRefused()
  h.render()
  t.ok(h.value.muted)
  h.value.handleUnmute()
  h.render()
  t.absent(h.value.muted, 'Ativar som enables sound')
  h.value.handleSoundRefused()
  h.render({ itemKey: A + ':2' })
  t.absent(h.value.muted)
  const src = read('src/screens/Momentos.js')
  t.ok(src.includes("controls={false} fit='contain'"), 'inline player without controls')
  t.ok(src.includes("<Pill label='Reproduzir' onPress={playback.handlePlay}"))
  t.ok(src.includes("<Pill label='Ativar som' onPress={playback.handleUnmute}"))
  t.ok(src.includes("<Pill label='Próximo momento' onPress={() => step('next')}"))
  t.ok(src.includes('video ? VIDEO_UNAVAILABLE : PHOTO_UNAVAILABLE'), 'unavailable text follows the media type')
})

// The player's control stands in for the browser: what each press did to it
// is logged next to the state the press had rendered by then.
function controlHarness (overrides = {}) {
  const log = []
  const control = { current: null }
  const h = playbackHarness({ control, ...overrides })
  control.current = {
    play: () => log.push(['play', h.value.playing]),
    unmute: () => log.push(['unmute', h.value.muted])
  }
  return { h, log, control }
}

test('Reproduzir starts the player inside the press, before the state changes', (t) => {
  const { h, log } = controlHarness({ autoOn: false })
  t.teardown(h.unmount)
  h.value.handlePlay()
  t.alike(log, [['play', false]], 'play() ran synchronously, before playing was rendered')
  h.render()
  t.ok(h.value.playing, 'the state still follows')
  h.render({ active: false })
  h.value.handlePlay()
  t.is(log.length, 1, 'no start while a hold keeps the props paused')
  h.render({ active: true, itemKey: A + ':2' })
  const old = h.value
  h.render({ itemKey: A + ':3' })
  old.handlePlay()
  t.is(log.length, 1, 'a press from a previous visit does nothing')
})

test('Reproduzir after a blocked start plays inside the press', (t) => {
  const { h, log } = controlHarness()
  t.teardown(h.unmount)
  h.value.handleReady({ durationMs: 15000 })
  h.render()
  h.value.handlePlayBlocked()
  h.render()
  t.ok(h.value.blocked)
  t.absent(h.value.playing)
  h.value.handlePlay()
  t.alike(log, [['play', false]], 'play() ran before the block was cleared')
  h.render()
  t.ok(h.value.playing)
  t.absent(h.value.blocked)
})

test('Ativar som unmutes the player inside the press, before the state changes', (t) => {
  const { h, log } = controlHarness()
  t.teardown(h.unmount)
  h.value.handleSoundRefused()
  h.render()
  h.value.handleUnmute()
  t.alike(log, [['unmute', true]], 'unmute() ran synchronously, while muted was still rendered')
  h.render()
  t.absent(h.value.muted)
  h.value.handleSoundRefused()
  h.render()
  const old = h.value
  h.render({ itemKey: A + ':2' })
  old.handleUnmute()
  t.is(log.length, 1, 'a press from a previous visit unmutes nothing')
  h.value.handleSoundRefused()
  h.render()
  old.handleUnmute()
  h.render()
  t.ok(h.value.muted, 'a press from a previous visit leaves the current visit muted')
  t.is(log.length, 1)
  const bare = playbackHarness()
  t.teardown(bare.unmount)
  bare.value.handlePlay()
  bare.value.handleUnmute()
  t.pass('no control is fine')
})

test('the viewer passes one control to the hook and to the player', (t) => {
  const src = read('src/screens/Momentos.js')
  t.ok(src.includes('const videoControl = useRef(null)'), 'the viewer owns the control')
  t.ok(/step,\s*control: videoControl\s*\}\)/.test(src), 'the hook gets it')
  t.ok(src.includes('onPlayBlocked={playback.handlePlayBlocked} control={videoControl} />'), 'the player gets it')
  const hook = src.slice(src.indexOf('function useMomentPlayback'), src.indexOf('// The rings the viewer plays'))
  t.ok(/handlePlay: \(\) => \{\s*if \(current\.current\.visit !== visit\) return\s*if \(current\.current\.canPlay\) control\?\.current\?\.play\(\)\s*setBlocked\(null\)\s*setManual\(visit\)/.test(hook), 'play() comes before the state updates')
  t.ok(/handleUnmute: \(\) => \{\s*if \(current\.current\.visit !== visit\) return\s*control\?\.current\?\.unmute\(\)\s*setMuted\(null\)/.test(hook), 'unmute() comes before the state update')
})

function mediaHarness (answer, { adoptFails = false, urlFails = false, expected = { mime: answer.mime, ms: 15000 } } = {}) {
  const forgotten = []
  const revoked = []
  const adopted = []
  const urls = []
  let answerReady
  const media = {
    read: () => new Promise((resolve) => { answerReady = resolve }),
    forgetReadFile: (name) => forgotten.push(name)
  }
  const h = momentHook('useMomentPhoto', 'author, seq, expected', {
    useNode: () => ({ media }),
    isObject: (value) => value !== null && typeof value === 'object',
    IMAGE_MIMES: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
    wipe: (bytes) => { if (bytes instanceof Uint8Array) bytes.fill(0) },
    adoptVideoFile: (uri) => { adopted.push(uri); if (adoptFails) throw new Error('move failed'); return 'file:///cache/video.mp4' },
    urlFromBytes: (bytes, mime) => { urls.push({ bytes: bytes.slice(), mime }); if (urlFails) throw new Error('blob failed'); return 'blob:video' },
    revokeUrl: (uri) => revoked.push(uri)
  })
  h.render(A, 1, expected)
  return {
    ...h,
    get value () { return h.value },
    forgotten,
    revoked,
    adopted,
    urls,
    async settle () { answerReady(answer); await Promise.resolve(); return h.render() }
  }
}

test('native video reads are adopted, forgotten and deleted on exit or item change', async (t) => {
  const uri = 'file:///documents/varanda/media-read/' + 'ab'.repeat(16) + '.bin'
  const h = mediaHarness({ uri, mime: 'video/mp4', w: 640, h: 480, ms: 15000 })
  await h.settle()
  t.is(h.value.phase, 'ok')
  t.is(h.value.ms, 15000)
  t.alike(h.adopted, [uri])
  t.alike(h.forgotten, ['ab'.repeat(16) + '.bin'])
  h.render(A, 2, { mime: 'video/mp4', ms: 15000 })
  t.alike(h.revoked, ['file:///cache/video.mp4'], 'changing item deletes its adopted file')
  h.unmount()
  t.is(h.revoked.length, 1)
  const photo = mediaHarness({ uri, mime: 'image/jpeg' })
  await photo.settle()
  t.is(photo.value.uri, uri, 'photo path is unchanged')
  t.is(photo.adopted.length, 0)
  t.is(photo.forgotten.length, 0, 'photo read file stays until exit')
  photo.unmount()
  t.is(photo.forgotten.length, 1)
})

test('refused, incomplete, failed and late media answers always forget the read file', async (t) => {
  const uri = 'file:///documents/varanda/media-read/' + 'ab'.repeat(16) + '.bin'
  for (const answer of [
    { uri, mime: 'application/octet-stream' },
    { uri, mime: 'video/mp4', w: 640, h: 480 },
    { uri, mime: 'video/mp4', w: 640, ms: 15000 },
    { uri, mime: 'video/mp4', h: 480, ms: 15000 },
    { uri, mime: 'video/mp4', w: 640, h: 480, ms: 0 }
  ]) {
    const h = mediaHarness(answer)
    await h.settle()
    t.is(h.value.phase, 'off')
    t.is(h.forgotten.length, 1)
    t.is(h.adopted.length, 0)
    h.unmount()
  }
  const answer = { uri, mime: 'video/mp4', w: 640, h: 480, ms: 15000 }
  const failed = mediaHarness(answer, { adoptFails: true })
  await failed.settle()
  t.is(failed.value.phase, 'off')
  t.is(failed.forgotten.length, 1, 'failed adoption still forgets')
  failed.unmount()
  const late = mediaHarness(answer)
  late.unmount()
  await late.settle()
  t.is(late.adopted.length, 0, 'does not adopt after exit')
  t.is(late.forgotten.length, 1, 'late native answer is deleted')
})

test('web video answers use a typed blob and wipe bytes on every path', async (t) => {
  // The node already checked the MP4; the UI owns only its transient copy.
  const bytes = Uint8Array.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0])
  const answer = () => ({ bytes: bytes.slice(), mime: 'video/mp4', w: 640, h: 480, ms: 15000 })
  const got = answer()
  const h = mediaHarness(got)
  await h.settle()
  t.is(h.value.phase, 'ok')
  t.is(h.urls[0].mime, 'video/mp4')
  t.alike(h.urls[0].bytes, bytes, 'URL receives the bytes before wiping')
  t.ok(got.bytes.every((n) => n === 0))
  h.unmount()
  t.alike(h.revoked, ['blob:video'])
  for (const mode of ['failed', 'refused', 'late']) {
    const got = answer()
    if (mode === 'refused') got.mime = 'video/other'
    const h = mediaHarness(got, { urlFails: mode === 'failed' })
    if (mode === 'late') h.unmount()
    await h.settle()
    t.ok(got.bytes.every((n) => n === 0), mode + ': bytes wiped')
    if (mode !== 'late') t.is(h.value.phase, 'off')
    h.unmount()
  }
})

function playOffered (playback, reduce) {
  const src = read('src/screens/Momentos.js')
  const expression = src.match(/const showPlay = ([^\n]+)/)[1]
  return new Function('playback', 'reduce', 'return ' + expression)(playback, reduce) // eslint-disable-line no-new-func
}

test('blocked playback holds the clock and Reproduzir resumes the same visit', (t) => {
  for (const autoOn of [true, false]) {
    const h = playbackHarness({ autoOn })
    t.teardown(h.unmount)
    h.value.handleReady()
    if (!autoOn) h.value.handlePlay()
    h.render()
    t.ok(h.value.playing, 'player initially plays')
    h.tick(3000)
    h.value.handleProgress({ ms: 2500, playing: true })
    h.value.handlePlayBlocked()
    h.render()
    t.ok(h.value.blocked)
    t.absent(h.value.playing, 'block changes the playing prop to false')
    t.ok(playOffered(h.value, !autoOn), 'block offers Reproduzir even after manual play')
    h.tick(30000)
    t.is(h.steps.length, 0, 'block holds the clock')
    h.value.handlePlay()
    h.render()
    t.absent(h.value.blocked)
    t.ok(h.value.playing, 'press changes the playing prop back to true')
    t.absent(playOffered(h.value, !autoOn), 'press hides Reproduzir')
    if (autoOn) t.is(h.animations.at(-1).duration, 12500, 'resumes from player position')
    else t.is(h.animations.length, 0, 'reduced motion still has no clock')
    h.tick(12500)
    h.value.handleEnd()
    t.is(h.steps.length, autoOn ? 1 : 0, 'only autoplay advances, once')
  }
  const src = read('src/screens/Momentos.js')
  t.ok(src.includes("{showPlay ? <Pill label='Reproduzir' onPress={playback.handlePlay} /> : null}"), 'Viewer uses the offered play action')
  t.ok(src.includes("const playbackControls = video && photo.phase === 'ok' && (playback.muted || showPlay || (reduce === true && playback.ended))"), 'play action makes the control bar visible')
})

test('a photo close ignored during a slide may advance again after hold and release', (t) => {
  const h = playbackHarness({ video: false, ms: 5000 })
  t.teardown(h.unmount)
  h.tick(5000)
  const oldAnimation = h.animations[0]
  oldAnimation.finishLate()
  t.is(h.steps.length, 1, 'one advance for the first end')
  h.render({ active: false })
  h.tick(1000)
  h.render({ active: true })
  t.is(h.animations.at(-1).duration, 0, 'same photo resumes with no time left')
  oldAnimation.finishLate()
  t.is(h.steps.length, 1, 'old completion remains cancelled after resume')
  h.tick(0)
  t.is(h.steps.length, 2, 'resuming allows another close attempt')
  h.animations.at(-1).finishLate()
  t.is(h.steps.length, 2, 'the resumed end is also guarded')
})

test('media MIME and video duration must match the item before becoming playable', async (t) => {
  const { segmentMs } = await import('../src/moments.js')
  for (const [expected, mime, ms] of [
    [{ mime: 'image/jpeg' }, 'video/mp4', 15000],
    [{ mime: 'video/mp4', ms: 15000 }, 'image/jpeg', undefined],
    [{ mime: 'image/jpeg' }, 'image/png', undefined],
    [{ mime: 'video/mp4', ms: 15000 }, 'video/mp4', 8000]
  ]) {
    const answer = { mime, ms, w: 640, h: 480, uri: 'file:///cache/read.bin', bytes: Uint8Array.from([1, 2, 3]) }
    const h = mediaHarness(answer, { expected })
    const item = { media: expected }
    const before = segmentMs(item, h.value.ms)
    await h.settle()
    t.is(h.value.phase, 'off', 'mismatch is unavailable')
    t.is(h.value.uri, null)
    t.is(segmentMs(item, h.value.ms), before, 'read never changes segment duration')
    t.is(h.adopted.length + h.urls.length, 0, 'mismatch is never displayed')
    t.alike(h.forgotten, ['read.bin'], 'read file is deleted')
    t.ok(answer.bytes.every((n) => n === 0), 'bytes are wiped')
    h.unmount()
  }
  const src = read('src/screens/Momentos.js')
  t.ok(src.includes('useMomentPhoto(author, item ? item.seq : null, item?.media)'), 'Viewer passes the expected media')
  t.ok(src.includes('video ? VIDEO_UNAVAILABLE : PHOTO_UNAVAILABLE'), 'unavailable text uses the item kind')
})

test('video has the same accessible name as the photo it replaces', (t) => {
  const src = read('src/screens/Momentos.js')
  t.ok(/<View style=\{styles.photo\} accessible accessibilityLabel=\{'momento de ' \+ name\}>\s*<VideoPlayer\b[^>]+\/>\s*<\/View>/.test(src), 'accessible labeled wrapper around VideoPlayer')
})

test('reduced motion fills the current segment until a video is playable', (t) => {
  const src = read('src/screens/Momentos.js')
  const expression = src.match(/<Animated.View style=\{\[styles.segmentFill, \{ width: ([^\n]+?) \}\]\}/)[1]
  const width = new Function('autoOn', 'video', 'photo', 'fill', 'return ' + expression) // eslint-disable-line no-new-func
  for (const phase of ['loading', 'off', 'ok']) {
    t.is(width(false, false, { phase }, 'progress'), '100%', 'photo stays full: ' + phase)
    t.is(width(false, true, { phase }, 'progress'), phase === 'ok' ? 'progress' : '100%', 'video: ' + phase)
    t.is(width(true, true, { phase }, 'progress'), 'progress', 'autoplay unchanged: ' + phase)
  }
})

test('Reproduzir waits for known reduced motion unless playback was blocked', (t) => {
  for (const reduce of [null, false, true]) {
    t.is(playOffered({ blocked: false, started: false, ended: false }, reduce), reduce === true, 'initial play offer: ' + reduce)
    t.ok(playOffered({ blocked: true, started: false, ended: false }, reduce), 'block always offers play: ' + reduce)
  }
  t.absent(playOffered({ blocked: false, started: true, ended: false }, true), 'manual playback hides the button')
  t.absent(playOffered({ blocked: false, started: true, ended: true }, true), 'finished video offers next instead')
})

test('Viewer wires every player event and keys the player by item and restart', (t) => {
  const player = read('src/screens/Momentos.js').match(/<VideoPlayer\b[^>]+\/>/)[0]
  for (const prop of [
    'playing={playback.playing}',
    'onReady={playback.handleReady}',
    'onProgress={playback.handleProgress}',
    'onEnd={playback.handleEnd}',
    'onError={handlePhotoError}',
    'onSoundRefused={playback.handleSoundRefused}',
    'onPlayBlocked={playback.handlePlayBlocked}',
    "key={itemKey + ':' + playback.restartTick}"
  ]) t.ok(player.includes(prop), prop)
})

test('viewer ignores music on video, keeps its own sound and uses the video segment clock', async (t) => {
  const h = await viewerHost({ media: { mime: 'video/mp4', ms: 8000 } })
  t.teardown(h.unmount)
  t.absent(h.music(), 'no music player for a video record')
  t.is(h.env.policyCalls, 0, 'no music policy request')
  t.absent(h.timers.has(3000), 'no music start wait')
  const player = () => treeNodes(h.render()).find((n) => n.type === 'VideoPlayer')
  t.absent(player().props.muted, 'video starts with its own sound')
  player().props.onReady()
  h.render()
  t.ok(player().props.playing)
  t.is(h.animation().duration, 8000)
  player().props.onSoundRefused()
  h.render()
  t.ok(h.button('Ativar som'), 'main sound control stays available')
  t.is(h.animations.length, 1, 'only one segment clock')
})

test('momento music button follows the draft availability gate', (t) => {
  const src = read('src/screens/Publicar.js')
  const start = src.indexOf('              {moment.musicAvailable\n')
  const jsx = src.slice(start, src.indexOf('              {moment.musicAvailable &&', start))
  const h = hookHost('function Button ({ moment, node }) { return <>' + jsx + '</> }', 'Button', { Pill: 'Pill' })
  t.teardown(h.unmount)
  for (const musicAvailable of [true, false]) {
    const tree = h.render({ moment: { musicAvailable }, node: { online: true } })
    t.is(treeNodes(tree).some((n) => n.props.label === 'Música'), musicAvailable)
  }
})
