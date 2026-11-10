'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const read = (file) => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')
const post = read('ui/PostRow.js')
const arua = read('screens/ARua.js')

test('post bar keeps reply, repost, like, share and mais', (t) => {
  t.ok(post.includes("name='resposta'"), 'reply')
  t.ok(post.includes("name='republicar'"), 'repost')
  t.ok(post.includes("name='coracao'"), 'like')
  t.ok(post.includes("label='compartilhar'"), 'share')
  t.ok(post.includes("label='mais ações'"), 'mais')
  t.ok(post.includes('doubleTap'), 'double tap like kept')
})

test('quote, report and delete left the inline bar', (t) => {
  t.absent(post.includes("name='citar'"), 'no pencil')
  t.absent(post.includes("name='bandeira'"), 'no inline flag')
  t.absent(post.includes("name='lixeira'"), 'no inline trash')
  t.ok(post.includes('moreActions') && post.includes('repostActions'), 'sheets come from postActions')
  t.ok(post.includes("label: 'Apagar'") && post.includes('danger: true'), 'delete stays a danger row')
  t.ok(post.includes('ActionsSheet'), 'compact sheet')
})

test('share is decided by capability, never by platform', (t) => {
  const start = post.indexOf('const pressShare')
  const body = post.slice(start, post.indexOf('const moreRows'))
  t.ok(body.includes('canShare(nav)') && body.includes('copyText'), 'native share, else clipboard')
  t.ok(body.includes('onNotice'), 'toast on copy')
  t.absent(body.includes('Platform.OS'))
})

test('A Rua footnote, bottom padding and pill', (t) => {
  t.ok(arua.includes('styles.footnote'), 'incomplete note is a footnote')
  t.absent(arua.includes('<Soft>{INCOMPLETE_NOTE}</Soft>'))
  t.ok(arua.includes('useBottomPad() + layout.fabSize'), 'clears the publish button')
  t.ok(arua.includes('loadedAt !== null && items.length > 0'), 'no pill over the empty state')
})

test('postActions rows the row builds', async (t) => {
  const { moreActions, repostActions } = await import('../src/postActions.js')
  t.alike(repostActions({}, null).map((r) => r.label), ['Republicar', 'Citar'])
  const rows = moreActions(null, { link: 'https://v.example/p/1', onReport: true })
  t.alike(rows.map((r) => r.label), ['Copiar link', 'Denunciar'])
  t.alike(moreActions({ link: 'https://v.example/p/1' }, { onReport: true }).map((r) => r.label), ['Denunciar'], 'a link on the item is ignored')
})

test('Citar keeps its own button when reposting is not available', (t) => {
  const src = read('ui/PostRow.js')
  t.ok(src.includes("<Action label='citar' onPress={otherPress(() => setSheet('repost'))} count={null}>"), 'the repost button opens Citar alone')
  t.ok(src.includes(".filter((row) => row.id !== 'repost' || fn(onRepost))"), 'no Republicar row without a repost handler')
  t.ok(src.includes('fn(onRepost) || fn(onQuote) || fn(onLike)'), 'a quote handler alone still shows the bar')
})

test('the repost button tells a screen reader it opens a choice when quoting is possible', (t) => {
  const src = read('ui/PostRow.js')
  t.ok(src.includes("const repostLabel = (reposted ? 'desfazer republicação' : 'republicar') + (fn(onQuote) ? ' ou citar' : '')"))
  t.is(src.split('label={repostLabel}').length - 1, 2, 'both repost buttons use it')
  t.absent(src.includes("label={reposted ? 'desfazer republicação' : 'republicar'}"))
})

test('the date of a post or a quote never shrinks; the @nome truncates first', (t) => {
  const quote = read('ui/QuoteCard.js')
  t.ok(/time: \{ \.\.\.type\.postMeta, color: colors\.soft, flexShrink: 0 \}/.test(post), 'post time keeps its width')
  t.ok(post.includes('<Text style={styles.handle} numberOfLines={1}>{handle}</Text>'), 'post handle is its own Text')
  t.absent(post.includes("displayText(who.subtitle) + ' · ' + time"), 'handle and time are not one string')
  t.ok(/time: \{[^}]*flexShrink: 0 \}/.test(quote) && quote.includes('<Meta handle={handle} time={time}'), 'quote time keeps its width')
})

test('the post time is outside the box that shrinks', (t) => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'ui', 'PostRow.js'), 'utf8')
  t.ok(src.includes('timeBox: { flexShrink: 0 }') && src.includes('styles.timeBox'), 'its own non-shrinking box')
  const meta = src.slice(src.indexOf('styles.metaBox'), src.indexOf('styles.timeBox'))
  t.absent(meta.includes('styles.time}'), 'the shrinking handle box does not hold the time')
})

test('large text leaves the @nome out of the post header', (t) => {
  const src = read('ui/PostRow.js')
  t.ok(src.includes('useWindowDimensions()') && /const handle = who\.subtitle && !\(fontScale >= LARGE_TEXT\)/.test(src))
})

test('beside a handle the name keeps its width up to 70%', (t) => {
  const src = read('ui/PostRow.js')
  t.ok(src.includes('nameBeside: { flexShrink: 1 }') && src.includes('metaBox: { flexShrink: 10000, minWidth: 32 }') && src.includes('handle && styles.nameBeside'), 'the handle gives way first, stops at 32 pt, then the name shrinks so the date fits')
})

test('the post header dot has one space on each side', (t) => {
  const src = read('ui/PostRow.js')
  t.ok(src.includes("head: { flexDirection: 'row', alignItems: 'baseline' }"), 'no head gap')
  t.ok(src.includes('nameBox: { flexShrink: 1, marginRight: 6 }'))
  t.ok(src.includes("(handle ? '\\u00a0· ' : '· ') + time"), 'one space each side of the dot, with or without a handle')
})

test('round 8: the handle hides at Android 1.3 text and QuoteCard spaces the dot like PostRow', (t) => {
  const row = read('ui/PostRow.js')
  t.ok(row.includes('!(fontScale >= LARGE_TEXT)') && read('ui/theme.js').includes('export const LARGE_TEXT = 1.29'), 'handle hidden at Android 1.3 (1.2999999523)')
  const quote = read('ui/QuoteCard.js')
  t.ok(quote.includes("(handle ? '\\u00a0· ' : '· ') + time"), 'the dot shows without a handle too, evenly spaced')
  t.ok(quote.includes('!(fontScale >= LARGE_TEXT)'), 'quotes leave the handle out at large text too')
  t.ok(quote.includes("head: { flexDirection: 'row', alignItems: 'center' },"), 'no head gap')
  t.ok(quote.includes('flexShrink: 1, marginRight: 6 }') && quote.includes('flexShrink: 10000, minWidth: 32'), '6 after the name, which gives way only after the handle')
})

test('round 13: a row without "mais" keeps an empty column, badges and Fechar respect large text', (t) => {
  t.ok(read('ui/PostRow.js').includes(': <View style={styles.slot} />}') && read('ui/PostRow.js').includes('slot: { minWidth: 44 }'), 'icons stay in their columns')
  const com = read('screens/Comunidade.js')
  t.ok(com.includes('badge: { minWidth: 22, minHeight: 22') && com.includes('maxFontSizeMultiplier={1.5}>{unread}'), 'the community unread badge grows with its digits')
  t.ok(read('screens/Ajustes.js').includes('maxFontSizeMultiplier={TEXT_CAP}>Fechar</Text>'), 'Fechar is capped like the title')
})
