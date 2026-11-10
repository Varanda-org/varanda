// The Entrar card when no passkey can open the account (src/screens/Identidade.js).
// Creation needs a synced manager with PRF; an existing passkey may still
// open the account. Pure so Node tests load it.

export const BROWSER_TEXT = 'Este navegador não funciona com o Varanda. Use o Chrome, o Edge ou o Safari 18 ou mais novo.'
export const UNUSABLE_TITLE = 'Não deu para entrar com essa passkey.'
export const RETRY_LABEL = 'tentar de novo'
export const PHONE_LABEL = 'criar com o celular'
// The same phone button when it opens an existing account instead.
export const PHONE_SIGNIN_LABEL = 'entrar com o celular'
// Capitalised forms for the buttons; the lower-case ones read inside sentences.
export const RETRY_BUTTON = 'Tentar de novo'
export const PHONE_BUTTON = 'Criar com o celular'
export const PHONE_SIGNIN_BUTTON = 'Entrar com o celular'
export const NOT_SYNCED_TITLE = 'Essa passkey não serve para o Varanda.'
export const NONE_TEXT = 'Nenhuma conta da Varanda neste aparelho. Toque em Criar minha conta. Se você já tem conta, confira se o aparelho está na mesma conta Google de antes, ou toque em Outras formas de entrar e use o código de recuperação.'
export const KNOWN_LOST_TEXT = 'A conta que este aparelho conhece não apareceu. Ela pode ter sido apagada ou estar guardada em outra conta Google, Apple ou de um gerenciador de senhas: toque em Entrar com outra passkey ou crie uma conta nova.'
// Variants shown while creation is withheld: the network is full, or its
// answer has not arrived yet.
export const NONE_FULL_TEXT = 'Nenhuma conta da Varanda neste aparelho. Se você já tem conta, confira se o aparelho está na mesma conta Google de antes, ou toque em Outras formas de entrar e use o código de recuperação.'
// The same miss while a creation waits for 'concluir': the code row is hidden
// then, so the notice names only the button on screen.
export const NONE_PENDING_TEXT = 'Nenhuma conta da Varanda neste aparelho. Toque em Concluir e entrar para terminar a conta que você começou a criar.'
export const KNOWN_LOST_FULL_TEXT = 'A conta que este aparelho conhece não apareceu. Ela pode ter sido apagada ou estar guardada em outra conta Google, Apple ou de um gerenciador de senhas: toque em Entrar com outra passkey.'
// After one sign-in that did not finish (closed sheet or missing passkey).
export const MISSED_TEXT = 'Sua conta não apareceu? Tente entrar de novo ou toque em Entrar com outra passkey para escolher outra.'
export const OTHER_PASSKEY_LABEL = 'Entrar com outra passkey'

const CLEANED_STEP = 'O app já pediu ao gerenciador para retirar a passkey que não serviu.'

// cleaned acknowledges the request; userIds are only the ids still to remove, so
// both lines can show without hiding a name the person must delete.
function cleanupSteps (cleaned, userIds) {
  return cleaned ? [CLEANED_STEP, deleteStep(userIds)] : [deleteStep(userIds)]
}

// The label the passkey carries in the password manager
// (packages/web-member/lib/passkey.js), or '' for anything but a hex user id.
export function staleName (userId) {
  return typeof userId === 'string' && /^[0-9a-f]{6,}$/i.test(userId)
    ? 'Varanda ' + userId.slice(0, 6).toLowerCase()
    : ''
}

// The unusable passkeys this page session saw fail, by label. Conditional:
// a passkey created here may still be the account on another device.
export function deleteStep (userIds) {
  const names = [...new Set((Array.isArray(userIds) ? userIds : []).map(staleName).filter(Boolean))]
  if (names.length === 0) return ''
  const quoted = names.map((n) => '"' + n + '"')
  return names.length === 1
    ? 'Se você não usou essa passkey para entrar em outro aparelho, apague a passkey ' + quoted[0] + ' do app onde você guarda senhas: ela foi criada aqui, mas não funciona com o Varanda.'
    : 'Se você não usou essas passkeys para entrar em outro aparelho, apague as passkeys ' + quoted.slice(0, -1).join(', ') + ' e ' + quoted[quoted.length - 1] + ' do app onde você guarda senhas: elas foram criadas aqui, mas não funcionam com o Varanda.'
}

// Numbered steps when PRF is unavailable. userIds: only passkeys created on this
// page that failed; one only chosen at Entrar may hold the account, so the
// caller never passes it. created: a passkey made here failed, so another can
// be created. known: this browser keeps a passkey, and Entrar offers only that
// one ('Criar passkey' is not shown). withLink: the card already tells the
// person to open the invite link in another browser. native: the installed
// app, which has no browser to switch to. Web and app both point to synced password managers.
// cleaned means cleanup was requested, not that the manager confirmed deletion.
export function unusableSteps ({ userIds = [], withLink = false, created = false, known = false, native = false, cleaned = false } = {}) {
  const retry = known
    ? 'Toque em ' + RETRY_LABEL + '.'
    : created
      ? 'Toque em ' + RETRY_LABEL + ' e crie a passkey outra vez. Se o aparelho perguntar onde salvar, escolha um gerenciador de senhas que sincroniza entre aparelhos (o do celular, do Google ou da Apple).'
      : 'Toque em ' + RETRY_LABEL + ' e escolha outra passkey do Varanda, se tiver.'
  const steps = [
    ...cleanupSteps(cleaned, userIds),
    retry,
    withLink ? '' : native ? 'Se não der certo, entre pelo site da associação no Chrome.' : 'Se não der certo, abra o Varanda no Safari ou no Chrome.'
  ].filter(Boolean)
  return steps.map((s, i) => (i + 1) + '. ' + s)
}

// Steps for a passkey that works but does not sync. userIds: only passkeys
// created here and not yet cleaned; cleaned: cleanup was requested for the rest;
// native and withLink as in unusableSteps (the phone QR path is web only).
// phone: the browser offers the hybrid transport; without it the page has no
// phone button, so the last step points to the phone itself instead.
export function notSyncedSteps ({ userIds = [], cleaned = false, native = false, withLink = false, phone = true } = {}) {
  // Never another browser: there the same device-bound passkey has no
  // refusal record and could sign in, binding a new account to one device.
  const fallback = native
    ? 'Se não der certo, escolha nas configurações do aparelho um gerenciador de senhas que sincroniza e crie a passkey de novo.'
    : phone
      ? 'Sem gerenciador assim neste aparelho? Toque em ' + RETRY_LABEL + ', em Outras formas de entrar e em ' + PHONE_LABEL + ': leia com a câmera do celular o QR code que aparece na tela.'
      : 'Se não der certo, abra o Varanda no celular e crie a passkey lá: o celular guarda a passkey num gerenciador que sincroniza.'
  const steps = [
    ...cleanupSteps(cleaned, userIds),
    'Toque em ' + RETRY_LABEL + ' e, ao criar, escolha um gerenciador de senhas que sincroniza entre aparelhos (o do celular, do Google, da Apple ou outro), nunca uma chave de segurança, o Windows Hello ou o perfil do navegador.',
    withLink ? '' : fallback
  ].filter(Boolean)
  return steps.map((s, i) => (i + 1) + '. ' + s)
}
