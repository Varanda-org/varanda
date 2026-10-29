'use strict'

// The hosted age gate (src/age.js). ES module loaded through import().
const test = require('brittle')

const load = () => import('../src/age.js')

test('constants', async (t) => {
  const { MIN_AGE, RETURN_PARAM, AGE_STATES } = await load()
  t.is(MIN_AGE, 16)
  t.is(RETURN_PARAM, 'idade')
  t.alike([...AGE_STATES], ['verificado', 'pendente', 'recusado', 'inconclusivo', 'expirado', 'nenhum'])
  t.ok(Object.isFrozen(AGE_STATES))
})

test('parseReturnAge: only ?idade=volta, provider params ignored', async (t) => {
  const { parseReturnAge } = await load()
  t.is(parseReturnAge('?idade=volta'), true)
  t.is(parseReturnAge('?idade=volta&verificationSessionId=abc&status=Declined'), true)
  t.is(parseReturnAge('?x=1&idade=volta'), true)
  t.is(parseReturnAge('?status=Approved'), false)
  t.is(parseReturnAge('?verificationSessionId=abc&status=Approved'), false)
  t.is(parseReturnAge('?idade=ok'), false)
  t.is(parseReturnAge('?idade=Volta'), false)
  t.is(parseReturnAge('%%%'), false)
  t.is(parseReturnAge(''), false)
  for (const bad of [undefined, null, 5, {}, []]) t.is(parseReturnAge(bad), false, String(bad))
  const evil = { toString () { throw new Error('x') } }
  t.is(parseReturnAge(evil), false)
})

test('ageGate: off only when not hosted or the policy says required false', async (t) => {
  const { ageGate, AGE_STATES } = await load()
  const states = [undefined, ...AGE_STATES, 'outro', null]
  for (const hosted of [false, undefined, 'true', 1]) {
    for (const state of states) {
      t.is(ageGate({ hosted, policy: { required: true }, state }), 'off', 'hosted ' + String(hosted))
    }
  }
  for (const state of states) t.is(ageGate({ hosted: true, policy: { required: false }, state }), 'off')
  t.is(ageGate(), 'off')
})

test('ageGate: fails closed on any other policy', async (t) => {
  const { ageGate } = await load()
  const policies = [undefined, null, {}, { required: 'false' }, { required: 0 }, { required: true }, [], 'off', false]
  for (const policy of policies) {
    const p = JSON.stringify(policy) || String(policy)
    t.is(ageGate({ hosted: true, policy, state: undefined }), 'loading', p)
    t.is(ageGate({ hosted: true, policy, state: 'verificado' }), 'ok', p)
    for (const state of ['pendente', 'recusado', 'inconclusivo', 'expirado', 'nenhum', 'outro', null, '', true]) {
      t.is(ageGate({ hosted: true, policy, state }), 'needed', p + ' ' + String(state))
    }
  }
})

test('ageGate: only the exact string verificado opens it', async (t) => {
  const { ageGate } = await load()
  for (const state of ['Verificado', ' verificado', 'verificado ', ['verificado'], { state: 'verificado' }, 'volta', 'Approved']) {
    t.not(ageGate({ hosted: true, policy: null, state }), 'ok', JSON.stringify(state))
  }
})

test('ageBlocking', async (t) => {
  const { ageBlocking } = await load()
  t.is(ageBlocking('loading'), true)
  t.is(ageBlocking('needed'), true)
  t.is(ageBlocking('ok'), false)
  t.is(ageBlocking('off'), false)
})

test('AGE_TEXTS: every state, plain words, no em dash', async (t) => {
  const { AGE_TEXTS, AGE_STATES } = await load()
  t.alike(Object.keys(AGE_TEXTS).sort(), [...AGE_STATES].sort())
  for (const s of AGE_STATES) t.is(typeof AGE_TEXTS[s], 'string', s)
  t.is(AGE_TEXTS.nenhum, '')
  t.is(AGE_TEXTS.recusado, 'A Varanda é só para quem tem 16 anos ou mais. Não foi possível liberar sua conta.')
  t.is(AGE_TEXTS.inconclusivo, 'Não deu para confirmar sua idade só pelo rosto. Tente de novo com um documento.')
  t.is(AGE_TEXTS.pendente, 'A verificação ainda está em análise. Confira de novo em instantes.')
  t.is(AGE_TEXTS.expirado, 'A verificação venceu. Comece de novo.')
  t.is(AGE_TEXTS.verificado, 'Idade confirmada.')
  const technical = /(^|[^\p{L}])(semeador|chave|certificado|nó)(?![\p{L}])/iu
  for (const text of Object.values(AGE_TEXTS)) {
    t.absent(text.includes(String.fromCharCode(0x2014)), text)
    t.absent(technical.test(text), text)
  }
})
