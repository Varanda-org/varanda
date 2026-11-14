// Link cards are drawn from stored data only: LinkCard never contacts the
// linked site, the web composer asks the account service, and the screens
// draw the card from the item's own `card` / `preview`. Read as text because
// the UI files pull in react-native.
'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const SRC = path.join(__dirname, '../src')
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8')

// String literals are kept whole, so a '//' inside a URL never hides the
// rest of its line.
function withoutComments (src) {
  return src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')
}

test('LinkCard never reaches the linked site', (t) => {
  const src = withoutComments(read('ui', 'LinkCard.js'))
  t.absent(/\bfetch\s*\(/.test(src), 'no fetch call')
  t.absent(/['"`]https?:\/\//i.test(src), 'no http(s) literal')
  t.absent(/uri\s*:\s*(card|data|draft|props)\s*\.\s*url/.test(src), 'the URL is never an image source')
  t.absent(/source=\{\{[^}]*\burl\b/.test(src), 'no Image source built from a url')
  t.absent(/favicon|apple-touch-icon|\/favicon/i.test(src), 'no site icon')
  t.absent(/iframe|WebView|<Video|prefetch|Image\.prefetch/i.test(src), 'no frame, player or prefetch')
  t.ok(src.includes('displayText('), 'peer text goes through displayText')
  t.ok(src.includes('cardUrlHost('), 'the host shown is the one the URL opens')
  t.ok(src.includes("from '../openExternal'"), 'opening goes through openExternal')
  t.ok(/onPress=\{open\}/.test(src), 'the URL opens only on a tap')
  t.ok(src.includes("from '../media/chatMedia'") && src.includes('sourceFor('), 'chat thumbnails use the chat media path')
  t.ok(src.includes('<MediaView author={thumb.author} descriptor={stored}'), 'post thumbnails use the post photo path')
})

test('LinkCard shows the title and host, with a hairline and no fill', (t) => {
  const src = withoutComments(read('ui', 'LinkCard.js'))
  t.ok(src.includes('const THUMB = 64'), 'the thumbnail stays 64')
  t.ok(src.includes('{title ? <Text style={styles.title} numberOfLines={2}>{title}</Text> : null}'), 'the title stays')
  t.ok(src.includes('<Text style={styles.host} numberOfLines={1}>{shownHost}</Text>'), 'the host stays')
  t.ok(src.includes("const label = LINK_CARD_OPEN + ': ' + (title ? title + ', ' : '') + shownHost"), 'the accessibility label stays title and host')
  t.ok(src.includes('accessibilityLabel={label}'), 'the label is announced')
  t.absent(src.includes('styles.desc'), 'the description is not drawn')
  t.absent(src.includes('data.desc'), 'the description is not read onto the screen')
  const card = src.slice(src.indexOf('\n  card: {'), src.indexOf('\n  body:'))
  t.ok(card.includes('borderWidth: StyleSheet.hairlineWidth') && card.includes('borderColor: colors.line'), 'the hairline border stays')
  t.absent(card.includes('backgroundColor'), 'the card has no filled background')
})

test('LinkCard thumbnails leave taps to the card', (t) => {
  const src = withoutComments(read('ui', 'LinkCard.js'))
  const media = [...src.matchAll(/<MediaView\b[^>]*(?:descriptor=\{stored\}|uri=\{chatUri\})[^>]*\/>/g)]
  t.is(media.length, 2, 'two stored thumbnail variants')
  for (const element of media) {
    t.ok(element[0].includes('tapRetry={false}'), 'retry is disabled inside the link')
    t.absent(element[0].includes('onPress'), 'the thumbnail has no nested press')
  }
})

test('the web composer asks the account preview route', (t) => {
  const file = path.join(SRC, 'previewBuild.web.js')
  if (!fs.existsSync(file)) {
    t.pass('previewBuild.web.js not written yet')
    return
  }
  t.ok(fs.readFileSync(file, 'utf8').includes("import { previewFetch, previewPolicy } from './account.js'"), 'previewBuild.web.js uses the account preview client')
  t.ok(fs.readFileSync(path.join(SRC, 'account.js'), 'utf8').includes("call('POST', '/account/preview', { url }"), 'account.js asks /account/preview')
})

test('Bubble and PostRow draw the stored card', (t) => {
  const bubble = withoutComments(read('ui', 'Bubble.js'))
  t.ok(bubble.includes("import { LinkCard } from './LinkCard'"))
  t.ok(/item\.card/.test(bubble) && /<LinkCard card=\{card\}/.test(bubble), 'Bubble renders item.card')
  t.ok(/const card = !muted/.test(bubble), 'no card on a hidden or deleted message')
  const row = withoutComments(read('ui', 'PostRow.js'))
  t.ok(row.includes("import { LinkCard } from './LinkCard'"))
  t.ok(/<LinkCard card=\{preview\}/.test(row), 'PostRow renders post.preview')
  t.ok(/kind: 'post', author/.test(row), 'the post thumbnail is read for the post author')
})

test('PostRow draws a music player only from the stored card', (t) => {
  const row = withoutComments(read('ui', 'PostRow.js'))
  t.ok(row.includes("import { MusicEmbedCard } from './MusicEmbedCard'"))
  t.ok(row.includes("import { embedOf, sameMusicPage } from '../musicEmbed'"))
  t.ok(row.includes("const embed = preview && typeof preview === 'object' ? embedOf(preview.url) : null"), 'the player comes from the stored card URL')
  t.is([...row.matchAll(/embedOf\(/g)].length, 1, 'never from a link in the text')
  t.ok(/embed !== null\s*\? <MusicEmbedCard embed=\{embed\} card=\{preview\} thumb=\{\{ kind: 'post', author/.test(row), 'MusicEmbedCard for a music link')
  t.ok(/: <LinkCard card=\{preview\}/.test(row), 'LinkCard for any other link')
  const quote = withoutComments(read('ui', 'QuoteCard.js'))
  t.ok(quote.includes("import { MusicEmbedCard } from './MusicEmbedCard'"))
  t.is([...quote.matchAll(/embedOf\(/g)].length, 1, 'only the stored quote URL is inspected')
  t.ok(quote.includes("return !missing && !hasMedia && q.preview && typeof q.preview === 'object' && typeof q.author === 'string' ? embedOf(q.preview.url) : null"))
  t.ok(quote.includes('const embed = quotePlayerOf(q)'), 'QuoteCard uses the shared player rule')
  t.ok(/embed !== null\s*\? <MusicEmbedCard embed=\{embed\} card=\{q\.preview\} thumb=\{\{ kind: 'post', author: q\.author, persist: q\.persist === true \}\}/.test(quote))
  t.ok(quote.includes('<LinkCard card={q.preview}'), 'other quoted links keep the static card')
})

test('quotePlayerOf matches the stored player eligibility rule', async (t) => {
  const { embedOf } = await import('../src/musicEmbed.js')
  const src = withoutComments(read('ui', 'QuoteCard.js'))
  const helper = src.match(/export function quotePlayerOf \(quote\) \{([\s\S]*?)\n\}/)
  t.ok(helper, 'the pure helper is exported')
  const quotePlayerOf = new Function('embedOf', 'quote', helper[1]).bind(null, embedOf) // eslint-disable-line no-new-func
  const quote = { author: 'a'.repeat(64), preview: { url: 'https://youtu.be/dQw4w9WgXcQ' } }
  t.alike(quotePlayerOf(quote), embedOf(quote.preview.url), 'a stored YouTube card gets its player')
  t.ok(quotePlayerOf(quote) !== null)
  t.ok(quotePlayerOf({ ...quote, media: [], missing: false }) !== null)
  for (const other of [
    null, undefined, {},
    { ...quote, media: [{}] },
    { ...quote, missing: true },
    { ...quote, author: undefined },
    { ...quote, author: 1 },
    { ...quote, preview: null },
    { ...quote, preview: { url: 'https://example.com' } }
  ]) t.is(quotePlayerOf(other), null, 'no player for ' + JSON.stringify(other))
})

test('quoted players stay outside the quote and row press areas', (t) => {
  const row = withoutComments(read('ui', 'PostRow.js'))
  t.ok(row.includes("import { QuoteCard, quotePlayerOf } from './QuoteCard'"), 'the row shares the card rule')
  t.ok(row.includes("const quoteOut = quoteOn && ((typeof quote.text === 'string' && !!quoteMention && hasMention(quote.text)) || quotePlayerOf(quote) !== null)"), 'players and handled mentions leave the hidden wrapper')
  t.ok(/\{quoteNode && !quoteOut\s*\? \(\s*<Pressable[^>]*>\s*<View accessibilityElementsHidden importantForAccessibility='no-hide-descendants'>\s*\{quoteNode\}/.test(row), 'only other quotes enter the hidden press area')
  t.ok(/<\/Pressable>\s*\)\s*: null\}\s*\{videoAbove \? null : previewNode\}\s*\{quoteOut \? quoteNode : null\}/.test(row), 'the lifted quote is outside that Pressable')
  const quote = withoutComments(read('ui', 'QuoteCard.js'))
  const start = quote.indexOf('if (embed !== null || mentioned) {')
  t.ok(start >= 0, 'every player takes the split layout before the default Pressable')
  const end = quote.indexOf('\n  return (\n    <Pressable', start)
  t.ok(end > start, 'the default grouped layout follows the split branch')
  const split = quote.slice(start, end)
  t.ok(/<Pressable\s+accessibilityRole=\{open \? 'link' : 'text'\}\s+accessibilityLabel=\{label\}/.test(split), 'the head keeps its labelled link')
  t.ok(split.includes('onPress={open}'), 'the head opens the quoted post')
  const headEnd = split.indexOf('</Pressable>')
  const player = split.indexOf('{preview}')
  t.ok(headEnd > 0 && player > headEnd && player < split.indexOf('<Pressable', headEnd), 'the player follows the closed head, before any other Pressable')
  t.ok(quote.includes('? <MusicEmbedCard embed={embed} card={q.preview}'), 'preview contains the stored player')
  t.ok(split.includes('<Text onPress={open} style={styles.text} numberOfLines={6}>{displayText(shownText, { multiline: true })}</Text>'), 'plain shown text opens the quote separately')
  t.ok(split.includes('<MentionText text={shownText} onOpenMention={openMention} onOpenPlain={open}'), 'mentions keep separate profile and quote taps')
  t.ok(split.includes("{hasText && shownText !== ''"), 'an empty shown text has no line')
  t.ok(split.includes('{loading ? <View style={styles.skeleton} accessible={false} /> : null}'), 'loading still uses the raw text rule')
})

test('PostRow hides only the music card\'s own link from the shown text', async (t) => {
  const row = withoutComments(read('ui', 'PostRow.js'))
  t.ok(row.includes("import { hasLink, textWithoutHrefs } from '../links'"))
  t.ok(/^ {2}const ownLink = !hasMedia && music === null && embed !== null$/m.test(row))
  t.ok(row.includes("const body = useMemo(() => (ownLink && typeof text === 'string' ? textWithoutHrefs(text, (href) => sameMusicPage(href, preview.url)) : text), [ownLink, text, preview])"))
  t.ok(row.includes('<MentionText text={body}'))
  t.absent(row.includes('<MentionText text={text}'))
  t.ok(row.includes("const hasText = typeof body === 'string' && body !== ''"))
  t.ok(row.includes('const shownText = useMemo(() => (hasText ? displayText(body, { multiline: true }) : null), [hasText, body])'))
  t.ok(row.includes('const textOut = hasText && numberOfLines === 0 && (hasLink(body) || (!!openMention && hasMention(body)))'))
  t.ok(row.includes('const textNode = hasText'), 'an empty shown body draws no text node')
  t.ok(row.includes('onMessage(author, { context: { author, seq, at, text, hasMedia } })'), 'message context keeps the raw text')
  for (const file of ['MentionText.js']) {
    t.absent(/textWithoutHrefs|sameMusicPage/.test(withoutComments(read('ui', file))), file + ' keeps its text')
  }
  t.ok(read('screens', 'Mensagem.js').includes('copyText(shareNav(), displayText(item.rawText, { multiline: true }))') && read('screens', 'Grupo.js').includes('copyText(shareNav(), displayText(row.rawText, { multiline: true }))'), 'chat copy keeps the raw text a bubble may shorten')
  const { textWithoutHrefs } = await import('../src/links.js')
  const { sameMusicPage } = await import('../src/musicEmbed.js')
  const card = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
  const text = 'ouça https://youtu.be/dQw4w9WgXcQ agora @ana https://example.com'
  t.is(textWithoutHrefs(text, (h) => sameMusicPage(h, card)), 'ouça agora @ana https://example.com')
  const timed = text.replace('dQw4w9WgXcQ', 'dQw4w9WgXcQ?t=42')
  t.is(textWithoutHrefs(timed, (h) => sameMusicPage(h, card)), timed, 'a different playback position stays visible')
  t.is(textWithoutHrefs('https://youtu.be/dQw4w9WgXcQ', (h) => sameMusicPage(h, card)), '')
})

test('a quote hides only its own music link', (t) => {
  const quote = withoutComments(read('ui', 'QuoteCard.js'))
  t.ok(quote.includes("import { embedOf, sameMusicPage } from '../musicEmbed'"))
  t.ok(quote.includes("import { textWithoutHrefs } from '../links'"))
  t.ok(quote.includes('const shownText = embed !== null && hasText ? textWithoutHrefs(q.text, (href) => sameMusicPage(href, q.preview.url)) : q.text'))
  t.ok(quote.includes("const hasText = typeof q.text === 'string' && q.text !== ''"))
  t.ok(quote.includes('const loading = !missing && !hasText && !hasMedia'), 'hiding a URL-only caption does not turn the quote into a loading card')
  t.ok(quote.includes("const mentioned = !missing && openMention && hasText && shownText !== '' && hasMention(shownText)"))
  t.ok(quote.includes('if (embed !== null || mentioned) {'))
  t.ok(quote.includes('<MentionText text={shownText}'))
  t.ok(quote.includes("{hasText && shownText !== ''"), 'an empty shown caption draws no plain text node')
  t.ok(quote.includes('displayText(shownText, { multiline: true })'))
  t.absent(quote.includes('displayText(q.text'))
  t.absent(quote.includes('<MentionText text={q.text}'))
})

test('Audius fragments take precedence without subscribing PostRow to the node', (t) => {
  const row = withoutComments(read('ui', 'PostRow.js'))
  t.ok(row.includes("import PostMusic from './PostMusic'"))
  t.absent(row.includes('MusicPlayerCard'), 'the music card is drawn by PostMusic')
  t.ok(row.includes("import { musicRefOf } from '../music'"))
  t.ok(row.includes("const music = preview && typeof preview === 'object' ? musicRefOf(preview.url) : null"))
  t.is([...row.matchAll(/musicRefOf\(/g)].length, 1, 'only the stored URL is inspected')
  t.ok(row.includes("const previewNode = !hasMedia && preview && typeof preview === 'object'"), 'music only on a post without media')
  t.ok(/\? music !== null\s*\? <PostMusic card=\{preview\} music=\{music\} \/>\s*: embed !== null\s*\? <MusicEmbedCard/.test(row))
  t.ok(row.includes('<LinkCard card={preview}'), 'the literal normal link fallback remains')
  t.absent(/useNode\(|useMusicAvailable\(|audiusReady\(/.test(row), 'availability belongs to PostMusic')
  const sticker = withoutComments(read('ui', 'PostMusic.js'))
  t.ok(sticker.includes("import { MusicPlayerCard, createMusicPlayback, musicPlayerIdle } from './MusicPlayerCard'"))
  t.absent(/musicRefOf\(/.test(sticker), 'PostMusic takes the ref PostRow read from the stored URL')
  t.ok(sticker.includes('return <MusicPlayerCard card={card} music={music} />'), 'the old card stays for a playlist and with the switch off')
  t.absent(/MusicPlayerCard|PostMusic|musicRefOf/.test(withoutComments(read('ui', 'QuoteCard.js'))), 'quotes remain static')
})

test('MusicEmbedCard draws stored data until it is on screen', (t) => {
  const src = withoutComments(read('ui', 'MusicEmbedCard.js'))
  t.absent(/\bfetch\s*\(/.test(src), 'no fetch call')
  t.absent(/['"`]https?:\/\//i.test(src), 'no http(s) literal')
  t.absent(/uri\s*:\s*(card|data|embed|props)\s*\.\s*(url|embedUrl|pageUrl)/.test(src), 'no URL is an image source')
  t.absent(/source=\{\{[^}]*\b(url|embedUrl|pageUrl)\b/.test(src), 'no Image source built from a url')
  t.absent(/\bImage\b/.test(src), 'no Image of its own')
  t.absent(/favicon|apple-touch-icon|prefetch|iframe|WebView|<Video/i.test(src), 'no site icon, prefetch or frame of its own')
  t.ok(src.includes('cardUrlHost('), 'the host shown is the one the URL opens')
  const cards = [...src.matchAll(/<LinkCard\b[^>]*\/>/g)].map((m) => m[0])
  t.is(cards.length, 1, 'the stored data is drawn by one LinkCard')
  t.absent(/\bstill\b/.test(cards[0]), 'not drawn still, so a tap opens the stored link')
  t.absent(src.includes('MediaView'), 'no MediaView of its own')
  const card = withoutComments(read('ui', 'LinkCard.js'))
  t.ok(card.includes('const open = () => openExternal(url)'), 'a LinkCard always opens its link on a tap')
  const cover = withoutComments(read('ui', 'EmbedCover.js'))
  t.absent(/openExternal|Linking|onPress=/.test(cover), 'the cover never opens a link')
  t.absent(/\bstill\b/.test(card), 'LinkCard has no still prop')
  const frames = [...src.matchAll(/<EmbedFrame\b/g)]
  t.is(frames.length, 1, 'one EmbedFrame')
  const before = src.slice(0, frames[0].index)
  t.ok(before.slice(before.lastIndexOf('{parts.')).startsWith('{parts.frame'), 'EmbedFrame only inside the parts.frame branch')
  t.ok(/function slotParts \(live, hosted, ready\) \{[^}]*frame: live && !hosted\s*\}/.test(src), 'which needs a live state')
  t.ok(src.includes('const live = state.live\n'), 'live is the card state')
})

test('Ajustes: Prévia de links switch uses previewPref', (t) => {
  const src = withoutComments(read('screens', 'Ajustes.js'))
  t.ok(src.includes("from '../previewPref'"))
  t.ok(src.includes('label={PREVIEW_PREF_LABEL}'), 'the switch is labelled from previewPref')
  t.ok(src.includes('previewsEnabled(') && src.includes('setPreviewsEnabled('), 'reads and writes the preference')
  t.ok(src.includes("'switch'"), 'announced as a switch')
})

test('every PostRow screen passes the stored preview', (t) => {
  const rua = withoutComments(read('screens', 'ARua.js'))
  t.ok(/preview: post\.preview \|\| null/.test(rua), 'socialRowProps (A Rua, Busca, Espiadinha) passes post.preview')
  t.ok(/preview: q \? q\.preview \|\| null : null/.test(rua), 'socialRowProps passes the quoted preview')
  const conversa = withoutComments(read('screens', 'Conversa.js'))
  t.ok(/preview: item\.preview \|\| null/.test(conversa), 'rowProps (Conversa, Membro) passes item.preview')
  t.ok(/preview: q\.preview \|\| null/.test(conversa), 'rowProps passes the quoted preview')
  t.ok(/preview: seed\.preview/.test(conversa), 'a seed keeps its preview')
  for (const f of ['Busca.js', 'Espiadinha.js']) {
    const src = withoutComments(read('screens', f))
    t.ok(src.includes('socialRowProps(') && /<PostRow\s+\{\.\.\.row\}/.test(src), f + ' spreads socialRowProps into PostRow')
  }
  const membro = withoutComments(read('screens', 'Membro.js'))
  t.ok(/<PostRow \{\.\.\.rowProps\(/.test(membro), 'Membro spreads rowProps into PostRow')
})

test('QuoteCard draws the quoted post preview from stored data', (t) => {
  const src = withoutComments(read('ui', 'QuoteCard.js'))
  t.ok(src.includes("import { LinkCard } from './LinkCard'"))
  t.ok(/<LinkCard card=\{q\.preview\} thumb=\{\{ kind: 'post', author: q\.author/.test(src), 'the quoted preview is a LinkCard with the post thumbnail')
  t.ok(/!missing && !hasMedia && q\.preview/.test(src), 'never with photos or on a missing quote')
})

test('Ajustes and the composers share previewPrefStore', (t) => {
  const ajustes = withoutComments(read('screens', 'Ajustes.js'))
  t.ok(ajustes.includes("import { previewPrefStore } from '../previewBuild'"), 'Ajustes reads the composers store')
  t.ok(/previewsEnabled\(prefStore\)/.test(ajustes) && /setPreviewsEnabled\(prefStore/.test(ajustes) && /prefStore = previewPrefStore\(\)/.test(ajustes))
  t.absent(/localStorage/.test(ajustes), 'no private browser store in Ajustes')
  const composer = withoutComments(read('ui', 'ChatComposer.js'))
  t.ok(/previewsEnabled\(previewPrefStore\(\)\)/.test(composer), 'the composer reads the same store')
})

test('a DM card thumbnail is read by the node with index card', (t) => {
  const card = withoutComments(read('ui', 'LinkCard.js'))
  t.ok(/thumb\.kind === 'dm'\) return \{ kind: 'dm', from: thumb\.from, id: thumb\.id, index: 'card', item: image \}/.test(card), 'LinkCard builds the DM card ref')
  t.ok(card.includes('sourceFor(ref'), 'read through chatMedia sourceFor')
  const msg = withoutComments(read('screens', 'Mensagem.js'))
  // A page thread (acting as a page) has no page-inbox media read, so its
  // cards show without the thumbnail.
  t.ok(/cardThumb=\{item\.deleted \|\| pageKey !== null \? undefined : \{ kind: 'dm', from: item\.from \|\| \(mine \? ownKey : null\), id: item\.id, identity: ownKey \}\}/.test(msg), 'Mensagem passes the DM card thumb, never in a page thread')
})

test('no em dash in the link card files', (t) => {
  for (const f of [['ui', 'LinkCard.js'], ['ui', 'Bubble.js'], ['ui', 'PostRow.js'], ['ui', 'QuoteCard.js'], ['ui', 'MusicEmbedCard.js'], ['screens', 'Ajustes.js'], ['screens', 'Mensagem.js'], ['media', 'chatMedia.js']]) {
    t.absent(read(...f).includes('\u2014'), f.join('/'))
  }
})
