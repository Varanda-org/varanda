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

test('taking formatting off removes only a pair the button would add', async (t) => {
  const { wrapSelection } = await load()
  const same = (text, start, end, marker, message) => t.alike(wrapSelection(text, { start, end }, marker), { text, selection: { start, end } }, message)
  same('@ana_b_c', 5, 6, '_', 'underscores inside a mention are not a pair')
  same('a_b_c', 2, 3, '_', 'underscores inside a word are not a pair')
  same('2*3*4', 2, 3, '*', 'asterisks between digits are not a pair')
  same('veja https://a.com/_x_ ok', 16, 17, '_', 'markers inside a link keep its address')
  t.alike(wrapSelection('oi _mundo_ bom', { start: 4, end: 9 }, '_'), { text: 'oi mundo bom', selection: { start: 3, end: 8 } }, 'a real pair still comes off')
  t.alike(wrapSelection('oi _mundo_ bom', { start: 3, end: 10 }, '_'), { text: 'oi mundo bom', selection: { start: 3, end: 8 } }, 'also with the markers inside the selection')
  t.alike(wrapSelection('a _b_ c_d', { start: 3, end: 4 }, '_'), { text: 'a b c_d', selection: { start: 2, end: 3 } }, 'and a stray underscore elsewhere stays')
})

test('a second Bloco de código takes the fences off instead of nesting', async (t) => {
  const { insertCodeBlock } = await load()
  const { parseRich } = await loadRich()
  const shape = (text) => parseRich(text).map((b) => b.kind === 'code' ? ['code', b.text] : ['para', b.spans.map((s) => s.text).join('')])
  const src = 'veja \n```\nx = 1\n```\n ok'
  t.alike(insertCodeBlock(src, { start: 10, end: 15 }), { text: 'veja \nx = 1\n ok', selection: { start: 6, end: 11 } }, 'a selection inside the block')
  t.alike(insertCodeBlock(src, { start: 12, end: 12 }), { text: 'veja \nx = 1\n ok', selection: { start: 8, end: 8 } }, 'a caret inside the block')
  t.alike(insertCodeBlock(src, { start: 6, end: 19 }), { text: 'veja \nx = 1\n ok', selection: { start: 6, end: 11 } }, 'the block selected whole')
  t.alike(insertCodeBlock('```\n\n```', { start: 4, end: 4 }), { text: '', selection: { start: 0, end: 0 } }, 'the empty block the button adds')
  const once = insertCodeBlock('veja x = 1 ok', { start: 5, end: 10 })
  const twice = insertCodeBlock(once.text, once.selection)
  t.alike(shape(once.text).filter((b) => b[0] === 'code'), [['code', 'x = 1']])
  t.alike(twice.text, 'veja \nx = 1\n ok', 'the second press undoes the first')
  t.absent(shape(twice.text).some((b) => b[0] === 'code'))
  const partial = 'a\n```\nb\n```\nc'
  t.alike(insertCodeBlock(partial, { start: 0, end: 8 }), { text: partial, selection: { start: 0, end: 8 } }, 'a selection ending inside a block is left alone')
  t.alike(insertCodeBlock(partial, { start: 6, end: 13 }), { text: partial, selection: { start: 6, end: 13 } }, 'and one starting inside it')
  const around = insertCodeBlock(partial, { start: 0, end: partial.length })
  t.alike(shape(around.text), [['code', partial]], 'a selection around a block is wrapped by a longer fence')
})

test('insertCodeBlock never splits a mention or a link, and unfencing keeps where they point', async (t) => {
  const { insertCodeBlock } = await load()
  const { textSegments } = await import('../src/links.js')
  const dests = (text) => textSegments(text, { mentions: true }).filter((s) => typeof s.href === 'string' || typeof s.username === 'string').map((s) => s.href || '@' + s.username)
  const unchanged = (text, start, end, why) => t.alike(insertCodeBlock(text, { start, end }), { text, selection: { start, end } }, why)
  unchanged('oi @ana_b fim', 6, 6, 'a caret inside a mention')
  unchanged('oi @ana_b fim', 5, 8, 'a selection inside a mention')
  unchanged('veja https://exemplo.com/a/b ok', 15, 15, 'a caret inside a URL')
  unchanged('veja https://exemplo.com/a/b ok', 12, 20, 'a selection inside a URL')
  const mention = 'oi @ana_b fim'
  const whole = insertCodeBlock(mention, { start: 3, end: 9 })
  t.is(whole.text, 'oi \n```\n@ana_b\n```\n fim', 'a whole mention still goes into a block')
  t.alike(dests(whole.text), dests(mention), 'and points where it did')
  const url = 'veja https://exemplo.com/a ok'
  const around = insertCodeBlock(url, { start: 5, end: 5 + 'https://exemplo.com/a'.length })
  t.alike(dests(around.text), dests(url), 'a whole URL keeps its address')
  const withLinks = 'oi @ana_b veja https://exemplo.com/a\n```\nx = 1\n```\n fim'
  const open = withLinks.indexOf('x = 1')
  const un = insertCodeBlock(withLinks, { start: open, end: open + 5 })
  t.is(un.text, 'oi @ana_b veja https://exemplo.com/a\nx = 1\n fim', 'a block comes off')
  t.alike(dests(un.text), dests(withLinks), 'the mention and the link outside it point where they did')
  t.alike(insertCodeBlock('veja x = 1 ok', { start: 5, end: 10 }).text, 'veja \n```\nx = 1\n```\n ok', 'the ordinary case still fences')
})

test('a fence left open earlier does not split the new block', async (t) => {
  const { insertCodeBlock } = await load()
  const { parseRich } = await loadRich()
  const out = insertCodeBlock('```\nfoo\n', { start: 4, end: 7 })
  const blocks = parseRich(out.text).filter((b) => b.kind === 'code')
  t.alike(blocks.map((b) => b.text), ['foo'])
  t.is(out.text.slice(out.selection.start, out.selection.end), 'foo')
  const lang = insertCodeBlock('```js\nfoo bar\n', { start: 6, end: 9 })
  t.alike(parseRich(lang.text).filter((b) => b.kind === 'code').map((b) => b.text), ['foo'])
})

test('codeBlocks finds the blocks the parser reads', async (t) => {
  const { codeBlocks } = await load()
  const { parseRich } = await loadRich()
  for (const src of [
    'a\n```js\nx\n```\nb', '```\n```', '```\n\n```', '````\n```\n````', '```\nfoo\n', '```js\n```js\n```\n```js\n``` ',
    'x ```\ny\n```', '```c\nint\n```\n```\nok\n```\nfim', '```toolongalangname\nx\n```'
  ]) {
    t.alike(codeBlocks(src).map((b) => src.slice(b.bodyStart, b.bodyEnd)), parseRich(src).filter((b) => b.kind === 'code').map((b) => b.text), JSON.stringify(src))
  }
})

test('the letters of a fence lang are not text, and markers alone in code show no style', async (t) => {
  const { wrapSelection } = await load()
  t.alike(wrapSelection('```js\n```\njs', { start: 10, end: 12 }, '*'), { text: '```js\n```\n*js*', selection: { start: 11, end: 13 } }, 'a wrap after a block with a lang')
  t.alike(wrapSelection('```js\n```\nsjs ', { start: 10, end: 13 }, '_'), { text: '```js\n```\n_sjs_ ', selection: { start: 11, end: 14 } })
  const same = (text, start, end, marker, message) => t.alike(wrapSelection(text, { start, end }, marker), { text, selection: { start, end } }, message)
  same('```\n**\n```', 4, 6, '_', 'italic over markers in a block')
  same('`**`', 1, 3, '_', 'italic over markers in inline code')
  same('```\nfoo\n```', 4, 7, '`', 'no marker formats inside a block')
})

test('a caret inside code gets no markers, and one beside it still does', async (t) => {
  const { wrapSelection, insertCodeBlock } = await load()
  const same = (text, at, marker, message) => t.alike(wrapSelection(text, { start: at, end: at }, marker), { text, selection: { start: at, end: at } }, message)
  same('`ab`', 2, '*', 'inline code')
  same('`ab`', 1, '_', 'just inside the opening tick')
  same('`ab`', 2, '`', 'a tick inside inline code')
  same('```\nabc\n```', 5, '_', 'a block')
  same('```js\nabc\n```', 8, '*', 'a block with a lang')
  t.alike(wrapSelection('```\nx\n```\n', { start: 10, end: 10 }, '*'), { text: '```\nx\n```\n**', selection: { start: 11, end: 11 } }, 'after a block')
  t.alike(wrapSelection('`ab` ', { start: 5, end: 5 }, '*'), { text: '`ab` **', selection: { start: 6, end: 6 } }, 'after inline code')
  t.alike(insertCodeBlock('`ab`', { start: 2, end: 2 }), { text: '`ab`', selection: { start: 2, end: 2 } }, 'a block would split inline code')
  t.alike(insertCodeBlock('x `a b` y', { start: 0, end: 5 }), { text: 'x `a b` y', selection: { start: 0, end: 5 } }, 'a selection ending inside inline code')
})

test('pasteCaret keeps the caret at the copy nearest the stored selection when the draft repeats', async (t) => {
  const { pasteCaret } = await load()
  t.is(pasteCaret('abab', 'ababab', { start: 0, end: 0 }), 2, 'inserted at the start')
  t.is(pasteCaret('abab', 'ababab', { start: 2, end: 2 }), 4, 'inserted in the middle')
  t.is(pasteCaret('abab', 'ababab', { start: 4, end: 4 }), 6, 'inserted at the end')
  t.is(pasteCaret('abab', 'ababab', null), 6, 'no selection: the last copy')
  t.is(pasteCaret('abab', 'ababab', { start: 99, end: 99 }), 6, 'an out of range selection is no evidence')
  t.is(pasteCaret('hello', 'hello\txo', { start: 1, end: 1 }), 8, 'a selection outside the candidates keeps the old answer')
  t.is(pasteCaret('abXab', 'abXZab', { start: 0, end: 0 }), 4, 'one place only: the selection cannot move it')
  t.is(pasteCaret('abc', 'ax', null), 2, 'a replacement falls back to the common ends')
})
