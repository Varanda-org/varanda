'use strict'

// The passkey enrolment of Excluir conta, the pure part (src/passkeyEnrol.js):
// the stored record, the attestation hash the diary key signs (the same the
// account service recomputes) and one attempt with every effect injected.
const test = require('brittle')
const nodeCrypto = require('node:crypto')

const load = () => import('../src/passkeyEnrol.js')
const M = 'ab'.repeat(32)
const ATT = Buffer.from([0xa3, 1, 2, 3, 4, 5]).toString('base64url')
const ENROL = { credentialId: 'Q1JFRA', attestationObject: ATT }

test('enrolRecordOf: the exact record only', async (t) => {
  const { enrolRecordOf } = await load()
  const rec = { v: 1, rpId: 'bora.varanda.app', credentialId: 'Q1JFRA', attestationObject: ATT, publicKey: M }
  t.alike(enrolRecordOf(rec), rec)
  t.alike(enrolRecordOf({ ...rec, publicKey: null }), { ...rec, publicKey: null }, 'waiting for concluir')
  t.is(enrolRecordOf({ ...rec, prf: 'x' }), null, 'nothing more')
  t.is(enrolRecordOf({ ...rec, publicKey: 'AB'.repeat(32) }), null)
  t.is(enrolRecordOf({ ...rec, attestationObject: 'a+b' }), null)
  t.is(enrolRecordOf({ ...rec, v: 2 }), null)
  t.is(enrolRecordOf(null), null)
})

test('attestationHash is the account service hash (hex SHA-256 of the bytes)', async (t) => {
  const { attestationHash } = await load()
  t.is(attestationHash(ATT), nodeCrypto.createHash('sha256').update(Buffer.from(ATT, 'base64url')).digest('hex'))
})

function effects (addImpl) {
  const calls = []
  return {
    calls,
    start: async (args) => { calls.push(['start', args]); return { nonce: 'p'.repeat(43) } },
    sign: async (args) => { calls.push(['sign', args]); return { signature: 'e'.repeat(128) } },
    add: async (args) => { calls.push(['add', args]); return addImpl ? addImpl() : { added: true } },
    drop: async () => { calls.push('drop') }
  }
}

test('runEnrolment: signs the hash at phase passkey, sends it, drops the record', async (t) => {
  const { runEnrolment, attestationHash } = await load()
  const fx = effects()
  t.is(await runEnrolment({ member: M, username: 'ana', enrolment: ENROL, ...fx }), 'stored')
  t.alike(fx.calls, [
    ['start', { member: M }],
    ['sign', { nonce: 'p'.repeat(43), username: 'ana', sub: attestationHash(ATT) }],
    ['add', { member: M, nonce: 'p'.repeat(43), signature: 'e'.repeat(128), credentialId: 'Q1JFRA', attestationObject: ATT }],
    'drop'
  ])
  const none = effects()
  t.is(await runEnrolment({ member: M, username: 'ana', enrolment: null, ...none }), 'stored', 'nothing to send')
  t.alike(none.calls, [])
})

test('runEnrolment: a final refusal drops the record; anything else keeps it for later', async (t) => {
  const { runEnrolment } = await load()
  for (const code of ['passkey-registrada', 'vinculo-antigo', 'passkey-invalida', 'conta-excluida']) {
    const fx = effects(() => { throw Object.assign(new Error(code), { code }) })
    t.is(await runEnrolment({ member: M, username: 'ana', enrolment: ENROL, ...fx }), 'refused', code)
    t.ok(fx.calls.includes('drop'), code + ' drops')
  }
  for (const code of ['indisponivel', 'expirado', 'assinatura-invalida', 'nao-vinculado', undefined]) {
    const fx = effects(() => { throw Object.assign(new Error('x'), { code }) })
    t.is(await runEnrolment({ member: M, username: 'ana', enrolment: ENROL, ...fx }), 'later', String(code))
    t.absent(fx.calls.includes('drop'), String(code) + ' keeps it')
  }
  const fx = effects()
  t.is(await runEnrolment({ member: 'zz', username: 'ana', enrolment: ENROL, ...fx }), 'later')
  t.alike(fx.calls, [], 'a bad member sends nothing')
})

test('enrolWith: reads the handle record and signs through account.sign', async (t) => {
  const { enrolWith } = await load()
  const requests = []
  let dropped = false
  const passkey = { enrolment: async () => ENROL, dropEnrolment: async () => { dropped = true } }
  const request = async (method, params) => { requests.push([method, params]); return { signature: 'e'.repeat(128) } }
  const out = await enrolWith({ passkey, request, member: M, username: 'ana', start: async () => ({ nonce: 'p'.repeat(43) }), add: async () => ({ added: true }) })
  t.is(out, 'stored')
  t.is(requests[0][0], 'account.sign')
  t.is(requests[0][1].phase, 'passkey')
  t.ok(dropped)
  t.is(await enrolWith({ passkey: null, request, member: M, username: 'ana' }), 'stored', 'no passkey handle (native node or serve)')
})
