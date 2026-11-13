// Momentos pure module (moments.js): strip order, navigation, reply context.
'use strict'

const test = require('brittle')
const load = () => import('../src/moments.js')
const loadReaction = () => import('../src/momentReaction.js')

const OWN = 'aa'.repeat(32)
const A = 'bb'.repeat(32)
const B = 'cc'.repeat(32)
const C = 'dd'.repeat(32)
const item = (seq, ref) => ({ seq, ref: ref || 'ref' + seq, text: 't', at: '2026-11-07T10:00:00.000Z', media: {} })
const who = (author, ...items) => ({ author, items })

test('ringOrder: own first, then unseen, then seen, stable inside groups', async (t) => {
  const { ringOrder } = await load()
  const authors = [who(A, item(1)), who(OWN, item(2)), who(B, item(3)), who(C, item(4))]
  const seen = new Set(['ref1', 'ref4'])
  t.alike(ringOrder(authors, seen, OWN).map((a) => a.author), [OWN, B, A, C])
})

test('ringOrder: ownKey absent, empty and all seen', async (t) => {
  const { ringOrder } = await load()
  const authors = [who(A, item(1)), who(B, item(2))]
  t.alike(ringOrder(authors, new Set(), undefined).map((a) => a.author), [A, B])
  t.alike(ringOrder(authors, new Set(), OWN).map((a) => a.author), [A, B])
  t.alike(ringOrder([], new Set(), OWN), [])
  t.alike(ringOrder(null, new Set(), OWN), [])
  t.alike(ringOrder(authors, ['ref1', 'ref2'], OWN).map((a) => a.author), [A, B])
  t.alike(ringOrder([who(A, item(1)), who(B, item(2))], ['ref1'], OWN).map((a) => a.author), [B, A])
})

test('ringOrder: an author with one unseen of several stays unseen; empty items count as seen', async (t) => {
  const { ringOrder } = await load()
  const authors = [who(A), who(B, item(1), item(2))]
  t.alike(ringOrder(authors, new Set(['ref1']), OWN).map((a) => a.author), [B, A])
})

test('seenKey', async (t) => {
  const { seenKey } = await load()
  t.is(seenKey('abc'), 'abc')
  t.is(seenKey(null), '')
  t.is(seenKey(5), '')
})

test('firstUnseenIndex', async (t) => {
  const { firstUnseenIndex } = await load()
  const items = [item(1), item(2), item(3)]
  t.is(firstUnseenIndex(items, new Set()), 0)
  t.is(firstUnseenIndex(items, new Set(['ref1'])), 1)
  t.is(firstUnseenIndex(items, new Set(['ref1', 'ref2'])), 2)
  t.is(firstUnseenIndex(items, new Set(['ref1', 'ref2', 'ref3'])), 0)
  t.is(firstUnseenIndex([], new Set()), 0)
  t.is(firstUnseenIndex(undefined, new Set()), 0)
})

test('nextIndex: steps and both ends', async (t) => {
  const { nextIndex } = await load()
  t.is(nextIndex(0, 3, 'next'), 1)
  t.is(nextIndex(1, 3, 'prev'), 0)
  t.is(nextIndex(2, 3, 'next'), null)
  t.is(nextIndex(0, 3, 'prev'), null)
  t.is(nextIndex(0, 0, 'next'), null)
  t.is(nextIndex(0, 1, 'next'), null)
  t.is(nextIndex(0, 3, 'up'), null)
  t.is(nextIndex(-1, 3, 'next'), null)
})

test('replyContext matches the openMessage context shape', async (t) => {
  const { replyContext } = await load()
  const moment = item(7)
  t.alike(replyContext(moment, A), { kind: 'moment', author: A, seq: 7, at: moment.at, text: 't', hasMedia: true })
  const { makeIntent, validIntent } = await import('../src/privateReply.js')
  const intent = makeIntent({ id: 'x', peer: A, from: 'rua', context: replyContext(moment, A) })
  t.alike(intent.context, replyContext(moment, A))
  t.ok(validIntent(intent, OWN))
})

test('canReply only for hosted === true', async (t) => {
  const { canReply } = await load()
  t.is(canReply({ hosted: true }), true)
  t.is(canReply({ hosted: false }), false)
  t.is(canReply({ hosted: 'true' }), false)
  t.is(canReply({}), false)
  t.is(canReply(null), false)
})

test('expiresIn: 24 h boundary', async (t) => {
  const { expiresIn, MOMENT_MS } = await load()
  const at = '2026-11-07T10:00:00.000Z'
  const start = Date.parse(at)
  t.is(MOMENT_MS, 86400000)
  t.is(expiresIn(at, start), MOMENT_MS)
  t.is(expiresIn(at, start + MOMENT_MS - 1), 1)
  t.is(expiresIn(at, start + MOMENT_MS), 0)
  t.is(expiresIn(at, start + MOMENT_MS + 1), 0)
  t.is(expiresIn('nope', start), 0)
})

test('progressOf', async (t) => {
  const { progressOf } = await load()
  t.alike(progressOf(0, 3), [0, 0, 0])
  t.alike(progressOf(2, 3), [1, 1, 0])
  t.alike(progressOf(0, 0), [])
})

test('momentMusicOf accepts wire and cleaned references and copies only id and start', async (t) => {
  const { momentMusicOf } = await load()
  for (const id of ['a', 'aB19', 'Z'.repeat(32)]) {
    for (const start of [0, 1, 7200]) {
      const music = { p: 'audius', id, start }
      const clean = momentMusicOf({ music })
      t.alike(clean, { id, start })
      t.alike(momentMusicOf({ music: clean }), clean, 'cleaning is idempotent')
      t.not(clean, music)
      t.alike(music, { p: 'audius', id, start }, 'input unchanged')
    }
  }
})

test('momentMusicOf refuses malformed references and holdMsOf extends only actual music playback', async (t) => {
  const { momentMusicOf, holdMsOf, MUSIC_HOLD_MS, AUTO_ADVANCE_MS } = await load()
  const valid = { p: 'audius', id: 'Ab12', start: 30 }
  const invalid = [null, undefined, [], 'abc', {}, { id: 'abc' }, { start: 0 },
    ...['', 'a'.repeat(33), 'a-b', 'a/b', 'é', 1].map((id) => ({ ...valid, id })),
    ...[-1, 7201, 1.5, NaN, Infinity, '30', null, undefined].map((start) => ({ ...valid, start })),
    ...['other', null, undefined].map((p) => ({ ...valid, p })),
    { ...valid, url: '/audio' }, Object.assign(new Date(), valid)]
  for (const music of invalid) {
    t.is(momentMusicOf({ music }), null)
    t.is(holdMsOf({ music }, true), AUTO_ADVANCE_MS)
  }
  t.is(momentMusicOf(null), null)
  t.is(momentMusicOf({}), null)
  t.is(holdMsOf(null, true), AUTO_ADVANCE_MS)
  t.is(MUSIC_HOLD_MS, 15000)
  for (const music of [valid, { id: 'Ab12', start: 30 }]) {
    t.is(holdMsOf({ music }, true), MUSIC_HOLD_MS)
    for (const playing of [false, undefined, null, 1, 'true']) t.is(holdMsOf({ music }, playing), AUTO_ADVANCE_MS)
  }
})

test('segmentMs: a photo auto-advances, a video lasts its clamped duration', async (t) => {
  const { segmentMs, AUTO_ADVANCE_MS } = await load()
  const photo = { ...item(1), media: { mime: 'image/jpeg', w: 10, h: 10 } }
  const video = (ms) => ({ ...item(2), media: { mime: 'video/mp4', w: 640, h: 360, ms } })
  t.is(segmentMs(photo), AUTO_ADVANCE_MS)
  t.is(segmentMs(photo, 12000), AUTO_ADVANCE_MS, 'a measured time never stretches a photo')
  t.is(segmentMs(item(3)), AUTO_ADVANCE_MS, 'no mime is a photo')
  t.is(segmentMs(null), AUTO_ADVANCE_MS)
  t.is(segmentMs({}), AUTO_ADVANCE_MS)
  t.is(segmentMs(video(8000), 7400), 7400, 'the measured duration')
  t.is(segmentMs(video(8000)), 8000, 'the declared one before the player measured')
  t.is(segmentMs(video(8000), NaN), 8000)
  t.is(segmentMs(video(8000), 0), 8000)
  t.is(segmentMs(video(8000), 7400.6), 7401)
  t.is(segmentMs(video(8000), 200), 1000, 'at least one second')
  t.is(segmentMs(video(8000), 60000), 15000, 'at most MAX_MOMENT_VIDEO_MS')
  t.is(segmentMs(video(8000), Infinity), 8000)
  t.is(segmentMs(video(99999)), 15000)
  t.is(segmentMs(video(undefined)), 15000, 'nothing known: the cap')
})

test('moment music is photo only, including GIF, even when a video record carries music', async (t) => {
  const { momentMusicOf, holdMsOf, segmentMs, MUSIC_HOLD_MS } = await load()
  for (const music of [{ p: 'audius', id: 'Ab12', start: 30 }, { id: 'Ab12', start: 30 }]) {
    for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'image/gif']) {
      const photo = { media: { mime }, music }
      t.alike(momentMusicOf(photo), { id: 'Ab12', start: 30 })
      t.is(holdMsOf(photo, true), MUSIC_HOLD_MS)
    }
    const video = { media: { mime: 'video/mp4', ms: 8000 }, music }
    t.is(momentMusicOf(video), null)
    t.is(segmentMs(video, 7400), 7400, 'music cannot extend the video segment')
    t.alike(video.music, music, 'ignoring music does not change the record')
  }
})

test('canReact requires hosted, online and an unlocked passkey', async (t) => {
  const { canReact } = await loadReaction()
  const node = { hosted: true, online: true, passkey: { status: { unlocked: true } } }
  t.is(canReact(node), true)
  for (const value of [false, undefined, null, 1, 'true']) {
    t.is(canReact({ ...node, hosted: value }), false)
    t.is(canReact({ ...node, online: value }), false)
    t.is(canReact({ ...node, passkey: { status: { unlocked: value } } }), false)
  }
  for (const value of [null, undefined, {}, { ...node, passkey: null }, { ...node, passkey: {} }]) {
    t.is(canReact(value), false)
  }
})

test('reactionParams copies only the recipient, emoji and safe moment sequence', async (t) => {
  const { reactionParams } = await loadReaction()
  for (const emoji of ['❤️', '😂', '😮', '😢', '🔥', '👏']) {
    t.alike(reactionParams(item(7), A, emoji), { to: A, text: emoji, moment: 7 })
  }
  t.alike(reactionParams({ seq: Number.MAX_SAFE_INTEGER }, A, '🔥'), { to: A, text: '🔥', moment: Number.MAX_SAFE_INTEGER })
  for (const emoji of ['oi', '', '🔥🔥', '🔥\u202e', null, undefined]) t.is(reactionParams(item(7), A, emoji), null)
  for (const seq of [0, -1, 1.5, '7', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, undefined]) {
    t.is(reactionParams({ seq }, A, '🔥'), null)
  }
  for (const author of ['', 'a'.repeat(63), 'g'.repeat(64), A.toUpperCase(), null, 7]) {
    t.is(reactionParams(item(7), author, '🔥'), null)
  }
  t.is(reactionParams(null, A, '🔥'), null)
})

test('isMomentReaction requires a safe sequence and raw emoji text', async (t) => {
  const { isMomentReaction } = await loadReaction()
  t.is(isMomentReaction({ moment: 1, rawText: '🔥' }), true)
  t.is(isMomentReaction({ moment: Number.MAX_SAFE_INTEGER, rawText: '❤️' }), true)
  for (const row of [null, undefined, {}, { rawText: '🔥' }, { moment: 1, text: '🔥' },
    { moment: 1, rawText: 'oi' }, { moment: 1, rawText: '' }, { moment: 1, rawText: '🔥\u202e' }]) {
    t.is(isMomentReaction(row), false)
  }
  for (const moment of [0, -1, 1.5, '1', Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    t.is(isMomentReaction({ moment, rawText: '🔥' }), false)
  }
})

test('moment reaction authors and labels follow the message direction', async (t) => {
  const { momentAuthor, reactionLabel, REACTION_SENT, REACTION_UNSURE, MOMENT_GONE } = await loadReaction()
  t.is(momentAuthor({ mine: true }, { peer: A, ownKey: OWN }), A)
  t.is(momentAuthor({ mine: false }, { peer: A, ownKey: OWN }), OWN)
  t.is(reactionLabel(true), 'Você reagiu a um momento')
  t.is(reactionLabel(false), 'Reagiu ao seu momento')
  t.is(REACTION_SENT, 'Reação enviada.')
  t.is(REACTION_UNSURE, 'Não deu para confirmar o envio. Confira a conversa antes de tentar de novo.')
  t.is(MOMENT_GONE, 'Momento indisponível')
})

test('unsure recognizes both uncertain send signals', async (t) => {
  const { unsure } = await loadReaction()
  const { UNSURE_SEND } = await import('../src/dm.js')
  t.is(unsure({ uncertain: true }), true)
  t.is(unsure(new Error(UNSURE_SEND)), true)
  t.is(unsure({ uncertain: false, message: UNSURE_SEND }), true)
  for (const err of [new Error('falhou'), { uncertain: 'true' }, { uncertain: 1 }, {}, null, undefined]) {
    t.is(unsure(err), false)
  }
})

test('previewPlan separates supported images from MP4 video', async (t) => {
  const { previewPlan } = await loadReaction()
  const lookup = { w: 640, h: 360, ms: 0, at: '2026-11-07T10:00:00.000Z' }
  for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'image/gif']) {
    t.alike(previewPlan({ ...lookup, mime }), { kind: 'image' })
  }
  t.alike(previewPlan({ ...lookup, mime: 'video/mp4', ms: 8000 }), { kind: 'video' })
})

test('previewPlan drops failed, unsupported and malformed lookups', async (t) => {
  const { previewPlan } = await loadReaction()
  const lookup = { mime: 'image/jpeg', w: 640, h: 360, ms: 0, at: '2026-11-07T10:00:00.000Z' }
  for (const value of [null, undefined, false, [], {}, new Error('gone'), { mime: 'image/jpeg' },
    { ...lookup, mime: 'image/svg+xml' }, { ...lookup, mime: 'video/webm' },
    { ...lookup, mime: 7 }, { ...lookup, w: 0 }, { ...lookup, h: '360' },
    { ...lookup, w: 1.5 }, { ...lookup, at: 'soon' }, { ...lookup, at: NaN }, { ...lookup, at: 1794045600000 },
    { ...lookup, ms: 1 }, { ...lookup, mime: 'video/mp4', ms: 0 },
    { ...lookup, mime: 'video/mp4', ms: Infinity }]) {
    t.alike(previewPlan(value), { kind: 'gone' })
  }
  for (const field of ['mime', 'w', 'h', 'ms', 'at']) {
    const missing = { ...lookup }
    delete missing[field]
    t.alike(previewPlan(missing), { kind: 'gone' })
  }
})

test('previewUntil expires exactly 24 hours after a safe lookup timestamp', async (t) => {
  const { previewUntil } = await loadReaction()
  const { MOMENT_MS } = await load()
  const at = '2026-11-13T12:00:00.000Z'
  t.is(previewUntil({ at }), Date.parse(at) + MOMENT_MS)
  for (const at of [1794045600000, 0, 'soon', '', null, undefined, NaN, Infinity]) {
    t.is(previewUntil({ at }), null)
  }
  t.is(previewUntil(null), null)
  t.is(previewUntil(undefined), null)
})
