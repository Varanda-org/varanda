'use strict'

// The recovery flow (src/recovery.js). ES module loaded through import(); the
// account calls and the node's request are stubs, nothing touches the network.
const test = require('brittle')

const load = () => import('../src/recovery.js')
const M = 'ab'.repeat(32)
const LOOKUP = 'cd'.repeat(32)
const NONCE = 'n'.repeat(43)
const SIG = 'ef'.repeat(64)
const BLOB = { v: 1, kind: 'code', nonce: '0a'.repeat(24), ciphertext: '1b'.repeat(82) }

function fakes ({ put, remove, list, start, sign } = {}) {
  const log = []
  const account = {
    recoveryStart: async (args) => { log.push(['start', args]); return start ? start() : { nonce: NONCE } },
    recoveryPut: async (args) => { log.push(['put', args]); return put ? put() : { ok: true, changed: true } },
    recoveryRemove: async (args) => { log.push(['remove', args]); return remove ? remove() : { ok: true, changed: true } },
    recoveryList: async (args) => { log.push(['list', args]); return list ? list() : [] }
  }
  const request = async (method, params) => { log.push([method, params]); return sign ? sign() : { signature: SIG } }
  return { account, request, log }
}

test('registerEntry: start, recovery.sign put with the blob, then put', async (t) => {
  const { registerEntry } = await load()
  const { account, request, log } = fakes()
  t.alike(await registerEntry({ request, account, member: M, kind: 'code', lookupId: LOOKUP, blob: BLOB }), { ok: true, changed: true })
  t.alike(log, [
    ['start', { member: M }],
    ['recovery.sign', { action: 'put', nonce: NONCE, kind: 'code', lookupId: LOOKUP, blob: BLOB }],
    ['put', { member: M, nonce: NONCE, signature: SIG, kind: 'code', lookupId: LOOKUP, blob: BLOB }]
  ])
  t.absent(Object.hasOwn(log[1][1], 'blobHash'), 'the app never hashes: the node does')
})

test('removeEntry and listEntries: the same three steps, no blob', async (t) => {
  const { removeEntry, listEntries } = await load()
  const entries = [{ lookupId: LOOKUP, kind: 'passkey', createdAt: '2026-11-06T12:00:00.000Z' }]
  const { account, request, log } = fakes({ list: () => entries })
  await removeEntry({ request, account, member: M, kind: 'passkey', lookupId: LOOKUP })
  t.alike(await listEntries({ request, account, member: M }), entries)
  t.alike(log, [
    ['start', { member: M }],
    ['recovery.sign', { action: 'remove', nonce: NONCE, kind: 'passkey', lookupId: LOOKUP }],
    ['remove', { member: M, nonce: NONCE, signature: SIG, kind: 'passkey', lookupId: LOOKUP }],
    ['start', { member: M }],
    ['recovery.sign', { action: 'list', nonce: NONCE }],
    ['list', { member: M, nonce: NONCE, signature: SIG }]
  ])
})

test('an uncertain put or remove propagates as is and is never retried', async (t) => {
  const { registerEntry, removeEntry } = await load()
  const unknown = () => { const e = new Error('serviço indisponível'); e.code = 'indisponivel'; e.uncertain = true; throw e }
  const { account, request, log } = fakes({ put: unknown, remove: unknown })
  try { await registerEntry({ request, account, member: M, kind: 'code', lookupId: LOOKUP, blob: BLOB }); t.fail() } catch (e) { t.is(e.uncertain, true) }
  try { await removeEntry({ request, account, member: M, kind: 'code', lookupId: LOOKUP }); t.fail() } catch (e) { t.is(e.uncertain, true) }
  t.is(log.filter(([k]) => k === 'put').length, 1)
  t.is(log.filter(([k]) => k === 'remove').length, 1)
  t.is(log.filter(([k]) => k === 'start').length, 2, 'no second nonce either')
})

test('a refused start or sign stops before any write', async (t) => {
  const { registerEntry } = await load()
  const refuse = () => { const e = new Error('identidade bloqueada: entre com a passkey'); throw e }
  for (const opts of [{ start: refuse }, { sign: refuse }]) {
    const { account, request, log } = fakes(opts)
    await t.exception(registerEntry({ request, account, member: M, kind: 'code', lookupId: LOOKUP, blob: BLOB }))
    t.absent(log.some(([k]) => k === 'put'))
  }
})

test('fixed texts: the expected sentences, pt-BR, no em dash', async (t) => {
  const r = await load()
  t.is(r.LOSS_TEXT, 'Sem passkey e sem código de recuperação, a conta não pode ser recuperada. Uma passkey adicionada e o código precisam da internet para entrar; a passkey original não.')
  t.is(r.SERVICE_DOWN_TEXT, 'não foi possível conferir a passkey com o serviço de conta; tente de novo')
  t.is(r.NOT_FOUND_TEXT, 'esta passkey ou este código não está ligado a uma conta neste endereço')
  const { toError } = await import('../src/account.js')
  t.is(toError('nao-encontrado', undefined, { 'nao-encontrado': r.NOT_FOUND_TEXT }).message, r.NOT_FOUND_TEXT)
  t.ok(/adicionar a nova/.test(r.CHANGE_TEXT) && /apagar a antiga/.test(r.CHANGE_TEXT) && /também sem internet, em qualquer aparelho/.test(r.CHANGE_TEXT) && /precisam da internet/.test(r.CHANGE_TEXT) && /não consegue invalidá-la/.test(r.CHANGE_TEXT))
  t.ok(/só agora/.test(r.CODE_ONCE_TEXT))
  t.ok(/fica com a conta para sempre/.test(r.CODE_ONCE_TEXT) && /não tira esse acesso/.test(r.CODE_ONCE_TEXT) && /crie uma conta nova/.test(r.CODE_ONCE_TEXT), 'a leaked code cannot be cancelled')
  for (const k of ['CHANGE_TEXT', 'CODE_ONCE_TEXT', 'LOSS_TEXT', 'SERVICE_DOWN_TEXT', 'NOT_FOUND_TEXT']) {
    t.ok(typeof r[k] === 'string' && r[k].length > 0, k)
    t.absent(r[k].includes('\u2014'), k + ' has no em dash')
  }
})
