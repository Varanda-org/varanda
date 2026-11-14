'use strict'

// The invite welcome (src/ui/InviteWelcome.js) and the screen that mounts it
// (src/ui/InviteCardOpen.js) read from source: both import react-native, which
// does not load on Node. The choreography itself is pinned in
// inviteWelcomeMotion.test.js and the layout in inviteWelcomeStage.test.js.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const read = (rel) => fs.readFileSync(path.join(__dirname, '../src', rel), 'utf8')
const OPEN = read('ui/InviteCardOpen.js')
const WELCOME = read('ui/InviteWelcome.js')
const FRAME = read('ui/InviteCardFrame.js')
const APP = fs.readFileSync(path.join(__dirname, '../App.js'), 'utf8')
const staticColors = /import\s*\{[^}]*\bcolors\b[^}]*\}\s*from/

const count = (src, needle) => src.split(needle).length - 1

test('InviteWelcome: plain Views, no loop, no peer text', (t) => {
  for (const [name, src] of [['open', OPEN], ['welcome', WELCOME]]) {
    t.absent(src.includes('react-native-svg'), name + ': no svg')
    t.absent(/\bImage\b/.test(src), name + ': no image')
    t.absent(/fontFamily|expo-font|useFonts/.test(src), name + ': no font')
    t.absent(/lottie|reanimated|skia|linear-gradient/i.test(src), name + ': no animation or gradient library')
    t.absent(src.includes('Animated.loop'), name + ': no loop')
    t.absent(/\b(window\.|document\.|navigator\.|globalThis)/.test(src), name + ': no browser global')
    t.absent(staticColors.test(src), name + ': no static colors import')
    t.absent(src.includes('\u2014'), name + ': no em dash')
    t.absent(src.includes('displayText'), name + ': peer text stays in InviteCard')
    t.absent(src.includes('announceForAccessibility'), name + ': no announcement')
    t.absent(src.includes('accessibilityLiveRegion'), name + ': no live region')
  }
})

test('InviteCardOpen: the card and its actions are unchanged and never held', (t) => {
  t.absent(OPEN.includes('Platform'), 'no Platform')
  t.absent(OPEN.includes('pointerEvents'), 'the actions answer during the entrance')
  t.absent(OPEN.includes('Animated'), 'the card is not wrapped in motion')
  t.absent(OPEN.includes('haptics'), 'the haptic lives in the welcome')
  for (const s of ['ENTER_LABEL', 'HOW_LABEL', 'LATER_LABEL', 'onPress={onEnter}', 'onPress={onHow}', 'onPress={onLater}', "accessibilityRole='button'", 'hitSlop={8}']) {
    t.ok(OPEN.includes(s), 'keeps ' + s)
  }
  t.ok(OPEN.includes('<InviteCard design={card.design} name={card.name} message={card.message} username={username} expiryText={expiryText}>'), 'same card props')
  t.ok(OPEN.includes('welcomeBands('), 'reserves the motif bands')
  t.ok(OPEN.includes('artFor(card.design)'), 'ground of the design')
  t.ok(OPEN.includes('useWelcomeEntrance('), 'one entrance driver')
  t.ok(OPEN.includes('const makeStyles = (colors) => StyleSheet.create('), 'styles per scheme')
  const stage = OPEN.indexOf('<InviteWelcomeStage')
  const header = OPEN.indexOf('<InviteWelcomeHeader')
  const card = OPEN.indexOf('<InviteCard ')
  t.ok(stage > -1 && header > stage && card > header, 'stage behind, then header, then card')
})

test('InviteWelcome: motifs are decoration, never read nor touched', (t) => {
  t.is(count(WELCOME, 'Platform.OS'), 1, 'one platform check')
  t.ok(WELCOME.includes("Platform.OS !== 'web'"), 'picks the driver only')
  for (const s of [
    "pointerEvents='none'",
    'aria-hidden',
    'accessibilityElementsHidden',
    "importantForAccessibility: 'no-hide-descendants'",
    'accessible={false}'
  ]) {
    t.ok(WELCOME.includes(s), 'has ' + s)
  }
})

test('InviteWelcome: driven by the pure modules, once per mount', (t) => {
  for (const s of [
    'AccessibilityInfo.isReduceMotionEnabled',
    'reduceMotionChanged',
    'createEntrance(',
    'welcomeStage(',
    'motifsFor(',
    'layoutMotif(',
    'motifMotion(',
    'welcomeMotion(',
    'welcomeCopy(',
    '<Shape',
    "tap('success')",
    "accessibilityRole='header'",
    'accessibilityLabel={copy.tagLabel}',
    'isInteraction: false',
    'clearTimeout('
  ]) {
    t.ok(WELCOME.includes(s), 'has ' + s)
  }
  t.absent(WELCOME.includes('useReduceMotion'), 'does not start before the setting is known')
  t.absent(WELCOME.includes("tap('warn')"), 'no warn haptic')
  t.absent(WELCOME.includes("tap('select')"), 'no select haptic')
  t.absent(WELCOME.includes('numberOfLines'), 'a large font wraps')
  t.absent(WELCOME.includes('useNativeDriver: false'), 'driver from the platform constant')
  t.absent(WELCOME.includes('useNativeDriver: true'), 'driver from the platform constant')
  // A stopped native animation reports its mid value after setValue(1).
  const settle = WELCOME.slice(WELCOME.indexOf('settle: () =>'), WELCOME.indexOf('haptic: () =>'))
  t.ok(settle.includes('setSettled(true)'), 'settle marks the scene settled')
  t.is(WELCOME.split('entrance.settled').length - 1, 2, 'stage and header render at rest once settled')
})

test('InviteCardFrame: Shape is shared, geometry unchanged', (t) => {
  t.ok(FRAME.includes('export function Shape'))
  t.ok(FRAME.includes("rotate: '45deg'"))
  t.ok(FRAME.includes("borderLeftColor: 'transparent'"))
})

test('App: the card screen keeps its gates and handlers', (t) => {
  t.ok(APP.includes('onEnter={() => intro.markSeen()}'))
  t.ok(APP.includes('onHow={() => setOpenHow(true)}'))
  t.ok(APP.includes('onLater={() => setOpenLater(true)}'))
  t.ok(APP.includes('expiryLine('))
  const open = APP.match(/<InviteCardOpen[\s\S]*?\/>/)
  t.ok(open, 'mounts InviteCardOpen')
  t.absent(/\binstant=/.test(open[0]), 'no instant prop')
  t.absent(/\bonPlayed=/.test(open[0]), 'no onPlayed prop')
})
