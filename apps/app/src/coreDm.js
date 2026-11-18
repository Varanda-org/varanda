// Conversas on a node that is not hosted (#352): whether it answers the DM
// methods, decided by asking it, never by the platform or node.hosted alone.
// A core node runs them only with the engine its host built on an account
// origin (worklet/main.js coreDm, varanda-serve --account-origin), and has
// no passkey: the engine unlocks from its seed file once dm.enable made it.
// No imports: Metro bundles the file and the tests load it with import().

// The core session's refusal without an engine (packages/core/lib/session.js
// DM_WEB_ONLY) and the engine's before dm.enable (packages/web-member/lib/
// core-dm.js DM_OFF).
export const CORE_DM_NONE = 'mensagens diretas disponíveis só no navegador'
export const CORE_DM_OFF = 'Conversas ainda não ativadas neste aparelho'

// What the activation says, as the Terms' core-node sentence (legal.js):
// the keys stay in a file on this device, with no passkey protecting them.
export const CORE_DM_ACTIVATE_NOTE = 'Num nó core, as chaves destas Conversas ficam guardadas num arquivo neste aparelho, sem passkey: quem tiver a pasta de dados do nó consegue lê-las, e quem perder essa pasta perde estas Conversas.'
export const CORE_DM_ACTIVATE = 'Ativar Conversas'

// Kept per request function and account origin: the request keeps one
// identity for the whole app session, across a change of node.
const probes = new WeakMap()

function slot (node) {
  const fn = typeof node.request === 'function' ? node.request : null
  if (fn === null) return null
  let byOrigin = probes.get(fn)
  if (byOrigin === undefined) {
    byOrigin = new Map()
    probes.set(fn, byOrigin)
  }
  return { byOrigin, origin: String(node.accountOrigin) }
}

// -> Promise<'hosted' | 'on' | 'off' | 'none'>. One dm.list, which writes
// nothing: CORE_DM_NONE is no engine, CORE_DM_OFF an engine not enabled yet,
// any other USAGE answer an engine (its own error shows on the screen). Any
// other failure (closed, offline) is thrown and not kept.
export function probeCoreDm (node) {
  if (!node || node.hosted !== false) return Promise.resolve('hosted')
  const s = slot(node)
  if (s === null) return Promise.resolve('none')
  const kept = s.byOrigin.get(s.origin)
  if (kept !== undefined) return kept
  const probe = Promise.resolve().then(() => node.request('dm.list', { limit: 1 })).then(() => 'on', (err) => {
    const message = err && err.message
    if (message === CORE_DM_NONE) return 'none'
    if (message === CORE_DM_OFF) return 'off'
    if (err && err.code === 'USAGE') return 'on'
    throw err
  })
  s.byOrigin.set(s.origin, probe)
  probe.catch(() => { if (s.byOrigin.get(s.origin) === probe) s.byOrigin.delete(s.origin) })
  return probe
}

// After dm.enable (or a failed one): the next probe asks again.
export function forgetCoreDm (node) {
  if (!node || typeof node.request !== 'function') return
  const s = slot(node)
  s.byOrigin.delete(s.origin)
}

// The Conversas screens' gate. core: the probe's answer, or null while it
// is unknown. -> { ready, locked, activate }: ready reads and writes; locked
// shows the passkey text (hosted only); activate offers dm.enable (core
// only). All false: today's view of a node without Conversas.
export function dmScreenGate ({ hosted, unlocked, core }) {
  if (hosted === true) return { ready: unlocked === true, locked: unlocked !== true, activate: false }
  return { ready: core === 'on', locked: false, activate: core === 'off' }
}

// ---- a Página in groups on a core node ----

const groupProbes = new WeakMap()

// -> Promise<'hosted' | 'on' | 'none'>: whether this node reads a group as
// a Página (group.read with `page`, and text group.seal with it). A core
// node without that support refuses it with CORE_DM_NONE before reading
// anything; one with it answers, or refuses for that group (the page's own
// key is no group). One read, which writes nothing, per request function
// and account origin. Any failure that is not a USAGE answer is thrown and
// not kept.
export function probeCorePageGroups (node, page) {
  if (!node || node.hosted !== false) return Promise.resolve('hosted')
  if (typeof node.request !== 'function' || typeof page !== 'string' || !/^[0-9a-f]{64}$/.test(page)) return Promise.resolve('none')
  let byOrigin = groupProbes.get(node.request)
  if (byOrigin === undefined) {
    byOrigin = new Map()
    groupProbes.set(node.request, byOrigin)
  }
  const origin = String(node.accountOrigin)
  const kept = byOrigin.get(origin)
  if (kept !== undefined) return kept
  const probe = Promise.resolve().then(() => node.request('group.read', { group: page, page, limit: 1 })).then(() => 'on', (err) => {
    if (err && err.message === CORE_DM_NONE) return 'none'
    if (err && (err.code === 'USAGE' || err.code === 'NOT_FOUND')) return 'on'
    throw err
  })
  byOrigin.set(origin, probe)
  probe.catch(() => { if (byOrigin.get(origin) === probe) byOrigin.delete(origin) })
  return probe
}

// Whether a group screen opens: always on a hosted node; on a core node only
// as a Página, once the probe says the node reads groups as one. Anything
// else keeps "Comunidades indisponíveis".
export function groupScreenOpen ({ hosted, asPage, core }) {
  if (hosted === true) return true
  return !!asPage && asPage.page === true && core === 'on'
}
