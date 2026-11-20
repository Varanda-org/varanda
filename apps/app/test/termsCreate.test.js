'use strict'

// The hosted terms gate around Entrar and Criar conta (src/termsCreate.js),
// and the shell and Identidade wiring that the pure rules rely on.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8')

function body (src, head) {
  const start = src.indexOf(head)
  if (start === -1) return ''
  const next = src.indexOf('\n  const ', start + head.length)
  return src.slice(start, next === -1 ? undefined : next)
}

const load = () => import('../src/termsCreate.js')
const loadTerms = () => import('../src/terms.js')

const X = 'ab'.repeat(32)
const T1 = '2026-10-27T12:00:00.000Z'

test('createNeedsTerms: table', async (t) => {
  const { createNeedsTerms } = await load()
  const claim = { at: T1 }
  const rows = [
    // [hosted, claim, needed, label]
    [true, null, true, 'hosted, no claim: whatever the device recorded for someone else'],
    [true, undefined, true, 'hosted, claim unknown'],
    [true, claim, false, 'a claim from this page load'],
    [false, null, false, 'native or serve'],
    [false, claim, false, 'native with a claim'],
    [undefined, null, false, 'hosted unknown'],
    ['true', null, false, 'hosted must be true']
  ]
  for (const [hosted, c, needed, label] of rows) {
    t.is(createNeedsTerms({ hosted, claim: c }), needed, label)
  }
  t.is(createNeedsTerms(), false, 'no arguments')
})

test('createTermsReason is gone: the create gate always says needed', async (t) => {
  const mod = await load()
  t.is(mod.createTermsReason, undefined)
  const src = read('App.js')
  t.ok(src.includes("<Termos gate reason='needed' version={LEGAL_VERSION} onAccept={acceptCreateTerms}"), 'an older record says nothing about the new person')
})

test('modeUnknownPass: table', async (t) => {
  const { modeUnknownPass } = await load()
  const I = 'https://bora.varanda.app'
  const hostedCfg = { kind: 'hosted', installationUrl: I }
  const ownCfg = { seederUrl: 'ws://127.0.0.1:1', association: X }
  const rows = [
    // [hostedMode, hostedPage, installation, config, phase, decision, pass, label]
    [false, true, null, null, 'loading', 'needed', true, 'hosted page, loading, no record'],
    [false, true, null, null, 'connecting', 'needed', true, 'hosted page, connecting'],
    [false, true, null, null, 'connecting', 'updated', true, 'an older record'],
    [false, true, null, null, 'connecting', 'account', true, 'account'],
    [false, false, I, null, 'loading', 'needed', true, 'an app pointed at an installation'],
    [false, false, I, hostedCfg, 'connecting', 'needed', true, 'the installation\'s own configuration'],
    [false, true, null, null, 'connecting', 'accepted', false, 'nothing to show anyway'],
    [false, true, null, null, 'connecting', 'loading', false, 'still loading the record'],
    [false, true, null, null, 'config-error', 'needed', false, 'config-error shows the gate as before'],
    [false, true, null, null, 'error', 'needed', false, 'error shows the gate as before'],
    [false, true, null, null, 'config', 'needed', false, 'the configuration form'],
    [false, true, null, null, 'ready', 'needed', false, 'connected without a hosted identity'],
    [true, true, null, null, 'connecting', 'needed', false, 'the mode is known'],
    [false, false, I, ownCfg, 'connecting', 'needed', false, 'native with its own core node'],
    [false, true, null, ownCfg, 'connecting', 'needed', false, 'a configuration typed on the hosted page'],
    [false, false, null, null, 'connecting', 'needed', false, 'varanda-serve: no hosted page, no installation'],
    [false, false, '', null, 'loading', 'needed', false, 'an empty installation'],
    [false, 'true', null, null, 'loading', 'needed', false, 'hostedPage must be true'],
    [false, true, null, 'cfg', 'loading', 'needed', false, 'a configuration that is not an object']
  ]
  for (const [hostedMode, hostedPage, installation, config, phase, decision, pass, label] of rows) {
    t.is(modeUnknownPass({ hostedMode, hostedPage, installation, config, phase, decision }), pass, label)
  }
  t.is(modeUnknownPass(), false, 'no arguments')
})

test('recoverView: table', async (t) => {
  const { recoverView, RECOVER_WAIT_MS } = await load()
  const base = { hosted: true, locked: false, member: null, claim: null, decision: 'needed', recovering: true, elapsedMs: 0 }
  const rows = [
    // [overrides, window, wait, label]
    [{}, true, true, 'after Entrar, before the key: the splash'],
    [{ elapsedMs: RECOVER_WAIT_MS - 1 }, true, true, 'just before the cap'],
    [{ elapsedMs: RECOVER_WAIT_MS }, true, false, 'the cap: the gate'],
    [{ elapsedMs: NaN }, true, false, 'no start: the gate'],
    [{ elapsedMs: -1 }, true, false, 'a clock that went back: the gate'],
    [{ recovering: false }, true, false, 'the recovery ended without a key: the gate'],
    [{ member: X }, false, false, 'the key is known: the held check decides'],
    [{ claim: { at: T1 } }, false, false, 'a claim (Criar conta): nothing to wait for'],
    [{ locked: true }, false, false, 'still at Entrar'],
    [{ locked: undefined }, false, false, 'locked unknown'],
    [{ hosted: false }, false, false, 'native or serve'],
    [{ decision: 'accepted' }, false, false, 'accepted'],
    [{ decision: 'loading' }, false, false, 'loading'],
    [{ decision: 'updated' }, false, false, 'updated is never this state']
  ]
  for (const [o, window, wait, label] of rows) {
    t.alike(recoverView({ ...base, ...o }), { window, wait, card: false }, label)
  }
  t.alike(recoverView(), { window: false, wait: false, card: false }, 'no arguments')
})

test('recoverView: the empty card is rendered instead of the splash or the gate', async (t) => {
  const { recoverView, RECOVER_WAIT_MS } = await load()
  const OTHER = 'cd'.repeat(32)
  const noDiary = { unlocked: true, exists: false, publicKey: null }
  const base = { hosted: true, locked: false, member: null, claim: null, decision: 'needed', recovering: true, elapsedMs: 0, card: X, status: noDiary }
  const rows = [
    // [overrides, window, wait, card, label]
    [{}, false, false, true, 'card up, recovery on: the shell, no splash'],
    [{ elapsedMs: RECOVER_WAIT_MS + 1 }, false, false, true, 'card up past the cap: the shell, no gate'],
    [{ elapsedMs: NaN }, false, false, true, 'window closed while the card is up'],
    [{ member: X, status: { unlocked: true, exists: true, publicKey: X } }, false, false, true, 'its diary already reads: still the card'],
    [{ card: null }, true, true, false, 'no card: the splash as before'],
    [{ card: null, elapsedMs: RECOVER_WAIT_MS }, true, false, false, 'no card, past the cap: the gate as before'],
    [{ status: { unlocked: true, exists: true, publicKey: OTHER }, member: OTHER }, false, false, false, 'a card for another identity does not count'],
    [{ card: OTHER, elapsedMs: RECOVER_WAIT_MS }, false, false, true, 'no diary yet: the unlocked identity is the one that raised it'],
    [{ status: { ...noDiary, unlocked: false }, locked: true }, false, false, false, 'locked: Entrar'],
    [{ status: null }, true, true, false, 'status unread: no card, the splash as before'],
    [{ claim: { at: T1 } }, false, false, false, 'Termos accepted in this page load: no gate to skip'],
    [{ decision: 'accepted' }, false, false, false, 'accepted: no gate to skip'],
    [{ hosted: false }, false, false, false, 'native or serve: never this state']
  ]
  for (const [o, window, wait, card, label] of rows) {
    t.alike(recoverView({ ...base, ...o }), { window, wait, card }, label)
  }
})

test('heldView: asks once, waits, then shows', async (t) => {
  const { heldView } = await load()
  const { TERMS_HELD_WAIT_MS } = await loadTerms()
  const base = { hosted: true, member: X, claim: null, decision: 'needed', online: true, entry: undefined, nowMs: 1000 }
  t.alike(heldView(base), { ask: true, offline: false, wait: true }, 'not asked yet: ask and wait in the same render')
  for (const decision of ['updated', 'account']) t.alike(heldView({ ...base, decision }), { ask: true, offline: false, wait: true }, decision)
  const asking = { state: 'asking', at: 1000 }
  t.alike(heldView({ ...base, entry: asking, nowMs: 1000 + TERMS_HELD_WAIT_MS - 1 }), { ask: false, offline: false, wait: true }, 'young question waits')
  t.alike(heldView({ ...base, entry: asking, nowMs: 1000 + TERMS_HELD_WAIT_MS }), { ask: false, offline: false, wait: false }, 'slow question: the gate')
  t.alike(heldView({ ...base, entry: { state: 'asking', at: 'x' } }), { ask: false, offline: false, wait: false }, 'a broken entry shows the gate')
  for (const state of ['held', 'none', 'failed', 'timeout']) {
    t.alike(heldView({ ...base, entry: { state } }), { ask: false, offline: false, wait: false }, state + ' never asks again')
  }
})

test('heldView: nothing to ask', async (t) => {
  const { heldView } = await load()
  const base = { hosted: true, member: X, claim: null, decision: 'needed', online: true, entry: undefined, nowMs: 1000 }
  const none = { ask: false, offline: false, wait: false }
  t.alike(heldView({ ...base, hosted: false }), none, 'native or serve')
  t.alike(heldView({ ...base, member: null }), none, 'no member (Entrar)')
  t.alike(heldView({ ...base, claim: { at: T1 } }), none, 'the gate was just answered here')
  for (const decision of ['accepted', 'bind', 'loading']) t.alike(heldView({ ...base, decision }), none, decision)
  t.alike(heldView({ ...base, decision: 'accepted', entry: { state: 'asking', at: 1000 } }), none, 'accepted here meanwhile: no wait')
  t.alike(heldView(), none, 'no arguments')
})

test('heldView: offline settles the gate', async (t) => {
  const { heldView } = await load()
  const base = { hosted: true, member: X, claim: null, decision: 'needed', online: false, entry: undefined, nowMs: 1000 }
  t.alike(heldView(base), { ask: false, offline: true, wait: false })
  t.alike(heldView({ ...base, entry: { state: 'none' } }), { ask: false, offline: false, wait: false }, 'once settled, nothing')
  t.alike(heldView({ ...base, decision: 'accepted' }), { ask: false, offline: false, wait: false }, 'no gate, nothing to settle')
  t.alike(heldView({ ...base, online: undefined }), { ask: true, offline: false, wait: true }, 'unknown is not offline')
})

test('heldOutcome', async (t) => {
  const { heldOutcome } = await load()
  t.is(heldOutcome({ version: 7, acceptedAt: T1 }), 'held')
  t.is(heldOutcome({ version: 7, acceptedAt: null }), 'none')
  t.is(heldOutcome(null), 'none', 'an older service (404)')
  t.is(heldOutcome(undefined), 'none')
  t.is(heldOutcome({ version: 7, acceptedAt: 5 }), 'none')
})

test('Identidade: every new-account path asks the Termos before its ceremony', (t) => {
  const src = read('src', 'screens', 'Identidade.js')
  // A recovery code always ends in a new passkey and a recovery write: a
  // creation too, from the press that opens its field to its last step.
  const creations = ['const doRegister = (', 'const onCreatePress = (', 'const onPhonePress = (', 'const doComplete = (', 'const doCreate = async (',
    'const onCodeOpen = (', 'const onCodeSubmit = (', 'const onFinishRecovery = (', 'const onFinishComplete = (']
  for (const head of creations) {
    const b = body(src, head)
    const gate = b.indexOf('termsFirst()')
    t.ok(gate > 0, head + ' asks first')
    for (const call of ['ceremony(', 'turnOffBeforeSwitch(', 'setConfirmCreate(', 'doRegister(', 'onCreatePress(', 'create.run(', 'setCodeOpen(', 'codeText.trim(']) {
      const at = b.indexOf(call, b.indexOf('=>'))
      if (at !== -1) t.ok(gate < at, head + ' asks before ' + call)
    }
  }
  const phone = body(src, 'const onPhonePress = (')
  t.ok(phone.includes('if (offer.phoneCreate && termsFirst()) return'), 'a phone sign-in is not a creation')
  for (const head of ['const doUnlock = (', 'const onOtherPasskey = (']) {
    t.absent(body(src, head).includes('termsFirst()'), head + ' enters an existing account')
  }
  t.ok(src.includes('<OptionRow label={CODE_LABEL} icon=\'hash\' onPress={onCodeOpen} '), 'the code field opens only through the gate')
  t.is(src.split('setCodeOpen(true)').length, 2, 'no other press opens the code field')
  t.ok(body(src, 'const onCodeOpen = (').includes('setCodeOpen(true)'))
  const helper = body(src, 'const termsFirst = (')
  t.ok(helper.includes('termsBeforeCreate.needed !== true'), 'only an explicit need asks')
  t.ok(helper.indexOf('termsBeforeCreate.ask()') > 0)
  t.absent(src.includes('\u2014'), 'no em dash')
})

test('App: the create gate and the held check are wired', (t) => {
  const src = read('App.js')
  t.ok(src.includes('createNeedsTerms({ hosted: mode === \'hosted\''), 'the rule decides by mode')
  t.ok(src.includes('termsBeforeCreate={termsBeforeCreate}'), 'Identidade gets the gate')
  t.ok(src.includes('onAccept={acceptCreateTerms}'), 'the create gate accepts with no member')
  t.ok(src.includes('terms.accept(null)'), 'a claim, never a member')
  t.ok(src.includes("node.request('invite.sign', { action: 'summary', nonce })"))
  t.ok(src.includes('termsHeldFinish({ member: who, nonce, signature, version: LEGAL_VERSION })'))
  t.ok(src.includes('const termsOk = decision === \'accepted\' || decision === \'bind\''), 'termsOk stays the raw decision')
  t.ok(src.includes('const loadingGate = gateDecision === \'loading\''), 'the wait is the splash')
  const drop = body(src, 'const dropTermsAndSync = useCallback(')
  t.ok(drop.length > 0)
  t.ok(drop.includes("termsHeld.current.set(heldKey(m, LEGAL_VERSION), { state: 'none' })"), 'Recomeçar settles the held question as none')
  t.absent(drop.includes('termsHeld.current.delete'), 'Recomeçar never forgets the held question')
  t.ok(drop.indexOf('termsHeld.current.set(') > drop.indexOf("if (typeof m !== 'string') return"), 'only for a real member key')
  t.ok(src.includes('acceptTermsHeld(who, answer.version, answer.acceptedAt)'), 'the answer\'s own version reaches acceptHeld')
  const nullStart = src.indexOf('if (started === null) {')
  t.ok(nullStart > 0, 'an older service at the start route')
  t.ok(nullStart < src.indexOf("node.request('invite.sign', { action: 'summary', nonce })"), 'no invite.sign after a null start')
  t.ok(src.slice(nullStart, nullStart + 120).includes("settle('none')"), 'a null start settles as none')
  t.absent(src.includes('\u2014'), 'no em dash')
})

test('App: after Entrar, nothing about the member leaves before the terms pass', (t) => {
  const src = read('App.js')
  const okAt = src.indexOf("const termsOk = decision === 'accepted' || decision === 'bind'")
  t.ok(okAt > 0)
  // The public status read stays ahead of the gate (a deleted account sees
  // its notice first); the enrolment write it leaves due waits for termsOk.
  const statusEnd = src.indexOf('}, [node.hosted, member, accountTick, refreshAccount])')
  const status = src.slice(src.lastIndexOf('useEffect(() => {', statusEnd), statusEnd)
  t.ok(statusEnd > 0 && status.includes('accountStatus(member).then('), 'the status read')
  t.ok(status.includes('setDeletedState(next.deletedState)'))
  t.absent(status.includes('enrolWith('), 'no account write from the status read')
  t.ok(status.includes('if (next.enrolDue !== null) setEnrolDue(next.enrolDue)'))
  const enrolAt = src.indexOf('enrolWith({')
  t.ok(enrolAt > okAt, 'the enrolment comes after termsOk is declared')
  const enrol = src.slice(src.lastIndexOf('useEffect(() => {', enrolAt), src.indexOf('}, [termsOk, locked, enrolDue, member])', enrolAt))
  t.ok(enrol.includes('if (!termsOk || locked || enrolDue === null || enrolDue.member !== member) return'), 'gated on termsOk and the same member')
  t.ok(enrol.indexOf('setEnrolDue(null)') < enrol.indexOf('enrolling.current = true'), 'one attempt per answer, consumed first')
  t.ok(enrol.includes('if (passkey === null || enrolling.current) return'), 'never two in flight')
  const drop = src.match(/const inviteDrop = useInviteDrop\(\{([\s\S]*?)\n {2}\}\)/)[1]
  t.ok(drop.includes('pkStatus?.unlocked === true && termsOk'), 'the invite allowance monitor')
  t.ok(src.includes("const dmReady = mode === 'hosted' && ready && !locked && termsOk"), 'the DM dot')
  t.ok(src.includes("if (mode !== 'hosted' || !ready || locked || !termsOk || feiraOnScreen) return"), 'the Feira alerts load')
  t.ok(src.includes('}, [mode, ready, locked, termsOk, feiraOnScreen, feiraAlertsOrigin, nodeEpoch])'))
  t.ok(src.includes("if (mode !== 'hosted' || !ready || locked || !termsOk) return\n    const scopeKey"), 'the Feira timer')
  t.ok(src.includes('}, [mode, ready, locked, termsOk, node.visible, node.online, node.hosted, feiraAlertsOrigin, nodeEpoch])'))
  t.ok(src.includes("const feiraBadge = mode === 'hosted' && !locked && termsOk && "), 'the Feira dot')
  for (const at of [src.indexOf('const dmReady = '), src.indexOf('const inviteDrop = useInviteDrop('), src.indexOf('const feiraBadge = ')]) t.ok(at > okAt, 'after termsOk is declared')
})

test('Ajustes: both Identidade instances get the create gate', (t) => {
  const src = read('src', 'screens', 'Ajustes.js')
  t.ok(src.includes('recheckPhone, termsBeforeCreate = null }) {'), 'Ajustes takes the prop')
  const tags = src.split('<Identidade ').slice(1).map((x) => x.slice(0, x.indexOf('/>')))
  t.is(tags.length, 2, 'two instances')
  for (const tag of tags) t.ok(tag.includes('termsBeforeCreate={termsBeforeCreate}'), 'passes it on')
  const app = read('App.js')
  const ajustes = app.slice(app.indexOf('<Ajustes key='), app.indexOf('/>', app.indexOf('<Ajustes key=')))
  t.ok(ajustes.includes('termsBeforeCreate={termsBeforeCreate}'), 'App gives it to Ajustes (a defensive guard: hosted Ajustes cannot open while locked)')
})

test('Identidade: termsFirst fails closed for a hosted node without the gate', (t) => {
  const src = read('src', 'screens', 'Identidade.js')
  const helper = body(src, 'const termsFirst = (')
  const nullLine = helper.indexOf('if (termsBeforeCreate === null) return node.hosted === true && passkey !== null')
  t.ok(nullLine > 0, 'no prop on a hosted node with a passkey refuses')
  t.ok(nullLine < helper.indexOf('termsBeforeCreate.needed'), 'before the prop is read')
  t.absent(helper.slice(nullLine, helper.indexOf('\n', nullLine)).includes('ask'), 'nothing to ask without the prop')
})

test('Identidade: an accepted create gate keeps Criar offered after the remount', (t) => {
  const src = read('src', 'screens', 'Identidade.js')
  t.ok(src.includes('const createAccepted = termsBeforeCreate !== null && termsBeforeCreate.accepted === true'))
  const line = src.slice(src.indexOf('const createFirst = '), src.indexOf('\n', src.indexOf('const createFirst = ')))
  t.ok(line.includes('(knownLost || createAccepted) && !showComplete'), 'like a lost known passkey')
  t.absent(line.includes('createToo || createAccepted'), 'never beside a pending concluir')
  const app = read('App.js')
  const accept = app.slice(app.indexOf('const acceptCreateTerms = () => {'), app.indexOf('\n  }', app.indexOf('const acceptCreateTerms = () => {')))
  t.ok(accept.includes('setCreateAccepted(true)'), 'the shell remembers the acceptance')
  t.ok(app.includes('accepted: createAccepted }), [createTerms, askCreateTerms, createAccepted])'), 'and passes it')
  t.ok(app.includes('useEffect(() => { if (member !== null) setCreateAccepted(false) }, [member])'), 'until a member is known')
})

test('Termos: Voltar only on the create gate', (t) => {
  const src = read('src', 'screens', 'Termos.js')
  t.ok(src.includes('onAccept, onBack = null }) {'), 'optional prop')
  t.ok(src.includes("typeof onBack === 'function' ? <Btn label={BACK_LABEL} accessibilityLabel={BACK_A11Y} onPress={onBack} secondary block large /> : null"))
  t.ok(src.includes("const BACK_LABEL = 'Voltar'"))
  t.ok(src.includes("{typeof onBack === 'function' ? BLOCKED_CREATE_TEXT : BLOCKED_TEXT}"), 'beside Voltar, Entrar stays open: only creating needs the acceptance')
  t.ok(src.includes("const BLOCKED_CREATE_TEXT = 'Sem aceitar, não é possível criar uma conta ou uma passkey nova.'"))
  const app = read('App.js')
  t.ok(app.includes('onAccept={acceptCreateTerms} onBack={() => setCreateAsked(false)} />'), 'the create gate goes back to Entrar')
  t.ok(app.includes('<Termos gate reason={decision} version={LEGAL_VERSION} onAccept={() => terms.accept(member)} />'), 'the entry gate has no way back')
  t.absent(src.includes('\u2014'), 'no em dash')
})

test('App: the boot and recovery windows render the splash, termsOk stays raw', (t) => {
  const src = read('App.js')
  t.ok(src.includes('const modePass = modeUnknownPass({ hostedMode: mode === \'hosted\', hostedPage, installation: installationOrigin(), config: node.config, phase: node.phase, decision })'), 'by capability, never Platform.OS')
  t.ok(src.includes("const gateDecision = recoverProbe.card ? 'accepted' : (held.wait || recoverWait ? 'loading' : (modePass ? 'accepted' : decision))"), 'render only')
  t.ok(src.includes("const termsOk = decision === 'accepted' || decision === 'bind'"), 'termsOk is the raw decision')
  t.ok(src.includes("gateNext: gateNext || loadingGate || modePass || opening === 'wait',"), 'an unknown gate keeps the preview away')
  t.ok(src.includes('status: pkStatus, recovering: passkey !== null && passkey.recovering === true, elapsedMs: recoverElapsed }).wait'), 'the wait follows the recovery')
  t.ok(src.includes('setTimeout(() => setHeldTick((n) => n + 1), Math.max(0, RECOVER_WAIT_MS - recoverElapsed) + 50)'), 'a tick ends the cap')
  t.ok(src.indexOf('const modePass = ') < src.indexOf('const coveringConnect = '), 'the patience sees it')
})

test('useTerms: acceptHeld records only an answer for the hook\'s own version', (t) => {
  const src = read('src', 'useTerms.js')
  const start = src.indexOf('const acceptHeld = useCallback((member, heldVersion, acceptedAt) => {')
  t.ok(start > 0, 'acceptHeld takes the answer\'s version')
  const b = src.slice(start, src.indexOf('}, [version, commit])', start))
  const guard = b.indexOf('if (heldVersion !== version) return')
  t.ok(guard > 0, 'another version returns')
  t.ok(guard < b.indexOf('commit('), 'before anything is committed')
})
