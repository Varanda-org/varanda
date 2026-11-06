'use strict'

// Excluir conta, the pure part (src/accountDeletion.js): the typed
// confirmation, the receipt and the request sequence with every effect
// injected. No network, no React.
const test = require('brittle')

const load = () => import('../src/accountDeletion.js')
const M = 'ab'.repeat(32)
const CRED = 'Q1JFRA'
const ASSERTION = { credentialId: CRED, clientDataJSON: 'e30', authenticatorData: 'AAAA', signature: 'AQID' }

test('typedMatches: the @nome with or without @, any case, spaces around', async (t) => {
  const { typedMatches } = await load()
  t.ok(typedMatches('ana', 'ana'))
  t.ok(typedMatches(' @Ana ', 'ana'))
  t.absent(typedMatches('an', 'ana'))
  t.absent(typedMatches('@@ana', 'ana'))
  t.absent(typedMatches('', 'ana'))
  t.absent(typedMatches('ana', ''))
  t.absent(typedMatches(null, 'ana'))
})

test('deletedOf and receiptOf accept only their exact shapes', async (t) => {
  const { deletedOf, receiptOf, newReceipt } = await load()
  t.is(deletedOf({ linked: false, deleted: 'pendente' }), 'pendente')
  t.is(deletedOf({ linked: false, deleted: 'concluida' }), 'concluida')
  t.is(deletedOf({ linked: true }), null)
  t.is(deletedOf({ deleted: 'talvez' }), null)
  t.is(deletedOf(null), null)
  const r = newReceipt(M, Date.parse('2026-11-06T12:00:00.000Z'))
  t.alike(r, { v: 1, member: M, at: '2026-11-06T12:00:00.000Z' })
  t.alike(receiptOf(r), r)
  t.is(receiptOf({ ...r, secret: 'x' }), null, 'nothing more than key and date')
  t.is(receiptOf({ ...r, member: 'AB'.repeat(32) }), null)
  t.is(receiptOf({ ...r, at: '2026-11-06' }), null)
  t.is(receiptOf([]), null)
})

function effects (overrides = {}) {
  const calls = []
  const fx = {
    confirm: (args) => { calls.push(['confirm', args]); return Promise.resolve({ ok: true, assertion: ASSERTION }) },
    beforeFinish: async () => { calls.push('push-off') },
    sign: async (args) => { calls.push(['sign', args]); return { signature: 'f'.repeat(128) } },
    finish: async (args) => { calls.push(['finish', args]); return { deleted: 'pendente' } },
    status: async () => { calls.push('status'); return { linked: false, deleted: 'pendente' } },
    ...overrides
  }
  return { fx, calls }
}

test('requestDeletion: typed name, then the passkey check over the nonce before any await, then push off, sign and finish with the assertion', async (t) => {
  const { requestDeletion } = await load()
  const { fx, calls } = effects()
  const prepared = { nonce: 'n'.repeat(43), username: 'ana', passkeys: [CRED], scheduled: null }
  const p = requestDeletion({ prepared, typed: '@ana', ...fx })
  t.alike(calls, [['confirm', { challenge: prepared.nonce }]], 'the passkey check ran synchronously, inside the tap, over the nonce')
  t.alike(await p, { deleted: 'pendente' })
  t.alike(calls, [['confirm', { challenge: prepared.nonce }], 'push-off', ['sign', { nonce: prepared.nonce, username: 'ana' }], ['finish', { nonce: prepared.nonce, signature: 'f'.repeat(128), assertion: ASSERTION }]])
})

test('requestDeletion: without a stored passkey (or with another one) it asks to wait and keeps push on', async (t) => {
  const { requestDeletion, deletionMode } = await load()
  const at = '2026-11-13T12:00:00.000Z'
  for (const passkeys of [[], ['T1RIRVI']]) {
    const { fx, calls } = effects({ finish: async (args) => { calls.push(['finish', args]); return { scheduled: at } } })
    const prepared = { nonce: 'n'.repeat(43), username: 'ana', passkeys, scheduled: null }
    t.is(deletionMode(prepared), passkeys.length === 0 ? 'agendada' : 'agora')
    t.alike(await requestDeletion({ prepared, typed: 'ana', ...fx }), { scheduled: at })
    t.absent(calls.includes('push-off'), 'a waiting deletion keeps the push notice of its schedule')
    t.alike(calls[calls.length - 1], ['finish', { nonce: prepared.nonce, signature: 'f'.repeat(128), wait: true }], 'no assertion the service cannot verify')
  }
})

test('cancelDeletion, scheduledOf and the date in Brasília time', async (t) => {
  const { cancelDeletion, scheduledOf, scheduleDate, scheduledText } = await load()
  const calls = []
  const out = await cancelDeletion({
    start: async () => { calls.push('start'); return { nonce: 'c'.repeat(43), username: 'ana' } },
    sign: async (args) => { calls.push(['sign', args]); return { signature: 'e'.repeat(128) } },
    finish: async (args) => { calls.push(['finish', args]); return { cancelled: true } }
  })
  t.alike(out, { cancelled: true })
  t.alike(calls, ['start', ['sign', { nonce: 'c'.repeat(43), username: 'ana' }], ['finish', { nonce: 'c'.repeat(43), signature: 'e'.repeat(128) }]])
  t.is(scheduledOf({ linked: true, scheduledDeletion: '2026-11-13T12:00:00.000Z' }), '2026-11-13T12:00:00.000Z')
  t.is(scheduledOf({ linked: true }), null)
  t.is(scheduledOf({ scheduledDeletion: 'amanhã' }), null)
  t.is(scheduledOf(null), null)
  t.is(scheduleDate('2026-11-14T02:00:00.000Z'), '13/11/2026', 'still the 13th in Brasília')
  t.ok(scheduledText('2026-11-13T12:00:00.000Z').includes('13/11/2026'))
})

test('requestDeletion: a wrong name or a cancelled passkey sends nothing', async (t) => {
  const { requestDeletion } = await load()
  const prepared = { nonce: 'n'.repeat(43), username: 'ana' }
  let { fx, calls } = effects()
  await t.exception(requestDeletion({ prepared, typed: 'bia', ...fx }), /digite o seu @nome/)
  t.alike(calls, [])
  ;({ fx, calls } = effects({ confirm: () => Promise.reject(Object.assign(new Error('entrada com a passkey cancelada'), { code: 'CANCELLED' })) }))
  await t.exception(requestDeletion({ prepared, typed: 'ana', ...fx }), /cancelada/)
  t.alike(calls.filter((c) => Array.isArray(c) && c[0] !== 'confirm'), [], 'nothing signed or sent after a cancel')
  await t.exception(requestDeletion({ prepared: null, typed: 'ana', ...fx }), /expirado/)
})

test('requestDeletion: an uncertain finish is settled by the status, never sent again', async (t) => {
  const { requestDeletion } = await load()
  const prepared = { nonce: 'n'.repeat(43), username: 'ana' }
  const uncertain = Object.assign(new Error('serviço indisponível'), { uncertain: true })
  let { fx, calls } = effects({ finish: async () => { calls.push('finish'); throw uncertain } })
  t.alike(await requestDeletion({ prepared, typed: 'ana', ...fx }), { deleted: 'pendente' })
  t.is(calls.filter((c) => c === 'finish').length, 1, 'one finish only')
  t.ok(calls.includes('status'))
  ;({ fx, calls } = effects({ finish: async () => { throw uncertain }, status: async () => ({ linked: true }) }))
  await t.exception(requestDeletion({ prepared, typed: 'ana', ...fx }), /indisponível/, 'still linked: the error stands')
  ;({ fx, calls } = effects({ beforeFinish: async () => { throw new Error('push') } }))
  t.alike(await requestDeletion({ prepared, typed: 'ana', ...fx }), { deleted: 'pendente' }, 'a failed push switch-off never stops it')
})
