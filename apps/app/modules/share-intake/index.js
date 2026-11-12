import { requireNativeModule } from 'expo-modules-core'

let native = null
try {
  native = requireNativeModule('ShareIntake')
} catch {}

const ID_RE = /^[0-9]{13}-[0-9a-f]{32}$/
const TEXT_MAX = 4000
const FILE_MAX = 10

export function isAvailable () {
  return native !== null
}

function validId (id) {
  return typeof id === 'string' && ID_RE.test(id)
}

function cutText (value) {
  if (typeof value !== 'string') return ''
  if (value.length <= TEXT_MAX) return value
  // Keep surrogate pairs intact at the length limit.
  let end = TEXT_MAX
  const tail = value.charCodeAt(end - 1)
  const next = value.charCodeAt(end)
  if (tail >= 0xd800 && tail <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1
  return value.slice(0, end)
}

function positiveInt (n) {
  return Number.isSafeInteger(n) && n > 0
}

function unsafePath (path) {
  for (const char of path) {
    const code = char.charCodeAt(0)
    if (char === '%' || char === '?' || char === '#' || code <= 0x1f || code === 0x7f) return true
  }
  return false
}

// The composer reads these uris. Keep a file only when it sits in this share's
// intake directory, so a bad native answer cannot point at an arbitrary path.
function fileOf (entry, id) {
  if (!entry || typeof entry !== 'object') return null
  const uri = entry.uri
  const mimeType = entry.mimeType
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return null
  const path = uri.slice('file://'.length)
  if (!path.startsWith('/') || unsafePath(path)) return null
  const segments = path.split('/')
  if (segments.some(segment => segment === '.' || segment === '..')) return null
  if (segments.at(-3) !== 'varanda-share' || segments.at(-2) !== id) return null
  if (!/^[0-9]{1,2}\.(jpg|png|gif|webp|heic|img)$/.test(segments.at(-1))) return null
  if (typeof mimeType !== 'string') return null
  if (!positiveInt(entry.width) || !positiveInt(entry.height)) return null
  return { uri, mimeType, width: entry.width, height: entry.height }
}

function normalize (answer) {
  if (!answer || typeof answer !== 'object') return null
  const id = answer.id
  if (!validId(id) || !Number.isSafeInteger(answer.at)) return null
  const files = []
  if (Array.isArray(answer.files)) {
    for (const entry of answer.files) {
      if (files.length >= FILE_MAX) break
      const file = fileOf(entry, id)
      if (file) files.push(file)
    }
  }
  let total = Number.isSafeInteger(answer.total) ? answer.total : files.length
  if (total < files.length) total = files.length
  return {
    id,
    at: answer.at,
    title: cutText(answer.title),
    text: cutText(answer.text),
    url: cutText(answer.url),
    total,
    files
  }
}

// A request that arrives during a read needs a fresh native snapshot.
let flight = null
let waiting = null

async function readPeek () {
  try {
    if (native === null || typeof native.peek !== 'function') return null
    return normalize(await native.peek())
  } catch {
    return null
  }
}

export function peek () {
  if (flight === null) return startPeek()
  if (waiting === null) {
    let resolveWaiting
    const promise = new Promise((resolve) => { resolveWaiting = resolve })
    waiting = { promise, resolve: resolveWaiting }
  }
  return waiting.promise
}

function startPeek () {
  const current = readPeek()
  flight = current
  current.then(() => finishPeek(current), () => finishPeek(current))
  return current
}

function finishPeek (current) {
  if (flight !== current) return
  flight = null
  const joined = waiting
  waiting = null
  if (joined === null) return
  const next = startPeek()
  next.then(joined.resolve, joined.resolve)
}

export async function release (id) {
  if (!validId(id)) return
  try {
    if (native === null || typeof native.release !== 'function') return
    await native.release(id)
  } catch {}
}

export async function sweep (ms) {
  if (!Number.isSafeInteger(ms) || ms <= 0) return
  try {
    if (native === null || typeof native.sweep !== 'function') return
    await native.sweep(ms)
  } catch {}
}

// Sair and Recomeçar. The native side has no call that removes everything,
// so the share peek offers goes by id (its time may be past the clock's), then
// a 1 ms sweep takes every older one.
export async function clear () {
  try {
    if (native === null) return
    const current = await readPeek()
    if (current !== null && typeof native.release === 'function') await native.release(current.id)
  } catch {}
  try {
    if (native !== null && typeof native.sweep === 'function') await native.sweep(1)
  } catch {}
}

export function listen (fn) {
  let sub = null
  try {
    if (native === null || typeof native.addListener !== 'function') return function () {}
    sub = native.addListener('onPending', fn)
  } catch {
    return function () {}
  }
  return function () {
    const current = sub
    sub = null
    try {
      if (current && typeof current.remove === 'function') current.remove()
    } catch {}
  }
}
