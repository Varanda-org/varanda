'use strict'

// App.js is the shell. Read it as text so this test never loads JSX.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')

const source = () => fs.readFileSync(path.join(__dirname, '../App.js'), 'utf8')

test('native group and community links reach the shell through Linking', (t) => {
  const s = source()
  t.ok(s.includes('parseAppLink('))
  t.ok(s.includes("'grupo'"))
  t.ok(s.includes("'comunidade'"))
  t.ok(s.includes('setPendingLink'))
  t.absent(s.includes("hostedPage === true && Platform.OS === 'web'"))
})

test('a public post link opens only on a hosted node, once', (t) => {
  const s = source()
  t.ok(s.includes("if (pendingPost === null || !atTabs || mode !== 'hosted') return"), 'waits for the tabs and a hosted node')
  t.ok(s.includes('}, [pendingPost, atTabs, mode, openThread])'))
})

test('a group or community link is never consent to join', (t) => {
  const s = source()
  t.absent(s.includes('group.join'))
  t.absent(s.includes("'community.join'"))
})

test('a pending group or community link belongs to the installation it arrived on', (t) => {
  const s = source()
  t.ok(s.includes('{ kind: CAPTURED_ENTRY.kind, key: CAPTURED_ENTRY.key, origin: ageOrigin }'))
  t.absent(s.includes('CAPTURED_GROUP'))
  t.absent(s.includes('CAPTURED_COMMUNITY'))
  t.ok(s.includes('setPendingLink({ kind: link.kind, key: link.key, origin: ageOrigin })'))
  t.ok(s.includes('pendingLink.origin !== ageOrigin'))
})

// The pendingLink effect, from its first guard to its deps.
const pendingEffect = (s) => {
  const start = s.indexOf("if (pendingLink === null || ageOrigin === '') return")
  const end = s.indexOf('}, [pendingLink, mode, atTabs, pushScreen, ageOrigin])', start)
  return start === -1 || end === -1 ? '' : s.slice(start, end)
}

test('a stored entry link is read once and dropped before it opens', (t) => {
  const s = source()
  t.ok(s.includes('const CAPTURED_ENTRY = captureEntryLink()'))
  const e = pendingEffect(s)
  t.ok(e !== '')
  const push = e.indexOf('pushScreen({ screen: pendingLink.kind')
  t.ok(push !== -1)
  const mismatch = e.indexOf('pendingLink.origin !== ageOrigin')
  t.ok(mismatch !== -1)
  const mismatchEnd = e.indexOf('return', mismatch)
  const drop = e.indexOf('dropEntryLink()', mismatch)
  t.ok(drop !== -1 && drop < mismatchEnd)
  const before = e.indexOf('dropEntryLink()', mismatchEnd)
  t.ok(before !== -1 && before < push)
})

test('an App Link before the installation is held and parsed again once it loads', (t) => {
  const s = source()
  t.ok(s.includes('waitsForInstallation(url)'))
  t.ok(s.includes('if (signup === null && rec === null && link === null && waitsForInstallation(url)) {'), 'held only when no capture took the URL')
  t.ok(s.includes('heldUrlRef.current = url'))
  const group = s.indexOf('setPendingLink({ kind: link.kind, key: link.key, origin: ageOrigin })\n      return')
  t.ok(group !== -1 && group < s.indexOf('waitsForInstallation(url)) {'), 'a group or community link returns before the hold')
  const replay = s.indexOf('try { appUrlRef.current(url) } catch {}\n  }, [ageOrigin])')
  t.ok(replay !== -1)
  const body = s.slice(s.lastIndexOf('useEffect(() => {', replay), replay)
  t.ok(body.includes("if (ageOrigin === '' || heldUrlRef.current === null) return"), 'replays only once an installation is known')
  t.ok(body.includes('heldUrlRef.current = null'))
})

test('Entrar announces a pending entry link and agora nao drops it', (t) => {
  const s = source()
  t.ok(s.includes('entryCardText(pendingLink.kind)'))
  t.ok(s.includes('const entryProp = invite === null && pendingLink !== null'), 'a pending profile invite always wins')
  t.ok(s.includes('invite={inviteProp || entryProp || postProp}'))
  t.ok(s.includes('onDismiss: () => { dropEntryLink(); setPendingLink(null) }'))
})

test('the post opening card sits between the invite card and the intro', (t) => {
  const s = source()
  const invite = s.indexOf("opening === 'card' && openResult !== null")
  const post = s.indexOf('postOpeningGate(')
  const intro = s.indexOf('if (showIntro) {')
  t.ok(invite > 0 && post > invite && intro > post)
  t.ok(s.includes('inviteOpening: opening'))
  t.ok(s.includes('dismissed: postOpenLater'))
  t.ok(s.includes('<PostLinkOpen post={pendingPost} origin={ageOrigin} onEnter={() => { intro.markSeen(); setPostOpenLater(true) }}'))
})

test('the post opening shows to a returning visitor with no account, held and latched', (t) => {
  const s = source()
  t.ok(s.includes('account: postAccount('), 'the account decides, not the platform')
  t.ok(s.includes('waitedMs: postWaitAt.current === null ? NaN'), 'no clock, no wait')
  t.ok(s.includes("opening === 'wait' || postWait)"), 'the wait holds the splash')
  t.ok(s.includes('[postWait, postDeadline]'), 'the timer re-arms when the clock starts or is reset')
  const gate = s.indexOf('postOpeningGate(postGate)')
  const latch = s.indexOf('if (showIntro || deletedNotice || showTerms || !connectingSplash) postPassed.current = true')
  const intro = s.indexOf('if (showIntro) {')
  t.ok(gate > 0 && latch > gate && intro > latch, 'a real screen past the gate latches it')
  const later = s.indexOf('setPostOpenLater(false)')
  const resetPassed = s.indexOf('postPassed.current = false', later)
  const resetWait = s.indexOf('postWaitAt.current = null', later)
  t.ok(later > 0 && resetPassed > later && resetWait > later, 'a new post link resets the latch and the clock')
  const seen = s.indexOf('if (postPassed.current) postScreenSeen.current = true')
  t.ok(seen > latch && seen < intro, 'the latch also marks a screen as seen')
  t.ok(s.includes('booting: !postScreenSeen.current && '), 'a seen screen never gives way to the splash again')
  t.is(s.indexOf('postScreenSeen.current = false'), -1, 'nothing resets the seen screen')
  t.ok(s.includes('held: postHeld.current'), 'a step Identidade holds keeps the preview away')
  t.ok(/<Identidade [^\n]*\bsetup\b[^\n]*onStepHeld=\{holdPostStep\}/.test(s), 'the setup Identidade reports its held step')
})

test('Identidade writes the post hold before it drops the recovery flag', (t) => {
  const s = fs.readFileSync(path.join(__dirname, '../src/screens/Identidade.js'), 'utf8')
  const start = s.indexOf('Promise.resolve(pending)')
  t.ok(start > 0)
  const hold = s.indexOf('onStepHeld(true)', start)
  const waiting = s.indexOf('if (r && r.pending === true) {', start)
  const needs = s.indexOf('if (r && r.needsPasskey === true) {', start)
  t.ok(hold > start, 'a synchronous hold, not only the effect')
  t.ok(waiting > hold && needs > hold, 'before both branches release the recovery')
  t.ok(s.indexOf('passkey.endRecovery()', start) > hold)
})
