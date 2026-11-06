// lib/authenticator-data.js: the flags byte, the minimal CBOR reader of the
// attestationObject and syncState, on hand-built fixtures (no real
// authenticator output is needed: only the layout matters).
const test = require('brittle')
const { parseAuthData, authDataFromAttestationObject, syncState } = require('../lib/authenticator-data')

const UP = 0x01
const UV = 0x04
const BE = 0x08
const BS = 0x10
const AT = 0x40

// rpIdHash (32) + flags (1) + signCount (4) [+ attested credential data].
function authData (flags, { attested = false } = {}) {
  const head = new Uint8Array(37)
  head.fill(0x11, 0, 32)
  head[32] = flags
  head[36] = 1
  if (!attested) return head
  // All-zero AAGUID (what a 'none' attestation hands out), credential id
  // length 4, credential id, then a stand-in for the COSE key.
  const tail = new Uint8Array(16 + 2 + 4 + 3)
  tail[17] = 4
  tail.set([1, 2, 3, 4], 18)
  tail.set([0xa1, 0x01, 0x02], 22)
  return concat(head, tail)
}

function concat (...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

// A tiny CBOR encoder for the fixtures: ints, byte strings, text strings,
// arrays, objects (text keys, insertion order), { raw } for literal bytes.
function cborHead (major, n) {
  if (n < 24) return new Uint8Array([(major << 5) | n])
  if (n < 0x100) return new Uint8Array([(major << 5) | 24, n])
  if (n < 0x10000) return new Uint8Array([(major << 5) | 25, n >> 8, n & 0xff])
  return new Uint8Array([(major << 5) | 26, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff])
}

function cbor (value) {
  if (value && value.raw instanceof Uint8Array) return value.raw
  if (value instanceof Uint8Array) return concat(cborHead(2, value.length), value)
  if (typeof value === 'string') {
    const bytes = new TextEncoder().encode(value)
    return concat(cborHead(3, bytes.length), bytes)
  }
  if (typeof value === 'number') return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value)
  if (Array.isArray(value)) return concat(cborHead(4, value.length), ...value.map(cbor))
  const entries = Object.entries(value)
  return concat(cborHead(5, entries.length), ...entries.flatMap(([k, v]) => [cbor(k), cbor(v)]))
}

test('parseAuthData reads every flag at byte 32', (t) => {
  const flags = parseAuthData(authData(0xdd)).flags
  t.alike(flags, { up: true, uv: true, be: true, bs: true, at: true, ed: true })
  t.alike(parseAuthData(authData(0)).flags, { up: false, uv: false, be: false, bs: false, at: false, ed: false })
  t.is(parseAuthData(new Uint8Array(36)), null, '36 bytes: too short')
  t.is(parseAuthData(null), null)
  t.is(parseAuthData('x'.repeat(40)), null)
  t.ok(parseAuthData(authData(BE).buffer).flags.be, 'ArrayBuffer input')
  const view = new DataView(concat(new Uint8Array(3), authData(BE)).buffer, 3)
  t.ok(parseAuthData(view).flags.be, 'view at an offset')
})

test('syncState: BE decides, BS is not an input', (t) => {
  t.is(syncState({ authenticatorData: authData(UP | UV | BE | BS) }), 'synced', '0x1d')
  t.is(syncState({ authenticatorData: authData(UP | UV | BE) }), 'synced', '0x0d, BS clear')
  t.is(syncState({ authenticatorData: authData(UP | UV | AT) }), 'bound', '0x45')
  t.is(syncState({ authenticatorData: authData(UP | UV) }), 'bound', '0x05')
  t.is(syncState({ authenticatorData: new Uint8Array(36) }), 'unknown', '36 bytes')
  t.is(syncState({}), 'unknown', 'nothing')
  t.is(syncState(), 'unknown', 'no argument')
  t.is(syncState({ authenticatorData: authData(UP | UV | BE).buffer }), 'synced', 'ArrayBuffer')
  t.is(syncState({ authenticatorData: authData(UP | UV | BE | AT, { attested: true }) }), 'synced', 'all-zero AAGUID with BE')
  t.is(syncState({ authenticatorData: authData(UP | UV | AT, { attested: true }) }), 'bound', 'all-zero AAGUID without BE')
})

test('authDataFromAttestationObject: none and packed formats', (t) => {
  const data = authData(UP | UV | BE | AT, { attested: true })
  const none = cbor({ fmt: 'none', attStmt: {}, authData: data })
  t.alike(authDataFromAttestationObject(none), data)
  t.alike(authDataFromAttestationObject(none.buffer), data, 'ArrayBuffer')
  t.is(syncState({ attestationObject: none }), 'synced')
  t.is(syncState({ attestationObject: cbor({ fmt: 'none', attStmt: {}, authData: authData(UP | UV | AT, { attested: true }) }) }), 'bound')

  const packed = cbor({ fmt: 'packed', attStmt: { alg: -7, sig: new Uint8Array(70).fill(3), x5c: [new Uint8Array(300).fill(4), new Uint8Array(20)] }, authData: data })
  t.alike(authDataFromAttestationObject(packed), data, 'packed attStmt with alg -7 and x5c')

  const first = cbor({ authData: data, fmt: 'none', attStmt: {} })
  t.alike(authDataFromAttestationObject(first), data, 'key order does not matter')

  const out = authDataFromAttestationObject(none)
  out.fill(0)
  t.alike(authDataFromAttestationObject(none), data, 'the result is a copy')

  t.is(syncState({ authenticatorData: authData(UP | UV), attestationObject: none }), 'bound', 'authenticator data wins')
  t.is(syncState({ authenticatorData: new Uint8Array(3), attestationObject: none }), 'synced', 'falls back to the attestationObject')
})

test('authDataFromAttestationObject skips any well-formed item', (t) => {
  const data = authData(UP | BE)
  const tagged = { raw: concat(new Uint8Array([0xc1]), cbor(5)) }
  const float = { raw: new Uint8Array([0xfb, 0x40, 0x09, 0x21, 0xfb, 0x54, 0x44, 0x2d, 0x18]) }
  const half = { raw: new Uint8Array([0xf9, 0x3c, 0x00]) }
  const simple = { raw: new Uint8Array([0xf5]) }
  const simple1 = { raw: new Uint8Array([0xf8, 0x20]) }
  const bigUint = { raw: new Uint8Array([0x1b, 0, 0, 0, 1, 0, 0, 0, 0]) }
  const obj = cbor({ a: tagged, b: float, c: half, d: simple, e: simple1, f: bigUint, g: -500, h: [1, [2, { x: 'y' }]], authData: data })
  t.alike(authDataFromAttestationObject(obj), data)

  let nested = cbor(1)
  for (let i = 0; i < 15; i++) nested = concat(new Uint8Array([0x81]), nested)
  t.alike(authDataFromAttestationObject(cbor({ deep: { raw: nested }, authData: data })), data, 'nesting within the cap')
  let tooDeep = cbor(1)
  for (let i = 0; i < 40; i++) tooDeep = concat(new Uint8Array([0x81]), tooDeep)
  t.is(authDataFromAttestationObject(cbor({ deep: { raw: tooDeep }, authData: data })), null, 'nesting over the cap')
})

test('authDataFromAttestationObject: anything unexpected -> null', (t) => {
  const data = authData(UP | BE)
  const good = cbor({ fmt: 'none', attStmt: {}, authData: data })
  const cases = {
    empty: new Uint8Array(0),
    'not bytes': 'abc',
    truncated: good.subarray(0, good.length - 1),
    'trailing byte': concat(good, new Uint8Array([0])),
    'top-level array': cbor([data]),
    'indefinite map': concat(new Uint8Array([0xbf]), cbor('authData'), cbor(data), new Uint8Array([0xff])),
    'indefinite byte string in an extra key': cbor({ x: { raw: new Uint8Array([0x5f, 0x41, 0x00, 0xff]) }, authData: data }),
    'reserved additional info': cbor({ x: { raw: new Uint8Array([0x1c]) }, authData: data }),
    'invalid one-byte simple': cbor({ x: { raw: new Uint8Array([0xf8, 0x10]) }, authData: data }),
    'integer key': concat(new Uint8Array([0xa1]), cbor(1), cbor(data)),
    'authData as text': cbor({ authData: 'abc' }),
    'duplicate authData': concat(new Uint8Array([0xa2]), cbor('authData'), cbor(data), cbor('authData'), cbor(data)),
    'no authData': cbor({ fmt: 'none', attStmt: {} }),
    'count larger than the input': new Uint8Array([0xbb, 0, 0, 0, 1, 0, 0, 0, 0]),
    'length past the end': concat(new Uint8Array([0xa1]), cbor('authData'), new Uint8Array([0x58, 200, 1, 2])),
    oversized: cbor({ pad: new Uint8Array(64 * 1024), authData: data })
  }
  for (const [name, bytes] of Object.entries(cases)) {
    t.is(authDataFromAttestationObject(bytes), null, name)
    t.is(syncState({ attestationObject: bytes }), 'unknown', name + ': unknown')
  }
})
