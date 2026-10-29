'use strict'

const test = require('brittle')
const { postRecord, validateRecord } = require('@varanda/core').records
const { findMentions, mentionTokens, mentionSegments, activeMention, MENTION_MAX } = require('@varanda/rpc')

test('findMentions: boundaries and UTF-16 offsets', (t) => {
  const cases = [
    ['@ana', 0, 4, 'ana'],
    ['(@ana)', 1, 5, 'ana'],
    ['#@ana', 1, 5, 'ana'],
    ['olá @ana!', 4, 8, 'ana'],
    ['@ana\u200b, oi', 0, 4, 'ana'],
    ['@ana\u200b ', 0, 4, 'ana'],
    ['@ana,', 0, 4, 'ana'],
    ['@ana ', 0, 4, 'ana'],
    ['😀@ana', 2, 6, 'ana'],
    ['oi\n@ana', 3, 7, 'ana'],
    ['@Ana', 0, 4, 'ana'],
    ['@anaZ', 0, 5, 'anaz'],
    ['@a_1', 0, 4, 'a_1'],
    ['@' + 'a'.repeat(20), 0, 21, 'a'.repeat(20)]
  ]
  for (const [text, start, end, username] of cases) {
    const spans = findMentions(text)
    t.alike(spans, [{ start, end, username }])
    t.is(text.slice(spans[0].start, spans[0].end), text.slice(start, end))
  }
  for (const text of ['', 'x@ana', 'café@ana', 'cafe\u0301@ana', '\u00e9@ana', 'x\u200b@ana', 'x\u00ad\u2060@ana', '\uff21@ana', '\uff20ana', '\uff21\u200b@ana', '@an\u00e1b', '@an\u00e9', '@ane\u0301', '@an\u200ba', '@ana\u200b\u00e1', '@ana\u0301', '@ana\uff21', 'email@ana.com', 'A@ana', '0@ana', '_@ana', '@@ana', '@ab', '@abcdef', '@ABCDEF', '@ab12ef', '@123abc', '@_ana', '@', '@' + 'a'.repeat(21)]) {
    t.alike(findMentions(text), [])
  }
  t.alike(findMentions('@Ana, @bob!'), [
    { start: 0, end: 4, username: 'ana' },
    { start: 6, end: 10, username: 'bob' }
  ])
})

test('findMentions: lookalikes, marks and invisible characters', (t) => {
  t.alike(findMentions('@an\u00e1b'), [])
  t.alike(findMentions('@ane\u0301'), [])
  t.alike(findMentions('x\u200b@ana'), [])
  t.alike(findMentions('\uff21@ana'), [])
  t.alike(findMentions('\uff20ana'), [])
  t.alike(findMentions('\u{1F600}@ana'), [{ start: 2, end: 6, username: 'ana' }])
  t.alike(findMentions('@ana\u200b, oi'), [{ start: 0, end: 4, username: 'ana' }])
  t.alike(findMentions('olá @ana!'), [{ start: 4, end: 8, username: 'ana' }])
  t.alike(mentionTokens('@an\u00e1b @ana\u200b!'), ['ana'])
})

test('findMentions: boundaries fail closed on unlisted neighbours', (t) => {
  for (const text of [
    '@anaб', '@ana️b', 'x️@ana', 'б@ana', '中@ana',
    '@ana中', '١@ana', '@ana', '@ana', '\ud800@ana',
    '@ana\udc00', '＠ana', '@ana\u{E0061}b', 'x\u{E0061}@ana'
  ]) {
    t.alike(findMentions(text), [], JSON.stringify(text))
    t.alike(mentionTokens(text), [], JSON.stringify(text))
  }
  const cases = [
    ['\u{1F600}@ana', 2, 6],
    ['\u{1F600}️ @ana', 4, 8],
    ['\u{1F600}️@ana', 3, 7],
    ['«@ana»', 1, 5],
    ['¿@ana?', 1, 5],
    ['@ana、', 0, 4],
    ['@ana…', 0, 4],
    [' @ana ', 1, 5],
    ['@ana​, oi', 0, 4],
    ['olá @ana!', 4, 8],
    [' @ana　', 1, 5],
    ['→@ana！', 1, 5],
    ['@ana@bob', 0, 4]
  ]
  for (const [text, start, end] of cases) {
    t.alike(findMentions(text), [{ start, end, username: 'ana' }], JSON.stringify(text))
  }
})

test('mentionTokens: distinct names in first-seen order with a limit', (t) => {
  t.is(MENTION_MAX, 8)
  t.alike(mentionTokens('oi @Ana e @bob, @ana de novo'), ['ana', 'bob'])
  const names = Array.from({ length: 9 }, (_, i) => 'user' + i)
  const text = '@USER0 ' + names.map(name => '@' + name).join(' ')
  t.alike(mentionTokens(text), names.slice(0, 8))
  t.alike(findMentions(text).map(span => span.username), ['user0', ...names])
  t.alike(mentionTokens(text, 2), names.slice(0, 2))
  t.alike(mentionTokens(text, 9), names)
  t.alike(mentionTokens(text, 0), [])
  t.alike(mentionTokens(text, -1), [])
})

test('mentionSegments: preserves text and merges plain runs', (t) => {
  const text = '😀 oi @Ana, @ab e x@bob; @bob!'
  t.alike(mentionSegments(text), [
    { text: '😀 oi ', username: null },
    { text: '@Ana', username: 'ana' },
    { text: ', @ab e x@bob; ', username: null },
    { text: '@bob', username: 'bob' },
    { text: '!', username: null }
  ])
  for (const input of ['', text, '@Ana', '@ana @bob', '@abcdef @ab', 'plain\ntext\ud800']) {
    const segments = mentionSegments(input)
    t.is(segments.map(segment => segment.text).join(''), input)
    for (let i = 1; i < segments.length; i++) {
      t.ok(segments[i - 1].username !== null || segments[i].username !== null)
    }
  }
  t.alike(mentionSegments('@an\u00e1b'), [{ text: '@an\u00e1b', username: null }])
  t.alike(mentionSegments('@ane\u0301'), [{ text: '@ane\u0301', username: null }])
  t.alike(mentionSegments('plain text'), [{ text: 'plain text', username: null }])
  t.alike(mentionSegments(''), [])
})

test('activeMention: incomplete queries and whole replacement spans', (t) => {
  t.alike(activeMention('oi @An', 6), { start: 3, end: 6, query: 'an' })
  t.alike(activeMention('oi @Ana!', 5), { start: 3, end: 7, query: 'a' })
  t.alike(activeMention('oi @Ana!', 7), { start: 3, end: 7, query: 'ana' })
  t.alike(activeMention('oi @Ana!', 4), { start: 3, end: 7, query: '' })
  t.alike(activeMention('@', 1), { start: 0, end: 1, query: '' })
  t.alike(activeMention('😀@An', 5), { start: 2, end: 5, query: 'an' })
  t.alike(activeMention('\u{1F600}@An', 5), { start: 2, end: 5, query: 'an' })
  t.alike(activeMention('@an\u200b@', 3), { start: 0, end: 4, query: 'an' })
  t.alike(activeMention('@an\u00e1', 3), { start: 0, end: 4, query: 'an' })
  t.alike(activeMention('@an\u00e1b', 3), { start: 0, end: 5, query: 'an' })
  t.alike(activeMention('@ana\u0301', 4), { start: 0, end: 5, query: 'ana' })
  t.alike(activeMention('@an\u0301', 3), { start: 0, end: 4, query: 'an' })
  t.is(activeMention('@an\u00e1', 4), null)
  t.alike(activeMention('@an\u0431x', 3), { start: 0, end: 5, query: 'an' })
  t.alike(activeMention('@an\ufe0f\u4e2d, oi', 3), { start: 0, end: 5, query: 'an' })
  t.alike(activeMention('@ana', 4), { start: 0, end: 4, query: 'ana' })
  t.is(activeMention('\u0431@an', 4), null)
  t.is(activeMention('x\ufe0f@an', 5), null)
  t.alike(activeMention('#@An', 4), { start: 1, end: 4, query: 'an' })
  t.alike(activeMention('(@An)', 4), { start: 1, end: 4, query: 'an' })
  t.alike(activeMention('@A_1', 4), { start: 0, end: 4, query: 'a_1' })
  t.alike(activeMention('@abcdef', 7), { start: 0, end: 7, query: 'abcdef' })
  const long = '@' + 'A'.repeat(21)
  t.alike(activeMention(long, 21), { start: 0, end: 22, query: 'a'.repeat(20) })
  t.is(activeMention(long, 22), null)
  for (const [text, caret] of [
    ['oi @Ana!', 3], ['oi @Ana!', 8], ['@an a', 5], ['@an-a', 5],
    ['@ané', 4], ['café@An', 7], ['x\u200b@an', 5], ['\uff21@an', 4], ['\uff20an', 4], ['x@an', 4], ['email@ana.com', 8], ['email@ana.com', 13],
    ['@@an', 4], ['_@an', 4], ['1@an', 4], ['', 0]
  ]) {
    t.is(activeMention(text, caret), null)
  }
})

test('activeMention: clamps the caret to UTF-16 text bounds', (t) => {
  t.is(activeMention('@ana', -1), null)
  t.is(activeMention('@ana', 0), null)
  t.alike(activeMention('@ana', 100), { start: 0, end: 4, query: 'ana' })
  t.alike(activeMention('@ana', Infinity), { start: 0, end: 4, query: 'ana' })
  t.alike(activeMention('@ana', 2.5), { start: 0, end: 4, query: 'a' })
  for (const caret of [undefined, null, NaN, '4', {}]) t.is(activeMention('@ana', caret), null)
})

test('mention helpers: non-string inputs are not coerced', (t) => {
  const hostile = { toString () { throw new Error('must not coerce') } }
  for (const value of [undefined, null, 42, true, [], {}, Symbol('text'), hostile, Object.create(null)]) {
    t.alike(findMentions(value), [])
    t.alike(mentionTokens(value), [])
    t.alike(mentionSegments(value), [])
    t.is(activeMention(value, 1), null)
  }
})

test('mentions stay in post text without changing the record shape', (t) => {
  const record = postRecord({ text: 'oi @ana' })
  t.alike(Object.keys(record).sort(), ['at', 'replyTo', 'text', 'type'])
  t.is(record.text, 'oi @ana')
  t.is(validateRecord(record, 1), null)
  t.is(validateRecord({ ...record, mentions: ['ana'] }, 1), 'malformed')
})

test('findMentions: CJK marks, superscripts and the soft hyphen are not separators', (t) => {
  for (const text of ['@ana〪', '@ana々', '々@ana', '@ana〱', '@ana²', '@ana½', '@ana­b', '@ana①', '❶@ana', '@ana\u{1F100}']) {
    t.alike(findMentions(text), [], JSON.stringify(text) + ' is not a mention')
  }
  for (const text of ['@ana、', '「@ana」', '@ana­', '@ana\u{1F1E7}\u{1F1F7}', '@ana→']) {
    t.alike(mentionTokens(text), ['ana'], JSON.stringify(text) + ' mentions ana')
  }
})

test('activeMention: end runs over a soft hyphen in the fragment', (t) => {
  t.alike(activeMention('@an­b', 3), { start: 0, end: 5, query: 'an' })
})
