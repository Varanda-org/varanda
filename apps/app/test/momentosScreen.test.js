// Momentos screens (src/screens/Momentos.js, src/ui/MomentosStrip.js, the
// Momento mode of Publicar, A Rua, Diário, App and tabs) read as source text,
// plus the pure seen store and helpers (src/momentSeen.js) and its web store.
'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const APP = join(__dirname, '..')
const read = (rel) => readFileSync(join(APP, rel), 'utf8')
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
  t.ok(src.includes("export const OWN_NOTE = 'A foto sai dos servidores em até 7 dias.'"), 'own note')
  t.ok(src.includes("export const DELETE_TITLE = 'Apagar momento?'"), 'delete confirmation title')
  t.ok(src.includes("request('moment.delete', { to: target.ref })"), 'moment.delete')
  t.ok(src.includes('<ConfirmStack'), 'ConfirmStack pattern')
  t.ok(src.includes("export const PHOTO_UNAVAILABLE = 'Foto indisponível'"), 'unavailable photo text')
  t.ok(src.includes("media.read({ kind: 'moment', author, seq })"), 'photo through node.media.read')
  t.ok(src.includes('AUTO_ADVANCE_MS') && src.includes('progressOf(') && src.includes('ringOrder('), 'pure module helpers used')
  t.ok(src.includes('mark(itemKey)'), 'each viewed item marked seen')
  t.ok(src.includes("backgroundColor: '#000000'"), 'black background')
})

test('auto-advance respects reduced motion and pauses', (t) => {
  const src = read('src/screens/Momentos.js')
  t.ok(src.includes('AccessibilityInfo.isReduceMotionEnabled()'), 'reads the system setting')
  t.ok(src.includes("addEventListener('reduceMotionChanged'"), 'follows changes')
  t.ok(src.includes('export function autoAdvanceOn (reduce) {\n  return reduce === false\n}'), 'only when known not reduced')
  t.ok(src.includes('const running = isTop && node.visible !== false && autoOn && item !== null && photo.phase !== \'loading\' && !held && !dragging && !menuOpen && deleting === null'), 'paused while hidden, pressed, dragged, in a menu or deleting')
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
  const create = send.indexOf("node.request('moment.create', { text, media: itemRef.current })")
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
  t.ok(src.includes('const running = isTop && node.visible !== false && autoOn'), 'auto-advance only on top and visible')
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
  t.ok(src.includes('const moment = useMomentDraft({ node, open, active: open === true && momentMode })'), 'the draft knows when it is shown')
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
  t.ok(src.includes("export const DELETE_BODY_PAST = 'O momento sai do seu diário. A foto já não aparece para ninguém.'"), 'past body')
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
  t.ok(src.includes('useEffect(() => { if (isTop) closingRef.current = false }, [isTop])'), 'released when the viewer is on top again')
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
  t.ok(src.includes('const captionMax = captionCap({ height: win.height, topEnd, barHeight, bottomPad: insets.bottom + 12 })'), 'the viewer uses it')
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
  const effect = src.slice(src.indexOf('captionOffsetRef.current = 0\n'), src.indexOf('}, [itemKey, progress])'))
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
