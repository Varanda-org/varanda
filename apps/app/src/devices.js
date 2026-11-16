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

function systemOf (ua) {
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua)) return 'iPad'
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
// constants give "Pixel 8" (Android: brand and model) or "iPhone" / "iPad"
// (iOS: the interface idiom). `env` is { userAgent, constants } with both
// optional; with nothing usable the name is UNNAMED_SELF.
export function deviceName (env) {
  const e = env !== null && typeof env === 'object' ? env : {}
  const ua = typeof e.userAgent === 'string' ? e.userAgent : ''
  const browser = browserOf(ua)
  const system = systemOf(ua)
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

// A tiny store shared by the shell (hello, the notice) and Ajustes (the
// entry and the screen). offered: null until a call answered, true when the
// node has the methods, false when it answered unknown method. off: this
// device was disconnected. list: the last device.list answer, or null.
export function createDeviceStore () {
  let state = { offered: null, off: false, list: null }
  const listeners = new Set()
  return {
    get: () => state,
    set (patch) {
      const next = { ...state, ...patch }
      if (next.offered === state.offered && next.off === state.off && next.list === state.list) return
      state = next
      for (const fn of [...listeners]) fn()
    },
    reset () {
      this.set({ offered: null, off: false, list: null })
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
  try {
    const list = await request('device.list', {})
    const shaped = shapeList(list)
    store.set({ offered: true, off: shaped.off, list })
    return shaped
  } catch (err) {
    if (unknownMethod(err)) store.set({ offered: false, off: false, list: null })
    throw err
  }
}

// device.hello, once per app open by the caller. An unknown method is
// silent; every other failure is silent too and never retried (the next open
// tries again).
export async function sendHello ({ request, store, name }) {
  try {
    const r = await request('device.hello', { name })
    store.set({ offered: true, off: !!r && r.off === true })
    return true
  } catch (err) {
    if (unknownMethod(err)) store.set({ offered: false })
    return false
  }
}

// device.reconnect: one call. The failure is the caller's to show.
export async function reconnectDevice ({ request, store, name }) {
  await request('device.reconnect', { name })
  store.set({ off: false, list: null })
}

// The shell calls this when hello may run: the member is unlocked and
// online, and this open has not sent it for that member yet.
export function helloDue ({ member, online, sent }) {
  return typeof member === 'string' && online !== false && sent !== member
}

export const deviceStore = createDeviceStore()
