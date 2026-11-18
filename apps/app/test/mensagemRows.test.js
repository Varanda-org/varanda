'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const src = readFileSync(join(__dirname, '../src/screens/Mensagem.js'), 'utf8')

function helper (name) {
  const match = src.match(new RegExp('(?:export )?function ' + name + ' \\([^]*?\\n\\}'))
  if (!match) throw new Error('missing helper: ' + name)
  const calls = src.match(/const ROW_CALLS = \[[^\]]*\]/)[0]
  // eslint-disable-next-line no-new-func
  return new Function(calls + '\n' + match[0].replace(/^export /, '') + '\nreturn ' + name)()
}

test('Mensagem renders rows through one renderItem for the list life', (t) => {
  t.absent(/renderItem=\{\(/.test(src), 'no inline renderItem')
  t.ok(src.includes('renderItem={renderItem}'))
  t.ok(src.includes('const renderItem = useCallback((info) => renderRef.current(info), [])'), 'stable renderItem reads the newest body')
  t.ok(src.includes('renderRef.current = ({ item, index }) => {'))
  t.absent(/extraData=\{\{/.test(src), 'no inline extraData object')
  t.ok(src.includes('extraData={extra}'))
  t.ok(/const extra = useMemo\(\(\) => \(\{[^}]*\bflashKey\b[^}]*\}\), \[[^\]]*\bflashKey\b/.test(src), 'extraData memoized on what rows read')
  t.ok(src.includes('const MessageRow = memo(function MessageRow ('), 'the row is memo')
  t.ok(src.includes('}, sameMessageRow)'), 'with the item-blind comparison')
  t.ok(src.includes('const rows = useMemo(() => withDayMarks(gestureRows, now), [gestureRows, now])'), 'typing keeps the same data array')
  t.ok(src.includes('const rowCalls = useMemo(() => liveRowCalls(rowLive), [])'), 'one set of row calls for the list life')
  t.ok(/rowLive\.current = \{[^}]*\bscrollToKey\b[^}]*\btoggleReaction\b/.test(src), 'the live box is refreshed every render')
})

test('the composer draft is not a row input', (t) => {
  const body = src.slice(src.indexOf('  renderRef.current = ({ item, index }) => {'), src.indexOf('  // Footers without a field'))
  t.ok(body.length > 0)
  t.absent(/\bdraft\b|\bcanSend\b|\blinkDraft\b|\breplyTo\b/.test(body), 'renderItem reads no composer state')
  const extra = src.match(/const extra = useMemo\([^\n]*/)[0]
  t.absent(/\bdraft\b|\bcanSend\b|\blinkDraft\b|\breplyTo\b|\bpost\b/.test(extra), 'extraData carries no composer state')
})

test('row calls run the newest handler at call time', (t) => {
  const liveRowCalls = helper('liveRowCalls')
  const seen = []
  const live = { current: { setReplyTo: (v) => seen.push(['old', v]), offerAct: { clearError: () => seen.push(['old clear']) } } }
  const calls = liveRowCalls(live)
  const reply = calls.setReplyTo
  const clear = calls.offerAct.clearError
  live.current = { setReplyTo: (v) => seen.push(['new', v]), toggleReaction: (k, e) => seen.push(['react', k, e]), scrollToKey: (k) => seen.push(['jump', k]), offerAct: { clearError: () => seen.push(['new clear']) } }
  reply(1)
  clear()
  calls.toggleReaction('a', 'x')
  calls.scrollToKey('b')
  t.alike(seen, [['new', 1], ['new clear'], ['react', 'a', 'x'], ['jump', 'b']])
  for (const name of ['setForwarding', 'onReport', 'openReactionPicker', 'declineOffer', 'setConfirming', 'onOpenInvite', 'onOpenListing', 'onAvaliar', 'mentionTap', 'reactionsFor', 'quoteTarget', 'offerOfRow']) {
    t.is(typeof calls[name], 'function', name)
  }
})

test('sameMessageRow ignores the fresh item and compares the rest', (t) => {
  const sameMessageRow = helper('sameMessageRow')
  const base = { key: 'a' }
  const props = { item: { ...base }, base, flash: false, shape: 'single', reactions: null }
  t.ok(sameMessageRow(props, { ...props, item: { ...base } }), 'a new item object alone redraws nothing')
  t.absent(sameMessageRow(props, { ...props, flash: true }), 'jump flash redraws')
  t.absent(sameMessageRow(props, { ...props, base: { key: 'a' } }), 'a changed thread row redraws')
  t.absent(sameMessageRow(props, { ...props, reactions: [{ emoji: 'x' }] }), 'a reaction redraws')
  t.absent(sameMessageRow(props, { ...props, extra: 1 }), 'a new prop redraws')
})

test('the row keeps every action wired through the calls', (t) => {
  const row = src.slice(src.indexOf('const MessageRow = memo('), src.indexOf('}, sameMessageRow)'))
  for (const pin of [
    'onPress: () => setReplyTo({ id: item.id, text: item.text, mine, name: mine ? OWN_LABEL : quoteName })',
    'closeThen(() => toggleReaction(item.key, emoji))',
    'closeThen(() => openReactionPicker(item.key))',
    'onPress: quoteMissing(item) ? undefined : () => scrollToKey(quoteTarget(item)?.key)',
    '<SwipeReply disabled={!reply} onReply={reply?.onPress}>',
    '<View style={flash ? styles.quoteFlash : undefined}>',
    "<ChatMedia refs={refs} identity={ownKey} mine={mine} deferred={folder === 'request'} />",
    'onPress: () => setForwarding({ source: forwardSource, refs })'
  ]) t.ok(row.includes(pin), pin)
  t.ok(row.includes('} = calls'), 'handlers come from the live calls')
})

test('a page thread offers Avaliar for its own offers, rated as the page', (t) => {
  t.ok(src.includes('const me = pageKey !== null ? pageKey : ownKey'), 'as a page, me is the page key')
  const body = src.slice(src.indexOf('  const offerOfRow = (index) => {'), src.indexOf('  const offerBusy = '))
  t.ok(body.length > 0)
  t.ok(body.includes('offerState(offerMsgs, me, listing, origin)'), 'the offer is read for me')
  const rate = body.match(/const rate = [^\n]*/)[0]
  t.absent(/pageKey/.test(rate), 'the rate gate does not exclude a page')
  t.ok(rate.includes('buttons.rate && old === null'), 'the person\'s rules still hold')
})
