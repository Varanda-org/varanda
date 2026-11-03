'use strict'

// The payments screen (src/screens/Carteira.js) runs on the hosted node, the
// site and the installed app alike: no browser-only globals in the screen or
// in account.js, and the platform pieces come from the .web/.native pairs.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')

// Tests never reach a public network: a call that skips the injected fake
// fails here instead of going out.
globalThis.fetch = async () => { throw new Error('network disabled in tests') }

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', 'src', rel), 'utf8')
const UP = 'https://uploads.hodle.com.br/u/front?sig=1'

test('Carteira.js uses no browser-only global', async (t) => {
  const src = read('screens/Carteira.js')
  for (const s of ['document.', 'window.location', 'crypto.subtle', 'globalThis.open', 'globalThis.btoa',
    'globalThis.navigator', 'globalThis.document']) {
    t.absent(src.includes(s), s)
  }
})

test('livenessCapture.native.js uses no browser-only global and never logs', async (t) => {
  const src = read('livenessCapture.native.js')
  for (const s of ['document.', 'window.', 'navigator', 'crypto.subtle', 'globalThis.open', 'globalThis.btoa',
    'globalThis.document', 'isSecureContext', 'localStorage', 'sessionStorage', 'console.']) {
    t.absent(src.includes(s), s)
  }
})

test('account.js hashes without crypto.subtle', async (t) => {
  t.absent(read('account.js').includes('crypto.subtle'))
})

test('Carteira.js takes the platform pieces from their modules', async (t) => {
  const src = read('screens/Carteira.js')
  const imports = [
    [/import \{[^}]*\bpickPhoto\b[^}]*\} from '\.\.\/pickPhoto'/, 'pickPhoto'],
    [/import \{[^}]*\bopenExternal\b[^}]*\} from '\.\.\/openExternal'/, 'openExternal'],
    [/import \{[^}]*\blinkProps\b[^}]*\} from '\.\.\/openExternal'/, 'linkProps'],
    [/import \{[^}]*\bselectContents\b[^}]*\} from '\.\.\/selectText'/, 'selectText'],
    [/import \{[^}]*\buploadDeps\b[^}]*\} from '\.\.\/uploadFetch'/, 'uploadDeps'],
    [/import \{[^}]*\bsha256Hex\b[^}]*\} from '\.\.\/sha256'/, 'sha256Hex'],
    [/import \{[^}]*\bshareNav\b[^}]*\} from '\.\.\/shareNav'/, 'shareNav'],
    [/import \{[^}]*\bbase64url\b[^}]*\} from '\.\.\/appLinkSecret'/, 'base64url'],
    [/import \{[^}]*\bisAvailable\b[^}]*\} from '\.\.\/livenessCapture'/, 'isAvailable'],
    [/import \{[^}]*\bLivenessCapture\b[^}]*\} from '\.\.\/livenessCapture'/, 'LivenessCapture']
  ]
  for (const [re, name] of imports) t.ok(re.test(src), name)
  const uploads = src.match(/uploadDocument\(/g) || []
  const withDeps = src.match(/uploadDocument\([^)]*, uploadDeps\(\)\)/g) || []
  t.ok(uploads.length >= 2)
  t.is(withDeps.length, uploads.length, 'every upload passes uploadDeps()')
})

// The screen only ever holds { sessionId, region, identityPoolId }: the
// validate token stays in the account service and the AWS credentials stay in
// the capture module, which is also where the platform is chosen.
test('Carteira.js never holds the liveness secrets nor picks the platform', async (t) => {
  const src = read('screens/Carteira.js')
  for (const s of ['validateLivenessToken', 'accessKeyId', 'secretAccessKey', 'sessionToken', '@aws-amplify',
    'Platform.OS', 'fetch(']) {
    t.absent(src.includes(s), s)
  }
  t.ok(/<LivenessCapture\b[^>]*\bkey=\{capture\.sessionId\}/.test(src), 'remounts on a new session')
})

// A hosted-only answer keeps today's flow, and an unknown validate outcome
// never starts a retry on its own.
test('Carteira.js keeps the hosted page and never retries after an unknown outcome', async (t) => {
  const src = read('screens/Carteira.js')
  t.ok(src.includes("label='Abrir a página da selfie' onPress={openLiveness}"), 'hosted button')
  t.ok(/if \(capture && isAvailable\(\)\)/.test(src), 'capture only when available')
  t.is((src.match(/'kyc-liveness-validate'/g) || []).length, 1, 'one validate call site')
  t.is((src.match(/'kyc-liveness-retry'/g) || []).length, 1, 'one retry call site')
  const done = src.slice(src.indexOf('const captureDone'), src.indexOf('const captureError'))
  t.ok(done.includes("'kyc-liveness-validate'"), 'validate lives in captureDone')
  t.absent(done.includes('kyc-liveness-retry'), 'validate never retries')
  t.absent(done.includes('retrySelfie'), 'validate never calls the retry')
  const retry = src.slice(src.indexOf('const retrySelfie'), src.indexOf('const openLiveness'))
  t.ok(retry.includes("'kyc-liveness-retry'"), 'retry only from its own tap')
})

const slice = (src, from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)))

// A completion that arrives while another action holds the screen is kept for
// the person's own tap, and 'Já terminei' cannot start such an action mid-capture.
test('Carteira.js keeps a busy completion for a confirm tap', async (t) => {
  const src = read('screens/Carteira.js')
  t.ok(/label='Já terminei, conferir'[^\n]*disabled=\{off \|\| selfieStage === 'capturing' \|\| selfieStage === 'validating'\}/.test(src),
    'Já terminei off during capture and validation')
  const done = slice(src, 'const captureDone', 'const captureError')
  const busyAt = done.indexOf('if (busyRef.current)')
  t.ok(busyAt > 0, 'busy check')
  t.ok(busyAt < done.indexOf('dropCapture()'), 'checked before the capture is dropped')
  t.ok(/if \(busyRef\.current\) \{[^}]*pendingRef\.current = c[^}]*setSelfieStage\('pending'\)[^}]*return/.test(done), 'kept as pending')
  t.ok(/captureRef\.current !== c && !\(tapped && pendingRef\.current === c\)/.test(done), 'pending only answers a tap')
  t.ok(src.includes("label='Confirmar a selfie' onPress={confirmSelfie}"), 'confirm button')
  const confirm = slice(src, 'const confirmSelfie', 'const captureError')
  t.ok(confirm.includes('captureDone(pendingRef.current, true)'), 'confirm goes through captureDone')
  t.absent(/setTimeout|setInterval|useEffect/.test(confirm), 'never sent on its own')
})

// The retry stage waits for the answer; an already completed selfie is polled
// like a validated one.
test('Carteira.js keeps the retry until the service answers', async (t) => {
  const src = read('screens/Carteira.js')
  const retry = slice(src, 'const retrySelfie', 'const openLiveness')
  const call = retry.indexOf("'kyc-liveness-retry'")
  const before = retry.slice(0, call)
  t.absent(before.includes('retryRef.current = null'), 'retry kept before the call')
  t.absent(before.includes('setSelfieStage('), 'stage kept before the call')
  t.absent(before.includes('dropCapture()'), 'capture kept before the call')
  t.ok(/if \(err\?\.uncertain === true\) dropCapture\(\)/.test(retry), 'unknown outcome drops the retry')
  t.ok(/err\?\.code === 'selfie-ausente'\) selfieGone\(\)/.test(retry), 'dead token starts over')
  t.ok(/out\.alreadyCompleted === true\) \{[^}]*await awaitSelfie\(gen, out\.ready\)/.test(retry), 'already completed polls')
  const done = slice(src, 'const captureDone', 'const captureError')
  t.ok(done.includes('await awaitSelfie(gen, out.ready)'), 'validate polls the same way')
  const poll = slice(src, 'const awaitSelfie', 'const captureDone')
  t.ok(poll.includes('ready ? 1 : SELFIE_POLLS'), 'at most SELFIE_POLLS reads')
  t.ok(poll.includes('await wait(SELFIE_POLL_MS)'), 'spaced by SELFIE_POLL_MS')
  t.ok(poll.includes('accountRef.current?.selfieReady === true) break'), 'stops once ready')
})

// The detector's own 'Tentar de novo' asks for the camera again, so a denial
// keeps it mounted.
test('Carteira.js keeps the detector after a camera denial', async (t) => {
  const src = read('screens/Carteira.js')
  const err = slice(src, 'const captureError', 'const captureCancel')
  t.ok(/if \(code === 'CAMERA_DENIED'\) \{\s*setCameraDenied\(true\)\s*return\s*\}/.test(err), 'denial returns before the drop')
  t.ok(err.indexOf("'CAMERA_DENIED'") < err.lastIndexOf('dropCapture()'), 'other codes still drop')
  t.ok(/\{cameraDenied \? <Notice>\{TEXTS\.LIVENESS_CAMERA_DENIED\}<\/Notice> : null\}\s*<LivenessCapture\b/.test(src), 'notice above the detector')
})

// A dead or expired token also kills the hosted link: the person starts a new
// selfie document instead.
test('Carteira.js starts over after selfie-ausente', async (t) => {
  const src = read('screens/Carteira.js')
  const gone = slice(src, 'const selfieGone', 'const awaitSelfie')
  t.ok(gone.includes('dropCapture()'), 'capture cleared')
  t.ok(gone.includes('setLivenessUrl(null)'), 'hosted link cleared')
  const done = slice(src, 'const captureDone', 'const captureError')
  t.ok(/err\?\.code === 'selfie-ausente'\) \{\s*selfieGone\(\)/.test(done), 'validate starts over')
  t.ok(src.includes("livenessUrl === null\n                      ? <Btn label='Selfie com prova de vida' onPress={startSelfie}"), 'new selfie offered once the link is gone')
})

test('Carteira.js tells a failed photo pick apart from a cancel', async (t) => {
  const src = read('screens/Carteira.js')
  t.ok(src.includes("'Não deu para usar essa foto. Escolha outra, de até 10 MB.'"), 'message text')
  const m = src.match(/const (\w+) = 'Não deu para usar essa foto\./)
  t.ok(m, 'message constant')
  const uses = src.match(new RegExp('=== false[^\\n]*setError\\(' + (m && m[1]) + '\\)', 'g')) || []
  t.is(uses.length, 2, 'front and back show it on a false pick')
})

// Enviar and Cripto exist only when the service lists their actions (or, on
// an older service, its mode is completo): pix shows neither.
test('Carteira.js gates Enviar and Cripto on the policy actions', async (t) => {
  const src = read('screens/Carteira.js')
  t.ok(src.includes("const canTransfer = hasAction(policy, 'transfer')"), 'transfer action')
  t.ok(src.includes("const canCrypto = hasAction(policy, 'send-crypto')"), 'send-crypto action')
  t.ok(/\{canTransfer \|\| canSendAddress \? <Btn label='Enviar' onPress=\{\(\) => go\('enviar'\)\}/.test(src), 'Enviar gated')
  t.ok(/\{canCrypto \? <Btn label='Cripto'[^\n]*go\('cripto'\)/.test(src), 'Cripto gated')
  t.is((src.match(/go\('enviar'\)/g) || []).length, 1, 'one way into Enviar')
  t.is((src.match(/go\('cripto'\)/g) || []).length, 1, 'one way into Cripto')
  const { hasAction, walletPolicy } = await import('../src/account.js')
  t.absent(hasAction({ actions: ['payout'] }, 'transfer'), 'pix has no transfer')
  t.ok(hasAction({ actions: ['transfer', 'send-crypto'] }, 'send-crypto'))
  t.ok(typeof walletPolicy === 'function')
})

// An unexpected network label has no warning text: no address send then.
test('Carteira.js offers an address send only with the network warning', async (t) => {
  const src = read('screens/Carteira.js')
  t.ok(src.includes('const networkWarning = CRYPTO_TEXTS.onlyBrla(policy.network)'), 'warning from the policy network')
  t.ok(src.includes('const canSendAddress = canCrypto && networkWarning !== null'), 'null warning hides the path')
  const conferir = slice(src, 'const conferirSend', 'const resetSend')
  t.ok(conferir.includes("target === 'address' && (!canCrypto || networkWarning === null)"), 'refused before preview')
  t.ok(conferir.indexOf('networkWarning === null') < conferir.indexOf("'preview'"), 'before any call')
  t.ok(conferir.includes("signed('preview', { kind, cents }, walletPreview)"), 'preview by kind')
  t.ok(src.includes('feeLinesFor(sendConfirm.preview, sendConfirm.kind)'), 'confirm lines by kind')
  t.ok(src.includes('{!isAddress || sendChecked\n            ? <PinField'), 'PIN only after the checkbox')
  t.ok(src.includes('<Check label={CRYPTO_TEXTS.CHECKBOX}'), 'checkbox text')
  t.ok(src.includes('disabled={off || sendLocked || (isAddress && !sendChecked)}'), 'send off until checked')
  const { CRYPTO_TEXTS } = await import('../src/wallet.js')
  t.is(CRYPTO_TEXTS.CHECKBOX, 'Conferi o endereço e a rede')
  t.is(CRYPTO_TEXTS.onlyBrla('Polygon!'), null)
})

test('Carteira.js never looks a name up nor offers a conversion', async (t) => {
  const src = read('screens/Carteira.js')
  for (const s of ['lookupUsername', 'Platform.OS', 'Converter', 'converter', "'swap'", 'walletSwap', 'Clipboard']) {
    t.absent(src.includes(s), s)
  }
})

// The PIN is copied into the one request and leaves the state before the
// call; 'Tentar de novo' sends the same op under the same opId.
test('Carteira.js resends an unknown send under the same opId', async (t) => {
  const src = read('screens/Carteira.js')
  const pay = slice(src, 'const sendPay', 'const checkSend')
  t.ok(/const chosen = sendPin\s*setSendPin\(''\)/.test(pay), 'PIN cleared first')
  t.ok(pay.includes('send({ ...a, pin: chosen })'), 'PIN only in the request')
  const retry = pay.slice(pay.indexOf('if (retry) {'), pay.indexOf('} else {'))
  t.ok(retry.includes('op = { ...lastSendRef.current.op }'), 'same op')
  t.absent(retry.includes('mintOpId'), 'no new opId on retry')
  t.ok(pay.includes('lastSendRef.current = { kind, op: { ...op } }'), 'op kept for the retry')
  t.ok(src.includes("<Btn label='Tentar de novo' onPress={() => sendPay(true)}"), 'retry button')
  const refused = slice(src, 'const sendRefused', 'const sendPay')
  t.ok(refused.includes('sendOpRef.current = null'), 'refusal drops the opId')
  t.ok(src.includes("err && err.code === 'destino-invalido'\n    ? SEND_TEXTS.badTarget"), 'destination refusal copy')
  t.ok(src.includes("badTarget: 'Não é possível enviar para este destino.'"), 'says only that it is not possible')
  const check = slice(src, 'const checkSend', 'const sendResultId')
  t.ok(check.includes("signed('op-status', { externalId: id }, walletOpStatus)"), 'incerto settles through op-status')
  t.absent(check.includes('walletStatement'), 'never by a statement read alone')
  t.ok(src.includes("<Btn label='Conferir o extrato' onPress={checkSend}"), 'incerto check button')
})

// While a send may still settle the service refuses any new debit, so the
// Enviar flow has no Desistir: a failed check keeps the lock and the opId.
test('Carteira.js has no Desistir in the Enviar flow', async (t) => {
  const src = read('screens/Carteira.js')
  t.absent(src.includes('giveUpSend'), 'no giveUpSend')
  t.absent(src.includes('sendLastStatus'), 'no answered-status state')
  const incerto = slice(src, "} else if (sendPhase === 'incerto') {", "} else if (sendPhase === 'result'")
  t.absent(incerto.includes('Desistir'), 'no Desistir on the incerto card')
  t.ok(incerto.includes("<Btn label='Conferir o extrato' onPress={checkSend}"), 'check stays')
  t.ok(incerto.includes("<Btn label='Tentar de novo' onPress={() => sendPay(true)}"), 'retry stays')
  const check = slice(src, 'const checkSend', 'const sendResultId')
  const failed = check.slice(check.indexOf('} catch (err) {'), check.indexOf('settleSend(row)'))
  t.absent(failed.includes('setSendLock('), 'a failed check keeps the lock')
  t.absent(failed.includes('sendOpRef.current = null'), 'a failed check keeps the opId')
  t.ok(failed.includes('throw err'), 'the error is shown')
})

// Any path that settles the current send moves an incerto card to the result,
// and a late check records the row before its generation check.
test('Carteira.js follows a settled send to the result card', async (t) => {
  const src = read('screens/Carteira.js')
  const settle = slice(src, 'const settleSend = useCallback', 'const clearSecrets')
  t.ok(settle.includes('l.externalId === row.externalId && !OPEN_STATUSES.includes(row.status)'), 'only the current send, settled')
  t.ok(settle.indexOf('setSendLock(null)') < settle.indexOf("if (sendPhaseRef.current !== 'incerto') return"), 'lock first')
  t.ok(settle.includes('setSendRetryReady(false)'), 'retry cleared')
  t.ok(settle.includes('status: row.status, fee: row.fee') && settle.includes('txHash: row.txHash || null'), 'row shown')
  t.ok(settle.includes("setSendPhase('result')"), 'result card')
  const check = slice(src, 'const checkSend', 'const sendResultId')
  t.ok(check.indexOf('settleSend(row)') < check.indexOf('if (gen !== genRef.current) return'), 'late check still settles')
  t.ok(slice(src, 'const checkItem', 'const resultId').includes('settleSend(row)'), 'statement Conferir settles')
  t.ok(slice(src, 'const sendOpen', 'const onSendExpired').includes('settleSend(row)'), 'poll settles')
})

// The countdown never acts on a send in flight or already sent, and a send
// answer leaves no stale error behind.
test('Carteira.js guards the Enviar countdown and clears the error on a send answer', async (t) => {
  const src = read('screens/Carteira.js')
  const expired = slice(src, 'const onSendExpired', 'const copyAddress')
  t.ok(expired.includes("if (sendLockRef.current !== null || sendPhaseRef.current !== 'confirm') return"), 'guarded')
  t.ok(expired.indexOf('return') < expired.indexOf('dropConfirm()'), 'before dropping anything')
  const pay = slice(src, 'const sendPay', 'const checkSend')
  const ok = pay.slice(pay.indexOf('} catch (err) {'))
  t.ok(/ {6}return\n {4}\}\n {4}setError\(''\)\n {4}setSendConfirm\(null\)/.test(ok), 'success clears the error first')
  t.ok(ok.indexOf("setError('')") < ok.indexOf('settleSend(out)'), 'before the answer is shown')
})

test('Carteira.js keeps the opId when a retry meets operacao-pendente', async (t) => {
  const src = read('screens/Carteira.js')
  const pay = slice(src, 'const sendPay', 'const checkSend')
  const caught = pay.slice(pay.indexOf('} catch (err) {'), pay.indexOf('sendRefused(err, retry)'))
  t.ok(caught.includes("(retry && err && err.code === 'operacao-pendente')"), 'pending on retry is unknown')
  const unknown = caught.slice(caught.indexOf("'operacao-pendente'"), caught.indexOf('} else if (retry) {'))
  t.ok(unknown.includes("setSendPhase('incerto')"), 'stays incerto')
  t.ok(unknown.includes('setSendLock({ ...lock, inFlight: false })'), 'keeps the lock')
  t.absent(unknown.includes('sendOpRef.current = null'), 'keeps the opId')
  t.absent(unknown.includes('lastSendRef.current = null'), 'keeps the op')
  const retried = slice(caught, '} else if (retry && !RETRY_NOTHING_SENT', '} else {\n')
  t.ok(retried.includes('setSendLock({ ...lock, inFlight: false })'), 'an ambiguous refused retry keeps the lock')
  t.absent(retried.includes('sendOpRef.current = null'), 'an ambiguous refused retry keeps the opId')
  t.absent(retried.includes('setSendLock(null)'), 'an ambiguous refused retry never releases the lock')
  // Only refusals that prove the opId has no row release it, so the screen
  // does not stick after a retry the service refused on its merits.
  const proven = src.slice(src.indexOf('const RETRY_NOTHING_SENT'), src.indexOf('\n', src.indexOf('const RETRY_NOTHING_SENT')))
  for (const code of ['indisponivel', 'pin-invalido', 'termos-pendentes', 'operacao-pendente']) t.absent(proven.includes("'" + code + "'"), code)
  t.ok(proven.includes("'destino-invalido'") && proven.includes("'saldo-insuficiente'"))
})

test('Carteira.js routes enviado and incerto answers to the incerto phase', async (t) => {
  const src = read('screens/Carteira.js')
  t.ok(src.includes("const OPEN_STATUSES = Object.freeze(['enviado', 'incerto'])"), 'open statuses')
  const pay = slice(src, 'const sendPay', 'const checkSend')
  const ok = pay.slice(pay.lastIndexOf('settleSend(out)'))
  t.ok(/if \(OPEN_STATUSES\.includes\(out\.status\)\) \{\s*setSendPhase\('incerto'\)\s*return/.test(ok), 'send answer')
  t.ok(ok.indexOf("setSendPhase('incerto')") < ok.indexOf("setSendPhase('result')"), 'before the result card')
  const check = slice(src, 'const checkSend', 'const sendResultId')
  t.ok(/if \(OPEN_STATUSES\.includes\(row\.status\)\) \{\s*setSendPhase\('incerto'\)/.test(check), 'op-status answer')
  const poll = slice(src, 'const sendOpen', 'const onSendExpired')
  t.ok(/if \(OPEN_STATUSES\.includes\(row\.status\)\) \{[^}]*setSendPhase\('incerto'\)/.test(poll), 'polled answer')
  t.ok(src.includes('!OPEN_STATUSES.includes(row.status))) return\n    setSendLock(null)'), 'lock released only when settled')
})

test('Carteira.js shows a USDC partner fee in USDC', async (t) => {
  const src = read('screens/Carteira.js')
  t.ok(src.includes("{item.asset === 'USDC' && item.feeMicros > 0\n                ? <Soft>Taxa do parceiro: {usdcText(item.feeMicros)}</Soft>"), 'feeMicros line')
  t.ok(src.includes("const formatted = formatUsdc(micros)\n  return formatted === null ? null : formatted + ' USDC'"), 'usdcText uses formatUsdc')
  t.absent(/formatBrl\([^)]*feeMicros/.test(src), 'never formatBrl')
})

test('Carteira.js refuses a mixed-case address whose EIP-55 checksum fails, before anything is signed', async (t) => {
  const src = read('screens/Carteira.js')
  t.ok(/import \{ hasValidChecksum \} from '\.\.\/evmAddress'/.test(src), 'checksum helper')
  const conferir = slice(src, 'const conferirSend', 'if (sendOpRef.current === null)')
  t.ok(conferir.includes("if (kind === 'crypto' && !hasValidChecksum(raw)) return setError(SEND_TEXTS.badChecksum)"), 'checked on the address path')
  t.ok(conferir.indexOf('hasValidChecksum(raw)') < conferir.indexOf('normalizeAddress(raw)'), 'checked before the address is lowercased')
})

test('Carteira.js derives the external id of every kind like the service', async (t) => {
  const src = read('screens/Carteira.js')
  t.ok(src.includes("const hex = await sha256Hex(member + ':' + kind + ':' + opId)"), 'member:kind:opId')
  t.ok(src.includes("return hex === null ? null : 'var-' + hex.slice(0, 32)"), 'var- and 32 hex')
  t.ok(src.includes("await opExternalId(member, 'payout', op.opId)"), 'payout')
  t.ok(src.includes('await opExternalId(member, kind, op.opId)'), 'transfer and crypto')
  t.absent(src.includes('payoutExternalId'), 'one helper')
})

test('Carteira.js copies the address through share.js and never formats USDC as reais', async (t) => {
  const src = read('screens/Carteira.js')
  t.ok(/import \{[^}]*\bcopyText\b[^}]*\} from '\.\.\/share'/.test(src), 'copyText from share')
  t.ok(src.includes('await copyText(shareNav(), address)'), 'address copy')
  t.ok(src.includes("item.asset === 'USDC' ? usdcText(item.amountMicros) : formatBrl(item.cents)"), 'USDC statement rows')
  t.ok(src.includes("fee.asset === 'USDC' ? usdcText(fee.feeMicros) : formatBrl(fee.cents)"), 'USDC fees')
  t.ok(src.includes('usdcText(bal.usdcMicros)'), 'USDC balance')
  t.ok(src.includes("<Line label='USDC' value={usdc} />"), 'USDC label')
  t.ok(src.includes('{CRYPTO_TEXTS.USDC_HERE}'), 'not convertible sentence')
  t.absent(/formatBrl\([^)]*[Mm]icros/.test(src), 'no micros into formatBrl')
  t.ok(src.includes("const sign = incoming ? '+ ' : (item.direction === 'out' ? '- ' : '')"), 'null direction is not money out')
})

function fakeFetch (res) {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, init })
    return res
  }
  return { calls, fetch }
}

const OK = { ok: true, status: 200, redirected: false, url: UP }

test('uploadDocument: native bytes go through deps.fetch with no cache mode', async (t) => {
  const { uploadDocument } = await import('../src/account.js')
  const bytes = new Uint8Array([0xff, 0xd8, 0xff])
  const f = fakeFetch(OK)
  await uploadDocument(UP, { type: 'image/jpeg', size: bytes.byteLength, bytes }, { fetch: f.fetch, native: true })
  t.is(f.calls.length, 1)
  const init = f.calls[0].init
  t.is(init.method, 'PUT')
  t.is(init.body, bytes)
  t.is(init.headers['content-type'], 'image/jpeg')
  t.is(init.headers['if-none-match'], '*')
  t.absent('cache-control' in init.headers || 'Cache-Control' in init.headers)
  t.absent('cache' in init)
  t.is(init.credentials, 'omit')
  t.is(init.redirect, 'error')
  t.ok(init.signal)
  const web = fakeFetch(OK)
  const blob = new Blob([bytes], { type: 'image/jpeg' })
  await uploadDocument(UP, blob, { fetch: web.fetch })
  t.is(web.calls[0].init.body, blob)
  t.is(web.calls[0].init.cache, 'no-store')
})

// Android and iOS go through expo/fetch with the picker's bytes; production's
// upload URLs (2026-11-02) live on BRLA's S3 bucket.
test('uploadDocument: native bytes reach the production S3 upload host, and only that bucket', async (t) => {
  const { uploadDocument } = await import('../src/account.js')
  const S3 = 'https://brla4platforms-production-uploaded-documents.s3.eu-west-1.amazonaws.com'
  const url = S3 + '/kyc/d1/front?X-Amz-Signature=' + 'a'.repeat(1900)
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  const doc = { type: 'image/png', size: bytes.byteLength, bytes }
  const f = fakeFetch({ ok: true, status: 200, redirected: false, url })
  await uploadDocument(url, doc, { fetch: f.fetch, native: true })
  t.is(f.calls.length, 1)
  t.is(f.calls[0].url, url)
  t.is(f.calls[0].init.body, bytes)
  t.is(f.calls[0].init.headers['content-type'], 'image/png')
  t.is(f.calls[0].init.headers['if-none-match'], '*')
  t.absent('cache' in f.calls[0].init)
  for (const bad of ['https://another-bucket.s3.eu-west-1.amazonaws.com/u', S3 + '.evil.test/u', S3 + ':8443/u']) {
    const g = fakeFetch({ ok: true, status: 200, redirected: false, url: bad })
    try { await uploadDocument(bad, doc, { fetch: g.fetch, native: true }); t.fail(bad) } catch (e) {
      t.is(e.code, 'indisponivel', bad)
    }
    t.is(g.calls.length, 0, 'never sent: ' + bad)
  }
})

test('uploadDocument: a redirected answer or one from another origin fails', async (t) => {
  const { uploadDocument } = await import('../src/account.js')
  const blob = new Blob([new Uint8Array([1])], { type: 'image/jpeg' })
  for (const res of [
    { ...OK, redirected: true },
    { ...OK, url: 'https://evil.test/u' },
    { ...OK, url: 'https://uploads.hodle.com.br:444/u' },
    { ...OK, url: 'não é url' }
  ]) {
    const f = fakeFetch(res)
    try { await uploadDocument(UP, blob, { fetch: f.fetch }); t.fail(JSON.stringify(res)) } catch (e) {
      t.is(e.code, 'indisponivel', JSON.stringify(res))
    }
    t.is(f.calls.length, 1, 'sent once, never again')
  }
  for (const res of [OK, { ...OK, url: 'https://uploads.hodle.com.br/other' }, { ok: true, status: 204, url: '' }]) {
    await uploadDocument(UP, blob, { fetch: fakeFetch(res).fetch })
    t.pass('same origin passes: ' + JSON.stringify(res))
  }
})
