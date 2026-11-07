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
  t.ok(/cardThumb=\{item\.deleted \? undefined : \{ kind: 'dm', from: item\.from \|\| \(mine \? ownKey : null\), id: item\.id, identity: ownKey \}\}/.test(msg), 'Mensagem passes the DM card thumb')
})

test('no em dash in the link card files', (t) => {
  for (const f of [['ui', 'LinkCard.js'], ['ui', 'Bubble.js'], ['ui', 'PostRow.js'], ['ui', 'QuoteCard.js'], ['screens', 'Ajustes.js'], ['screens', 'Mensagem.js'], ['media', 'chatMedia.js']]) {
    t.absent(read(...f).includes('\u2014'), f.join('/'))
  }
})
