'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const load = () => import('../src/onceSync.js')
const read = (file) => readFileSync(join(__dirname, '..', file), 'utf8')
const MEMBER = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const PAGE = 'c'.repeat(64)
const KEY = 'd'.repeat(64)

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

test('onceKeyOf: only a hex64 key', async (t) => {
  const { onceKeyOf } = await load()
  t.is(onceKeyOf({ key: MEMBER }), MEMBER)
  for (const bad of [null, undefined, {}, { key: null }, { key: MEMBER.toUpperCase() }, { key: 'ab' }, 'x', { key: 5 }]) t.is(onceKeyOf(bad), null, JSON.stringify(bad))
})

test('firstPassStep: settles once per member appearance, after the pass and the key or the timer', async (t) => {
  const { FIRST_PASS_IDLE, firstPassStep, firstPassReady, inviteWaitsForSeen } = await load()
  const at = (member, pass, key, settled) => ({ member, pass, key, settled })
  const rows = [
    [FIRST_PASS_IDLE, { type: 'member', member: MEMBER }, at(MEMBER, false, false, false), 'a member appears unsettled'],
    [at(MEMBER, false, false, false), { type: 'pass', member: MEMBER }, at(MEMBER, true, false, false), 'its pass alone does not settle it'],
    [at(MEMBER, false, false, false), { type: 'key', member: MEMBER }, at(MEMBER, false, true, false), 'its key alone does not settle it'],
    [at(MEMBER, true, false, false), { type: 'key', member: MEMBER }, at(MEMBER, true, true, true), 'pass and key settle it'],
    [at(MEMBER, false, true, false), { type: 'pass', member: MEMBER }, at(MEMBER, true, true, true), 'in either order'],
    [at(MEMBER, false, false, false), { type: 'timeout', member: MEMBER }, at(MEMBER, false, false, true), 'the timer settles it at the latest'],
    [at(MEMBER, false, false, false), { type: 'pass', member: OTHER }, at(MEMBER, false, false, false), 'a late answer for another member is ignored'],
    [at(MEMBER, true, true, true), { type: 'member', member: OTHER }, at(OTHER, false, false, false), 'a new member starts over'],
    [at(MEMBER, true, true, true), { type: 'member', member: null }, at(null, false, false, false), 'a lock resets'],
    [at(MEMBER, true, true, true), { type: 'member', member: MEMBER }, at(MEMBER, true, true, true), 'the same member keeps its state'],
    [at(null, false, false, false), { type: 'timeout', member: null }, at(null, false, false, false), 'no member never settles'],
    [at(MEMBER, false, false, false), { type: 'settle', member: MEMBER }, at(MEMBER, false, false, false), 'unknown event'],
    [undefined, { type: 'pass', member: MEMBER }, FIRST_PASS_IDLE, 'no state yet']
  ]
  for (const [state, event, want, label] of rows) t.alike(firstPassStep(state, event), want, label)

  let s = FIRST_PASS_IDLE
  s = firstPassStep(s, { type: 'member', member: MEMBER })
  t.is(inviteWaitsForSeen(s, MEMBER), true, 'the invite monitor waits for the first pass')
  s = firstPassStep(s, { type: 'pass', member: MEMBER })
  t.is(inviteWaitsForSeen(s, MEMBER), true, 'and for the key attempt')
  s = firstPassStep(s, { type: 'key', member: MEMBER })
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
  onceRegistry.setKey(MEMBER, KEY)
  onceRegistry.setRemote(MEMBER, [])
  t.absent(pageNoticeSeen(syncedPageNoticeStore(base, onceMember(), onceRegistry), PAGE))
  notePageNotice(syncedPageNoticeStore(base, onceMember(), onceRegistry), PAGE)
  t.is(marks.length, 1, 'showing the notice marks it')
  t.is(marks[0].member, MEMBER)
  t.is(disk.get('varanda-once-' + marks[0].token), '1', 'and still remembers it on this device, under an opaque name')
  t.absent(disk.has(pageNoticeKey(PAGE)), 'never under the Página key')

  disk.clear()
  setOnceMember(OTHER)
  onceRegistry.setKey(OTHER, KEY)
  onceRegistry.setRemote(OTHER, [marks[0].token])
  t.absent(pageNoticeSeen(syncedPageNoticeStore(base, onceMember(), onceRegistry), PAGE), 'a token is bound to its member')
  onceRegistry.forget(MEMBER)
  onceRegistry.forget(OTHER)
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

test('App: a pass sends the unsynced marks and, once answered, settles them', (t) => {
  const run = app.slice(app.indexOf('const sent = cleanAvisos('), app.indexOf('if (result.dmChanged) bumpDm()'))
  t.ok(run.startsWith('const sent = cleanAvisos(withOnceTokens(avisosSeenRef.current, onceRegistry.unsynced(member)))'), 'whatever the pending list holds')
  const guard = run.indexOf('if (seenMemberRef.current !== member || seenAppearanceRef.current !== appearance) return')
  t.ok(guard > 0, 'a pass for an older member, or an earlier appearance of the same one, stops first')
  t.ok(app.includes('const appearance = ++seenAppearanceRef.current\n    if (seenMember === null) return'), 'every seenMember change is a new appearance')
  t.ok(app.includes('const member = seenMember\n    const appearance = seenAppearanceRef.current\n    const run = async () => {'), 'the pass takes the appearance it runs for')
  t.ok(run.indexOf("stepFirstPass({ type: 'pass', member })") > guard, 'an answer or a failure settles the pass half')
  t.ok(run.indexOf("stepFirstPass({ type: 'pass', member })") < run.indexOf('if (result.avisos) {'), 'settled even without avisos (a failed pass)')
  const avisos = run.slice(run.indexOf('if (result.avisos) {'))
  t.ok(avisos.indexOf('onceRegistry.delivered(member, sent.own)') > 0, 'what the merge took stops going out')
  t.ok(avisos.indexOf('onceRegistry.setRemote(member, result.avisos.own)') > avisos.indexOf('onceRegistry.delivered(member, sent.own)'), 'the merged own tokens become remote marks')
})

test('App: per member appearance, one key request, a timer, and forget on the way out', (t) => {
  const reset = app.slice(app.indexOf('avisosSeenRef.current = { own: [], pages: {} }\n    avisosMergedRef.current = null'), app.indexOf('}, [seenMember])'))
  t.ok(reset.includes("stepFirstPass({ type: 'member', member: seenMember })"), 'a member change resets it')
  t.ok(reset.includes("setTimeout(() => stepFirstPass({ type: 'timeout', member }), FIRST_PASS_MS)"), 'a timer settles it at the latest')
  t.is(reset.split("'seen.onceKey'").length, 2, 'one request, no retry')
  t.ok(reset.includes('if (live && seenAppearanceRef.current === appearance && seenMemberRef.current === member && key !== null) onceRegistry.setKey(member, key)'), 'a late answer for another member or appearance is dropped')
  t.ok(reset.includes(".then(() => { if (live) stepFirstPass({ type: 'key', member }) })"), 'answer or failure settles the key half')
  t.ok(reset.includes('clearTimeout(t)') && reset.includes('onceRegistry.forget(member)'), 'cleanup forgets the member')
  t.ok(app.includes('useReducer(firstPassStep, FIRST_PASS_IDLE)'))
})

test('App: a new mark of the seen member asks for a prompt pass', (t) => {
  const at = app.indexOf('onceRegistry.onMark(')
  t.ok(at > 0)
  const sub = app.slice(at, app.indexOf('}), [])', at))
  t.ok(sub.includes('if (member !== seenMemberRef.current || !seenSchedulerRef.current) return'), 'a mark for another member is ignored')
  t.ok(sub.includes("seenSchedulerRef.current.wake('once')"))
})

test('App: the invite monitor waits for the first pass, shares its marks and rechecks on a change', (t) => {
  const drop = app.match(/const inviteDrop = useInviteDrop\(\{([\s\S]*?)\n {2}\}\)/)[1]
  t.ok(drop.includes('pkStatus?.unlocked === true && termsOk && !inviteWaitsForSeen(firstPass, seenMember)'), 'not before the first seen pass settled')
  t.ok(drop.includes('seenElsewhere: inviteSeenElsewhere') && drop.includes('onMarked: inviteMarked'))
  t.ok(app.includes('const inviteOnce = onceMemberFor(seenMember, member)'), 'only for the monitor member when it is the seen member')
  t.ok(app.includes("inviteOnce !== null && onceRegistry.has('invite-drop', inviteOnce, inviteDropOnceId(record))"))
  t.ok(app.includes("if (inviteOnce !== null) onceRegistry.mark('invite-drop', inviteOnce, inviteDropOnceId(record))"))
  t.ok(app.includes('useEffect(() => onceRegistry.onChange(recheckInvite), [recheckInvite])'), 'a late remote mark dismisses the note')
  const hook = read('src/useInviteDrop.js')
  t.ok(hook.includes('active.update({ enabled, member, request })'), 'update takes only what it reads')
  t.ok(hook.includes('const recheck = useCallback(() => monitor.current.recheck(), [])'))
})
