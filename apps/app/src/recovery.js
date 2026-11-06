// Recovery entries: a second passkey or a recovery code that opens the same
// account (docs/rpc.md 5.90 to 5.94). Pure ES module: no React, no Node
// built-ins. `account` is the set of recovery calls of src/account.js and
// `request` the node's RPC, both injected so the flow is testable. The app
// never hashes or signs: the node computes the blob hash and signs the
// statement in recovery.sign. Nothing here repeats a call that failed: an
// unknown outcome keeps `uncertain: true` and the caller re-reads the list.

export const CHANGE_TEXT = 'Trocar a passkey é adicionar a nova, confirmar que ela entra na conta e só depois apagar a antiga no gerenciador de senhas. A passkey com que a conta foi criada continua abrindo a conta enquanto existir no gerenciador, também sem internet, em qualquer aparelho: o Varanda não consegue invalidá-la. A passkey nova e o código precisam da internet sempre que você entra de novo com eles.'
export const CODE_ONCE_TEXT = 'Este código de recuperação aparece só agora. Anote e guarde num lugar seguro, fora deste aparelho: quem tiver o código abre a sua conta, e o Varanda não consegue mostrá-lo de novo. Quem entrar com este código fica com a conta para sempre: se ele vazar, removê-lo ou trocá-lo depois não tira esse acesso, então crie uma conta nova.'
export const LOSS_TEXT = 'Sem passkey e sem código de recuperação, a conta não pode ser recuperada. Uma passkey adicionada e o código precisam da internet para entrar; a passkey original não.'
export const SERVICE_DOWN_TEXT = 'não foi possível conferir a passkey com o serviço de conta; tente de novo'
export const NOT_FOUND_TEXT = 'esta passkey ou este código não está ligado a uma conta neste endereço'

async function signed ({ request, account, member, params }) {
  const { nonce } = await account.recoveryStart({ member })
  const { signature } = await request('recovery.sign', { ...params, nonce })
  return { nonce, signature }
}

// Registers a blob from identity.recoveryWrap (or the web handle) under its
// lookup id.
export async function registerEntry ({ request, account, member, kind, lookupId, blob }) {
  const { nonce, signature } = await signed({ request, account, member, params: { action: 'put', kind, lookupId, blob } })
  return account.recoveryPut({ member, nonce, signature, kind, lookupId, blob })
}

export async function removeEntry ({ request, account, member, kind, lookupId }) {
  const { nonce, signature } = await signed({ request, account, member, params: { action: 'remove', kind, lookupId } })
  return account.recoveryRemove({ member, nonce, signature, kind, lookupId })
}

export async function listEntries ({ request, account, member }) {
  const { nonce, signature } = await signed({ request, account, member, params: { action: 'list' } })
  return account.recoveryList({ member, nonce, signature })
}
