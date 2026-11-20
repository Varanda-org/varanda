// The hosted welcome card ('Entrar') must not open a new account while the
// network is full: there is no 'Criar passkey', and the phone button only
// signs in. Signing in with an existing passkey, another passkey or a
// recovery code stays offered, because none of those adds a member.
// Creation waits while the answer is still pending instead of racing the
// read: the passkey ceremony has to start synchronously in the click, so
// that click cannot await anything. A failed read (null) counts as open,
// because the account service still refuses on its own later. A device
// whose passkey is already known (createFirst false) never sees the notice.
// The answer belongs to one installation (origin), so a switch has to ask
// again.

// Said before any attempt; a refused attempt keeps toError('lista-de-espera').
export const FULL_TEXT = 'A Varanda está cheia por enquanto e não está aceitando contas novas. Volte daqui a alguns dias para criar a sua. Se você já tem conta, toque em Entrar.'

export function admissionOffer ({ hosted, admission, createFirst, phoneOk }) {
  const creating = !!createFirst
  const phone = !!phoneOk
  if (hosted !== true) {
    return {
      full: false,
      waiting: false,
      create: creating,
      phoneCreate: creating && phone,
      phoneSignin: phone && !creating
    }
  }
  const closed = admission !== null && typeof admission === 'object' && admission.open === false
  const waiting = creating && admission === undefined
  const create = creating && !waiting && !closed
  return {
    full: creating && closed,
    waiting,
    create,
    phoneCreate: create && phone,
    phoneSignin: phone && !create
  }
}

export function admissionFor (entry, origin) {
  if (entry === null || typeof entry !== 'object') return undefined
  if (entry.origin !== origin) return undefined
  return entry.answer
}
