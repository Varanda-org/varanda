// Source pins for the chat's rich text view: RichText.js and Bubble.js import
// React Native, so they are read as text here. The parser itself is covered
// by richText.test.js.
'use strict'

const test = require('brittle')
const { readFileSync } = require('fs')
const { join } = require('path')

const ui = (name) => readFileSync(join(__dirname, '../src/ui', name), 'utf8')

// String literals are kept whole, so a '//' inside a URL never hides the
// rest of its line.
function withoutComments (src) {
  return src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')
}

// The open tags (Text, View, Pressable, ScrollView) still unclosed at `at`,
// counted from `from`.
function openTags (src, from, at) {
  const stack = []
  for (const match of src.slice(from, at).matchAll(/<(\/)?(Text|View|Pressable|ScrollView)\b([^>]*?)>/g)) {
    if (match[1]) stack.pop()
    else if (!match[3].endsWith('/')) stack.push(match[2])
  }
  return stack
}

test('Bubble draws styled text through RichText and keeps the plain path', (t) => {
  const bubble = ui('Bubble.js')
  t.ok(bubble.includes("import { hasRich, parseRich } from '../richText'"), 'the parser test comes from the pure module')
  t.ok(bubble.includes("import { RichText, cardBesideSpoilers } from './RichText'"))
  t.ok(bubble.includes('const styled = rich && !empty && hasRich(item.rawText)'), 'only raw text with markers takes the rich path')
  t.ok(bubble.includes('{styled\n                ? <RichText text={item.rawText} onOpenMention={onOpenMention} onLongPress={rows.length > 0 ? () => setOpen(true) : undefined} style={styles.text} trailer={spacer} blocks={blocks} />'), 'RichText gets the raw text, its parse, the long press and the time spacer')
  t.ok(bubble.includes('<MentionText text={item.rawText} onOpenMention={onOpenMention} onLongPress={rows.length > 0 ? () => setOpen(true) : undefined} style={styles.text} />'), 'the plain path still draws MentionText')
  t.ok(bubble.includes('<Text style={styles.text}>\n                    {body}\n                    {spacer}\n                  </Text>'), 'the plain path keeps the time spacer in the same Text')
  t.is(bubble.split('<RichText').length - 1, 1, 'one RichText')
})

test('Bubble places RichText outside any Text, so its code blocks are Views beside the paragraphs', (t) => {
  const bubble = withoutComments(ui('Bubble.js'))
  const start = bubble.indexOf('<Pressable')
  const at = bubble.indexOf('<RichText')
  t.ok(start > 0 && at > start, 'bubble and RichText found')
  t.alike(openTags(bubble, start, at), ['Pressable'], 'RichText is a direct child of the bubble Pressable')
  const rich = withoutComments(ui('RichText.js'))
  t.ok(rich.includes("block.kind === 'code'\n    ? <CodeBlock key={b}"), 'a code block is its own element in the block list')
  t.ok(rich.includes(': <Text key={b} style={style}>{spansOf(block.spans)}{b === blocks.length - 1 ? trailer : null}</Text>)'), 'paragraphs are Texts, the last one carries the trailer')
  const code = rich.slice(rich.indexOf('function CodeBlock'), rich.indexOf('export function RichText'))
  t.ok(code.includes('return (\n    <View style={styles.codeBox}>'), 'a code block is a View')
  t.ok(code.includes('<ScrollView horizontal'), 'long lines scroll sideways')
  t.ok(rich.includes('export const CODE_LINES = 12') && code.includes('lines.slice(0, CODE_LINES)'), 'twelve lines until ver tudo')
  t.ok(code.includes('copyText(shareNav(), shown)'), 'Copiar código copies what is shown')
  t.ok(code.includes('pending = false') && code.includes('() => done(n, false)'), 'a failed copy is reported, never thrown')
})

test('RichText draws atoms through SegmentSpan and never re-reads span text', (t) => {
  const rich = withoutComments(ui('RichText.js'))
  t.ok(rich.includes("import { SegmentSpan } from './MentionText'"))
  t.ok(rich.includes('<SegmentSpan key={key} segment={span.segment} onOpenMention={onOpenMention} onLongPress={onLongPress} />'), 'an atom is the parser segment, drawn as MentionText draws it')
  for (const word of ['textSegments', 'findLinks', 'findMentions', 'MentionText ', '<MentionText', 'hasMention', 'linkProps', 'isHttpUrl']) {
    t.absent(rich.includes(word), 'RichText.js has no ' + word)
  }
  t.ok(rich.includes('{displayText(span.text, { multiline: true })}'), 'plain spans are escaped text')
  t.absent(rich.includes('Platform'), 'no platform branch')
})

test('MentionText draws each segment with SegmentSpan', (t) => {
  const mention = withoutComments(ui('MentionText.js'))
  t.ok(mention.includes('export function SegmentSpan ({ segment, onOpenMention, onOpenPlain, onLongPress, links = true })'))
  t.ok(mention.includes('{segments.map((segment, i) => <SegmentSpan key={i} segment={segment} onOpenMention={onOpenMention} onOpenPlain={plain} onLongPress={onLongPress} links={links} />)}'), 'MentionText hands its own segments over')
  const span = mention.slice(mention.indexOf('export function SegmentSpan'))
  t.ok(span.includes("segment.username !== null && typeof onOpenMention === 'function'"), 'a mention is tappable only with a handler')
  t.ok(span.includes('if (!links || segment.href === null || !isHttpUrl(segment.href))'), 'a link opens only when checked and unclamped')
  t.absent(span.includes('textSegments'), 'SegmentSpan never segments again')
})

test('the spoiler is a covered button with its own label', (t) => {
  const rich = ui('RichText.js')
  t.ok(rich.includes("export const SPOILER_LABEL = 'spoiler, toque para mostrar'"))
  t.ok(rich.includes("export const COPY_CODE_LABEL = 'Copiar código'"))
  t.ok(rich.includes("export const SHOW_ALL_LABEL = 'ver tudo'"))
  const code = withoutComments(rich)
  t.ok(code.includes("accessibilityRole='button'\n            accessibilityLabel={SPOILER_LABEL}\n            onPress={reveal}"), 'the covered span is a labelled button that reveals')
  t.ok(code.includes('{cover(hidden)}'), 'covered text is replaced, so a screen reader cannot read it')
  t.ok(rich.includes("for (const ch of text) out += ch === '\\n' ? '\\n' : /\\s/.test(ch) ? ' ' : '\\u2007'"), 'every non-space character is covered')
  t.ok(code.includes('spoiler: { color: colors.ink, backgroundColor: colors.ink }'), 'the cover uses theme tokens')
})

test('no read, delivery or typing words and no em dash in the rich view files', (t) => {
  for (const name of ['Bubble.js', 'RichText.js', 'MentionText.js']) {
    const src = ui(name)
    t.absent(src.includes('\u2014'), name)
  }
  const bubble = ui('Bubble.js')
  for (const word of ['lida', 'entregue', 'digitando']) t.absent(bubble.includes(word), 'Bubble.js: ' + word)
})

// A pure function of a ui file, cut out of its source and built on its own,
// since the file itself imports React Native.
function fnOf (src, name) {
  const start = src.indexOf('function ' + name + ' (')
  const end = src.indexOf('\n}\n', start)
  if (start === -1 || end === -1) throw new Error(name + ' not found')
  return new Function('return ' + src.slice(start, end + 2))() // eslint-disable-line no-new-func
}

const NO_STYLE = { bold: false, italic: false, strike: false, code: false }
const plainSpan = (text, spoiler) => ({ text, ...NO_STYLE, spoiler, atom: false, segment: null })
const linkSpan = (href, spoiler) => ({ text: href, ...NO_STYLE, spoiler, atom: true, segment: { text: href, username: null, href } })

test('a link card is not drawn for a link hidden in a spoiler', async (t) => {
  const cardBesideSpoilers = fnOf(ui('RichText.js'), 'cardBesideSpoilers')
  const url = 'https://example.com/final'
  const card = { url, host: 'example.com', title: 'Final' }
  const para = (...spans) => ({ kind: 'para', spans })
  t.is(cardBesideSpoilers(null, card), card, 'plain path: the stored card')
  t.is(cardBesideSpoilers([para(plainSpan('veja ', false), linkSpan(url, false))], card), card, 'no spoiler: the stored card')
  t.is(cardBesideSpoilers([para(plainSpan('veja ', true), linkSpan(url, true), plainSpan(' aqui', true))], card), null, 'the link only inside a spoiler: no card')
  t.is(cardBesideSpoilers([para(linkSpan('https://example.com/other', false), plainSpan('x', true))], card), null, 'a spoiler and another visible link: no card')
  t.is(cardBesideSpoilers([para(plainSpan('x', true)), { kind: 'code', text: url, lang: '' }, para(linkSpan(url, false))], card), card, 'the card link drawn outside the spoiler: the card stays')
  t.is(cardBesideSpoilers([para(linkSpan(url, false), plainSpan('x', true))], { title: 'sem url' }), null, 'a card without a url beside a spoiler: no card')
  t.is(cardBesideSpoilers([para(plainSpan('', true))], card), null, 'an empty trailing spoiler still counts')
  t.is(cardBesideSpoilers([para(plainSpan('x', true))], null), null, 'no card stays no card')
  const { parseRich } = await import('../src/richText.js')
  t.is(cardBesideSpoilers(parseRich('||veja ' + url + ' aqui||'), card), null, 'a parsed spoiler hides its link card')
  t.is(cardBesideSpoilers(parseRich('veja ' + url + ' ||o final||'), card), card, 'a parsed visible link keeps its card')
  const root = { url: new URL('https://example.com').href, host: 'example.com', title: 'Raiz' }
  t.is(cardBesideSpoilers(parseRich('https://example.com ||segredo||'), root), root, 'a normalized card url still matches its visible link')
  const slashed = { ...card, url: url + '/' }
  t.is(cardBesideSpoilers(parseRich('https://example.com/final ||segredo||'), slashed), slashed, 'a trailing slash added by the URL class still matches')
  const accent = { url: new URL('https://example.com/olá').href, host: 'example.com', title: 'Olá' }
  t.is(cardBesideSpoilers(parseRich('https://example.com/olá ||segredo||'), accent), accent, 'a percent-encoded card url still matches its visible link')
  t.is(cardBesideSpoilers(parseRich('||https://example.com||'), root), null, 'a normalized url only inside a spoiler: no card')
  const twin = { url: 'https://example.com/final/', host: 'example.com', title: 'Gêmeo' }
  t.is(cardBesideSpoilers(parseRich('||veja https://example.com/final/ aqui|| https://example.com/final'), twin), null, 'a card matching a link inside a spoiler stays hidden even when a look-alike link is visible')
  const bubble = withoutComments(ui('Bubble.js'))
  t.ok(bubble.includes('const blocks = useMemo(() => (styled ? parseRich(item.rawText) : null), [styled, item.rawText])'), 'parsed once, only on the styled path')
  t.ok(bubble.includes("const card = !muted && item.card && typeof item.card === 'object' ? cardBesideSpoilers(blocks, item.card) : null"), 'Bubble draws only the checked card')
  t.ok(bubble.includes('<LinkCard card={card}'), 'the checked card is the one drawn')
})

test('a message with Abrir convite keeps its spoilers and a spoiler link card covered', async (t) => {
  const screen = withoutComments(readFileSync(join(__dirname, '../src/screens/Mensagem.js'), 'utf8'))
  t.ok(screen.includes("import { parseRich, plainOf } from '../richText'"))
  t.ok(screen.includes("import { cardBesideSpoilers } from '../ui/RichText'"))
  t.ok(screen.includes('text: link ? plainOf(item.rawText, { full: true }) : item.text, rawText: link ? undefined : item.rawText'), 'the plain path beside the invite gets every code line, with its spoilers replaced')
  t.ok(screen.includes('card: link && stored ? cardBesideSpoilers(parseRich(item.rawText), stored) : stored'), 'the card beside the invite goes through the spoiler check')
  const cardBesideSpoilers = fnOf(ui('RichText.js'), 'cardBesideSpoilers')
  const { parseRich, plainOf } = await import('../src/richText.js')
  const { inviteLinkOf } = await import('../src/inviteMessage.js')
  const origin = 'https://bora.varanda.app'
  const link = origin + '/c/' + 'a'.repeat(64)
  const raw = 'Convite: ' + link + ' ||veja https://example.com/final||'
  t.ok(inviteLinkOf(raw, origin), 'the text holds an invite link')
  const text = plainOf(raw)
  t.absent(text.includes('example.com'), 'the spoiler stays covered: ' + text)
  t.absent(text.includes('||'), 'no raw markers')
  const card = { url: 'https://example.com/final', host: 'example.com', title: 'Final' }
  t.is(cardBesideSpoilers(parseRich(raw), card), null, 'no card for a link inside the spoiler')
  const shown = { url: link, host: 'bora.varanda.app', title: 'Convite' }
  t.is(cardBesideSpoilers(parseRich('Convite: ' + link + ' *ok*'), shown), shown, 'without a spoiler the card stays')
})

test('an invite link inside a spoiler does not offer Abrir convite', async (t) => {
  const screen = withoutComments(readFileSync(join(__dirname, '../src/screens/Mensagem.js'), 'utf8'))
  t.ok(screen.includes(': inviteLinkOf(plainOf(row.rawText, { full: true }), origin)'), 'the row looks for an invite in the same text the invite form shows')
  t.absent(screen.includes('inviteLinkOf(row.rawText'), 'never in the raw text')
  const { plainOf } = await import('../src/richText.js')
  const { inviteLinkOf } = await import('../src/inviteMessage.js')
  const origin = 'https://bora.varanda.app'
  const link = origin + '/c/' + 'a'.repeat(64)
  t.ok(inviteLinkOf('oi ||veja ' + link + ' aqui||', origin), 'the raw text holds the link')
  t.is(inviteLinkOf(plainOf('oi ||veja ' + link + ' aqui||'), origin), null, 'only inside a spoiler: no invite')
  t.ok(inviteLinkOf(plainOf('Convite: ' + link + ' ||segredo||'), origin), 'outside the spoiler: the invite stays')
  t.ok(inviteLinkOf(plainOf('Convite: *' + link + '*'), origin), 'a styled link stays whole')
  const fenced = (lines) => '```\n' + lines.join('\n') + '\n```'
  t.ok(inviteLinkOf(plainOf(fenced([link, 'b']), { full: true }), origin), 'on the first line of a code block')
  t.ok(inviteLinkOf(plainOf(fenced(['a', link]), { full: true }), origin), 'on a later line, the same')
  t.is(inviteLinkOf(plainOf('```\n```\n'.repeat(8) + 'oi ||veja ' + link + ' aqui||', { full: true }), origin), null, 'past CODE_MAX a covered link still does not count')
  const shown = plainOf('Convite: ' + link + '\n```\nl1\nl2\nl3\n```\n||segredo||', { full: true })
  t.is(shown, 'Convite: ' + link + '\nl1\nl2\nl3\nspoiler', 'the invite form keeps every code line and covers the spoiler')
})

test('the spoiler cover reads spoiler and never the hidden text', (t) => {
  const cover = fnOf(ui('RichText.js'), 'cover')
  for (const hidden of ['segredo', 'a b', 'o final do filme\ne triste', ' x', 'https://example.com/final', 'spoilerzinho']) {
    const out = cover(hidden)
    t.ok(/^spoiler[\u2007 \n]*$/.test(out), 'the word, then only figure spaces, spaces and line breaks: ' + JSON.stringify(hidden))
    t.is(out.split('\n').length, hidden.split('\n').length, 'line breaks kept: ' + JSON.stringify(hidden))
  }
  const long = cover('palavra '.repeat(30).trim())
  t.is(long.split(' ').length, 30, 'a long spoiler still breaks at its spaces')
  t.absent(long.includes('palavra'))
})

test('only the latest Copiar código answer updates the label', (t) => {
  const code = withoutComments(ui('RichText.js'))
  const block = code.slice(code.indexOf('function CodeBlock'), code.indexOf('export function cardBesideSpoilers'))
  t.ok(block.includes('const copies = useRef(0)'), 'a copy counter')
  t.ok(block.indexOf('const n = ++copies.current') !== -1 && block.indexOf('const n = ++copies.current') < block.indexOf('copyText(shareNav(), shown)'), 'each tap takes its number before copying')
  t.ok(block.includes('if (!alive.current || n !== copies.current) return'), 'an older answer is dropped')
  t.ok(block.includes('.then((ok) => done(n, ok === true), () => done(n, false))'), 'both outcomes carry the tap number')
})

test('a code block does not grow its bubble past the code', (t) => {
  const code = withoutComments(ui('RichText.js'))
  t.ok(code.includes('<ScrollView horizontal showsHorizontalScrollIndicator style={styles.codeScroll}>'), 'the sideways scroll takes codeScroll')
  t.ok(code.includes('codeScroll: { flexGrow: 0 }'), 'and does not grow')
})

test('a long code line does not widen its bubble past the column', (t) => {
  const code = withoutComments(ui('Bubble.js'))
  const column = code.indexOf('<View style={[styles.column, mine && styles.columnMine]}>')
  t.ok(column !== -1, 'the column')
  t.ok(code.slice(column).replace(/\{\s*\}/g, '').replace(/\s+/g, ' ').startsWith('<View style={[styles.column, mine && styles.columnMine]}> <View style={styles.stack}> <Pressable'), 'the bubble sits in the capped stack')
  t.ok(code.includes("stack: { maxWidth: '100%' }"), 'capped at the column width')
})
