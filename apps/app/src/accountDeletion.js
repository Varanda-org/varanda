// Excluir conta, the pure part (no React, no react-native, no Node
// built-ins): the typed confirmation, the request sequence and the local
// receipt that lets the app confirm, after the device was wiped, when the
// diary left the network. The screen is src/screens/ExcluirConta.js; the
// account service side is apps/cli/lib/account/delete-routes.js.

const KEY_RE = /^[0-9a-f]{64}$/

// The time the association promises for the diary to leave its seeders
// (the operator's `mod apply` signs the block). Same number as the Termos.
export const DELETE_DAYS = 7

export const DELETED_TEXT = 'Esta conta foi excluída.'
export const PENDING_TEXT = 'O serviço de conta já apagou o vínculo com o Google, o registro de idade, os aceites dos Termos, os avisos no aparelho, as marcações de visto, os convites, as passkeys extras e o código de recuperação. O diário sai dos semeadores da associação em até ' + DELETE_DAYS + ' dias.'
export const DONE_TEXT = 'Exclusão concluída: o diário saiu dos semeadores da associação.'
export const PASSKEY_TEXT = 'A passkey continua no gerenciador de senhas do aparelho e o Varanda não consegue apagá-la. Para apagar: no iPhone, app Senhas (ou Ajustes > Senhas); no Android, Gerenciador de senhas do Google; no computador, o gerenciador do navegador. Procure pelo endereço do Varanda.'

// The person types the @nome (with or without '@', any case, spaces around).
export function typedMatches (typed, username) {
  if (typeof typed !== 'string' || typeof username !== 'string' || username === '') return false
  const t = typed.trim().toLowerCase()
  return (t.startsWith('@') ? t.slice(1) : t) === username
}

// accountStatus answer -> 'pendente' | 'concluida' | null.
export function deletedOf (status) {
  if (status === null || typeof status !== 'object') return null
  return status.deleted === 'pendente' || status.deleted === 'concluida' ? status.deleted : null
}

// The receipt kept on the device after the wipe: only the public key and
// the date, never a secret. -> the receipt or null.
export function receiptOf (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const keys = Object.keys(value)
  if (keys.length !== 3 || value.v !== 1 || typeof value.member !== 'string' || !KEY_RE.test(value.member)) return null
  if (typeof value.at !== 'string' || Number.isNaN(Date.parse(value.at)) || new Date(value.at).toISOString() !== value.at) return null
  return { v: 1, member: value.member, at: value.at }
}

export function newReceipt (member, nowMs) {
  return { v: 1, member, at: new Date(nowMs).toISOString() }
}

function fail (message, code) {
  const err = new Error(message)
  if (code) err.code = code
  return err
}

// The whole request, with every effect injected:
//   confirm()                  the fresh passkey check (node.passkey.confirm)
//   sign({ nonce, username })  account.sign at phase 'delete'
//   finish({ nonce, signature }) the account service's finish
//   status()                   accountStatus of the member, after an
//                              uncertain finish
//   beforeFinish()             e.g. switching push off while the key can sign
// `prepared` is the start answer ({ nonce, username }) read when the screen
// opened. confirm() runs before any await, so on the web it stays inside the
// tap (Safari's user activation). -> { deleted } once the service holds the
// deletion; the caller then saves the receipt and wipes the device.
export async function requestDeletion ({ prepared, typed, confirm, sign, finish, status, beforeFinish = async () => {} }) {
  if (prepared === null || typeof prepared !== 'object' || typeof prepared.nonce !== 'string') throw fail('pedido expirado: tente de novo', 'expirado')
  if (!typedMatches(typed, prepared.username)) throw fail('digite o seu @nome para confirmar')
  await confirm()
  try {
    await beforeFinish()
  } catch {}
  const { signature } = await sign({ nonce: prepared.nonce, username: prepared.username })
  try {
    return await finish({ nonce: prepared.nonce, signature })
  } catch (err) {
    // An unknown outcome is settled by reading the status, never by sending
    // the request again.
    if (err && (err.uncertain === true || err.code === 'conta-excluida')) {
      let st = null
      try { st = await status() } catch {}
      const deleted = deletedOf(st)
      if (deleted !== null) return { deleted }
    }
    throw err
  }
}
