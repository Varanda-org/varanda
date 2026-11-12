// Account-origin audio on the phone (Audius through the account service).
// expo-audio streams the ticket URL itself: nothing is written to a file and
// no background or lock-screen playback is asked for, so the sound stops with
// the app. audio.native.js stays for local voice notes only. A failure is
// reported once through onError; there is no reconnect loop, the person
// retries with a tap.

import { createAudioPlayer, setAudioModeAsync } from 'expo-audio'
import { isHttpsOrigin, isStreamUrl } from './streamUrl.js'

async function playbackMode () {
  try { await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }) } catch {}
}

function streamError (message, code, cause) {
  const err = new Error(message)
  if (code !== undefined) err.code = code
  if (cause !== undefined) err.cause = cause
  return err
}

// The service waits up to 10 s for the provider's audio headers, and a far
// seek is a new Range request with the same wait, so both bounds leave room
// for that plus a slow mobile link.
export const LOAD_WAIT_MS = 20000
export const SEEK_WAIT_MS = 20000
export const SEEK_TOLERANCE_MS = 1000
const SEEK_POLL_MS = 250
// Without tolerances iOS may land on any keyframe, more than a second off,
// and the position check would never confirm. Half the tolerance on each
// side keeps the landing inside it while still letting AVPlayer start from a
// nearby sync point instead of decoding to the exact frame over the network.
// Android ignores both.
const SEEK_SIDE_MS = SEEK_TOLERANCE_MS / 2

// origin: the base audiusPlay returned. A phone has no document origin, so
// the URL must be absolute https on exactly that base.
export function createStreamPlayer (url, { origin } = {}) {
  if (!isHttpsOrigin(origin) || !isStreamUrl(url, origin)) throw new Error('áudio inválido')
  let player = createAudioPlayer({ uri: url }, { updateInterval: 250 })
  const listeners = new Set()
  const errorListeners = new Set()
  let failed = false
  let loaded = false
  // A pause or a release while the audio mode is being set must win over the
  // play that started it.
  let playSeq = 0
  let playWanted = false
  let lastMs = -1
  let watch = null
  let pendingSeek = null

  const report = (err) => {
    if (player === null || failed) return
    failed = true
    stopWatch()
    for (const fn of [...errorListeners]) { try { fn(err) } catch {} }
  }

  // On iOS a failed item (a 404, a retired ticket, a cut relay, a decode
  // error) emits no status at all, so a failure is also inferred from
  // silence: not loaded, or playing without progress, for LOAD_WAIT_MS.
  function stopWatch () {
    clearTimeout(watch)
    watch = null
  }
  function kickWatch () {
    stopWatch()
    if (player === null || failed) return
    watch = setTimeout(onWatch, LOAD_WAIT_MS)
  }
  function onWatch () {
    watch = null
    if (player === null) return
    if (!isLoadedNow()) return report(streamError('falha no áudio', 'load-timeout'))
    if (playWanted) report(streamError('falha no áudio', 'stall'))
  }

  function isLoadedNow () {
    if (loaded) return true
    try { if (player.isLoaded === true) loaded = true } catch {}
    return loaded
  }

  const sub = player.addListener('playbackStatusUpdate', (status) => {
    if (player === null) return
    const state = status?.playbackState
    // iOS may say 'failed'. Android's player has no error event: it drops
    // back to 'idle' after it had loaded.
    if (state === 'failed' || (state === 'idle' && loaded)) {
      report(streamError('falha no áudio', 'media'))
    } else if (state === 'ready' || state === 'buffering' || status?.isLoaded === true || Number(status?.duration) > 0) {
      loaded = true
    }
    const playing = status?.playing === true
    if (playing) failed = false
    const ms = Math.round((Number(status?.currentTime) || 0) * 1000)
    const ended = status?.didJustFinish === true
    if (ended) {
      playWanted = false
      stopWatch()
    } else if (playWanted && ms !== lastMs && loaded) {
      kickWatch()
    } else if (!playWanted && pendingSeek === null && loaded) {
      stopWatch()
    }
    lastMs = ms
    if (pendingSeek !== null) pendingSeek.check(status)
    const update = {
      ms,
      durationMs: Math.round((Number(status?.duration) || 0) * 1000),
      playing,
      ended,
      buffering: status?.isBuffering === true
    }
    for (const fn of [...listeners]) { try { fn(update) } catch {} }
  })

  return {
    async play () {
      if (player === null) return
      const seq = ++playSeq
      playWanted = true
      kickWatch()
      await playbackMode()
      if (player === null || seq !== playSeq) return
      try { player.play() } catch (err) { report(streamError('falha no áudio', 'play', err)) }
    },
    pause () {
      playSeq++
      playWanted = false
      if (pendingSeek === null) stopWatch()
      if (player !== null) { try { player.pause() } catch {} }
    },
    // Resolves only once the player is loaded and its position is within
    // SEEK_TOLERANCE_MS of the target: expo-audio's seekTo resolves on
    // Android as soon as the seek is asked, and on iOS also when the seek
    // was interrupted. A newer seek rejects this one ('superseded'), so does
    // release ('released'); neither is reported. A real failure is reported
    // once through onError. Never starts playback.
    seek (ms) {
      if (player === null) return Promise.reject(streamError('áudio encerrado', 'released'))
      if (pendingSeek !== null) pendingSeek.cancel(streamError('busca substituída', 'superseded'))
      const target = Math.max(0, Number(ms) || 0) / 1000
      const p = player
      let timer = null
      let poll = null
      let done = false
      let asked = false
      return new Promise((resolve, reject) => {
        const finish = (err) => {
          if (done) return
          done = true
          clearTimeout(timer)
          clearInterval(poll)
          if (pendingSeek === entry) pendingSeek = null
          if (!playWanted && pendingSeek === null && loaded) stopWatch()
          if (err === undefined) resolve()
          else reject(err)
        }
        const fail = (err) => {
          report(err)
          finish(err)
        }
        const confirm = (seconds, isLoaded, duration) => {
          if (done || !asked || !isLoaded) return
          if (duration > 0 && target > duration + SEEK_TOLERANCE_MS / 1000) {
            return finish(streamError('posição fora do áudio', 'seek-range'))
          }
          if (Math.abs(seconds - target) * 1000 <= SEEK_TOLERANCE_MS) finish()
        }
        const read = () => {
          if (player === null) return
          let seconds, isLoaded, duration
          try {
            seconds = Number(p.currentTime)
            isLoaded = p.isLoaded === true
            duration = Number(p.duration) || 0
          } catch { return }
          confirm(seconds, isLoaded, duration)
        }
        const entry = {
          cancel: finish,
          check: (status) => confirm(Number(status?.currentTime), status?.isLoaded === true, Number(status?.duration) || 0)
        }
        pendingSeek = entry
        timer = setTimeout(() => fail(streamError('falha no áudio', 'seek-timeout')), SEEK_WAIT_MS)
        if (!isLoadedNow() && watch === null) kickWatch()
        let asking
        try {
          asking = Promise.resolve(p.seekTo(target, SEEK_SIDE_MS, SEEK_SIDE_MS))
        } catch (err) {
          asking = Promise.reject(err)
        }
        asking.then(() => {
          if (done) return
          asked = true
          read()
          if (!done) poll = setInterval(read, SEEK_POLL_MS)
        }, (err) => {
          if (!done) fail(streamError('falha no áudio', 'seek', err))
        })
      })
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
      if (player === null) return
      const p = player
      if (pendingSeek !== null) pendingSeek.cancel(streamError('áudio encerrado', 'released'))
      player = null
      playSeq++
      playWanted = false
      stopWatch()
      listeners.clear()
      errorListeners.clear()
      try { sub.remove() } catch {}
      try { p.pause() } catch {}
      try { p.remove() } catch {}
    }
  }
}
