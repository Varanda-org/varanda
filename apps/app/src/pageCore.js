// Pages on a core node (no passkey): the node's Ed25519 delegate (the actor,
// page.register, docs/rpc.md 5.87) acts for the diary. Before its first page
// action the delegate accepts the current Terms with the account service
// (pagesTerms: op { version, diary }, the body carries the termsSignature
// page.sign answers). Both run once per account origin and node epoch (a
// new connection may be another node); a failure is forgotten so the next
// try starts again. Nothing is resent on its own: page.register is safe to
// repeat, the terms step is a read with a fresh nonce.

import { LEGAL_VERSION } from './legal.js'
import { pagesOrigin, pagesTerms } from './pages.js'

const KEY_RE = /^[0-9a-f]{64}$/
const ready = new Map()

export const ACTOR_NOTE = 'convites chegam por esta chave'

async function setUp (node, origin) {
  const info = await node.request('node.info', {})
  const diary = info && typeof info.publicKey === 'string' ? info.publicKey : ''
  if (!KEY_RE.test(diary)) throw new Error('identidade não encontrada')
  const reg = await node.request('page.register', {})
  const actor = reg && typeof reg.actor === 'string' ? reg.actor : ''
  if (!KEY_RE.test(actor)) throw new Error('Serviço indisponível')
  await pagesTerms(node, { member: actor, op: { version: LEGAL_VERSION, diary } })
  return { actor, diary, origin }
}

// -> { actor, diary, origin } once the delegate can act, or throws.
export function coreActor (node) {
  const origin = pagesOrigin(node)
  if (origin === undefined || !node || typeof node.request !== 'function') return Promise.reject(new Error('Serviço indisponível'))
  const id = origin + '|' + String(node.epoch)
  const known = ready.get(id)
  if (known) return known
  const pending = setUp(node, origin)
  ready.set(id, pending)
  pending.catch(() => { if (ready.get(id) === pending) ready.delete(id) })
  return pending
}

// Tests only.
export function forgetCoreActors () {
  ready.clear()
}
