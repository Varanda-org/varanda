// "Sincronizar só no Wi-Fi": a per-device switch, on by default. Like the
// sound mute, reads are synchronous and the record is versioned JSON.
export const WIFI_ONLY_LABEL = 'Sincronizar só no Wi-Fi'
export const WIFI_ONLY_KEY = 'varanda-so-wifi'

let on = true
let bound = null
const listeners = new Set()

// Only an explicit stored "off" turns it off; absent or unreadable stays on,
// so losing the file never spends mobile data.
export function wifiOnlyOf (raw) {
  if (typeof raw !== 'string') return true
  try {
    const record = JSON.parse(raw)
    return !(record !== null && typeof record === 'object' && record.v === 1 && record.wifiOnly === false)
  } catch {
    return true
  }
}

export function bindWifiOnly (store) {
  if (bound) return
  bound = store
  try {
    on = wifiOnlyOf(store.getItem(WIFI_ONLY_KEY))
  } catch {}
}

export function wifiOnly () {
  return on
}

export function setWifiOnly (value) {
  if (typeof value !== 'boolean' || on === value) return false
  try {
    bound?.setItem(WIFI_ONLY_KEY, JSON.stringify({ v: 1, wifiOnly: value }))
  } catch {
    return false
  }
  on = value
  for (const fn of [...listeners]) {
    try { fn(value) } catch {}
  }
  return true
}

export function onWifiOnly (fn) {
  if (typeof fn !== 'function') return () => {}
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
