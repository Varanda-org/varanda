// What the Fãs and Melhores amigos screens read and say (fansView.js): the scan
// of the own diary, the fan button's states, the editor's candidates and the
// strings (no em dash, no quoted method names).
'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const load = () => import('../src/fansView.js')

const key = (n) => n.toString(16).padStart(2, '0').repeat(32)
const ME = key(0xb2)
const OTHER = key(0xc1)
const F1 = key(0xd1)
const F2 = key(0xd2)
const DASH = String.fromCharCode(0x2014)
const AT = '2026-10-20T10:00:00.000Z'

const page = (entries, { start = false, who = ME } = {}) => ({ key: who, entries, invalid: [], entriesTruncated: start ? 0 : 5 })
const fan = (seq, k, on) => ({ seq, record: { type: 'fan', key: k, on, at: AT } })
const top = (seq, keys) => ({ seq, record: { type: 'top-friends', keys, at: AT } })

test('ownFansScan keeps the newest mark per key and the newest top list', async (t) => {
  const { ownFansScan } = await load()
  const scan = ownFansScan([page([top(9, [F1]), fan(8, OTHER, false), fan(5, OTHER, true), top(3, [F2])], { start: true })], ME)
  t.is(scan.settled, true)
  t.alike(scan.fans.get(OTHER), { seq: 8, on: false })
  t.alike(scan.top, { seq: 9, keys: [F1] })
  t.is(scan.next, null)
})

test('ownFansScan: a short walk settles nothing, a page of another diary is empty', async (t) => {
  const { ownFansScan } = await load()
  const short = ownFansScan([page([fan(8, OTHER, true), fan(7, F1, true)])], ME)
  t.is(short.settled, false)
  t.is(short.next, 7)
  const wrong = ownFansScan([page([fan(8, OTHER, true)], { start: true, who: OTHER })], ME)
  t.is(wrong.settled, false)
  t.is(wrong.fans.size, 0)
  t.is(ownFansScan([], 'nope').settled, false)
  const junk = ownFansScan([page([{ seq: 4, record: { type: 'fan', key: 'x', on: true } }, { seq: 3, record: { type: 'top-friends', keys: ['x'] } }], { start: true })], ME)
  t.is(junk.fans.size, 0)
  t.is(junk.top, null)
})

test('fanOf: an unknown mark is unknown, never "not a fan"', async (t) => {
  const { fanOf, marksFromScan, ownFansScan, withFan, NO_MARKS } = await load()
  const ready = marksFromScan(ownFansScan([page([fan(8, OTHER, true)], { start: true })], ME))
  t.is(ready.status, 'ready')
  t.is(fanOf(ready, OTHER), true)
  t.is(fanOf(ready, F1), false)
  const unsure = marksFromScan(ownFansScan([page([fan(8, OTHER, true)])], ME))
  t.is(unsure.status, 'unsure')
  t.is(fanOf(unsure, OTHER), true)
  t.is(fanOf(unsure, F1), null)
  t.is(fanOf(NO_MARKS, OTHER), null)
  t.is(fanOf(null, OTHER), null)
  t.is(fanOf(withFan(unsure, F1, false, 12), F1), false)
})

test('fanButtonView: shown on a hosted node for someone else, and what it offers', async (t) => {
  const { fanButtonView, marksFromScan, ownFansScan, NO_MARKS, TEXTS } = await load()
  const base = { hosted: true, online: true, ownKey: ME, author: OTHER, page: false, blocked: false, busy: false, uncertain: false }
  const ready = marksFromScan(ownFansScan([page([fan(8, OTHER, true)], { start: true })], ME))
  const none = marksFromScan(ownFansScan([page([], { start: true })], ME))
  const v = fanButtonView({ ...base, marks: none })
  t.is(v.label, TEXTS.fan)
  t.is(v.kind, 'fan')
  t.is(v.disabled, false)
  t.is(fanButtonView({ ...base, marks: ready }).label, TEXTS.unfan)
  t.is(fanButtonView({ ...base, marks: ready }).kind, 'unfan')
  t.is(fanButtonView({ ...base, marks: NO_MARKS }).disabled, true, 'waits for the own diary')
  t.is(fanButtonView({ ...base, marks: ready, busy: true }).disabled, true)
  t.is(fanButtonView({ ...base, marks: ready, uncertain: true }).disabled, true, 'an uncertain write holds the button')
  t.is(fanButtonView({ ...base, marks: ready, online: false }).disabled, true)
  const unsure = marksFromScan(ownFansScan([page([fan(8, F1, true)])], ME))
  const short = fanButtonView({ ...base, marks: unsure })
  t.is(short.kind, 'fan', 'a walk that stopped short offers the idempotent Sou fã')
  t.is(short.label, TEXTS.fan)
  t.is(short.disabled, false)
  t.is(short.pending, false)
  t.is(fanButtonView({ ...base, marks: unsure, uncertain: true }).disabled, true, 'an uncertain write still holds it')
  const unsureOn = marksFromScan(ownFansScan([page([fan(8, OTHER, true)])], ME))
  t.is(fanButtonView({ ...base, marks: unsureOn }).kind, 'unfan', 'unfan only when the mark is known on')
  const unsureOff = marksFromScan(ownFansScan([page([fan(8, OTHER, false)])], ME))
  t.is(fanButtonView({ ...base, marks: unsureOff }).kind, 'fan')
  t.is(fanButtonView({ ...base, marks: { status: 'failed', fans: new Map(), top: null } }).kind, 'retry')
  t.is(fanButtonView({ ...base, marks: ready, hosted: false }), null)
  t.is(fanButtonView({ ...base, marks: ready, author: ME }), null)
  t.is(fanButtonView({ ...base, marks: ready, page: true }), null)
  t.is(fanButtonView({ ...base, marks: ready, blocked: true }), null)
  t.is(fanButtonView({ ...base, marks: undefined }).disabled, true)
  t.is(fanButtonView({ ...base, ownKey: null, marks: ready }), null)
})

test('fanCheck: Conferir settles from a short walk too, never claims "not a fan" from it', async (t) => {
  const { fanCheck, marksFromScan, ownFansScan, NO_MARKS, TEXTS } = await load()
  const ready = marksFromScan(ownFansScan([page([fan(8, OTHER, true)], { start: true })], ME))
  t.alike(fanCheck(ready, OTHER), { settled: true, text: TEXTS.checkedFan })
  t.alike(fanCheck(ready, F1), { settled: true, text: TEXTS.checkedNotFan })
  const unsure = marksFromScan(ownFansScan([page([fan(8, OTHER, false)])], ME))
  t.alike(fanCheck(unsure, OTHER), { settled: true, text: TEXTS.checkedNotFan })
  t.alike(fanCheck(unsure, F1), { settled: true, text: TEXTS.checkedNotWritten })
  t.alike(fanCheck(null, OTHER), { settled: false, text: TEXTS.checkFailed })
  t.alike(fanCheck(NO_MARKS, OTHER), { settled: false, text: TEXTS.checkFailed })
  t.alike(fanCheck({ status: 'failed', fans: new Map(), top: null }, OTHER), { settled: false, text: TEXTS.checkFailed })
})

test('topCheck: compares the newest own list, a short walk included', async (t) => {
  const { topCheck, marksFromScan, ownFansScan } = await load()
  const ready = marksFromScan(ownFansScan([page([top(9, [F1, F2])], { start: true })], ME))
  t.is(topCheck(ready, [F1, F2]), true)
  t.is(topCheck(ready, [F2, F1]), false)
  const shortWith = marksFromScan(ownFansScan([page([top(9, [F1])])], ME))
  t.is(shortWith.status, 'unsure')
  t.is(topCheck(shortWith, [F1]), true)
  const shortWithout = marksFromScan(ownFansScan([page([fan(9, OTHER, true)])], ME))
  t.is(topCheck(shortWithout, [F1]), false, 'a list that was taken would be among the newest blocks')
  t.is(topCheck(null, [F1]), null)
  t.is(topCheck({ status: 'failed', fans: new Map(), top: null }, [F1]), null)
  t.is(topCheck({ status: 'loading', fans: new Map(), top: null }, [F1]), null)
})

test('topFromPeek: only the own top-friends record at that seq', async (t) => {
  const { topFromPeek } = await load()
  const peek = (entries, who = ME) => ({ key: who, entries, invalid: [] })
  t.alike(topFromPeek(peek([top(40, [F1, F2])]), ME, 40), { seq: 40, keys: [F1, F2] })
  t.alike(topFromPeek(peek([top(40, [])]), ME, 40), { seq: 40, keys: [] })
  t.is(topFromPeek(peek([top(40, [F1])], OTHER), ME, 40), null, 'another diary')
  t.is(topFromPeek(peek([top(41, [F1])]), ME, 40), null, 'another seq')
  t.is(topFromPeek(peek([fan(40, F1, true)]), ME, 40), null, 'another type')
  t.is(topFromPeek(peek([top(40, [F1, F1])]), ME, 40), null, 'a repeat')
  t.is(topFromPeek(peek([top(40, [ME])]), ME, 40), null, 'the own key')
  t.is(topFromPeek(peek([top(40, ['zz'])]), ME, 40), null)
  t.is(topFromPeek(peek([top(40, Array.from({ length: 64 }, (_, i) => key(i + 1)))]), ME, 40), null, 'over the limit')
  t.is(topFromPeek(null, ME, 40), null)
  t.is(topFromPeek(peek([top(40, [F1])]), 'nope', 40), null)
  t.is(topFromPeek(peek([top(40, [F1])]), ME, 0), null)
})

test('editorSource: the own diary first, the seeder pointer read back, else locked', async (t) => {
  const { editorSource, marksFromScan, ownFansScan, NO_MARKS, TEXTS } = await load()
  const ready = marksFromScan(ownFansScan([page([top(9, [F1])], { start: true })], ME))
  const readyNone = marksFromScan(ownFansScan([page([], { start: true })], ME))
  const shortWith = marksFromScan(ownFansScan([page([top(9, [F2])])], ME))
  const short = marksFromScan(ownFansScan([page([fan(9, OTHER, true)])], ME))
  const failed = { status: 'failed', fans: new Map(), top: null }
  const index = (top, complete = true) => ({ about: null, mood: null, indexing: false, complete, fans: null, top })

  t.alike(editorSource({ marks: ready }), { phase: 'open', top: { seq: 9, keys: [F1] }, note: null, peekSeq: null })
  t.alike(editorSource({ marks: readyNone }), { phase: 'open', top: null, note: null, peekSeq: null }, 'a settled walk without a list opens empty, no note')
  t.alike(editorSource({ marks: shortWith, index: index({ seq: 3, back: {} }) }).top, { seq: 9, keys: [F2] }, 'the newest list found wins over the seeder')
  t.is(editorSource({ marks: NO_MARKS }).phase, 'loading')
  t.is(editorSource({ marks: failed, index: index(null) }).phase, 'locked')

  t.is(editorSource({ marks: short, index: null }).phase, 'loading', 'waits for the profile answer')
  t.is(editorSource({ marks: short, index: null, indexFailed: true }).phase, 'locked')
  t.is(editorSource({ marks: short, index: index(null, false) }).phase, 'locked', 'an incomplete answer keeps it locked')
  t.is(editorSource({ marks: short, index: index({ seq: 40, back: {} }, false) }).phase, 'locked')
  t.alike(editorSource({ marks: short, index: index(null) }), { phase: 'open', top: null, note: TEXTS.topOlderNote, peekSeq: null })

  const asks = editorSource({ marks: short, index: index({ seq: 40, back: {} }) })
  t.is(asks.phase, 'loading')
  t.is(asks.peekSeq, 40)
  t.alike(editorSource({ marks: short, index: index({ seq: 40, back: {} }), fallback: { seq: 40, top: { seq: 40, keys: [F1, F2] } } }), { phase: 'open', top: { seq: 40, keys: [F1, F2] }, note: null, peekSeq: null })
  t.is(editorSource({ marks: short, index: index({ seq: 40, back: {} }), fallback: { seq: 40, top: null } }).phase, 'locked', 'a pointer that did not verify locks')
  t.is(editorSource({ marks: short, index: index({ seq: 41, back: {} }), fallback: { seq: 40, top: { seq: 40, keys: [F1] } } }).peekSeq, 41, 'a new pointer is read again')
})

test('addCandidates: followed, not picked, not self, not blocked', async (t) => {
  const { addCandidates, openEditor } = await load()
  const state = openEditor({ keys: [F1] })
  const follows = [F1, F2, ME, OTHER, 'zz']
  const out = addCandidates({ follows, state, self: ME, isBlocked: (k) => k === OTHER, profileOf: () => null, text: '' })
  t.alike(out, [F2])
})

test('ownTopRows follows the own record and marks the ones waiting', async (t) => {
  const { ownTopRows } = await load()
  const rows = ownTopRows({ seq: 4, keys: [F1, F2] }, { rows: [{ key: F2, status: 'pending' }, { key: F1, status: 'confirmed' }] })
  t.is(rows.length, 2)
  t.is(rows[0].key, F1)
  t.is(rows[0].label, null)
  t.is(rows[1].status, 'pending')
  t.ok(typeof rows[1].label === 'string' && rows[1].label.length > 0)
  t.alike(ownTopRows(null, null), [])
})

test('sameList and rebase', async (t) => {
  const { sameList, rebase } = await load()
  t.ok(sameList({ keys: [F1, F2] }, [F1, F2]))
  t.absent(sameList({ keys: [F1, F2] }, [F2, F1]), 'the order matters')
  t.absent(sameList({ keys: [F1] }, [F1, F2]))
  t.absent(sameList(null, []))
  t.alike(rebase([F1, F1, F2]).keys, [F1, F2])
})

test('strings: no em dash, and the pure module quotes no method name', async (t) => {
  const { TEXTS, editorIntroText, topCountText } = await load()
  for (const value of Object.values(TEXTS)) {
    const text = typeof value === 'function' ? value(2) : value
    t.absent(text.includes(DASH), text)
  }
  t.absent(editorIntroText().includes(DASH))
  t.is(topCountText(1), '1 pessoa')
  t.is(topCountText(3), '3 pessoas')
  t.is(topCountText(-1), '')
  const src = fs.readFileSync(path.join(__dirname, '../src/fansView.js'), 'utf8')
  t.absent(/'(fan|top|follow|log|diary)\.[a-z]+'/.test(src), 'no quoted RPC method name')
  t.is(TEXTS.fan, 'Sou fã')
  t.is(TEXTS.unfan, 'Deixar de ser fã')
})
