// The conversations a Página kept under a key it moved away from (docs/protocol.md
// section 12): shown read-only while acting as the Página. The chain comes from
// the node-verified page.read (`movedFrom`), never from a seeder hint, and every
// read goes to the node with `page: <old key>`; nothing is sent or signed as an
// old key.

export const OLD_KEY_TITLE = 'Conversas da chave antiga'
export const OLD_KEY_NOTE = 'Mensagens recebidas antes de a página mudar de chave. Só para ler: as respostas saem pela chave nova.'
export const OLD_KEY_READONLY = 'Conversa da chave antiga da página: só leitura.'

const HEX64 = /^[0-9a-f]{64}$/

// The keys this Página moved from, newest first. A failed read ends the walk,
// or with `strict` rejects, so a caller can tell it from a chain that ends.
export async function oldPageKeys (request, page, { max = 4, strict = false } = {}) {
  const found = []
  const seen = new Set([page])
  let key = page
  while (found.length < max) {
    let read
    try {
      read = await request('page.read', { key })
    } catch (err) {
      if (strict) throw err
      break
    }
    const from = read && read.movedFrom && typeof read.movedFrom === 'object' ? read.movedFrom.from : null
    if (typeof from !== 'string' || !HEX64.test(from) || seen.has(from)) break
    seen.add(from)
    found.push(from)
    key = from
  }
  return found
}

// The old keys this device can read and that hold at least one conversation.
export async function heldOldKeys (request, keys) {
  const held = []
  for (const key of keys) {
    try {
      let any = false
      for (const folder of ['inbox', 'request']) {
        const r = await request('dm.list', { page: key, folder, limit: 1 })
        if (r && Array.isArray(r.conversations) && r.conversations.length > 0) {
          any = true
          break
        }
      }
      if (any) held.push(key)
    } catch {}
  }
  return held
}

// A dm request function that reads the old key's store and refuses anything else.
export function oldThreadClient ({ request, page }) {
  return async (method, params = {}) => {
    if (method === 'dm.list' || method === 'dm.thread' || method === 'dm.seen') return request(method, { ...params, page })
    if (method === 'dm.pull') return request('dm.pull', {})
    throw new Error(OLD_KEY_READONLY)
  }
}
