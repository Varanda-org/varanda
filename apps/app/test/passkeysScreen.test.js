// Ajustes › Passkeys e recuperação, read as text like the other screen
// checks: the screen imports react-native, so it is never loaded here.
'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const SRC = path.join(__dirname, '..', 'src')
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8')

// String literals are kept whole, so a '//' inside a text never hides code.
function withoutComments (src) {
  return src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')
}

// The body of `const name = (...) => {` up to the next line that closes it
// at the same indentation.
function body (src, head) {
  const start = src.indexOf(head)
  if (start === -1) return ''
  const lineStart = src.lastIndexOf('\n', start) + 1
  const indent = src.slice(lineStart, start).match(/^ */)[0]
  const end = src.indexOf('\n' + indent + '}\n', start)
  return src.slice(start, end === -1 ? undefined : end)
}

// Index of the first `await` keyword (not `awaiting`), or -1.
const awaitAt = (src) => src.search(/\bawait\s/)

const screen = read('screens', 'Passkeys.js')
const code = withoutComments(screen)

test('Passkeys is a shared screen: no platform switch and no browser API', (t) => {
  t.absent(code.includes('Platform'), 'decided by capability, never by Platform.OS')
  for (const api of ['window.', 'document.', 'navigator', 'localStorage', 'sessionStorage', 'console.']) {
    t.absent(code.includes(api), api)
  }
  t.ok(code.includes('node.hosted === true && unlocked'), 'only for a hosted, unlocked passkey node')
})

test('Adicionar passkey calls addPasskey in the press, before any await', (t) => {
  const add = body(code, 'const onAdd = (change = false) => {')
  t.ok(add.length > 0, 'onAdd found')
  const call = add.indexOf('passkey.addPasskey()')
  t.ok(call > 0, 'addPasskey is called')
  t.is(awaitAt(add), -1, 'nothing is awaited in the handler')
  t.absent(add.slice(0, call).includes('.then('), 'no promise step before the ceremony')
  const begin = body(code, 'const begin = () => {')
  t.is(awaitAt(begin), -1, 'the busy guard is synchronous')
  const complete = body(code, 'const onComplete = () => {')
  t.ok(complete.includes('passkey.complete()'))
  t.is(awaitAt(complete), -1, 'concluir also runs in the press')
  t.ok(code.includes("<Btn label='Adicionar passkey' onPress={() => onAdd(false)}"))
})

test('Trocar shows CHANGE_TEXT first and binds only after a successful put', (t) => {
  t.ok(code.includes("<Btn label='Trocar a passkey deste aparelho' secondary onPress={() => setConfirmChange(true)}"), 'the first press only opens the text')
  t.ok(code.includes('<Notice>{CHANGE_TEXT}</Notice>'))
  t.ok(code.includes('onPress={() => onAdd(true)}'))
  const register = body(code, 'const register = async (entry) => {')
  const put = register.indexOf('await registerEntry(')
  const bound = register.indexOf('await bind(entry)')
  t.ok(put > 0 && bound > put, 'bindPasskey follows the put')
  const fail = register.slice(put, register.indexOf('releaseUnregistered()'))
  t.ok(fail.includes('holdUnregistered(entry)'), 'a failed put keeps the passkey for registrar de novo')
  t.ok(fail.includes('return'), 'and never binds')
  t.ok(code.includes("<Btn label='registrar de novo' onPress={onRetry}"))
})

test('failures: fixed sentences, unknown outcomes offer conferir', (t) => {
  const { NOT_REGISTERED_TEXT } = { NOT_REGISTERED_TEXT: screen.match(/NOT_REGISTERED_TEXT = '([^']+)'/)[1] }
  t.ok(NOT_REGISTERED_TEXT.includes('criada no gerenciador de senhas'))
  t.ok(NOT_REGISTERED_TEXT.includes('não foi cadastrada'))
  t.ok(NOT_REGISTERED_TEXT.includes('apague essa passkey no gerenciador de senhas'))
  t.ok(code.includes('<Notice>{UNCERTAIN}</Notice>'))
  t.ok(code.includes("<Btn label='conferir' secondary onPress={onCheck}"))
  t.ok(body(code, 'const onRemove = (e) => {').includes('setFailure({ uncertain: true })'), 'an unknown remove is checked, not repeated')
  t.ok(body(code, 'const onCheck = () => {').includes('load()'), 'conferir lists the entries')
  t.absent(/err\.message|\.body|res\.text/.test(code), 'no raw server text reaches the screen')
  t.ok(read('account.js').includes("'limite-recuperacao': 'você já tem o máximo de passkeys e códigos cadastrados; remova um antes'"), 'the cap is a fixed sentence (errorText)')
})

test('the recovery code: once, with a copy, an acknowledgement and a cleanup', (t) => {
  const make = body(code, 'const onCode = () => {')
  const made = make.indexOf('passkey.makeRecoveryCode()')
  const kept = make.indexOf('setHeldCode(mine)')
  const put = make.indexOf('await registerEntry(')
  const shown = make.indexOf('setHeldCode({ ...mine, settled: true, unknown })')
  t.ok(made > 0 && kept > made && put > kept && shown > put, 'makeRecoveryCode, held before the put, then settled (shown)')
  t.ok(make.includes('setConfirmNewCode(true)'), 'an existing code asks first')
  const newCode = screen.match(/NEW_CODE_TEXT = '([^']+)'/)[1]
  t.ok(newCode.includes('substitui o anterior no serviço de conta') && newCode.includes('não o usou'), 'replacement only stops the old code where it was not used')
  t.ok(newCode.includes('Quem já entrou com o código anterior continua com acesso') && newCode.includes('a chave da conta não pode ser trocada'), 'no revocation is promised')
  t.ok(newCode.includes('criar uma conta nova'), 'a leak points to a new account')
  t.ok(code.includes('<Notice>{CODE_ONCE_TEXT}</Notice>'))
  t.ok(code.includes("CODE_ACK_LABEL = 'Anotei o código'"))
  t.ok(code.includes("<Btn label='pronto' onPress={onCodeDone} disabled={!codeAck} />"), 'closing waits for the checkbox')
  t.ok(code.includes("<Btn label='copiar o código'"))
  const done = body(code, 'const onCodeDone = () => {')
  t.ok(done.includes('if (!codeAck || myCode === null) return'), 'pronto waits for the tick')
  t.ok(done.includes('setHeldCode(null)'), 'pronto drops the code')
  t.absent(code.includes('setShownCode'), 'the shown code is derived from the held one, not component state')
  t.is(code.split('setHeldCode({ ...mine').length - 1, 1, 'the code becomes showable in one place only')
  t.absent(/holdUnregistered\([^)]*code/.test(code), 'a code is never held')
  t.absent(/Error\([^)]*shownCode|Error\([^)]*r\.code/.test(code), 'the code never goes into an error')
})

test('a code with an unknown registration stays shown with conferir', (t) => {
  const make = body(code, 'const onCode = () => {')
  const caught = make.slice(make.indexOf('} catch (err) {'), make.indexOf('setHeldCode({ ...mine, settled: true, unknown })'))
  t.ok(caught.includes('throw err'), 'a refused put still drops the code')
  t.ok(caught.indexOf('if (heldCode === mine) setHeldCode(null)') < caught.indexOf('throw err'), 'and lets go of the held one')
  t.absent(/return setFailure/.test(caught), 'an unknown outcome never returns before the code is shown')
  t.ok(caught.includes('unknown = true') && caught.includes('setFailure({ uncertain: true })'))
  t.ok(make.includes('lookupId: r.lookupId, settled: false, unknown: false }'), 'the attempt is remembered by its lookup id')
  t.ok(code.includes('const codeUnknown = shownCode !== null && myCode.unknown ? { lookupId: myCode.lookupId } : null'))
  const view = code.slice(code.indexOf('if (shownCode !== null) {'), code.indexOf('<Body>{INTRO_TEXT}</Body>'))
  t.ok(view.includes('<Notice>{CODE_ONCE_TEXT}</Notice>'))
  t.ok(view.includes("<Btn label='copiar o código'"))
  t.ok(view.includes('<Notice>{UNCERTAIN}</Notice>'), 'the unknown-outcome wording sits with the code')
  t.ok(view.includes("<Btn label='conferir' secondary onPress={onCheckCode}"))
  t.ok(view.includes("<Btn label='pronto' onPress={onCodeDone} disabled={!codeAck} />"), 'or the person confirms they noted it')
  const check = body(code, 'const onCheckCode = () => {')
  t.ok(check.includes('load()'), 'conferir lists the entries')
  const listed = check.indexOf("e.kind === 'code' && e.lookupId === unknown.lookupId")
  const dropped = check.indexOf('if (same) setHeldCode(null)')
  t.ok(listed > 0 && dropped > listed, 'the code leaves only after the list lacks this attempt')
  t.ok(check.slice(listed, dropped).includes('return'), 'a listed code stays for pronto')
  t.ok(check.includes('if (list === null) return'), 'a failed list keeps the code')
  t.ok(screen.includes("CODE_NOT_SAVED_TEXT = 'O código não foi cadastrado, então não abre a conta. Crie outro.'"))
  t.absent(body(code, 'const onCodeDone = () => {').includes('setFailure(null)'), 'pronto keeps the unknown outcome for the list conferir')
})

test('an unknown code put is answered by the list conferir after pronto', (t) => {
  t.ok(code.includes('let uncertainCode = null'), 'the doubt lives in module memory')
  const make = body(code, 'const onCode = () => {')
  const caught = make.slice(make.indexOf('} catch (err) {'), make.indexOf('setHeldCode({ ...mine, settled: true, unknown })'))
  t.ok(caught.includes('setUncertainCode({ member: who, lookupId: r.lookupId })'), 'only the lookup id is kept, never the code')
  t.absent(/setUncertainCode\([^)]*code/.test(code), 'the code text is never part of the doubt')
  t.ok(make.indexOf('if (uncertainCode !== null && uncertainCode.member === who) setUncertainCode(null)') > make.indexOf('codeRegisteredFor = who'), 'a newer registered code ends the doubt')
  const done = body(code, 'const onCodeDone = () => {')
  t.absent(done.includes('setUncertainCode'), 'pronto keeps the doubt')
  t.ok(code.includes('if (uncertainCode !== null && uncertainCode.member !== member) setUncertainCode(null)'), 'cleared when the member changes')
  t.ok(code.includes('const codeDoubt = uncertainCode !== null && uncertainCode.member === member ? uncertainCode : null'))
  t.ok(code.includes('{(failure !== null && failure.uncertain) || codeDoubt !== null'), 'the list conferir stays offered while the doubt lasts')

  const check = body(code, 'const onCheck = () => {')
  const failed = check.indexOf('if (list === null) return')
  const cleared = check.indexOf('setUncertainCode(null)')
  t.ok(failed > 0 && cleared > failed, 'a failed list keeps the doubt')
  const listed = check.indexOf("!list.some((e) => e.kind === 'code' && e.lookupId === doubt.lookupId)")
  t.ok(listed > cleared, 'the attempt is looked up by kind and lookup id')
  t.ok(check.slice(listed).indexOf('setError(CODE_NOTED_NOT_SAVED_TEXT)') > 0, 'an absent code is said to open nothing')
  t.ok(screen.includes("CODE_NOTED_NOT_SAVED_TEXT = 'O código anotado não foi cadastrado e não abre a conta. Crie outro.'"))
  t.ok(body(code, 'const onCheckCode = () => {').includes('if (uncertainCode !== null && uncertainCode.lookupId === unknown.lookupId) setUncertainCode(null)'), 'the shown-code conferir answers it too')
  t.ok(code.includes("<Btn label='Criar código de recuperação' secondary onPress={onCode} disabled={busy || entries === null || codeInFlight} />"), 'a new code stays available')
})

test('a new code survives the screen going inactive or unmounting mid put', (t) => {
  t.ok(code.includes('let heldCode = null'), 'the code lives in module memory, outside the component')
  t.ok(code.includes('const shownCode = active && myCode !== null && myCode.settled ? myCode.code : null'), 'shown when the screen is active again, once the put answered')
  t.ok(code.includes('heldCode.member === member'), 'only to the same member')
  const make = body(code, 'const onCode = () => {')
  t.absent(make.includes('if (activeRef.current && memberRef.current === who) {\n        setHeldCode'), 'settling never depends on the screen still being shown')
  const inactive = code.slice(code.indexOf('useEffect(() => {\n    if (active && member !== null) return'))
  t.absent(inactive.slice(0, 200).includes('setHeldCode'), 'an inactive screen keeps the unacknowledged code')
  t.ok(inactive.slice(0, 200).includes('setCodeAck(false)'), 'the tick is asked again')
  t.ok(make.indexOf('if (codeInFlight) return') > 0, 'no second code while a put is still in flight')
  t.ok(code.includes('disabled={busy || entries === null || codeInFlight}'))
  t.is(code.split('setHeldCode(null)').length - 1, 3, 'dropped only on a refused put, pronto, or a conferir that lacks it')
  t.absent(/shareNav\([^)]*code|navigate\([^)]*code|params[^\n]*code/i.test(code.replace('copyText(shareNav(), code)', '')), 'never a navigation param')
})

test('concluir follows the handle status, so it survives an unmount', (t) => {
  t.ok(code.includes('const awaiting = status !== null && status.pending === true'), 'derived from status().pending')
  t.absent(code.includes('setAwaiting'), 'no component-only pending state')
  t.ok(code.includes('let pendingAdd = null'), 'the change flag lives outside the component')
  const complete = body(code, 'const onComplete = () => {')
  t.ok(complete.includes('pendingAdd.member === memberRef.current'), 'only the same member reuses the flag')
  t.ok(complete.indexOf('passkey.complete()') > 0)
  t.ok(code.includes("if (!active || !pk || typeof pk.refresh !== 'function') return"), 'the status is re-read whenever the screen is shown')
  t.ok(code.includes('Promise.resolve(pk.refresh())'))
  t.ok(/\{awaiting\n\s+\? \(/.test(code), 'concluir is drawn from the derived flag')
})

test('entries show kind and date only, and removal asks first', (t) => {
  t.ok(code.includes("e.kind === 'code' ? 'Código de recuperação' : 'Passkey'"))
  t.ok(code.includes("'cadastrado em ' + dateText(e.createdAt)"))
  t.absent(/\{[^}]*e\.lookupId[^}]*\}<\//.test(code), 'the lookup id is never drawn')
  t.ok(code.includes('onPress={() => setConfirmRemove(e.lookupId)}'))
  t.ok(code.includes('onPress={() => onRemove(e)}'))
})

test('Ajustes: the row, the title and the embedded screen', (t) => {
  const ajustes = withoutComments(read('screens', 'Ajustes.js'))
  t.ok(ajustes.includes("passkeys: 'Passkeys e recuperação'"))
  t.ok(ajustes.includes("{account && unlocked ? <Item icon='shield' label='Passkeys e recuperação' onPress={() => onNavigate('passkeys')} /> : null}"))
  t.ok(ajustes.includes("<Passkeys active={ready && screen === 'passkeys'} embedded />"))
  const signOut = ajustes.match(/SIGN_OUT_TEXT = '([^']+)'/)[1]
  const reset = ajustes.match(/RESET_TEXT = '([^']+)'/)[1]
  for (const text of [signOut, reset]) {
    t.ok(text.includes('qualquer passkey cadastrada'), text)
    t.ok(text.includes('código de recuperação'), text)
  }
})

test('Identidade: recovery sign-in paths', (t) => {
  const src = read('screens', 'Identidade.js')
  const exists = src.match(/const EXISTS_TEXT = (.+)\n/)[1]
  t.absent(exists.includes('outra passkey é outra conta'))
  t.ok(exists.includes('Uma passkey criada aqui abre outra conta'))
  t.ok(exists.includes('Ajustes › Passkeys e recuperação'))
  t.ok(src.includes("ceremony(() => passkey.unlockWithCode(code), false, false, 'code')"), 'the code goes through ceremony()')
  t.ok(src.includes("const onFinishRecovery = () => ceremony(() => passkey.finishRecovery(), true, false, 'finish')"), 'the new passkey is created in the press')
  t.ok(src.includes("<Btn label='Criar passkey nova' onPress={onFinishRecovery}"))
  t.ok(src.includes("const onFinishComplete = () => ceremony(() => passkey.complete(), true, true, 'finish')"), 'the recovery concluir keeps the finish mode, in the press')
  t.ok(src.includes("autoCapitalize='characters'"))
  t.ok(src.includes("const CODE_LABEL = 'Entrar com código de recuperação'"))
  t.ok(src.includes('knownLost || missedOnce || pkStatus.passkeyKnown === true ? <Btn label={OTHER_PASSKEY_LABEL}'), 'another passkey whenever one is known')
  const after = src.slice(src.indexOf('const afterUnlock = async () => {'), src.indexOf('const registerFinished'))
  t.ok(after.indexOf('registerFinished(finished)') < after.indexOf('await passkey.recover()'), 'registered before the once sync')
  const reg = src.slice(src.indexOf('const registerFinished'), src.indexOf('// The handle\'s unlock/complete'))
  t.ok(reg.includes('holdUnregistered(entry)'), 'a failed registration is held for Ajustes')
  t.ok(src.includes('REGISTER_FAILED_TEXT') && src.includes('registrar de novo'))
})

test('node: argument ops and the recovery fetch', (t) => {
  const node = read('node.js')
  t.ok(node.includes("const ARG_OPS = new Set(['unlock', 'unlockWrapped', 'unlockWithCode', 'bindPasskey', 'addPasskey', 'finishRecovery'])"))
  t.ok(node.includes('result.wrapped === true || result.needsPasskey === true'), 'a wrapped or code result bumps nothing')
  const resolve = node.slice(node.indexOf('const resolveWrapped = useCallback'), node.indexOf('const pkUnlock ='))
  t.ok(resolve.includes('await recoveryFetch(r.lookupId'))
  t.ok(resolve.includes('throw recoveryError(SERVICE_DOWN_TEXT'))
  t.absent(resolve.includes('unlockDirect'), 'a recovery lookup never installs a passkey directly')
  t.ok(resolve.includes('throw recoveryError(NOT_FOUND_TEXT'))
  t.ok(resolve.includes("passkeyOp('unlockWrapped', { blob: entry.blob, member: entry.member })"))
  t.is(resolve.split('await cancel()').length - 1, 2, 'cancelRecovery on a 404 and on a failed fetch')
})

test('node: an added passkey at concluir bumps nothing', (t) => {
  const node = withoutComments(read('node.js'))
  const op = node.slice(node.indexOf('const passkeyOp = useCallback'), node.indexOf('const resolveWrapped = useCallback'))
  t.ok(op.includes("kind: name === 'addPasskey' ? 'add' : name === 'finishRecovery' ? 'recover' : 'unlock'"), 'the op that left the pending creation is remembered')
  t.ok(op.includes('pendingKindRef.current.conn === conn'), 'per connection')
  t.ok(op.includes("const added = name === 'complete' && pendingKind === 'add' && addedOnly(result)"))
  t.ok(op.includes('!installedNothing(result) && !added'), 'only an install bumps the generation and epoch')
  const added = node.slice(node.indexOf('function addedOnly'), node.indexOf('function recoveryError'))
  t.ok(added.includes("typeof result.lookupId === 'string'") && added.includes('result.publicKey === undefined') && added.includes('result.created === undefined'))
})

test('node: confirm is a pure check, never an identity op', (t) => {
  const node = withoutComments(read('node.js'))
  t.absent(node.match(/const IDENTITY_OPS = new Set\(\[([^\]]*)\]\)/)[1].includes("'confirm'"), 'not in IDENTITY_OPS')
  t.absent(node.match(/const ARG_OPS = new Set\(\[([^\]]*)\]\)/)[1].includes("'confirm'"))
  const fn = node.slice(node.indexOf('const pkConfirm = useCallback'), node.indexOf('const pkRefresh ='))
  t.ok(fn.includes('return Promise.resolve(conn.identity.confirm())'), 'calls the handle')
  t.is(awaitAt(fn), -1, 'nothing awaited before the ceremony')
  for (const touch of ['passkeyOp', 'readPasskey', 'bumpEpoch', 'bumpGeneration', 'setPkStatus', 'setPkError', 'setPhase', 'pendingKindRef']) {
    t.absent(fn.includes(touch), 'never ' + touch)
  }
  t.ok(fn.includes("typeof conn.identity.confirm !== 'function'") && fn.includes("recoveryError(MISSING_OP_TEXT, 'UNSUPPORTED')"), 'an older node script rejects clearly')
  t.ok(node.includes('confirm: pkConfirm,') && node.includes('pkCancelRecovery, pkConfirm,'), 'on node.passkey, memo dependency included')
})

test('node: a superseded recovery fetch neither cancels nor opens', (t) => {
  const node = withoutComments(read('node.js'))
  const resolve = node.slice(node.indexOf('const resolveWrapped = useCallback'), node.indexOf('const pkUnlock ='))
  const attempt = resolve.indexOf('const attempt = ++wrappedAttemptRef.current')
  const fetch = resolve.indexOf('await recoveryFetch(')
  t.ok(attempt > 0 && fetch > attempt, 'the attempt is taken before the fetch')
  const caught = resolve.slice(resolve.indexOf('} catch {'), resolve.indexOf('throw recoveryError(SERVICE_DOWN_TEXT'))
  t.ok(caught.indexOf('if (wrappedAttemptRef.current !== attempt) throw superseded()') < caught.indexOf('await cancel()'), 'a stale failure does not cancel')
  const after = resolve.slice(resolve.indexOf("throw recoveryError(SERVICE_DOWN_TEXT, 'RECOVERY_SERVICE')"))
  const stale = after.indexOf('if (wrappedAttemptRef.current !== attempt) throw superseded()')
  t.ok(stale > 0 && stale < after.indexOf("passkeyOp('unlockWrapped'"), 'a stale success opens nothing')
})

test('Passkeys: a failed bind, a registered code and a created passkey survive', (t) => {
  t.ok(code.includes('let pendingBind = null'), 'the pending bind lives in module memory')
  t.absent(code.includes('setBindPending'), 'no component-only bind state')
  t.ok(code.includes('const bindPending = pendingBind !== null && pendingBind.member === member ? pendingBind : null'))
  const bind = body(code, 'const bind = async (entry) => {')
  t.ok(bind.includes('setPendingBind({ member: entry.member, credentialId: entry.credentialId, userId: entry.userId })'))
  t.ok(bind.includes('setPendingBind(null)'), 'cleared on success')
  t.ok(code.includes('if (pendingBind !== null && pendingBind.member !== member) setPendingBind(null)'), 'cleared when the member changes')

  t.ok(code.includes("const hasCode = (entries !== null && entries.some((e) => e.kind === 'code')) || codeRegisteredFor === member"))
  const make = body(code, 'const onCode = () => {')
  t.ok(make.indexOf('if (!unknown) codeRegisteredFor = who') < make.indexOf('await load()'), 'set before the list refresh')
  const load = body(code, 'const load = useCallback(async () => {')
  t.ok(load.includes("if (codeRegisteredFor === who && !list.some((e) => e.kind === 'code')) codeRegisteredFor = null"), 'only a successful list clears it')

  const left = screen.match(/CREATED_LEFT_TEXT = '([^']+)'/)[1]
  t.ok(left.includes('criada no gerenciador de senhas') && left.includes('apague essa passkey no gerenciador de senhas'))
  const create = body(code, 'const afterCreate = (pending, change) => {')
  t.ok(create.includes("typeof err.credentialId === 'string'") && create.includes('setNote(CREATED_LEFT_TEXT)'), 'a stored but unregistered passkey gets the advice')
})

test('new texts carry no em dash', (t) => {
  for (const file of [['screens', 'Passkeys.js'], ['screens', 'Identidade.js'], ['screens', 'Ajustes.js'], ['node.js'], ['help.js']]) {
    t.absent(read(...file).includes(String.fromCharCode(0x2014)), file.join('/'))
  }
})

test('removal confirmations do not promise revocation', (t) => {
  for (const k of ['REMOVE_PASSKEY_TEXT', 'REMOVE_CODE_TEXT']) {
    const text = screen.match(new RegExp(k + " = '([^']+)'"))[1]
    t.ok(text.includes('Daqui em diante') && text.includes('não serve mais para entrar na conta'), k + ' stops future entries')
    t.ok(text.includes('continua com acesso') && text.includes('a chave da conta não pode ser trocada'), k + ' says past entries keep access')
    t.ok(text.includes('criar uma conta nova'), k + ' points a leak to a new account')
    t.absent(text.includes('\u2014'), k + ' has no em dash')
  }
  t.ok(screen.match(/REMOVE_PASSKEY_TEXT = '([^']+)'/)[1].includes('um aparelho ainda aberto com ela'))
  t.ok(code.includes("<Soft>{e.kind === 'code' ? REMOVE_CODE_TEXT : REMOVE_PASSKEY_TEXT}</Soft>"))
})
