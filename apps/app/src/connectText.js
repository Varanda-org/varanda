// The plain sentence the boot "Conectar" screen shows for a connection
// failure, with the original message kept for "Detalhes técnicos".

export const OTHER_TAB_TEXT = 'O Varanda já está aberto em outra aba ou janela. Feche a outra e toque em Tentar de novo.'
export const CONNECT_FAILED_TEXT = 'Não foi possível conectar agora. Confira sua internet e tente de novo.'
export const RETRY_LABEL = 'Tentar de novo'
export const DETAILS_LABEL = 'Detalhes técnicos'

const LOAD_FAILED_TEXT = 'Não foi possível carregar o app. Recarregue a página.'

export function connectProblem (error) {
  if (typeof error !== 'string' || error === '') return { text: '', detail: '' }
  // Match display text to cover storage failures too; LOCKED also means a passkey sign-in is in progress.
  if (error.includes('outra aba')) return { text: OTHER_TAB_TEXT, detail: '' }
  if (error === LOAD_FAILED_TEXT) return { text: LOAD_FAILED_TEXT, detail: '' }
  return { text: CONNECT_FAILED_TEXT, detail: error }
}
