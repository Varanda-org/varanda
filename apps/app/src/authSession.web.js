// The web returns from the Google step by a page load, never by an auth
// session (modules/auth-session is native only).
export function isAvailable () { return false }

export async function open () {
  const err = new Error('este endereço não pode abrir o login aqui')
  err.code = 'UNSUPPORTED'
  throw err
}
