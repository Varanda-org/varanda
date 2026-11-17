'use strict'

// The key of an extra passkey, the pure part (src/extraPasskeyKey.js): when
// it skips with no prompt, the order of the steps (the ceremony first, inside
// the call), what goes to the account service, and how each answer maps to
// an outcome. Nothing is ever sent twice.
const test = require('brittle')
const nodeCrypto = require('node:crypto')

const load = () => import('../src/extraPasskeyKey.js')
const M = 'ab'.repeat(32)
const ATT = Buffer.from([0xa3, 1, 2, 3, 4, 5]).toString('base64url')
const LOOKUP = 'cd'.repeat(32)
const CURRENT = 'Q1VSUkVOVA'
const NEW = 'TkVX'
const NONCE = 'p'.repeat(43)
const ASSERTION = { credentialId: CURRENT, clientDataJSON: 'Yw', authenticatorData: 'YQ', signature: 'cw' }
const ENTRY = { credentialId: NEW, attestationObject: ATT, lookupId: LOOKUP, userId: '77'.repeat(32), blob: {} }

function coded (code) {
  const err = new Error(code)
  err.code = code
  return err
}

function effects ({ startImpl, confirmImpl, signImpl, addImpl } = {}) {
  const calls = []
  return {
    calls,
    start: async (args) => { calls.push(['start', args]); return startImpl ? startImpl() : { nonce: NONCE, passkeys: [CURRENT], username: 'ana' } },
    confirm: (args) => { calls.push(['confirm', args]); return confirmImpl ? confirmImpl() : Promise.resolve({ ok: true, assertion: ASSERTION }) },
    sign: async (args) => { calls.push(['sign', args]); return signImpl ? signImpl() : { signature: 'e'.repeat(128) } },
    add: async (args) => { calls.push(['add', args]); return addImpl ? addImpl() : { added: true } }
  }
}

test('createdKeyOf: only a full entry with an attestation object', async (t) => {
  const { createdKeyOf } = await load()
  t.alike(createdKeyOf(ENTRY), { credentialId: NEW, attestationObject: ATT, lookupId: LOOKUP }, 'no blob, user id or anything else')
  t.is(createdKeyOf({ ...ENTRY, attestationObject: null }), null, 'a creation without attestation object')
  t.is(createdKeyOf({ ...ENTRY, attestationObject: 'a+b' }), null)
  t.is(createdKeyOf({ ...ENTRY, lookupId: 'CD'.repeat(32) }), null)
  t.is(createdKeyOf({ ...ENTRY, credentialId: '' }), null)
  t.is(createdKeyOf(null), null)
})

test('passkeyEntryOf: the add result\'s attestation object reaches createdKeyOf', async (t) => {
  const { passkeyEntryOf, createdKeyOf } = await load()
  // The shape of identity.addPasskey() and complete() (web node and native).
  const result = { credentialId: NEW, userId: '77'.repeat(32), lookupId: LOOKUP, blob: { nonce: 'n', ciphertext: 'c' }, attestationObject: ATT }
  const entry = passkeyEntryOf({ member: M, change: false, result })
  t.alike(entry, { member: M, kind: 'passkey', lookupId: LOOKUP, blob: result.blob, credentialId: NEW, userId: '77'.repeat(32), change: false, attestationObject: ATT })
  t.alike(createdKeyOf(entry), { credentialId: NEW, attestationObject: ATT, lookupId: LOOKUP }, 'the key step has something to send')
  t.is(passkeyEntryOf({ member: M, change: true, result }).change, true, 'Trocar')
  const bare = passkeyEntryOf({ member: M, change: false, result: { ...result, attestationObject: undefined } })
  t.is(bare.attestationObject, null)
  t.is(createdKeyOf(bare), null, 'a creation without attestation object skips')
})

test('registerExtraKey: start with list, the current passkey asserts over the nonce, add carries it', async (t) => {
  const { registerExtraKey, createdKeyOf } = await load()
  const e = effects()
  const out = await registerExtraKey({ member: M, created: createdKeyOf(ENTRY), currentCredentialId: CURRENT, ...e })
  t.is(out, 'stored')
  t.alike(e.calls.map((c) => c[0]), ['start', 'confirm', 'sign', 'add'])
  t.alike(e.calls[0][1], { member: M, list: true })
  t.alike(e.calls[1][1], { challenge: NONCE }, 'the assertion is over the start nonce')
  t.alike(e.calls[2][1], { nonce: NONCE, username: 'ana', sub: nodeCrypto.createHash('sha256').update(Buffer.from(ATT, 'base64url')).digest('hex') })
  t.alike(e.calls[3][1], { member: M, nonce: NONCE, signature: 'e'.repeat(128), credentialId: NEW, attestationObject: ATT, assertion: ASSERTION, lookupId: LOOKUP })
  t.absent(JSON.stringify(e.calls).includes('"blob"'), 'never the blob')
  t.absent(JSON.stringify(e.calls).includes('77'.repeat(32)), 'never the user id')

  const again = effects({ addImpl: () => ({ added: false }) })
  t.is(await registerExtraKey({ member: M, created: createdKeyOf(ENTRY), currentCredentialId: CURRENT, ...again }), 'stored', 'already stored ends well')
})

test('registerExtraKey: skipped with no prompt', async (t) => {
  const { registerExtraKey, createdKeyOf } = await load()
  const cases = [
    ['no attestation object', { created: createdKeyOf({ ...ENTRY, attestationObject: null }) }],
    ['no current credential', { currentCredentialId: null }],
    ['the current is the new one', { currentCredentialId: NEW }],
    ['a bad member', { member: 'zz' }]
  ]
  for (const [name, over] of cases) {
    const e = effects()
    t.is(await registerExtraKey({ member: M, created: createdKeyOf(ENTRY), currentCredentialId: CURRENT, ...e, ...over }), 'skipped', name)
    t.is(e.calls.length, 0, name + ': nothing sent')
  }
  for (const [name, answer] of [
    ['an older service (no list)', { nonce: NONCE, passkeys: null, username: null }],
    ['the current passkey has no stored key', { nonce: NONCE, passkeys: ['T1RIRVI'], username: 'ana' }],
    ['no key stored at all', { nonce: NONCE, passkeys: [], username: 'ana' }]
  ]) {
    const e = effects({ startImpl: () => answer })
    t.is(await registerExtraKey({ member: M, created: createdKeyOf(ENTRY), currentCredentialId: CURRENT, ...e }), 'skipped', name)
    t.alike(e.calls.map((c) => c[0]), ['start'], name + ': no ceremony, no add')
  }
})

test('registerExtraKey: answers map to refused or later, never a second request', async (t) => {
  const { registerExtraKey, createdKeyOf } = await load()
  for (const code of ['passkey-invalida', 'pedido-invalido', 'limite-recuperacao']) {
    const e = effects({ addImpl: () => { throw coded(code) } })
    t.is(await registerExtraKey({ member: M, created: createdKeyOf(ENTRY), currentCredentialId: CURRENT, ...e }), 'refused', code)
    t.is(e.calls.filter((c) => c[0] === 'add').length, 1, code + ': sent once')
  }
  for (const code of ['indisponivel', 'expirado', 'assinatura-invalida', undefined]) {
    const e = effects({ addImpl: () => { throw code === undefined ? new Error('rede') : coded(code) } })
    t.is(await registerExtraKey({ member: M, created: createdKeyOf(ENTRY), currentCredentialId: CURRENT, ...e }), 'later', String(code))
    t.is(e.calls.filter((c) => c[0] === 'add').length, 1, code + ': sent once')
  }
  const busy = Object.assign(coded('pedido-invalido'), { status: 429 })
  const slowed = effects({ addImpl: () => { throw busy } })
  t.is(await registerExtraKey({ member: M, created: createdKeyOf(ENTRY), currentCredentialId: CURRENT, ...slowed }), 'later', 'a 429 passes with time, whatever its code')
  t.is(slowed.calls.filter((c) => c[0] === 'add').length, 1, '429: sent once')
  const slowStart = effects({ startImpl: () => { throw busy } })
  t.is(await registerExtraKey({ member: M, created: createdKeyOf(ENTRY), currentCredentialId: CURRENT, ...slowStart }), 'later', 'a 429 on start')
  const offline = effects({ startImpl: () => { throw coded('indisponivel') } })
  t.is(await registerExtraKey({ member: M, created: createdKeyOf(ENTRY), currentCredentialId: CURRENT, ...offline }), 'later', 'start offline')
  t.alike(offline.calls.map((c) => c[0]), ['start'])

  const cancelled = effects({ confirmImpl: () => Promise.reject(coded('CANCELLED')) })
  t.is(await registerExtraKey({ member: M, created: createdKeyOf(ENTRY), currentCredentialId: CURRENT, ...cancelled }), 'later', 'a cancelled assertion')
  t.alike(cancelled.calls.map((c) => c[0]), ['start', 'confirm'], 'nothing signed or sent')
  const thrown = effects({ confirmImpl: () => { throw coded('LOCKED') } })
  t.is(await registerExtraKey({ member: M, created: createdKeyOf(ENTRY), currentCredentialId: CURRENT, ...thrown }), 'later', 'a confirm that throws')

  const other = effects({ confirmImpl: () => Promise.resolve({ ok: true, assertion: { ...ASSERTION, credentialId: 'T1RIRVI' } }) })
  t.is(await registerExtraKey({ member: M, created: createdKeyOf(ENTRY), currentCredentialId: CURRENT, ...other }), 'skipped', 'an assertion of a passkey with no stored key')
  t.alike(other.calls.map((c) => c[0]), ['start', 'confirm'])

  const unsigned = effects({ signImpl: () => { throw coded('LOCKED') } })
  t.is(await registerExtraKey({ member: M, created: createdKeyOf(ENTRY), currentCredentialId: CURRENT, ...unsigned }), 'later', 'a sign that fails')
  t.alike(unsigned.calls.map((c) => c[0]), ['start', 'confirm', 'sign'])
})

test('confirmExtraKey: confirm is called inside the call, before any await', async (t) => {
  const { prepareExtraKey, confirmExtraKey, createdKeyOf } = await load()
  const e = effects()
  const created = createdKeyOf(ENTRY)
  const prepared = await prepareExtraKey({ member: M, created, currentCredentialId: CURRENT, start: e.start })
  t.is(prepared.outcome, 'ready')
  e.calls.length = 0
  const pending = confirmExtraKey({ member: M, created, prepared, ...e })
  t.alike(e.calls.map((c) => c[0]), ['confirm'], 'the ceremony already started, synchronously')
  t.is(await pending, 'stored')
  t.is(await confirmExtraKey({ member: M, created, prepared: { outcome: 'skipped' }, ...e }), 'skipped')
})

test('outcomeText: only a stored key says the deletion runs at once', async (t) => {
  const { outcomeText, STORED_TEXT, NOT_STORED_TEXT, CONFIRM_TEXT } = await load()
  t.is(outcomeText('stored'), STORED_TEXT)
  for (const o of ['skipped', 'refused', 'later']) t.is(outcomeText(o), NOT_STORED_TEXT)
  t.absent((STORED_TEXT + NOT_STORED_TEXT + CONFIRM_TEXT).includes('\u2014'))
})
