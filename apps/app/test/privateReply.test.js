'use strict'

const test = require('brittle')
const load = () => import('../src/privateReply.js')
const PEER = 'ab'.repeat(32)
const OWN = 'cd'.repeat(32)
const AUTHOR = 'ef'.repeat(32)
// Local noon, so the calendar day is the same in every time zone.
const AT = new Date(2020, 0, 15, 12).toISOString()
const NOW = new Date(2026, 5, 1, 12).getTime()
const context = (extra = {}) => ({ author: AUTHOR, seq: 1, at: AT, text: 'Uma publicação', hasMedia: false, ...extra })
const intent = (extra = {}) => ({ id: 'caller-id', peer: PEER, from: 'mural', context: null, ...extra })

test('makeIntent preserves the caller id, peer and origin', async (t) => {
  const { makeIntent } = await load()
  const input = Object.freeze(intent())
  t.alike(makeIntent(input), { ...input, offer: null })
  t.alike(makeIntent(input), makeIntent(input), 'no randomness')
})

test('makeIntent keeps null context and defaults absent context to null', async (t) => {
  const { makeIntent } = await load()
  t.is(makeIntent(intent()).context, null)
  t.is(makeIntent({ id: 'id', peer: PEER, from: 'profile' }).context, null)
})

test('makeIntent copies only the public post context fields', async (t) => {
  const { makeIntent } = await load()
  const input = Object.freeze(context({ extra: 'unused' }))
  const result = makeIntent(intent({ context: input }))
  t.alike(result.context, context())
  t.not(result.context, input)
})

test('makeIntent limits preview text to 140 Unicode code points', async (t) => {
  const { makeIntent } = await load()
  const text = 'a'.repeat(139) + '🌿' + 'z'
  t.is(makeIntent(intent({ context: context({ text }) })).context.text, 'a'.repeat(139) + '🌿')
  const emoji = '🌿'.repeat(140)
  t.is(makeIntent(intent({ context: context({ text: emoji }) })).context.text, emoji, 'exact boundary stays whole')
})

test('makeIntent normalizes absent preview text to empty', async (t) => {
  const { makeIntent } = await load()
  for (const text of [undefined, null, 42]) {
    t.is(makeIntent(intent({ context: context({ text }) })).context.text, '')
  }
})

test('makeIntent always returns a boolean hasMedia', async (t) => {
  const { makeIntent } = await load()
  for (const [hasMedia, expected] of [[true, true], [false, false], [undefined, false], [null, false], [1, true]]) {
    t.is(makeIntent(intent({ context: context({ hasMedia }) })).context.hasMedia, expected)
  }
})

test('makeIntent never carries a post reference into DM replyTo', async (t) => {
  const { makeIntent } = await load()
  const result = makeIntent(intent({ replyTo: AUTHOR + ':1', context: context({ replyTo: AUTHOR + ':2' }) }))
  t.is(Object.hasOwn(result, 'replyTo'), false)
  t.is(Object.hasOwn(result.context, 'replyTo'), false)
})

test('validIntent accepts null context and a valid public post context', async (t) => {
  const { validIntent } = await load()
  t.is(validIntent(intent(), OWN), true)
  t.is(validIntent(intent({ context: context() }), OWN), true)
  t.is(validIntent(intent({ context: context({ seq: Number.MAX_SAFE_INTEGER }) }), OWN), true)
})

test('validIntent rejects non-objects and arrays', async (t) => {
  const { validIntent } = await load()
  for (const value of [null, undefined, false, 42, 'text', Object.assign([], intent())]) {
    t.is(validIntent(value, OWN), false)
  }
})

test('validIntent rejects a missing or empty id', async (t) => {
  const { validIntent } = await load()
  for (const id of [undefined, null, '']) t.is(validIntent(intent({ id }), OWN), false)
})

test('validIntent requires a lowercase hex64 peer', async (t) => {
  const { validIntent } = await load()
  for (const peer of [PEER.toUpperCase(), 'g'.repeat(64), PEER.slice(1), PEER + '0', PEER + '\n', null, undefined, [PEER], 1]) {
    t.is(validIntent(intent({ peer }), OWN), false)
  }
})

test('validIntent rejects replying privately to oneself', async (t) => {
  const { validIntent } = await load()
  t.is(validIntent(intent({ peer: OWN }), OWN), false)
})

test('validIntent requires an object context or explicit null', async (t) => {
  const { validIntent } = await load()
  for (const value of [undefined, false, 1, 'text', Object.assign([], context())]) {
    t.is(validIntent(intent({ context: value }), OWN), false)
  }
})

test('validIntent requires a lowercase hex64 context author', async (t) => {
  const { validIntent } = await load()
  for (const author of [AUTHOR.toUpperCase(), 'g'.repeat(64), AUTHOR.slice(1), AUTHOR + '0', AUTHOR + '\n', null, undefined, [AUTHOR], 1]) {
    t.is(validIntent(intent({ context: context({ author }) }), OWN), false)
  }
})

test('validIntent requires a positive safe integer post seq', async (t) => {
  const { validIntent } = await load()
  for (const seq of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, '1', undefined, null]) {
    t.is(validIntent(intent({ context: context({ seq }) }), OWN), false)
  }
})

test('composeText stays empty until the person types non-whitespace text', async (t) => {
  const { composeText } = await load()
  for (const typed of ['', ' \n\t ', undefined, null, 42]) {
    t.is(composeText(context(), typed), '')
    t.is(composeText(null, typed), '')
  }
})

test('composeText names the post by its words and an absolute date', async (t) => {
  const { composeText } = await load()
  t.is(composeText(context(), 'Que bonito!', NOW), 'Sobre a sua publicação "Uma publicação" (15 jan 2020): Que bonito!')
  const thisYear = new Date(new Date(NOW).getFullYear(), 10, 5, 12).toISOString()
  t.is(composeText(context({ at: thisYear }), 'Oi', NOW), 'Sobre a sua publicação "Uma publicação" (5 nov): Oi')
})

test('composeText preserves typed text without context', async (t) => {
  const { composeText } = await load()
  t.is(composeText(null, '  Olá!\n '), '  Olá!\n ')
})

test('composeText drops an invalid date instead of inserting raw peer text', async (t) => {
  const { composeText } = await load()
  t.is(composeText(context({ at: 'not a date' }), 'Olá!', NOW), 'Sobre a sua publicação "Uma publicação": Olá!')
  t.is(composeText(context({ at: 'not a date', text: '', hasMedia: true }), 'Olá!', NOW), 'Sobre a sua foto: Olá!')
  t.is(composeText(context({ at: 'not a date', text: '' }), 'Olá!', NOW), 'Sobre a sua publicação: Olá!')
})

test('composeText says foto for a photo-only post and publicação for an empty one', async (t) => {
  const { composeText } = await load()
  t.is(composeText(context({ text: '', hasMedia: true }), 'Oi', NOW), 'Sobre a sua foto (15 jan 2020): Oi')
  t.is(composeText(context({ text: ' \n ', hasMedia: true }), 'Oi', NOW), 'Sobre a sua foto (15 jan 2020): Oi')
  t.is(composeText(context({ text: '' }), 'Oi', NOW), 'Sobre a sua publicação (15 jan 2020): Oi')
  t.is(composeText(context({ text: 'Legenda', hasMedia: true }), 'Oi', NOW), 'Sobre a sua publicação "Legenda" (15 jan 2020): Oi')
})

test('composeText puts the excerpt on one line and cuts it at 60 code points', async (t) => {
  const { composeText } = await load()
  t.is(composeText(context({ text: '  Linha um\n\n  linha\tdois  ' }), 'Oi', NOW), 'Sobre a sua publicação "Linha um linha dois" (15 jan 2020): Oi')
  const exact = 'a'.repeat(59) + '🌿'
  t.is(composeText(context({ text: exact }), 'Oi', NOW), 'Sobre a sua publicação "' + exact + '" (15 jan 2020): Oi', 'exactly 60 stays whole')
  t.is(composeText(context({ text: exact + 'z' }), 'Oi', NOW), 'Sobre a sua publicação "' + exact + '…" (15 jan 2020): Oi', 'cut without splitting the emoji')
})

test('composeText replaces unsafe characters of the post text', async (t) => {
  const { composeText } = await load()
  t.is(composeText(context({ text: 'a\u202eb' }), 'Oi', NOW), 'Sobre a sua publicação "a\ufffdb" (15 jan 2020): Oi')
})

test('composeText never embeds the post reference and leaves the context alone', async (t) => {
  const { composeText } = await load()
  const input = Object.freeze(context({ hasMedia: true }))
  const text = composeText(input, 'Olá!', NOW)
  t.is(text.includes(AUTHOR), false)
  t.is(text.endsWith(': Olá!'), true)
  t.alike(input, context({ hasMedia: true }))
})

test('composeText does not drift with time: never agora, ontem or minutes', async (t) => {
  const { composeText } = await load()
  const at = Date.parse(AT)
  const expected = 'Sobre a sua publicação "Uma publicação" (15 jan): Oi'
  for (const later of [0, 5 * 60000, 2 * 3600000, 26 * 3600000, 40 * 86400000]) {
    t.is(composeText(context(), 'Oi', at + later), expected)
  }
  const originalNow = Date.now
  Date.now = () => at + 26 * 3600000
  try {
    t.is(composeText(context(), 'Oi'), expected, 'the default clock gives the same text')
  } finally {
    Date.now = originalNow
  }
})

test('contextLabel matches the absolute date of the text sent', async (t) => {
  const { contextLabel, contextDate } = await load()
  t.is(contextLabel(context(), NOW), 'Sobre a sua publicação de 15 jan 2020')
  t.is(contextLabel(context({ text: '', hasMedia: true }), NOW), 'Sobre a sua foto de 15 jan 2020')
  t.is(contextLabel(context({ at: 'x' }), NOW), 'Sobre a sua publicação')
  t.is(contextLabel(null, NOW), '')
  t.is(contextDate(AT, Date.parse(AT) + 26 * 3600000), '15 jan')
  t.is(contextDate(AT, NOW), '15 jan 2020')
  t.is(contextDate(undefined, NOW), null)
})

test('a moment context keeps its kind and says momento, posts keep their wording', async (t) => {
  const { makeIntent, validIntent, contextLabel, composeText } = await load()
  const moment = context({ kind: 'moment', text: 'Pôr do sol', hasMedia: true })
  const kept = makeIntent(intent({ context: moment }))
  t.is(kept.context.kind, 'moment', 'makeIntent keeps kind moment')
  t.ok(validIntent(kept, OWN), 'a moment intent is valid')
  t.absent('kind' in makeIntent(intent({ context: context() })).context, 'a post context has no kind')
  t.absent('kind' in makeIntent(intent({ context: context({ kind: 'other' }) })).context, 'an unknown kind is dropped')
  t.absent(validIntent(intent({ context: context({ kind: 'other' }) }), OWN), 'an unknown kind is not valid')
  t.is(contextLabel(kept.context, NOW), 'Sobre o seu momento de 15 jan 2020')
  t.is(contextLabel({ ...kept.context, at: 'x' }, NOW), 'Sobre o seu momento')
  t.is(composeText(kept.context, 'Lindo!', NOW), 'Sobre o seu momento "Pôr do sol" (15 jan 2020): Lindo!')
  t.is(composeText({ ...kept.context, text: '' }, 'Oi', NOW), 'Sobre o seu momento (15 jan 2020): Oi')
  t.is(composeText({ ...kept.context, text: '', at: 'x' }, 'Oi', NOW), 'Sobre o seu momento: Oi')
  t.is(contextLabel(context({ text: '', hasMedia: true }), NOW), 'Sobre a sua foto de 15 jan 2020', 'posts unchanged')
  t.is(composeText(context(), 'Oi', NOW), 'Sobre a sua publicação "Uma publicação" (15 jan 2020): Oi', 'posts unchanged')
})

test('MAX_TEXT is the 1000 code point DM text limit', async (t) => {
  const { MAX_TEXT } = await load()
  t.is(MAX_TEXT, 1000)
})

test('composeText caps plain text without splitting surrogate pairs', async (t) => {
  const { composeText } = await load()
  t.is(composeText(null, 'a'.repeat(999) + '🌿z'), 'a'.repeat(999) + '🌿')
  t.is(composeText(null, '🌿'.repeat(1000)), '🌿'.repeat(1000))
})

test('composeText includes the prefix within the total cap', async (t) => {
  const { composeText } = await load()
  const prefix = 'Sobre a sua publicação "Uma publicação" (15 jan 2020): '
  const budget = 1000 - Array.from(prefix).length
  t.is(composeText(context(), '🌿'.repeat(1001), NOW), prefix + '🌿'.repeat(budget))
  t.is(composeText(context(), 'a'.repeat(budget - 1) + '🌿z', NOW), prefix + 'a'.repeat(budget - 1) + '🌿')
})

test('makeIntent tolerates no argument', async (t) => {
  const { makeIntent, validIntent } = await load()
  t.is(validIntent(makeIntent(), 'a'.repeat(64)), false)
})

test('an offer intent keeps only the listing reference and title', async (t) => {
  const { makeIntent, validIntent } = await load()
  const offer = Object.freeze({ author: PEER, seq: 7, title: 'Bicicleta', text: 'Unused', photos: ['unused'] })
  const result = makeIntent(intent({ offer }))
  t.alike(result.offer, { author: PEER, seq: 7, title: 'Bicicleta' })
  t.not(result.offer, offer)
  t.ok(validIntent(result, OWN))
  t.ok(validIntent(makeIntent(intent({ offer: { ...offer, seq: Number.MAX_SAFE_INTEGER } })), OWN))
  t.is(result.context, null)
})

test('offer titles are capped in code points and default to empty', async (t) => {
  const { makeIntent, validIntent } = await load()
  const offer = { author: PEER, seq: 7 }
  const title = 'a'.repeat(139) + '🌿'
  t.is(makeIntent(intent({ offer: { ...offer, title: title + 'z' } })).offer?.title, title)
  t.is(makeIntent(intent({ offer: { ...offer, title: '🌿'.repeat(140) } })).offer?.title, '🌿'.repeat(140))
  for (const title of [undefined, null, 42]) {
    const result = makeIntent(intent({ offer: { ...offer, title } }))
    t.is(result.offer?.title, '')
    t.ok(validIntent(result, OWN))
  }
})

test('an offer intent rejects another seller and malformed references', async (t) => {
  const { makeIntent, validIntent } = await load()
  const offer = { author: PEER, seq: 7, title: 'Bicicleta' }
  const bad = [false, 42, 'listing', Object.assign([], offer)]
  for (const author of [AUTHOR, OWN, PEER.toUpperCase(), 'g'.repeat(64), PEER.slice(1), null, undefined]) bad.push({ ...offer, author })
  for (const seq of [0, -1, 1.5, '7', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, undefined]) bad.push({ ...offer, seq })
  for (const value of bad) {
    t.absent(validIntent(intent({ offer: value }), OWN))
    t.absent(validIntent(makeIntent(intent({ offer: value })), OWN))
  }
  for (const title of [undefined, null, 42, []]) t.absent(validIntent(intent({ offer: { ...offer, title } }), OWN))
  t.absent(validIntent(intent({ context: context(), offer }), OWN), 'context and offer cannot travel together')
  t.absent(validIntent(makeIntent(intent({ context: context(), offer })), OWN))
})

test('old intents without an offer remain valid', async (t) => {
  const { makeIntent, validIntent } = await load()
  t.absent(Object.hasOwn(intent(), 'offer'))
  t.ok(validIntent(intent(), OWN))
  t.ok(validIntent(intent({ context: context() }), OWN))
  t.ok(validIntent(intent({ offer: null }), OWN))
  t.is(makeIntent(intent()).offer, null)
})

test('sendAttempt keeps the held composed text for the same draft and chip', async (t) => {
  const { composeText, sendAttempt } = await load()
  const { sendPlan } = await import('../src/dm-screen.js')
  const ctx = context()
  const held = composeText(ctx, 'Oi', Date.parse(AT))
  const hold = { text: held, quoteId: null, typed: 'Oi', ctx }
  // Across New Year the same chip composes a different text (the year appears).
  const later = composeText(ctx, 'Oi', NOW)
  t.not(later, held)
  t.is(sendAttempt(hold, 'Oi', ctx, later), held)
  t.is(sendPlan(hold, sendAttempt(hold, 'Oi', ctx, later), null), 'retry', 'an unchanged draft is a retry')
  t.is(sendAttempt(hold, 'Oi!', ctx, 'x'), 'x', 'a changed draft is a new text')
  t.is(sendPlan(hold, sendAttempt(hold, 'Oi!', ctx, composeText(ctx, 'Oi!', NOW)), null), 'confirm')
  t.is(sendAttempt(hold, 'Oi', null, 'Oi'), 'Oi', 'a removed chip is a new text')
  t.is(sendAttempt(null, 'Oi', ctx, later), later, 'no hold: the composed text')
})

test('the excerpt drops links, so the link the person types keeps its preview', async (t) => {
  const { composeText, contextExcerpt } = await load()
  const { previewTarget } = await import('../src/preview.js')
  t.is(contextExcerpt('Veja https://example.org/agenda hoje'), 'Veja hoje')
  t.is(contextExcerpt('www.example.org'), '')
  t.is(contextExcerpt('Veja\u202fhttps://example.org/agenda'), 'Veja', 'a link behind a narrow no-break space is found too')
  t.is(contextExcerpt('Veja\nwww.example.org\thoje'), 'Veja hoje')
  t.is(contextExcerpt('Uma seleção de músicas para a tarde: https://example.org/musica'), 'Uma seleção de músicas para a tarde', 'no dangling colon')
  const sent = composeText({ author: 'a'.repeat(64), seq: 3, at: '2026-11-05T15:00:00.000Z', text: 'Agenda: https://example.org/agenda', hasMedia: false }, 'Olha https://example.com/mapa', Date.parse('2026-11-07T15:00:00.000Z'))
  t.is(previewTarget(sent), 'https://example.com/mapa', 'the first link of the sent text is the typed one')
})
