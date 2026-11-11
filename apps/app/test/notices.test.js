'use strict'

const test = require('brittle')
const load = () => import('../src/notices.js')
const item = (key, seq, at = 1) => Object.freeze({ key, seq, at, name: 'Ana', username: 'ana' })

test('the fixed texts are the approved Portuguese', async (t) => {
  const {
    EMPTY_TITLE,
    EMPTY_TEXT,
    NOTICES_WEB_ONLY_MESSAGE,
    NOTICES_OFFLINE_MESSAGE,
    NOTICES_UNSUPPORTED_MESSAGE,
    ACTIVITY_QUIET_TEXT,
    NOTICES_INCOMPLETE_TEXT,
    SEEN_STORAGE_KEY,
    NOTICES_POLL_MS,
    NOTICES_FIRST_READ_QUIET_MS,
    SEEN_MAX
  } = await load()
  t.is(EMPTY_TITLE, 'Ninguém novo por aqui')
  t.is(EMPTY_TEXT, 'Quando alguém começar a seguir você, responder, citar, mencionar você, curtir ou republicar uma publicação sua, aparece aqui.')
  t.is(NOTICES_WEB_ONLY_MESSAGE, 'Nesta versão, os Avisos só funcionam na versão web no site da associação.')
  t.is(NOTICES_OFFLINE_MESSAGE, 'Confira sua internet.')
  t.is(NOTICES_UNSUPPORTED_MESSAGE, 'Os Avisos ainda não estão disponíveis nesta associação.')
  t.is(ACTIVITY_QUIET_TEXT, 'O semeador desta associação ainda só envia avisos de quem seguiu você.')
  t.is(NOTICES_INCOMPLETE_TEXT, 'Alguns avisos ainda podem chegar.')
  t.is(SEEN_STORAGE_KEY, 'varanda-notices-seen')
  t.is(NOTICES_POLL_MS, 300000)
  t.is(NOTICES_FIRST_READ_QUIET_MS, 1000)
  t.is(SEEN_MAX, 2048)
})

test('notice lines name the person or say someone, and never carry a key', async (t) => {
  const { noticeLine } = await load()
  const key = 'ab'.repeat(32)
  const hexRun = /[0-9a-f]{6,}/i
  const lines = [
    noticeLine(Object.freeze({ title: 'Bia', subtitle: '@bia', avatarName: 'Bia', known: true, key, seq: 12 })),
    noticeLine(Object.freeze({ title: 'sem nome', subtitle: null, avatarName: null, known: true, key, seq: 12 })),
    noticeLine(Object.freeze({ title: '', key, seq: 4 })),
    noticeLine(Object.freeze({ title: null, key })),
    noticeLine(Object.freeze({ title: undefined, key })),
    noticeLine(Object.freeze({ title: 7, key })),
    noticeLine(Object.freeze({ title: 'João da Silva', key, seq: 3 }))
  ]
  t.is(lines[0], 'Bia começou a seguir você')
  t.is(lines[1], 'Alguém começou a seguir você')
  t.is(lines[2], 'Alguém começou a seguir você')
  t.is(lines[3], 'Alguém começou a seguir você')
  t.is(lines[4], 'Alguém começou a seguir você')
  t.is(lines[5], 'Alguém começou a seguir você')
  t.is(lines[6], 'João da Silva começou a seguir você')
  for (const line of lines) {
    t.is(hexRun.test(line), false, line)
    t.is(/\d/.test(line), false, line)
    t.is(line.includes(key), false, line)
    t.is(line.includes(key.slice(0, 6)), false, line)
  }
})

test('notice lines follow the kind, and the default kind is a follow', async (t) => {
  const { noticeLine } = await load()
  const key = 'ab'.repeat(32)
  const who = Object.freeze({ title: 'Bia', subtitle: '@bia', key, seq: 12 })
  t.is(noticeLine(who, 'mention'), 'Bia mencionou você')
  t.is(noticeLine(who, 'reply'), 'Bia respondeu à sua publicação')
  t.is(noticeLine(who, 'quote'), 'Bia citou sua publicação')
  t.is(noticeLine(who, 'like'), 'Bia curtiu sua publicação')
  t.is(noticeLine(who, 'repost'), 'Bia republicou sua publicação')
  t.is(noticeLine(who, 'follow'), 'Bia começou a seguir você')
  t.is(noticeLine({ title: 'Bia' }), 'Bia começou a seguir você')
  t.is(noticeLine({ title: 'sem nome' }, 'reply'), 'Alguém respondeu à sua publicação')
  t.is(noticeLine({ title: 'sem nome' }, 'quote'), 'Alguém citou sua publicação')
  t.is(noticeLine({ title: 'sem nome' }, 'mention'), 'Alguém mencionou você')
  t.is(noticeLine({ title: 'sem nome' }, 'like'), 'Alguém curtiu sua publicação')
  t.is(noticeLine({ title: 'sem nome' }, 'repost'), 'Alguém republicou sua publicação')
  t.is(noticeLine({ title: '' }, 'quote'), 'Alguém citou sua publicação')
  t.is(noticeLine({ title: 'Bia' }, 'pin'), 'Bia começou a seguir você', 'an unknown kind reads as a follow')
  for (const kind of ['follow', 'reply', 'quote', 'mention', 'like', 'repost']) {
    const line = noticeLine(who, kind)
    t.is(line.includes(key), false, line)
    t.is(line.includes('@bia'), false, line)
  }
})

test('noticeParts is the name and the rest of the line, and the two join back into it', async (t) => {
  const { noticeParts, noticeLine } = await load()
  const bia = Object.freeze({ title: 'Bia' })
  const rests = {
    follow: ' começou a seguir você',
    reply: ' respondeu à sua publicação',
    quote: ' citou sua publicação',
    mention: ' mencionou você',
    like: ' curtiu sua publicação',
    repost: ' republicou sua publicação'
  }
  for (const kind of ['follow', 'reply', 'quote', 'mention', 'like', 'repost']) {
    const parts = noticeParts(bia, kind)
    t.is(parts.name, 'Bia', kind)
    t.is(parts.rest, rests[kind], kind)
    t.is(parts.name + parts.rest, noticeLine(bia, kind), kind)
    const someone = noticeParts(Object.freeze({ title: 'sem nome' }), kind)
    t.is(someone.name, 'Alguém', kind)
    t.is(someone.rest, rests[kind], kind)
    t.is(someone.name + someone.rest, noticeLine({ title: 'sem nome' }, kind), kind)
  }
  for (const title of ['', null, undefined, 7]) {
    const parts = noticeParts(Object.freeze({ title }))
    t.is(parts.name, 'Alguém')
    t.is(parts.name + parts.rest, noticeLine({ title }))
  }
  t.is(noticeParts(bia).name + noticeParts(bia).rest, noticeLine(bia), 'the default kind is a follow')
  const pin = noticeParts(bia, 'pin')
  t.is(pin.rest, ' começou a seguir você')
  t.is(pin.name + pin.rest, noticeLine(bia, 'pin'), 'an unknown kind still joins into the line')
})

test('noticeIcon is the avatar glyph for each kind and null for an unknown one', async (t) => {
  const { noticeIcon } = await load()
  t.is(noticeIcon('follow'), 'seguir')
  t.is(noticeIcon('reply'), 'resposta')
  t.is(noticeIcon('quote'), 'citar')
  t.is(noticeIcon('mention'), 'at-sign')
  t.is(noticeIcon('like'), 'coracao')
  t.is(noticeIcon('repost'), 'republicar')
  t.is(noticeIcon('pin'), null)
  t.is(noticeIcon('FOLLOW'), null)
  t.is(noticeIcon('LIKE'), null)
  t.is(noticeIcon(''), null)
  t.is(noticeIcon(null), null)
  t.is(noticeIcon(undefined), null)
  t.is(noticeIcon(), null)
})

test('noticeKind is the row kind, and a row from an older node reads as a follow', async (t) => {
  const { noticeKind } = await load()
  t.is(noticeKind({ kind: 'follow' }), 'follow')
  t.is(noticeKind({ kind: 'reply' }), 'reply')
  t.is(noticeKind({ kind: 'quote' }), 'quote')
  t.is(noticeKind({ kind: 'mention' }), 'mention')
  t.is(noticeKind({ kind: 'like' }), 'like')
  t.is(noticeKind({ kind: 'repost' }), 'repost')
  t.is(noticeKind({}), 'follow')
  t.is(noticeKind({ kind: undefined }), 'follow')
  t.is(noticeKind({ kind: 'pin' }), 'follow', 'an unknown kind reads as a follow')
  t.is(noticeKind({ kind: 'FOLLOW' }), 'follow')
  t.is(noticeKind({ kind: 'LIKE' }), 'follow')
  t.is(noticeKind(null), 'follow')
})

test('noticeRef is the signed block for a reply, quote or mention, item.post for a like or repost, and null for a follow', async (t) => {
  const { noticeRef } = await load()
  const key = 'ab'.repeat(32)
  const post = 'cd'.repeat(32) + ':7'
  t.is(noticeRef({ key, seq: 5, kind: 'reply' }), key + ':5')
  t.is(noticeRef({ key, seq: 12, kind: 'quote' }), key + ':12')
  t.is(noticeRef({ key, seq: 3, kind: 'mention' }), key + ':3')
  t.is(noticeRef({ key, seq: 5, kind: 'reply', post }), key + ':5', 'a reply ignores post')
  t.is(noticeRef({ key, seq: 5, kind: 'follow' }), null)
  t.is(noticeRef({ key, seq: 5, kind: 'follow', post }), null)
  t.is(noticeRef({ key, seq: 5 }), null, 'a row with no kind is a follow')
  t.is(noticeRef({ key, seq: 5, kind: 'like', post }), post)
  t.is(noticeRef({ key, seq: 9, kind: 'repost', post }), post)
  t.is(noticeRef({ kind: 'like', post: key + ':9007199254740991' }), key + ':9007199254740991')
  t.is(noticeRef({ key, seq: 5, kind: 'like' }), null, 'a like without post returns no ref')
  t.is(noticeRef({ key, seq: 5, kind: 'repost' }), null, 'a repost without post returns no ref')
  t.is(noticeRef({ key, seq: 5, kind: 'like', post: undefined }), null)
  t.is(noticeRef({ key, seq: 5, kind: 'repost', post: null }), null)
  t.is(noticeRef({ key, seq: 5, kind: 'like', post: 7 }), null)
  t.is(noticeRef({ key, seq: 5, kind: 'like', post: key.toUpperCase() + ':7' }), null, 'uppercase hex is not a ref')
  t.is(noticeRef({ key, seq: 5, kind: 'like', post: 'ab'.repeat(31) + ':7' }), null)
  t.is(noticeRef({ key, seq: 5, kind: 'like', post: key + ':0' }), null)
  t.is(noticeRef({ key, seq: 5, kind: 'like', post: key + ':01' }), null, 'a leading zero is not canonical')
  t.is(noticeRef({ key, seq: 5, kind: 'repost', post: key + ':9007199254740992' }), null, 'past the safe integer range')
  t.is(noticeRef({ key, seq: 5, kind: 'like', post: post + ' ' }), null)
  t.is(noticeRef({ key, seq: 5, kind: 'like', post: '' }), null)
})

test('snippetOf quotes the post for every kind but a follow, and is empty when the post is missing', async (t) => {
  const { snippetOf } = await load()
  const text = 'Olá, varanda'
  const key = 'ab'.repeat(32)
  for (const kind of ['reply', 'quote', 'mention', 'like', 'repost']) {
    t.is(snippetOf(Object.freeze({ kind, key }), text), text, kind)
    t.is(snippetOf(Object.freeze({ kind, key })), '', kind + ' with no post text')
    t.is(snippetOf(Object.freeze({ kind, key }), null), '', kind + ' with a null post')
    t.is(snippetOf(Object.freeze({ kind, key }), undefined), '', kind + ' with an undefined post')
    t.is(snippetOf(Object.freeze({ kind, key, post: key + ':7' })), '', kind + ' does not fall back to the ref')
  }
  t.is(snippetOf(Object.freeze({ kind: 'follow', key }), text), '', 'a follow has no post')
  t.is(snippetOf(Object.freeze({ kind: 'follow', key, post: key + ':7' }), text), '')
  t.is(snippetOf(Object.freeze({ key }), text), '', 'a row with no kind is a follow')
  t.is(snippetOf(Object.freeze({ kind: 'pin', key }), text), '', 'an unknown kind reads as a follow')
  t.is(snippetOf(null, text), '')
  t.is(snippetOf(Object.freeze({ kind: 'reply' }), ''), '')
  t.is(snippetOf(Object.freeze({ kind: 'reply' }), 7), '')
  const quoted = snippetOf(Object.freeze({ kind: 'quote', key, post: key + ':7' }), text)
  t.is(quoted.includes(key), false)
  t.is(quoted.includes(key.slice(0, 6)), false)
})

test('snippetOf collapses line breaks and clips to 90 code points on a boundary', async (t) => {
  const { snippetOf } = await load()
  const notice = Object.freeze({ kind: 'mention' })
  t.is(snippetOf(notice, 'um\r\n\ndois\rtrês\u2028quatro\u2029cinco'), 'um dois três quatro cinco')
  t.is(snippetOf(notice, 'a'.repeat(90)), 'a'.repeat(90))
  t.is(snippetOf(notice, 'a'.repeat(91)), 'a'.repeat(90), 'nothing is appended')
  t.is(snippetOf(notice, '😀'.repeat(91)), '😀'.repeat(90))
  t.is(snippetOf(notice, 'a'.repeat(89) + '😀' + 'z'), 'a'.repeat(89) + '😀', 'an emoji on the boundary stays whole')
  t.is(snippetOf(notice, 'a'.repeat(89) + '\r\n' + 'z'), 'a'.repeat(89) + ' ', 'line breaks collapse before the cut')
  t.is(snippetOf(notice, 'a'.repeat(90) + '\n' + 'b'), 'a'.repeat(90))
  t.is(snippetOf(notice, 'a\n' + 'b'.repeat(100)), 'a ' + 'b'.repeat(88))
  t.is(snippetOf(Object.freeze({ kind: 'like' }), 'a'.repeat(200) + '\n'), 'a'.repeat(90))
  t.is(snippetOf(Object.freeze({ kind: 'repost' }), '  dois espaços  '), '  dois espaços  ')
  t.is(snippetOf(Object.freeze({ kind: 'follow' }), 'a'.repeat(200) + '\n\n'), '')
})

test('compareNotices orders by time descending, then key ascending, then seq descending', async (t) => {
  const { compareNotices } = await load()
  const at = '2026-06-01T00:00:00.000Z'
  const earlier = '2026-05-01T00:00:00.000Z'
  const row = (when, key, seq) => ({ at: when, key, seq })
  const items = [
    row(at, 'b', 1),
    row(at, 'a', 2),
    row(at, 'a', 9),
    row(earlier, 'a', 50)
  ]
  t.alike(items.slice().sort(compareNotices), [
    row(at, 'a', 9),
    row(at, 'a', 2),
    row(at, 'b', 1),
    row(earlier, 'a', 50)
  ])
  t.is(compareNotices(row(at, 'a', 2), row(at, 'a', 2)), 0)
  // String order puts -000001 before -000002; time order is the reverse.
  // Same key and seq, so only the instant can decide.
  const older = row('-000002-01-01T00:00:00.000Z', 'a', 1)
  const newer = row('-000001-01-01T00:00:00.000Z', 'a', 1)
  t.ok(compareNotices(newer, older) < 0)
  t.ok(compareNotices(older, newer) > 0)
})

test('notice ids use the signed sequence, so the same moment can be two follows', async (t) => {
  const { noticeId } = await load()
  const first = { key: 'peer', seq: 4, at: 100, name: 'Ana', username: 'ana' }
  const again = { key: 'peer', seq: 9, at: 100, name: 'Ana', username: 'ana' }
  t.is(noticeId(first), 'peer:4')
  t.is(noticeId(again), 'peer:9')
  t.not(noticeId(first), noticeId(again))
  t.is(noticeId(first), noticeId({ key: 'peer', seq: 4, at: 999, name: 'Ana', username: 'ana' }))
  t.is(noticeId({ key: 'peer:4', seq: 9, at: 100 }), 'peer:4:9')
})

const OWN = 'f0'.repeat(32)
// Distinct 32-hex token-shaped ids.
const d = (i) => i.toString(16).padStart(32, '0')
// A notice row as the node returns it, with its opaque seen token.
const row = (key, seq, seen) => Object.freeze({ key, seq, at: 1, name: 'Ana', username: 'ana', seen })
const tok = (i) => row('k' + i, 1, d(i))

test('hasNew is true only when some row with a valid seen token is still unseen', async (t) => {
  const { hasNew } = await load()
  const items = Object.freeze([tok(1), tok(2)])
  const seen = Object.freeze([d(1), d(2)])
  const partial = Object.freeze([d(1)])
  t.is(hasNew(items, seen), false)
  t.is(hasNew(items, partial), true)
  t.is(hasNew(items, Object.freeze([])), true)
  t.is(hasNew(Object.freeze([]), seen), false)
  t.is(hasNew(items, Object.freeze([d(2), d(1)])), false)
  // Rows without a valid token never count as new.
  const bad = Object.freeze([
    row('a', 1, undefined), row('b', 1, 'G'.repeat(32)), row('c', 1, d(9).toUpperCase().replace(/0/g, 'A')),
    row('d', 1, 'ab'.repeat(32)), row('e', 1, 7), Object.freeze({ key: 'f', seq: 1 })
  ])
  t.is(hasNew(bad, Object.freeze([])), false, 'no valid token: never new')
  t.is(hasNew([...bad, tok(3)], Object.freeze([])), true)
  t.is(items.length, 2)
  t.is(partial.length, 1)
})

// Deterministic random bytes: a seeded xorshift32, so runs repeat.
function seeded (seed) {
  let x = seed >>> 0 || 1
  return (n) => {
    const out = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      x ^= x << 13
      x >>>= 0
      x ^= x >>> 17
      x ^= x << 5
      x >>>= 0
      out[i] = x & 0xff
    }
    return out
  }
}
const HEX = /^[0-9a-f]{32}$/

test('seenOnScreen excludes padding, unseen rows and invalid tokens', async (t) => {
  const { seenOnScreen, padSeen } = await load()
  const stored = Object.freeze(padSeen([d(1), d(2)], seeded(7)))
  const decoy = stored.find((id) => id !== d(1) && id !== d(2))
  const items = Object.freeze([tok(2), tok(3), tok(1), tok(2), null, row('bad', 1, 'nope')])
  const ids = seenOnScreen(items, stored)
  t.alike(ids, [d(2), d(1)])
  t.is(ids.includes(decoy), false)
  t.alike(seenOnScreen([], stored), [])
  t.alike(seenOnScreen(items, []), [])
  t.alike(seenOnScreen([row('bad', 1, 'nope')], ['nope']), [])
})

test('seenOnScreen keeps newest loaded rows first and caps personal and page lists', async (t) => {
  const { seenOnScreen } = await load()
  const items = Object.freeze(Array.from({ length: 300 }, (_, i) => tok(300 - i)))
  const stored = Object.freeze(items.map((row) => row.seen).reverse())
  t.alike(seenOnScreen(items, stored), items.slice(0, 256).map((row) => row.seen))
  t.alike(seenOnScreen(items, stored, 32), items.slice(0, 32).map((row) => row.seen))
  t.alike(seenOnScreen(items, stored, 0), [])
})

test('mergeRemoteSeen never evicts locally seen loaded rows when folding remote tokens', async (t) => {
  const { mergeRemoteSeen, SEEN_MAX } = await load()
  // A zero draw would evict the first slot if the local row were not protected.
  const stored = Object.freeze(Array.from({ length: SEEN_MAX }, (_, i) => d(i + 1)))
  const remote = Object.freeze([d(SEEN_MAX + 1), d(SEEN_MAX + 2)])
  const items = Object.freeze([tok(SEEN_MAX + 1), tok(1), tok(2), tok(SEEN_MAX + 3)])
  const result = mergeRemoteSeen(stored, remote, items, (n) => new Uint8Array(n))
  t.is(result.changed, true)
  t.is(result.ids.length, SEEN_MAX)
  t.is(new Set(result.ids).size, SEEN_MAX)
  t.ok(result.ids.includes(d(1)), 'the locally seen row in the first slot survives')
  t.ok(result.ids.includes(d(2)), 'every locally seen loaded row survives')
  t.ok(result.ids.includes(d(SEEN_MAX + 1)), 'the remote seen loaded row is folded')
  t.is(result.ids.includes(d(SEEN_MAX + 2)), false, 'an unloaded remote token is not stored')
  t.is(result.ids.includes(d(SEEN_MAX + 3)), false, 'a loaded unseen row stays unseen')
  t.alike(stored, Array.from({ length: SEEN_MAX }, (_, i) => d(i + 1)))
})

test('remoteFoldPlan never marks a hidden poll page and settles nothing after a namespace reset', async (t) => {
  const { remoteFoldPlan } = await load()
  const onScreen = [tok(1), tok(2)]
  const polled = [tok(3), tok(1)]

  const reset = remoteFoldPlan(null, null)
  t.alike(reset.rows, [])
  t.is(reset.settle, null, 'no list of this namespace: nothing is settled')

  const hidden = remoteFoldPlan(onScreen, { list: polled, shown: false })
  t.alike(hidden.rows, onScreen.concat(polled), 'rows on screen and the polled page are protected')
  t.is(hidden.settle.list, polled)
  t.is(hidden.settle.shown, false, 'a page read by a hidden poll only moves the dot')

  const visible = remoteFoldPlan(onScreen, { list: onScreen, shown: true })
  t.alike(visible.rows, onScreen)
  t.is(visible.settle.list, onScreen)
  t.is(visible.settle.shown, true)

  const firstPoll = remoteFoldPlan(null, { list: polled, shown: false })
  t.alike(firstPoll.rows, polled)
  t.is(firstPoll.settle.shown, false)
})

test('mergeRemoteSeen leaves storage untouched when remote tokens are present or unloaded', async (t) => {
  const { mergeRemoteSeen, padSeen } = await load()
  const stored = Object.freeze(padSeen([d(1), d(2)], seeded(8)))
  const noRandom = () => { throw new Error('unchanged lists need no randomness') }
  for (const remote of [[d(1), d(2)], [d(3)], [], ['nope', null]]) {
    const result = mergeRemoteSeen(stored, Object.freeze(remote), [tok(1), tok(2), null, { seen: 'nope' }], noRandom)
    t.is(result.changed, false)
    t.is(result.ids, stored)
  }
  const empty = Object.freeze([])
  t.alike(mergeRemoteSeen(empty, [d(3)], [], noRandom), { ids: empty, changed: false })
})

test('mergeRemoteSeen pads the first fold and keeps existing local tokens', async (t) => {
  const { mergeRemoteSeen, SEEN_MAX } = await load()
  const result = mergeRemoteSeen(Object.freeze([d(1)]), [d(2)], [tok(2), tok(1)], seeded(9))
  t.is(result.changed, true)
  t.is(result.ids.length, SEEN_MAX)
  t.ok(result.ids.includes(d(1)))
  t.ok(result.ids.includes(d(2)))
})

test('seenUnion combines valid local and remote tokens for the badge without changing storage', async (t) => {
  const { seenUnion, hasNew } = await load()
  const stored = Object.freeze([d(1), d(2)])
  const remote = Object.freeze([d(2), d(3), d(3), 'nope', null, 7, 'AB'.repeat(16)])
  const ids = seenUnion(stored, remote)
  t.alike(ids, [d(1), d(2), d(3)])
  t.is(hasNew([tok(1), tok(3)], ids), false)
  t.is(hasNew([tok(4)], ids), true)
  t.is(hasNew([tok(3)], stored), true)
  t.alike(seenUnion([], []), [])
  t.alike(seenUnion(['bad'], [d(3)]), [d(3)])
})

test('randomToken is 32 lowercase hex from 16 injected bytes and rejects a wrong source', async (t) => {
  const { randomToken } = await load()
  t.is(randomToken(() => new Uint8Array(16).fill(0xab)), 'ab'.repeat(16))
  t.ok(HEX.test(randomToken(seeded(1))))
  t.exception(() => randomToken(() => new Uint8Array(15)))
  t.exception(() => randomToken(() => new Array(16).fill(0)))
})

test('padSeen returns exactly size distinct 32-hex entries, keeps every real id and shuffles them', async (t) => {
  const { padSeen, SEEN_MAX } = await load()
  const real = Object.freeze([d(1), d(2), d(3), d(2)])
  const out = padSeen(real, seeded(7))
  t.is(out.length, SEEN_MAX)
  t.ok(out.every((id) => HEX.test(id)))
  t.is(new Set(out).size, SEEN_MAX, 'no duplicates')
  for (const id of real) t.ok(out.includes(id))
  t.is(real.length, 4, 'not mutated')
  t.not(out, real)

  t.is(padSeen([], seeded(3), 16).length, 16)
  const long = []
  for (let i = 0; i < 20; i++) long.push(d(i))
  t.alike(padSeen(long, seeded(3), 16).slice().sort(), long.slice(-16).sort(), 'the last size ids when longer')

  // Real ids are not always at the front.
  let atFront = 0
  for (let run = 0; run < 20; run++) {
    const o = padSeen([d(1), d(2), d(3)], seeded(100 + run), 64)
    if (o.slice(0, 3).every((id) => [d(1), d(2), d(3)].includes(id))) atFront++
  }
  t.ok(atFront < 3, 'real ids are spread through the list')
})

test('markSeenPadded pads the first write to exactly size and keeps old and new ids', async (t) => {
  const { markSeenPadded, SEEN_MAX } = await load()
  const old = Object.freeze([d(1), d(2)])
  const items = Object.freeze([tok(3), tok(1), row('x', 1, 'nope'), tok(4), row('k3', 2, d(3))])
  const { ids, changed } = markSeenPadded(old, items, seeded(11))
  t.is(changed, true)
  t.is(ids.length, SEEN_MAX)
  t.ok(ids.every((id) => HEX.test(id)))
  t.is(new Set(ids).size, SEEN_MAX)
  for (const id of [d(1), d(2), d(3), d(4)]) t.ok(ids.includes(id))
  t.is(ids.includes('nope'), false)
  t.alike(old, [d(1), d(2)])
  // Nothing new: the same array, unchanged.
  const again = markSeenPadded(ids, items, seeded(12))
  t.is(again.changed, false)
  t.is(again.ids, ids)
  const empty = markSeenPadded(old, Object.freeze([]), seeded(12))
  t.is(empty.changed, false)
  t.is(empty.ids, old)
  // Rows without a valid token are ignored entirely.
  const bad = markSeenPadded(ids, Object.freeze([row('x', 1, undefined), row('y', 1, 'ab'.repeat(32)), row('z', 1, 'G'.repeat(32))]), seeded(13))
  t.is(bad.changed, false)
  t.is(bad.ids, ids)
})

test('markSeenPadded keeps the length at size, adds new ids and never evicts a row on screen', async (t) => {
  const { markSeenPadded, padSeen } = await load()
  const size = 32
  for (let run = 0; run < 30; run++) {
    const rand = seeded(500 + run)
    const stored = Object.freeze(padSeen([d(1), d(2), d(3)], rand, size))
    // d(1) and d(2) are on screen (already seen); d(10)..d(14) are new.
    const items = Object.freeze([tok(10), tok(1), tok(11), tok(12), tok(2), tok(13), tok(14)])
    const { ids, changed } = markSeenPadded(stored, items, rand, size)
    t.is(changed, true)
    t.is(ids.length, size)
    t.not(ids, stored)
    for (const id of [d(1), d(2), d(10), d(11), d(12), d(13), d(14)]) {
      if (!ids.includes(id)) t.fail('missing ' + id)
    }
    // Exactly five entries replaced, none of them a token of the items.
    let replaced = 0
    for (let i = 0; i < size; i++) {
      if (ids[i] === stored[i]) continue
      replaced++
      if (stored[i] === d(1) || stored[i] === d(2)) t.fail('evicted a row on screen')
    }
    if (replaced !== 5) t.fail('replaced ' + replaced)
  }
  t.pass('length kept, new ids in, rows on screen kept')
})

test('markSeenPadded keeps the newest new ids that fit when too few entries can be evicted', async (t) => {
  const { markSeenPadded } = await load()
  const stored = Object.freeze([d(1), d(2), d(3), d(4)])
  // Newest first: d(1)..d(3) on screen leave one evictable slot (d(4)).
  const items = Object.freeze([tok(20), tok(21), tok(1), tok(2), tok(3)])
  const { ids, changed } = markSeenPadded(stored, items, seeded(9), 4)
  t.is(changed, true)
  t.alike(ids, [d(1), d(2), d(3), d(20)])
  const none = markSeenPadded(stored, Object.freeze([tok(20), tok(1), tok(2), tok(3), tok(4)]), seeded(9), 4)
  t.is(none.changed, false)
  t.is(none.ids, stored)
})

test('parseSeen round-trips serializeSeen v3 and rejects anything else, v1 and v2 included', async (t) => {
  const { parseSeen, serializeSeen, SEEN_MAX } = await load()
  const ids = [d(2), d(1), d(3)]
  const text = serializeSeen(OWN, ids)
  t.alike(JSON.parse(text), { v: 3, own: OWN, ids })
  t.alike(parseSeen(text, OWN), ids)
  t.alike(parseSeen(serializeSeen(OWN, []), OWN), [])

  const key = 'ab'.repeat(32)
  const salt = '0123456789abcdef0123456789abcdef'
  t.alike(parseSeen(JSON.stringify({ v: 1, own: OWN, ids: [key + ':4'] }), OWN), [], 'a v1 entry (raw keys) is discarded')
  t.alike(parseSeen(JSON.stringify({ v: 2, own: OWN, salt, ids }), OWN), [], 'a v2 entry (salt + digests) is discarded')
  t.alike(parseSeen(JSON.stringify({ v: 3, own: OWN, ids: [key + ':4'] }), OWN), [], 'raw ids are rejected')
  t.alike(parseSeen(JSON.stringify({ v: 3, own: OWN, ids: [key] }), OWN), [], 'a 64-hex key is not a token')
  t.alike(parseSeen(JSON.stringify({ v: 3, own: 'e1'.repeat(32), ids }), OWN), [], 'another identity')
  t.alike(parseSeen(JSON.stringify({ v: 3, ids }), OWN), [], 'no own')
  t.alike(parseSeen(JSON.stringify({ v: 3, own: OWN, ids: [d(1), 'G'.repeat(32)] }), OWN), [])
  t.alike(parseSeen(JSON.stringify({ v: 3, own: OWN, ids: [d(1).toUpperCase().replace(/0/g, 'A')] }), OWN), [])
  t.alike(parseSeen(JSON.stringify({ v: 3, own: OWN, ids: [d(1), null] }), OWN), [])
  t.alike(parseSeen(JSON.stringify({ v: 3, own: OWN, ids: d(1) }), OWN), [])
  t.alike(parseSeen(JSON.stringify({ v: '3', own: OWN, ids }), OWN), [])
  t.alike(parseSeen('nope', OWN), [])
  t.alike(parseSeen('{', OWN), [])
  t.alike(parseSeen('null', OWN), [])
  t.alike(parseSeen(null, OWN), [])
  t.alike(parseSeen(undefined, OWN), [])

  const full = []
  for (let i = 0; i < SEEN_MAX; i++) full.push(d(i))
  t.alike(parseSeen(serializeSeen(OWN, full), OWN), full, 'exactly SEEN_MAX ids are accepted')
  t.alike(parseSeen(serializeSeen(OWN, [...full, d(SEEN_MAX)]), OWN), [], 'SEEN_MAX + 1 ids are rejected')
})

test('the stored text never carries a follower key nor the number of notices seen', async (t) => {
  const { markSeenPadded, serializeSeen, SEEN_MAX } = await load()
  const keys = ['ab'.repeat(32), 'cd'.repeat(32), '12'.repeat(32)]
  const items = keys.map((k, i) => row(k, i + 1, d(i + 1)))
  const text = serializeSeen(OWN, markSeenPadded([], items, seeded(5)).ids)
  for (const k of keys) {
    t.is(text.includes(k), false)
    t.is(text.includes(k.slice(0, 16)), false)
  }
  t.alike(Object.keys(JSON.parse(text)), ['v', 'own', 'ids'])
  const stored = JSON.parse(text).ids
  t.is(stored.length, SEEN_MAX, 'three seen notices still store exactly SEEN_MAX ids')
  t.ok(stored.every((id) => HEX.test(id)))
  for (const id of [d(1), d(2), d(3)]) t.ok(stored.includes(id))
})

test('the notice is web-only, then unsupported, then offline, else none', async (t) => {
  const { noticesNotice } = await load()
  t.is(noticesNotice({ hosted: true, supported: true, online: true, loadedAt: 1 }), null)
  t.is(noticesNotice({ hosted: true, supported: true, online: true, loadedAt: null }), null)
  t.is(noticesNotice({ hosted: true, supported: true, online: false, loadedAt: 1 }), null)
  t.is(noticesNotice({ hosted: true, supported: true, online: false, loadedAt: null }), 'offline')
  t.is(noticesNotice({ hosted: true, supported: false, online: true, loadedAt: 1 }), 'unsupported')
  t.is(noticesNotice({ hosted: true, supported: false, online: false, loadedAt: null }), 'unsupported')
  t.is(noticesNotice({ hosted: true, supported: undefined, online: false, loadedAt: null }), 'offline')
  t.is(noticesNotice({ hosted: false, supported: false, online: false, loadedAt: null }), 'web-only')
  t.is(noticesNotice({ hosted: false, supported: true, online: true, loadedAt: 1 }), 'web-only')
  t.is(noticesNotice({ hosted: false, supported: true, online: false, loadedAt: null }), 'web-only')
  t.is(noticesNotice({ supported: true, online: true, loadedAt: 1 }), 'web-only')
})

test('polling happens only when hosted, online and visible are all true', async (t) => {
  const { shouldPoll } = await load()
  const cases = [
    [true, true, true, true],
    [false, true, true, false],
    [true, false, true, false],
    [true, true, false, false],
    [false, false, true, false],
    [false, true, false, false],
    [true, false, false, false],
    [false, false, false, false]
  ]
  for (const [hosted, online, visible, expected] of cases) {
    t.is(shouldPoll({ hosted, online, visible }), expected, [hosted, online, visible].join(','))
  }
  t.is(shouldPoll({ online: true, visible: true }), false)
  t.is(shouldPoll({ hosted: true, visible: true }), false)
  t.is(shouldPoll({ hosted: true, online: true }), false)
  t.is(shouldPoll({ hosted: 1, online: true, visible: true }), false)
})

test('merging a page appends new notices in page order and skips repeats', async (t) => {
  const { mergePage } = await load()
  const a = item('a', 1)
  const b = item('b', 1)
  const c = item('a', 2)
  const d = item('c', 1)
  const current = Object.freeze([a, b])
  const page = Object.freeze([c, b, d, c])
  t.alike(mergePage(current, page), { items: [a, b, c, d], added: 2 })
  t.alike(mergePage(current, []), { items: [a, b], added: 0 })
  t.alike(mergePage([], page), { items: [c, b, d], added: 3 })
  t.alike(mergePage(current, [a]), { items: [a, b], added: 0 }, 'a page of repeats adds nothing')
  const refollow = item('a', 3, 1)
  t.alike(mergePage(Object.freeze([item('a', 1, 1)]), Object.freeze([refollow])), {
    items: [item('a', 1, 1), refollow],
    added: 1
  })
  const sameId = item('a', 1, 50)
  t.alike(mergePage(Object.freeze([item('a', 1, 1)]), Object.freeze([sameId])), {
    items: [item('a', 1, 1)],
    added: 0
  })
})

test('merging never mutates the inputs', async (t) => {
  const { mergePage } = await load()
  const current = Object.freeze([item('a', 1)])
  const page = Object.freeze([item('b', 1)])
  const result = mergePage(current, page)
  t.is(current.length, 1)
  t.is(page.length, 1)
  t.not(result.items, current, 'a new array is returned')
  t.is(result.items[0], current[0])
})

test('a page is the last one only when next is null: an empty page with a cursor is a gap, not the end', async (t) => {
  const { isLastNoticesPage } = await load()
  t.is(isLastNoticesPage({ notices: [item('a', 1)], next: null }), true)
  t.is(isLastNoticesPage({ notices: [], next: null }), true)
  t.is(isLastNoticesPage({ notices: [], next: { at: '2026-01-01T00:00:00.000Z', key: 'k' } }), false)
  t.is(isLastNoticesPage({ notices: [item('a', 1)], next: 'cursor' }), false)
})

// A node whose pages come from `pages` in order; every call is recorded.
function fakeRequest (pages) {
  const calls = []
  const request = async (method, params) => {
    calls.push({ method, params })
    const page = pages.shift()
    if (page === undefined) throw new Error('no more pages')
    return page
  }
  return { request, calls }
}

const cursor = (n) => ({ at: '2026-01-01T00:00:0' + n + '.000Z', key: 'k' + n })

test('readNotices delivers cumulative pages before requesting the next one', async (t) => {
  const { readNotices } = await load()
  const a = item('a', 1)
  const b = item('b', 1)
  const pages = [
    { notices: [a], next: cursor(1), incomplete: true, supported: true, activity: false },
    { notices: [a, b], next: cursor(2), incomplete: false, supported: true, activity: true },
    { notices: [], next: null, incomplete: false, supported: true }
  ]
  const events = []
  const partials = []
  const { request, calls } = fakeRequest(pages.slice())
  const result = await readNotices((method, params) => {
    events.push('request ' + (calls.length + 1))
    return request(method, params)
  }, {
    limit: 30,
    onPage: (partial) => {
      partials.push(partial)
      events.push('page ' + partials.length)
    }
  })
  t.alike(events, ['request 1', 'page 1', 'request 2', 'page 2', 'request 3', 'page 3'])
  t.alike(partials, [
    { notices: [a], next: cursor(1), incomplete: true, activity: false },
    { notices: [a, b], next: cursor(2), incomplete: true, activity: false },
    { notices: [a, b], next: null, incomplete: true, activity: false }
  ])
  t.alike(result, { notices: [a, b], next: null, incomplete: true, supported: true, activity: false })
  t.alike(await readNotices(fakeRequest(pages).request, { limit: 30 }), result, 'omitting onPage preserves the result')
})

test('readNotices delivers the first page even when a continuation fails', async (t) => {
  const { readNotices } = await load()
  const a = item('a', 1)
  const partials = []
  const failure = new Error('continuation failed')
  let reads = 0
  const result = readNotices(async () => {
    if (++reads === 2) throw failure
    return { notices: [a], next: cursor(1), incomplete: false, supported: true }
  }, { limit: 30, onPage: (partial) => partials.push(partial) })
  await t.exception(result, failure)
  t.is(reads, 2)
  t.alike(partials, [{ notices: [a], next: cursor(1), incomplete: false, activity: true }])
})

test('readNotices propagates an onPage error', async (t) => {
  const { readNotices } = await load()
  const failure = new Error('callback failed')
  const { request, calls } = fakeRequest([{ notices: [], next: cursor(1), supported: true }])
  await t.exception(readNotices(request, {
    limit: 30,
    onPage: () => { throw failure }
  }), failure)
  t.is(calls.length, 1)
})

test('readNotices reads past a gap: an empty page with a cursor is followed by the page after it', async (t) => {
  const { readNotices, NOTICES_AUTO_PAGES } = await load()
  t.is(NOTICES_AUTO_PAGES, 4)
  const behind = item('b', 1)
  const { request, calls } = fakeRequest([
    { notices: [], next: cursor(1), incomplete: true, supported: true },
    { notices: [behind], next: null, incomplete: false, supported: true }
  ])
  const r = await readNotices(request, { limit: 30 })
  t.alike(r, { notices: [behind], next: null, incomplete: true, supported: true, activity: true })
  t.alike(calls, [
    { method: 'notices.list', params: { limit: 30 } },
    { method: 'notices.list', params: { limit: 30, after: cursor(1) } }
  ], 'the second read starts at the first page\'s cursor, from the first page')
})

test('readNotices continues from `after`, merges short pages and stops once limit rows are in hand', async (t) => {
  const { readNotices } = await load()
  const a = item('a', 1)
  const b = item('b', 1)
  const c = item('c', 1)
  const { request, calls } = fakeRequest([
    { notices: [a], next: cursor(1), incomplete: false, supported: true },
    { notices: [b, a], next: cursor(2), incomplete: false, supported: true },
    { notices: [c], next: cursor(3), incomplete: false, supported: true }
  ])
  const r = await readNotices(request, { limit: 3, after: cursor(0) })
  t.alike(r, { notices: [a, b, c], next: cursor(3), incomplete: false, supported: true, activity: true })
  t.alike(calls.map((call) => call.params.after), [cursor(0), cursor(1), cursor(2)])
})

test('readNotices stops on a full page, keeping its cursor', async (t) => {
  const { readNotices } = await load()
  const full = [item('a', 1), item('b', 1)]
  const { request, calls } = fakeRequest([{ notices: full, next: cursor(1), incomplete: false, supported: true }])
  const r = await readNotices(request, { limit: 2 })
  t.alike(r, { notices: full, next: cursor(1), incomplete: false, supported: true, activity: true })
  t.is(calls.length, 1)
})

test('readNotices is bounded: at most NOTICES_AUTO_PAGES continuations, then the cursor is handed back', async (t) => {
  const { readNotices, NOTICES_AUTO_PAGES } = await load()
  const gaps = () => {
    const pages = []
    for (let i = 1; i <= 9; i++) pages.push({ notices: [], next: cursor(i), incomplete: false, supported: true })
    return pages
  }
  const { request, calls } = fakeRequest(gaps())
  const r = await readNotices(request, { limit: 30 })
  t.is(calls.length, 1 + NOTICES_AUTO_PAGES)
  t.alike(r, { notices: [], next: cursor(1 + NOTICES_AUTO_PAGES), incomplete: false, supported: true, activity: true })
  const two = fakeRequest(gaps())
  const r2 = await readNotices(two.request, { limit: 30, maxContinuations: 1 })
  t.is(two.calls.length, 2)
  t.alike(r2.next, cursor(2))
})

test('readNotices never spins on a cursor that does not move', async (t) => {
  const { readNotices } = await load()
  const partials = []
  const { request, calls } = fakeRequest([
    { notices: [], next: cursor(1), incomplete: false, supported: true },
    { notices: [], next: { at: cursor(1).at, key: cursor(1).key }, incomplete: false, supported: true }
  ])
  const r = await readNotices(request, { limit: 30, onPage: (partial) => partials.push(partial) })
  t.is(calls.length, 2)
  t.alike(partials, [
    { notices: [], next: cursor(1), incomplete: false, activity: true },
    { notices: [], next: null, incomplete: false, activity: true }
  ])
  t.alike(r, { notices: [], next: null, incomplete: false, supported: true, activity: true }, 'a stuck cursor ends the list')
  const same = fakeRequest([{ notices: [item('a', 1)], next: cursor(0), incomplete: false, supported: true }])
  const r2 = await readNotices(same.request, { limit: 30, after: cursor(0) })
  t.is(same.calls.length, 1)
  t.is(r2.next, null)
})

test('readNotices returns an unsupported page as is and stops when no longer live', async (t) => {
  const { readNotices } = await load()
  const partials = []
  const onPage = (partial) => partials.push(partial)
  const unsupported = { notices: [], next: null, incomplete: false, supported: false }
  const one = fakeRequest([unsupported])
  t.is(await readNotices(one.request, { limit: 30, onPage }), unsupported)
  t.alike(partials, [], 'an unsupported page is never delivered')
  const gone = fakeRequest([
    { notices: [], next: cursor(1), incomplete: false, supported: true },
    { notices: [item('a', 1)], next: null, incomplete: false, supported: true }
  ])
  const r = await readNotices(gone.request, { limit: 30, live: () => false, onPage })
  t.is(gone.calls.length, 1, 'no page is read for a read that is no longer the latest')
  t.alike(partials, [{ notices: [], next: cursor(1), incomplete: false, activity: true }], 'the current page is delivered before checking live')
  t.alike(r, { notices: [], next: cursor(1), incomplete: false, supported: true, activity: true })
})

test('readNotices is not stuck when only the cursor seq advances', async (t) => {
  const { readNotices } = await load()
  const at = '2026-01-01T00:00:00.000Z'
  const key = 'kk'
  const start = { at, key, seq: 1 }
  const moved = { at, key, seq: 4 }
  const a = item('a', 1)
  const b = item('b', 1)
  const { request, calls } = fakeRequest([
    { notices: [a], next: moved, incomplete: false, supported: true },
    { notices: [b], next: null, incomplete: false, supported: true }
  ])
  const r = await readNotices(request, { limit: 30, after: start })
  t.is(calls.length, 2, 'a cursor that moves only in seq is a new page')
  t.alike(calls[1].params.after, moved)
  t.alike(r, { notices: [a, b], next: null, incomplete: false, supported: true, activity: true })
  const stuck = fakeRequest([
    { notices: [], next: { at, key, seq: 1 }, incomplete: false, supported: true }
  ])
  const r2 = await readNotices(stuck.request, { limit: 30, after: { at, key, seq: 1 } })
  t.is(stuck.calls.length, 1)
  t.is(r2.next, null)
  t.is(r2.activity, true)
})

test('readNotices carries activity false when any page says so, else true', async (t) => {
  const { readNotices } = await load()
  const one = fakeRequest([
    { notices: [item('a', 1)], next: null, incomplete: false, supported: true, activity: false }
  ])
  const r = await readNotices(one.request, { limit: 30 })
  t.is(r.activity, false)
  t.alike(r.notices, [item('a', 1)])

  const across = fakeRequest([
    { notices: [item('a', 1)], next: cursor(1), incomplete: false, supported: true, activity: true },
    { notices: [item('b', 1)], next: null, incomplete: false, supported: true, activity: false }
  ])
  const r2 = await readNotices(across.request, { limit: 30 })
  t.is(r2.activity, false)
  t.is(r2.notices.length, 2, 'a quiet page is still merged')

  const full = fakeRequest([
    { notices: [item('a', 1), item('b', 1)], next: cursor(1), incomplete: false, supported: true, activity: false }
  ])
  const rFull = await readNotices(full.request, { limit: 2 })
  t.is(full.calls.length, 1)
  t.is(rFull.activity, false)

  const omitted = fakeRequest([
    { notices: [], next: cursor(1), incomplete: false, supported: true },
    { notices: [item('c', 1)], next: null, incomplete: false, supported: true }
  ])
  t.is((await readNotices(omitted.request, { limit: 30 })).activity, true, 'a page that omits activity counts as true')
})

test('withoutAuthor drops every notice of one key and keeps the rest in order', async (t) => {
  const { withoutAuthor } = await load()
  const items = Object.freeze([item('a', 1), item('b', 1), item('a', 2), item('c', 1)])
  t.alike(withoutAuthor(items, 'a'), [item('b', 1), item('c', 1)])
  t.alike(withoutAuthor(items, 'z'), [...items])
  t.alike(withoutAuthor([], 'a'), [])
  t.is(items.length, 4, 'the input is not changed')
})

test('withoutAuthor keeps a reply, quote, mention, like or repost of the key it drops follows for', async (t) => {
  const { withoutAuthor } = await load()
  const K = 'ab'.repeat(32)
  const follow = Object.freeze({ key: K, seq: 1, kind: 'follow' })
  const reply = Object.freeze({ key: K, seq: 5, kind: 'reply' })
  const quote = Object.freeze({ key: K, seq: 6, kind: 'quote' })
  const mention = Object.freeze({ key: K, seq: 7, kind: 'mention' })
  const like = Object.freeze({ key: K, seq: 8, kind: 'like' })
  const repost = Object.freeze({ key: K, seq: 9, kind: 'repost' })
  const otherFollow = Object.freeze({ key: 'b', seq: 1, kind: 'follow' })
  const otherReply = Object.freeze({ key: 'b', seq: 2, kind: 'reply' })
  const bare = Object.freeze({ key: K, seq: 10 })
  const items = Object.freeze([follow, reply, otherFollow, quote, mention, like, repost, otherReply, bare])
  t.alike(withoutAuthor(items, K), [reply, otherFollow, quote, mention, like, repost, otherReply])
  t.is(items.length, 9, 'the input is not changed')
})

test('a web-only error is a USAGE error with one of the two known messages', async (t) => {
  const { isWebOnlyError } = await load()
  t.is(isWebOnlyError({ code: 'USAGE', message: 'método desconhecido' }), true)
  t.is(isWebOnlyError({ code: 'USAGE', message: 'avisos disponíveis só no navegador' }), true)
  t.is(isWebOnlyError({ code: 'USAGE', message: 'outra coisa' }), false)
  t.is(isWebOnlyError({ code: 'NETWORK', message: 'método desconhecido' }), false)
  t.is(isWebOnlyError({ code: 'NETWORK', message: 'avisos disponíveis só no navegador' }), false)
  t.is(isWebOnlyError({ message: 'método desconhecido' }), false)
  t.is(isWebOnlyError(null), false)
  t.is(isWebOnlyError(undefined), false)
})

const PAGE = 'ab'.repeat(32)

test('a page seen namespace never equals a member key, even the same hex', async (t) => {
  const { pageSeenNamespace, isPageSeenNamespace } = await load()
  const ns = pageSeenNamespace(OWN)
  t.is(ns, 'page:' + OWN)
  t.not(ns, OWN)
  t.is(ns.length === OWN.length, false)
  t.is(isPageSeenNamespace(ns), true)
  t.is(isPageSeenNamespace(OWN), false)
  t.is(isPageSeenNamespace('page:' + PAGE), true)
  t.is(pageSeenNamespace(OWN.toUpperCase()), 'page:' + OWN)
  t.is(pageSeenNamespace(PAGE), 'page:' + PAGE)
  t.not(pageSeenNamespace(PAGE), pageSeenNamespace(OWN))
  t.is(pageSeenNamespace('zz'), null)
  t.is(pageSeenNamespace(''), null)
  t.is(pageSeenNamespace(null), null)
  t.is(pageSeenNamespace(undefined), null)
  t.is(pageSeenNamespace(OWN + 'aa'), null)
  t.is(isPageSeenNamespace('page:' + 'ab'), false)
  t.is(isPageSeenNamespace('page:' + OWN.toUpperCase()), false)
})

test('the page notices header names the page and never a key', async (t) => {
  const { pageNoticesHeader, PAGE_NOTICES_READ_LINE } = await load()
  t.is(pageNoticesHeader('Café'), 'Avisos da página Café')
  t.is(pageNoticesHeader('  Café  '), 'Avisos da página Café')
  t.is(pageNoticesHeader('@cafe'), 'Avisos da página @cafe')
  t.is(pageNoticesHeader(''), 'Avisos da página')
  t.is(pageNoticesHeader('   '), 'Avisos da página')
  t.is(pageNoticesHeader(null), 'Avisos da página')
  t.is(pageNoticesHeader(undefined), 'Avisos da página')
  t.is(pageNoticesHeader(7), 'Avisos da página')
  t.is(pageNoticesHeader(OWN), 'Avisos da página')
  t.is(pageNoticesHeader(OWN.toUpperCase()), 'Avisos da página')
  t.is(pageNoticesHeader('@' + OWN), 'Avisos da página')
  t.is(pageNoticesHeader('Café\nSilva'), 'Avisos da página Café Silva')
  const header = pageNoticesHeader('Café')
  t.is(header.includes(OWN), false)
  t.is(header.includes(PAGE), false)
  t.is(/[0-9a-f]{16,}/i.test(pageNoticesHeader(OWN)), false)
  t.is(PAGE_NOTICES_READ_LINE, 'A associação lê estes avisos para a página')
})

test('page seen ids share the stored text and never collide with the person', async (t) => {
  const {
    serializeSeen, parseSeen, parseSeenNamespace, writeSeenNamespace,
    pageSeenNamespace, hasNew, hasPageSeenNamespaces
  } = await load()
  // The page key is the member key on purpose: the hex must not be enough
  // to share a seen list.
  const ns = pageSeenNamespace(OWN)
  const other = pageSeenNamespace(PAGE)
  const personal = [d(1), d(2)]
  const pageIds = [d(3), d(4)]
  const otherIds = [d(5)]
  let text = writeSeenNamespace(serializeSeen(OWN, personal), ns, pageIds)
  text = writeSeenNamespace(text, other, otherIds)

  t.alike(parseSeen(text, OWN), personal)
  t.alike(parseSeenNamespace(text, OWN), personal)
  t.alike(parseSeenNamespace(text, ns), pageIds)
  t.alike(parseSeenNamespace(text, other), otherIds)
  t.alike(parseSeen(text, ns), [], 'the page namespace is not a personal own key')
  t.alike(parseSeen(text, OWN), personal)
  t.is(JSON.parse(text).own, OWN)
  t.not(JSON.parse(text).own, ns)
  t.is(JSON.parse(text).ids.includes(d(3)), false)
  t.is(JSON.parse(text).ids.includes(d(5)), false)

  const personRows = Object.freeze([tok(1), tok(3)])
  const pageRows = Object.freeze([tok(3), tok(1)])
  t.is(hasNew(personRows, parseSeen(text, OWN)), true, 'a page token is still unseen for the person')
  t.is(hasNew([tok(1)], parseSeen(text, OWN)), false)
  t.is(hasNew(pageRows, parseSeenNamespace(text, ns)), true, 'a personal token is still unseen for the page')
  t.is(hasNew([tok(3), tok(4)], parseSeenNamespace(text, ns)), false)
  t.is(hasNew([tok(5)], parseSeenNamespace(text, other)), false)
  t.is(hasNew([tok(3)], parseSeenNamespace(text, other)), true, 'another page does not see this page')

  // A later personal write keeps every page list.
  const next = writeSeenNamespace(text, OWN, [d(1), d(9)])
  t.alike(parseSeen(next, OWN), [d(1), d(9)])
  t.alike(parseSeenNamespace(next, ns), pageIds)
  t.alike(parseSeenNamespace(next, other), otherIds)
  t.is(hasPageSeenNamespaces(serializeSeen(OWN, personal)), false)
  t.is(hasPageSeenNamespaces(next), true)
  t.is(hasPageSeenNamespaces('nope'), false)
  t.is(hasPageSeenNamespaces(null), false)

  // An old personal entry still reads, and a page list is empty there.
  t.alike(parseSeenNamespace(serializeSeen(OWN, personal), OWN), personal)
  t.alike(parseSeenNamespace(serializeSeen(OWN, personal), ns), [])

  // A v1 blob of follower keys is not copied into the shared document.
  const v1 = JSON.stringify({ v: 1, own: OWN, ids: [OWN + ':4', PAGE + ':1'] })
  const dropped = writeSeenNamespace(v1, ns, pageIds)
  t.alike(parseSeen(dropped, OWN), [])
  t.alike(parseSeenNamespace(dropped, ns), pageIds)
  t.is(dropped.includes(OWN + ':4'), false)
  t.is(dropped.includes(PAGE + ':1'), false)
  t.is(dropped.includes(PAGE), false, 'the other key was only in the discarded v1 ids')
})

const avatarDescriptor = () => Object.freeze({
  core: 'dd'.repeat(32),
  mime: 'image/jpeg',
  start: 1,
  blocks: 1,
  bytes: 10,
  sha256: 'ee'.repeat(32),
  width: 512,
  height: 512
})
const hostileAvatarInput = () => new Proxy({}, {
  get () { throw new Error('hostile property') }
})

test('needsAvatar distinguishes an unknown profile from a confirmed missing photo', async (t) => {
  const { needsAvatar } = await load()
  const row = Object.freeze({ ...item('aa'.repeat(32), 12), avatar: null })
  const descriptor = avatarDescriptor()
  t.is(needsAvatar({ ...row, avatar: descriptor }), false)
  t.is(needsAvatar(row, undefined), true)
  t.is(needsAvatar(row, null), true)
  t.is(needsAvatar(row, { avatar: undefined }), true)
  t.is(needsAvatar(row, { avatar: null }), false)
  t.is(needsAvatar(row, { avatar: descriptor }), false)
  t.is(needsAvatar(item(row.key, 12)), true, 'an omitted row avatar is unknown')
  t.is(needsAvatar({ ...row, avatar: false }), false)
  for (const cached of [false, 1, 'unknown', () => {}]) t.is(needsAvatar(row, cached), false)
  for (const key of ['zz'.repeat(32), 'aa', row.key.toUpperCase(), 1, null]) {
    t.is(needsAvatar({ ...row, key }), false)
  }
  for (const value of [null, undefined, 1, 'row', () => {}]) t.is(needsAvatar(value), false)
  t.is(needsAvatar(hostileAvatarInput()), false, 'a throwing row is ignored')
  t.is(needsAvatar(row, hostileAvatarInput()), false, 'a throwing cache is ignored')
})

test('avatarPeeks fetches only valid own profile hints once in first-seen order', async (t) => {
  const { avatarPeeks } = await load()
  const a = 'aa'.repeat(32)
  const b = 'bb'.repeat(32)
  const c = 'cc'.repeat(32)
  const hints = { [a]: { profileSeq: 4, usernameSeq: 3 }, [b]: { profileSeq: 4 } }
  const chunks = avatarPeeks([b, a, b, c, a, 'zz'.repeat(32), null, 12], hints)
  t.is(chunks.length, 2)
  t.alike(chunks[0], { author: b, seqs: [4], profileSeq: 4 })
  t.alike(chunks[1], { author: a, seqs: [4], profileSeq: 4 })
  for (const profileSeq of [null, undefined, 0, -1, 1.5, '4', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    t.alike(avatarPeeks([a], { [a]: { profileSeq } }), [])
  }
  for (const hint of [null, undefined, 4, 'hint', { usernameSeq: 3 }]) {
    t.alike(avatarPeeks([a], { [a]: hint }), [])
  }
  t.alike(avatarPeeks([a], Object.create({ [a]: { profileSeq: 4 } })), [])
  t.alike(avatarPeeks(['zz'.repeat(32)], { ['zz'.repeat(32)]: { profileSeq: 4 } }), [])
  for (const hints of [null, undefined, 'hints', hostileAvatarInput()]) {
    t.alike(avatarPeeks([a], hints), [])
  }
  t.alike(avatarPeeks([a], { [a]: hostileAvatarInput() }), [])
  t.alike(avatarPeeks(hostileAvatarInput(), hints), [])
  t.alike(avatarPeeks(null, hints), [])
})

test('avatarFromPeek leaves missing profiles unresolved and preserves descriptors', async (t) => {
  const { avatarFromPeek } = await load()
  const descriptor = avatarDescriptor()
  for (const peek of [undefined, null, 1, 'peek', {}, { profile: null }, { profile: 'profile' }]) {
    t.is(avatarFromPeek(peek), undefined)
  }
  for (const avatar of [null, undefined, false, 1, 'avatar']) {
    t.is(avatarFromPeek({ profile: { avatar } }), null)
  }
  t.is(avatarFromPeek({ profile: { avatar: descriptor } }), descriptor)
  t.is(avatarFromPeek(hostileAvatarInput()), undefined)
  t.is(avatarFromPeek({ profile: hostileAvatarInput() }), undefined)
})

test('resolveRowAvatars recovers a photo whose profile pair is outside the notice window', async (t) => {
  const { needsAvatar, resolveRowAvatars } = await load()
  const a = 'aa'.repeat(32)
  const descriptor = avatarDescriptor()
  // The profile pair at blocks 3 and 4 is outside the node's notice window.
  const row = Object.freeze({ ...item(a, 80), avatar: null })
  t.is(needsAvatar(row, null), true)
  const members = []
  const peeks = []
  const events = []
  const found = await resolveRowAvatars([row.key, row.key], {
    fetchMember: async (key) => {
      members.push(key)
      events.push('member')
      return { ok: true, value: { profileSeq: 4, usernameSeq: null } }
    },
    peekChunk: async (chunk) => {
      peeks.push(chunk)
      events.push('peek')
      t.alike(chunk, { author: a, seqs: [4], profileSeq: 4 })
      return { key: a, profile: { name: 'Fabi', bio: '', avatar: descriptor } }
    }
  })
  t.alike(found, { [a]: descriptor })
  t.alike(members, [a])
  t.is(peeks.length, 1)
  t.alike(events, ['member', 'peek'])
})

test('resolveRowAvatars isolates failed members, unresolved profiles and failed or mismatched peeks', async (t) => {
  const { resolveRowAvatars } = await load()
  const [a, b, c, e, f, wrong, failed] = ['aa', 'bb', 'cc', 'ee', 'ff', '11', '22'].map((s) => s.repeat(32))
  const descriptor = avatarDescriptor()
  const keys = [b, c, f, e, wrong, failed, a]
  const members = []
  const peeks = []
  const events = []
  const found = await resolveRowAvatars([...keys, a, null, 12, 'zz'.repeat(32)], {
    fetchMember: async (key) => {
      members.push(key)
      events.push('member:' + key)
      if (key === b) return { ok: false, reason: 'cooldown' }
      if (key === failed) throw new Error('member unavailable')
      return { ok: true, value: { profileSeq: 4, usernameSeq: 3 } }
    },
    peekChunk: async (chunk) => {
      peeks.push(chunk.author)
      events.push('peek:' + chunk.author)
      t.alike(chunk, { author: chunk.author, seqs: [4], profileSeq: 4 })
      if (chunk.author === f) throw new Error('peek unavailable')
      if (chunk.author === c) return { key: c, profile: null }
      if (chunk.author === e) return { key: e, profile: { avatar: null } }
      if (chunk.author === wrong) return { key: a, profile: { avatar: descriptor } }
      return { key: a, profile: { avatar: descriptor } }
    }
  })
  t.alike(found, { [e]: null, [a]: descriptor })
  t.is(found[e], null)
  for (const key of [b, c, f, wrong, failed]) t.is(Object.hasOwn(found, key), false)
  t.alike(members, keys)
  t.alike(peeks, [c, f, e, wrong, a])
  t.alike(events, [...keys.map((key) => 'member:' + key), ...peeks.map((key) => 'peek:' + key)])
})

test('resolveRowAvatars needs a successful member with a valid profile hint', async (t) => {
  const { resolveRowAvatars } = await load()
  const a = 'aa'.repeat(32)
  for (const member of [null, {}, { ok: 1, value: { profileSeq: 4 } }, { ok: true, value: null }, { ok: true, value: 'member' }, { ok: true, value: { usernameSeq: 3 } }, { ok: true, value: { profileSeq: null } }]) {
    let peeks = 0
    t.alike(await resolveRowAvatars([a], {
      fetchMember: async () => member,
      peekChunk: async () => { peeks++ }
    }), {})
    t.is(peeks, 0)
  }
  for (const peek of [null, 'peek', { profile: null }, { profile: { avatar: avatarDescriptor() } }]) {
    t.alike(await resolveRowAvatars([a], {
      fetchMember: async () => ({ ok: true, value: { profileSeq: 4 } }),
      peekChunk: async () => peek
    }), {}, 'a peek must identify the requested author')
  }
})

test('resolveRowAvatars stops before more member or peek calls once no longer alive', async (t) => {
  const { resolveRowAvatars } = await load()
  const a = 'aa'.repeat(32)
  const b = 'bb'.repeat(32)
  for (const keys of [[a, b], [a]]) {
    let alive = true
    const members = []
    const peeks = []
    t.alike(await resolveRowAvatars(keys, {
      alive: () => alive,
      fetchMember: async (key) => {
        members.push(key)
        alive = false
        return { ok: true, value: { profileSeq: 4 } }
      },
      peekChunk: async (chunk) => { peeks.push(chunk) }
    }), {})
    t.alike(members, [a])
    t.alike(peeks, [])
  }
  let calls = 0
  t.alike(await resolveRowAvatars([a], {
    alive: () => false,
    fetchMember: async () => { calls++ },
    peekChunk: async () => { calls++ }
  }), {})
  t.is(calls, 0)
})

test('rowAvatarSource prefers a row photo over older peek answers', async (t) => {
  const { rowAvatarSource } = await load()
  const descriptor = avatarDescriptor()
  const newer = Object.freeze({ ...descriptor, start: 2 })
  const row = Object.freeze({ ...item('aa'.repeat(32), 12), avatar: newer })
  t.is(rowAvatarSource(row, null), row)
  t.is(rowAvatarSource(row, descriptor), row)
  const missing = Object.freeze({ ...row, avatar: null })
  t.alike(rowAvatarSource(missing, descriptor), { avatar: descriptor })
  t.alike(rowAvatarSource(missing, null), { avatar: null })
  t.is(rowAvatarSource(missing, undefined), missing)
  for (const value of [null, undefined, 'row', 12, hostileAvatarInput()]) {
    t.is(rowAvatarSource(value, undefined), value)
  }
  const hostile = hostileAvatarInput()
  t.is(rowAvatarSource(hostile, descriptor), hostile)
  t.alike(rowAvatarSource(undefined, descriptor), { avatar: descriptor })
})

test('notices helpers keep the pure module free of imports', (t) => {
  const source = require('fs').readFileSync(require.resolve('../src/notices.js'), 'utf8')
  t.is(/^import /m.test(source), false)
})

test('the hidden first read waits for this epoch peek to settle or become ineligible', async (t) => {
  const { shouldStartNoticesFirstRead } = await load()
  const ready = {
    hosted: true,
    online: true,
    phase: 'ready',
    visible: true,
    seederVerified: true,
    syncReady: false,
    active: false,
    loadedAt: null,
    epoch: 2,
    peekWarm: { epoch: 2, eligible: true, attempted: false, pending: false, busy: false }
  }
  const withPeek = (patch) => shouldStartNoticesFirstRead({ ...ready, peekWarm: { ...ready.peekWarm, ...patch } })
  t.is(shouldStartNoticesFirstRead(ready), false, 'Espiadinha is still waiting for its idle slot')
  t.is(withPeek({ attempted: true, pending: true }), false, 'attempted is not settled')
  t.is(withPeek({ eligible: false, attempted: true, pending: true }), false, 'an in-flight warm is still pending after a tab change')
  t.is(withPeek({ attempted: true }), true, 'settled, even without sync ready')
  t.is(withPeek({ eligible: false }), true, 'a warm that will not run does not block notices')
  t.is(withPeek({ epoch: 1, attempted: true }), false, 'an old completion is not this epoch')
  t.is(shouldStartNoticesFirstRead({ ...ready, peekWarm: null }), false, 'wait for Espiadinha to declare eligibility')
  for (const patch of [{ attempted: true }, { eligible: false }]) {
    t.is(withPeek({ ...patch, busy: true }), false, 'a full seeder gets no second warm read')
  }
  const settled = { ...ready, peekWarm: { ...ready.peekWarm, attempted: true } }
  for (const patch of [
    { hosted: false }, { online: false }, { phase: 'connecting' }, { visible: false },
    { seederVerified: false }, { active: true }, { loadedAt: 1 }, { loading: true },
    { refreshing: true }, { loadingMore: true }, { unsupported: true }, { locked: true }, { attempted: true }
  ]) {
    t.is(shouldStartNoticesFirstRead({ ...settled, ...patch }), false, JSON.stringify(patch))
  }
})

test('peek eligibility releases notices when its warm will not run', async (t) => {
  const { shouldWarmPeek } = await import('../src/peek.js')
  const { shouldStartNoticesFirstRead } = await load()
  const ready = { hosted: true, online: true, phase: 'ready', visible: true, seederVerified: true, active: false, loadedAt: null }
  for (const patch of [{ hosted: false }, { online: false }, { loadedAt: 1 }, { unsupported: true }, { active: true }]) {
    const eligible = shouldWarmPeek({ ...ready, ...patch })
    t.is(eligible, false)
    t.is(shouldStartNoticesFirstRead({ ...ready, epoch: 1, peekWarm: { epoch: 1, eligible } }), true)
  }
})
