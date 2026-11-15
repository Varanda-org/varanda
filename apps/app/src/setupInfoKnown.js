// Whether the setup step under the boot splash knows enough to show
// (splashGate.js coverBoot infoKnown). Pure, for the tests.
// 'Escolha seu @nome' also waits for the account state of the key node.info
// names (Identidade LinkCard reports it by key), so the step never opens on
// its own "Preparando sua conta…". This is decided at render time, before the
// card mounts: the cover latch (App.js bootSettled) would otherwise settle in
// the render where node.info arrives. Once the shell has shown a screen (the
// step comes after Idade or Telefone) the splash does not come back, and the
// step's own loading state is what shows. holdBootCover still bounds the wait.
export function setupInfoKnown ({ step, info = null, infoError = '', accountReadKey = null } = {}) {
  if (typeof infoError === 'string' && infoError !== '') return true
  if (info === null || typeof info !== 'object') return false
  if (step === 'vinculo' && typeof info.publicKey === 'string' && info.memberCert !== true) {
    return accountReadKey === info.publicKey
  }
  return true
}
