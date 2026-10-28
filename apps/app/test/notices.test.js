'use strict'

const test = require('brittle')
const load = () => import('../src/notices.js')
const item = (key, seq, at = 1) => Object.freeze({ key, seq, at, name: 'Ana', username: 'ana' })

test('the fixed texts are the approved Portuguese', async (t) => {
  const {
    FOLLOW_BACK_LABEL,
    EMPTY_TITLE,
    EMPTY_TEXT,
    NOTICES_WEB_ONLY_MESSAGE,
    NOTICES_OFFLINE_MESSAGE,
    NOTICES_UNSUPPORTED_MESSAGE,
    NOTICES_INCOMPLETE_TEXT,
    SEEN_STORAGE_KEY,
    NOTICES_POLL_MS,
    SEEN_MAX
  } = await load()
  t.is(FOLLOW_BACK_LABEL, 'Seguir de volta')
  t.is(EMPTY_TITLE, 'Ninguém novo por aqui')
  t.is(EMPTY_TEXT, 'Quando alguém começar a seguir você, aparece aqui.')
  t.is(NOTICES_WEB_ONLY_MESSAGE, 'Nesta versão, os Avisos só funcionam na versão web no site da associação.')
  t.is(NOTICES_OFFLINE_MESSAGE, 'Confira sua internet.')
  t.is(NOTICES_UNSUPPORTED_MESSAGE, 'Os Avisos ainda não estão disponíveis nesta associação.')
  t.is(NOTICES_INCOMPLETE_TEXT, 'Alguns avisos ainda podem chegar.')
  t.is(SEEN_STORAGE_KEY, 'varanda-notices-seen')
  t.is(NOTICES_POLL_MS, 300000)
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

test('readNotices reads past a gap: an empty page with a cursor is followed by the page after it', async (t) => {
  const { readNotices, NOTICES_AUTO_PAGES } = await load()
  t.is(NOTICES_AUTO_PAGES, 4)
  const behind = item('b', 1)
  const { request, calls } = fakeRequest([
    { notices: [], next: cursor(1), incomplete: true, supported: true },
    { notices: [behind], next: null, incomplete: false, supported: true }
  ])
  const r = await readNotices(request, { limit: 30 })
  t.alike(r, { notices: [behind], next: null, incomplete: true, supported: true })
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
  t.alike(r, { notices: [a, b, c], next: cursor(3), incomplete: false, supported: true })
  t.alike(calls.map((call) => call.params.after), [cursor(0), cursor(1), cursor(2)])
})

test('readNotices stops on a full page, keeping its cursor', async (t) => {
  const { readNotices } = await load()
  const full = [item('a', 1), item('b', 1)]
  const { request, calls } = fakeRequest([{ notices: full, next: cursor(1), incomplete: false, supported: true }])
  const r = await readNotices(request, { limit: 2 })
  t.alike(r, { notices: full, next: cursor(1), incomplete: false, supported: true })
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
  t.alike(r, { notices: [], next: cursor(1 + NOTICES_AUTO_PAGES), incomplete: false, supported: true })
  const two = fakeRequest(gaps())
  const r2 = await readNotices(two.request, { limit: 30, maxContinuations: 1 })
  t.is(two.calls.length, 2)
  t.alike(r2.next, cursor(2))
})

test('readNotices never spins on a cursor that does not move', async (t) => {
  const { readNotices } = await load()
  const { request, calls } = fakeRequest([
    { notices: [], next: cursor(1), incomplete: false, supported: true },
    { notices: [], next: { at: cursor(1).at, key: cursor(1).key }, incomplete: false, supported: true }
  ])
  const r = await readNotices(request, { limit: 30 })
  t.is(calls.length, 2)
  t.alike(r, { notices: [], next: null, incomplete: false, supported: true }, 'a stuck cursor ends the list')
  const same = fakeRequest([{ notices: [item('a', 1)], next: cursor(0), incomplete: false, supported: true }])
  const r2 = await readNotices(same.request, { limit: 30, after: cursor(0) })
  t.is(same.calls.length, 1)
  t.is(r2.next, null)
})

test('readNotices returns an unsupported page as is and stops when no longer live', async (t) => {
  const { readNotices } = await load()
  const unsupported = { notices: [], next: null, incomplete: false, supported: false }
  const one = fakeRequest([unsupported])
  t.is(await readNotices(one.request, { limit: 30 }), unsupported)
  const gone = fakeRequest([
    { notices: [], next: cursor(1), incomplete: false, supported: true },
    { notices: [item('a', 1)], next: null, incomplete: false, supported: true }
  ])
  const r = await readNotices(gone.request, { limit: 30, live: () => false })
  t.is(gone.calls.length, 1, 'no page is read for a read that is no longer the latest')
  t.alike(r, { notices: [], next: cursor(1), incomplete: false, supported: true })
})

test('withoutAuthor drops every notice of one key and keeps the rest in order', async (t) => {
  const { withoutAuthor } = await load()
  const items = Object.freeze([item('a', 1), item('b', 1), item('a', 2), item('c', 1)])
  t.alike(withoutAuthor(items, 'a'), [item('b', 1), item('c', 1)])
  t.alike(withoutAuthor(items, 'z'), [...items])
  t.alike(withoutAuthor([], 'a'), [])
  t.is(items.length, 4, 'the input is not changed')
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
