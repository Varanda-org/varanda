// The device-held keys of a Página's Conversas (docs/rpc.md 5.84 'dm-box',
// 'dm-box-read', 'dm-box-share' and 5.114): who gets a share, which gen to
// seal for, the activation steps, the legacy bundle and the state a
// 'dm-box-read' answer puts the screen in. Pure: no React, no I/O.

const KEY_RE = /^[0-9a-f]{64}$/
const isKey = (v) => typeof v === 'string' && KEY_RE.test(v)
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

export const PAGE_DM_ACTIVATE_TITLE = 'Ativar Conversas privadas da página'
export const PAGE_DM_ACTIVATE_TEXT = 'Daqui em diante, só quem é dono ou administra a página lê estas mensagens. As mensagens que o serviço guardava são copiadas para este aparelho e depois apagadas lá. As mensagens escritas antes podiam ser lidas pelo serviço.'
export const PAGE_DM_ASK_OWNER = 'Peça ao dono da página para enviar a chave'
export const PAGE_DM_ROTATING = 'A chave da página está sendo trocada; tente de novo em instantes'
export const PAGE_DM_CONFLICT = 'A chave da página mudou em outro aparelho'
export const PAGE_DM_MISMATCH = 'A chave publicada da página não é a deste aparelho'
export const PAGE_DM_KEY_PENDING = 'Chave da página pendente'
export const PAGE_DM_SEND_KEY = 'Enviar chave'
export const PAGE_DM_BLOCKS_FAILED = 'Não foi possível reaplicar os bloqueios antigos'
export const reapplyBlocksLabel = (n) => 'Reaplicar ' + n + (n === 1 ? ' bloqueio antigo' : ' bloqueios antigos')

export const PAGE_DM_LEGACY_IMPORT = 'Concluir a importação das conversas antigas'
export const PAGE_DM_ROTATE_TITLE = 'Gerar nova chave da página'
export const PAGE_DM_ROTATE_TEXT = 'Este aparelho não tem a chave atual da página. Uma chave nova é gerada e enviada a quem administra a página; as mensagens seladas com a chave antiga continuam ilegíveis aqui.'
export const PAGE_DM_BLOCK_PEERS = 'Serão bloqueados de novo: '

// The line naming the peers an old block re-apply is about to block, before
// the owner confirms: `labelOf(peer)` gives the @nome or the short key.
export function blockPeersLine (peers, labelOf) {
  const list = Array.isArray(peers) ? peers.filter(isKey) : []
  if (list.length === 0) return ''
  return PAGE_DM_BLOCK_PEERS + [...new Set(list)].map((p) => {
    const l = typeof labelOf === 'function' ? labelOf(p) : null
    return typeof l === 'string' && l !== '' ? l : p.slice(0, 8)
  }).join(', ')
}

// The key state of the page now shown: one read for another page (the
// acting page changed) counts as no read at all, so no action can target
// page B with page A's roster or status.
export const PAGE_KEYS_IDLE = Object.freeze({ page: null, phase: 'idle', status: null, owner: false, roster: null, member: null, error: '', pending: 0, peers: [] })
export function pageKeysOf (state, page) {
  return isObject(state) && state.page === page && isKey(page) ? state : { ...PAGE_KEYS_IDLE, page }
}

// The sealed legacy bundle 'dm-box-read' names for this member (5.84
// 'dm-legacy-read'): { id, count }, or null when none or malformed.
export function legacyBundleOf (status) {
  const b = isObject(status) && isObject(status.legacyBundle) ? status.legacyBundle : null
  if (b === null || !isKey(b.id) || !Number.isInteger(b.count) || b.count < 1 || b.count > 1024) return null
  return { id: b.id, count: b.count }
}

// The inbox card's label for the unfinished legacy steps, or null when there
// is nothing left: the import first, since it may add blocks to re-apply.
export function legacyCardLabel ({ bundle, pending } = {}) {
  if (isObject(bundle)) return PAGE_DM_LEGACY_IMPORT
  return Number.isInteger(pending) && pending > 0 ? reapplyBlocksLabel(pending) : null
}

// The node's USAGE strings (docs/rpc.md 5.114).
const NODE_MISMATCH = 'chave da página não confere'
const NODE_NO_KEY = 'sem chave da página'
const NODE_WAITING = 'aguardando nova chave'

// The owner first, then the admins, each once. A member whose dm-key is
// unknown (null, missing, not a key) is left out of the shares and listed
// in `missing` for 'Enviar chave' later.
export function planShares ({ owner, admins, boxes } = {}) {
  const members = []
  for (const m of [owner, ...(Array.isArray(admins) ? admins : [])]) {
    if (isKey(m) && !members.includes(m)) members.push(m)
  }
  const table = isObject(boxes) ? boxes : {}
  const recipients = []
  const missing = []
  for (const member of members) {
    const box = Object.hasOwn(table, member) ? table[member] : null
    if (isKey(box)) recipients.push({ member, box })
    else missing.push(member)
  }
  return { recipients, missing }
}

// The gen the next shares are sealed for: expectedGen + 1.
export function nextGen (status) {
  if (!isObject(status)) return 1
  const gen = Number.isInteger(status.gen) && status.gen >= 0 ? status.gen : null
  if (status.legacy === true) return gen !== null && gen >= 1 ? gen + 1 : 2
  return gen === null ? 1 : gen + 1
}

// The gen the service expects in 'dm-box' and in a remove's dmBox.
export function expectedGen (status) {
  return nextGen(status) - 1
}

export function activationSteps (status) {
  const steps = ['generate', 'publish', 'confirm']
  return isObject(status) && status.legacy === true ? ['import', ...steps] : steps
}

// What the page's Conversas screen shows for a 'dm-box-read' answer:
// 'rotating' (wait and retry), 'share' (adopt the share), 'activate' (the
// owner may activate), 'rotate' (an owner without a share of the current
// gen, as after a transfer: only a new gen for the roster helps, since no
// admin may write the owner's share), 'ask-owner' (an admin without a
// share, or a page not yet activated), 'unknown' (no answer).
export function pageDmState (status, { owner = false } = {}) {
  if (!isObject(status)) return 'unknown'
  if (status.rotatePending === true) return 'rotating'
  if (isObject(status.share)) return 'share'
  if (owner === true) return hasDeviceKeys(status) ? 'rotate' : 'activate'
  return 'ask-owner'
}

// Whether the page's Conversas use device-held keys (a groupBox is published
// only then): remove and move must carry dmBox, the service answers
// 'rotacao-necessaria' otherwise and refuses dmBox before.
export function hasDeviceKeys (status) {
  return isObject(status) && Number.isInteger(status.gen) && status.gen >= 1 && isKey(status.groupBox)
}

// A page whose gen 1 box the service still holds: its 'dm-box' seals the
// legacy bundle for the owner.
export function isLegacyPage (status) {
  return isObject(status) && (status.legacy === true || (status.gen === 1 && !isKey(status.groupBox)))
}

// The members of the roster without a share of the current gen ('dm-box-read'
// shared, the owner's only), in roster order.
export function missingShares (status, { owner, admins } = {}) {
  if (!isObject(status) || !Array.isArray(status.shared)) return []
  const out = []
  for (const m of [owner, ...(Array.isArray(admins) ? admins : [])]) {
    if (isKey(m) && !status.shared.includes(m) && !out.includes(m)) out.push(m)
  }
  return out
}

// The dm.pageSecrets params for a share from 'dm-box-read' (or the self
// share of dm.pageGenerate), or null when something is missing.
export function secretsParams ({ page, share, by, box, groupBox, cert }) {
  if (!isKey(page) || !isObject(share) || !Number.isInteger(share.gen) || typeof share.sealed !== 'string' || typeof share.sig !== 'string') return null
  const sharer = isKey(share.by) ? share.by : by
  if (!isKey(sharer) || !isKey(box) || !isKey(groupBox) || !isObject(cert)) return null
  return { page, gen: share.gen, sealed: share.sealed, by: sharer, sig: share.sig, box, groupBox, cert }
}

// The screen text for a node or service failure on the page's keys.
export function pageKeyText (err) {
  if (!err) return ''
  if (err.pageKeyMismatch === true || err.message === NODE_MISMATCH) return PAGE_DM_MISMATCH
  if (err.message === NODE_NO_KEY || err.message === NODE_WAITING) return PAGE_DM_ASK_OWNER
  if (err.code === 'rotacao-necessaria') return PAGE_DM_ROTATING
  if (err.code === 'conflito') return PAGE_DM_CONFLICT
  return ''
}

export const isPageKeyMismatch = (err) => !!err && (err.pageKeyMismatch === true || err.message === NODE_MISMATCH)
