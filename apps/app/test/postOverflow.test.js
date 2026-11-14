'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const read = (file) => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')
const post = read('ui/PostRow.js')
const arua = read('screens/ARua.js')

test('post bar keeps reply, repost, like and share; mais moves to the head', (t) => {
  const bar = post.slice(post.indexOf('<View style={styles.bar}>'), post.indexOf('{previewLines.length > 0'))
  t.ok(bar.includes("name='resposta'"), 'reply')
  t.ok(bar.includes("name='republicar'"), 'repost')
  t.ok(bar.includes("name='coracao'"), 'like')
  t.ok(bar.includes("label='compartilhar'"), 'share')
  t.ok(post.includes("label='mais ações'") && !bar.includes("label='mais ações'"), 'mais stays outside the bar')
  t.absent(bar.includes('onFollow'), 'follow stays outside the bar')
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

test('A Rua counts help, bottom padding and pill', (t) => {
  t.ok(arua.includes("return { title: 'Números incompletos', paragraphs: [INCOMPLETE_NOTE] }") && arua.includes('<HelpButton doc={doc} size={18} style={styles.countsHelp} />'), 'incomplete note stays reachable through help')
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
  t.ok(/time: \{ \.\.\.type\.meta, color: colors\.soft, flexShrink: 0 \}/.test(post), 'post time keeps its width')
  t.ok(post.includes('<Text style={styles.handle} numberOfLines={1}>{handle}</Text>'), 'post handle is its own Text')
  t.absent(post.includes("displayText(who.subtitle) + ' · ' + time"), 'handle and time are not one string')
  t.ok(post.includes('compactTime(at, now) ?? relativeTime(at, now) ?? displayText(at)'), 'a post under a minute old says agora, never the raw timestamp')
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
  t.ok(src.includes("(handle ? '\\u00a0· ' : stackHead ? '' : '· ') + time"), 'one space each side of the dot, with or without a handle; no dot when the date has its own line')
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

test('the bar needs no overflow slot; badges and Fechar respect large text', (t) => {
  t.absent(/styles\.slot|slot:/.test(post), 'no empty column after moving mais to the head')
  t.ok(post.includes('const bar = fn(onReply) || fn(onRepost) || fn(onQuote) || fn(onLike) || href !== null'), 'head actions alone do not leave an empty bar')
  const com = read('screens/Comunidade.js')
  t.ok(com.includes('badge: { minWidth: 22, minHeight: 22') && com.includes('maxFontSizeMultiplier={1.5}>{unread}'), 'the community unread badge grows with its digits')
  t.ok(read('screens/Ajustes.js').includes('maxFontSizeMultiplier={TEXT_CAP}>Fechar</Text>'), 'Fechar is capped like the title')
})

test('body long press opens more with feedback and cancels pending navigation', async (t) => {
  const { createPendingOpen } = await import('../src/doubleTap.js')
  const handler = post.match(/const longPress = \(\) => \{([\s\S]*?)\n {2}\}/)
  t.ok(handler, 'long press handler exists')
  if (!handler) return
  const cancel = post.match(/const cancelPendingOpen = \(\) => \{([\s\S]*?)\n {2}\}/)
  t.ok(cancel, 'existing cancellation handler exists')
  const timers = new Map()
  const pendingOpen = createPendingOpen({
    setTimer: (fn) => { timers.set(1, fn); return 1 },
    clearTimer: (id) => timers.delete(id)
  })
  const previousTap = { current: 100 }
  const calls = []
  // eslint-disable-next-line no-new-func
  const cancelPendingOpen = new Function('pendingOpen', 'previousTap', cancel[1]).bind(null, pendingOpen, previousTap)
  let reader = false
  // eslint-disable-next-line no-new-func
  const makePress = new Function('hasMore', 'screenReaderOn', 'cancelPendingOpen', 'tap', 'setSheet', 'return () => {' + handler[1] + '\n}')
  const press = (hasMore) => makePress(hasMore, () => reader, cancelPendingOpen, (kind) => calls.push(kind), (sheet) => calls.push(sheet))
  pendingOpen.arm(() => calls.push('open'), {}, 100)
  press(false)()
  t.alike(calls, [], 'no actions, no sheet or haptic')
  reader = true
  press(true)()
  t.alike(calls, [], 'screen reader, no sheet or haptic')
  reader = false
  press(true)()
  t.alike(calls, ['light', 'more'], 'one light haptic and the same more sheet')
  t.is(previousTap.current, null, 'the next tap cannot complete a double tap')
  t.is(timers.size, 0, 'the pending open was cancelled')
  const body = post.slice(post.indexOf('<View style={styles.body}'))
  t.ok(/onLongPress=\{bodyLongPress\}\s+delayLongPress=\{350\}/.test(body), 'body has the 350 ms gesture')
  t.ok(post.includes('const bodyLongPress = hasMore && !screenReaderOn() ? longPress : undefined'), 'no gesture binding without actions or with a reader')
  const caption = post.slice(post.indexOf('const textNode'), post.indexOf('const mediaNode'))
  t.ok(caption.includes('onLongPress={bodyLongPress}') && caption.includes('delayLongPress={350}'), 'the nested plain caption also handles the hold')
  t.ok(body.includes('disabled={!open && !bodyLongPress}') && caption.includes('disabled={!open && !bodyLongPress}'), 'more remains reachable without a conversation handler')
  t.ok(caption.includes('<MentionText text={body} onOpenMention={openMention} onOpenPlain={openTap} onLongPress={bodyLongPress}'), 'a caption with links or mentions handles the hold too')
  const head = post.slice(post.indexOf('<View style={[styles.head'), post.indexOf('{mediaNode}'))
  t.is(head.split('onLongPress={bodyLongPress}\n').length - 1, 4, 'name, @nome, date and the reply line open the sheet on a hold instead of their own press')
})
