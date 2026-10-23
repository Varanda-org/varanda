// The member's diary on Hypercore 10 (10.38.2, the random-access-storage
// line; v11 is native-only), runnable in Node and in a browser.
//
// Findings read from the installed hypercore@10.38.2 (not assumed):
// - Constructor: new Hypercore(storage, key?, opts) (index.js:40-55); when
//   the second argument is an options object the key comes from opts.key.
//   Options used here: keyPair (index.js:73, lib/core.js:100 on creation;
//   the stored header.keyPair signs afterwards), compat (lib/core.js:79:
//   `opts.compat === true || (opts.compat !== false && !opts.manifest)`, so
//   the DEFAULT is compat mode whenever no manifest is given), manifest
//   (lib/core.js:101-107, 137-143) and valueEncoding (index.js:347,
//   c.from(...) of the nested compact-encoding 2.19.2).
// - Storage: Hypercore.defaultStorage (index.js:190-195) passes a plain
//   function through untouched and lib/core.js:49-53 calls it as
//   storage(name) for 'oplog', 'tree', 'bitfield', 'data' and 'header',
//   expecting a random-access-storage instance (see ./storage.js).
// - static Hypercore.getProtocolMuxer(stream) exists (index.js:153) and
//   returns stream.noiseStream.userData.
// - replicate(stream) (index.js:509-523) calls createProtocolStream, which
//   sets noiseStream.userData = Protomux.from(noiseStream) (index.js:174-180)
//   and setKeepAlive(5000); the muxer is therefore where @varanda/core's
//   attachAdmission looks for it (socket.noiseStream.userData.isProtomux).
// - Key vs public key, measured with hypercore-crypto.keyPair(): with the
//   defaults (compat) core.key === keyPair.publicKey and core.manifest is the
//   default signer manifest, version 1 (lib/verifier.js:167-180); with
//   { compat: false } core.key is the manifest hash, so key !== publicKey.
//   Reopening the same storage factory with the same keyPair restores the
//   same key and length and stays writable in both modes.
// - Restored key pair: on an existing storage Core.open (lib/core.js:88-125)
//   skips the creation branch, so opts.keyPair is neither stored nor compared
//   (only opts.key is, lib/core.js:146-148); the stored pair comes back in
//   header.keyPair (unslabbed at lib/core.js:132-135) and the Hypercore
//   instance exposes it as this.keyPair = this.core.header.keyPair
//   (index.js:409) after ready(). On an empty storage with no keyPair
//   lib/core.js:100 generates one and stores it (lib/core.js:108). The wrapper
//   therefore never generates a key pair itself: it reads core.keyPair after
//   ready() and compares a given keyPair against it.
// - APPEND_MODE: valueEncoding 'json' resolves to compact-encoding 2.19.2's
//   raw.json (index.js:933-934), and block 0 read back with
//   { valueEncoding: 'binary' } (and with { raw: true }) is byte-for-byte
//   JSON.stringify(record) (76 bytes for a 76-byte record), exactly what the
//   Hypercore 11 side decodes (@varanda/core lib/store.js:472-480,
//   lib/records.js:54-62). No prefix appears, so the 'json' mode is kept;
//   'binary' would append b4a.from(JSON.stringify(record)) instead.
const Hypercore = require('hypercore')
const b4a = require('b4a')
const { certForKey } = require('@varanda/core/lib/cert')
const { memberCertRecord, postRecord, validateRecord, decodeBlock } = require('@varanda/core/lib/records')
const { DIARY_OPTIONS } = require('./diary-options')

// 'json': append plain records through valueEncoding 'json' (measured to
// store exactly JSON.stringify bytes). 'binary': append the JSON bytes
// ourselves on a binary core (fallback, unused because no prefix appeared).
const APPEND_MODE = 'json'

const HEX64 = /^[0-9a-f]{64}$/

function noop () {}

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function encodeRecord (record) {
  return APPEND_MODE === 'json' ? record : b4a.from(JSON.stringify(record), 'utf8')
}

async function createMember ({ storage, keyPair = null, association, ...overrides } = {}) {
  if (typeof storage !== 'function') throw new TypeError('storage must be a factory (name) => RandomAccess')
  if (typeof association !== 'string' || !HEX64.test(association)) {
    throw new Error('chave da associação inválida')
  }
  if (keyPair !== null && (!keyPair || !b4a.isBuffer(keyPair.publicKey))) {
    throw new TypeError('keyPair must be { publicKey, secretKey }')
  }
  const options = { ...DIARY_OPTIONS, ...overrides }
  // No key pair is generated here: on an empty storage hypercore generates
  // and stores one (lib/core.js:100,108); on an existing storage the stored
  // pair is restored whatever is passed, so it is compared below.
  const coreOptions = { valueEncoding: APPEND_MODE === 'json' ? 'json' : 'binary' }
  if (keyPair !== null) coreOptions.keyPair = keyPair
  if (options.compat !== undefined) coreOptions.compat = options.compat
  if (options.manifest !== undefined) coreOptions.manifest = options.manifest

  const core = new Hypercore(storage, coreOptions)
  await core.ready()
  // The pair the core signs with (index.js:409: this.core.header.keyPair).
  const stored = core.keyPair
  if (!stored || !stored.publicKey || !stored.secretKey) {
    await core.close()
    throw new Error('diário sem par de chaves gravado')
  }
  if (keyPair !== null && !b4a.equals(stored.publicKey, keyPair.publicKey)) {
    await core.close()
    throw new Error('chave não corresponde ao diário')
  }
  keyPair = { publicKey: stored.publicKey, secretKey: stored.secretKey }
  const key = hex(core.key)

  // Writes (setCert, post) run one at a time through this chain so a length
  // check and its append are atomic with respect to the other writes on this
  // member: two overlapping setCert calls would otherwise both see length 0
  // and the second certificate would land in block 1.
  let writes = Promise.resolve()
  function serialized (fn) {
    const run = writes.then(fn)
    writes = run.then(noop, noop)
    return run
  }

  // Raw block bytes decoded as the Hypercore 11 side decodes them.
  async function block (index) {
    const raw = await core.get(index, { valueEncoding: 'binary' })
    return decodeBlock(raw)
  }

  function setCert (cert) {
    // Verify and store a private copy: the caller's object could change
    // between this check and the queued append.
    let copy
    try {
      copy = JSON.parse(JSON.stringify(cert))
    } catch {
      return Promise.reject(new Error('certificado rejeitado: não é JSON'))
    }
    const r = certForKey(copy, key, association)
    if (!r.ok) return Promise.reject(new Error('certificado rejeitado: ' + r.reason))
    return serialized(async () => {
      if (core.length !== 0) throw new Error('certificado já gravado')
      await core.append(encodeRecord(memberCertRecord(copy)))
    })
  }

  function post (text) {
    return serialized(async () => {
      if (core.length < 1) throw new Error('certificado ausente: grave o certificado antes de publicar')
      const record = postRecord({ text })
      const reason = validateRecord(record, core.length)
      if (reason !== null) throw new Error('registro inválido: ' + reason)
      await core.append(encodeRecord(record))
      return core.length - 1
    })
  }

  async function close () {
    await core.close()
  }

  return {
    core,
    key,
    publicKey: hex(keyPair.publicKey),
    keyPair,
    manifest: core.manifest ?? null,
    block,
    setCert,
    post,
    close
  }
}

module.exports = { APPEND_MODE, createMember }
