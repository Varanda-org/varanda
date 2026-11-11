// Excluir conta, the pure part (no React, no react-native, no Node
// built-ins): the typed confirmation, the request sequence and the local
// receipt that lets the app confirm, after the device was wiped, when the
// diary left the network. The screen is src/screens/ExcluirConta.js; the
// account service side is apps/cli/lib/account/delete-routes.js.

const KEY_RE = /^[0-9a-f]{64}$/

// The time the association promises for the diary to leave its seeders
// (the operator's `mod apply` signs the block). Same number as the Termos.
export const DELETE_DAYS = 7
// The wait of a deletion asked without a passkey the account service can
// verify (accounts from before the passkey was registered there, or a
// passkey that is not the registered one). Same number as the Termos and
// apps/cli/lib/account/delete-routes.js WAIT_MS.
export const WAIT_DAYS = 7

export const DELETED_TEXT = 'Esta conta foi excluída.'
export const PENDING_TEXT = 'O serviço de conta já apagou o registro de idade, os aceites dos Termos, os avisos no aparelho, as marcações de visto, os convites, as passkeys extras e o código de recuperação. O número do celular, se houver, fica lacrado por até 180 dias e então é apagado. O diário sai dos semeadores da associação em até ' + DELETE_DAYS + ' dias.'
export const DONE_TEXT = 'Exclusão concluída: o diário saiu dos semeadores da associação.'
export const PASSKEY_TEXT = 'A passkey continua no gerenciador de senhas do aparelho e o Varanda não consegue apagá-la. Para apagar: no iPhone, app Senhas (ou Ajustes > Senhas); no Android, Gerenciador de senhas do Google; no computador, o gerenciador do navegador. Procure pelo endereço do Varanda.'

// The person types the @nome (with or without '@', any case, spaces around).
export function typedMatches (typed, username) {
  if (typeof typed !== 'string' || typeof username !== 'string' || username === '') return false
  const t = typed.trim().toLowerCase()
  return (t.startsWith('@') ? t.slice(1) : t) === username
}

// accountStatus answer -> the ISO date of a deletion waiting for it, or null.
export function scheduledOf (status) {
  if (status === null || typeof status !== 'object') return null
  const d = status.scheduledDeletion
  return typeof d === 'string' && !Number.isNaN(Date.parse(d)) ? d : null
}

// The start answer -> 'agora' when the service holds a passkey key to verify
// (the deletion runs at once), else 'agendada' (it waits WAIT_DAYS). The
// ceremony can still end 'agendada' when the device's passkey is not the
// registered one.
export function deletionMode (prepared) {
  return prepared && Array.isArray(prepared.passkeys) && prepared.passkeys.length > 0 ? 'agora' : 'agendada'
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
//   confirm({ challenge })     the fresh passkey check over the nonce
//                              (node.passkey.confirm) -> { assertion }
//   sign({ nonce, username })  account.sign at phase 'delete'
//   finish({ nonce, signature, assertion?, wait? }) the account service's finish
//   status()                   accountStatus of the member, after an
//                              uncertain finish
//   beforeFinish()             e.g. switching push off while the key can sign
//                              (only when the deletion runs now: a waiting
//                              one keeps the push notice of its schedule)
// `prepared` is the start answer ({ nonce, username, passkeys }) read when
// the screen opened. confirm() runs before any await, so on the web it stays
// inside the tap (Safari's user activation). With an assertion of a passkey
// the service holds, -> { deleted }: the caller then saves the receipt and
// wipes the device. Otherwise -> { scheduled }: nothing is wiped, and the
// account keeps working until that date.
export async function requestDeletion ({ prepared, typed, confirm, sign, finish, status, beforeFinish = async () => {} }) {
  if (prepared === null || typeof prepared !== 'object' || typeof prepared.nonce !== 'string') throw fail('pedido expirado: tente de novo', 'expirado')
  if (!typedMatches(typed, prepared.username)) throw fail('digite o seu @nome para confirmar')
  const checked = await confirm({ challenge: prepared.nonce })
  const assertion = checked && checked.assertion ? checked.assertion : null
  const stored = Array.isArray(prepared.passkeys) ? prepared.passkeys : []
  const now = assertion !== null && stored.includes(assertion.credentialId)
  if (now) {
    try {
      await beforeFinish()
    } catch {}
  }
  const { signature } = await sign({ nonce: prepared.nonce, username: prepared.username })
  try {
    return await finish(now ? { nonce: prepared.nonce, signature, assertion } : { nonce: prepared.nonce, signature, wait: true })
  } catch (err) {
    // An unknown outcome is settled by reading the status, never by sending
    // the request again.
    if (err && (err.uncertain === true || err.code === 'conta-excluida')) {
      let st = null
      try { st = await status() } catch {}
      const deleted = deletedOf(st)
      if (deleted !== null) return { deleted }
      const scheduled = scheduledOf(st)
      if (scheduled !== null) return { scheduled }
    }
    throw err
  }
}

// Cancelling a waiting deletion, every effect injected: start() ->
// { nonce, username }, sign({ nonce, username }) -> { signature }
// (account.sign at phase 'cancel'), finish({ nonce, signature }) ->
// { cancelled }.
export async function cancelDeletion ({ start, sign, finish }) {
  const { nonce, username } = await start()
  const { signature } = await sign({ nonce, username })
  return finish({ nonce, signature })
}

// 'dd/mm/aaaa' of an ISO date, in Brasília time (UTC-3, no DST), as the
// schedule is told to the person.
export function scheduleDate (iso) {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return ''
  const d = new Date(ms - 3 * 3600 * 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return pad(d.getUTCDate()) + '/' + pad(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear()
}

export function scheduledText (iso) {
  return 'A exclusão da conta está agendada para ' + scheduleDate(iso) + '. Até lá a conta continua funcionando, e você pode cancelar de qualquer aparelho.'
}

export const WAIT_TEXT = 'O serviço de conta não tem a passkey desta conta registrada (contas criadas antes desse registro, ou outra passkey). Por segurança, a exclusão fica agendada por ' + WAIT_DAYS + ' dias: todos os seus aparelhos mostram o pedido, e você pode cancelar até lá. Depois disso, ela segue como uma exclusão imediata.'
