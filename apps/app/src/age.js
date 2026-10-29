// Hosted age check (minimum 16). Pure ES module: imports nothing, so Node's
// import() tests every branch. Nothing read from the URL or from storage can
// open the gate: only a 'verificado' state that the account service answered
// does, and the caller is the one that asks it.

export const MIN_AGE = 16
export const RETURN_PARAM = 'idade'
export const AGE_STATES = Object.freeze(['verificado', 'pendente', 'recusado', 'inconclusivo', 'expirado', 'nenhum'])

// ?idade=volta: the browser came back from the verification provider, so the
// screen should ask the service for the result. The params the provider
// appends (verificationSessionId, status) are untrusted and never read.
export function parseReturnAge (search) {
  if (typeof search !== 'string') return false
  try {
    return new URLSearchParams(search).get(RETURN_PARAM) === 'volta'
  } catch {
    return false
  }
}

const isPlainObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x)

// Fails closed: a policy not read yet (undefined), a failed read (null) or
// any unexpected shape counts as required, so a slow or broken service never
// lets anyone past. 'loading' must block exactly like 'needed'.
export function ageGate ({ hosted, policy, state } = {}) {
  if (hosted !== true) return 'off'
  if (isPlainObject(policy) && policy.required === false) return 'off'
  if (state === undefined) return 'loading'
  if (state === 'verificado') return 'ok'
  return 'needed'
}

export function ageBlocking (gate) {
  return gate === 'loading' || gate === 'needed'
}

export const AGE_TEXTS = Object.freeze({
  verificado: 'Idade confirmada.',
  pendente: 'A verificação ainda está em análise. Confira de novo em instantes.',
  recusado: 'A Varanda é só para quem tem 16 anos ou mais. Não foi possível liberar sua conta.',
  inconclusivo: 'Não deu para confirmar sua idade só pelo rosto. Tente de novo com um documento.',
  expirado: 'A verificação venceu. Comece de novo.',
  nenhum: ''
})
