'use strict'

// The photo hash of fetchMedia: an injected digest (natively expo-crypto,
// src/media/hash.native.js) is used and still has to match descriptor.sha256;
// without one, noble. The dev-only 'media-hash' timing never changes what is
// accepted.
const test = require('brittle')
const { createHash, webcrypto } = require('node:crypto')
const load = () => import('../src/media/fetch.js')

const AUTHOR = 'ab'.repeat(32)
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

// Stamps a minimal JPEG frame header (SOF0, 1x1, one component) on the start
// of `bytes`, so rpc.mediaBounds accepts the photo fetchMedia now checks.
function photo (bytes) {
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00])
  return bytes
}

function descriptor (bytes, over = {}) {
  return {
    core: 'cd'.repeat(32),
    mime: 'image/jpeg',
    start: 1,
    blocks: Math.ceil(bytes.byteLength / 32768),
    bytes: bytes.byteLength,
    sha256: sha(bytes),
    width: 10,
    height: 20,
    ...over
  }
}

function response (bytes) {
  let done = false
  return {
    status: 200,
    redirected: false,
    body: {
      getReader: () => ({
        read: async () => (done ? { done: true } : ((done = true), { done: false, value: bytes })),
        cancel: async () => {}
      }),
      cancel: async () => {}
    }
  }
}

function spies (digestOf = (algorithm, bytes) => webcrypto.subtle.digest(algorithm, bytes)) {
  const calls = { subtle: [], noble: 0 }
  const subtle = {
    digest: async (algorithm, bytes) => {
      calls.subtle.push({ algorithm, bytes: Uint8Array.from(bytes) })
      return digestOf(algorithm, bytes)
    }
  }
  const sha256 = (bytes) => {
    calls.noble += 1
    return createHash('sha256').update(bytes).digest()
  }
  return { calls, subtle, sha256 }
}

const reason = async (p) => {
  try { await p } catch (err) { return err }
  return null
}

test('an injected digest is used with the exact bytes, and noble is not', async (t) => {
  const { fetchMedia } = await load()
  const bytes = photo(new Uint8Array(70000).map((_, i) => i % 251))
  const { calls, subtle, sha256 } = spies()
  const got = await fetchMedia(AUTHOR, descriptor(bytes), { fetch: async () => response(bytes), subtle, sha256 })
  t.alike(Array.from(got), Array.from(bytes))
  t.is(calls.subtle.length, 1, 'injected digest called once')
  t.is(calls.subtle[0].algorithm, 'SHA-256')
  t.alike(Array.from(calls.subtle[0].bytes), Array.from(bytes), 'given the exact bytes')
  t.is(calls.noble, 0, 'noble not used')
})

test('a wrong injected digest still fails with conteúdo não confere', async (t) => {
  const { fetchMedia } = await load()
  const bytes = photo(new Uint8Array(1000).fill(5))
  const { subtle, sha256 } = spies(async () => new Uint8Array(32).buffer)
  const err = await reason(fetchMedia(AUTHOR, descriptor(bytes), { fetch: async () => response(bytes), subtle, sha256 }))
  t.is(err && err.message, 'conteúdo não confere')
  t.absent(err.retryable)
})

test('without a digest (subtle null) noble is used', async (t) => {
  const { fetchMedia } = await load()
  const bytes = photo(new Uint8Array(1000).fill(9))
  const { calls, sha256 } = spies()
  await fetchMedia(AUTHOR, descriptor(bytes), { fetch: async () => response(bytes), subtle: null, sha256 })
  t.is(calls.noble, 1)
  const err = await reason(fetchMedia(AUTHOR, descriptor(bytes, { sha256: 'ef'.repeat(32) }), { fetch: async () => response(bytes), subtle: null, sha256 }))
  t.is(err && err.message, 'conteúdo não confere', 'noble mismatch fails too')
})

test('hash.web.js keeps WebCrypto; hash.native.js without expo-crypto leaves noble', async (t) => {
  const web = await import('../src/media/hash.web.js')
  t.is(web.nativeSubtle, undefined)
  // Node has no require inside an ES module, as a missing native module
  // throws at load: the fallback is undefined, never a broken digest.
  const native = await import('../src/media/hash.native.js')
  t.is(native.nativeSubtle, undefined)
  const { fetchMedia } = await load()
  const bytes = photo(new Uint8Array(500).fill(1))
  const { calls, sha256 } = spies()
  await fetchMedia(AUTHOR, descriptor(bytes), { fetch: async () => response(bytes), subtle: web.nativeSubtle, sha256 })
  t.is(calls.noble, 0, 'undefined subtle falls back to the global WebCrypto')
})

test('media-hash timing: one line per photo, both paths, result unchanged', async (t) => {
  const { fetchMedia } = await load()
  const bytes = photo(new Uint8Array(4096).fill(2))
  const lines = []
  const marks = { mark: (name, extra) => lines.push([name, extra]) }
  const { calls, subtle, sha256 } = spies()
  await fetchMedia(AUTHOR, descriptor(bytes), { fetch: async () => response(bytes), subtle, sha256, marks })
  t.is(lines.length, 1)
  t.is(lines[0][0], 'media-hash')
  t.ok(/^native \d+\.\d ms, js \d+\.\d ms, 4096 B$/.test(lines[0][1]), lines[0][1])
  t.is(calls.subtle.length, 1)
  t.is(calls.noble, 1, 'noble timed on the same bytes')

  // The extra noble hash is right, but the real path's wrong digest decides.
  const bad = spies(async () => new Uint8Array(32).buffer)
  const err = await reason(fetchMedia(AUTHOR, descriptor(bytes), { fetch: async () => response(bytes), subtle: bad.subtle, sha256: bad.sha256, marks }))
  t.is(err && err.message, 'conteúdo não confere')

  // A noble that throws while timing changes nothing.
  const boom = () => { throw new Error('x') }
  t.alike(Array.from(await fetchMedia(AUTHOR, descriptor(bytes), { fetch: async () => response(bytes), subtle, sha256: boom, marks })), Array.from(bytes))
  t.ok(/^native \d+\.\d ms, js falhou, 4096 B$/.test(lines[lines.length - 1][1]))

  lines.length = 0
  const only = spies()
  await fetchMedia(AUTHOR, descriptor(bytes), { fetch: async () => response(bytes), subtle: null, sha256: only.sha256, marks })
  t.is(only.calls.noble, 1, 'noble path: no second hash')
  t.ok(/^js \d+\.\d ms, 4096 B$/.test(lines[0][1]), lines[0][1])
})

// Every screen that downloads a photo hands fetchMedia the native digest, so
// no listing, chat, link card, forward or report photo falls back to noble on
// the phone (#473, #539).
test('every app media download passes the native digest', (t) => {
  const fs = require('node:fs')
  const path = require('node:path')
  const src = path.join(__dirname, '../src')
  const read = (rel) => fs.readFileSync(path.join(src, rel), 'utf8')
  const files = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(src, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(rel)
      else if (rel.endsWith('.js') && !rel.startsWith('media' + path.sep)) files.push(rel)
    }
  }
  walk('.')
  const callsOf = (code, name) => {
    const out = []
    let at = code.indexOf(name + '(')
    while (at !== -1) {
      let depth = 0
      let end = at + name.length
      for (; end < code.length; end++) {
        if (code[end] === '(') depth++
        else if (code[end] === ')' && --depth === 0) break
      }
      out.push(code.slice(at, end + 1))
      at = code.indexOf(name + '(', end)
    }
    return out
  }
  const hashed = (text) => text.includes('mediaHashDeps()') || text.includes('subtle: nativeSubtle')
  let seen = 0
  for (const rel of files) {
    const code = read(rel)
    for (const call of [...callsOf(code, 'fetchMedia'), ...callsOf(code, 'fetchAvatarBytes')]) {
      seen++
      t.ok(hashed(call), rel + ': ' + call)
    }
    for (const line of code.split('\n').filter((l) => l.includes('const fetchDeps = '))) {
      seen++
      t.ok(hashed(line), rel + ': ' + line.trim())
    }
    for (const call of callsOf(code, 'sourceFor').filter((c) => !c.includes('cachedOnly: true'))) {
      seen++
      t.ok(call.includes('fetchDeps'), rel + ': ' + call)
    }
  }
  t.ok(seen >= 10, 'the scan found the download sites (' + seen + ')')
  t.ok(read('ui/MediaView.js').includes('export const mediaHashDeps = () => (HASH_PERF ? { subtle: nativeSubtle, marks: perfMarks() } : { subtle: nativeSubtle })'))
})

test('without marks nothing extra runs', async (t) => {
  const { fetchMedia } = await load()
  const bytes = photo(new Uint8Array(4096).fill(4))
  const { calls, subtle, sha256 } = spies()
  await fetchMedia(AUTHOR, descriptor(bytes), { fetch: async () => response(bytes), subtle, sha256 })
  t.is(calls.noble, 0)
})
