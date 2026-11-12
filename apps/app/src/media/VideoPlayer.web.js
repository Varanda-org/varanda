// A short video in the browser: a plain video element, for a local blob: or
// file: URI only. expo-video is never imported here, so it stays out of the
// web bundle. Inline playback, no download, fullscreen, picture-in-picture or
// remote playback. One video plays at a time (videoPlayers). Same props as
// VideoPlayer.native.js: { uri, playing, muted, controls, fit, style, startMs, inline, onReady,
// onEnd, onError, onSoundRefused, onProgress } plus onPlayBlocked, which only
// this one calls. When the browser refuses to play with sound, the video
// starts muted and onSoundRefused is called. When it refuses even muted (it
// wants a gesture), onPlayBlocked is called once per play attempt, never
// onError: the element keeps its source and its own controls, and a later
// play() plays normally. control, a ref, holds { play, unmute, progress } while the
// player of this uri is live: a press calls them in its own handler, because
// a browser that wants a gesture may not count the effect that applies the
// new props later.
// startMs resumes once metadata is ready; inline is ignored here. progress()
// reads the live { ms, durationMs, playing, ended }, or null once gone.

import React, { useEffect, useLayoutEffect, useRef } from 'react'
import { View } from 'react-native'
import {
  VIDEO_PROGRESS_MS,
  isLocalPlayable,
  playbackError,
  playRefusal,
  progressFromSeconds,
  reduceVideo,
  refusedSourceError,
  resumeSeconds,
  videoEffects,
  videoPlayers,
  videoState
} from './videoPlayback'

const FITS = new Set(['contain', 'cover', 'fill'])
const FILL = { width: '100%', height: '100%', display: 'block' }
// timeupdate may fire every frame in some browsers: keep about 250 ms.
const TICK_MS = VIDEO_PROGRESS_MS * 0.8

export default function VideoPlayer ({ uri, playing = false, muted = false, controls = false, fit = 'contain', style, startMs = 0, inline = false, onReady, onEnd, onError, onSoundRefused, onProgress, onPlayBlocked, control }) {
  const ref = useRef(null)
  const live = useRef(null)
  const controlRef = useRef(control)
  controlRef.current = control
  const callbacks = useRef({})
  callbacks.current = { onReady, onEnd, onError, onSoundRefused, onProgress, onPlayBlocked }
  const mutedRef = useRef(muted === true)
  mutedRef.current = muted === true
  const startRef = useRef(0)
  startRef.current = startMs
  const playingRef = useRef(playing === true)
  playingRef.current = playing === true
  const state = useRef(videoState(null))
  const local = isLocalPlayable(uri)

  // A layout effect: its cleanup runs in the commit itself, before any passive
  // effect of the parent, so the element drops the blob before the caller can
  // revoke it or swap the uri.
  useLayoutEffect(() => {
    state.current = videoState(uri, { muted: mutedRef.current })
    if (!isLocalPlayable(uri)) {
      try { callbacks.current.onError?.(refusedSourceError()) } catch {}
      return undefined
    }
    const el = ref.current
    if (!el) return undefined
    const token = {}
    let active = true
    let seeked = false
    let lastTick = 0
    const apply = (event) => {
      if (!active) return
      const prev = state.current
      const next = reduceVideo(prev, { ...event, uri })
      state.current = next
      for (const effect of videoEffects(prev, next)) emit(callbacks.current, effect)
      if (next.status === 'ended' || next.status === 'error') videoPlayers.release(token)
    }
    const position = (extra) => progressFromSeconds({ currentTime: el.currentTime, duration: el.duration, ...extra })
    // play() took the registry from the video that was playing: a video that
    // will not play gives it back and reports an error, so the caller does
    // not wait on a silent player. A rejection after the caller paused
    // changes nothing; the pause listener already reported it.
    const fail = () => {
      videoPlayers.release(token)
      apply({ type: 'error' })
    }
    // Refused even muted: the browser wants a gesture. Give the registry back
    // and tell the caller once; on mount both effects call play(), so both
    // rejections arrive for one attempt. The next pause or real playback
    // starts a new attempt.
    let blockedSent = false
    const block = () => {
      videoPlayers.release(token)
      if (blockedSent) return
      blockedSent = true
      try { callbacks.current.onPlayBlocked?.() } catch {}
    }
    const play = () => {
      videoPlayers.claim(token, () => { if (active) el.pause() })
      // The muted state this call ran with: on mount both effects call play(),
      // and the first rejection's retry mutes before the second one is read.
      const wasMuted = el.muted
      const attempt = el.play()
      if (!attempt || typeof attempt.catch !== 'function') return
      attempt.catch((err) => {
        if (!active || !playingRef.current) return
        const refusal = playRefusal(err, wasMuted)
        if (refusal === 'aborted') return
        if (refusal === 'failed') { fail(); return }
        if (refusal === 'blocked') { block(); return }
        el.muted = true
        apply({ type: 'soundRefused' })
        if (!playingRef.current) return
        const again = el.play()
        if (again && typeof again.catch === 'function') {
          again.catch((retryErr) => {
            if (!active || !playingRef.current) return
            const retried = playRefusal(retryErr, true)
            if (retried === 'failed') fail()
            else if (retried === 'blocked') block()
          })
        }
      })
    }
    const offs = []
    const on = (type, fn) => {
      el.addEventListener(type, fn)
      offs.push(() => el.removeEventListener(type, fn))
    }
    on('loadedmetadata', () => {
      if (!seeked) {
        seeked = true
        const seconds = resumeSeconds(startRef.current, el.duration * 1000)
        if (seconds !== null) {
          try { el.currentTime = seconds } catch {}
        }
      }
      apply({ type: 'ready', durationMs: position().durationMs })
    })
    on('playing', () => {
      // A 'playing' queued before another video claimed and paused this one
      // must not take the registry back from it.
      if (el.paused) return
      videoPlayers.claim(token, () => { if (active) el.pause() })
      blockedSent = false
      lastTick = Date.now()
      apply({ type: 'progress', ...position({ playing: true }) })
    })
    on('pause', () => { if (!el.ended) apply({ type: 'progress', ...position({ playing: false }) }) })
    on('timeupdate', () => {
      if (el.paused || el.ended) return
      const now = Date.now()
      if (now - lastTick < TICK_MS) return
      lastTick = now
      apply({ type: 'progress', ...position({ playing: true }) })
    })
    on('ended', () => apply({ type: 'ended', durationMs: position().durationMs }))
    on('error', () => apply({ type: 'error' }))
    el.muted = mutedRef.current
    el.src = uri
    live.current = {
      play,
      pause: () => {
        blockedSent = false
        el.pause()
      },
      ended: () => el.ended
    }
    const ctl = controlRef.current
    const handle = {
      play: () => {
        if (!active) return
        // The caller sets playing in the same press: a rejection that arrives
        // before that render must not be dropped as a pause.
        playingRef.current = true
        play()
      },
      unmute: () => {
        if (active) el.muted = false
      },
      progress: () => {
        if (!active || !ref.current) return null
        return progressFromSeconds({ currentTime: el.currentTime, duration: el.duration, playing: !el.paused, ended: el.ended })
      }
    }
    if (ctl) ctl.current = handle
    if (playingRef.current) play()
    return () => {
      active = false
      live.current = null
      if (ctl && ctl.current === handle) ctl.current = null
      videoPlayers.release(token)
      for (const off of offs) { try { off() } catch {} }
      try { el.pause() } catch {}
      try { el.removeAttribute('src'); el.load() } catch {}
    }
  }, [uri])

  useEffect(() => {
    if (ref.current) ref.current.muted = muted === true
  }, [muted])

  useEffect(() => {
    const player = live.current
    if (player === null) return
    if (playing === true) player.play()
    else player.pause()
  }, [playing])

  if (!local) return null
  return (
    <View style={style}>
      <video
        key={uri}
        ref={ref}
        playsInline
        preload='metadata'
        controls={controls === true}
        controlsList='nodownload nofullscreen noremoteplayback'
        disablePictureInPicture
        disableRemotePlayback
        x-webkit-airplay='deny'
        style={{ ...FILL, objectFit: FITS.has(fit) ? fit : 'contain' }}
      />
    </View>
  )
}

function emit (cb, effect) {
  try {
    if (effect.type === 'ready') cb.onReady?.({ durationMs: effect.durationMs })
    else if (effect.type === 'progress') cb.onProgress?.({ ms: effect.ms, durationMs: effect.durationMs, playing: effect.playing, ended: effect.ended })
    else if (effect.type === 'end') cb.onEnd?.()
    else if (effect.type === 'soundRefused') cb.onSoundRefused?.()
    else if (effect.type === 'error') cb.onError?.(playbackError())
  } catch {}
}
