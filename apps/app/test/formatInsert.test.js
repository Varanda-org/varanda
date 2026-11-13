'use strict'

const test = require('brittle')
const load = () => import('../src/formatInsert.js')
const loadRich = () => import('../src/richText.js')

test('wrapSelection wraps and selects the same text', async (t) => {
  const { wrapSelection } = await load()
  t.alike(wrapSelection('oi mundo', { start: 3, end: 8 }, '*'), { text: 'oi *mundo*', selection: { start: 4, end: 9 } })
  t.alike(wrapSelection('oi mundo', { start: 3, end: 8 }, '||'), { text: 'oi ||mundo||', selection: { start: 5, end: 10 } })
})

test('wrapSelection toggles off', async (t) => {
  const { wrapSelection } = await load()
  t.alike(wrapSelection('oi *mundo*', { start: 4, end: 9 }, '*'), { text: 'oi mundo', selection: { start: 3, end: 8 } }, 'marker just outside')
  t.alike(wrapSelection('oi *mundo*', { start: 3, end: 10 }, '*'), { text: 'oi mundo', selection: { start: 3, end: 8 } }, 'marker at both ends inside')
  t.alike(wrapSelection('oi ~~', { start: 4, end: 4 }, '~'), { text: 'oi ', selection: { start: 3, end: 3 } }, 'an empty pair')
})

test('wrapSelection with a caret inserts a pair around it', async (t) => {
  const { wrapSelection } = await load()
  t.alike(wrapSelection('oi ', { start: 3, end: 3 }, '_'), { text: 'oi __', selection: { start: 4, end: 4 } })
})

test('wrapSelection leaves edge spaces outside the markers', async (t) => {
  const { wrapSelection } = await load()
  t.alike(wrapSelection('oi mundo bom', { start: 2, end: 9 }, '*'), { text: 'oi *mundo* bom', selection: { start: 4, end: 9 } })
})

test('wrapSelection never splits a surrogate pair', async (t) => {
  const { wrapSelection } = await load()
  const out = wrapSelection('a 😀 b', { start: 3, end: 4 }, '*')
  t.alike(out, { text: 'a *😀* b', selection: { start: 3, end: 5 } })
  t.ok(out.text.includes('😀'))
  t.alike(wrapSelection('a😀b', { start: 2, end: 3 }, '*'), { text: '*a😀b*', selection: { start: 1, end: 5 } }, 'next to letters it moves out to them')
})

test('wrapSelection with hostile arguments', async (t) => {
  const { wrapSelection } = await load()
  t.alike(wrapSelection('abc', { start: 1, end: 2 }, '<b>'), { text: 'abc', selection: { start: 1, end: 2 } }, 'unknown marker')
  t.alike(wrapSelection('abc', null, '*'), { text: 'abc **', selection: { start: 5, end: 5 } }, 'no selection is a caret at the end')
  t.alike(wrapSelection('abc', { start: NaN, end: -5 }, '*'), { text: '*abc*', selection: { start: 1, end: 4 } }, 'NaN is the end')
  t.alike(wrapSelection('abc', { start: 99, end: 0 }, '*'), { text: '*abc*', selection: { start: 1, end: 4 } }, 'reversed and out of range')
  t.alike(wrapSelection(null, { start: 0, end: 0 }, '*'), { text: '**', selection: { start: 1, end: 1 } })
})

test('every wrapped marker is read back as its style', async (t) => {
  const { wrapSelection } = await load()
  const { parseRich } = await loadRich()
  const styles = { '*': 'bold', '**': 'bold', _: 'italic', __: 'italic', '~': 'strike', '||': 'spoiler', '`': 'code' }
  for (const [marker, style] of Object.entries(styles)) {
    const { text } = wrapSelection('veja isso aqui', { start: 5, end: 9 }, marker)
    const spans = parseRich(text)[0].spans
    t.alike(spans.filter((s) => s[style]).map((s) => s.text), ['isso'], marker)
  }
})

test('insertCodeBlock puts each fence on its own line', async (t) => {
  const { insertCodeBlock } = await load()
  t.alike(insertCodeBlock('veja x = 1 ok', { start: 5, end: 10 }), {
    text: 'veja \n```\nx = 1\n```\n ok',
    selection: { start: 10, end: 15 }
  })
  t.alike(insertCodeBlock('', { start: 0, end: 0 }), { text: '```\n\n```', selection: { start: 4, end: 4 } })
  t.alike(insertCodeBlock('a\n', { start: 2, end: 2 }), { text: 'a\n```\n\n```', selection: { start: 6, end: 6 } })
  t.alike(insertCodeBlock(42, null), { text: '```\n\n```', selection: { start: 4, end: 4 } })
})

test('insertCodeBlock output parses as a code block', async (t) => {
  const { insertCodeBlock } = await load()
  const { parseRich } = await loadRich()
  const { text } = insertCodeBlock('veja x = *1* ok', { start: 5, end: 12 })
  t.alike(parseRich(text).map((b) => b.kind === 'code' ? ['code', b.text] : ['para', b.spans.map((s) => s.text).join('')]), [
    ['para', 'veja '], ['code', 'x = *1*'], ['para', ' ok']
  ])
})

test('cleanPaste turns TAB and CR into what records accept', async (t) => {
  const { cleanPaste } = await load()
  t.is(cleanPaste('a\tb\r\nc\rd\ne'), 'a  b\nc\nd\ne')
  t.is(cleanPaste('\r\r\n\t'), '\n\n  ')
  t.is(cleanPaste(null), '')
  t.is(cleanPaste(5), '')
  t.is(cleanPaste('sem nada'), 'sem nada')
})

test('wrapSelection trims every space the parser knows', async (t) => {
  const { wrapSelection } = await load()
  const { parseRich } = await loadRich()
  t.alike(wrapSelection(' word ', { start: 0, end: 6 }, '*'), { text: ' *word* ', selection: { start: 2, end: 6 } })
  const { text } = wrapSelection('olá　', { start: 0, end: 4 }, '*')
  t.is(text, '*olá*　')
  t.alike(parseRich(text)[0].spans.filter((s) => s.bold).map((s) => s.text), ['olá'])
})

test('wrapSelection inside a word wraps the whole word', async (t) => {
  const { wrapSelection } = await load()
  const { parseRich } = await loadRich()
  t.alike(wrapSelection('mundo', { start: 0, end: 3 }, '*'), { text: '*mundo*', selection: { start: 1, end: 6 } })
  const out = wrapSelection('oi mundo bom', { start: 5, end: 7 }, '_')
  t.alike(out, { text: 'oi _mundo_ bom', selection: { start: 4, end: 9 } })
  t.alike(parseRich(out.text)[0].spans.filter((s) => s.italic).map((s) => s.text), ['mundo'])
  t.alike(wrapSelection('*mundo*', { start: 1, end: 4 }, '*'), { text: 'mundo', selection: { start: 0, end: 5 } }, 'toggles off on the whole word')
  t.alike(wrapSelection('mundo', { start: 2, end: 2 }, '*'), { text: 'mu ** ndo', selection: { start: 4, end: 4 } }, 'a caret inside a word gets spaces around the pair')
})

test('insertCodeBlock keeps a selected fence line inside the block', async (t) => {
  const { insertCodeBlock } = await load()
  const { parseRich } = await loadRich()
  const src = 'x\n```\n*y* ||z||'
  const out = insertCodeBlock(src, { start: 0, end: src.length })
  t.is(out.text, '````\n' + src + '\n````')
  t.alike(parseRich(out.text), [{ kind: 'code', lang: null, text: src }])
  const longer = 'a\n`````\n||b||'
  t.alike(parseRich(insertCodeBlock(longer, { start: 0, end: longer.length }).text), [{ kind: 'code', lang: null, text: longer }])
})

test('a caret beside a letter gets a pair that formats what is typed', async (t) => {
  const { wrapSelection } = await load()
  const { parseRich } = await loadRich()
  const styles = { '*': 'bold', '**': 'bold', _: 'italic', __: 'italic', '~': 'strike', '||': 'spoiler', '`': 'code' }
  for (const [src, at] of [['mundo', 2], ['mundo', 0], ['mundo', 5], ['oi ', 3], ['', 0]]) {
    for (const [marker, style] of Object.entries(styles)) {
      const { text, selection } = wrapSelection(src, { start: at, end: at }, marker)
      t.is(selection.start, selection.end)
      const typed = text.slice(0, selection.start) + 'segredo' + text.slice(selection.end)
      const spans = parseRich(typed).flatMap((b) => b.spans)
      t.alike(spans.filter((s) => s[style]).map((s) => s.text), ['segredo'], JSON.stringify([src, at, marker]))
    }
  }
  t.alike(wrapSelection('mundo', { start: 2, end: 2 }, '||'), { text: 'mu |||| ndo', selection: { start: 5, end: 5 } })
})

test('wrapping never changes where a link or mention points', async (t) => {
  const { wrapSelection } = await load()
  const { parseRich } = await loadRich()
  const { textSegments } = await import('../src/links.js')
  const targets = (text) => textSegments(text, { mentions: true }).filter((s) => s.href !== null || s.username !== null).map((s) => s.href || '@' + s.username)
  t.alike(wrapSelection('oi @ana', { start: 0, end: 7 }, '_'), { text: '_oi_ @ana', selection: { start: 1, end: 3 } }, 'the mention is left outside')
  t.alike(wrapSelection('https://a.com/x', { start: 0, end: 15 }, '*'), { text: 'https://a.com/x', selection: { start: 0, end: 15 } }, 'only a link: unchanged')
  t.alike(wrapSelection('veja https://a.com/x', { start: 0, end: 20 }, '*'), { text: '*veja* https://a.com/x', selection: { start: 1, end: 5 } })
  for (const marker of ['*', '**', '_', '__', '~', '||', '`']) {
    for (const [src, sel] of [['oi @ana', [0, 7]], ['https://a.com/x', [0, 15]], ['veja https://a.com/_x_ e @bia_c', [0, 31]], ['@ana fim', [0, 8]], ['https://a.com/', [14, 14]]]) {
      const out = wrapSelection(src, { start: sel[0], end: sel[1] }, marker)
      t.alike(targets(out.text), targets(src), marker + ' ' + JSON.stringify(src))
      t.ok(parseRich(out.text).length > 0)
    }
  }
})

test('a wrap the parser would not show leaves the text as it was', async (t) => {
  const { wrapSelection } = await load()
  const { parseRich } = await loadRich()
  const capped = '*a* '.repeat(64) + 'fim'
  t.alike(wrapSelection(capped, { start: 256, end: 259 }, '*'), { text: capped, selection: { start: 256, end: 259 } }, 'past the span cap')
  const out = wrapSelection(capped, { start: 256, end: 259 }, '||')
  t.is(out.text, '*a* '.repeat(64) + '||fim||', 'a spoiler is never capped')
  t.ok(parseRich(out.text)[0].spans.find((s) => s.text === 'fim').spoiler)
  const poisoned = 'oi \u200b mundo'
  t.alike(wrapSelection(poisoned, { start: 5, end: 10 }, '*'), { text: poisoned, selection: { start: 5, end: 10 } }, 'poisoned text shows no style')
  const hidden = wrapSelection(poisoned, { start: 5, end: 10 }, '||')
  t.is(hidden.text, 'oi \u200b ||mundo||', 'but a spoiler there is still hidden')
})
