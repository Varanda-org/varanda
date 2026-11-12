// Account-origin audio in the browser (Audius through the account service).
// A plain audio element streams the ticket URL: no fetch, no blob, no Media
// Session, so nothing keeps playing once the page is gone. crossOrigin stays
// unset, since the page never reads the samples. The element itself resumes
// with Range when the service cuts a long response; there is no reconnect
// loop here. A failure is reported once through onError and the person
// retries with a tap. audio.web.js stays for local voice notes only.

import { isStreamUrl } from './streamUrl.js'

// The service waits up to 10 s for the provider's audio headers, and a far
// seek is a new Range request with the same wait, so the bound leaves room
// for that plus a slow link. It runs from the seek call, metadata included.
export const SEEK_WAIT_MS = 20000
export const SEEK_TOLERANCE_MS = 1000

const HAVE_METADATA = 1
const HAVE_FUTURE_DATA = 3

function streamError (message, code, cause) {
  const err = new Error(message)
  if (code !== undefined) err.code = code
  if (cause !== undefined) err.cause = cause
  return err
}

function listen (target, type, fn, offs) {
  target.addEventListener(type, fn)
  offs.push(() => target.removeEventListener(type, fn))
}

// origin: the base audiusPlay returned; null or undefined on the hosted web
// app, whose ticket path is relative.
export function createStreamPlayer (url, { origin } = {}) {
  if (!isStreamUrl(url, origin)) throw new Error('áudio inválido')
  let el = new globalThis.Audio()
  // Set now, not on play: the ticket exists only after a tap, and a snippet
  // start has to be confirmed by a seek before play.
  el.preload = 'metadata'
  el.src = url
  const listeners = new Set()
  const errorListeners = new Set()
  const offs = []
  let failed = false
  let pendingSeek = null

  const report = (err) => {
    if (el === null || failed) return
    failed = true
    for (const fn of [...errorListeners]) { try { fn(err) } catch {} }
  }

  const emit = (ended) => {
    if (el === null) return
    const duration = Number(el.duration)
    const playing = !el.paused && !el.ended
    const update = {
      ms: Math.round((Number(el.currentTime) || 0) * 1000),
      durationMs: Number.isFinite(duration) ? Math.round(duration * 1000) : 0,
      playing,
      ended,
      buffering: playing && Number(el.readyState) < HAVE_FUTURE_DATA
    }
    for (const fn of [...listeners]) { try { fn(update) } catch {} }
  }

  for (const type of ['timeupdate', 'play', 'pause', 'loadedmetadata', 'durationchange', 'waiting', 'canplay']) {
    listen(el, type, () => emit(false), offs)
  }
  listen(el, 'playing', () => { failed = false; emit(false) }, offs)
  listen(el, 'ended', () => emit(true), offs)
  listen(el, 'error', () => report(streamError('falha no áudio', 'media')), offs)

  return {
    play () {
      if (el === null) return Promise.resolve()
      let p
      try { p = el.play() } catch (err) { p = Promise.reject(err) }
      if (!p || typeof p.then !== 'function') return Promise.resolve()
      // A pause or a release before the start rejects with AbortError: the
      // person stopped it, nothing failed.
      return p.then(() => {}, (err) => {
        if (err?.name !== 'AbortError') report(streamError('falha no áudio', 'play', err))
      })
    },
    pause () { if (el !== null) el.pause() },
    // Resolves once the element has seeked to within SEEK_TOLERANCE_MS of the
    // target, so a caller can confirm the start before play. The element
    // clamps to what it can seek and still fires 'seeked': a position off the
    // target rejects ('seek-range') without onError, since the audio itself
    // is fine. Never starts playback.
    seek (ms) {
      if (el === null) return Promise.reject(streamError('áudio encerrado', 'released'))
      if (pendingSeek !== null) pendingSeek.cancel(streamError('busca substituída', 'superseded'))
      const target = Math.max(0, Number(ms) || 0) / 1000
      const a = el
      const seekOffs = []
      let timer = null
      let done = false
      const promise = new Promise((resolve, reject) => {
        const finish = (err) => {
          if (done) return
          done = true
          clearTimeout(timer)
          for (const off of seekOffs.splice(0)) { try { off() } catch {} }
          if (pendingSeek === entry) pendingSeek = null
          if (err === undefined) resolve()
          else reject(err)
        }
        const fail = (err) => {
          report(err)
          finish(err)
        }
        const entry = { cancel: finish }
        pendingSeek = entry
        const apply = () => {
          if (done) return
          // While a seek is pending, currentTime already shows its target.
          if (!a.seeking && Number(a.readyState) >= HAVE_METADATA && Number(a.currentTime) === target) return finish()
          try { a.currentTime = target } catch (err) { return fail(streamError('falha no áudio', 'seek', err)) }
        }
        listen(a, 'seeked', () => {
          // A 'seeked' queued by an earlier seek can arrive after this one
          // started: currentTime already shows this target, but the element
          // is still seeking.
          if (a.seeking) return
          if (Math.abs(Number(a.currentTime) - target) * 1000 <= SEEK_TOLERANCE_MS) finish()
          else finish(streamError('posição fora do áudio', 'seek-range'))
        }, seekOffs)
        listen(a, 'error', () => fail(streamError('falha no áudio', 'seek')), seekOffs)
        timer = setTimeout(() => fail(streamError('falha no áudio', 'seek-timeout')), SEEK_WAIT_MS)
        // Before metadata a position is only remembered, with no seeked
        // event: apply it once the element knows the duration.
        if (typeof a.readyState === 'number' && a.readyState < HAVE_METADATA) {
          listen(a, 'loadedmetadata', apply, seekOffs)
        } else {
          apply()
        }
      })
      return promise
    },
    onProgress (fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    onError (fn) {
      errorListeners.add(fn)
      return () => errorListeners.delete(fn)
    },
    release () {
      if (el === null) return
      const a = el
      el = null
      listeners.clear()
      errorListeners.clear()
      if (pendingSeek !== null) pendingSeek.cancel(streamError('áudio encerrado', 'released'))
      for (const off of offs) { try { off() } catch {} }
      try { a.pause() } catch {}
      try { a.removeAttribute('src'); a.load() } catch {}
    }
  }
}
