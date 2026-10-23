// The node configuration the person chooses on the native "Conectar" screen.
// It holds NO secret (an association public key, bootstrap addresses, the DHT
// choice). The rules mirror packages/core/lib/session.js checkConfig and
// packages/core/lib/config.js validBootstrap, so a bad value is caught before
// the node starts; the node still has the last word.

const HEX64 = /^[0-9a-fA-F]{64}$/

// Hostname or IPv4, exactly one colon, port 1..65535 with no leading zeros.
export function validBootstrap (entry) {
  const match = /^([A-Za-z0-9.-]+):([0-9]+)$/.exec(entry)
  if (!match) return false
  const port = Number(match[2])
  return String(port) === match[2] && Number.isSafeInteger(port) && port >= 1 && port <= 65535
}

// 'localhost', 127.0.0.0/8 or ::1 (packages/core/lib/config.js
// isLoopbackAddress).
export function isLoopbackAddress (host) {
  const text = String(host).toLowerCase()
  if (text === 'localhost' || text === '::1' || text === '[::1]') return true
  const m = /^127\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/.exec(text)
  return m !== null && m.slice(1).every((octet) => Number(octet) <= 255)
}

export function parseBootstrapText (text) {
  return String(text).split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
}

// form: { association, bootstrapText, publicDht, dhtHost }
// -> { config } with { association, bootstrap (array or null), dhtHost (string
// or null), allowPublicDht }, or { error } (pt-BR).
export function checkForm (form) {
  const association = String(form.association || '').trim()
  if (!HEX64.test(association)) return { error: 'chave da associação inválida (64 dígitos hexadecimais)' }
  const list = parseBootstrapText(form.bootstrapText || '')
  for (const entry of list) {
    if (!validBootstrap(entry)) return { error: 'bootstrap inválido: use host:porta, um por linha' }
  }
  const publicDht = form.publicDht === true
  if (publicDht && list.length > 0) return { error: 'bootstrap e DHT pública são exclusivos' }
  if (!publicDht && list.length === 0) return { error: 'informe ao menos um bootstrap ou ligue a DHT pública' }
  const host = String(form.dhtHost || '').trim()
  if (/\s/.test(host)) return { error: 'endereço da DHT inválido' }
  // A DHT bound to loopback never reaches a public peer (issue #10).
  if (publicDht && host !== '' && isLoopbackAddress(host)) {
    return { error: 'com a DHT pública, apague o endereço local da DHT: ' + host + ' só alcança este aparelho' }
  }
  return {
    config: {
      association: association.toLowerCase(),
      bootstrap: publicDht ? null : list,
      dhtHost: host === '' ? null : host,
      allowPublicDht: publicDht
    }
  }
}

export function formOf (config) {
  if (config === null || config === undefined) {
    return { association: '', bootstrapText: '', publicDht: false, dhtHost: '' }
  }
  return {
    association: config.association,
    bootstrapText: Array.isArray(config.bootstrap) ? config.bootstrap.join('\n') : '',
    publicDht: config.allowPublicDht === true,
    dhtHost: config.dhtHost || ''
  }
}

// The seeder's WebSocket address for the node in the browser, as
// packages/web-member/lib/seeder-url.js accepts it: ws: or wss:, a host, an
// optional port and path; no credentials, query or fragment.
export function validSeederUrl (text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 2048 || /\s/.test(text)) return false
  if (text.includes('#') || text.includes('?')) return false
  let url
  try {
    url = new URL(text)
  } catch {
    return false
  }
  return (url.protocol === 'ws:' || url.protocol === 'wss:') && url.hostname !== '' &&
    url.username === '' && url.password === ''
}

// Web, node in the browser. form: { association, seederUrl }; secure: the
// page itself is https (a browser refuses ws:// from it).
// -> { config: { association, seederUrl } } or { error } (pt-BR).
export function checkWebForm (form, { secure = false } = {}) {
  const association = String(form.association || '').trim()
  if (!HEX64.test(association)) return { error: 'chave da associação inválida (64 dígitos hexadecimais)' }
  const seederUrl = String(form.seederUrl || '').trim()
  if (!validSeederUrl(seederUrl)) {
    return { error: 'endereço do semeador inválido: use ws:// ou wss://, sem usuário, consulta ou fragmento' }
  }
  if (secure && seederUrl.slice(0, 5).toLowerCase() === 'ws://') {
    return { error: 'nesta página segura (https), o endereço do semeador deve começar com wss://' }
  }
  return { config: { association: association.toLowerCase(), seederUrl: new URL(seederUrl).href } }
}

export function webFormOf (config) {
  if (config === null || config === undefined) return { association: '', seederUrl: '' }
  return { association: config.association, seederUrl: config.seederUrl }
}

// A stored web configuration is only trusted after the same check.
export function reviveWeb (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return checkWebForm({ association: value.association, seederUrl: value.seederUrl }).config || null
}

// A stored value is only trusted after the same check (a hand-edited file).
export function revive (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const publicDht = value.allowPublicDht === true
  const host = typeof value.dhtHost === 'string' ? value.dhtHost : ''
  const checked = checkForm({
    association: value.association,
    bootstrapText: Array.isArray(value.bootstrap) ? value.bootstrap.filter((e) => typeof e === 'string').join('\n') : '',
    publicDht,
    // Saved before the loopback check: that host only kept the node off the
    // public DHT, so it is dropped rather than the whole configuration.
    dhtHost: publicDht && isLoopbackAddress(host.trim()) ? '' : host
  })
  return checked.config || null
}
