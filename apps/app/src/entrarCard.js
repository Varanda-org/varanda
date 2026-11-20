// The welcome card ('Entrar', src/screens/Identidade.js) speaks plain words.
// Passkey, phone and recovery-code options live behind 'Outras formas de entrar'.
// Pure so Node tests can load it without the screen.

export const CREATE_LABEL = 'Criar minha conta'
export const ENTRAR_LABEL = 'Entrar'
export const HAVE_ACCOUNT_LABEL = 'Já tenho conta'
export const MORE_LABEL = 'Outras formas de entrar'
export const COMPLETE_LABEL = 'Concluir e entrar'
export const COMPLETE_TEXT = 'Falta só confirmar mais uma vez. Toque em Concluir e entrar.'
export const CANCELLED_TEXT = 'Você fechou a confirmação. Toque de novo quando quiser.'
export const NO_ANSWER_TEXT = 'O aparelho não respondeu. Tente de novo.'

// The default messages of apps/app/src/passkeyOptions.js MESSAGES and
// packages/web-member/lib/passkey.js. Only these are rewritten: the same code
// with another message carries its own meaning (a 'concluir' with nothing
// pending is a CANCELLED too).
const DEFAULT_CANCELLED_MESSAGE = 'entrada com a passkey cancelada'
const DEFAULT_WEBAUTHN_MESSAGE = 'a passkey não respondeu; tente de novo'

function defaultMessage (err, message) {
  return err.message === undefined || err.message === '' || err.message === message
}

export function entrarLabel (createLeads) {
  return createLeads === true ? HAVE_ACCOUNT_LABEL : ENTRAR_LABEL
}

// advanced is null until a toggle tap: a sign-in miss opens the section so
// the button named by its notice is visible. A tap wins so it can close again.
// An open recovery-code field keeps it open unless a pending creation hides
// that field: stale codeOpen beside 'concluir' must not lock the section open.
export function advancedOpen ({ advanced, knownLost, missedOnce, codeOpen, showComplete } = {}) {
  return (codeOpen === true && showComplete !== true) || (typeof advanced === 'boolean' ? advanced : (knownLost === true || missedOnce === true))
}

export function plainError (err) {
  if (err === null || typeof err !== 'object' || err.uncertain === true) return ''
  if (err.code === 'CANCELLED' && defaultMessage(err, DEFAULT_CANCELLED_MESSAGE)) return CANCELLED_TEXT
  if (err.code === 'WEBAUTHN' && defaultMessage(err, DEFAULT_WEBAUTHN_MESSAGE)) return NO_ANSWER_TEXT
  return ''
}
