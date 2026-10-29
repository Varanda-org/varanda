// Web Push on the hosted web app: the fixed texts, whether this page may
// offer it, the checks on what the browser and the worker hand over, and the
// toggle's state. Pure: no imports and no globals (no URL, URLSearchParams
// or atob), so Node tests load it directly. Not named push.js: a platform
// file push.web.js would shadow a './push' import under Metro.

export const PUSH_KINDS = Object.freeze(['follow', 'reply', 'like', 'repost'])

export const PUSH_LABEL = 'Avisos no aparelho'
export const PUSH_ON = 'Ativar avisos neste aparelho'
export const PUSH_OFF = 'Desligar avisos neste aparelho'
export const PUSH_HINT = 'Receba um aviso quando alguém seguir você, responder, curtir ou republicar o que você publicou. Mostra o nome de quem fez a ação. Só neste aparelho.'
export const PUSH_DENIED = 'Os avisos do sistema estão desligados neste aparelho.'
export const PUSH_UNAVAILABLE = 'Os avisos ainda não estão disponíveis nesta associação.'
export const PUSH_UNSUPPORTED = 'No iPhone e no iPad, os avisos só funcionam com o Varanda na Tela de Início.'
export const PUSH_FAILED = 'Não foi possível mudar os avisos. Tente de novo.'
export const PUSH_UNCERTAIN = 'incerto: pode ter sido aplicado; confira o botão antes de repetir'
export const PUSH_RELOAD = 'Feche todas as janelas do Varanda e abra de novo para ligar os avisos.'
export const PUSH_UNKNOWN = 'Não deu para confirmar os avisos agora.'

// Same rules as the service worker (scripts/sw.js), which builds the launch
// query and the message: what arrives here may still be planted by anyone
// who can open a link, so it is checked again.
const HEX64 = /^[0-9a-f]{64}$/
const REF_RE = /^([0-9a-f]{64}):[1-9][0-9]{0,14}$/
const LAUNCH_KEYS = ['aviso', 'actor', 'recipient', 'ref']
const MESSAGE_KEYS = ['source', 'kind', 'actor', 'recipient', 'ref']
const MESSAGE_SOURCE = 'varanda-push'
const ENDPOINT_MAX = 2048
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
// Unpadded base64url of exactly 65 bytes (an uncompressed P-256 point) and
// of exactly 16 bytes (the RFC 8291 auth secret).
const P256_RE = /^[A-Za-z0-9_-]{87}$/
const AUTH_RE = /^[A-Za-z0-9_-]{22}$/

function isPlainObject (v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

// Same gate as pwaBoot plus the two Push APIs. A hosted page without them
// (an iPhone outside the Home Screen) is told why instead of hiding the row.
export function pushSupport ({ mode, hosted, hasMarker, hasServiceWorker, hasPushManager, hasNotification } = {}) {
  if (mode !== 'browser' || hosted !== true || hasMarker !== true) return 'not-hosted'
  if (hasServiceWorker === true && hasPushManager === true && hasNotification === true) return 'ok'
  return 'unsupported'
}

// -> the bytes, or null unless `s` is the canonical unpadded base64url of
// exactly `len` bytes (non-zero trailing bits would let two strings stand
// for one key).
function decodeB64url (s, re, len) {
  if (typeof s !== 'string' || !re.test(s)) return null
  const out = new Uint8Array(len)
  let acc = 0
  let bits = 0
  let n = 0
  for (let i = 0; i < s.length; i++) {
    acc = (acc << 6) | B64URL.indexOf(s[i])
    bits += 6
    if (bits >= 8) {
      bits -= 8
      if (n >= len) return null
      out[n++] = (acc >> bits) & 0xff
    }
    acc &= (1 << bits) - 1
  }
  if (n !== len || acc !== 0) return null
  return out
}

// The VAPID public key the account service publishes -> the 65-byte
// uncompressed point PushManager.subscribe expects, or null.
export function applicationServerKey (value) {
  const bytes = decodeB64url(value, P256_RE, 65)
  return bytes !== null && bytes[0] === 0x04 ? bytes : null
}

// https only, no userinfo (a credential in the URL) and no fragment. The
// host allowlist is the account service's job.
function validEndpoint (url) {
  if (typeof url !== 'string' || url.length > ENDPOINT_MAX || !url.startsWith('https://')) return false
  if (/[\s#\\]/.test(url) || /[\u0000-\u001f\u007f-\u009f]/.test(url)) return false // eslint-disable-line no-control-regex
  const rest = url.slice('https://'.length)
  const end = rest.search(/[/?]/)
  const authority = end === -1 ? rest : rest.slice(0, end)
  return authority.length > 0 && !authority.includes('@')
}

// PushSubscription.toJSON() -> a fresh { endpoint, p256dh, auth }, or null.
export function subscriptionJsonOf (value) {
  try {
    if (!isPlainObject(value) || !isPlainObject(value.keys)) return null
    const endpoint = value.endpoint
    const p256dh = value.keys.p256dh
    const auth = value.keys.auth
    if (!validEndpoint(endpoint)) return null
    const point = decodeB64url(p256dh, P256_RE, 65)
    if (point === null || point[0] !== 0x04) return null
    if (decodeB64url(auth, AUTH_RE, 16) === null) return null
    return { endpoint, p256dh, auth }
  } catch {
    return null
  }
}

// `registered` is what the account service says about this subscription
// (null: not known right now). The toggle reads "on" only when both the
// browser and the service agree, so a lost row on either side is offered
// again instead of shown as working.
export function pushUiState ({ support, keyAvailable, permission, subscribed, registered = null, pending, swUpToDate = true } = {}) {
  const on = subscribed === true && registered === true
  if (support === 'unsupported') return { visible: true, on: false, disabled: true, note: PUSH_UNSUPPORTED }
  if (support !== 'ok') return { visible: false, on: false, disabled: true, note: null }
  if (keyAvailable !== true) return { visible: true, on: false, disabled: true, note: PUSH_UNAVAILABLE }
  // Before the reload note: reopening the app does not lift a browser block.
  if (permission === 'denied') return { visible: true, on: false, disabled: true, note: PUSH_DENIED }
  // An older worker without the push handler stays in charge until every
  // window closes (sw.js lifecycle): a subscription made now would get
  // notices nobody shows.
  if (swUpToDate !== true) return { visible: true, on, disabled: true, note: PUSH_RELOAD }
  const note = subscribed === true && registered === null ? PUSH_UNKNOWN : null
  return { visible: true, on, disabled: pending === true, note }
}

function decodePart (s) {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '))
  } catch {
    return null
  }
}

// location.search -> [{ raw, key, value }] in order; key null when it does
// not decode.
function splitSearch (search) {
  if (typeof search !== 'string') return []
  const body = search.startsWith('?') ? search.slice(1) : search
  if (body === '') return []
  return body.split('&').filter((raw) => raw !== '').map((raw) => {
    const eq = raw.indexOf('=')
    const key = decodePart(eq === -1 ? raw : raw.slice(0, eq))
    const value = eq === -1 ? '' : decodePart(raw.slice(eq + 1))
    return { raw, key, value }
  })
}

function notice (kind, actor, recipient, ref) {
  if (!PUSH_KINDS.includes(kind)) return null
  if (typeof actor !== 'string' || !HEX64.test(actor)) return null
  if (typeof recipient !== 'string' || !HEX64.test(recipient) || actor === recipient) return null
  if (kind === 'follow') {
    if (ref !== null) return null
  } else {
    const m = typeof ref === 'string' ? REF_RE.exec(ref) : null
    if (m === null || m[1] !== recipient) return null
  }
  return { kind, actor, recipient, ref }
}

// The query a notification click opens (/?aviso=...) -> { kind, actor,
// recipient, ref }, or null. A repeated field is refused: which copy the
// worker meant is unknowable.
export function parseLaunch (search) {
  try {
    const found = {}
    for (const { key, value } of splitSearch(search)) {
      if (!LAUNCH_KEYS.includes(key)) continue
      if (Object.prototype.hasOwnProperty.call(found, key) || value === null) return null
      found[key] = value
    }
    if (!Object.prototype.hasOwnProperty.call(found, 'aviso')) return null
    const ref = Object.prototype.hasOwnProperty.call(found, 'ref') ? found.ref : null
    return notice(found.aviso, found.actor, found.recipient, ref)
  } catch {
    return null
  }
}

// What the worker posts to an open window on a click -> the same, or null.
export function parseMessage (data) {
  try {
    if (!isPlainObject(data)) return null
    const own = Object.keys(data)
    if (own.length !== MESSAGE_KEYS.length || !MESSAGE_KEYS.every((k) => own.includes(k))) return null
    if (data.source !== MESSAGE_SOURCE) return null
    return notice(data.kind, data.actor, data.recipient, data.ref)
  } catch {
    return null
  }
}

// location.search without the launch fields, the rest (such as ?conta=)
// kept as written and in order; '' when nothing is left.
export function stripLaunch (search) {
  const kept = splitSearch(search).filter(({ key }) => !LAUNCH_KEYS.includes(key)).map(({ raw }) => raw)
  return kept.length === 0 ? '' : '?' + kept.join('&')
}
