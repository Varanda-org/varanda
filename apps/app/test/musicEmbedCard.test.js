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
  t.ok(/const count = playbackClaimCount\(\)\s*const touching = embedSlots\.engaged\(release\.current\)\s*const at = embedSlots\.engagedAt\(release\.current\)\s*if \(touching && !touchSeen\.current && Number\.isFinite\(at\)\) claims\.current = Math\.max\(claims\.current, at\)\s*touchSeen\.current = touching\s*const allowed = count === claims\.current \|\| !touchedNow\(release\.current\)\s*claims\.current = count/.test(src), 'a new claim drops a touched frame for one check, unless it came before the touch')
  t.ok(/function touchedNow \(release\) \{\s*return embedTouched\(embedSlots\.engaged\(release\), screenReaderOn\(\), screenReaderKnown\(\)\)\s*\}/.test(src), 'touched is read at the moment of each decision')
  t.ok(src.includes("import { screenReaderKnown, screenReaderOn } from './screenReader'"), 'the screen reader state comes from ./screenReader')
})

test('the frame mounts only for a live state on the visible screen', (t) => {
  t.ok(src.includes("import { EmbedBandBottom, EmbedHost, EmbedRowKey, RowShift, ScreenVisible, SheetDepth } from './screenVisible'"), 'imports ScreenVisible')
  t.ok(src.includes('const visible = useContext(ScreenVisible)'), 'reads ScreenVisible')
  const frames = [...src.matchAll(/<EmbedFrame\b/g)]
  t.is(frames.length, 1, 'one EmbedFrame')
  t.ok(/\{parts\.frame\s*\?\s*\(\s*<Animated\.View key='frame' style=\{settled \? styles\.frame : \[styles\.frame, \{ opacity: ready \? opacity : 0 \}\]\} pointerEvents=\{ready \? 'auto' : 'none'\}>\s*$/.test(src.slice(0, frames[0].index)), 'inside the parts.frame branch, out of touches until loaded')
  t.ok(/\{parts\.empty\s*\? <View key='empty' style=\{\{ height \}\} accessibilityLabel=\{'Player do ' \+ name\} onStartShouldSetResponder=\{\(\) => true\} \/>\s*: null\}/.test(src), 'a card in a list row leaves an empty slot of the player height for the layer')
  t.ok(src.includes("const parts = slotParts(live, key !== '' && !inline, ready)"), 'what the slot draws comes from slotParts')
  t.ok(src.includes('const live = state.live\n'), 'a kept frame stays live while its screen is not shown')
  const frame = src.slice(frames[0].index, src.indexOf('/>', frames[0].index))
  for (const prop of [
    'embedUrl={embed.embedUrl}',
    'html={embedHtml(embed)}',
    'baseUrl={EMBED_BASE_URL}',
    'allowTop={topNavigationAllowed}',
    'height={height}'
  ]) t.ok(frame.includes(prop), prop)
  t.ok(frame.includes('onOpen={ready && active ? openFromPlayer : undefined}'), 'a link inside a loaded player is handed to openFromPlayer, only while it is shown and not held')
  t.ok(src.includes('const active = visible && !held && fits\n'), 'active needs a shown screen and no hold')
  t.ok(frame.includes('onGone={() => { embedSlots.shrink(Date.now()); apply(EMBED_IDLE) }}'), 'a dead content process lowers the cap and brings the stored card back')
  t.ok(frame.includes('onEngage={(on) => embedSlots.engage(release.current, on, playbackClaimCount())}'), 'a touch marks the slot engaged')
  t.ok(frame.includes('onReady={() => setReady(true)}'), 'the loaded page shows the frame')
  t.ok(frame.includes('parked={!ready}'), 'out of the screen reader until loaded')
  t.ok(/const out = embedExitUrl\(embed, target\)\s*if \(out !== null\) openExternal\(out\)/.test(src), 'it leaves the app only through embedExitUrl')
  t.ok(src.includes('  embedExitUrl,\n') && src.includes("} from '../musicEmbed'"), 'embedExitUrl comes from ../musicEmbed')
  t.ok(src.includes('const active = visible && !held && fits'), 'active needs the visible screen, no hold and a fit')
  t.ok(src.includes('const fits = width > 0 && width >= embed.minWidth'), 'fits only once measured')
  t.ok(src.includes('const height = embedHeight(embed, width)'), 'slot height from the measured width')
  t.ok(src.includes('style={[styles.slot, { height }]}'), 'the slot always has the player height')
})

test('the card checks its slot every 500 ms against the feed band', (t) => {
  t.ok(src.includes("import { EMBED_IDLE, EMBED_PARKED, EMBED_TICK_MS, EMBED_WAITING, bandGap, embedNear, embedSlots, embedStays, embedStep, embedTouched, embedsHeld, embedsHeldAll, mostlyHidden, onEmbedHold } from '../embedLive'"), 'imports from ../embedLive')
  t.absent(/farFromBand|EMBED_FAR_SCREENS|\bfar\b/.test(src), 'no distance rule')
  t.absent(/function mostlyHidden/.test(src), 'no local mostlyHidden')
  t.ok(src.includes('setInterval(check, EMBED_TICK_MS)'), 'EMBED_TICK_MS in setInterval')
  t.ok(src.includes('const top = insets.top + layout.topBar'), 'the band starts under the top bar')
  t.ok(src.includes('const bottom = win.height - (insets.bottom + (tabBarShown ? layout.tabBar : 0))'), 'the band ends above the tab bar, when there is one')
  t.ok(src.includes('answer(x, y, w, h, bottom)'), 'measured against the band')
  t.ok(/const settle = \(hidden, mayYield = true, gap = Infinity, near = false\) => \{\s*pending = false\s*const free = stateRef\.current\.live \|\| embedSlots\.free\(gap, readerTouchNow\(\)\)\s*apply\(embedStep\(stateRef\.current, \{ hidden, near, allowed, turned, free \}\), mayYield, gap\)\s*\}/.test(src), 'embedStep with the answer, its distance handed to apply')
  t.ok(/const answer = \(x, y, w, h, lower\) => \{\s*const hidden = mostlyHidden\(x, y, w, h, top, lower, win\.width\)\s*const gap = hidden \? Math\.max\(bandGap\(x, y, w, h, top, lower, win\.width\), 1\) : 0\s*settle\(hidden, true, gap, embedNear\(gap, top, lower\)\)\s*\}/.test(src), 'the distance and nearness of the slot, never 0 when hidden')
  t.ok(src.includes('return () => { cancelled = true; clearInterval(timer) }'), 'the cleanup')
  t.ok(/if \(!active\) \{\s*if \(!stateRef\.current\.live \|\| !fits \|\| !embedStays\(touchedNow\(release\.current\), locked\)\) \{\s*apply\(EMBED_IDLE\)\s*return undefined\s*\}/.test(src), 'inactive drops a touched frame at once, with no timer')
  t.ok(/const idle = setInterval\(keep, EMBED_TICK_MS\)\s*return \(\) => clearInterval\(idle\)\s*\}/.test(src), 'an untouched one keeps only a tick that parks it')
  t.ok(/if \(!view \|\| typeof view\.measureInWindow !== 'function'\) \{\s*unseen\(\)\s*return\s*\}/.test(src), 'no slot or no measure counts as hidden')
  t.ok(/\} catch \{\s*unseen\(\)\s*\}/.test(src), 'a throwing measure counts as hidden')
  t.ok(src.includes('const unseen = () => settle(true)'), 'hidden: true')
  t.ok(src.includes("import { TabBarShown } from './tabBarShown'") && src.includes('useContext(TabBarShown)'), 'reads TabBarShown')
  t.ok(src.includes('[active, fits, locked, win.width, win.height, insets.top, insets.bottom, tabBarShown, band]'), 'the effect dependencies')
})

test('a new claim drops the frame before any measurement', (t) => {
  t.ok(/const allowed = count === claims\.current \|\| !touchedNow\(release\.current\)\s*claims\.current = count\s*if \(!allowed\) \{\s*apply\(EMBED_IDLE\)\s*return\s*\}/.test(src), 'dropped synchronously')
})

test('a check whose answer never came counts as hidden', (t) => {
  t.ok(src.includes('let pending = false'), 'a pending flag per effect run')
  t.ok(/const check = \(\) => \{\s*if \(cancelled\) return\s*const id = \+\+round\s*const missed = pending\s*pending = false\s*const count = playbackClaimCount\(\)/.test(src), 'every check invalidates earlier answers before any early return')
  t.is((src.match(/\+\+round/g) || []).length, 1, 'round moves only at the top of a check')
  t.ok(/if \(missed\) settle\(true, false\)\s*pending = true\s*try \{\s*view\.measureInWindow/.test(src), 'a missing answer is hidden at the next tick, may not yield, then is measured again')
  t.is((src.match(/settle\(true, false\)/g) || []).length, 1, 'only the missing answer is barred from yielding')
  t.ok(/measureInWindow\(\(x, y, w, h\) => \{\s*if \(cancelled \|\| !alive\.current \|\| id !== round\) return\n/.test(src), 'only the latest check applies')
})

// The card's touchedNow(), as written, against the given slots and a stub
// screen reader.
function liftTouched (live, slots, reader) {
  const m = raw.match(/function touchedNow \(release\) \{([\s\S]*?)\n\}/)
  if (!m) throw new Error('touchedNow not found in MusicEmbedCard.js')
  const fn = new Function('embedTouched', 'embedSlots', 'screenReaderOn', 'screenReaderKnown', 'release', m[1]) // eslint-disable-line no-new-func
  return (release) => fn(live.embedTouched, slots, () => reader.on, () => reader.known, release)
}

// The card's readerTouchNow(), as written, against a stub screen reader.
function liftReaderTouch (live, reader) {
  const m = raw.match(/function readerTouchNow \(\) \{([\s\S]*?)\n\}/)
  if (!m) throw new Error('readerTouchNow not found in MusicEmbedCard.js')
  const fn = new Function('embedTouched', 'screenReaderOn', 'screenReaderKnown', m[1]) // eslint-disable-line no-new-func
  return () => fn(live.embedTouched, () => reader.on, () => reader.known)
}

// The card's check() lifted out of its source and run against stub
// measurements, with the real embedLive rules. env.reader is the screen
// reader (default: known off).
async function liftCheck (env) {
  const live = await import('../src/embedLive.js')
  const start = raw.indexOf('    let round = 0')
  const end = raw.indexOf('    // The dwell counts ticks')
  if (start === -1 || end === -1) throw new Error('check() not found in MusicEmbedCard.js')
  const names = ['playbackClaimCount', 'claims', 'apply', 'EMBED_IDLE', 'embedSlots', 'stateRef', 'base', 'win', 'embedStep', 'slot', 'band', 'alive', 'mostlyHidden', 'bandGap', 'embedNear', 'top', 'bottom', 'cancelled', 'placeFrame', 'release', 'touchedNow', 'readerTouchNow', 'touchSeen']
  const all = { placeFrame: () => {}, release: { current: null }, touchSeen: { current: false }, ...env, EMBED_IDLE: live.EMBED_IDLE, embedStep: live.embedStep, mostlyHidden: live.mostlyHidden, bandGap: live.bandGap, embedNear: live.embedNear, cancelled: false }
  all.touchedNow = liftTouched(live, all.embedSlots, env.reader || { on: false, known: true })
  all.readerTouchNow = liftReaderTouch(live, env.reader || { on: false, known: true })
  const make = new Function(...names, raw.slice(start, end) + '\nreturn check') // eslint-disable-line no-new-func
  return { check: make(...names.map((n) => all[n])), live }
}

test('a measurement in flight across a playback claim never applies', async (t) => {
  let claimCount = 0
  const answers = []
  const stateRef = { current: null }
  const slots = { count: () => 0, free: () => true, engaged: () => false, engagedAt: () => null }
  const { check, live } = await liftCheck({
    // A reader that has not answered counts as a touch, so a claim drops the dwell.
    reader: { on: false, known: false },
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

// A loaded card driven through its lifted check() with stub answers.
async function liftLive () {
  const answers = []
  const seen = []
  const stateRef = { current: null }
  const { check, live } = await liftCheck({
    playbackClaimCount: () => 0,
    claims: { current: 0 },
    apply: (next) => { stateRef.current = next; seen.push(next) },
    embedSlots: { count: () => 1, free: () => false, engaged: () => false, engagedAt: () => null },
    stateRef,
    base: { current: false },
    win: { width: 390, height: 844 },
    slot: { current: { measureInWindow: (cb) => answers.push(cb) } },
    band: null,
    alive: { current: true },
    top: 99,
    bottom: 761
  })
  stateRef.current = live.EMBED_LIVE
  const inBand = () => answers.shift()(0, 300, 300, 152)
  const offBand = () => answers.shift()(0, 2000, 300, 152)
  return { check, live, stateRef, seen, answers, inBand, offBand }
}

test('a loaded card stays live while its answers say hidden', async (t) => {
  const { check, live, stateRef, seen, inBand, offBand } = await liftLive()
  check()
  offBand()
  t.is(stateRef.current, live.EMBED_AWAY, 'one off-band answer marks it away')
  check()
  offBand()
  t.is(stateRef.current, live.EMBED_PARKED, 'the second parks it')
  check()
  offBand()
  t.is(stateRef.current, live.EMBED_PARKED, 'more off-band answers keep it parked')
  check()
  inBand()
  t.is(stateRef.current, live.EMBED_LIVE, 'back in the band it is live again')
  t.ok(seen.every((s) => s.live === true), 'never idle in between')
})

test('one late answer never parks a card', async (t) => {
  const { check, live, stateRef, answers, inBand } = await liftLive()
  check()
  t.is(stateRef.current, live.EMBED_LIVE, 'no answer yet')
  check()
  t.is(stateRef.current, live.EMBED_AWAY, 'a missing answer counts as one hidden check')
  answers.shift()(0, 300, 300, 152)
  t.is(stateRef.current, live.EMBED_AWAY, 'the late answer of the earlier check is ignored')
  inBand()
  t.is(stateRef.current, live.EMBED_LIVE, 'the next visible answer clears it')
})

// The card's effect branch for a card that is not active (its screen not
// shown, a hold, no fit), as written. It returns the effect's cleanup, or null
// when the card is active.
function liftInactive () {
  const start = raw.indexOf('    if (!active) {')
  const end = raw.indexOf('    // measureInWindow answers later')
  if (start === -1 || end === -1) throw new Error('the inactive branch not found in MusicEmbedCard.js')
  const names = ['active', 'stateRef', 'fits', 'embedStays', 'touchedNow', 'release', 'locked', 'apply', 'EMBED_IDLE', 'EMBED_PARKED', 'EMBED_TICK_MS', 'setInterval', 'clearInterval']
  return { names, run: new Function(...names, raw.slice(start, end) + '\nreturn null') } // eslint-disable-line no-new-func
}

// Cards driven through their real apply() and check(), lifted from the
// source, sharing one real createEmbedSlots(max), a claim count, a screen
// reader and a clock that moves one tick before each check.
async function liftCards (max = 2) {
  const live = await import('../src/embedLive.js')
  const slots = live.createEmbedSlots(max)
  const start = raw.indexOf('  const apply = (')
  const end = raw.indexOf('  useEffect(() => {\n    alive.current = true')
  if (start === -1 || end === -1) throw new Error('apply() not found in MusicEmbedCard.js')
  const names = ['embedSlots', 'release', 'stateRef', 'base', 'win', 'alive', 'setState', 'EMBED_PARKED', 'EMBED_IDLE', 'EMBED_WAITING', 'hosted', 'host', 'Date', 'readerTouchNow', 'request']
  const makeApply = new Function(...names, raw.slice(start, end) + '\nreturn apply') // eslint-disable-line no-new-func
  const inactive = liftInactive()
  const playback = { count: 0 }
  const reader = { on: false, known: true }
  const clock = { now: 1000 }
  const touchedNow = liftTouched(live, slots, reader)
  const readerTouchNow = liftReaderTouch(live, reader)
  let most = 0
  const card = async () => {
    const answers = []
    const c = {
      stateRef: { current: live.EMBED_IDLE },
      release: { current: null },
      base: { current: false },
      alive: { current: true },
      win: { width: 390, height: 844 },
      slot: { current: { measureInWindow: (cb) => answers.push(cb) } },
      shown: []
    }
    const apply = makeApply(slots, c.release, c.stateRef, c.base, c.win, c.alive, (s) => c.shown.push(s), live.EMBED_PARKED, live.EMBED_IDLE, live.EMBED_WAITING, { current: '' }, null, { now: () => clock.now }, readerTouchNow, { current: '' })
    c.apply = (...args) => {
      apply(...args)
      most = Math.max(most, slots.count())
    }
    const { check } = await liftCheck({
      reader,
      release: c.release,
      playbackClaimCount: () => playback.count,
      claims: { current: playback.count },
      apply: c.apply,
      embedSlots: slots,
      stateRef: c.stateRef,
      base: c.base,
      win: c.win,
      slot: c.slot,
      band: null,
      alive: c.alive,
      top: 99,
      bottom: 761
    })
    const answer = (y) => {
      const latest = answers.splice(0).pop()
      latest(0, y, 300, 152)
    }
    c.answers = answers
    c.check = () => { clock.now += live.EMBED_TICK_MS; check() }
    c.seen = () => { c.check(); answer(300) }
    // Past two band heights (2 x 662 pt) below the band's bottom (761).
    c.unseen = () => { c.check(); answer(3000) }
    // Many window heights below the band's bottom (761).
    c.far = () => { c.check(); answer(40000) }
    // gap pt below the band: near up to 1324.
    c.near = (gap = 239) => { c.check(); answer(761 + gap) }
    c.answerSeen = () => answer(300)
    // The card's screen is not shown (or a hold): runs the inactive branch
    // with a stub timer; c.idleTick() is one of its ticks.
    c.hide = ({ fits = true, locked = false } = {}) => {
      if (c.stop) c.stop()
      c.idleTick = null
      const env = {
        active: false,
        stateRef: c.stateRef,
        fits,
        embedStays: live.embedStays,
        touchedNow,
        release: c.release,
        locked,
        apply: c.apply,
        EMBED_IDLE: live.EMBED_IDLE,
        EMBED_PARKED: live.EMBED_PARKED,
        EMBED_TICK_MS: live.EMBED_TICK_MS,
        setInterval: (fn, ms) => { c.idleTick = fn; c.idleMs = ms; return 1 },
        clearInterval: () => { c.idleTick = null }
      }
      const stop = inactive.run(...inactive.names.map((n) => env[n]))
      c.stop = typeof stop === 'function' ? stop : null
    }
    // As the frame reports a touch: with the claim count at that moment.
    c.engage = (on = true) => slots.engage(c.release.current, on, playback.count)
    c.holds = () => c.release.current !== null
    c.asked = () => c.holds() && slots.yielding(c.release.current)
    c.park = () => { c.unseen(); c.unseen() }
    return c
  }
  // A and B live, C seen twice with both slots taken.
  const three = async () => {
    const a = await card()
    const b = await card()
    const c = await card()
    for (const x of [a, a, b, b, c, c]) x.seen()
    return { a, b, c }
  }
  return { live, slots, card, three, playback, reader, clock, most: () => most }
}

test('three cards share two slots through the real apply', async (t) => {
  const { live, slots, three, most } = await liftCards()
  const { a, b, c } = await three()
  t.is(a.stateRef.current, live.EMBED_LIVE)
  t.is(b.stateRef.current, live.EMBED_LIVE)
  t.ok(a.holds() && b.holds(), 'two cards hold the two slots')
  t.is(c.stateRef.current, live.EMBED_WAITING, 'a third visible card waits')
  t.absent(a.asked() || b.asked(), 'nobody is asked while no holder is parked')
  c.seen()
  t.is(c.stateRef.current, live.EMBED_WAITING)
  t.absent(a.asked() || b.asked(), 'still nobody asked')

  a.unseen()
  t.is(a.stateRef.current, live.EMBED_AWAY)
  c.seen()
  t.absent(a.asked(), 'one hidden check is not enough to be asked')
  a.unseen()
  t.is(a.stateRef.current, live.EMBED_PARKED, 'two hidden checks park it')
  t.ok(a.holds(), 'a parked player keeps its slot')
  c.seen()
  t.is(c.stateRef.current, live.EMBED_WAITING, 'the newcomer gets nothing at once')
  t.ok(a.asked(), 'the newcomer asks the parked holder')
  t.ok(a.holds(), 'the asked holder still holds')

  a.seen()
  t.is(a.stateRef.current, live.EMBED_LIVE, 'back in the band it stays live')
  t.ok(a.holds())
  t.absent(a.asked(), 'a visible check clears the request')

  a.park()
  // Only a touched player can be in native full screen.
  a.engage()
  c.seen()
  t.ok(a.asked())
  a.win.width = 844
  a.win.height = 390
  a.unseen()
  t.is(a.stateRef.current, live.EMBED_LIVE, 'a turned check un-parks it')
  t.ok(a.holds())
  t.absent(a.asked(), 'a turned check clears the request')
  a.win.width = 390
  a.win.height = 844
  a.engage(false)

  a.park()
  c.seen()
  t.ok(a.asked())
  a.unseen()
  t.is(a.stateRef.current, live.EMBED_IDLE, 'its own measured hidden check makes it yield')
  t.absent(a.holds(), 'and frees the slot')
  t.is(slots.count(), 1)
  c.seen()
  t.is(c.stateRef.current, live.EMBED_LIVE, 'the newcomer goes live on its next tick')
  t.ok(c.holds())
  t.is(slots.count(), 2)
  t.ok(most() <= 2, 'never more than two slots taken')
})

test('a late answer never makes an asked player yield', async (t) => {
  const { live, slots, three, most } = await liftCards()
  const { a, c } = await three()
  a.park()
  c.seen()
  t.ok(a.asked())
  a.check()
  a.check()
  t.is(a.stateRef.current, live.EMBED_PARKED, 'the missing answer counts as hidden')
  t.ok(a.holds(), 'but the asked player keeps its slot')
  t.is(slots.count(), 2)
  a.answerSeen()
  t.is(a.stateRef.current, live.EMBED_LIVE, 'its fresh answer finds it in the band')
  t.absent(a.asked(), 'and clears the request')

  a.park()
  c.seen()
  t.ok(a.asked())
  a.check()
  a.check()
  t.ok(a.holds())
  a.unseen()
  t.is(a.stateRef.current, live.EMBED_IDLE, 'a fresh hidden answer still yields')
  t.absent(a.holds())
  t.ok(most() <= 2)
})

test('an unmeasurable slot may yield', async (t) => {
  const { live, three } = await liftCards()
  const { a, c } = await three()
  a.park()
  c.seen()
  t.ok(a.asked())
  a.slot.current = null
  a.check()
  t.is(a.stateRef.current, live.EMBED_IDLE, 'no view counts as a fresh hidden check')
  t.absent(a.holds())
})

test('another release clears the request to yield', async (t) => {
  const { live, slots, three, most } = await liftCards()
  const { a, b, c } = await three()
  a.park()
  c.seen()
  t.ok(a.asked())
  b.apply(live.EMBED_IDLE)
  t.absent(b.holds(), 'the other holder leaves')
  t.absent(a.asked(), 'the request is gone')
  a.unseen()
  t.is(a.stateRef.current, live.EMBED_PARKED, 'the parked player keeps its slot')
  t.ok(a.holds())
  c.seen()
  t.is(c.stateRef.current, live.EMBED_LIVE, 'the newcomer takes the freed slot')
  t.is(slots.count(), 2)
  t.ok(most() <= 2)
})

test('a newcomer that stops waiting withdraws its request', async (t) => {
  const { live, slots, three, most } = await liftCards()
  const { a, c } = await three()
  a.park()
  c.seen()
  t.ok(a.asked(), 'the waiting newcomer asks the parked holder')
  c.unseen()
  t.is(c.stateRef.current, live.EMBED_IDLE, 'its own hidden check ends the wait')
  t.absent(a.asked(), 'and withdraws the request')
  a.unseen()
  t.is(a.stateRef.current, live.EMBED_PARKED, 'the holder keeps its parked player')
  t.ok(a.holds())

  c.seen()
  c.seen()
  t.is(c.stateRef.current, live.EMBED_WAITING)
  t.ok(a.asked(), 'waiting again asks again')
  c.apply(live.EMBED_IDLE)
  t.absent(a.asked(), 'a hold withdraws the request too')
  a.unseen()
  t.is(a.stateRef.current, live.EMBED_PARKED)
  t.ok(a.holds())
  t.is(slots.count(), 2)
  t.ok(most() <= 2)
})

test('one of two waiting newcomers leaving leaves the other to ask again', async (t) => {
  const { live, slots, card, three, most } = await liftCards()
  const { a, c } = await three()
  const d = await card()
  d.seen()
  d.seen()
  t.is(d.stateRef.current, live.EMBED_WAITING, 'a second newcomer waits too')
  a.park()
  c.seen()
  t.ok(a.asked())
  d.unseen()
  t.is(d.stateRef.current, live.EMBED_IDLE)
  t.absent(a.asked(), 'one newcomer leaving clears the request')
  c.seen()
  t.ok(a.asked(), 'the other re-asks on its next tick')
  a.unseen()
  t.is(a.stateRef.current, live.EMBED_IDLE, 'then the holder yields on its own hidden check')
  t.absent(a.holds())
  c.seen()
  t.is(c.stateRef.current, live.EMBED_LIVE, 'and the remaining newcomer goes live')
  t.ok(c.holds())
  t.is(slots.count(), 2)
  t.ok(most() <= 2, 'never more than two slots taken')
})

test('a parked holder found far away keeps its slot', async (t) => {
  const { live, slots, three, most } = await liftCards()
  const { a, b, c } = await three()
  a.park()
  t.is(a.stateRef.current, live.EMBED_PARKED)
  t.is(slots.count(), 2)
  for (let i = 0; i < 10; i++) a.far()
  t.is(a.stateRef.current, live.EMBED_PARKED, 'a check that finds it far keeps it loaded')
  t.ok(a.holds(), 'and its slot')
  t.is(slots.count(), 2)
  b.far()
  t.is(b.stateRef.current, live.EMBED_AWAY, 'a live holder found far away is only away')
  t.ok(b.holds())
  a.seen()
  t.is(a.stateRef.current, live.EMBED_LIVE, 'scrolled back, the same frame is live again')
  t.ok(a.holds())
  c.seen()
  t.is(c.stateRef.current, live.EMBED_WAITING, 'the newcomer still waits for a parked holder to yield')
  t.ok(most() <= 2, 'never more than two slots taken')
})

test('a near card out of the band goes live after two ticks and then parks', async (t) => {
  const { live, slots, card } = await liftCards(4)
  const n = await card()
  n.near()
  t.alike(n.stateRef.current, { live: false, seen: 1 }, 'one near check loads nothing')
  t.absent(n.holds())
  n.near()
  t.is(n.stateRef.current, live.EMBED_LIVE, 'the second near check loads the frame before it is seen')
  t.ok(n.holds())
  n.near()
  t.is(n.stateRef.current, live.EMBED_AWAY, 'out of the band it is away')
  n.near()
  t.is(n.stateRef.current, live.EMBED_PARKED, 'and then parked, still loaded')
  t.ok(n.holds())
  const f = await card()
  f.unseen()
  f.unseen()
  t.is(f.stateRef.current, live.EMBED_IDLE, 'a card past two band heights never loads')
  t.is(slots.count(), 1)
})

test('two near cards in one tick load one frame', async (t) => {
  const { live, slots, card, clock } = await liftCards(4)
  const a = await card()
  const b = await card()
  a.near()
  b.near()
  a.near()
  clock.now -= live.EMBED_TICK_MS
  b.near()
  t.is(a.stateRef.current, live.EMBED_LIVE)
  t.is(b.stateRef.current, live.EMBED_WAITING, 'the second preload in the same tick waits')
  t.is(slots.count(), 1)
  b.near()
  t.is(b.stateRef.current, live.EMBED_LIVE, 'and loads on the next tick')
  t.is(slots.count(), 2)
})

test('a preloaded holder yields to a nearer newcomer, never to one inside the 400 pt margin', async (t) => {
  const { live, slots, card, most } = await liftCards(1)
  const a = await card()
  a.near(1300)
  a.near(1300)
  t.is(a.stateRef.current, live.EMBED_LIVE, 'preloaded 1300 pt below the band')
  a.near(1300)
  a.near(1300)
  t.is(a.stateRef.current, live.EMBED_PARKED)
  const b = await card()
  b.near(1000)
  b.near(1000)
  t.is(b.stateRef.current, live.EMBED_WAITING, 'a newcomer 300 pt nearer waits')
  t.absent(a.asked(), 'and asks nothing of the holder')
  a.near(1300)
  t.is(a.stateRef.current, live.EMBED_PARKED, 'the holder keeps its frame')
  t.ok(a.holds())
  b.apply(live.EMBED_IDLE)
  const c = await card()
  c.near()
  c.near()
  t.is(c.stateRef.current, live.EMBED_WAITING, 'a newcomer over 400 pt nearer waits a tick')
  t.ok(a.asked(), 'and asks the holder')
  a.near(1300)
  t.is(a.stateRef.current, live.EMBED_IDLE, 'the holder yields on its own next check')
  t.absent(a.holds())
  c.near()
  t.is(c.stateRef.current, live.EMBED_LIVE, 'the newcomer loads')
  t.is(slots.count(), 1)
  t.ok(most() <= 1)
})

// Only touching the band, 0 pt away, the slot is still hidden: its request is
// a preload.
test('a hidden card touching the band edge never asks a touched frame', async (t) => {
  const { live, slots, card } = await liftCards(4)
  const a = await card()
  a.seen()
  a.seen()
  a.engage()
  a.park()
  t.is(a.stateRef.current, live.EMBED_PARKED, 'a touched frame parked')
  const others = [await card(), await card(), await card()]
  for (let i = 0; i < 2; i++) for (const x of others) x.seen()
  t.ok(others.every((x) => x.stateRef.current === live.EMBED_LIVE), 'three untouched frames live in the band')
  t.is(slots.count(), 4)
  const e = await card()
  e.near(0)
  e.near(0)
  t.is(e.stateRef.current, live.EMBED_WAITING, 'the card at the band edge waits')
  t.absent(a.asked(), 'and never asks the touched frame')
  a.unseen()
  t.is(a.stateRef.current, live.EMBED_PARKED, 'which keeps its slot')
  t.ok(a.holds())
  e.seen()
  t.ok(a.asked(), 'in the band, with no untouched frame parked, the same card asks it')
  a.unseen()
  t.is(a.stateRef.current, live.EMBED_IDLE, 'and the touched frame yields')
})

test('a waiting card that leaves the band withdraws its visible request once', async (t) => {
  const { live, card } = await liftCards(1)
  const a = await card()
  a.seen()
  a.seen()
  a.engage()
  a.park()
  t.is(a.stateRef.current, live.EMBED_PARKED, 'a touched frame parked')
  const c = await card()
  c.seen()
  c.seen()
  t.is(c.stateRef.current, live.EMBED_WAITING, 'a visible card waits')
  t.ok(a.asked(), 'and asks the touched frame, the only one parked')
  c.near()
  t.is(c.stateRef.current, live.EMBED_WAITING, 'out of the band but near, it still waits')
  t.absent(a.asked(), 'with its visible request withdrawn')
  a.unseen()
  t.is(a.stateRef.current, live.EMBED_PARKED, 'so the touched frame keeps its slot')
  t.ok(a.holds())
  const d = await card()
  d.seen()
  d.seen()
  t.ok(a.asked(), 'another visible card asks')
  c.near()
  t.ok(a.asked(), 'and the near card does not withdraw again on its next tick')
  d.near()
  t.absent(a.asked(), 'until that one leaves the band too')
  c.seen()
  t.ok(a.asked(), 'back in the band, the card asks again')
  a.unseen()
  t.is(a.stateRef.current, live.EMBED_IDLE, 'and the frame yields to it')
})

test('a touched parked frame is never taken by a preload', async (t) => {
  const { live, card } = await liftCards(1)
  const a = await card()
  a.seen()
  a.seen()
  a.park()
  t.is(a.stateRef.current, live.EMBED_PARKED)
  a.engage()
  const c = await card()
  c.near()
  c.near()
  t.is(c.stateRef.current, live.EMBED_WAITING, 'the preload waits')
  t.absent(a.asked(), 'the touched frame is not asked')
  a.unseen()
  t.is(a.stateRef.current, live.EMBED_PARKED, 'and keeps its slot')
  t.ok(a.holds())
  a.engage(false)
  c.near()
  t.ok(a.asked(), 'untouched, the same frame would be asked')
})

test('a marked holder re-checks with its fresh distance through the real apply', async (t) => {
  const { live, slots, card, most } = await liftCards(1)
  const a = await card()
  a.seen()
  a.seen()
  a.far()
  a.far()
  t.is(a.stateRef.current, live.EMBED_PARKED, 'parked far below the band')
  const b = await card()
  b.near()
  b.near()
  t.is(b.stateRef.current, live.EMBED_WAITING, 'a preload waits')
  t.ok(a.asked(), 'and asks the far holder')
  a.near(300)
  t.is(a.stateRef.current, live.EMBED_PARKED, 'back within the margin of the request, the holder keeps its frame')
  t.ok(a.holds())
  a.far()
  t.is(a.stateRef.current, live.EMBED_IDLE, 'found far again, it yields')
  t.absent(a.holds())
  b.near()
  t.is(b.stateRef.current, live.EMBED_LIVE, 'the newcomer loads')
  t.is(slots.count(), 1)
  t.ok(most() <= 1)
})

test('a screen reader keeps a parked frame from a preload through the real check', async (t) => {
  const { live, card, reader } = await liftCards(1)
  const a = await card()
  a.seen()
  a.seen()
  a.far()
  a.far()
  t.is(a.stateRef.current, live.EMBED_PARKED)
  reader.on = true
  const b = await card()
  b.near()
  b.near()
  t.is(b.stateRef.current, live.EMBED_WAITING, 'the preload waits')
  t.absent(a.asked(), 'and marks nobody while a screen reader runs')
  a.far()
  t.is(a.stateRef.current, live.EMBED_PARKED, 'the holder keeps its frame')
  t.ok(a.holds())
  reader.on = false
  b.near()
  t.ok(a.asked(), 'with the reader off, the same preload marks the holder')
  reader.known = false
  a.far()
  t.is(a.stateRef.current, live.EMBED_PARKED, 'a reader that has not answered refuses the mark at the holder\'s check')
  t.ok(a.holds())
  reader.on = true
  reader.known = true
  a.far()
  t.is(a.stateRef.current, live.EMBED_PARKED, 'so does a running one')
  reader.on = false
  a.far()
  t.is(a.stateRef.current, live.EMBED_IDLE, 'known off, the holder yields')
})

test('a card on a hidden screen keeps an untouched frame and yields it at once when asked', async (t) => {
  const { live, slots, card, most } = await liftCards(2)
  const a = await card()
  const b = await card()
  for (const x of [a, a, b, b]) x.seen()
  t.is(a.stateRef.current, live.EMBED_LIVE)
  a.hide()
  t.is(a.stateRef.current, live.EMBED_PARKED, 'unseen, the untouched frame is parked at once')
  t.ok(a.holds(), 'and keeps its slot')
  t.is(typeof a.idleTick, 'function', 'with a tick')
  t.is(a.idleMs, live.EMBED_TICK_MS)
  a.idleTick()
  t.is(a.stateRef.current, live.EMBED_PARKED, 'still loaded on the next tick')
  t.is(a.answers.length, 0, 'no measurement while hidden')
  const c = await card()
  c.seen()
  c.seen()
  t.is(c.stateRef.current, live.EMBED_WAITING)
  t.ok(a.asked(), 'the hidden holder is asked first, as the farthest')
  t.absent(b.asked())
  a.idleTick()
  t.is(a.stateRef.current, live.EMBED_IDLE, 'and yields on its next tick')
  t.absent(a.holds())
  c.seen()
  t.is(c.stateRef.current, live.EMBED_LIVE)
  t.is(slots.count(), 2)
  t.ok(most() <= 2)
  const idle = await card()
  idle.hide()
  t.is(idle.stateRef.current, live.EMBED_IDLE, 'a card with no frame starts nothing while hidden')
  t.is(idle.idleTick, null)
  t.absent(idle.holds())
})

test('a touched frame drops on a hidden screen and on a playback claim, an untouched one survives both', async (t) => {
  const { live, slots, card, playback, reader } = await liftCards(4)
  const a = await card()
  const b = await card()
  for (const x of [a, a, b, b]) x.seen()
  a.engage()
  a.hide()
  t.is(a.stateRef.current, live.EMBED_IDLE, 'the touched frame drops when its screen hides')
  t.absent(a.holds())
  t.is(a.idleTick, null, 'with no tick')
  b.hide()
  t.is(b.stateRef.current, live.EMBED_PARKED, 'the untouched one stays loaded')
  t.ok(b.holds())

  const d = await card()
  const e = await card()
  for (const x of [d, d, e, e]) x.seen()
  d.engage()
  playback.count++
  d.check()
  t.is(d.stateRef.current, live.EMBED_IDLE, 'another player closes the touched frame, before any measurement')
  t.is(d.answers.length, 0)
  t.absent(d.holds())
  e.seen()
  t.is(e.stateRef.current, live.EMBED_LIVE, 'and leaves the untouched one')
  t.ok(e.holds())
  reader.known = false
  playback.count++
  e.check()
  t.is(e.stateRef.current, live.EMBED_IDLE, 'with a screen reader that has not answered, it counts as touched')
  reader.known = true
  b.idleTick()
  t.is(b.stateRef.current, live.EMBED_PARKED)
  reader.on = true
  b.idleTick()
  t.is(b.stateRef.current, live.EMBED_IDLE, 'a screen reader turned on while hidden closes it on the next tick')
  reader.on = false
  t.is(slots.count(), 0)
})

test('a touch wins over an automatic claim made before it', async (t) => {
  const { live, slots, card, playback } = await liftCards(4)
  const a = await card()
  a.seen()
  a.seen()
  t.is(a.stateRef.current, live.EMBED_LIVE)
  playback.count++
  a.engage()
  a.check()
  if (a.answers.length) a.answerSeen()
  t.is(a.stateRef.current, live.EMBED_LIVE, 'a claim made before the touch leaves the tapped frame live')
  t.ok(a.holds())
  t.ok(slots.engaged(a.release.current), 'and engaged')
  a.seen()
  t.is(a.stateRef.current, live.EMBED_LIVE, 'on the next check too')
  playback.count++
  a.check()
  t.is(a.stateRef.current, live.EMBED_IDLE, 'a claim made after the touch closes it')
  t.absent(a.holds())
})

test('a lock drops every frame', async (t) => {
  const { live, slots, card } = await liftCards(4)
  const a = await card()
  const b = await card()
  for (const x of [a, a, b, b]) x.seen()
  a.hide()
  t.is(a.stateRef.current, live.EMBED_PARKED)
  a.hide({ locked: true })
  t.is(a.stateRef.current, live.EMBED_IDLE, 'a kept untouched frame drops on a lock')
  b.hide({ locked: true })
  t.is(b.stateRef.current, live.EMBED_IDLE, 'and so does a live one')
  t.is(slots.count(), 0)
  const c = await card()
  c.seen()
  c.seen()
  c.hide({ fits: false })
  t.is(c.stateRef.current, live.EMBED_IDLE, 'a card that no longer fits drops its frame')
})

test('an untouched frame re-bases to a real rotation', async (t) => {
  const { live, card } = await liftCards(2)
  const a = await card()
  a.seen()
  a.seen()
  a.park()
  a.win.width = 844
  a.win.height = 390
  a.unseen()
  t.is(a.stateRef.current, live.EMBED_PARKED, 'not counted as turned, so it stays parked')
  a.engage()
  a.win.width = 390
  a.win.height = 844
  a.unseen()
  t.is(a.stateRef.current, live.EMBED_LIVE, 'a touched one counts as turned and is un-parked')
})

test('the cap is never exceeded', async (t) => {
  const { live, slots, card, most } = await liftCards(4)
  const cards = []
  for (let i = 0; i < 6; i++) cards.push(await card())
  for (let round = 0; round < 4; round++) for (const c of cards) c.seen()
  t.is(cards.filter((c) => c.holds()).length, 4, 'four cards hold the four slots')
  t.ok(cards.slice(4).every((c) => c.stateRef.current === live.EMBED_WAITING), 'the others wait')
  t.is(slots.shrink(0), 3, 'a dead content process lowers the cap')
  for (const c of cards.slice(0, 2)) c.park()
  for (let round = 0; round < 4; round++) for (const c of cards.slice(4)) c.seen()
  for (const c of cards.slice(0, 2)) c.unseen()
  for (let round = 0; round < 4; round++) for (const c of cards.slice(4)) c.seen()
  t.ok(most() <= 4, 'never more than four frames at once')
  t.is(slots.count(), 3, 'the pool drained to the lowered cap')
  t.is(cards.filter((c) => c.holds()).length, 3)
})

// The inline frame's own callbacks, as written, against a card's real apply().
test('the inline frame lowers the cap when its process dies and reports its touches', async (t) => {
  const { live, slots, card } = await liftCards(4)
  const a = await card()
  a.seen()
  a.seen()
  const frame = src.slice(src.indexOf('<EmbedFrame'), src.indexOf('/>', src.indexOf('<EmbedFrame')))
  const gone = frame.match(/onGone=\{\(\) => \{ ([^}]*) \}\}/)
  const engage = frame.match(/onEngage=\{\(on\) => ([^}]*)\}/)
  t.ok(gone && engage, 'both callbacks found')
  const onEngage = new Function('embedSlots', 'release', 'playbackClaimCount', 'on', engage[1]) // eslint-disable-line no-new-func
  onEngage(slots, a.release, () => 7, true)
  t.ok(slots.engaged(a.release.current), 'a touch engages the frame')
  t.is(slots.engagedAt(a.release.current), 7, 'with the claim count at the touch')
  onEngage(slots, a.release, () => 7, false)
  t.absent(slots.engaged(a.release.current))
  const onGone = new Function('embedSlots', 'apply', 'EMBED_IDLE', 'Date', gone[1]) // eslint-disable-line no-new-func
  onGone(slots, a.apply, live.EMBED_IDLE, { now: () => 0 })
  t.is(slots.limit(), live.EMBED_LIVE_MAX - 1, 'the cap drops one step')
  t.is(a.stateRef.current, live.EMBED_IDLE, 'the stored card comes back')
  t.absent(a.holds())
})

// What the slot draws, as written.
function liftSlotParts () {
  const m = raw.match(/function slotParts \(live, hosted, ready\) \{([\s\S]*?)\n\}/)
  if (!m) throw new Error('slotParts not found in MusicEmbedCard.js')
  return new Function('live', 'hosted', 'ready', m[1]) // eslint-disable-line no-new-func
}

test('the stored card stays drawn until the provider page has loaded', (t) => {
  const slotParts = liftSlotParts()
  t.alike(slotParts(false, true, false), { standIn: true, empty: false, frame: false }, 'no frame: the stored card')
  t.alike(slotParts(true, true, false), { standIn: true, empty: false, frame: false }, 'a hosted frame still loading: the stored card')
  t.alike(slotParts(true, true, true), { standIn: false, empty: true, frame: false }, 'a hosted frame loaded: the empty slot under it')
  t.alike(slotParts(true, false, false), { standIn: true, empty: false, frame: true }, 'an inline frame loading under the stored card')
  t.alike(slotParts(true, false, true), { standIn: false, empty: false, frame: true }, 'an inline frame loaded')
  t.alike(slotParts(false, false, true), { standIn: true, empty: false, frame: false }, 'a stale ready never hides the stored card')
  t.ok(src.includes('style={settled ? styles.frame : [styles.frame, { opacity: ready ? opacity : 0 }]}'), 'transparent until loaded, then fades in')
  t.ok(src.includes('const { opacity, settled } = useReveal(live && ready, 100)'), 'the fade follows a loaded live frame, the cover lingers 100 ms')
  t.ok(src.includes('const lingers = coverLingers(parts.standIn, live, ready, settled)'), 'the cover stays through the fade')
  t.ok(src.includes('frame: { ...StyleSheet.absoluteFillObject }'), 'drawn over the stored card, so showing it moves nothing')
  t.ok(src.includes('useEffect(() => { if (!state.live) setReady(false) }, [state.live])'), 'a frame that unloads must load again before it shows')
})

// The card's onLayout handler, as written.
function liftOnLayout () {
  const start = '  const onLayout = (event) => {\n'
  const a = raw.indexOf(start)
  const b = raw.indexOf('\n  }\n', a)
  if (a === -1 || b === -1) throw new Error('onLayout not found in MusicEmbedCard.js')
  return new Function('visible', 'held', 'setWidth', 'event', raw.slice(a + start.length, b)) // eslint-disable-line no-new-func
}

test('a hidden screen reporting width 0 keeps the measured width', (t) => {
  const onLayout = liftOnLayout()
  const run = (visible, held, width) => {
    const set = []
    onLayout(visible, held, (w) => set.push(w), { nativeEvent: { layout: { width } } })
    return set
  }
  t.alike(run(false, false, 0), [], 'a hidden screen reporting 0 is ignored')
  t.alike(run(true, true, 0), [], 'so is a held card reporting 0')
  t.alike(run(true, false, 0), [0], 'a shown card takes a 0 width')
  t.alike(run(false, false, 320), [320], 'a hidden card takes a real width')
  t.alike(run(true, false, NaN), [], 'never an unreadable width')
  t.alike(run(false, false, -1), [], 'nor a negative one while hidden')
})

test('the dwell counts ticks, not effect runs', (t) => {
  t.ok(/if \(stateRef\.current\.live\) check\(\)\s*const timer = setInterval\(check, EMBED_TICK_MS\)/.test(src), 'only a live frame is checked at once')
  t.absent(/\n\s*check\(\)\n\s*const timer/.test(src), 'no unconditional immediate check')
})

test('a slot is acquired on going live and released on leave and unmount', (t) => {
  t.ok(/if \(next\.live && !stateRef\.current\.live\) \{\s*const done = embedSlots\.acquire\(gap, Date\.now\(\), readerTouchNow\(\)\)\s*if \(done === null\) \{\s*next = EMBED_WAITING\s*request\.current = gap > 0 \? 'preload' : 'visible'\s*\} else \{\s*release\.current = done/.test(src), 'acquire only on going live, a null result keeps the finished wait and its kind, the release is kept')
  t.ok(/const apply = \(next, mayYield = true, gap\) => \{\s*if \(mayYield && next === EMBED_PARKED && release\.current !== null && embedSlots\.yielding\(release\.current, gap, readerTouchNow\(\)\)\) next = EMBED_IDLE\n/.test(src), 'a wanted player yields only on its own parked check, first thing in apply')
  t.is((src.match(/\bapply\([^)]*,\s*false\)/g) || []).length, 0, 'no apply call bars yielding by itself')
  t.ok(/done\(\)\s*\}\s*if \(next\.live && release\.current !== null\) embedSlots\.park\(release\.current, next === EMBED_PARKED, gap\)\s*const changed/.test(src), 'a live card reports whether it is parked after the release block')
  t.absent(/onEvict|evicted/i.test(raw), 'no card is evicted by another')
  t.ok(/if \(!next\.live && release\.current !== null\) \{\s*const done = release\.current\s*release\.current = null\s*done\(\)/.test(src), 'apply releases on leaving live')
  t.ok(/return \(\) => \{\s*alive\.current = false\s*if \(stateRef\.current === EMBED_WAITING\) embedSlots\.withdraw\(\)\s*const kept = stateRef\.current\.live \? hosted\.current : ''\s*hosted\.current = ''\s*stateRef\.current = EMBED_IDLE\s*const done = release\.current\s*release\.current = null\s*if \(kept !== '' && typeof done === 'function'\) \{\s*if \(playbackClaimCount\(\) !== claims\.current && touchedNow\(done\)\) \{\s*if \(host\.keep\.drop\(kept\)\) return\s*\} else \{\s*embedSlots\.park\(done, true\)\s*if \(host\.keep\.orphan\(kept\)\) return\s*\}\s*\}\s*if \(typeof done === 'function'\) done\(\)/.test(src), 'unmount releases, or leaves a hosted frame parked with the list unless another player started and it was touched')
  t.ok(/if \(!next\.live && hosted\.current !== ''\) \{\s*const kept = hosted\.current\s*hosted\.current = ''\s*if \(host\.keep\.drop\(kept\)\) release\.current = null\s*\}/.test(src), 'leaving live drops a hosted frame, whose drop ran the release')
  t.ok(src.includes('    if (stateRef.current === EMBED_WAITING && next !== EMBED_WAITING && !next.live) embedSlots.withdraw()\n    if (next !== EMBED_WAITING) request.current = \'\'\n    if (!next.live && release.current !== null) {'), 'a card that stops waiting without going live withdraws its request and forgets its kind, after the acquire block')
  t.ok(/alive\.current = false\s*if \(stateRef\.current === EMBED_WAITING\) embedSlots\.withdraw\(\)\s*const kept[^\n]*\s*hosted\.current = ''\s*stateRef\.current = EMBED_IDLE/.test(src), 'a waiting card withdraws on unmount, before its state is reset')
})

test('a turned window keeps a live frame', (t) => {
  t.ok(src.includes('const turned = (win.width > win.height) !== base.current'), 'turned is compared with base.current')
  t.ok(src.includes('if (embedSlots.count() === 0 || !stateRef.current.live || !touchedNow(release.current)) base.current = win.width > win.height'), 'the base follows the window while this card is not live or its frame is untouched')
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

test('no tap gate, no notice, no outside link under the card', (t) => {
  for (const text of ['Tocar aqui', 'Fechar player', 'EMBED_PLAY', 'EMBED_CLOSE', 'embedNotice', 'OPEN_GRACE_MS', 'openLabel', 'openPage']) t.absent(src.includes(text), 'no ' + text)
  t.absent(raw.includes('Abrir no'), 'no "Abrir no ..." link anywhere')
  t.absent(/<Text\b/.test(src), 'no Text in the card')
  t.ok(src.includes("from '../openExternal'"))
})

test('the visible-screen signal is provided by the App and the stack', (t) => {
  const visible = fs.readFileSync(path.join(APP, 'src/ui/screenVisible.js'), 'utf8')
  t.ok(visible.includes('export const ScreenVisible = createContext(false)'))
  t.ok(visible.includes('export const ScreenCovered = createContext(false)'))
  t.ok(visible.includes('export const SheetDepth = createContext(0)'))
  t.ok(visible.includes('export const EmbedBandBottom = createContext(null)'))
  t.ok(visible.includes('export const EmbedHost = createContext(null)'))
  t.ok(visible.includes("export const EmbedRowKey = createContext('')"))
  const stack = withoutComments(fs.readFileSync(path.join(APP, 'src/ui/StackLayer.js'), 'utf8'))
  t.ok(stack.includes('const covered = useContext(ScreenCovered)'), 'the stack reads ScreenCovered')
  t.ok(stack.includes("<ScreenVisible.Provider value={!covered && role === 'top'}>"), 'only the top entry is visible')
  const app = withoutComments(fs.readFileSync(path.join(APP, 'App.js'), 'utf8'))
  t.ok(app.includes('<ScreenCovered.Provider value={covered}>'), 'the App provides ScreenCovered')
  t.ok(app.includes('const covered = composer.open || ajustes !== null || report !== null || helpOpen || pageDmAsk !== null || shareTarget !== null || locked || backgrounded'), 'covered')
  t.ok(app.includes('const screenSeen = (id) => !covered && !stacked && tab === id'), 'screenSeen')
  t.ok(app.includes("const [backgrounded, setBackgrounded] = useState(() => AppState.currentState === 'background')"), 'backgrounded starts from the current state')
  const tabs = ['rua', 'espiadinha', 'busca', 'avisos', 'comunidades', 'feira', 'diario']
  t.is([...app.matchAll(/<ScreenVisible\.Provider value=\{screenSeen\('(\w+)'\)\}>/g)].map((m) => m[1]).join(), tabs.join(), 'seven tab providers')
  t.ok(/if \(state === 'background'\) setBackgrounded\(true\)\s*else if \(state === 'active'\) setBackgrounded\(false\)/.test(app), 'backgrounded follows background and active only')
  const busca = withoutComments(fs.readFileSync(path.join(APP, 'src/screens/BuscaGlobal.js'), 'utf8'))
  t.ok(busca.includes("import { ScreenVisible } from '../ui/screenVisible'"), 'Busca imports ScreenVisible')
  t.ok(busca.includes('const visible = useContext(ScreenVisible)'), 'Busca reads the tab signal')
  t.ok(/<ScreenVisible\.Provider value=\{visible && category === 'publicacoes'\}>\s*<View style=\{\[styles\.flex, category !== 'publicacoes' && styles\.hidden\]\}>\{postsPane\}<\/View>\s*<\/ScreenVisible\.Provider>/.test(busca), 'switching to Contas unloads a player in the hidden posts pane')
})

test('the card follows its sheet depth', (t) => {
  t.ok(src.includes('const depth = useContext(SheetDepth)'))
  t.ok(src.includes('const [held, setHeld] = useState(() => embedsHeld(depth))'))
  t.ok(/const sync = \(\) => \{\s*setHeld\(embedsHeld\(depth\)\)\s*setLocked\(embedsHeldAll\(\)\)\s*\}\s*sync\(\)\s*return onEmbedHold\(sync\)\s*\}, \[depth\]\)/.test(src), 'the sync effect is keyed on depth and tracks a lock too')
  t.ok(src.includes('const [locked, setLocked] = useState(() => embedsHeldAll())'))
})

test('a list may lower the band', (t) => {
  t.ok(src.includes('const band = useContext(EmbedBandBottom)'))
  const measure = src.indexOf('measureInWindow((x, y, w, h) => {')
  const call = src.indexOf('band.measure(')
  t.ok(measure !== -1 && call > measure, 'band.measure is called inside the measureInWindow callback')
  t.ok(/if \(!\(typeof limit === 'number' && Number\.isFinite\(limit\) && limit > 0\)\) \{\s*settle\(true\)\s*return\s*\}/.test(src), 'a band with no usable answer counts as hidden')
  t.ok(/answer\(x, y, w, h, Math\.min\(bottom, limit\)\)/.test(src), 'a usable answer lowers the band')
  t.ok(/const withLimit = \(limit\) => \{[^}]*?if \(cancelled \|\| !alive\.current \|\| id !== round\) return\n/.test(src), 'cancelled is tested again in the band callback')
  t.ok(/try \{\s*band\.measure\(withLimit\)\s*\} catch \{\s*withLimit\(null\)\s*\}/.test(src), 'a throw counts as no answer, so hidden')
  t.absent(/:\s*bottom\b/.test(src.slice(src.indexOf('const withLimit'), src.indexOf('band.measure(withLimit)'))), 'the band callback never falls back to the window band')
})

test('the stand-in is the cover, the narrow fallback the stored LinkCard', (t) => {
  const cards = [...src.matchAll(/<LinkCard\b[^>]*\/>/g)].map((m) => m[0])
  t.is(cards.length, 1, 'one LinkCard element')
  t.absent(/\bstill\b/.test(cards[0]), 'not drawn still, so a tap opens the stored link')
  t.absent(/\bstill\b/.test(src), 'no still anywhere in the card')
  t.absent(cards[0].includes('onDismiss'), 'no onDismiss passed to it')
  t.ok(src.includes('const plain = <LinkCard '), 'the card is named plain')
  const covers = [...src.matchAll(/<EmbedCover\b[^>]*\/>/g)].map((m) => m[0])
  t.is(covers.length, 1, 'one EmbedCover element')
  const before = src.slice(0, src.indexOf('<EmbedCover '))
  t.ok(/\{parts\.standIn \|\| lingers\s*\?\s*\(\s*<View\s+key='cover'\s+style=\{styles\.cover\}\s+pointerEvents=\{parts\.standIn \? 'auto' : 'none'\}\s+accessibilityElementsHidden=\{!parts\.standIn\}\s+importantForAccessibility=\{parts\.standIn \? 'auto' : 'no-hide-descendants'\}\s+onStartShouldSetResponder=\{\(\) => true\}\s*>\s*$/.test(before), 'inside the cover View, which takes no touch while it only lingers')
  t.ok(before.indexOf("key='cover'") < src.indexOf("key='frame'"), 'the cover comes first, so the frame draws over it')
  t.absent(/\b(onPress|live)=/.test(covers[0]), 'the cover gets no open handler and no live flag')
  t.ok(covers[0].includes('onLongPress={onLongPress}'), 'a long press still reaches the post')
  t.absent(src.includes('{plain}</View>'), 'the slot no longer draws the stored card')
  t.absent(src.includes('MediaView'), 'no MediaView in the card')
})

test('a draft has a remove button and a tall draft has no frame', (t) => {
  t.ok(/const actions = typeof onDismiss === 'function'\s*\?\s*\(\s*<View style=\{styles\.actions\}>\s*<Pressable\s*accessibilityRole='button'\s*accessibilityLabel=\{LINK_CARD_DISMISS\}\s*onPress=\{onDismiss\}\s*hitSlop=\{4\}/.test(src), 'the remove button')
  t.ok(/<\/Pressable>\s*<\/View>\s*\)\s*:\s*null\n/.test(src), 'no actions row without a remove button')
  t.ok(src.includes("import { LINK_CARD_DISMISS, LinkCard } from './LinkCard'"))
  t.ok(src.includes('const tooTall = !!draft && !state.live && height > win.height / 3'), 'a live draft frame is never swapped out when the window turns')
  t.ok(/if \(tooNarrow \|\| tooTall\) \{\s*return \(\s*<View onLayout=\{onLayout\}>\s*\{plain\}\s*\{actions\}\s*<\/View>/.test(src), 'no slot or frame when too narrow or too tall')
})

test('taps inside the slot stay in the slot', (t) => {
  const start = src.indexOf('ref={slot}')
  const slot = src.slice(start, src.indexOf('>', src.indexOf('onKeyDown=', start)))
  t.absent(slot.includes('onStartShouldSetResponder'), 'the slot claims no touch, so Android never intercepts a drag in the player')
  t.ok(slot.includes('onClick={stopClick}'))
  t.ok(slot.includes('onKeyDown={stopPressKeys}'))
  t.ok(/<View\s+key='cover'[^>]*onStartShouldSetResponder=\{\(\) => true\}\s*>/.test(src), 'the cover claims the touch')
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

test('embedLive: a loaded frame is kept at any distance', async (t) => {
  const live = await import('../src/embedLive.js')
  const { embedStep, EMBED_LIVE, EMBED_AWAY, EMBED_PARKED } = live
  t.absent('farFromBand' in live, 'no distance rule')
  t.absent('EMBED_FAR_SCREENS' in live)
  const far = { hidden: true, far: true, allowed: true, turned: false, free: true }
  t.is(embedStep(EMBED_LIVE, far), EMBED_AWAY, 'a far check is a hidden check')
  t.is(embedStep(EMBED_AWAY, far), EMBED_PARKED, 'and parks the frame on the second')
  let state = EMBED_PARKED
  for (let i = 0; i < 1000; i++) state = embedStep(state, far)
  t.is(state, EMBED_PARKED, 'far checks keep a parked frame for good')
  t.is(embedStep(EMBED_LIVE, { ...far, hidden: false }), EMBED_LIVE, 'a visible far sample stays live')
  t.is(embedStep(EMBED_PARKED, { ...far, hidden: false }), EMBED_LIVE, 'a parked frame back in view is live')
})

test('embedLive: a card goes live after two visible checks', async (t) => {
  const { embedStep, EMBED_IDLE, EMBED_LIVE, EMBED_DWELL_TICKS, EMBED_AWAY, EMBED_PARKED, EMBED_WAITING } = await import('../src/embedLive.js')
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
  t.is(embedStep(EMBED_LIVE, hidden), EMBED_AWAY, 'one hidden check only marks a loaded frame away')
  t.is(embedStep(EMBED_AWAY, hidden), EMBED_PARKED, 'the second hidden check parks it')
  t.is(embedStep(EMBED_PARKED, hidden), EMBED_PARKED, 'a parked frame stays parked')
  t.is(embedStep(EMBED_AWAY, visible), EMBED_LIVE, 'back in the band clears the away count')
  t.is(embedStep(EMBED_PARKED, visible), EMBED_LIVE, 'a parked frame back in the band is live again')
  t.is(embedStep(EMBED_PARKED, { ...visible, allowed: false }), EMBED_IDLE, 'another player drops a parked frame')
  t.is(embedStep(EMBED_PARKED, { ...hidden, hidden: 0 }), EMBED_IDLE, 'an invalid answer drops a parked frame')
  t.is(embedStep(EMBED_PARKED, { ...hidden, turned: true }), EMBED_LIVE, 'a turned window un-parks a frame')
  t.is(embedStep(EMBED_LIVE, { ...hidden, free: false }), EMBED_AWAY, 'a hidden live frame stays live with no free slot')
  t.ok(Object.isFrozen(EMBED_AWAY) && Object.isFrozen(EMBED_PARKED) && Object.isFrozen(EMBED_WAITING))
  t.is(embedStep({ live: false, seen: 1 }, { ...visible, free: false }), EMBED_WAITING, 'a finished wait with no free slot is EMBED_WAITING')
  t.is(embedStep(EMBED_WAITING, visible), EMBED_LIVE, 'a waiting card loads once a slot is free')
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

test('embedLive: a parked holder is asked to yield, never removed', async (t) => {
  const { createEmbedSlots, embedSlots, EMBED_LIVE_MAX } = await import('../src/embedLive.js')
  t.is(EMBED_LIVE_MAX, 4)
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
  t.is(slots.acquire(), null, 'full with no parked holder, a newcomer gets nothing')
  t.is(slots.yielding(first), false, 'nobody is asked to yield')
  t.is(slots.yielding(second), false, 'nobody is asked to yield')
  t.is(slots.count(), 2, 'both holders remain')
  slots.park(first, true)
  t.is(slots.free(), true, 'a parked holder makes room for a newcomer')
  t.is(slots.acquire(), null, 'the newcomer still gets nothing at once')
  t.is(slots.yielding(first), true, 'the parked holder is asked to yield')
  t.is(slots.yielding(second), false)
  t.is(slots.count(), 2, 'the parked holder is not removed')
  first()
  t.is(slots.count(), 1, 'the asked holder releases on its own')
  const third = slots.acquire()
  t.is(typeof third, 'function', 'then the newcomer gets the slot')
  t.is(slots.count(), 2)

  slots.park(second, true)
  slots.park(third, true)
  slots.park(second, true)
  t.is(slots.acquire(), null)
  t.is(slots.yielding(second), true, 'the holder parked first is asked, re-parking keeps its turn')
  t.is(slots.yielding(third), false)
  slots.park(second, false)
  t.is(slots.yielding(second), false, 'un-parking clears the request')
  t.is(slots.acquire(), null)
  t.is(slots.yielding(third), true, 'the remaining parked holder is asked next')
  t.is(slots.count(), 2)

  first()
  t.is(slots.count(), 2, 'a stale release cannot remove a newer holder')
  slots.park(first, true)
  t.is(slots.yielding(first), false, 'park and yielding ignore a removed holder')
  second()
  second()
  t.is(slots.count(), 1, 'release is idempotent')
  third()
  t.is(slots.count(), 0)
  t.is(slots.free(), true)

  const again = createEmbedSlots(2)
  const a = again.acquire()
  const b = again.acquire()
  again.park(a, true)
  t.is(again.acquire(), null)
  t.is(again.yielding(a), true, 'a newcomer asks the parked holder')
  b()
  t.is(again.yielding(a), false, 'another release clears the request, since a slot is free')
  const c = again.acquire()
  t.is(typeof c, 'function', 'the next acquire takes the freed slot')
  t.is(again.count(), 2)
  t.is(again.yielding(a), false, 'still not asked')
  t.is(again.acquire(), null)
  t.is(again.yielding(a), true, 'a newcomer that still needs a slot asks again')
  b()
  t.is(again.yielding(a), true, 'a stale release frees nothing and clears nothing')
  again.park(c, true)
  a()
  t.is(again.yielding(c), false, 'the asked holder leaving marks nobody else')
  c()
  t.is(again.count(), 0)

  const back = createEmbedSlots(2)
  const p = back.acquire()
  const q = back.acquire()
  back.park(p, true)
  back.park(q, true)
  t.is(back.acquire(), null)
  t.is(back.yielding(p), true)
  back.withdraw()
  t.is(back.yielding(p), false, 'withdraw clears every request')
  t.is(back.yielding(q), false)
  t.is(back.count(), 2, 'and keeps both holders')
  t.is(back.free(), true, 'still parked')
  t.is(back.acquire(), null)
  t.is(back.yielding(p), true, 'a later newcomer asks again')
  p()
  q()

  const single = createEmbedSlots(1)
  const release = single.acquire()
  t.is(single.acquire(), null, 'the supplied maximum is honored')
  release()
  t.is(embedSlots.count(), 0, 'the shared slots stay empty')
})

test('embedLive: bandGap measures the distance to the band', async (t) => {
  const { bandGap, EMBED_LIVE_MIN, EMBED_AHEAD_BANDS, EMBED_YIELD_GAP, EMBED_SHRINK_MS } = await import('../src/embedLive.js')
  t.is(EMBED_LIVE_MIN, 2)
  t.is(EMBED_AHEAD_BANDS, 2)
  t.is(EMBED_YIELD_GAP, 400)
  t.is(EMBED_SHRINK_MS, 5000)
  t.is(bandGap(0, 200, 300, 200, 100, 800, 400), 0, 'inside the band')
  t.is(bandGap(0, 0, 300, 200, 100, 800, 400), 0, 'overlapping the top')
  t.is(bandGap(0, -100, 300, 200, 100, 800, 400), 0, 'touching the top')
  t.is(bandGap(0, 800, 300, 200, 100, 800, 400), 0, 'touching the bottom')
  t.is(bandGap(0, -300, 300, 200, 100, 800, 400), 200, 'above the band')
  t.is(bandGap(0, 1000, 300, 200, 100, 800, 400), 200, 'below the band')
  t.is(bandGap(-150, 1000, 300, 200, 100, 800, 400), 200, 'exactly half the width in')
  t.is(bandGap(-151, 1000, 300, 200, 100, 800, 400), Infinity, 'under half the width in')
  t.is(bandGap(251, 300, 300, 200, 100, 800, 400), Infinity, 'under half the width in, on the right')
  for (const args of [
    [NaN, 0, 300, 200, 100, 800, 400],
    [0, undefined, 300, 200, 100, 800, 400],
    [0, 0, 0, 200, 100, 800, 400],
    [0, 0, 300, 0, 100, 800, 400],
    [0, 0, -300, 200, 100, 800, 400],
    [0, 0, 300, 200, 100, Infinity, 400],
    [0, 0, 300, 200, 100, 800, '400']
  ]) t.is(bandGap(...args), Infinity, 'bad input is never near')
})

test('embedLive: embedNear allows two band heights', async (t) => {
  const { embedNear } = await import('../src/embedLive.js')
  t.is(embedNear(0, 100, 500), true, 'in the band')
  t.is(embedNear(800, 100, 500), true, 'exactly two band heights away')
  t.is(embedNear(801, 100, 500), false, 'farther than two band heights')
  t.is(embedNear(Infinity, 100, 500), false, 'not measured')
  t.is(embedNear(NaN, 100, 500), false)
  t.is(embedNear(undefined, 100, 500), false)
  t.is(embedNear(10, 100, NaN), false, 'a bad band is never near')
  t.is(embedNear(Infinity, 0, Infinity), false, 'an unmeasured slot is never near')
})

test('embedLive: a near card dwells like a visible one', async (t) => {
  const { embedStep, EMBED_IDLE, EMBED_LIVE, EMBED_AWAY, EMBED_PARKED, EMBED_WAITING } = await import('../src/embedLive.js')
  const near = { hidden: true, near: true, allowed: true, turned: false, free: true }
  const first = embedStep(EMBED_IDLE, near)
  t.alike(first, { live: false, seen: 1 }, 'one near check mounts no frame')
  t.is(embedStep(first, near), EMBED_LIVE, 'the second near check loads the frame')
  t.is(embedStep(first, { ...near, free: false }), EMBED_WAITING, 'a near card with no free slot waits')
  t.is(embedStep(EMBED_IDLE, { ...near, near: false }), EMBED_IDLE, 'hidden and not near stays idle')
  t.is(embedStep(first, { ...near, near: false }), EMBED_IDLE, 'and resets the dwell')
  t.is(embedStep(EMBED_IDLE, { ...near, near: 1 }), EMBED_IDLE, 'only near === true counts')
  t.is(embedStep(EMBED_LIVE, near), EMBED_AWAY, 'a live frame out of the band still goes away')
  t.is(embedStep(EMBED_AWAY, near), EMBED_PARKED, 'and then parks')
  t.is(embedStep(first, { ...near, allowed: false }), EMBED_IDLE, 'near never overrides a disallowed sample')
})

test('embedLive: the farthest untouched holder is asked first', async (t) => {
  const { createEmbedSlots } = await import('../src/embedLive.js')
  const slots = createEmbedSlots(3)
  const a = slots.acquire()
  const b = slots.acquire()
  const c = slots.acquire()
  slots.park(a, true, 500)
  slots.park(b, true, 2000)
  slots.park(c, true, 1000)
  t.is(slots.acquire(), null)
  t.is(slots.yielding(b), true, 'the farthest holder is asked')
  t.is(slots.yielding(a), false)
  t.is(slots.yielding(c), false)
  b()
  const d = slots.acquire()
  t.is(typeof d, 'function')
  slots.park(d, true)
  t.is(slots.acquire(), null)
  t.is(slots.yielding(d), true, 'an unknown gap counts as farthest')
  slots.park(d, false)
  slots.park(a, true, 1000)
  t.is(slots.acquire(), null)
  t.is(slots.yielding(a), true, 'equal gaps go to the holder parked first')
  t.is(slots.yielding(c), false)
  a()
  c()
  d()
})

test('embedLive: a preload asks only a holder 400 pt farther away', async (t) => {
  const { createEmbedSlots } = await import('../src/embedLive.js')
  const slots = createEmbedSlots(1)
  const a = slots.acquire()
  slots.park(a, true, 1000)
  t.is(slots.free(600), false, 'no holder far enough for this preload')
  t.is(slots.acquire(600, 0), null)
  t.is(slots.yielding(a), false, 'exactly 400 pt farther is not enough')
  t.is(slots.free(599), true)
  t.is(slots.acquire(599, 0), null)
  t.is(slots.yielding(a), true, 'more than 400 pt farther is asked')
  a()
})

test('embedLive: a preload never marks an engaged holder', async (t) => {
  const { createEmbedSlots } = await import('../src/embedLive.js')
  const slots = createEmbedSlots(1)
  const a = slots.acquire()
  slots.park(a, true, 5000)
  slots.engage(a)
  t.is(slots.free(100), false, 'an engaged holder makes no room for a preload')
  t.is(slots.acquire(100, 0), null)
  slots.engage(a, false)
  t.is(slots.yielding(a), false, 'the preload marked nobody')
  a()
})

test('embedLive: a visible card asks an engaged holder only when no untouched one is parked', async (t) => {
  const { createEmbedSlots } = await import('../src/embedLive.js')
  const slots = createEmbedSlots(2)
  const a = slots.acquire()
  const b = slots.acquire()
  slots.park(a, true, 3000)
  slots.park(b, true, 100)
  slots.engage(a)
  t.is(slots.free(), true)
  t.is(slots.acquire(), null)
  t.is(slots.yielding(b), true, 'the untouched holder is asked, though nearer')
  slots.park(b, false)
  t.is(slots.yielding(a), false, 'the engaged holder was not marked')
  t.is(slots.acquire(), null)
  t.is(slots.yielding(a), true, 'with no untouched holder parked, the engaged one is asked')
  a()
  b()
})

test('embedLive: one preload per tick, a visible card is never held back', async (t) => {
  const { createEmbedSlots, EMBED_TICK_MS } = await import('../src/embedLive.js')
  const slots = createEmbedSlots(4)
  const first = slots.acquire(100, 1000)
  t.is(typeof first, 'function')
  t.is(slots.acquire(100, 1000 + EMBED_TICK_MS - 1), null, 'a second preload in the same tick waits')
  t.is(slots.count(), 1)
  const seen = slots.acquire(0, 1000 + EMBED_TICK_MS - 1)
  t.is(typeof seen, 'function', 'a visible card is not throttled')
  const again = slots.acquire(100, 1000 + EMBED_TICK_MS - 1)
  t.is(again, null, 'a visible grant does not reset the preload clock')
  const next = slots.acquire(100, 1000 + EMBED_TICK_MS)
  t.is(typeof next, 'function', 'the next tick may preload')
  const noClock = slots.acquire(100)
  t.is(typeof noClock, 'function', 'a call with no time is not throttled')
  t.is(slots.count(), 4)
  slots.park(first, true, 5000)
  t.is(slots.acquire(100, 1000 + EMBED_TICK_MS + 1), null)
  t.is(slots.yielding(first), false, 'a throttled preload marks nobody')
  t.is(slots.acquire(100, 1000 + 2 * EMBED_TICK_MS), null)
  t.is(slots.yielding(first), true, 'a later preload marks the far holder')
  for (const release of [first, seen, next, noClock]) if (typeof release === 'function') release()
})

test('embedLive: two near cards never take turns', async (t) => {
  const { createEmbedSlots } = await import('../src/embedLive.js')
  const slots = createEmbedSlots(2)
  const a = slots.acquire()
  const b = slots.acquire()
  slots.park(a, true, 100)
  slots.park(b, true, 300)
  t.is(slots.acquire(300, 0), null)
  t.is(slots.yielding(a), false, 'a near caller does not mark a nearer holder')
  t.is(slots.acquire(100, 1000), null)
  t.is(slots.yielding(b), false, 'nor a holder under 400 pt farther')
  t.is(slots.acquire(400, 2000), null)
  t.is(slots.yielding(a), false)
  t.is(slots.yielding(b), false)
  a()
  b()
})

test('embedLive: a mark is re-checked when the holder decides', async (t) => {
  const { createEmbedSlots } = await import('../src/embedLive.js')
  const engaged = createEmbedSlots(1)
  const a = engaged.acquire()
  engaged.park(a, true, 2000)
  t.is(engaged.acquire(100, 0), null)
  engaged.engage(a)
  t.is(engaged.yielding(a), false, 'a holder engaged after a preload marked it does not yield')
  engaged.engage(a, false)
  t.is(engaged.yielding(a), true, 'the mark stands while the request is still met')
  a()

  const closer = createEmbedSlots(1)
  const b = closer.acquire()
  closer.park(b, true, 2000)
  t.is(closer.acquire(100, 0), null)
  closer.park(b, true, 500)
  t.is(closer.yielding(b), false, 'a holder whose gap shrank inside the margin does not yield')
  b()

  const visible = createEmbedSlots(1)
  const c = visible.acquire()
  visible.park(c, true, 100)
  t.is(visible.acquire(), null)
  t.is(visible.yielding(c), true, 'a holder marked by a visible card yields')
  visible.park(c, true, 50)
  t.is(visible.yielding(c), true, 'at any distance')
  visible.engage(c)
  t.is(visible.yielding(c), true, 'and engaged, with no untouched holder parked')
  c()

  const both = createEmbedSlots(1)
  const d = both.acquire()
  both.park(d, true, 2000)
  t.is(both.acquire(), null)
  t.is(both.acquire(100, 0), null)
  both.engage(d)
  t.is(both.yielding(d), true, 'a later preload does not narrow a visible mark')
  d()

  const untouched = createEmbedSlots(2)
  const e = untouched.acquire()
  const f = untouched.acquire()
  untouched.park(e, true, 100)
  untouched.engage(e)
  t.is(untouched.acquire(), null)
  t.is(untouched.yielding(e), true, 'an engaged holder is asked while it is the only one parked')
  untouched.park(f, true, 100)
  t.is(untouched.yielding(e), false, 'but not once an untouched holder parks')
  e()
  f()
})

test('embedLive: yielding re-checks with the fresh gap it is given', async (t) => {
  const { createEmbedSlots } = await import('../src/embedLive.js')
  const slots = createEmbedSlots(1)
  const a = slots.acquire()
  slots.park(a, true, 2000)
  t.is(slots.acquire(100, 0), null)
  t.is(slots.yielding(a), true, 'with no fresh gap, the parked one stands')
  t.is(slots.yielding(a, 300), false, 'a fresh gap inside the margin keeps the slot')
  t.is(slots.yielding(a), false, 'and is stored')
  t.is(slots.yielding(a, 3000), true, 'a fresh gap beyond the margin yields')
  t.is(slots.yielding(a, 300), false)
  t.is(slots.yielding(a, NaN), true, 'a non-finite gap counts as farthest')
  t.is(slots.yielding(a, 300), false)
  t.is(slots.yielding(a, Infinity), true)
  a()
})

test('embedLive: a screen reader counts every holder as touched', async (t) => {
  const { createEmbedSlots } = await import('../src/embedLive.js')
  const slots = createEmbedSlots(2)
  const a = slots.acquire()
  const b = slots.acquire()
  slots.park(a, true, 3000)
  slots.park(b, true, 5000)
  t.is(slots.free(100, true), false, 'a full pool has nothing for a preload while a reader runs')
  t.is(slots.free(100), true, 'without it, the far untouched holder would be asked')
  t.is(slots.acquire(100, 0, true), null)
  t.is(slots.yielding(a), false, 'the preload marked nobody')
  t.is(slots.yielding(b), false)
  t.is(slots.acquire(100, 0), null)
  t.is(slots.yielding(b), true, 'a preload with the reader off marks the far holder')
  t.is(slots.yielding(b, undefined, true), false, 'the re-check with the reader on refuses it')
  t.is(slots.yielding(b, 5000, true), false)
  slots.withdraw()
  t.is(slots.free(0, true), true, 'a visible card still finds a slot')
  t.is(slots.acquire(0, 0, true), null)
  t.is(slots.yielding(a, undefined, true), true, 'and asks the holder parked first, though nearer')
  t.is(slots.yielding(b, undefined, true), false)
  a()
  b()
})

test('embedLive: engage marks a holder as touched', async (t) => {
  const { createEmbedSlots } = await import('../src/embedLive.js')
  const slots = createEmbedSlots(2)
  const a = slots.acquire()
  const b = slots.acquire()
  t.is(slots.engagedCount(), 0)
  t.is(slots.engaged(a), false)
  slots.engage(a)
  t.is(slots.engaged(a), true)
  t.is(slots.engaged(b), false)
  t.is(slots.engagedCount(), 1)
  slots.engage(b, true)
  t.is(slots.engagedCount(), 2)
  slots.engage(b, false)
  t.is(slots.engaged(b), false)
  t.is(slots.engagedCount(), 1)
  t.is(slots.engagedAt(a), null, 'a touch with no claim count carries no mark')
  slots.engage(b, true, 3)
  t.is(slots.engagedAt(b), 3, 'the claim count at the touch')
  slots.engage(b, false, 4)
  t.is(slots.engagedAt(b), null, 'no mark once not engaged')
  t.is(slots.engagedAt(() => {}), null)
  t.is(slots.engaged(() => {}), false, 'an unknown release is not engaged')
  slots.engage(() => {})
  t.is(slots.engagedCount(), 1, 'engaging an unknown release changes nothing')
  a()
  t.is(slots.engagedCount(), 0, 'a release forgets the holder')
  t.is(slots.engaged(a), false)
  b()
})

test('embedLive: shrink lowers the cap without closing anything', async (t) => {
  const { createEmbedSlots, EMBED_LIVE_MAX, EMBED_LIVE_MIN, EMBED_SHRINK_MS } = await import('../src/embedLive.js')
  const slots = createEmbedSlots()
  t.is(slots.limit(), EMBED_LIVE_MAX)
  const held = [slots.acquire(), slots.acquire(), slots.acquire(), slots.acquire()]
  t.ok(held.every((release) => typeof release === 'function'))
  t.is(slots.shrink(1000), EMBED_LIVE_MAX - 1)
  t.is(slots.shrink(1000 + EMBED_SHRINK_MS - 1), EMBED_LIVE_MAX - 1, 'one step per window')
  t.is(slots.limit(), EMBED_LIVE_MAX - 1)
  t.is(slots.shrink(1000 + EMBED_SHRINK_MS), EMBED_LIVE_MAX - 2)
  t.is(slots.shrink(1000 + 10 * EMBED_SHRINK_MS), EMBED_LIVE_MIN, 'never under the floor')
  t.is(slots.shrink(1000 + 20 * EMBED_SHRINK_MS), EMBED_LIVE_MIN)
  t.is(slots.count(), 4, 'nobody is evicted')
  t.is(slots.free(), false)
  t.is(slots.acquire(), null)
  held[0]()
  held[1]()
  t.is(slots.acquire(), null, 'the pool drains to the lower cap')
  held[2]()
  const next = slots.acquire()
  t.is(typeof next, 'function')
  if (typeof next === 'function') next()
  held[3]()
  const small = createEmbedSlots(1)
  t.is(small.shrink(0), 1, 'a cap already under the floor stays')
})

test('embedLive: embedsHeldAll sees only an all-card hold', async (t) => {
  const { holdEmbeds, holdAllEmbeds, embedsHeldAll } = await import('../src/embedLive.js')
  t.is(embedsHeldAll(), false)
  const layer = holdEmbeds()
  t.is(embedsHeldAll(), false, 'a layer is not an all-card hold')
  const all = holdAllEmbeds()
  t.is(embedsHeldAll(), true)
  all()
  t.is(embedsHeldAll(), false)
  layer()
})

test('embedLive: embedStays and embedTouched', async (t) => {
  const { embedStays, embedTouched } = await import('../src/embedLive.js')
  t.is(embedStays(false, false), true, 'an untouched frame on an unlocked device stays')
  t.is(embedStays(true, false), false, 'a touched frame goes')
  t.is(embedStays(false, true), false, 'a lock closes it')
  t.is(embedStays(undefined, false), false, 'an unknown touch state goes')
  t.is(embedStays(false, undefined), false, 'an unknown lock state goes')
  t.is(embedTouched(false, false, true), false, 'untouched with the reader known off')
  t.is(embedTouched(true, false, true), true, 'engaged')
  t.is(embedTouched(false, true, true), true, 'a running screen reader counts as a touch')
  t.is(embedTouched(false, false, false), true, 'an unknown reader state counts as a touch')
  t.is(embedTouched(false, false, undefined), true)
  t.is(embedTouched(1, 1, true), false, 'only true counts')
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

test('the card hands its row shift to the list layer', (t) => {
  t.ok(/const shift = useContext\(RowShift\)/.test(src))
  t.ok(/host\.keep\.show\(key, \{[\s\S]*?\bshift\n\s*\}, release\.current, rowKey\)/.test(src))
  t.ok(src.includes('}, [live, height, width, key, shift])'))
})
