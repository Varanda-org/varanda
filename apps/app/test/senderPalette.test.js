'use strict'

// The name colours (ReplyPreview SENDER_*) and the avatar stripes (theme.js)
// share one index, so they must stay the same length and stay readable. The
// modules import react-native, so the lists are read from the source text.
const test = require('brittle')
const fs = require('fs')
const path = require('path')
const read = (file) => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')

const hexes = (source, name) => {
  const m = source.match(new RegExp('const ' + name + ' = \\[([^\\]]*)\\]'))
  return m ? [...m[1].matchAll(/'(#[0-9a-f]{6})'/g)].map((x) => x[1]) : []
}
const stripes = [...read('ui/theme.js').match(/export const stripes = \[([^\]]*)\]/)[1].matchAll(/bg: '(#[0-9a-f]{6})', ink: '(#[0-9a-f]{6})'/g)].map((x) => ({ bg: x[1], ink: x[2] }))
const LIGHT = hexes(read('ui/ReplyPreview.js'), 'SENDER_LIGHT')
const DARK = hexes(read('ui/ReplyPreview.js'), 'SENDER_DARK')
const ON_MINE_DARK = hexes(read('ui/ReplyPreview.js'), 'SENDER_ON_MINE_DARK')

const over = (fg, alpha, bg) => '#' + [0, 1, 2].map((i) => {
  const f = parseInt(fg.slice(1 + i * 2, 3 + i * 2), 16)
  const b = parseInt(bg.slice(1 + i * 2, 3 + i * 2), 16)
  return Math.round(f * alpha + b * (1 - alpha)).toString(16).padStart(2, '0')
}).join('')

test('avatar stripes and name colours have 8 entries in the same order', async (t) => {
  const { avatarColorOf } = await import('../src/format.js')
  t.is(stripes.length, 8)
  t.is(LIGHT.length, 8)
  t.is(DARK.length, 8)
  t.is(new Set(LIGHT).size, 8, 'light colours are distinct')
  t.is(new Set(DARK).size, 8, 'dark colours are distinct')
  t.is(LIGHT[4], '#1d6b4f', 'index 4 is still the accent hue (the fallback)')
  t.is(DARK[4], '#5dcaa0')
  t.is(stripes[4].bg, '#1d6b4f')
  for (let i = 0; i < 256; i++) t.ok(avatarColorOf(i.toString(16).padStart(2, '0')) < stripes.length)
})

test('name colours and stripe inks are readable (WCAG contrast)', async (t) => {
  const { contrastRatio, light, dark } = await import('../src/appearance.js')
  const lightTint = [over('#1f2a24', 0.08, light.card), over('#1f2a24', 0.08, light.bg), over('#1f2a24', 0.08, light.bubbleMine)]
  const darkTint = [over('#f5f5f5', 0.10, dark.card), over('#f5f5f5', 0.10, dark.bg)]
  LIGHT.forEach((c) => {
    t.ok(contrastRatio(c, light.card) >= 4.5, 'light ' + c + ' on the card')
    t.ok(contrastRatio(c, light.bg) >= 4.5, 'light ' + c + ' on the page')
    t.ok(contrastRatio(c, light.bubbleMine) >= 4.5, 'light ' + c + ' on my bubble')
    for (const bg of lightTint) t.ok(contrastRatio(c, bg) >= 4.5, 'light ' + c + ' on the tint ' + bg)
  })
  DARK.forEach((c) => {
    for (const bg of [dark.card, dark.bg, ...darkTint]) t.ok(contrastRatio(c, bg) >= 4.5, 'dark ' + c + ' on ' + bg)
  })
  for (const s of stripes) t.ok(contrastRatio(s.ink, s.bg) >= 4.5, 'stripe ink on ' + s.bg)
})

test('a quote inside my own bubble stays readable in the dark scheme', async (t) => {
  const { contrastRatio, dark } = await import('../src/appearance.js')
  const preview = read('ui/ReplyPreview.js')
  const soft = preview.match(/const SOFT_ON_MINE_DARK = '(#[0-9a-f]{6})'/)
  t.is(ON_MINE_DARK.length, 8, 'one shade per name colour')
  t.is(new Set(ON_MINE_DARK).size, 8, 'the shades are distinct')
  t.ok(soft, 'the quoted text has its own grey there')
  // The quote box lays the scheme's skeleton tint over the bubble.
  const box = over('#f5f5f5', 0.10, dark.bubbleMine)
  t.ok(DARK.some((c) => contrastRatio(c, box) < 4.5), 'the plain dark names fall short on my bubble')
  t.ok(contrastRatio(dark.accent, box) < 4.5, 'so does the accent')
  ON_MINE_DARK.forEach((c) => {
    t.ok(contrastRatio(c, box) >= 4.5, 'dark on my bubble ' + c)
    t.ok(contrastRatio(c, dark.bubbleMine) >= 4.5, 'dark on my bubble, outside the box ' + c)
  })
  t.ok(contrastRatio(soft[1], box) >= 4.5, 'the quoted text on my bubble')
  t.ok(preview.includes('own ? (onMineDark ? SENDER_ON_MINE_DARK[4] : colors.accent) : senderColor(senderKey, scheme, onMine)'), 'my own quote takes the accent shade there')
  t.ok(preview.includes("scheme === 'dark' ? (onMine ? SENDER_ON_MINE_DARK : SENDER_DARK) : SENDER_LIGHT"), 'others take their shade there')
  t.ok(read('ui/Bubble.js').includes('mine={quote.mine} onMine={!!mine}'), 'the bubble tells the quote it is mine')
})
