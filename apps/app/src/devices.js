// Aparelhos conectados (#350): the pure side. The node keeps the account's
// device list in the diary (device.hello, device.list, device.disconnect,
// device.reconnect, docs/rpc.md); this module holds the copy, the device name
// the app sends, the shaping of a device.list answer and the store the shell
// and the screen share. No React, no react-native, no clock of its own.
// Anything that comes from the node (a device name) is shown through
// displayText by the caller.

export const DEVICES_TITLE = 'Aparelhos conectados'
export const THIS_DEVICE = 'Este aparelho'
export const NO_NAME = 'Aparelho sem nome'
export const PREVIOUS_TITLE = 'Aparelhos anteriores'
export const PREVIOUS_NOTE = 'Aparelhos que entraram na sua conta antes desta lista existir. Não aparecem um a um, mas dá para desconectar todos de uma vez.'
export const DEVICES_NOTE = 'Os aparelhos em que você entrou com a sua passkey. Se perder um, desconecte-o aqui.'
export const DISCONNECT = 'Desconectar'
export const CONNECTED_SECTION = 'Conectados'
export const DISCONNECTED_SECTION = 'Desconectados'
export const EMPTY_OTHERS = 'Nenhum outro aparelho conectado.'
export const LOAD_FAILED = 'Não deu para carregar os aparelhos agora.'
export const CONFIRM_TITLE = 'Desconectar aparelho'
export const CONFIRM_LINES = Object.freeze([
  'O que aquele aparelho escrever depois disso não aparece mais nas comunidades e grupos.',
  'Os grupos privados trocam a chave.',
  'Ele só volta se alguém com a sua passkey conectar de novo naquele aparelho.'
])
// "Aparelhos anteriores" are several devices: the same promise, in the plural.
// Per the node they are disconnected too and need the passkey to come back.
export const PREVIOUS_CONFIRM_TITLE = 'Desconectar aparelhos anteriores'
export const PREVIOUS_CONFIRM_LINES = Object.freeze([
  'O que esses aparelhos escreverem depois disso não aparece mais nas comunidades e grupos.',
  'Os grupos privados trocam a chave.',
  'Eles só voltam se alguém com a sua passkey conectar de novo em cada um.'
])
export const PREVIOUS_DONE_TOAST = 'Aparelhos desconectados.'
export const DISCONNECTED_CAPTION = 'Desconectado'
export const FORCED_LOCK_TEXT = 'Este aparelho foi desconectado da conta. Entre com a sua passkey para usar de novo.'
export const RECONNECT_UNCERTAIN = 'Pode não ter dado certo. Veja se este aparelho continua desconectado e toque de novo se for o caso.'
export const CONFIRM_CANCEL = 'Cancelar'
export const DONE_TOAST = 'Aparelho desconectado.'
export const PARTLY_DONE = 'Pode ter sido feito só em parte. Confira a lista.'
export const OFF_NOTE = 'Este aparelho foi desconectado da conta'
export const RECONNECT = 'Conectar de novo'
export const RECONNECT_ACCESSIBILITY = 'Conectar este aparelho de novo à conta'
export const RECONNECTED_TOAST = 'Aparelho conectado de novo.'

export const NAME_MAX = 40
export const UNNAMED_SELF = 'Aparelho'

const HEX64 = /^[0-9a-f]{64}$/
// What the node answers to a method it does not have.
const UNKNOWN_METHOD = 'método desconhecido'

// True only for the node's unknown-method answer: the entry hides then. Any
// other failure (offline, locked) says nothing about what the node offers.
export function unknownMethod (err) {
  return err !== null && typeof err === 'object' && err.message === UNKNOWN_METHOD
}

function clean (text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()
}

function cut (text) {
  const chars = Array.from(text)
  return chars.length <= NAME_MAX ? text : chars.slice(0, NAME_MAX).join('').trim()
}

function browserOf (ua) {
  if (/Edg(?:e|A|iOS)?\//.test(ua)) return 'Edge'
  if (/OPR\/|Opera/.test(ua)) return 'Opera'
  if (/SamsungBrowser\//.test(ua)) return 'Samsung Internet'
  if (/Firefox\/|FxiOS\//.test(ua)) return 'Firefox'
  if (/Chrome\/|CriOS\//.test(ua)) return 'Chrome'
  if (/Safari\//.test(ua)) return 'Safari'
  return null
}

function systemOf (ua, touches) {
  if (/iPhone/.test(ua)) return 'iPhone'
  // iPadOS reports a Mac user agent; touch points tell it apart (as install-offer.js does).
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && typeof touches === 'number' && touches > 1)) return 'iPad'
  if (/Android/.test(ua)) return 'Android'
  if (/Windows/.test(ua)) return 'Windows'
  if (/CrOS/.test(ua)) return 'ChromeOS'
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac'
  if (/Linux|X11/.test(ua)) return 'Linux'
  return null
}

// The short name this device sends with device.hello, at most NAME_MAX
// characters. It follows what the environment reports, never the platform:
// a browser user agent gives "Chrome no Android"; otherwise the phone's own
// constants give brand and model ("Google Pixel 8", Android) or "iPhone" /
// "iPad" (iOS: the interface idiom). `env` is { userAgent, maxTouchPoints,
// constants }, all optional; with nothing usable the name is UNNAMED_SELF.
export function deviceName (env) {
  const e = env !== null && typeof env === 'object' ? env : {}
  const ua = typeof e.userAgent === 'string' ? e.userAgent : ''
  const browser = browserOf(ua)
  const system = systemOf(ua, e.maxTouchPoints)
  let name = ''
  if (browser !== null && system !== null) name = browser + ' no ' + system
  else if (browser !== null) name = browser
  else if (system !== null) name = system
  if (name === '') {
    const c = e.constants !== null && typeof e.constants === 'object' ? e.constants : {}
    const model = typeof c.Model === 'string' ? clean(c.Model) : ''
    const brand = typeof c.Brand === 'string' ? clean(c.Brand) : (typeof c.Manufacturer === 'string' ? clean(c.Manufacturer) : '')
    if (model !== '') {
      const capital = brand === '' ? '' : brand.charAt(0).toUpperCase() + brand.slice(1)
      name = capital !== '' && !model.toLowerCase().startsWith(brand.toLowerCase()) ? capital + ' ' + model : model
    } else if (c.interfaceIdiom === 'pad') name = 'iPad'
    else if (c.interfaceIdiom === 'phone' || typeof c.systemName === 'string') name = 'iPhone'
  }
  name = cut(clean(name))
  return name === '' ? UNNAMED_SELF : name
}

// "dd/mm/aaaa" in the device's own calendar, or null for anything else.
export function sinceDate (iso) {
  if (typeof iso !== 'string') return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  const d = new Date(t)
  const two = (n) => String(n).padStart(2, '0')
  return two(d.getDate()) + '/' + two(d.getMonth() + 1) + '/' + d.getFullYear()
}

export function sinceText (iso) {
  const date = sinceDate(iso)
  return date === null ? null : 'Conectado desde ' + date
}

// The caption under a row: "Conectado desde ..." for a connected device,
// "Desconectado" for one that is not (it was never connected "since" then).
export function rowCaption (row) {
  if (row === null || typeof row !== 'object') return null
  return row.on === false ? DISCONNECTED_CAPTION : sinceText(row.since)
}

function rowOf (d) {
  if (d === null || typeof d !== 'object' || typeof d.id !== 'string' || !HEX64.test(d.id)) return null
  const name = typeof d.name === 'string' && d.name.trim() !== '' ? d.name : null
  return {
    id: d.id,
    name,
    since: typeof d.since === 'string' ? d.since : null,
    on: d.on !== false,
    self: d.self === true,
    writers: Number.isInteger(d.writers) && d.writers >= 0 ? d.writers : 0
  }
}

// What the screen shows from a device.list answer: this device, the other
// connected ones (newest first, as the node orders them), the disconnected
// ones (no actions) and the "Aparelhos anteriores" item. A malformed answer
// gives an empty view rather than an error.
export function shapeList (reply) {
  const r = reply !== null && typeof reply === 'object' ? reply : {}
  const rows = (Array.isArray(r.devices) ? r.devices : []).map(rowOf).filter((x) => x !== null)
  const own = rows.find((x) => x.self) || null
  const others = rows.filter((x) => !x.self && x.on)
  const disconnected = rows.filter((x) => !x.self && !x.on)
  const prev = r.previous !== null && typeof r.previous === 'object' ? r.previous : null
  return {
    off: r.off === true || (own !== null && !own.on),
    self: own,
    others,
    disconnected,
    previous: prev === null ? null : { writers: Number.isInteger(prev.writers) && prev.writers >= 0 ? prev.writers : 0 }
  }
}

export function otherLabel (row) {
  return row.name === null ? NO_NAME : row.name
}

export function disconnectLabel (row) {
  return DISCONNECT + ' ' + (row.name === null ? NO_NAME : row.name)
}

// The params for device.disconnect: exactly one of id and previous.
export function disconnectParams (target) {
  if (target === 'previous') return { previous: true }
  return { id: target }
}

// The sheet copy for what is being disconnected: one device, or the
// "Aparelhos anteriores" (plural).
export function confirmCopy (target) {
  return target === 'previous'
    ? { title: PREVIOUS_CONFIRM_TITLE, lines: PREVIOUS_CONFIRM_LINES, done: PREVIOUS_DONE_TOAST }
    : { title: CONFIRM_TITLE, lines: CONFIRM_LINES, done: DONE_TOAST }
}

// The member the device feature works for: the unlocked passkey key (lower
// case), or on a node without a passkey (the core kind) the own key from
// node.info. Null while not ready, behind the Terms, locked or unknown.
export function deviceMemberOf ({ ready, termsOk, hasPasskey, status, ownKey }) {
  if (ready !== true || termsOk !== true) return null
  const key = hasPasskey
    ? (status !== null && typeof status === 'object' && status.unlocked === true ? status.publicKey : null)
    : ownKey
  return typeof key === 'string' && HEX64.test(key.toLowerCase()) ? key.toLowerCase() : null
}

// The Ajustes row: the node offers device.list, and the identity is unlocked
// when it has a passkey (a node without one has nothing to unlock). It does
// not depend on `hosted`.
export function devicesRowShown ({ offered, hasPasskey, unlocked }) {
  return offered === true && (hasPasskey !== true || unlocked === true)
}

// A disconnected device whose identity came from a kept session (resumed,
// no passkey ceremony in this open) forgets the session and locks, so the
// passkey is asked again. After a passkey unlock in this open (resumed
// false, or `passkeyHere`: a member that unlocked by passkey earlier in this
// open, since a native reconnect reports resumed again), and on a node
// without a passkey, it only shows the note.
export function shouldForceLock ({ off, hasPasskey, unlocked, resumed, passkeyHere }) {
  return off === true && hasPasskey === true && unlocked === true && resumed === true && passkeyHere !== true
}

// Remembers (in `seen`, a Set kept for the open) a member whose identity was
// unlocked by a passkey ceremony: unlocked with resumed false. Returns
// whether this member unlocked that way in this open.
export function notePasskeyUnlock (seen, { member, unlocked, resumed }) {
  if (typeof member !== 'string') return false
  if (unlocked === true && resumed === false) seen.add(member)
  return seen.has(member)
}

// What the shell does for the member now. 'hello': first time this open
// (device.hello also answers off). 'read': the member came back (a lock and
// an unlock, or the first run) and hello is not sent again, so the state is
// read once (a read, never a retry of a mutating call): an event that came
// while locked, or the wipe at the lock, would otherwise lose `off`. Null:
// nothing, or offline.
export function deviceStep ({ member, online, helloSent, readFor }) {
  if (typeof member !== 'string' || online === false) return null
  if (helloSent !== member) return 'hello'
  return readFor !== member ? 'read' : null
}

// What a failed reconnect says: plain words, never the "incerto" text.
export function reconnectFailure (err, show) {
  if (err !== null && typeof err === 'object' && err.uncertain === true) return RECONNECT_UNCERTAIN
  const message = err !== null && typeof err === 'object' && typeof err.message === 'string' && err.message !== '' ? err.message : 'erro'
  return show(message)
}

const FRESH = { member: null, offered: null, off: false, list: null, forced: false }

// The state as seen by `member`: another member's answer is never shown.
export function visibleDevices (state, member) {
  return state.member !== null && state.member === member ? state : { ...FRESH, forced: state.forced }
}

// A tiny store shared by the shell (hello, the notice) and Ajustes (the
// entry and the screen), bound to one member. offered: null until a call
// answered, true when the node has the methods, false when it answered
// unknown method. off: this device was disconnected. list: the last
// device.list answer, or null. forced: the shell locked the identity because
// this device was disconnected (the unlock screen says so until the next
// unlock). An answer for another member is dropped.
export function createDeviceStore () {
  let state = { ...FRESH }
  const listeners = new Set()
  const commit = (next) => {
    if (next.member === state.member && next.offered === state.offered && next.off === state.off && next.list === state.list && next.forced === state.forced) return
    state = next
    for (const fn of [...listeners]) fn()
  }
  return {
    get: () => state,
    // Binds the store to a member (null: none). A new member starts fresh;
    // a member appearing clears `forced` (the unlock happened).
    bind (member) {
      if (member === state.member) return
      commit({ ...FRESH, member, forced: member === null ? state.forced : false })
    },
    // An answer read for `member`: ignored when the store moved on.
    answer (member, patch) {
      if (member === null || member !== state.member) return
      commit({ ...state, ...patch })
    },
    forceLock () {
      commit({ ...state, forced: true })
    },
    // A devices.changed event carries no member: it is for the bound one.
    event (off) {
      if (state.member === null) return
      commit({ ...state, off: off === true })
    },
    subscribe (fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    }
  }
}

// device.list: records the answer in the store. Unknown method hides the
// entry; any other failure keeps what was known and rethrows for the caller.
export async function readDevices ({ request, store }) {
  const member = store.get().member
  try {
    const list = await request('device.list', {})
    const shaped = shapeList(list)
    store.answer(member, { offered: true, off: shaped.off, list })
    return shaped
  } catch (err) {
    if (unknownMethod(err)) store.answer(member, { offered: false, off: false, list: null })
    throw err
  }
}

// device.hello, once per app open by the caller. An unknown method is
// silent; every other failure is silent too and never retried (the next open
// tries again).
export async function sendHello ({ request, store, name }) {
  const member = store.get().member
  try {
    const r = await request('device.hello', { name })
    store.answer(member, { offered: true, off: !!r && r.off === true })
    return true
  } catch (err) {
    if (unknownMethod(err)) store.answer(member, { offered: false })
    return false
  }
}

// device.reconnect: one call. After a failure the list is read once (a read,
// not a retry) to settle whether this device is still off, and the failure
// is rethrown for the caller to show.
export async function reconnectDevice ({ request, store, name }) {
  const member = store.get().member
  try {
    await request('device.reconnect', { name })
  } catch (err) {
    try { await readDevices({ request, store }) } catch {}
    throw err
  }
  store.answer(member, { off: false, list: null })
}

// The shell calls this when hello may run: the member is known and online,
// and this open has not sent it for that member yet.
export function helloDue ({ member, online, sent }) {
  return typeof member === 'string' && online !== false && sent !== member
}

export const deviceStore = createDeviceStore()
