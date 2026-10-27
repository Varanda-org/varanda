/* global navigator, document, window, fetch */

// Web: registers the service worker on a hosted installation whose document
// carries the release marker the export generator inserts into dist/index.html
// (never public/index.html). Never throws.

import { hostedPage } from './configStore'
import { webMode } from './client/mode'
import { pwaBoot } from './pwa-boot'
import { RELEASE_CHECK_MS, parseWorkerRelease, releaseState, shouldCheck } from './release'

// The version assignment is near the top of the rendered worker. Read at most
// 64 KiB and ignore the rest, so a long precache cannot pin memory here.
const RELEASE_TEXT_MAX = 64 * 1024

function bootFor (meta) {
  return pwaBoot({
    mode: webMode,
    hosted: hostedPage,
    hasMarker: !!meta && !!meta.getAttribute('content'),
    hasServiceWorker: typeof navigator === 'object' && navigator !== null && !!navigator.serviceWorker
  })
}

export function startPwa () {
  try {
    const meta = document.querySelector('meta[name="varanda-release"]')
    const boot = bootFor(meta)
    if (boot.action !== 'register') return Promise.resolve(false)
    return Promise.resolve(navigator.serviceWorker.register(boot.url, { scope: boot.scope, updateViaCache: boot.updateViaCache }))
      .then(() => true, () => false)
  } catch {
    return Promise.resolve(false)
  }
}

function cancelReader (reader) {
  try { reader.cancel().catch(() => {}) } catch {}
}

function takeBytes (value, length) {
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) out[i] = value[i]
  return out
}

// The release id is ASCII, so each byte maps to one character.
function decodeBytes (bytes) {
  let text = ''
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i])
  return text
}

// -> string (possibly a prefix) or null when the body cannot be read.
async function readWorkerStream (reader) {
  const chunks = []
  let total = 0
  for (;;) {
    const part = await reader.read()
    if (!part || part.done) break
    const value = part.value
    if (!value || typeof value.byteLength !== 'number' || typeof value.subarray !== 'function') {
      cancelReader(reader)
      return null
    }
    if (value.byteLength < 1) continue
    const room = RELEASE_TEXT_MAX - total
    const take = value.byteLength > room ? room : value.byteLength
    if (take > 0) {
      chunks.push(takeBytes(value, take))
      total += take
    }
    if (value.byteLength > room || total >= RELEASE_TEXT_MAX) {
      cancelReader(reader)
      break
    }
  }
  const bytes = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  return decodeBytes(bytes)
}

async function readWorkerText (res) {
  try {
    if (res && res.body && typeof res.body.getReader === 'function') {
      return await readWorkerStream(res.body.getReader())
    }
    if (res && typeof res.text === 'function') {
      const text = await res.text()
      if (typeof text !== 'string') return null
      return text.length > RELEASE_TEXT_MAX ? text.slice(0, RELEASE_TEXT_MAX) : text
    }
  } catch {}
  return null
}

// Compare the running document with the release /sw.js serves now. An
// installing worker only prompts that comparison: the person chooses when
// to reload, and nothing here activates the waiting worker.
export function watchRelease (onChange) {
  let stopped = false
  let seq = 0
  const removers = []
  const stop = () => {
    stopped = true
    seq += 1
    for (const remove of removers.splice(0)) {
      try { remove() } catch {}
    }
  }
  const attach = (target, name, fn) => {
    try {
      target.addEventListener(name, fn)
      removers.push(() => target.removeEventListener(name, fn))
    } catch {}
  }

  try {
    const meta = document.querySelector('meta[name="varanda-release"]')
    if (bootFor(meta).action !== 'register') return stop
    const running = meta.getAttribute('content')
    const sw = navigator.serviceWorker
    // startPwa may still be registering on the first visit. ready covers that
    // race without registering again or touching an unrelated registration.
    const registration = typeof sw.getRegistration === 'function'
      ? Promise.resolve(sw.getRegistration()).then((reg) => reg || sw.ready)
      : sw.ready
    Promise.resolve(registration).then((reg) => {
      if (stopped || !reg) return
      let lastCheck = null
      let interval
      let update
      const workers = new Set()
      const deliver = (served, token) => {
        if (stopped || token !== seq) return
        try {
          const state = releaseState({ running, served })
          if (state.update !== update) {
            update = state.update
            try { onChange(state) } catch {}
          }
        } catch {}
      }
      // A newer check, or unsubscribe, drops a response that arrives late.
      const compare = () => {
        if (stopped) return
        const token = ++seq
        try {
          const worker = reg.installing
          if (worker && !workers.has(worker)) {
            workers.add(worker)
            attach(worker, 'statechange', compare)
          }
        } catch {}
        try {
          const pending = fetch('/sw.js', { cache: 'no-store', credentials: 'omit' })
          Promise.resolve(pending).then((res) => {
            if (stopped || token !== seq || !res || res.ok !== true) return null
            return readWorkerText(res)
          }, () => null).then((text) => {
            if (typeof text !== 'string' || stopped || token !== seq) return
            // An answer without a readable release (an empty or torn /sw.js
            // during an in-place deploy) is a failed check: keep the state.
            const served = parseWorkerRelease(text)
            if (served === null) return
            deliver(served, token)
          }).catch(() => {})
        } catch {}
      }
      // A periodic tick is already paced by its interval: it only needs the
      // page visible. Through shouldCheck it could land a millisecond short
      // of RELEASE_CHECK_MS after the first check and be refused, leaving
      // nearly an hour between background checks.
      const check = (focus = false, periodic = false) => {
        if (stopped) return
        let due = false
        try {
          const now = Date.now()
          const visible = document.visibilityState === 'visible'
          if (periodic ? visible : shouldCheck({ now, lastCheck, visible, focus })) {
            // Failed/offline attempts also count, preventing repeated focus
            // events from hammering the network. Later checks can retry.
            lastCheck = now
            due = true
            // Anchor the next periodic check to this focus check, otherwise
            // the cooldown could skip a tick and leave nearly an hour's gap.
            if (focus) {
              try {
                clearInterval(interval)
                interval = setInterval(tick, RELEASE_CHECK_MS)
              } catch {}
            }
          }
        } catch {}
        if (!due || stopped) return
        try { Promise.resolve(reg.update()).then(() => {}, () => {}) } catch {}
        compare()
      }
      const tick = () => check(false, true)
      attach(reg, 'updatefound', compare)
      attach(document, 'visibilitychange', () => check(true))
      attach(window, 'focus', () => check(true))
      try {
        interval = setInterval(tick, RELEASE_CHECK_MS)
        removers.push(() => clearInterval(interval))
      } catch {}
      check()
    }).catch(() => {})
  } catch {}
  return stop
}
