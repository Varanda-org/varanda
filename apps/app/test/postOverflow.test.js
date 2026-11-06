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
