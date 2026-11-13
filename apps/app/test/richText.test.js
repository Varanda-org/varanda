'use strict'

const test = require('brittle')
const load = () => import('../src/richText.js')
const loadLinks = () => import('../src/links.js')

const FLAGS = ['bold', 'italic', 'strike', 'code', 'spoiler']

// [text, 'bold,italic'] per span, plus 'atom' when the span is one.
function brief (blocks) {
  return blocks.map((b) => {
    if (b.kind === 'code') return { code: b.text, lang: b.lang }
    return b.spans.map((s) => [s.text, FLAGS.concat('atom').filter((k) => s[k]).join(',')])
  })
}

function isStyled (span) {
  return FLAGS.some((k) => span[k])
}

function styledCount (blocks) {
  let n = 0
  for (const b of blocks) if (b.kind === 'para') for (const s of b.spans) if (isStyled(s)) n++
  return n
}

test('every marker', async (t) => {
  const { parseRich } = await load()
  t.alike(brief(parseRich('*a* **b** _c_ __d__ ~e~ ||f|| `g`')), [[
    ['a', 'bold'], [' ', ''], ['b', 'bold'], [' ', ''], ['c', 'italic'], [' ', ''],
    ['d', 'italic'], [' ', ''], ['e', 'strike'], [' ', ''], ['f', 'spoiler'], [' ', ''], ['g', 'code']
  ]])
})

test('span shape', async (t) => {
  const { parseRich } = await load()
  t.alike(parseRich('*a*'), [{
    kind: 'para',
    spans: [{ text: 'a', bold: true, italic: false, strike: false, code: false, spoiler: false, atom: false, segment: null }]
  }])
})

test('nesting', async (t) => {
  const { parseRich } = await load()
  t.alike(brief(parseRich('*a _b_ c*')), [[['a ', 'bold'], ['b', 'bold,italic'], [' c', 'bold']]])
  t.alike(brief(parseRich('||*x* y||')), [[['x', 'bold,spoiler'], [' y', 'spoiler']]])
  t.alike(brief(parseRich('~_*x*_~')), [[['x', 'bold,italic,strike']]])
  t.alike(brief(parseRich('*a _b* c_')), [[['a _b', 'bold'], [' c_', '']]], 'an interleaved opener drops back to literal')
})

test('unclosed and odd markers stay literal', async (t) => {
  const { parseRich } = await load()
  for (const text of ['*a', 'a*', '||a', 'a||', '`a', '~a ~', '***a***', '|a|', '|||a|||', '``a``', '* a*', '*a *', '~~a~~']) {
    t.alike(brief(parseRich(text)), [[[text, '']]], JSON.stringify(text))
  }
})

test('emphasis needs a word boundary', async (t) => {
  const { parseRich } = await load()
  t.alike(brief(parseRich('snake_case_name 2*3*4')), [[['snake_case_name 2*3*4', '']]])
  t.alike(brief(parseRich('(*a*), "_b_".')), [[['(', ''], ['a', 'bold'], ['), "', ''], ['b', 'italic'], ['".', '']]])
  t.alike(brief(parseRich('*a*b')), [[['*a*b', '']]], 'a closer before a letter does not close')
  t.alike(brief(parseRich('a*b* x_y_ z')), [[['a*b* x_y_ z', '']]], 'an opener after a letter does not open')
})

test('nothing is parsed inside inline code', async (t) => {
  const { parseRich } = await load()
  t.alike(brief(parseRich('`*a* _b_`')), [[['*a* _b_', 'code']]])
  t.alike(brief(parseRich('*bold `code*` x*')), [[['bold ', 'bold'], ['code*', 'bold,code'], [' x', 'bold']]])
})

test('fenced code blocks', async (t) => {
  const { parseRich } = await load()
  t.alike(brief(parseRich('a\n```js\nconst x = *1*\n_y_\n```\nb')), [
    [['a', '']], { code: 'const x = *1*\n_y_', lang: 'js' }, [['b', '']]
  ])
  t.alike(brief(parseRich('```\n```')), [{ code: '', lang: null }])
  t.alike(brief(parseRich('```c++\nx\n```')), [{ code: 'x', lang: 'c++' }])
  t.alike(brief(parseRich('```\nunclosed *a*')), [[['```\nunclosed ', ''], ['a', 'bold']]], 'an unclosed fence stays literal')
  for (const fence of ['```JS', '```<script>', '``` js', '```js ', '```' + 'a'.repeat(17), ' ```']) {
    t.alike(brief(parseRich(fence + '\nx\n```')), [[[fence + '\nx\n```', '']]], JSON.stringify(fence))
  }
  t.alike(brief(parseRich('```' + 'a'.repeat(16) + '\nx\n```')), [{ code: 'x', lang: 'a'.repeat(16) }])
})

test('a URL with _ and * stays one atom with the same target', async (t) => {
  const { parseRich } = await load()
  const { textSegments } = await loadLinks()
  const text = 'veja https://a.com/_x_*y* e _z_'
  const link = textSegments(text, { mentions: true })[1]
  t.is(link.href, 'https://a.com/_x_*y*')
  const spans = parseRich(text)[0].spans
  t.alike(brief([{ kind: 'para', spans }]), [[['veja ', ''], ['https://a.com/_x_*y*', 'atom'], [' e ', ''], ['z', 'italic']]])
  t.alike(spans[1].segment, link, 'the textSegments entry is carried unchanged')
  t.is(spans[1].segment.href, 'https://a.com/_x_*y*')
})

test('a marker inside a link never closes one outside it', async (t) => {
  const { parseRich } = await load()
  const { textSegments } = await loadLinks()
  const text = '*(https://a.com/x)* y'
  const segments = textSegments(text, { mentions: true })
  t.is(segments[1].href, 'https://a.com/x)*')
  const spans = parseRich(text)[0].spans
  t.alike(brief([{ kind: 'para', spans }]), [[['*(', ''], ['https://a.com/x)*', 'atom'], [' y', '']]])
  t.alike(spans[1].segment, segments[1])
  t.alike(brief(parseRich('https://a.com/*x* fim *y*')), [[['https://a.com/*x*', 'atom'], [' fim ', ''], ['y', 'bold']]])
})

test('a style wraps a whole atom', async (t) => {
  const { parseRich } = await load()
  const spans = parseRich('*veja @ana_b_c*')[0].spans
  t.alike(brief([{ kind: 'para', spans }]), [[['veja ', 'bold'], ['@ana_b_c', 'bold,atom']]])
  t.is(spans[1].segment.username, 'ana_b_c')
  t.is(spans[1].segment.href, null)
})

test('a mention with underscores stays intact', async (t) => {
  const { parseRich } = await load()
  const spans = parseRich('oi @ana_b_c e _x_')[0].spans
  t.alike(brief([{ kind: 'para', spans }]), [[['oi ', ''], ['@ana_b_c', 'atom'], [' e ', ''], ['x', 'italic']]])
  t.alike(spans[1].segment, { text: '@ana_b_c', username: 'ana_b_c', href: null })
})

test('styled text is never scanned for links', async (t) => {
  const { parseRich } = await load()
  const { textSegments } = await loadLinks()
  t.alike(textSegments('_https://a.com_', { mentions: true }), [{ text: '_https://a.com_', username: null, href: null }])
  const spans = parseRich('_https://a.com_')[0].spans
  t.alike(spans, [{ text: 'https://a.com', bold: false, italic: true, strike: false, code: false, spoiler: false, atom: false, segment: null }])
  t.alike(brief(parseRich('`https://a.com`')), [[['https://a.com', 'code']]])
})

test('a link inside a fenced block is plain code', async (t) => {
  const { parseRich } = await load()
  t.alike(parseRich('```\nhttps://a.com\n```\nhttps://b.com').map((b) => b.kind === 'code' ? b.text : b.spans[0].segment.href), [
    'https://a.com', 'https://b.com'
  ])
})

test('poisoned text is one plain paragraph', async (t) => {
  const { parseRich } = await load()
  for (const text of ['a​ *b*', '\ud800 *b*', 'x\udc00 *b*', '‮*b*', '*a*⁦', 'a  *b*', '*a*\u0007']) {
    t.alike(brief(parseRich(text)), [[[text, '']]], JSON.stringify(text))
  }
  const spans = parseRich('https://a.com ​ *b*')[0].spans
  t.alike(brief([{ kind: 'para', spans }]), [[['https://a.com', 'atom'], [' ​ *b*', '']]], 'links stay as they are today')
})

test('U+FFFD and astral characters parse without breaking', async (t) => {
  const { parseRich } = await load()
  // displayText writes U+FFFD for a code point poisoned() refuses, so it takes the same plain path.
  t.alike(brief(parseRich('� *a* �')), [[['� *a* �', '']]])
  t.alike(brief(parseRich('😀*a*😀')), [[['😀', ''], ['a', 'bold'], ['😀', '']]])
})

test('hostile input never throws', async (t) => {
  const { parseRich, plainOf, hasRich } = await load()
  for (const v of [null, undefined, 42, {}, [], Symbol('x'), () => {}, '']) {
    t.alike(parseRich(v), [])
    t.is(plainOf(v), '')
    t.is(hasRich(v), false)
  }
  const { textSegments } = await loadLinks()
  let seed = 7
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed % n
  }
  const parts = ['*', '**', '_', '__', '~', '||', '|', '`', '```', '```js', '\n', ' ', 'a', 'é', '😀', '@ana_b', 'https://a.com/_x_', 'www.b.com*', '(', ')', '.']
  let atomsOk = true
  let coverOk = true
  for (let n = 0; n < 2000; n++) {
    let text = ''
    const len = 1 + rand(30)
    for (let i = 0; i < len; i++) text += parts[rand(parts.length)]
    const blocks = parseRich(text)
    const segments = textSegments(text, { mentions: true })
    for (const b of blocks) {
      if (b.kind !== 'para') continue
      for (const s of b.spans) {
        if (s.atom && !(s.segment.text === s.text && segments.some((g) => g.text === s.text && g.href === s.segment.href && g.username === s.segment.username))) atomsOk = false
        if (!s.atom && s.segment !== null) atomsOk = false
      }
    }
    if (blocks.reduce((n, b) => n + (b.kind === 'code' ? b.text.length : b.spans.reduce((m, s) => m + s.text.length, 0)), 0) > text.length) coverOk = false
  }
  t.ok(atomsOk, 'every atom is an unchanged textSegments entry')
  t.ok(coverOk, 'output is never longer than the input')
})

test('at most 64 styled spans, the rest plain', async (t) => {
  const { parseRich, SPAN_MAX } = await load()
  t.is(SPAN_MAX, 64)
  const blocks = parseRich('*a* '.repeat(100))
  t.is(styledCount(blocks), 64)
  const spans = blocks[0].spans
  t.is(spans.map((s) => s.text).join(''), 'a '.repeat(64) + '*a* '.repeat(36))
  t.alike(brief([{ kind: 'para', spans: [spans[spans.length - 1]] }]), [[[' ' + '*a* '.repeat(36), '']]])
  const across = parseRich('*a* '.repeat(40) + '\n```\nx\n```\n' + '_b_ '.repeat(40) + 'https://a.com')
  t.is(styledCount(across), 64, 'the cap counts across paragraphs')
  t.is(across[1].kind, 'code')
  const last = across[2].spans
  t.is(last[last.length - 1].segment.href, 'https://a.com', 'atoms stay atoms past the cap')
  t.ok(last[last.length - 2].text.endsWith('_b_ '), 'markers past the cap are literal')
})

test('5000 repeated markers parse in linear time', async (t) => {
  const { parseRich, plainOf } = await load()
  const shapes = [
    '*a* '.repeat(5000), '*a '.repeat(5000), 'a* '.repeat(5000), '||a '.repeat(5000), '`a'.repeat(5000),
    'a_'.repeat(5000), '```\n'.repeat(5000), '```js\n'.repeat(5000), '*'.repeat(5000), '*_~||'.repeat(5000),
    '_x '.repeat(2500) + 'x_ '.repeat(2500), '*_'.repeat(2500) + ' a' + '_*'.repeat(2500),
    'https://a.com/*_ *'.repeat(1000), '`` `a'.repeat(5000), '`a`b'.repeat(5000), ' ``a`` `b` '.repeat(2000),
    '````\n```\n'.repeat(2500), Array.from({ length: 150 }, (_, k) => '`'.repeat(3 + k) + 'js').join('\n')
  ]
  // Mostly textSegments time: its overlap check is quadratic in mentions.
  const mentions = '@a_b *'.repeat(5000)
  // One warm-up pass, so the bound measures the parser rather than the JIT.
  for (const text of shapes.concat(mentions)) plainOf(text, { clipped: true })
  const timed = (text) => {
    const t0 = Date.now()
    parseRich(text)
    return Date.now() - t0
  }
  const worst = Math.max(...shapes.map(timed))
  const mentionMs = timed(mentions)
  t.comment('slowest marker shape: ' + worst + ' ms, 5000 mentions with markers: ' + mentionMs + ' ms')
  // Generous bounds: the target is under 50 ms, but the suite runs under load.
  t.ok(mentionMs < 500, '5000 mentions took ' + mentionMs + ' ms')
  t.ok(worst < 250, 'slowest shape took ' + worst + ' ms')
})

test('hasRich', async (t) => {
  const { hasRich } = await load()
  for (const c of ['*', '_', '~', '|', '`']) t.ok(hasRich('a' + c), c)
  t.absent(hasRich('texto comum, sem nada'))
})

test('plainOf', async (t) => {
  const { plainOf } = await load()
  t.is(plainOf('*a* _b_ ~c~ `d` ||segredo|| fim'), 'a b c d spoiler fim')
  t.is(plainOf('||veja https://a.com e *x*||!'), 'spoiler!', 'one word for a spoiler split by atoms and styles')
  t.is(plainOf('a\n```js\nl1\nl2\n```\nb'), 'a\nl1\nb')
  t.is(plainOf('sem nada'), 'sem nada')
  t.is(plainOf('abc ||segr'), 'abc ||segr', 'unclosed stays literal when not clipped')
  t.is(plainOf('*abc* ||segr'), 'abc ||segr')
  t.is(plainOf('*abc* ||segr', { clipped: true }), 'abc spoiler')
  t.is(plainOf('a ||b|| c ||d e', { clipped: true }), 'a spoiler', 'a clipped text shows nothing after its first ||')
  t.is(plainOf('a\nb ||c\nd\n```\nx\n```', { clipped: true }), 'a\nb spoiler', 'the tail hides later blocks too')
  t.is(plainOf('a || b'), 'a || b', 'a || that cannot open hides nothing')
  t.is(plainOf('a || b', { clipped: true }), 'a spoiler', 'clipped, even that || ends the preview')
  t.absent(plainOf('||s|| '.repeat(100)).includes('s '), 'no cap: every spoiler stays hidden')
  t.is(plainOf('https://a.com/_x_ _y_'), 'https://a.com/_x_ y')
})

test('plainOf hides spoilers in text it cannot parse', async (t) => {
  const { plainOf } = await load()
  t.is(plainOf('||segredo 👩\u200d', { clipped: true }), 'spoiler', 'a clip inside an emoji sequence')
  t.is(plainOf('a ||segredo|| \u200b'), 'a spoiler', 'poisoned text hides from its first ||')
  t.is(plainOf('a \u200b *b*'), 'a \u200b *b*', 'with no || it stays as it is')
})

test('the span cap never uncovers a spoiler', async (t) => {
  const { parseRich } = await load()
  const hidden = (text) => {
    const spans = parseRich(text).flatMap((b) => b.spans)
    const secret = spans.filter((s) => s.text.includes('secret'))
    return secret.length > 0 && secret.every((s) => s.spoiler) && !spans.some((s) => s.text.includes('||'))
  }
  t.ok(hidden('*a* '.repeat(64) + '||secret||'), 'a spoiler after the cap')
  t.ok(hidden('||' + '*a* '.repeat(65) + 'secret||'), 'a spoiler holding more than the cap')
  t.ok(hidden('*a* '.repeat(65) + '||secret||'), 'a spoiler in the raw tail')
  const spans = parseRich('*a* '.repeat(65) + '||secret||')[0].spans
  t.alike(spans.slice(-2).map((s) => [s.text, s.bold, s.spoiler]), [[' *a* ', false, false], ['secret', false, true]], 'other styles past the cap stay raw')
})

test('a longer backtick run leaves later inline code working', async (t) => {
  const { parseRich } = await load()
  t.alike(brief(parseRich('``literal`` and `*value*`')), [[['``literal`` and ', ''], ['*value*', 'code']]])
  t.alike(brief(parseRich('``` x `||x||`')), [[['``` x ', ''], ['||x||', 'code']]])
})

test('inline code needs a boundary outside its ticks', async (t) => {
  const { parseRich, plainOf } = await load()
  for (const text of ['https://safe.com`@evil.com`', 'https://a.com`/evil`']) {
    t.absent(parseRich(text)[0].spans.some((s) => s.code), JSON.stringify(text))
    t.is(plainOf(text), text, 'plainOf keeps the ticks of ' + JSON.stringify(text))
  }
  t.alike(brief(parseRich('a`b` c')), [[['a`b` c', '']]], 'after a letter')
  t.alike(brief(parseRich('x `b`c')), [[['x `b`c', '']]], 'before a letter')
  t.alike(brief(parseRich('x `@ana`@bia')), [[['x `', ''], ['@ana', 'atom'], ['`', ''], ['@bia', 'atom']]], 'before a mention')
  t.alike(brief(parseRich('(`b`).')), [[['(', ''], ['b', 'code'], [').', '']]], 'punctuation is a boundary')
})

test('a longer fence holds a line of three backticks', async (t) => {
  const { parseRich } = await load()
  t.alike(brief(parseRich('````\n```\n*x*\n````')), [{ code: '```\n*x*', lang: null }])
  t.alike(brief(parseRich('````js\na\n```\n````\nb')), [{ code: 'a\n```', lang: 'js' }, [['b', '']]])
  t.alike(brief(parseRich('```\n````\n```')), [{ code: '````', lang: null }], 'a fence closes only on its own length')
  t.alike(brief(parseRich('````\nx\n```')), [[['````\nx\n```', '']]], 'a shorter closer does not close')
})

test('a spoiler in poisoned text is still hidden', async (t) => {
  const { parseRich, plainOf } = await load()
  for (const bad of ['\u200b', '\u202e', '\u2066']) {
    const text = 'oi ' + bad + ' ||segredo|| fim'
    const spans = parseRich(text)[0].spans
    t.alike(brief([{ kind: 'para', spans }]), [[['oi ' + bad + ' ', ''], ['||segredo|| fim', 'spoiler']]], JSON.stringify(bad))
    t.is(plainOf(text), 'oi ' + bad + ' spoiler', 'plainOf hides the same range')
  }
  const spans = parseRich('veja https://a.com/ ||s|| \u200b @ana fim')[0].spans
  t.alike(brief([{ kind: 'para', spans }]), [[
    ['veja ', ''], ['https://a.com/', 'atom'], [' ', ''], ['||s|| \u200b ', 'spoiler'], ['@ana', 'spoiler,atom'], [' fim', 'spoiler']
  ]], 'a segment crossing the || splits there and later atoms stay atoms')
  t.is(spans[1].segment.href, 'https://a.com/')
  t.is(spans[4].segment.username, 'ana')
  t.alike(brief(parseRich('a || b \u200b *c*')), [[['a || b \u200b *c*', '']]], 'a || that cannot open hides nothing')
  t.alike(brief(parseRich('a \u200b ||')), [[['a \u200b ||', '']]], 'nor does a || at the very end')
})

test('a clipped text never closes against its cut end', async (t) => {
  const { plainOf } = await load()
  t.is(plainOf('`a ||segredo|| b`c'), '`a spoiler b`c', 'the whole text keeps the spoiler hidden')
  t.is(plainOf('`a ||segredo|| b`', { clipped: true }), '`a spoiler', 'nothing after the first || shows, whatever follows the cut')
  t.is(plainOf('```\n||segredo||\n```js'), '```\nspoiler\n```js')
  t.is(plainOf('```\n||segredo||\n```', { clipped: true }), 'spoiler', 'the last line does not close a fence')
  t.is(plainOf('```\nx\n```\nfim', { clipped: true }), 'x\nfim', 'an earlier line still closes')
  t.is(plainOf('*a* ||b', { clipped: true }), 'a spoiler')
  t.is(plainOf('*a*', { clipped: true }), '*a*', 'a style does not close at the cut')
  t.is(plainOf('`a ||segredo|| b`'), 'a ||segredo|| b', 'not clipped, the end still closes')
})

test('no prefix of a text uncovers a spoiler the whole text hides', async (t) => {
  const { plainOf } = await load()
  // Q appears only inside the spoiler, so any Q in a preview is a leak.
  const fulls = [
    '`a ||Q|| b`c', '```\n||Q||\n```js', 'x `y` ||Q|| `z` w', '`a` ||Q||`b`', '||Q|| `',
    '*a _b ||Q|| c_ d*', '||*Q* _x_||', '~||Q||~ **||Q||**', '_a ||Q||_b', 'a\n||Q\nb||',
    '````\nx\n```\n||Q||\n````js', '````\n```\n||Q||', '```\nx\n```\n||Q||', '```js\na\n```\n`||Q||`b',
    'https://a.com/x ||Q|| @ana_b *y*', '||@ana Q https://a.com||', '*https://a.com* ||Q|| @ana',
    '||Q \ud83d\udc69\u200d\ud83d\udcbb|| \ud83d\udc4d\ud83c\udffd a', '\ud83d\udc69\u200d\ud83d\udcbb||Q||', '1\ufe0f\u20e3 ||Q|| \ud83c\udff3\ufe0f\u200d\ud83c\udf08',
    '```js\nconst a = 1\n||Q||\nconst b = 2\n```\nfim', '```js\nconst a = ||x||\nb = `||Q||`\n```',
    '||a\n```\nQ||', 'x ||a ||b\n```\nQ|| c', '```\n||Q|| a\nb', '```js\n' + 'linha\n'.repeat(30) + '||Q||\n```',
    // Inline code holding || inside a spoiler: a cut inside the code, at its
    // closing tick or past a fence-like line leaves the opener literal.
    '||a `b||"Q"` c||', '||a `(b)||(Q)` c||', '||a `(b)||(c)\n```\nQ` Q|| z',
    '||o resultado do jogo foi 3 a 1 e a senha do wifi novo e `const senha = lida||"Qvaranda-2026-casa-da-vo-maria-rua-das-flores-numero-quarenta-e-dois-fundos"` pronto||',
    // The code point the whole text is poisoned by sits after the cut.
    'oi||Q ' + 'lorem '.repeat(30) + '\u200b fim',
    // A cut at a mention after inline code holding || changes how its closing tick reads.
    '`||Q||`@abcdefgh', '`||Q||`@ana_b fim'
  ]
  let checked = 0
  let slowest = 0
  for (const full of fulls) {
    t.absent(plainOf(full).includes('Q'), 'the whole text hides it: ' + JSON.stringify(full))
    const cps = Array.from(full)
    const t0 = Date.now()
    let prefix = ''
    const leaks = []
    for (const cp of cps) {
      prefix += cp
      if (plainOf(prefix, { clipped: true }).includes('Q')) leaks.push(prefix)
      checked++
    }
    slowest = Math.max(slowest, Date.now() - t0)
    t.alike(leaks, [], JSON.stringify(full))
  }
  t.ok(checked > 200, checked + ' prefixes')
  t.ok(slowest < 1000, 'slowest text took ' + slowest + ' ms')
})

test('a clipped preview drops the fence line of a cut code block', async (t) => {
  const { plainOf } = await load()
  const cut = '```js\nconst linha1 = 1\nconst linha2 = 2\nc'
  t.is(plainOf(cut, { clipped: true }), 'const linha1 = 1')
  t.is(plainOf('a\n```js\nx ||segredo|| y\nz', { clipped: true }), 'a\nx spoiler', 'its line hides from the first ||')
  t.is(plainOf('```js', { clipped: true }), '', 'a fence with nothing after it')
  t.is(plainOf(cut), cut, 'not clipped, an unclosed fence stays literal')
})

test('a quote of display-cleaned text hides what the bubble hides', async (t) => {
  const { parseRich, plainOf } = await load()
  const { displayText } = require('@varanda/rpc')
  const { threadOf } = await import('../src/dm.js')
  const shown = (blocks) => blocks.map((b) => b.kind === 'code' ? b.text : b.spans.filter((s) => !s.spoiler).map((s) => s.text).join('')).join('\n')
  for (const [raw, secret] of [['oi||segredo \u200f fim', 'segredo'], ['\u200e `||SECRET||`', 'SECRET']]) {
    t.absent(shown(parseRich(raw)).includes(secret), 'the bubble hides it: ' + JSON.stringify(raw))
    const cleaned = displayText(raw, { multiline: true })
    t.ok(cleaned.includes('\ufffd'), 'displayText marks the code point')
    t.absent(shown(parseRich(cleaned)).includes(secret), 'parseRich of the cleaned text hides it')
    t.absent(plainOf(cleaned).includes(secret), 'plainOf of the cleaned text hides it')
    const thread = threadOf([
      { id: 'm1', at: '2026-05-01T00:00:00.000Z', text: raw, replyTo: null },
      { id: 'm2', at: '2026-05-02T00:00:00.000Z', text: 'resposta', replyTo: 'm1' }
    ])
    const quote = thread.find((m) => m.id === 'm2').replyTo
    t.is(typeof quote, 'string')
    t.absent(plainOf(quote).includes(secret), 'the reply quote hides it')
  }
  t.alike(brief(parseRich('oi *a* ||b||')), [[['oi ', ''], ['a', 'bold'], [' ', ''], ['b', 'spoiler']]], 'without U+FFFD the text still formats')
  t.is(plainOf('oi *a* ||b||'), 'oi a spoiler')
})

test('one message draws at most CODE_MAX code blocks', async (t) => {
  const { parseRich, plainOf, CODE_MAX } = await load()
  t.is(CODE_MAX, 8)
  const codes = (blocks) => blocks.filter((b) => b.kind === 'code').length
  const many = '```\n```\n'.repeat(125)
  t.is(Array.from(many).length, 1000)
  const blocks = parseRich(many)
  t.is(codes(blocks), CODE_MAX, 'the 125-block message stops at the cap')
  t.ok(blocks.length <= CODE_MAX + 1, blocks.length + ' blocks')
  const at = Array.from({ length: CODE_MAX }, (_, i) => '```\nx' + i + '\n```').join('\n')
  t.alike(brief(parseRich(at)), Array.from({ length: CODE_MAX }, (_, i) => ({ code: 'x' + i, lang: null })), 'a message at the cap draws every block')
  const past = at + '\nfim *a*\n```\n||Q||\n```\n||R|| e ||S||'
  const out = parseRich(past)
  t.is(codes(out), CODE_MAX)
  const tail = out[out.length - 1]
  t.is(tail.kind, 'para')
  t.alike(brief([out[out.length - 2]]), [[['fim ', ''], ['a', 'bold']]], 'the paragraph before the next block still formats')
  t.alike(brief([tail]), [[['```\n', ''], ['||Q||\n```\n||R|| e ||S||', 'spoiler']]], 'from the next block on the text is plain, hidden from its first ||')
  t.absent(plainOf(past).includes('R'), 'plainOf still hides the spoilers past the cap')
})

test('plainOf hides what the bubble hides past CODE_MAX', async (t) => {
  const { parseRich, plainOf } = await load()
  const text = '```\n```\n'.repeat(8) + '```\n||Q||\n```\nR ||S|| fim'
  const covered = parseRich(text).flatMap((b) => b.kind === 'code' ? [] : b.spans.filter((s) => s.spoiler).map((s) => s.text)).join('')
  t.ok(covered.includes('Q') && covered.includes('S'), 'the bubble covers them')
  for (const opts of [{}, { full: true }]) {
    const out = plainOf(text, opts)
    t.absent(/[QRS]/.test(out), JSON.stringify(opts) + ' ' + JSON.stringify(out))
    t.ok(out.endsWith('```\nspoiler'), 'the tail reads up to its first || and then spoiler')
  }
})

test('plainOf full keeps every line of a code block', async (t) => {
  const { plainOf } = await load()
  const text = 'veja\n```js\nl1\nl2 ||x||\nl3\n```\n||s|| fim'
  t.is(plainOf(text), 'veja\nl1\nspoiler fim')
  t.is(plainOf(text, { full: true }), 'veja\nl1\nl2 ||x||\nl3\nspoiler fim', 'the code shows as the bubble shows it, the spoiler stays covered')
  t.is(plainOf('a \u200b ||s||', { full: true }), 'a \u200b spoiler', 'poisoned text keeps the fallback')
})

test('a clipped preview closes styles at its first || and keeps a line break before it', async (t) => {
  const { plainOf } = await load()
  t.is(plainOf('*título*||segredo||' + ' x'.repeat(80), { clipped: true }), 'títulospoiler', 'a closer flush against || closes')
  t.is(plainOf('`código`||segredo||', { clipped: true }), 'códigospoiler')
  t.is(plainOf('*aberto ||segredo||', { clipped: true }), '*aberto spoiler', 'an opener with no closer stays literal')
  t.is(plainOf('*abc', { clipped: true }), '*abc', 'without || the cut end still closes nothing')
  t.is(plainOf('```\nx\n```\n||Q||', { clipped: true }), 'x\nspoiler', 'a || on the line after a fence starts its own line')
  t.is(plainOf('a\n||Q||', { clipped: true }), 'a\nspoiler')
  t.is(plainOf('||Q||', { clipped: true }), 'spoiler')
})
