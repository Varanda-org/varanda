// The Entrar card when no passkey can open the account (src/screens/Identidade.js).
// Two cases: the browser says up front it cannot (only another browser helps),
// or a passkey was created or chosen but its password manager gives no PRF
// (trying again and saving it elsewhere can work). Pure so Node tests load it.

export const BROWSER_TEXT = 'Este navegador não funciona com o Varanda. Use o Chrome, o Edge ou o Safari 18 ou mais novo.'
export const UNUSABLE_TITLE = 'Não deu para entrar com essa passkey.'
export const RETRY_LABEL = 'tentar de novo'

// The label the passkey carries in the password manager
// (packages/web-member/lib/passkey.js), or '' for anything but a hex user id.
export function staleName (userId) {
  return typeof userId === 'string' && /^[0-9a-f]{6,}$/i.test(userId)
    ? 'Varanda ' + userId.slice(0, 6).toLowerCase()
    : ''
}

// The unusable passkeys this page saw, by label, so the person can delete them.
export function deleteStep (userIds) {
  const names = [...new Set((Array.isArray(userIds) ? userIds : []).map(staleName).filter(Boolean))]
  if (names.length === 0) return ''
  const quoted = names.map((n) => '"' + n + '"')
  return names.length === 1
    ? 'Apague a passkey ' + quoted[0] + ' do app onde você guarda senhas. Ela foi criada, mas não funciona com o Varanda.'
    : 'Apague as passkeys ' + quoted.slice(0, -1).join(', ') + ' e ' + quoted[quoted.length - 1] + ' do app onde você guarda senhas. Elas foram criadas, mas não funcionam com o Varanda.'
}

// Numbered steps for the second case. userIds: only passkeys created on this
// page that failed; one only chosen at Entrar may hold the account, so the
// caller never passes it. created: a passkey made here failed, so another can
// be created. known: this browser keeps a passkey, and Entrar offers only that
// one ('Criar passkey' is not shown). withLink: the card already tells the
// person to open the invite link in another browser. native: the installed
// app, which has no browser to switch to and saves only to Google's manager.
export function unusableSteps ({ userIds = [], withLink = false, created = false, known = false, native = false } = {}) {
  const retry = known
    ? 'Toque em ' + RETRY_LABEL + '.'
    : created
      ? 'Toque em ' + RETRY_LABEL + ' e crie a passkey outra vez. Se o aparelho perguntar onde salvar, escolha ' + (native ? 'o Gerenciador de Senhas do Google.' : 'as Senhas da Apple (no iPhone) ou o Gerenciador de Senhas do Google.')
      : 'Toque em ' + RETRY_LABEL + ' e escolha outra passkey do Varanda, se tiver.'
  const steps = [
    deleteStep(userIds),
    retry,
    withLink ? '' : native ? 'Se não der certo, entre pelo site da associação no Chrome.' : 'Se não der certo, abra o Varanda no Safari ou no Chrome.'
  ].filter(Boolean)
  return steps.map((s, i) => (i + 1) + '. ' + s)
}
