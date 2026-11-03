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
