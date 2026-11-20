// The key of an extra passkey at the account service, the pure part (no
// React, no react-native, no Node built-ins): after a passkey added in
// Ajustes > Passkeys e recuperação is registered as a recovery entry, the
// passkey that unlocked this session (its key already stored) vouches for
// it with a fresh assertion over the service's nonce, so the new passkey
// also confirms Excluir conta at once (apps/cli/lib/account/passkey-routes.js,
// docs/protocol.md "Account deletion"). Only the attestation object, the
// credential ids and the assertion go to the service.
//
// Two steps, so the ceremony can run inside a press when the browser needs
// a fresh user activation for it: prepareExtraKey (no ceremony) asks the
// service which credentials it holds, and confirmExtraKey calls confirm()
// before any await. Nothing here repeats a request: 'later' only means the
// person can try again.
import { attestationHash } from './passkeyEnrol.js'

export const CONFIRM_TEXT = 'Confirme com a passkey deste aparelho para que a passkey nova também confirme a exclusão da conta.'
export const STORED_TEXT = 'A passkey nova também confirma a exclusão da conta.'
export const NOT_STORED_TEXT = 'A passkey nova já abre a conta. Uma exclusão confirmada só com ela fica agendada por 7 dias.'

const KEY_RE = /^[0-9a-f]{64}$/
const ID_RE = /^[A-Za-z0-9_-]{1,1364}$/
const ATTESTATION_RE = /^[A-Za-z0-9_-]{1,2731}$/

// Answers after which sending the same again cannot help.
const REFUSED = new Set(['passkey-invalida', 'pedido-invalido', 'limite-recuperacao', 'passkey-registrada', 'conta-excluida', 'nao-vinculado'])

// An HTTP 429 ('pedido-invalido' at the account service) passes with time.
function outcomeOf (err) {
  if (err && err.status === 429) return 'later'
  return err && REFUSED.has(err.code) ? 'refused' : 'later'
}

// The new passkey as the add flow returned it -> { credentialId,
// attestationObject, lookupId } or null (a creation without an attestation
// object, or a code recovery's passkey, has no key to send).
export function createdKeyOf (entry) {
  if (entry === null || typeof entry !== 'object') return null
  const { credentialId, attestationObject, lookupId } = entry
  if (typeof credentialId !== 'string' || !ID_RE.test(credentialId)) return null
  if (typeof attestationObject !== 'string' || !ATTESTATION_RE.test(attestationObject)) return null
  if (typeof lookupId !== 'string' || !KEY_RE.test(lookupId)) return null
  return { credentialId, attestationObject, lookupId }
}

// The entry the screen registers for a new passkey, from an addPasskey or
// complete() result. The attestation object rides along (public data) so
// createdKeyOf can send the new passkey's key once the entry is stored.
export function passkeyEntryOf ({ member, change, result }) {
  const r = result !== null && typeof result === 'object' ? result : {}
  return {
    member,
    kind: 'passkey',
    lookupId: r.lookupId,
    blob: r.blob,
    credentialId: r.credentialId,
    userId: r.userId,
    change: change === true,
    attestationObject: typeof r.attestationObject === 'string' ? r.attestationObject : null
  }
}

// No ceremony. `created` is createdKeyOf's answer; `currentCredentialId`
// the passkey that unlocked this session (the handle's status). start({
// member, list: true }) -> { nonce, passkeys, username } (passkeys null from
// an older service). -> { outcome: 'ready', nonce, username, passkeys }, or
// { outcome: 'skipped' } (nothing to send, an older service, or a current
// passkey whose key the service does not hold: no prompt), or { outcome:
// 'refused' | 'later' }.
export async function prepareExtraKey ({ member, created, currentCredentialId, start }) {
  if (typeof member !== 'string' || !KEY_RE.test(member) || created === null || typeof created !== 'object') return { outcome: 'skipped' }
  if (typeof currentCredentialId !== 'string' || !ID_RE.test(currentCredentialId) || currentCredentialId === created.credentialId) return { outcome: 'skipped' }
  let st
  try {
    st = await start({ member, list: true })
  } catch (err) {
    return { outcome: outcomeOf(err) }
  }
  if (!st || typeof st.nonce !== 'string' || !Array.isArray(st.passkeys) || typeof st.username !== 'string') return { outcome: 'skipped' }
  if (!st.passkeys.includes(currentCredentialId)) return { outcome: 'skipped' }
  return { outcome: 'ready', nonce: st.nonce, username: st.username, passkeys: st.passkeys.slice() }
}

// The ceremony and the add. confirm({ challenge }) is called first, before
// any await (the handle's confirm: the bound passkey only) -> { assertion };
// sign({ nonce, username, sub }) is account.sign at phase 'passkey';
// add({ member, nonce, signature, credentialId, attestationObject,
// assertion, lookupId }) -> { added }. -> 'stored' | 'skipped' | 'refused' |
// 'later'.
export function confirmExtraKey ({ member, created, prepared, confirm, sign, add }) {
  if (prepared === null || typeof prepared !== 'object' || prepared.outcome !== 'ready' || created === null || typeof created !== 'object') return Promise.resolve('skipped')
  let checking
  try {
    checking = confirm({ challenge: prepared.nonce })
  } catch (err) {
    checking = Promise.reject(err)
  }
  return (async () => {
    let assertion
    try {
      const checked = await checking
      assertion = checked && checked.assertion ? checked.assertion : null
    } catch {
      return 'later'
    }
    if (assertion === null || typeof assertion !== 'object') return 'later'
    if (!prepared.passkeys.includes(assertion.credentialId)) return 'skipped'
    let signature
    try {
      ;({ signature } = await sign({ nonce: prepared.nonce, username: prepared.username, sub: attestationHash(created.attestationObject) }))
    } catch {
      return 'later'
    }
    try {
      await add({ member, nonce: prepared.nonce, signature, credentialId: created.credentialId, attestationObject: created.attestationObject, assertion, lookupId: created.lookupId })
    } catch (err) {
      return outcomeOf(err)
    }
    return 'stored'
  })()
}

// Both steps chained. -> 'stored' | 'skipped' | 'refused' | 'later'.
export async function registerExtraKey ({ member, created, currentCredentialId, start, confirm, sign, add }) {
  const prepared = await prepareExtraKey({ member, created, currentCredentialId, start })
  if (prepared.outcome !== 'ready') return prepared.outcome
  return confirmExtraKey({ member, created, prepared, confirm, sign, add })
}

// The sentence for an outcome: only 'stored' says the new passkey confirms
// a deletion at once.
export function outcomeText (outcome) {
  return outcome === 'stored' ? STORED_TEXT : NOT_STORED_TEXT
}
