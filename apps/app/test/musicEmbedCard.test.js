'use strict'

// MusicEmbedCard: the music link card that plays in the provider's player
// only after a tap. The UI file pulls in react-native, so it is read as text
// and its pure visibility rule is lifted out of the source and run alone.
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

function mostlyHidden () {
  const start = raw.indexOf('export function mostlyHidden')
  const end = raw.indexOf('\n}\n', start)
  if (start === -1 || end === -1) throw new Error('mostlyHidden not found in MusicEmbedCard.js')
  const enough = raw.match(/^const SEEN_ENOUGH = \d+$/m)
  if (!enough) throw new Error('SEEN_ENOUGH not found in MusicEmbedCard.js')
  return new Function(enough[0] + '\n' + raw.slice(start, end + 2).replace('export ', '') + '\nreturn mostlyHidden')() // eslint-disable-line no-new-func
}

test('the web frame-src list is exactly EMBED_FRAME_ORIGINS', async (t) => {
  const { EMBED_FRAME_ORIGINS } = await import('../src/musicEmbed.js')
  const csp = fs.readFileSync(CADDYFILE, 'utf8').split('\n').filter((line) => /^\s*Content-Security-Policy\s/.test(line))
  t.is(csp.length, 1, 'one Content-Security-Policy header')
  const directive = csp[0].split(';').map((d) => d.trim().replace(/^"/, '')).find((d) => d.startsWith('frame-src '))
  t.ok(directive, 'the header has frame-src')
  t.alike(directive.split(/\s+/).slice(1), [...EMBED_FRAME_ORIGINS])
})

test('the player claim is bound, and released on close and unmount', (t) => {
  t.ok(src.includes("import { claimPlayback } from '../media/chatMedia'"))
  const claims = [...src.matchAll(/claimPlayback\(([^)]*\))/g)]
  t.is(claims.length, 1, 'one claim')
  t.is(claims[0][0], 'claimPlayback({ pause: close }, { bound: true })', 'a bound claim that closes the frame')
  t.ok(/const close = useCallback\(\(\) => \{\s*const done = release\.current\s*release\.current = null\s*if \(typeof done === 'function'\) done\(\)/.test(src), 'close releases the claim')
  t.ok(/return \(\) => \{\s*alive\.current = false\s*close\(\)\s*\}/.test(src), 'unmount closes')
})

test('the frame is mounted only after a tap, at the card width, when it fits', (t) => {
  t.ok(src.includes('const [open, setOpen] = useState(false)'), 'closed by default')
  const frames = [...src.matchAll(/<EmbedFrame\b/g)]
  t.is(frames.length, 1, 'one EmbedFrame')
  const openAt = src.indexOf('if (open) {')
  const closedAt = src.indexOf('accessibilityLabel={EMBED_PLAY + \': \' + name}')
  t.ok(openAt !== -1 && closedAt !== -1, 'open branch and play button found')
  t.ok(frames[0].index > openAt && frames[0].index < closedAt, 'EmbedFrame sits in the open branch only')
  t.ok(/onPress=\{play\}/.test(src), 'the play button opens it')
  t.ok(/if \(!\(width > 0\) \|\| width < embed\.minWidth\) \{\s*openPage\(\)\s*return\s*\}/.test(src), 'too narrow or unmeasured: opened outside the app')
  const frame = src.slice(frames[0].index, src.indexOf('/>', frames[0].index))
  for (const prop of [
    'embedUrl={embed.embedUrl}',
    'html={embedHtml(embed)}',
    'baseUrl={EMBED_BASE_URL}',
    'allowTop={topNavigationAllowed}',
    'height={height}'
  ]) t.ok(frame.includes(prop), prop)
  t.absent(frame.includes('onOpenExternal'), 'the player is given no way out of the app')
  t.ok(src.includes('const openPage = () => openExternal(url)'), 'the card link still opens the card URL')
  t.ok(/accessibilityLabel=\{openLabel\}\s*onPress=\{openPage\}/.test(src), 'on a tap of "Abrir no ..."')
  t.ok(src.includes('const height = embedHeight(embed, width)'), 'height from the measured width')
  t.ok(/<View ref=\{slot\} collapsable=\{false\} style=\{\{ width: '100%', height \}\}>\s*<EmbedFrame/.test(src), 'full width, nothing else in the slot')
  t.ok(src.includes('accessibilityLabel={EMBED_CLOSE}') && /onPress=\{close\}/.test(src), 'a close button')
})

test('the open frame closes when it is mostly out of the feed band', (t) => {
  t.ok(src.includes('const VISIBILITY_MS = 500'))
  t.ok(src.includes("import { useSafeAreaInsets } from 'react-native-safe-area-context'"), 'insets from the safe-area context')
  t.ok(src.includes('const top = insets.top + layout.topBar'), 'the band starts under the top bar')
  t.ok(src.includes('const bottom = win.height - (insets.bottom + (tabBarShown ? layout.tabBar : 0))'), 'the band ends above the tab bar, when there is one')
  t.ok(/setInterval\([\s\S]*?measureInWindow\([\s\S]*?mostlyHidden\(x, y, w, h, top, bottom, win\.width\)\) close\(\)[\s\S]*?VISIBILITY_MS\)/.test(src), 'measured every 500 ms against the band')
  t.ok(src.includes('return () => clearInterval(timer)'), 'the timer stops with the frame')
  const hidden = mostlyHidden()
  t.is(hidden(0, 0, 300, 200, 0, 800, 400), false, 'fully visible')
  t.is(hidden(0, 700, 300, 200, 0, 800, 400), false, 'half visible')
  t.is(hidden(0, 701, 300, 200, 0, 800, 400), true, 'just under half at the bottom')
  t.is(hidden(0, -101, 300, 200, 0, 800, 400), true, 'just under half at the top')
  t.is(hidden(-151, 0, 300, 200, 0, 800, 400), true, 'just under half at the side')
  t.is(hidden(0, 900, 300, 200, 0, 800, 400), true, 'below the window')
  t.is(hidden(0, 0, 0, 0, 0, 800, 400), true, 'not laid out')
  t.is(hidden(NaN, 0, 300, 200, 0, 800, 400), true, 'unmeasurable')
  t.is(hidden(undefined, 0, 300, 200, 0, 800, 400), true, 'no measure')

  // An 844 pt iPhone window with insets 47 and 34: a 99 pt header (52 + 47)
  // and an 83 pt tab bar (49 + 34) leave the band from 99 to 761.
  const top = 99
  const bottom = 844 - 83
  t.is(hidden(0, -60, 300, 152, top, bottom, 390), true, 'Spotify player under the header')
  t.is(hidden(0, bottom, 300, 152, top, bottom, 390), true, 'Spotify player under the tab bar')
  t.is(hidden(0, bottom, 300, 166, top, bottom, 390), true, 'SoundCloud player under the tab bar')
  t.is(hidden(0, 300, 300, 152, top, bottom, 390), false, 'player inside the band')
  t.is(hidden(0, bottom - 76, 300, 152, top, bottom, 390), false, 'exactly half inside at the bottom')
  t.is(hidden(0, top - 76, 300, 152, top, bottom, 390), false, 'exactly half inside at the top')

  // A tall player (Apple album, 450 pt) stays while 120 pt of it shows.
  t.is(hidden(0, bottom - 150, 300, 450, top, bottom, 390), false, '450 pt slot with 150 pt inside')
  t.is(hidden(0, bottom - 100, 300, 450, top, bottom, 390), true, '450 pt slot with 100 pt inside')
  t.is(hidden(0, bottom - 120, 300, 450, top, bottom, 390), false, '450 pt slot with exactly 120 pt inside')
  t.is(hidden(0, bottom - 119, 300, 450, top, bottom, 390), true, '450 pt slot with 119 pt inside')

  // A pushed screen has no tab bar: the same slot is on screen without it.
  const stackBottom = 844 - 34
  t.is(hidden(0, 686, 300, 152, top, stackBottom, 390), false, 'no tab bar: 152 pt player at y 686 is visible')
  t.is(hidden(0, 686, 300, 152, top, bottom, 390), true, 'tab bar: the same player is hidden')
})

test('an unmeasurable slot closes, and a fresh player has a grace', (t) => {
  t.ok(src.includes('const OPEN_GRACE_MS = 2000'), 'grace constant')
  t.ok(/if \(Date\.now\(\) - openedAt < OPEN_GRACE_MS\) return/.test(src), 'the grace gates the close')
  t.ok(/if \(!view \|\| typeof view\.measureInWindow !== 'function'\) \{\s*if \(alive\.current\) close\(\)\s*return\s*\}/.test(src), 'no slot or no measure closes')
  t.ok(/\} catch \{\s*if \(alive\.current\) close\(\)\s*\}/.test(src), 'a throwing measure closes')
  t.ok(src.indexOf('OPEN_GRACE_MS) return') < src.indexOf('typeof view.measureInWindow'), 'grace comes before every measurement path')
  t.ok(src.includes("import { TabBarShown } from './tabBarShown'") && src.includes('useContext(TabBarShown)'), 'reads TabBarShown')
  t.ok(/\[open, close, win\.width, win\.height, insets\.top, insets\.bottom, tabBarShown\]/.test(src), 'tabBarShown is a dependency')
})

test('a window that turned after the tap pauses the visibility close', (t) => {
  const open = src.indexOf('openedLandscape.current = win.width > win.height')
  const effect = src.indexOf('useEffect(() => {\n    if (!open) return undefined')
  t.ok(open > 0 && open < src.indexOf('setOpen(true)'), 'orientation is captured in a ref where the tap opens')
  t.ok(effect > 0 && !src.slice(effect, src.indexOf('}, [open, close', effect)).includes('openedLandscape.current ='), 'the interval effect never writes it')
  const guard = src.indexOf('(win.width > win.height) !== openedLandscape.current')
  t.ok(guard > effect && guard < src.indexOf('measureInWindow((', effect), 'the interval returns before measuring')
  t.ok(/!== openedLandscape\.current\) return\n/.test(src), 'it returns without closing')
})

test('the closed card shows the provider notice and an outside link', (t) => {
  t.ok(src.includes('embedNotice(embed.provider)'), 'the notice is drawn')
  t.ok(src.includes("const openLabel = 'Abrir no ' + name"))
  t.ok(src.includes('const openPage = () => openExternal(url)'))
  t.ok(src.includes("from '../openExternal'"))
})

test('MusicEmbedCard is phone-safe and stays out of the Vitrine', (t) => {
  for (const api of ['window.', 'document.', 'globalThis.', 'navigator.', 'localStorage', 'Platform']) {
    t.absent(src.includes(api), 'no ' + api)
  }
  t.absent(/vitrine/i.test(src), 'no Vitrine import')
  t.absent(raw.includes('\u2014'), 'no em dash')
})
