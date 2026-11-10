'use strict'

// The hosted age gate (src/age.js). ES module loaded through import().
const test = require('brittle')

const load = () => import('../src/age.js')

test('constants', async (t) => {
  const { MIN_AGE, RETURN_PARAM, AGE_STATES } = await load()
  t.is(MIN_AGE, 16)
  t.is(RETURN_PARAM, 'idade')
  t.alike([...AGE_STATES], ['verificado', 'pendente', 'recusado', 'inconclusivo', 'expirado', 'nenhum'])
  t.ok(Object.isFrozen(AGE_STATES))
})

test('parseReturnAge: only ?idade=volta, provider params ignored', async (t) => {
  const { parseReturnAge } = await load()
  t.is(parseReturnAge('?idade=volta'), true)
  t.is(parseReturnAge('?idade=volta&verificationSessionId=abc&status=Declined'), true)
  t.is(parseReturnAge('?x=1&idade=volta'), true)
  t.is(parseReturnAge('?status=Approved'), false)
  t.is(parseReturnAge('?verificationSessionId=abc&status=Approved'), false)
  t.is(parseReturnAge('?idade=ok'), false)
  t.is(parseReturnAge('?idade=Volta'), false)
  t.is(parseReturnAge('%%%'), false)
  t.is(parseReturnAge(''), false)
  for (const bad of [undefined, null, 5, {}, []]) t.is(parseReturnAge(bad), false, String(bad))
  const evil = { toString () { throw new Error('x') } }
  t.is(parseReturnAge(evil), false)
})

test('ageGate: off only when not hosted or the policy says required false', async (t) => {
  const { ageGate, AGE_STATES } = await load()
  const states = [undefined, ...AGE_STATES, 'outro', null]
  for (const hosted of [false, undefined, 'true', 1]) {
    for (const state of states) {
      t.is(ageGate({ hosted, policy: { required: true }, state }), 'off', 'hosted ' + String(hosted))
    }
  }
  for (const state of states) t.is(ageGate({ hosted: true, policy: { required: false }, state }), 'off')
  t.is(ageGate(), 'off')
})

test('ageGate: fails closed on any other policy', async (t) => {
  const { ageGate } = await load()
  const policies = [undefined, null, {}, { required: 'false' }, { required: 0 }, { required: true }, [], 'off', false]
  for (const policy of policies) {
    const p = JSON.stringify(policy) || String(policy)
    t.is(ageGate({ hosted: true, policy, state: undefined }), 'loading', p)
    t.is(ageGate({ hosted: true, policy, state: 'verificado' }), 'ok', p)
    for (const state of ['pendente', 'recusado', 'inconclusivo', 'expirado', 'nenhum', 'outro', null, '', true]) {
      t.is(ageGate({ hosted: true, policy, state }), 'needed', p + ' ' + String(state))
    }
  }
})

test('ageGate: only the exact string verificado opens it', async (t) => {
  const { ageGate } = await load()
  for (const state of ['Verificado', ' verificado', 'verificado ', ['verificado'], { state: 'verificado' }, 'volta', 'Approved']) {
    t.not(ageGate({ hosted: true, policy: null, state }), 'ok', JSON.stringify(state))
  }
})

test('ageBlocking', async (t) => {
  const { ageBlocking } = await load()
  t.is(ageBlocking('loading'), true)
  t.is(ageBlocking('needed'), true)
  t.is(ageBlocking('ok'), false)
  t.is(ageBlocking('off'), false)
})

test('ageErrorText: a definite unavailable gets the age wording; uncertain and others fall through', async (t) => {
  const { ageErrorText, AGE_UNAVAILABLE_TEXT } = await load()
  t.is(ageErrorText({ code: 'indisponivel' }), AGE_UNAVAILABLE_TEXT)
  t.is(ageErrorText({ code: 'indisponivel', uncertain: true }), null)
  t.is(ageErrorText({ code: 'limite-idade' }), null)
  t.is(ageErrorText(null), null)
  t.absent(AGE_UNAVAILABLE_TEXT.includes(String.fromCharCode(0x2014)))
})

test('AGE_TEXTS: every state, plain words, no em dash', async (t) => {
  const { AGE_TEXTS, AGE_STATES } = await load()
  t.alike(Object.keys(AGE_TEXTS).sort(), [...AGE_STATES].sort())
  for (const s of AGE_STATES) t.is(typeof AGE_TEXTS[s], 'string', s)
  t.is(AGE_TEXTS.nenhum, '')
  t.is(AGE_TEXTS.recusado, 'A Varanda é só para quem tem 16 anos ou mais. Não foi possível liberar sua conta.')
  t.is(AGE_TEXTS.inconclusivo, 'Não deu para confirmar sua idade só pelo rosto. Tente de novo com um documento.')
  t.is(AGE_TEXTS.pendente, 'A verificação ainda está em análise. Confira de novo em instantes.')
  t.is(AGE_TEXTS.expirado, 'A verificação venceu. Comece de novo.')
  t.is(AGE_TEXTS.verificado, 'Idade confirmada.')
  const technical = /(^|[^\p{L}])(semeador|chave|certificado|nó)(?![\p{L}])/iu
  for (const text of Object.values(AGE_TEXTS)) {
    t.absent(text.includes(String.fromCharCode(0x2014)), text)
    t.absent(technical.test(text), text)
  }
})

test('ageReadAllowed: hosted, ready, unlocked, terms, member and a required policy; no sync input', async (t) => {
  const { ageReadAllowed } = await load()
  const ok = { hosted: true, ready: true, termsOk: true, locked: false, member: 'a'.repeat(64), policyKnown: true, policyRequired: true }
  t.is(ageReadAllowed(ok), true, 'no recovering or onceSync argument needed')
  t.is(ageReadAllowed({ ...ok, recovering: true, onceSync: true }), true, 'a recovery or once sync does not hold it back')
  t.is(ageReadAllowed({ ...ok, policyKnown: false }), false, 'policy unknown')
  t.is(ageReadAllowed({ ...ok, policyRequired: false }), false, 'not required')
  t.is(ageReadAllowed({ ...ok, policyRequired: undefined }), false, 'required unknown')
  t.is(ageReadAllowed({ ...ok, policyRequired: 'true' }), false, 'required not a boolean')
  t.is(ageReadAllowed({ ...ok, locked: true }), false, 'locked')
  t.is(ageReadAllowed({ ...ok, locked: undefined }), false, 'lock unknown')
  t.is(ageReadAllowed({ ...ok, ready: false }), false, 'not ready')
  t.is(ageReadAllowed({ ...ok, member: null }), false, 'no member')
  t.is(ageReadAllowed({ ...ok, termsOk: false }), false, 'terms')
  t.is(ageReadAllowed({ ...ok, hosted: false }), false, 'not hosted')
  t.is(ageReadAllowed(), false)
})

// App.js is the shell: read as text so this test never loads JSX.
const fs = require('fs')
const path = require('path')
const appSource = () => fs.readFileSync(path.join(__dirname, '../App.js'), 'utf8')
const count = (s, needle) => s.split(needle).length - 1
const between = (s, from, to) => {
  const a = s.indexOf(from)
  const b = s.indexOf(to, a + from.length)
  return a >= 0 && b > a ? s.slice(a, b) : ''
}

const ageSection = (s) => between(s, '// --- the age gate (src/age.js; a hosted node) ---', '// The gates: ')

test('App.js: the node\'s proofs feed the gate and the Idade screen', (t) => {
  const s = appSource()
  t.ok(/import \{[^}]*\bageStateShown\b[^}]*\bnodeVouches\b[^}]*\} from '\.\/src\/ageMemory\.js'/.test(s), 'imports ageStateShown and nodeVouches')
  t.ok(s.includes('ageStateShown({ answered: ageState, remembered: ageRemembered })'), 'calls ageStateShown')
  t.absent(/\bcertVouches\b/.test(s), 'the certificate is weighed only inside nodeVouches')
  t.ok(s.includes('ageGate({ hosted: ageHosted, policy: agePolicy, state: ageShown })'), 'ageGate takes ageShown')
  t.absent(s.includes('state: ageState }'), 'ageGate never takes the raw answer')
  const idade = between(s, '<Idade\n', '/>')
  t.ok(idade.includes('state={ageShown}'), 'Idade shows ageShown')
  t.ok(idade.includes('busy={ageBusy || (ageShown === undefined && !ageError && ageReadPending)}'), 'busy only while a read is pending')
  t.absent(idade.includes('state={ageState}'))
})

test('App.js: only answerAge writes the refusals and sends the age-verified proof', (t) => {
  const s = appSource()
  const answer = between(s, 'const answerAge = (', 'const ageRequest = (')
  t.ok(answer.length > 0, 'answerAge exists')
  for (const call of ['ageMemory.deny(', 'ageMemory.clearDenial(']) {
    t.is(count(answer, call), 1, call + ' inside answerAge')
    t.is(count(s, call), 1, call + ' nowhere else')
  }
  t.ok(answer.includes("if (outcome === 'deny') ageMemory.deny(who, origin)"), 'only a refusal is written')
  t.ok(answer.includes("node.request('age.proof', { verified: proof })"), 'the proof goes to the node')
  t.ok(/else if \(outcome === 'clear'\) \{[\s\S]*age\.proof/.test(answer), 'only on a verificado')
  t.ok(s.includes('const { state, proof } = await ageResult({ member, nonce, signature })'))
  t.ok(s.includes('if (!stale()) answerAge(state, who, origin, proof)'), 'the result read answers through it')
  t.ok(s.includes("if (r.state === 'verificado') return answerAge('verificado', who, origin, r.proof)"), 'the session answers through it')
  t.absent(s.includes("return setAgeState('verificado')"), 'no direct verdict from the session')
  const urls = [
    between(s, 'const AGE_RETURN = ', '\nfunction '),
    between(s, 'appUrlRef.current = (url) => {', '\n  }\n')
  ]
  for (const block of urls) {
    t.ok(block.length > 0)
    for (const call of ['deny(', 'clearDenial(', 'age.proof', 'saveAgeRecord(', 'answerAge(']) {
      t.absent(block.includes(call), call + ' never from a URL')
    }
  }
})

test('App.js: age answers are scoped to the installation', (t) => {
  const s = appSource()
  t.ok(s.includes('}, [generation, locked, ageOrigin])'), 'the reset follows the installation')
  t.ok(s.includes("const key = generation + '#' + member + '#' + ageOrigin + '#' + ageCheckTick"), 'the read key carries the installation')
  t.ok(s.includes('origin !== ageOriginRef.current'), 'stale() compares the installation')
})

test('App.js: age.proof only from answerAge (verified) and the since effect (since)', (t) => {
  const s = appSource()
  t.is(count(s, "'age.proof'"), 2, 'two senders')
  const answer = between(s, 'const answerAge = (', 'const ageRequest = (')
  t.is(count(answer, "node.request('age.proof', { verified: proof })"), 1)
  const effect = between(s, 'const ageSinceNow =', 'const ageSinceOnlineRef')
  t.ok(effect.length > 0, 'the since effect exists')
  t.is(count(effect, "node.request('age.proof', { since })"), 1)
  t.absent(/age\.proof', \{ since/.test(answer))
  t.absent(/age\.proof', \{ verified/.test(effect))
})

test('App.js: nodeVouches over node.info is the only opener, after the refusals load', (t) => {
  const s = appSource()
  const gate = between(s, 'const ageRemembered =', '\n  // ')
  t.ok(gate.includes('ageMemory.loaded &&'), 'ageMemory.loaded is in the gate')
  t.ok(gate.includes('ageMemory.open(member, ageOrigin, nodeVouches({ ageVerifiedDate: ageInfo?.ageVerifiedDate, memberCertDate: ageInfo?.memberCertDate, ageSince: ageInfo?.ageSince, ageSinceUntil: ageInfo?.ageSinceUntil }))'), 'ageSinceUntil reaches nodeVouches')
  t.is(count(s, 'nodeVouches('), 1, 'one opener')
  t.is(count(s, 'ageMemory.open('), 1)
  t.absent(/\|\|\s*nodeVouches\(/.test(gate), 'the node vouch never bypasses a denial')
  for (const gone of ['sinceOf', 'remember(', 'remembered(', 'rememberAgeSince', 'setSince', 'liveSince', 'ageSinceEntry', 'ageMemoryOutcome']) {
    t.absent(s.includes(gone), gone + ' is gone')
  }
  t.absent(/typeof ageSince === 'string'/.test(s), 'ageInfoNow no longer waits for an app-side since')
})

test('App.js: the since effect keeps the latest answer and retries', (t) => {
  const s = appSource()
  const effect = between(s, 'const ageSinceNow =', 'const ageSinceOnlineRef')
  t.ok(effect.includes('const seq = ++ageSinceSeq.current'), 'a request sequence')
  t.ok(effect.includes('seq === ageSinceSeq.current'), 'only the latest answer is applied')
  t.ok(effect.includes('if (since === undefined) return retry()'), 'a failed read is retried')
  t.ok(effect.includes('agePolicyDelay(ageSinceTries.current)'), 'with the 5 s, 15 s, 60 s backoff')
  t.ok(effect.includes('clearTimeout(timer)'))
  t.ok(effect.includes('ageSinceNow = ageHosted && ready && !locked && member !== null'), 'held until ready, unlocked and a member')
  t.absent(effect.includes('recovering') || effect.includes('onceSync'), 'not held back by a sync')
  const online = between(s, 'const ageSinceOnlineRef', '\n\n')
  t.ok(online.includes('if (was !== false || node.online !== true || !ageSinceNow) return'), 'tried again when back online')
})

test('App.js: node.sync.stopped re-reads node.info on the age step while the node has no proof', (t) => {
  const s = appSource()
  const age = ageSection(s)
  t.ok(age.includes('node.sync.stopped'), 'read in the age section')
  t.ok(age.includes('ageInfo.memberCertDate == null && ageInfo.ageVerifiedDate == null'), 'only while neither proof is there')
  t.ok(age.includes('!ageClear'), 'only on the age step')
  const effect = between(age, 'const ageStopped = node.sync.stopped', '}, [ageStopped, readInfo, recovering, onceSync])')
  t.ok(effect.includes('readInfo()'))
  t.ok(effect.includes('if (recovering || onceSync) return'), 'never reads node.info during a recovery or once sync')
  t.ok(effect.indexOf('if (recovering || onceSync) return') < effect.indexOf('ageInfoHeld.current = false'), 'and keeps the held read for when it ends')
  t.ok(age.includes('}, [ageStopped, readInfo, recovering, onceSync])'), 'a run that ended during a recovery is read when it ends')
})

test('App.js: ageReadNow is not held back by a sync or recovery', (t) => {
  const s = appSource()
  const read = between(s, 'const ageReadNow =', '\n  })\n')
  t.ok(read.includes('ageReadAllowed({'), 'built from ageReadAllowed')
  t.absent(read.includes('onceSync'))
  t.absent(read.includes('recovering'))
})

test('Idade: says the first answer is on its way', (t) => {
  const s = fs.readFileSync(path.join(__dirname, '../src/screens/Idade.js'), 'utf8')
  t.ok(s.includes("'Conferindo sua idade…'"))
  t.ok(s.includes('const checking = state === undefined && busy && !error'))
})

test('App.js: busy means a background read for the current key is still pending', (t) => {
  const s = appSource()
  t.ok(s.includes('const [ageReadDone, setAgeReadDone] = useState(null)'), 'finished key tracked')
  t.ok(s.includes("const ageReadKey = generation + '#' + member + '#' + ageOrigin + '#' + ageCheckTick"), 'same key as the read')
  t.ok(s.includes('const ageReadPending = (ageReadNow && ageReadDone !== ageReadKey) || (ageHosted && !agePolicyKnown)'))
  const read = between(s, "const key = generation + '#' + member + '#' + ageOrigin + '#' + ageCheckTick", 'const ageReadKey =')
  t.ok(/finally \{[\s\S]*setAgeReadDone\(key\)/.test(read), 'the read marks its key done when it ends')
  t.ok(s.includes('const ageReadKeyRef = useRef(null)'), 'the current key is kept in a ref')
  t.ok(s.includes('  ageReadKeyRef.current = ageReadKey\n'), 'refreshed on every render')
  t.ok(read.includes('if (key === ageReadKeyRef.current) setAgeReadDone(key)'), 'an older read finishing late never overwrites the current mark')
  t.is(count(read, 'setAgeReadDone('), 1, 'no unconditional mark')
})

test('App.js: a refusal is remembered per installation and wins over the node\'s proofs', (t) => {
  const s = appSource()
  t.ok(s.includes("if (outcome === 'deny') ageMemory.deny(who, origin)"), 'deny records the installation')
  t.ok(s.includes('ageMemory.clearDenial(who, origin)'), 'a verificado clears this installation only')
})

test('App.js: a failed node.info read on the age step is retried with a backoff', (t) => {
  const s = appSource()
  t.ok(s.includes('const ageInfoDelay = (n) => (n === 0 ? 2000 : n === 1 ? 5000 : n === 2 ? 15000 : 30000)'))
  const now = between(s, 'const ageInfoNow =', '\n  const ')
  t.ok(now.includes('!recovering') && now.includes('!onceSync'), 'never while recovering or in a once sync')
  t.ok(now.includes('info === null'), 'only while the info is missing')
  const effect = between(s, 'if (!ageInfoNow) return', '}, [ageInfoNow, generation, readInfo, ageInfoTick])')
  t.ok(effect.includes('readInfo()'))
  t.ok(effect.includes('setTimeout(() => setAgeInfoTick((n) => n + 1), ageInfoDelay(ageInfoTries.current))'), 'schedules the next try')
  t.ok(effect.includes('clearTimeout(timer)'), 'cleared on unmount and when no longer needed')
  t.ok(s.includes('useEffect(() => { ageInfoTries.current = 0 }, [generation])'), 'a new generation starts over')
  t.ok(s.includes('if (was !== false || node.online !== true || !ageInfoNow) return'), 'tried at once when back online')
})

test('Idade: no answer and nothing in flight offers start and check, not the checking text', (t) => {
  const s = fs.readFileSync(path.join(__dirname, '../src/screens/Idade.js'), 'utf8')
  t.ok(s.includes("const showCheck = state === 'pendente' || (state === undefined && (!!error || !busy))"))
  t.ok(s.includes('const showStart = state === undefined || STARTABLE.has(state)'))
  // The same conditions evaluated for state undefined, busy false, error ''.
  const showCheck = (state, busy, error) => state === 'pendente' || (state === undefined && (!!error || !busy))
  const checking = (state, busy, error) => state === undefined && busy && !error
  t.is(showCheck(undefined, false, ''), true)
  t.is(checking(undefined, false, ''), false)
  t.is(showCheck(undefined, true, ''), false, 'hidden while a read runs')
  t.is(showCheck(undefined, true, 'erro'), true)
})

test('Idade sits on the shared step frame', (t) => {
  const s = fs.readFileSync(path.join(__dirname, '../src/screens/Idade.js'), 'utf8')
  for (const piece of ["icon='shield'", 'KeyboardForm', 'StepNotice', 'block large']) t.ok(s.includes(piece), piece)
  for (const piece of ['WHO_TEXT', '<Card>', 'Didit']) t.absent(s.includes(piece), 'explanation moved to the help sheet: ' + piece)
})
