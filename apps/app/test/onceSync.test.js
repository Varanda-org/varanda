'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const load = () => import('../src/onceSync.js')
const read = (file) => readFileSync(join(__dirname, '..', file), 'utf8')
const MEMBER = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const PAGE = 'c'.repeat(64)

test('setOnceMember keeps only a known key, memory only', async (t) => {
  const { setOnceMember, onceMember } = await load()
  t.is(onceMember(), null, 'nothing syncs before the shell names a member')
  setOnceMember(MEMBER)
  t.is(onceMember(), MEMBER)
  for (const bad of [null, undefined, '', 'A'.repeat(64), 'a'.repeat(63), 42]) {
    setOnceMember(bad)
    t.is(onceMember(), null, 'not a key: ' + String(bad))
  }
})

test('onceMemberFor: the marks of a member count only while its seen document syncs', async (t) => {
  const { onceMemberFor } = await load()
  const rows = [
    [MEMBER, MEMBER, MEMBER, 'same member'],
    [MEMBER, MEMBER.toUpperCase(), MEMBER, 'same key in capitals'],
    [MEMBER, OTHER, null, 'another member'],
    [null, MEMBER, null, 'nothing syncs (core node, varanda-serve, locked, no terms)'],
    [MEMBER, null, null, 'no monitor member'],
    ['xyz', 'xyz', null, 'not a key']
  ]
  for (const [syncing, member, want, label] of rows) t.is(onceMemberFor(syncing, member), want, label)
})

test('firstPassStep: settles once per member appearance, reset on any change', async (t) => {
  const { FIRST_PASS_IDLE, firstPassStep, firstPassReady, inviteWaitsForSeen } = await load()
  const rows = [
    [FIRST_PASS_IDLE, { type: 'member', member: MEMBER }, { member: MEMBER, settled: false }, 'a member appears unsettled'],
    [{ member: MEMBER, settled: false }, { type: 'settle', member: MEMBER }, { member: MEMBER, settled: true }, 'its pass (or the timer) settles it'],
    [{ member: MEMBER, settled: false }, { type: 'settle', member: OTHER }, { member: MEMBER, settled: false }, 'a late answer for another member is ignored'],
    [{ member: MEMBER, settled: true }, { type: 'member', member: OTHER }, { member: OTHER, settled: false }, 'a new member starts over'],
    [{ member: MEMBER, settled: true }, { type: 'member', member: null }, { member: null, settled: false }, 'a lock resets'],
    [{ member: MEMBER, settled: true }, { type: 'member', member: MEMBER }, { member: MEMBER, settled: true }, 'the same member keeps its state'],
    [{ member: null, settled: false }, { type: 'settle', member: null }, { member: null, settled: false }, 'no member never settles'],
    [{ member: MEMBER, settled: false }, { type: 'nope', member: MEMBER }, { member: MEMBER, settled: false }, 'unknown event'],
    [undefined, { type: 'settle', member: MEMBER }, FIRST_PASS_IDLE, 'no state yet']
  ]
  for (const [state, event, want, label] of rows) t.alike(firstPassStep(state, event), want, label)

  let s = FIRST_PASS_IDLE
  s = firstPassStep(s, { type: 'member', member: MEMBER })
  t.is(inviteWaitsForSeen(s, MEMBER), true, 'the invite monitor waits for the first pass')
  s = firstPassStep(s, { type: 'settle', member: MEMBER })
  t.is(firstPassReady(s, MEMBER), true)
  t.is(inviteWaitsForSeen(s, MEMBER), false, 'then it starts')
  t.is(inviteWaitsForSeen(s, OTHER), true, 'a settled pass of another member does not count')
  s = firstPassStep(s, { type: 'member', member: null })
  t.is(inviteWaitsForSeen(s, null), false, 'without a syncing member nothing waits, as before')
  s = firstPassStep(s, { type: 'member', member: MEMBER })
  t.is(inviteWaitsForSeen(s, MEMBER), true, 'unlocking again waits for a new first pass')
})

test('the shared registry: a mark under the syncing member reads as seen through the page store', async (t) => {
  const { onceRegistry, setOnceMember, onceMember } = await load()
  const { syncedPageNoticeStore } = await import('../src/onceMarks.js')
  const { pageNoticeKey, pageNoticeSeen, notePageNotice } = await import('../src/pageNotice.js')
  const disk = new Map()
  const base = { getItem: (k) => (disk.has(k) ? disk.get(k) : null), setItem: (k, v) => { disk.set(k, v) } }
  const marks = []
  const off = onceRegistry.onMark((m) => marks.push(m))

  setOnceMember(null)
  t.is(syncedPageNoticeStore(base, onceMember(), onceRegistry), base, 'no syncing member: the device store, untouched')
  notePageNotice(syncedPageNoticeStore(base, onceMember(), onceRegistry), PAGE)
  t.is(marks.length, 0, 'nothing marked without a syncing member')
  disk.clear()

  setOnceMember(MEMBER)
  onceRegistry.setRemote(MEMBER, [])
  t.absent(pageNoticeSeen(syncedPageNoticeStore(base, onceMember(), onceRegistry), PAGE))
  notePageNotice(syncedPageNoticeStore(base, onceMember(), onceRegistry), PAGE)
  t.is(marks.length, 1, 'showing the notice marks it')
  t.is(marks[0].member, MEMBER)
  t.is(disk.get(pageNoticeKey(PAGE)), '1', 'and still remembers it on this device')

  disk.clear()
  setOnceMember(OTHER)
  onceRegistry.setRemote(OTHER, [marks[0].token])
  t.absent(pageNoticeSeen(syncedPageNoticeStore(base, onceMember(), onceRegistry), PAGE), 'a token is bound to its member')
  setOnceMember(null)
  off()
})

const app = read('App.js')

test('App: the four page notice call sites read and write through the synced store', (t) => {
  const synced = 'syncedPageNoticeStore(pageNoticeStore(), onceMember(), onceRegistry)'
  t.ok(app.includes('pageDmPlan({ hint, read, seen: pageNoticeSeen(' + synced + ', key), canConverse })'), 'a post row decides with the synced marks')
  t.ok(read('src/screens/Membro.js').includes('if (' + synced + ".getItem(key) === '1') {"), 'the profile')
  t.ok(read('src/screens/Anuncio.js').includes('listing.page === true && !pageNoticeSeen(' + synced + ', listing.author)'), 'a page listing')
  t.ok(read('src/ui/PageNoticeSheet.js').includes('notePageNotice(' + synced + ', page)'), 'the sheet writes the mark')
  for (const file of ['App.js', 'src/screens/Membro.js', 'src/screens/Anuncio.js', 'src/ui/PageNoticeSheet.js']) {
    const src = read(file)
    t.is(src.split('pageNoticeStore()').length, src.split(synced).length, file + ': no call site left on the device store alone')
  }
})

test('App: the syncing member is the seen member, set in render', (t) => {
  const at = app.indexOf('const seenMember = ')
  t.ok(at > 0)
  t.ok(app.indexOf('setOnceMember(seenMember)') > at, 'the shared registry follows seenMember')
  t.is(app.split('setOnceMember(').length, 2, 'set in one place only')
})

test('App: after a pass, the remote marks of that same member', (t) => {
  const run = app.slice(app.indexOf('const result = await runSeenPass({'), app.indexOf('if (result.dmChanged) bumpDm()'))
  const guard = run.indexOf('if (seenMemberRef.current !== member) return')
  t.ok(guard > 0, 'a pass for an older member stops first')
  t.ok(run.indexOf("stepFirstPass({ type: 'settle', member })") > guard, 'an answer or a failure settles the first pass')
  t.ok(run.indexOf("stepFirstPass({ type: 'settle', member })") < run.indexOf('if (result.avisos) {'), 'settled even without avisos (a failed pass)')
  const avisos = run.slice(run.indexOf('if (result.avisos) {'))
  t.ok(avisos.includes('onceRegistry.setRemote(member, result.avisos.own)'), 'the merged own tokens become remote marks')
})

test('App: the first pass flag resets per member and times out', (t) => {
  const reset = app.slice(app.indexOf('avisosSeenRef.current = { own: [], pages: {} }\n    avisosMergedRef.current = null'), app.indexOf('}, [seenMember])'))
  t.ok(reset.includes("stepFirstPass({ type: 'member', member: seenMember })"), 'a member change resets it')
  t.ok(reset.includes("setTimeout(() => stepFirstPass({ type: 'settle', member }), FIRST_PASS_MS)") && reset.includes('return () => clearTimeout(t)'), 'and a timer settles it at the latest')
  t.ok(app.includes('useReducer(firstPassStep, FIRST_PASS_IDLE)'))
})

test('App: a mark goes out through onAvisosSeen under the own key, for the seen member only', (t) => {
  const at = app.indexOf('onceRegistry.onMark(')
  t.ok(at > app.indexOf('const onAvisosSeen = useCallback('), 'after onAvisosSeen exists')
  const sub = app.slice(at, app.indexOf('}), [onAvisosSeen, ownKey])', at))
  t.ok(sub.includes('if (member !== seenMemberRef.current || typeof ownKey !== \'string\' || ownKey.toLowerCase() !== member) return'), 'a mark for another member is ignored')
  t.ok(sub.includes('onAvisosSeen(ownKey, [token])'), 'the existing pending, debounce and merge send it')
})

test('App: the invite monitor waits for the first pass and shares its marks', (t) => {
  const drop = app.match(/const inviteDrop = useInviteDrop\(\{([\s\S]*?)\n {2}\}\)/)[1]
  t.ok(drop.includes('pkStatus?.unlocked === true && termsOk && !inviteWaitsForSeen(firstPass, seenMember)'), 'not before the first seen pass settled')
  t.ok(drop.includes('seenElsewhere: inviteSeenElsewhere') && drop.includes('onMarked: inviteMarked'))
  t.ok(app.includes('const inviteOnce = onceMemberFor(seenMember, member)'), 'only for the monitor member when it is the seen member')
  t.ok(app.includes("inviteOnce !== null && onceRegistry.has('invite-drop', inviteOnce, inviteDropOnceId(record))"))
  t.ok(app.includes("if (inviteOnce !== null) onceRegistry.mark('invite-drop', inviteOnce, inviteDropOnceId(record))"))
})
