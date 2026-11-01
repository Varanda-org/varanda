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
    [/import \{[^}]*\bbase64url\b[^}]*\} from '\.\.\/appLinkSecret'/, 'base64url']
  ]
  for (const [re, name] of imports) t.ok(re.test(src), name)
  const uploads = src.match(/uploadDocument\(/g) || []
  const withDeps = src.match(/uploadDocument\([^)]*, uploadDeps\(\)\)/g) || []
  t.ok(uploads.length >= 2)
  t.is(withDeps.length, uploads.length, 'every upload passes uploadDeps()')
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
