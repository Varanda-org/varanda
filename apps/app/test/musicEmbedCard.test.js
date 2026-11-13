'use strict'

// MusicEmbedCard: the music link card that loads the provider's player by
// itself while it is on the visible screen. The UI files pull in
// react-native, so they are read as text; the pure lifetime rules in
// ../src/embedLive.js are run directly.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const APP = path.join(__dirname, '..')
const CARD = path.join(APP, 'src/ui/MusicEmbedCard.js')
const CADDYFILE = path.join(APP, '../../deploy/seeder/Caddyfile')

// String literals are kept whole, so a '//' inside a URL never hides the
// rest of its line.
function withoutComments (src) {
  return src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')
}

const raw = fs.readFileSync(CARD, 'utf8')
const src = withoutComments(raw)

test('the web frame-src list is exactly EMBED_FRAME_ORIGINS', async (t) => {
  const { EMBED_FRAME_ORIGINS } = await import('../src/musicEmbed.js')
  const csp = fs.readFileSync(CADDYFILE, 'utf8').split('\n').filter((line) => /^\s*Content-Security-Policy\s/.test(line))
  t.is(csp.length, 1, 'one Content-Security-Policy header')
  const directive = csp[0].split(';').map((d) => d.trim().replace(/^"/, '')).find((d) => d.startsWith('frame-src '))
  t.ok(directive, 'the header has frame-src')
  t.alike(directive.split(/\s+/).slice(1), [...EMBED_FRAME_ORIGINS])
})

test('the card never claims playback and watches other players', (t) => {
  t.absent(raw.includes('claimPlayback'), 'no claimPlayback anywhere')
  t.ok(src.includes("import { playbackClaimCount } from '../media/chatMedia'"), 'imports playbackClaimCount')
  t.ok(src.includes('const claims = useRef(playbackClaimCount())'), 'the count when the card mounts')
  t.ok(/const count = playbackClaimCount\(\)\s*const allowed = count === claims\.current\s*claims\.current = count/.test(src), 'a new claim drops the frame for one check')
})

test('the frame mounts only for a live state on the visible screen', (t) => {
  t.ok(src.includes("import { EmbedBandBottom, ScreenVisible, SheetDepth } from './screenVisible'"), 'imports ScreenVisible')
  t.ok(src.includes('const visible = useContext(ScreenVisible)'), 'reads ScreenVisible')
  const frames = [...src.matchAll(/<EmbedFrame\b/g)]
  t.is(frames.length, 1, 'one EmbedFrame')
  t.ok(/state\.live && active\s*\?\s*\(\s*$/.test(src.slice(0, frames[0].index)), 'preceded by state.live && active')
  const frame = src.slice(frames[0].index, src.indexOf('/>', frames[0].index))
  for (const prop of [
    'embedUrl={embed.embedUrl}',
    'html={embedHtml(embed)}',
    'baseUrl={EMBED_BASE_URL}',
    'allowTop={topNavigationAllowed}',
    'height={height}'
  ]) t.ok(frame.includes(prop), prop)
  t.absent(frame.includes('onOpenExternal'), 'the player is given no way out of the app')
  t.ok(src.includes('const active = visible && !held && fits'), 'active needs the visible screen, no hold and a fit')
  t.ok(src.includes('const fits = width > 0 && width >= embed.minWidth'), 'fits only once measured')
  t.ok(src.includes('const height = embedHeight(embed, width)'), 'slot height from the measured width')
  t.ok(src.includes('style={[styles.slot, { height }]}'), 'the slot always has the player height')
})

test('the card checks its slot every 500 ms against the feed band', (t) => {
  t.ok(src.includes("import { EMBED_IDLE, EMBED_TICK_MS, embedSlots, embedStep, embedsHeld, mostlyHidden, onEmbedHold } from '../embedLive'"), 'imports from ../embedLive')
  t.absent(/function mostlyHidden/.test(src), 'no local mostlyHidden')
  t.ok(src.includes('setInterval(check, EMBED_TICK_MS)'), 'EMBED_TICK_MS in setInterval')
  t.ok(src.includes('const top = insets.top + layout.topBar'), 'the band starts under the top bar')
  t.ok(src.includes('const bottom = win.height - (insets.bottom + (tabBarShown ? layout.tabBar : 0))'), 'the band ends above the tab bar, when there is one')
  t.ok(src.includes('settle(mostlyHidden(x, y, w, h, top, bottom, win.width))'), 'measured against the band')
  t.ok(/const settle = \(hidden\) => \{\s*pending = false\s*apply\(embedStep\(stateRef\.current, \{ hidden, allowed, turned, free \}\)\)\s*\}/.test(src), 'embedStep with the answer')
  t.ok(src.includes('return () => { cancelled = true; clearInterval(timer) }'), 'the cleanup')
  t.ok(/if \(!active\) \{\s*apply\(EMBED_IDLE\)\s*return undefined\s*\}/.test(src), 'inactive drops the frame at once, with no timer')
  t.ok(/if \(!view \|\| typeof view\.measureInWindow !== 'function'\) \{\s*unseen\(\)\s*return\s*\}/.test(src), 'no slot or no measure counts as hidden')
  t.ok(/\} catch \{\s*unseen\(\)\s*\}/.test(src), 'a throwing measure counts as hidden')
  t.ok(src.includes('const unseen = () => settle(true)'), 'hidden: true')
  t.ok(src.includes("import { TabBarShown } from './tabBarShown'") && src.includes('useContext(TabBarShown)'), 'reads TabBarShown')
  t.ok(src.includes('[active, win.width, win.height, insets.top, insets.bottom, tabBarShown, band]'), 'the effect dependencies')
})

test('a new claim drops the frame before any measurement', (t) => {
  t.ok(/const allowed = count === claims\.current\s*claims\.current = count\s*if \(!allowed\) \{\s*apply\(EMBED_IDLE\)\s*return\s*\}/.test(src), 'dropped synchronously')
})

test('a check whose answer never came counts as hidden', (t) => {
  t.ok(src.includes('let pending = false'), 'a pending flag per effect run')
  t.ok(/const check = \(\) => \{\s*if \(cancelled\) return\s*const id = \+\+round\s*const missed = pending\s*pending = false\s*const count = playbackClaimCount\(\)/.test(src), 'every check invalidates earlier answers before any early return')
  t.is((src.match(/\+\+round/g) || []).length, 1, 'round moves only at the top of a check')
  t.ok(/if \(missed\) unseen\(\)\s*pending = true\s*try \{\s*view\.measureInWindow/.test(src), 'a missing answer is hidden at the next tick, then measured again')
  t.ok(/measureInWindow\(\(x, y, w, h\) => \{\s*if \(cancelled \|\| !alive\.current \|\| id !== round\) return\n/.test(src), 'only the latest check applies')
})

// The card's check() lifted out of its source and run against stub
// measurements, with the real embedLive rules.
async function liftCheck (env) {
  const live = await import('../src/embedLive.js')
  const start = raw.indexOf('    let round = 0')
  const end = raw.indexOf('    // The dwell counts ticks')
  if (start === -1 || end === -1) throw new Error('check() not found in MusicEmbedCard.js')
  const names = ['playbackClaimCount', 'claims', 'apply', 'EMBED_IDLE', 'embedSlots', 'stateRef', 'base', 'win', 'embedStep', 'slot', 'band', 'alive', 'mostlyHidden', 'top', 'bottom', 'cancelled']
  const all = { ...env, EMBED_IDLE: live.EMBED_IDLE, embedStep: live.embedStep, mostlyHidden: live.mostlyHidden, cancelled: false }
  const make = new Function(...names, raw.slice(start, end) + '\nreturn check') // eslint-disable-line no-new-func
  return { check: make(...names.map((n) => all[n])), live }
}

test('a measurement in flight across a playback claim never applies', async (t) => {
  let claimCount = 0
  const answers = []
  const stateRef = { current: null }
  const slots = { count: () => 0, free: () => true }
  const { check, live } = await liftCheck({
    playbackClaimCount: () => claimCount,
    claims: { current: 0 },
    apply: (next) => { stateRef.current = next },
    embedSlots: slots,
    stateRef,
    base: { current: false },
    win: { width: 390, height: 844 },
    slot: { current: { measureInWindow: (cb) => answers.push(cb) } },
    band: null,
    alive: { current: true },
    top: 99,
    bottom: 761
  })
  stateRef.current = live.EMBED_IDLE
  const answer = () => answers.shift()(0, 300, 300, 152)
  check()
  answer()
  t.alike(stateRef.current, { live: false, seen: 1 }, 'one visible check')
  check()
  claimCount++
  check()
  t.is(stateRef.current, live.EMBED_IDLE, 'another player dropped the dwell')
  answer()
  t.is(stateRef.current, live.EMBED_IDLE, 'the answer from before the claim is ignored')
  check()
  answer()
  t.is(stateRef.current.live, false, 'one fresh visible check loads nothing')
  check()
  answer()
  t.is(stateRef.current.live, true, 'the second fresh visible check loads the frame')
})

test('the dwell counts ticks, not effect runs', (t) => {
  t.ok(/if \(stateRef\.current\.live\) check\(\)\s*const timer = setInterval\(check, EMBED_TICK_MS\)/.test(src), 'only a live frame is checked at once')
  t.absent(/\n\s*check\(\)\n\s*const timer/.test(src), 'no unconditional immediate check')
})

test('a slot is acquired on going live and released on leave and unmount', (t) => {
  t.ok(/if \(next\.live && !stateRef\.current\.live\) \{\s*const done = embedSlots\.acquire\(\)\s*if \(done === null\) \{\s*next = EMBED_IDLE\s*\} else \{\s*release\.current = done/.test(src), 'acquire only on going live, a null result falls back to idle, the release is kept')
  t.ok(/if \(!next\.live && release\.current !== null\) \{\s*const done = release\.current\s*release\.current = null\s*done\(\)/.test(src), 'apply releases on leaving live')
  t.ok(/return \(\) => \{\s*alive\.current = false\s*stateRef\.current = EMBED_IDLE\s*const done = release\.current\s*release\.current = null\s*if \(typeof done === 'function'\) done\(\)/.test(src), 'unmount releases')
})

test('a turned window keeps a live frame', (t) => {
  t.ok(src.includes('const turned = (win.width > win.height) !== base.current'), 'turned is compared with base.current')
  t.ok(src.includes('if (embedSlots.count() === 0 || !stateRef.current.live) base.current = win.width > win.height'), 'the base follows the window while this card is not live')
  const at = src.indexOf('return () => { cancelled = true; clearInterval(timer) }')
  t.ok(at !== -1, 'the cleanup cancels and clears the interval')
  t.absent(src.slice(at, src.indexOf('\n', at)).includes('apply('), 'the cleanup does not reset the state')
})

test('a measurement from an earlier check never applies', (t) => {
  t.ok(src.includes('let cancelled = false'), 'the effect declares cancelled')
  t.ok(src.includes('if (cancelled) return\n'), 'check returns once cancelled')
  t.ok(/measureInWindow\(\(x, y, w, h\) => \{\s*if \(cancelled \|\| !alive\.current \|\| id !== round\) return\n/.test(src), 'the measure callback tests cancelled before apply')
  const at = src.indexOf('return () => { cancelled = true; clearInterval(timer) }')
  t.ok(at !== -1, 'the cleanup sets cancelled')
  t.absent(src.slice(at, src.indexOf('\n', at)).includes('apply('), 'the cleanup calls no apply')
})

test('no tap gate, no notice, the outside link stays', (t) => {
  for (const text of ['Tocar aqui', 'Fechar player', 'EMBED_PLAY', 'EMBED_CLOSE', 'embedNotice', 'OPEN_GRACE_MS']) t.absent(src.includes(text), 'no ' + text)
  t.ok(src.includes("const openLabel = 'Abrir no ' + name"))
  t.ok(src.includes('const openPage = () => openExternal(url)'))
  t.ok(src.includes("from '../openExternal'"))
  t.ok(/accessibilityLabel=\{openLabel\}\s*onPress=\{openPage\}/.test(src), 'on a tap of "Abrir no ..."')
})

test('the visible-screen signal is provided by the App and the stack', (t) => {
  const visible = fs.readFileSync(path.join(APP, 'src/ui/screenVisible.js'), 'utf8')
  t.ok(visible.includes('export const ScreenVisible = createContext(false)'))
  t.ok(visible.includes('export const ScreenCovered = createContext(false)'))
  t.ok(visible.includes('export const SheetDepth = createContext(0)'))
  t.ok(visible.includes('export const EmbedBandBottom = createContext(null)'))
  const stack = withoutComments(fs.readFileSync(path.join(APP, 'src/ui/StackLayer.js'), 'utf8'))
  t.ok(stack.includes('const covered = useContext(ScreenCovered)'), 'the stack reads ScreenCovered')
  t.ok(stack.includes("<ScreenVisible.Provider value={!covered && role === 'top'}>"), 'only the top entry is visible')
  const app = withoutComments(fs.readFileSync(path.join(APP, 'App.js'), 'utf8'))
  t.ok(app.includes('<ScreenCovered.Provider value={covered}>'), 'the App provides ScreenCovered')
  t.ok(app.includes('const covered = composer.open || ajustes !== null || report !== null || helpOpen || pageDmAsk !== null || locked || backgrounded'), 'covered')
  t.ok(app.includes('const screenSeen = (id) => !covered && !stacked && tab === id'), 'screenSeen')
  t.ok(app.includes("const [backgrounded, setBackgrounded] = useState(() => AppState.currentState === 'background')"), 'backgrounded starts from the current state')
  const tabs = ['rua', 'espiadinha', 'busca', 'avisos', 'comunidades', 'feira', 'diario']
  t.is([...app.matchAll(/<ScreenVisible\.Provider value=\{screenSeen\('(\w+)'\)\}>/g)].map((m) => m[1]).join(), tabs.join(), 'seven tab providers')
  t.ok(/if \(state === 'background'\) setBackgrounded\(true\)\s*else if \(state === 'active'\) setBackgrounded\(false\)/.test(app), 'backgrounded follows background and active only')
})

test('the card follows its sheet depth', (t) => {
  t.ok(src.includes('const depth = useContext(SheetDepth)'))
  t.ok(src.includes('const [held, setHeld] = useState(() => embedsHeld(depth))'))
  t.ok(/const sync = \(\) => setHeld\(embedsHeld\(depth\)\)\s*sync\(\)\s*return onEmbedHold\(sync\)\s*\}, \[depth\]\)/.test(src), 'the sync effect is keyed on depth')
})

test('a list may lower the band', (t) => {
  t.ok(src.includes('const band = useContext(EmbedBandBottom)'))
  const measure = src.indexOf('measureInWindow((x, y, w, h) => {')
  const call = src.indexOf('band.measure(')
  t.ok(measure !== -1 && call > measure, 'band.measure is called inside the measureInWindow callback')
  t.ok(/if \(!\(typeof limit === 'number' && Number\.isFinite\(limit\) && limit > 0\)\) \{\s*settle\(true\)\s*return\s*\}/.test(src), 'a band with no usable answer counts as hidden')
  t.ok(src.includes('settle(mostlyHidden(x, y, w, h, top, Math.min(bottom, limit), win.width))'), 'a usable answer lowers the band')
  t.ok(/const withLimit = \(limit\) => \{[^}]*?if \(cancelled \|\| !alive\.current \|\| id !== round\) return\n/.test(src), 'cancelled is tested again in the band callback')
  t.ok(/try \{\s*band\.measure\(withLimit\)\s*\} catch \{\s*withLimit\(null\)\s*\}/.test(src), 'a throw counts as no answer, so hidden')
  t.absent(/:\s*bottom\b/.test(src.slice(src.indexOf('const withLimit'), src.indexOf('band.measure(withLimit)'))), 'the band callback never falls back to the window band')
})

test('the stand-in is a still LinkCard', (t) => {
  const cards = [...src.matchAll(/<LinkCard\b[^>]*\/>/g)].map((m) => m[0])
  t.is(cards.length, 1, 'one LinkCard element')
  t.ok(/\bstill \/>$/.test(cards[0]), 'drawn still')
  t.absent(cards[0].includes('onDismiss'), 'no onDismiss passed to it')
  t.ok(src.includes('<View style={styles.standIn} onStartShouldSetResponder={() => true}>{still}</View>'), 'the slot draws it')
  t.absent(src.includes('MediaView'), 'no MediaView in the card')
})

test('a draft has a remove button and a tall draft has no frame', (t) => {
  t.ok(/typeof onDismiss === 'function'\s*\?\s*\(\s*<Pressable\s*accessibilityRole='button'\s*accessibilityLabel=\{LINK_CARD_DISMISS\}\s*onPress=\{onDismiss\}\s*hitSlop=\{4\}/.test(src), 'the remove button')
  t.ok(src.includes("import { LINK_CARD_DISMISS, LinkCard } from './LinkCard'"))
  t.ok(src.includes('const tooTall = !!draft && !state.live && height > win.height / 3'), 'a live draft frame is never swapped out when the window turns')
  t.ok(/if \(tooNarrow \|\| tooTall\) \{\s*return \(\s*<View onLayout=\{onLayout\}>\s*\{still\}\s*\{actions\}\s*<\/View>/.test(src), 'no slot or frame when too narrow or too tall')
})

test('taps inside the slot stay in the slot', (t) => {
  const start = src.indexOf('ref={slot}')
  const slot = src.slice(start, src.indexOf('>', src.indexOf('onKeyDown=', start)))
  t.absent(slot.includes('onStartShouldSetResponder'), 'the slot claims no touch, so Android never intercepts a drag in the player')
  t.ok(slot.includes('onClick={stopClick}'))
  t.ok(slot.includes('onKeyDown={stopPressKeys}'))
  t.ok(/<View style=\{styles\.standIn\} onStartShouldSetResponder=\{\(\) => true\}>/.test(src), 'the stand-in claims the touch')
  t.absent(/onResponderGrant/.test(src), 'no responder grant')
  t.ok(/<\/View>\s*\{actions\}\s*<\/View>\s*\)\s*\}\s*const makeStyles/.test(src), 'the slot is followed by the actions row')
})

test('an open sheet holds what is under it', (t) => {
  const sheet = withoutComments(fs.readFileSync(path.join(APP, 'src/ui/Sheet.js'), 'utf8'))
  t.ok(sheet.includes("import { holdEmbeds } from '../embedLive'"))
  t.ok(sheet.includes('useEffect(() => (open ? holdEmbeds() : undefined), [open])'), 'the hold effect')
  t.ok(sheet.includes('<SheetDepth.Provider value={depth + 1}>'))
  t.ok(sheet.includes('<ScreenVisible.Provider value={!!open}>'))
  const fn = sheet.slice(sheet.indexOf('export function Sheet'))
  t.ok(fn.includes('>{body}</IosContent>'), 'iOS renders body')
  t.ok(fn.includes('>{body}</View>'), 'Android and web render body')
  t.is((fn.match(/\{children\}/g) || []).length, 1, 'children reach the sheet only through body')
  t.ok(fn.includes('<ScreenVisible.Provider value={!!open}>{children}</ScreenVisible.Provider>'), 'body wraps the children')
  const ios = sheet.slice(sheet.indexOf('function IosContent'), sheet.indexOf('export function Sheet'))
  t.ok(ios.includes('{children}</View>'), 'IosContent renders its own children')
})

test('a lock or the background holds every player', (t) => {
  const app = withoutComments(fs.readFileSync(path.join(APP, 'App.js'), 'utf8'))
  t.ok(app.includes("import { holdAllEmbeds } from './src/embedLive'"))
  t.ok(app.includes('useEffect(() => (locked || backgrounded ? holdAllEmbeds() : undefined), [locked, backgrounded])'))
})

test('a chat menu holds the players', (t) => {
  const sheet = withoutComments(fs.readFileSync(path.join(APP, 'src/ui/ActionsSheet.js'), 'utf8'))
  t.ok(sheet.includes("import { holdEmbeds } from '../embedLive'"))
  t.ok(sheet.includes('useEffect(() => (shown ? holdEmbeds() : undefined), [shown])'))
})

test('MusicEmbedCard is phone-safe and stays out of the Vitrine', (t) => {
  for (const api of ['window.', 'document.', 'globalThis.', 'navigator.', 'localStorage', 'Platform']) {
    t.absent(src.includes(api), 'no ' + api)
  }
  t.absent(/vitrine/i.test(src), 'no Vitrine import')
  t.absent(raw.includes('\u2014'), 'no em dash')
})

test('embedLive stays pure', async (t) => {
  await import('../src/embedLive.js')
  const source = fs.readFileSync(path.join(APP, 'src/embedLive.js'), 'utf8')
  t.absent(/^\s*import\b/m.test(source), 'no import statement')
  t.absent(/\brequire\s*\(/.test(source), 'no require call')
})

test('embedLive: mostlyHidden', async (t) => {
  const { mostlyHidden: hidden, SEEN_ENOUGH, VISIBILITY_MS, OPEN_GRACE_MS, EMBED_TICK_MS } = await import('../src/embedLive.js')
  t.is(hidden(0, 0, 300, 200, 0, 800, 400), false, 'fully visible')
  t.is(hidden(0, 700, 300, 200, 0, 800, 400), false, 'half height visible')
  t.is(hidden(0, 701, 300, 200, 0, 800, 400), true, 'less than half height visible')
  t.is(hidden(-151, 0, 300, 200, 0, 800, 400), true, 'less than half width visible')
  t.is(hidden(0, 761 - 120, 300, 450, 99, 761, 390), false, 'exactly 120 pt visible')
  t.is(hidden(0, 761 - 119, 300, 450, 99, 761, 390), true, '119 pt visible')
  t.is(hidden(NaN, 0, 300, 200, 0, 800, 400), true, 'not measurable')
  t.is(hidden(undefined, 0, 300, 200, 0, 800, 400), true, 'no measurement')
  t.is(SEEN_ENOUGH, 120)
  t.is(VISIBILITY_MS, 500)
  t.is(OPEN_GRACE_MS, 2000)
  t.is(EMBED_TICK_MS, VISIBILITY_MS)
})

test('embedLive: a card goes live after two visible checks', async (t) => {
  const { embedStep, EMBED_IDLE, EMBED_LIVE, EMBED_DWELL_TICKS } = await import('../src/embedLive.js')
  const visible = { hidden: false, allowed: true, turned: false, free: true }
  t.is(EMBED_DWELL_TICKS, 2)
  t.ok(Object.isFrozen(EMBED_IDLE))
  t.ok(Object.isFrozen(EMBED_LIVE))
  const first = embedStep(EMBED_IDLE, visible)
  t.alike(first, { live: false, seen: 1 }, 'one check mounts no frame')
  t.ok(Object.isFrozen(first))
  t.is(embedStep(first, visible), EMBED_LIVE, 'the second check loads the frame')
  const hidden = { ...visible, hidden: true }
  t.is(embedStep(first, hidden), EMBED_IDLE, 'a hidden check resets the dwell')
  t.alike(embedStep(embedStep(first, hidden), visible), first, 'a fling cannot carry dwell forward')
  t.is(embedStep(EMBED_LIVE, { ...visible, allowed: false }), EMBED_IDLE)
  t.is(embedStep(EMBED_LIVE, hidden), EMBED_IDLE)
  t.is(embedStep(EMBED_LIVE, { ...hidden, turned: true }), EMBED_LIVE, 'a rotated full-screen player keeps its slot')
  t.is(embedStep(first, { ...visible, turned: true }), EMBED_IDLE, 'rotation cannot load a new frame')
  t.is(embedStep(EMBED_LIVE, { ...hidden, allowed: false, turned: true }), EMBED_IDLE, 'disallowed wins over rotation')
  t.is(embedStep(EMBED_LIVE, { ...visible, free: false }), EMBED_LIVE, 'a loaded frame never yields its slot')
  const waiting = embedStep(first, { ...visible, free: false })
  t.alike(waiting, { live: false, seen: 2 }, 'dwell is kept when both slots are occupied')
  t.ok(Object.isFrozen(waiting))
  t.alike(embedStep(waiting, { ...visible, free: false }), waiting, 'waiting dwell is capped')
  t.is(embedStep(waiting, visible), EMBED_LIVE, 'a free slot needs no new dwell')
  const live = { live: true, seen: 2 }
  t.is(embedStep(live, visible), live, 'a valid live state is preserved')
  for (const state of [undefined, null, false, 1, 'x', {}, { live: 1, seen: 0 }, { live: true, seen: NaN }, { live: false, seen: Infinity }]) {
    t.is(embedStep(state, undefined), EMBED_IDLE, 'malformed inputs are idle')
    t.alike(embedStep(state, visible), first, 'an invalid state starts its dwell from idle')
  }
  for (const sample of [null, false, 1, 'x', {}, { ...visible, allowed: 1 }, { ...visible, hidden: 0 }]) {
    t.is(embedStep(EMBED_LIVE, sample), EMBED_IDLE, 'invalid samples cannot keep a frame')
  }
  const broken = { get live () { throw new Error('unreadable') } }
  t.is(embedStep(broken, visible), EMBED_IDLE, 'unreadable inputs never throw')
})

test('embedLive: slots never evict', async (t) => {
  const { createEmbedSlots, embedSlots, EMBED_LIVE_MAX } = await import('../src/embedLive.js')
  t.is(EMBED_LIVE_MAX, 2)
  t.is(embedSlots.count(), 0, 'the shared slots start empty')
  const slots = createEmbedSlots(2)
  t.is(slots.count(), 0)
  t.is(slots.free(), true)
  const first = slots.acquire()
  const second = slots.acquire()
  t.is(typeof first, 'function')
  t.is(typeof second, 'function')
  t.is(slots.count(), 2)
  t.is(slots.free(), false)
  t.is(slots.acquire(), null, 'a newcomer cannot evict a holder')
  t.is(slots.count(), 2, 'both holders remain')
  first()
  t.is(slots.count(), 1)
  t.is(slots.free(), true)
  const third = slots.acquire()
  t.is(typeof third, 'function', 'a released slot can be acquired')
  first()
  t.is(slots.count(), 2, 'an old release cannot remove a newer holder')
  t.is(slots.free(), false)
  second()
  second()
  t.is(slots.count(), 1, 'release is idempotent')
  t.is(slots.free(), true)
  third()
  t.is(slots.count(), 0)
  t.is(slots.free(), true)
  const single = createEmbedSlots(1)
  const release = single.acquire()
  t.is(single.acquire(), null, 'the supplied maximum is honored')
  release()
})

test('embedLive: holds are layered', async (t) => {
  const { holdEmbeds, holdAllEmbeds, embedsHeld, onEmbedHold } = await import('../src/embedLive.js')
  const releases = []
  const calls = []
  const offThrow = onEmbedHold(() => { throw new Error('listener failed') })
  const off = onEmbedHold((...args) => calls.push({ args, held: embedsHeld(1) }))
  try {
    t.is(embedsHeld(), false)
    const first = holdEmbeds()
    releases.push(first)
    t.is(calls.length, 1, 'a throwing listener does not stop the other listener')
    t.alike(calls[0], { args: [], held: false }, 'listeners re-read at their own depth')
    t.is(embedsHeld(0), true)
    t.is(embedsHeld(1), false)
    for (const depth of [-1, 1.5, 'x']) t.is(embedsHeld(depth), true, 'invalid depth counts as zero')
    const second = holdEmbeds()
    releases.push(second)
    t.is(calls.length, 2)
    t.is(embedsHeld(1), true)
    t.is(embedsHeld(2), false)
    const all = holdAllEmbeds()
    releases.push(all)
    t.is(calls.length, 3)
    t.is(embedsHeld(9), true, 'an all-card hold ignores depth')
    all()
    t.is(calls.length, 4)
    t.is(embedsHeld(9), false, 'releasing the all-card hold leaves only layers')
    all()
    t.is(calls.length, 4, 'double release notifies nobody')
    first()
    t.is(calls.length, 5)
    t.is(embedsHeld(0), true, 'one layer remains after an out-of-order release')
    t.is(embedsHeld(1), false)
    first()
    t.is(calls.length, 5)
    second()
    t.is(calls.length, 6)
    t.is(embedsHeld(), false)
    const onlyAll = holdAllEmbeds()
    releases.push(onlyAll)
    t.is(calls.length, 7)
    t.is(embedsHeld(0), true)
    t.is(embedsHeld(1), true, 'an all-card hold cannot be treated as a layer')
    onlyAll()
    t.is(calls.length, 8)
    t.is(embedsHeld(), false)
    off()
    off()
    const after = holdEmbeds()
    releases.push(after)
    after()
    t.is(calls.length, 8, 'unsubscribe stops notifications')
    t.is(embedsHeld(), false, 'a throwing listener never breaks counter cleanup')
    const noop = onEmbedHold(null)
    t.is(typeof noop, 'function', 'invalid listeners get a no-op unsubscribe')
    noop()
    noop()
  } finally {
    offThrow()
    off()
    for (const release of releases) release()
  }
})
