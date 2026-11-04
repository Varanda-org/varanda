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

test('Carteira.js never looks a name up nor picks the platform', async (t) => {
  const src = read('screens/Carteira.js')
  for (const s of ['lookupUsername', 'Platform.OS', 'Clipboard']) {
    t.absent(src.includes(s), s)
  }
})

// Converter and the USDC send exist only when the service lists their action
// and there is USDC; otherwise the not-convertible sentence stays.
test('Carteira.js gates Converter and the USDC send on the actions and the USDC balance', async (t) => {
  const src = read('screens/Carteira.js')
  t.ok(src.includes("const canSwap = hasAction(policy, 'swap')"), 'swap action')
  t.ok(src.includes('const usdcHeld = bal !== null && Number.isSafeInteger(bal.usdcMicros) && bal.usdcMicros > 0'), 'USDC balance above zero')
  t.ok(src.includes('const canSendUsdc = canCrypto && networkWarning !== null && usdcHeld'), 'USDC send gated')
  t.ok(src.includes("const usdcSend = sendAsset === 'USDC' && canSendUsdc"), 'USDC send only while offered')
  t.ok(src.includes("const showSwap = canSwap && (swapPhase !== 'form' || usdcHeld)"), 'Converter gated, a running one stays')
  t.ok(src.includes('{showSwap ? USDC_TEXTS.OFFERED : CRYPTO_TEXTS.USDC_HERE}'), 'USDC_HERE without the swap')
  t.ok(/\{canSendUsdc\n\s*\? \(\n\s*<>\n\s*<Label>O que enviar<\/Label>/.test(src), 'asset choice only with USDC')
  t.is((src.match(/'swap-quote'/g) || []).length, 1, 'one quote call site')
  t.is((src.match(/signed\('swap', /g) || []).length, 1, 'one swap call site')
})

// A USDC send is paid from the USDC balance only: the op names USDC as both
// asset and source, the preview is in micros, and nothing offers BRLA for it.
test('Carteira.js never funds a USDC send with BRLA', async (t) => {
  const src = read('screens/Carteira.js')
  const conferir = slice(src, 'const conferirSend', 'const resetSend')
  t.ok(conferir.includes("signed('preview', { kind, asset: 'USDC', source: 'USDC', amountMicros: amount }, walletCryptoPreview)"), 'micros preview')
  t.ok(conferir.includes("if (usdcSend && target !== 'address') return setError(SEND_TEXTS.usdcAddress)"), 'USDC only to an address')
  t.ok(conferir.includes('usdcSend ? parseUsdc(sendAmount) : parseBrl(sendAmount)'), 'USDC amount parsed as USDC')
  const pay = slice(src, 'const sendPay', 'const checkSend')
  t.ok(pay.includes("{ opId: sendOpRef.current, amountMicros: sendConfirm.micros, asset: 'USDC', source: 'USDC' }"), 'USDC op from USDC')
  t.ok(pay.includes('Object.assign(op, debitTerms(sendConfirm.preview))'), 'debit terms from the preview')
  t.absent(/source: 'BRLA'|source: 'BRL'/.test(src), 'no BRLA source')
  t.absent(/asset: 'USDC', source: (?!'USDC')/.test(src), 'USDC never with another source')
  t.ok(src.includes('usdcSendLines(sendConfirm.preview)'), 'USDC confirm lines')
  t.ok(slice(src, 'function usdcSendLines', 'export default').includes('usdcFeeLines(p.varandaFeeMicros)'), 'fee lines in USDC')
  t.ok(src.includes('usdcText(sendConfirm.preview.reservedFeeMicros)'), 'reserved USDC fees in USDC')
  t.absent(/formatBrl\([^)]*[Mm]icros/.test(src), 'no micros into formatBrl')
  const { parseUsdc, formatUsdc } = await import('../src/wallet.js')
  t.is(formatUsdc(parseUsdc('1.000')), '1.000,00', 'a typed 1.000 is echoed as one thousand')
})

// One opId per conversion. It stays while the conversion is enviado, pendente
// or incerto, only a final op-status answer releases it, and nothing resends.
test('Carteira.js never retries a conversion nor mints a new opId while it may settle', async (t) => {
  const src = read('screens/Carteira.js')
  t.ok(src.includes("const SWAP_OPEN = Object.freeze(['enviado', 'pendente', 'incerto'])"), 'open conversion statuses')
  const pay = slice(src, 'const swapPay', 'const checkSwap')
  t.ok(/const chosen = swapPin\s*setSwapPin\(''\)/.test(pay), 'PIN cleared first')
  t.ok(pay.includes('walletSwap({ ...a, pin: chosen })'), 'PIN only in the request')
  t.ok(pay.indexOf('if (swapLockRef.current !== null) return setError(SWAP_TEXTS.inFlight)') < pay.indexOf('mintOpId()'), 'held lock blocks a new opId')
  t.is((pay.match(/mintOpId\(\)/g) || []).length, 1, 'one mint')
  t.ok(pay.includes('if (swapOpRef.current === null) swapOpRef.current = mintOpId()'), 'mint only without an opId')
  t.ok(pay.includes("await opExternalId(member, 'swap', op.opId)"), 'external id like the service')
  const unknown = pay.slice(pay.indexOf('if (err && err.uncertain === true) {'), pay.indexOf('// A definite refusal'))
  t.ok(unknown.includes("status: 'incerto'"), 'unknown outcome is incerto')
  t.absent(unknown.includes('swapOpRef.current = null'), 'unknown outcome keeps the opId')
  t.absent(unknown.includes('setSwapLock('), 'unknown outcome keeps the lock')
  t.absent(/swapPay\(true\)|swapPay\(retry/.test(src), 'no retry entry')
  t.absent(/label='Tentar de novo' onPress=\{swap/.test(src), 'no retry button')
  const settle = slice(src, 'const settleSwap = useCallback', 'const clearSecrets')
  t.ok(settle.indexOf('if (SWAP_OPEN.includes(row.status)) return') < settle.indexOf('swapOpRef.current = null'), 'opId kept while open')
  t.ok(settle.indexOf('if (SWAP_OPEN.includes(row.status)) return') < settle.indexOf('setSwapLock(null)'), 'lock kept while open')
  const poll = slice(src, 'const swapId', 'const onSwapExpired')
  t.ok(poll.includes("signed('op-status', { externalId: swapId }, walletOpStatus)"), 'progress reads op-status')
  t.ok(poll.includes('POLL_EVERY_MS'), 'every 10 s')
  t.absent(poll.includes('walletSwap'), 'the poll never converts')
  t.ok(src.includes('const POLL_EVERY_MS = 10 * 1000'))
  const expired = slice(src, 'const onSwapExpired', 'const newSwap')
  t.ok(expired.includes("if (swapLockRef.current !== null || swapPhaseRef.current !== 'confirm') return"), 'countdown guarded')
  t.ok(slice(src, 'const newSwap', 'const off =').includes('if (swapLockRef.current !== null) return'), 'no new conversion while one is held')
})

// The three outcomes of a conversion: concluido offers a new one; falhou and
// incerto show the support line with the code and no retry.
test('Carteira.js shows the Converter outcomes', async (t) => {
  const src = read('screens/Carteira.js')
  const quote = slice(src, "} else if (showSwap && swapPhase === 'confirm'", "} else if (showSwap && swapPhase === 'progress'")
  t.ok(quote.includes('swapLines.map('), 'quote lines')
  t.ok(src.includes('const swapLines = swapConfirm !== null ? swapQuoteLines(swapConfirm.quote) : null'), 'lines from swapQuoteLines')
  t.ok(quote.includes('<Notice>{USDC_TEXTS.QUOTE}</Notice>'), 'indicative warning')
  t.ok(quote.indexOf('USDC_TEXTS.QUOTE') < quote.indexOf('<PinField'), 'warning before the PIN')
  const form = slice(src, "if (showSwap && swapPhase === 'form')", "} else if (showSwap && swapPhase === 'confirm'")
  t.ok(form.includes('Você vai converter {usdcText(typedSwap)}.'), 'amount echoed before the PIN')
  const card = slice(src, "} else if (showSwap && swapPhase === 'progress'", 'content = (')
  t.ok(card.includes("const support = status === 'incerto' || status === 'falhou'"), 'support on falhou and incerto')
  t.ok(/\{status === 'incerto'\n\s*\? <Notice>\{UNCERTAIN_MONEY\}<\/Notice>/.test(card), 'uncertain copy')
  t.ok(card.includes('<Notice>{USDC_TEXTS.SUPPORT}</Notice>'), 'support line')
  t.ok(card.includes('{swapResult.externalId}</Text>'), 'external id shown')
  t.ok(/\{swapLock === null && !SWAP_OPEN\.includes\(status\)\n\s*\? <Btn label='Fechar' onPress=\{newSwap\}/.test(card), 'Fechar once settled')
  t.absent(card.includes('Tentar de novo'), 'no retry on any outcome')
  t.absent(card.includes('swapPay'), 'the card never converts')
  t.ok(card.includes('USDC_TEXTS.PROGRESS'), 'progress copy')
  const { USDC_TEXTS } = await import('../src/wallet.js')
  t.ok(USDC_TEXTS.SUPPORT.includes('Não tente de novo'))
})

// A settled conversion (concluido or falhou) closes back to the form; the
// falhou card keeps the support text and code, and there is still no retry.
test('Carteira.js closes a settled conversion back to the form', async (t) => {
  const src = read('screens/Carteira.js')
  const card = slice(src, "} else if (showSwap && swapPhase === 'progress'", 'content = (')
  t.ok(card.includes("label='Fechar' onPress={newSwap}"), 'Fechar on the card')
  t.ok(card.includes('USDC_TEXTS.SUPPORT') && card.includes('SWAP_TEXTS.code'), 'support text and code stay')
  t.absent(card.includes('Nova conversão'), 'one way out')
  const close = slice(src, 'const newSwap', 'const off =')
  t.ok(close.indexOf('if (swapLockRef.current !== null) return') < close.indexOf('setSwapPhase('), 'never past an open lock')
  for (const s of ['setSwapResult(null)', "setSwapAmount('')", 'setSwapConfirm(null)', "setSwapPhase('form')"]) {
    t.ok(close.includes(s), s)
  }
  t.absent(close.includes('swapOpRef.current'), 'never reuses or touches the opId')
  t.absent(close.includes('setSwapLock('), 'never touches the lock')
  t.absent(close.includes('swapPay'), 'closing never converts')
})

// The USDC confirmation renders only with usdcSendLines, so a preview without
// them stays on the form with the refusal.
test('Carteira.js refuses a USDC preview whose lines cannot be built', async (t) => {
  const src = read('screens/Carteira.js')
  const conferir = slice(src, 'const conferirSend', 'const resetSend')
  const usdc = conferir.slice(conferir.indexOf('if (usdcSend) {'), conferir.indexOf('const cents = amount'))
  t.ok(usdc.includes('if (usdcSendLines(p) === null) return setError(SEND_TEXTS.previewRefused)'), 'refused without lines')
  t.ok(usdc.indexOf('usdcSendLines(p)') < usdc.indexOf("setSendPhase('confirm')"), 'checked before the confirm phase')
})

// A USDC amount is never previewed as reais once USDC stops being offered.
test('Carteira.js drops the USDC choice when USDC is no longer offered', async (t) => {
  const src = read('screens/Carteira.js')
  const reset = slice(src, "if (canSendUsdc || sendAsset !== 'USDC') return", '}, [canSendUsdc, sendAsset, setSendPhase])')
  t.ok(reset.includes("setSendAsset('BRLA')"), 'back to BRLA')
  t.ok(reset.includes("setSendAmount('')"), 'typed USDC digits cleared')
  t.ok(reset.includes('setSendConfirm(null)'), 'USDC confirmation dropped')
  t.ok(reset.indexOf('if (sendLockRef.current !== null') < reset.indexOf('setSendConfirm(null)'), 'never under a send in flight')
  const conferir = slice(src, 'const conferirSend', 'const resetSend')
  const guard = "if (sendAsset === 'USDC' && !canSendUsdc) return setError(SEND_TEXTS.previewRefused)"
  t.ok(conferir.includes(guard), 'USDC without the offer is refused')
  t.ok(conferir.indexOf(guard) < conferir.indexOf("signed('preview', { kind, cents }"), 'before the BRLA preview')
})

// Hodle support searches the Hodle swap id: it is kept from the swap answer
// and from op-status rows, and shown next to the code on the support cards.
test('Carteira.js keeps and shows the Hodle swap id', async (t) => {
  const src = read('screens/Carteira.js')
  t.ok(src.includes("providerCode: 'Código da Hodle:'"), 'labelled for support')
  const pay = slice(src, 'const swapPay', 'const checkSwap')
  t.ok(pay.includes('setSwapResult({ externalId: out.externalId, status: out.status, providerId: out.providerId || null })'), 'from the swap answer')
  const settle = slice(src, 'const settleSwap = useCallback', 'const clearSecrets')
  t.ok(settle.includes('providerId: row.providerId || r.providerId || null'), 'from op-status, never erased')
  const card = slice(src, "} else if (showSwap && swapPhase === 'progress'", 'content = (')
  const support = card.slice(card.indexOf('{support'), card.indexOf('{swapPolling'))
  t.ok(support.includes('{swapResult.externalId}</Text>'), 'code always')
  t.ok(/\{swapResult\.providerId\n\s*\? \(/.test(support), 'Hodle id only when present')
  t.ok(support.includes('{swapResult.providerId}</Text>'), 'Hodle id shown')
  t.ok(support.includes('<Soft>{SWAP_TEXTS.providerCode}</Soft>'), 'Hodle id labelled')
})

// A conversion left pendente is re-checked from the statement, by op-status.
test('Carteira.js re-checks a pendente conversion from the statement', async (t) => {
  const src = read('screens/Carteira.js')
  const ext = slice(src, "if (view === 'extrato') {", 'Ver mais')
  t.ok(ext.includes("(OPEN_STATUSES.includes(item.status) || (item.kind === 'swap' && item.status === 'pendente')) && item.externalId !== null"), 'Conferir on a pendente swap')
  t.ok(ext.includes('onPress={() => checkItem(item.externalId)}'), 'same per-row check')
  t.ok(ext.includes("{item.kind === 'swap' && item.providerId"), 'Hodle id on swap rows')
  const check = slice(src, 'const checkItem', 'setItems(')
  t.ok(check.includes("signed('op-status', { externalId }, walletOpStatus)"), 'op-status per row')
  t.ok(check.includes('settleSwap(row)'), 'settles the Converter too')
  t.absent(check.includes('walletSwap'), 'the check never converts')
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

test('Carteira.js refuses a USDC send or a conversion above the operator cap before the preview or the quote', async (t) => {
  const src = read('screens/Carteira.js')
  t.ok(/const maxUsdcMicros = Number\.isSafeInteger\(policy\.maxUsdcMicros\)/.test(src), 'the cap comes from the policy')
  const send = slice(src, 'const conferirSend', "signed('preview', { kind, asset: 'USDC'")
  t.ok(send.includes('if (usdcSend && maxUsdcMicros !== null && amount > maxUsdcMicros) return setError(SEND_TEXTS.usdcCap(maxUsdcMicros))'), 'a USDC send above the cap is refused before its preview')
  const swap = slice(src, 'const quoteSwap', "signed('swap-quote'")
  t.ok(swap.includes('if (maxUsdcMicros !== null && micros > maxUsdcMicros) return setError(SWAP_TEXTS.cap(maxUsdcMicros))'), 'a conversion above the cap is refused before its quote')
  t.ok(/usdcCap \(micros\) \{\n {4}return 'O limite por envio de USDC é ' \+ usdcText\(micros\)/.test(src), 'the send message shows the cap in USDC')
  t.ok(/cap \(micros\) \{\n {4}return 'O limite por conversão é ' \+ usdcText\(micros\)/.test(src), 'the conversion message shows the cap in USDC')
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
  t.ok(src.includes('CRYPTO_TEXTS.USDC_HERE}'), 'not convertible sentence')
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
