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
  t.ok(frame.includes('onOpen={openFromPlayer}'), 'a link inside the player is handed to openFromPlayer')
  t.ok(/const out = embedExitUrl\(embed, target\)\s*if \(out !== null\) openExternal\(out\)/.test(src), 'it leaves the app only through embedExitUrl')
  t.ok(src.includes('  embedExitUrl,\n') && src.includes("} from '../musicEmbed'"), 'embedExitUrl comes from ../musicEmbed')
  t.ok(src.includes('const active = visible && !held && fits'), 'active needs the visible screen, no hold and a fit')
  t.ok(src.includes('const fits = width > 0 && width >= embed.minWidth'), 'fits only once measured')
  t.ok(src.includes('const height = embedHeight(embed, width)'), 'slot height from the measured width')
  t.ok(src.includes('style={[styles.slot, { height }]}'), 'the slot always has the player height')
})

test('the card checks its slot every 500 ms against the feed band', (t) => {
  t.ok(src.includes("import { EMBED_IDLE, EMBED_PARKED, EMBED_TICK_MS, EMBED_WAITING, embedSlots, embedStep, embedsHeld, farFromBand, mostlyHidden, onEmbedHold } from '../embedLive'"), 'imports from ../embedLive')
  t.absent(/function mostlyHidden/.test(src), 'no local mostlyHidden')
  t.ok(src.includes('setInterval(check, EMBED_TICK_MS)'), 'EMBED_TICK_MS in setInterval')
  t.ok(src.includes('const top = insets.top + layout.topBar'), 'the band starts under the top bar')
  t.ok(src.includes('const bottom = win.height - (insets.bottom + (tabBarShown ? layout.tabBar : 0))'), 'the band ends above the tab bar, when there is one')
  t.ok(src.includes('settle(mostlyHidden(x, y, w, h, top, bottom, win.width), true, farFromBand(y, h, top, bottom, win.height))'), 'measured against the band, and how far from it')
  t.ok(/const settle = \(hidden, mayYield = true, far = false\) => \{\s*pending = false\s*apply\(embedStep\(stateRef\.current, \{ hidden, allowed, turned, free, far \}\), mayYield\)\s*\}/.test(src), 'embedStep with the answer and far')
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
  t.ok(/if \(missed\) settle\(true, false\)\s*pending = true\s*try \{\s*view\.measureInWindow/.test(src), 'a missing answer is hidden at the next tick, may not yield, then is measured again')
  t.is((src.match(/settle\(true, false\)/g) || []).length, 1, 'only the missing answer is barred from yielding')
  t.ok(/measureInWindow\(\(x, y, w, h\) => \{\s*if \(cancelled \|\| !alive\.current \|\| id !== round\) return\n/.test(src), 'only the latest check applies')
})

test('a fresh measurement says whether the card is far from the band', (t) => {
  t.is((src.match(/farFromBand\(/g) || []).length, 2, 'only the two fresh measurement paths ask how far')
  t.is((src.match(/farFromBand\(y, h, top, (?:bottom|lower), win\.height\)/g) || []).length, 2, 'both against the window height')
  t.ok(/if \(missed\) settle\(true, false\)\s*pending = true/.test(src), 'the late path stays hidden, never far')
  t.ok(src.includes('const unseen = () => settle(true)\n'), 'an unmeasurable slot is never far')
  t.ok(/limit > 0\)\) \{\s*settle\(true\)\s*return\s*\}/.test(src), 'a band with no answer is never far')
})

// The card's check() lifted out of its source and run against stub
// measurements, with the real embedLive rules.
async function liftCheck (env) {
  const live = await import('../src/embedLive.js')
  const start = raw.indexOf('    let round = 0')
  const end = raw.indexOf('    // The dwell counts ticks')
  if (start === -1 || end === -1) throw new Error('check() not found in MusicEmbedCard.js')
  const names = ['playbackClaimCount', 'claims', 'apply', 'EMBED_IDLE', 'embedSlots', 'stateRef', 'base', 'win', 'embedStep', 'slot', 'band', 'alive', 'mostlyHidden', 'farFromBand', 'top', 'bottom', 'cancelled']
  const all = { ...env, EMBED_IDLE: live.EMBED_IDLE, embedStep: live.embedStep, mostlyHidden: live.mostlyHidden, farFromBand: live.farFromBand, cancelled: false }
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

// A loaded card driven through its lifted check() with stub answers.
async function liftLive () {
  const answers = []
  const seen = []
  const stateRef = { current: null }
  const { check, live } = await liftCheck({
    playbackClaimCount: () => 0,
    claims: { current: 0 },
    apply: (next) => { stateRef.current = next; seen.push(next) },
    embedSlots: { count: () => 1, free: () => false },
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

// Cards driven through their real apply() and check(), lifted from the
// source, sharing one real createEmbedSlots(2).
async function liftCards () {
  const live = await import('../src/embedLive.js')
  const slots = live.createEmbedSlots(2)
  const start = raw.indexOf('  const apply = (')
  const end = raw.indexOf('  useEffect(() => {\n    alive.current = true')
  if (start === -1 || end === -1) throw new Error('apply() not found in MusicEmbedCard.js')
  const names = ['embedSlots', 'release', 'stateRef', 'base', 'win', 'alive', 'setState', 'EMBED_PARKED', 'EMBED_IDLE', 'EMBED_WAITING']
  const makeApply = new Function(...names, raw.slice(start, end) + '\nreturn apply') // eslint-disable-line no-new-func
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
    const apply = makeApply(slots, c.release, c.stateRef, c.base, c.win, c.alive, (s) => c.shown.push(s), live.EMBED_PARKED, live.EMBED_IDLE, live.EMBED_WAITING)
    c.apply = (...args) => {
      apply(...args)
      most = Math.max(most, slots.count())
    }
    const { check } = await liftCheck({
      playbackClaimCount: () => 0,
      claims: { current: 0 },
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
    c.check = check
    c.seen = () => { check(); answer(300) }
    c.unseen = () => { check(); answer(2000) }
    // More than 3 window heights (3 * 844) below the band's bottom (761).
    c.far = () => { check(); answer(4000) }
    c.answerSeen = () => answer(300)
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
  return { live, slots, card, three, most: () => most }
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

test('a parked holder found far away releases its slot', async (t) => {
  const { live, slots, three, most } = await liftCards()
  const { a, b, c } = await three()
  a.park()
  t.is(a.stateRef.current, live.EMBED_PARKED)
  t.is(slots.count(), 2)
  a.far()
  t.is(a.stateRef.current, live.EMBED_IDLE, 'a check that finds it far unloads it')
  t.absent(a.holds(), 'and releases its slot')
  t.is(slots.count(), 1, 'one slot fewer is taken')
  t.is(b.stateRef.current, live.EMBED_LIVE, 'the other holder is untouched')
  c.seen()
  t.is(c.stateRef.current, live.EMBED_LIVE, 'the waiting newcomer goes live on its next tick')
  t.ok(c.holds())
  t.is(slots.count(), 2)
  b.far()
  t.is(b.stateRef.current, live.EMBED_IDLE, 'a live holder found far away unloads too, parked or not')
  t.is(slots.count(), 1)
  t.ok(most() <= 2, 'never more than two slots taken')
})

test('a late answer never counts as far', async (t) => {
  const { check, live, stateRef, answers } = await liftLive()
  check()
  check()
  t.is(stateRef.current, live.EMBED_AWAY, 'the missing answer counts as hidden only')
  check()
  t.is(stateRef.current, live.EMBED_PARKED, 'and keeps the frame loaded')
  answers.splice(0).pop()(0, 4000, 300, 152)
  t.is(stateRef.current, live.EMBED_IDLE, 'only a fresh far answer unloads it')
})

test('a lowered band measures far from its own bottom', async (t) => {
  const run = async (y) => {
    const stateRef = { current: null }
    const answers = []
    const { check, live } = await liftCheck({
      playbackClaimCount: () => 0,
      claims: { current: 0 },
      apply: (next) => { stateRef.current = next },
      embedSlots: { count: () => 1, free: () => false },
      stateRef,
      base: { current: false },
      win: { width: 390, height: 844 },
      slot: { current: { measureInWindow: (cb) => answers.push(cb) } },
      band: { measure: (reply) => reply(600) },
      alive: { current: true },
      top: 99,
      bottom: 761
    })
    stateRef.current = live.EMBED_LIVE
    check()
    answers.shift()(0, y, 300, 152)
    return { state: stateRef.current, live }
  }
  // 600 + 3 * 844 = 3132; 761 + 3 * 844 = 3293.
  const lowered = await run(3200)
  t.is(lowered.state, lowered.live.EMBED_IDLE, 'far from the lowered band, though within reach of the window band')
  const near = await run(3132)
  t.is(near.state, near.live.EMBED_AWAY, 'at the reach of the lowered band it is only away')
})

test('the dwell counts ticks, not effect runs', (t) => {
  t.ok(/if \(stateRef\.current\.live\) check\(\)\s*const timer = setInterval\(check, EMBED_TICK_MS\)/.test(src), 'only a live frame is checked at once')
  t.absent(/\n\s*check\(\)\n\s*const timer/.test(src), 'no unconditional immediate check')
})

test('a slot is acquired on going live and released on leave and unmount', (t) => {
  t.ok(/if \(next\.live && !stateRef\.current\.live\) \{\s*const done = embedSlots\.acquire\(\)\s*if \(done === null\) \{\s*next = EMBED_WAITING\s*\} else \{\s*release\.current = done/.test(src), 'acquire only on going live, a null result keeps the finished wait, the release is kept')
  t.ok(/const apply = \(next, mayYield = true\) => \{\s*if \(mayYield && next === EMBED_PARKED && release\.current !== null && embedSlots\.yielding\(release\.current\)\) next = EMBED_IDLE\n/.test(src), 'a wanted player yields only on its own parked check, first thing in apply')
  t.is((src.match(/\bapply\([^)]*,\s*false\)/g) || []).length, 0, 'no apply call bars yielding by itself')
  t.ok(/done\(\)\s*\}\s*if \(next\.live && release\.current !== null\) embedSlots\.park\(release\.current, next === EMBED_PARKED\)\s*const changed/.test(src), 'a live card reports whether it is parked after the release block')
  t.absent(/onEvict|evicted/i.test(raw), 'no card is evicted by another')
  t.ok(/if \(!next\.live && release\.current !== null\) \{\s*const done = release\.current\s*release\.current = null\s*done\(\)/.test(src), 'apply releases on leaving live')
  t.ok(/return \(\) => \{\s*alive\.current = false\s*if \(stateRef\.current === EMBED_WAITING\) embedSlots\.withdraw\(\)\s*stateRef\.current = EMBED_IDLE\s*const done = release\.current\s*release\.current = null\s*if \(typeof done === 'function'\) done\(\)/.test(src), 'unmount releases')
  t.ok(src.includes('    if (stateRef.current === EMBED_WAITING && next !== EMBED_WAITING && !next.live) embedSlots.withdraw()\n    if (!next.live && release.current !== null) {'), 'a card that stops waiting without going live withdraws its request, after the acquire block')
  t.ok(/alive\.current = false\s*if \(stateRef\.current === EMBED_WAITING\) embedSlots\.withdraw\(\)\s*stateRef\.current = EMBED_IDLE/.test(src), 'a waiting card withdraws on unmount, before its state is reset')
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
  const busca = withoutComments(fs.readFileSync(path.join(APP, 'src/screens/BuscaGlobal.js'), 'utf8'))
  t.ok(busca.includes("import { ScreenVisible } from '../ui/screenVisible'"), 'Busca imports ScreenVisible')
  t.ok(busca.includes('const visible = useContext(ScreenVisible)'), 'Busca reads the tab signal')
  t.ok(/<ScreenVisible\.Provider value=\{visible && category === 'publicacoes'\}>\s*<View style=\{\[styles\.flex, category !== 'publicacoes' && styles\.hidden\]\}>\{postsPane\}<\/View>\s*<\/ScreenVisible\.Provider>/.test(busca), 'switching to Contas unloads a player in the hidden posts pane')
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
  t.ok(/const lower = Math\.min\(bottom, limit\)\s*settle\(mostlyHidden\(x, y, w, h, top, lower, win\.width\), true, farFromBand\(y, h, top, lower, win\.height\)\)/.test(src), 'a usable answer lowers the band, for hidden and far alike')
  t.ok(/const withLimit = \(limit\) => \{[^}]*?if \(cancelled \|\| !alive\.current \|\| id !== round\) return\n/.test(src), 'cancelled is tested again in the band callback')
  t.ok(/try \{\s*band\.measure\(withLimit\)\s*\} catch \{\s*withLimit\(null\)\s*\}/.test(src), 'a throw counts as no answer, so hidden')
  t.absent(/:\s*bottom\b/.test(src.slice(src.indexOf('const withLimit'), src.indexOf('band.measure(withLimit)'))), 'the band callback never falls back to the window band')
})

test('the stand-in is the stored LinkCard', (t) => {
  const cards = [...src.matchAll(/<LinkCard\b[^>]*\/>/g)].map((m) => m[0])
  t.is(cards.length, 1, 'one LinkCard element')
  t.absent(/\bstill\b/.test(cards[0]), 'not drawn still, so a tap opens the stored link')
  t.absent(/\bstill\b/.test(src), 'no still anywhere in the card')
  t.absent(cards[0].includes('onDismiss'), 'no onDismiss passed to it')
  t.ok(src.includes('const plain = <LinkCard '), 'the card is named plain')
  t.ok(src.includes('<View style={styles.standIn} onStartShouldSetResponder={() => true}>{plain}</View>'), 'the slot draws it')
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

test('embedLive: farFromBand', async (t) => {
  const { farFromBand: far, EMBED_FAR_SCREENS } = await import('../src/embedLive.js')
  t.is(EMBED_FAR_SCREENS, 3)
  // Band 99 to 761 in an 844 pt window: the reach is 3 * 844 = 2532 pt.
  t.is(far(3294, 152, 99, 761, 844), true, 'below the reach')
  t.is(far(3293, 152, 99, 761, 844), false, 'exactly at the reach below')
  t.is(far(-2586, 152, 99, 761, 844), true, 'above the reach')
  t.is(far(-2585, 152, 99, 761, 844), false, 'exactly at the reach above')
  t.is(far(3200, 200, 99, 761, 844), false, 'starting inside the reach below')
  t.is(far(-2600, 200, 99, 761, 844), false, 'ending inside the reach above')
  t.is(far(2000, 152, 99, 761, 844), false, 'out of the band but within reach')
  t.is(far(300, 152, 99, 761, 844), false, 'in the band')
  for (const bad of [NaN, Infinity, -Infinity, undefined, null, '4000']) {
    t.is(far(bad, 152, 99, 761, 844), false, 'a non-finite y is never far')
    t.is(far(4000, bad, 99, 761, 844), false, 'a non-finite height is never far')
    t.is(far(4000, 152, bad, 761, 844), false, 'a non-finite top is never far')
    t.is(far(4000, 152, 99, bad, 844), false, 'a non-finite bottom is never far')
    t.is(far(4000, 152, 99, 761, bad), false, 'a non-finite window height is never far')
  }
  t.is(far(4000, 0, 99, 761, 844), false, 'a zero height is never far')
  t.is(far(4000, -152, 99, 761, 844), false, 'a negative height is never far')
  t.is(far(4000, 152, 99, 761, 0), false, 'a zero window height is never far')
  t.is(far(4000, 152, 99, 761, -844), false, 'a negative window height is never far')
})

test('embedLive: a check that finds a loaded frame far away unloads it', async (t) => {
  const { embedStep, EMBED_IDLE, EMBED_LIVE, EMBED_AWAY, EMBED_PARKED } = await import('../src/embedLive.js')
  const far = { hidden: true, far: true, allowed: true, turned: false, free: true }
  const hidden = { ...far, far: false }
  t.is(embedStep(EMBED_LIVE, far), EMBED_IDLE, 'a live frame')
  t.is(embedStep(EMBED_AWAY, far), EMBED_IDLE, 'an away frame')
  t.is(embedStep(EMBED_PARKED, far), EMBED_IDLE, 'a parked frame')
  t.is(embedStep({ live: true, seen: 2 }, far), EMBED_IDLE, 'any valid live state')
  t.is(embedStep(EMBED_AWAY, { ...far, turned: true }), EMBED_LIVE, 'a turned window keeps the frame, far or not')
  t.is(embedStep(EMBED_LIVE, { ...far, turned: true }), EMBED_LIVE)
  let state = EMBED_PARKED
  for (let i = 0; i < 1000; i++) state = embedStep(state, hidden)
  t.is(state, EMBED_PARKED, 'hidden checks alone keep a parked frame for good')
  t.is(embedStep(state, far), EMBED_IDLE, 'the first far check unloads it')
  t.is(embedStep(EMBED_IDLE, far), EMBED_IDLE, 'a card that is not live stays idle')
  t.is(embedStep({ live: false, seen: 1 }, far), EMBED_IDLE, 'a dwell resets')
  t.is(embedStep(EMBED_LIVE, { ...far, far: 1 }), EMBED_AWAY, 'only far: true counts as far')
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
