'use strict'

const test = require('brittle')
const rpc = require('..')
const px = require('../lib/profile-extra')

test('profile-extra is exported from the package index', (t) => {
  t.is(rpc.profileExtra, px)
  t.is(rpc.THEME_IDS, px.THEME_IDS)
  t.is(rpc.isBirthday, px.isBirthday)
  t.alike([rpc.MAX_ABOUT, rpc.MAX_CITY, rpc.MAX_WORK, rpc.MAX_STUDIES, rpc.MAX_INTERESTS, rpc.MAX_MOOD_TEXT], [600, 60, 80, 80, 200, 60])
  t.alike([px.MAX_ABOUT, px.MAX_CITY, px.MAX_WORK, px.MAX_STUDIES, px.MAX_INTERESTS, px.MAX_MOOD_TEXT], [600, 60, 80, 80, 200, 60])
})

test('THEME_IDS: eight frozen unique lowercase ids', (t) => {
  t.is(px.THEME_IDS.length, 8)
  t.ok(Object.isFrozen(px.THEME_IDS))
  t.is(new Set(px.THEME_IDS).size, 8)
  for (const id of px.THEME_IDS) {
    t.ok(/^[a-z-]{2,16}$/.test(id), id)
    t.is(px.isThemeId(id), true)
  }
  for (const v of ['', 'Mar', 'rosa', 'constructor', '__proto__', 'toString', 5, null, undefined, ['mar']]) t.is(px.isThemeId(v), false, String(v))
})

test('isBirthday: MM-DD with a real month and day, 02-29 allowed', (t) => {
  const days = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0')
    for (let d = 1; d <= days[m - 1]; d++) t.is(px.isBirthday(mm + '-' + String(d).padStart(2, '0')), true, mm + '-' + d)
    t.is(px.isBirthday(mm + '-' + String(days[m - 1] + 1).padStart(2, '0')), false, mm + ' past its last day')
    t.is(px.isBirthday(mm + '-00'), false)
  }
  for (const v of ['00-01', '13-01', '1-1', '01-1', '001-01', '01-001', '2000-01-01', '01/01', '01-01 ', ' 01-01', '01-01\n', '٠١-٠١', 101, null, undefined, {}, ['01-01']]) {
    t.is(px.isBirthday(v), false, JSON.stringify(v))
  }
})

test('field texts: limits in code points, no controls, no blank, LF only in about', (t) => {
  const fields = [['isAbout', 600, true], ['isCity', 60, false], ['isWork', 80, false], ['isStudies', 80, false], ['isInterests', 200, false]]
  for (const [name, max, multiline] of fields) {
    const is = px[name]
    t.is(is('a'), true, name)
    t.is(is('a'.repeat(max)), true, name + ' at limit')
    t.is(is('😀'.repeat(max)), true, name + ' counts code points')
    t.is(is('a'.repeat(max + 1)), false, name + ' over limit')
    t.is(is('😀'.repeat(max + 1)), false)
    t.is(is(''), false, name + ' empty is null, not an empty string')
    t.is(is(' \t'), false, name + ' blank')
    for (const bad of ['a\u0000b', 'a\u007fb', 'a\u0085b', 'a\u2028b', 'a\u2029b', 'a\u202eb', 'a\u2066b', 'a\ud800b', 'a\udc00b', 'a\ud800', 5, null, undefined, {}]) {
      t.is(is(bad), false, name + ' ' + JSON.stringify(bad))
    }
    t.is(is('a\nb'), multiline, name + ' newline')
    t.is(is('a\rb'), false, name + ' carriage return')
    for (const blank of ['\u200b', '\u200c\u200d', '\u2060', '\u00ad', ' \u200b\t\u2060\u00ad', '\u200b'.repeat(max)]) {
      t.is(is(blank), false, name + ' invisible only ' + JSON.stringify(blank))
    }
    t.is(is('a\u200b'), true, name + ' visible text with a zero-width char')
  }
})

test('mood: one emoji or none, short single-line text', (t) => {
  t.is(px.isMoodEmoji(''), true)
  for (const e of ['😀', '👍🏽', '🇧🇷', '👨‍👩‍👧', '1️⃣']) t.is(px.isMoodEmoji(e), true, e)
  for (const e of ['a', '😀😀', '😀 ', ' ', 'oi', '‍', '😀\u0000', 5, null, undefined]) t.is(px.isMoodEmoji(e), false, JSON.stringify(e))
  t.is(px.isMoodText(''), true)
  t.is(px.isMoodText('a'.repeat(60)), true)
  t.is(px.isMoodText('😀'.repeat(60)), true)
  t.is(px.isMoodText('a'.repeat(61)), false)
  for (const bad of ['a\nb', 'a\u0000b', 'a\u202eb', 'a\ud800b', 5, null, undefined]) t.is(px.isMoodText(bad), false, JSON.stringify(bad))
})

// Characters that draw nothing on their own, each tried alone, repeated and
// mixed with whitespace; with a visible character the text passes.
const INVISIBLES = ['\u200b', '\u200c', '\u200d', '\u2060', '\u00ad', '\u115f', '\u1160', '\u3164', '\uffa0', '\u2800', '\ufff9', '\ufffa', '\ufffb', '\u{e0000}', '\u{e0001}', '\u{e0020}', '\u{e007f}']

test('invisible only: every invisible character is refused in fields and mood text', (t) => {
  for (const ch of INVISIBLES) {
    const label = 'U+' + ch.codePointAt(0).toString(16).toUpperCase()
    for (const v of [ch, ch + ch, ' ' + ch + '\t', ch + '\u200b' + ch]) {
      t.is(px.isInvisibleOnly(v), true, label + ' ' + JSON.stringify(v))
      for (const name of ['isAbout', 'isCity', 'isWork', 'isStudies', 'isInterests']) t.is(px[name](v), false, name + ' ' + label)
      t.is(px.isMoodText(v), false, 'isMoodText ' + label)
    }
    t.is(px.isInvisibleOnly('a' + ch), false, label + ' with a visible character')
    t.is(px.isCity('a' + ch), true, label + ' visible text passes')
    t.is(px.isMoodText(ch + 'a'), true, label + ' visible mood text passes')
  }
  t.is(px.isInvisibleOnly(''), true)
  t.is(px.isMoodText(''), true, 'an empty mood text is still no text')
  t.is(px.isMoodText(' '), false, 'only whitespace')
  t.is(px.isMoodText(' oi '), true)
  for (const v of ['\u{e0080}', '\u{1f600}', '\ufffc', '\u3163', 'x']) t.is(px.isInvisibleOnly(v), false, 'U+' + v.codePointAt(0).toString(16).toUpperCase() + ' draws something')
  for (const v of [5, null, undefined, {}, ['\u200b']]) t.is(px.isInvisibleOnly(v), false, JSON.stringify(v))
})

test('nullable: null passes, otherwise the check decides', (t) => {
  const check = px.nullable(px.isCity)
  t.is(check(null), true)
  t.is(check('Recife'), true)
  t.is(check(undefined), false)
  t.is(check(''), false)
})
