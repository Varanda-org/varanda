// A short video on the phone: expo-video's player plus its view, for a local
// file only (file:// or blob:, the node wrote and checked it). No fullscreen,
// no picture-in-picture, no AirPlay or cast, no background playback and no
// lock-screen controls. One video plays at a time (videoPlayers). The web
// sibling is VideoPlayer.web.js, with the same props:
// { uri, playing, muted, controls, fit, onReady, onEnd, onError,
//   onSoundRefused, onProgress }. onProgress gets { ms, durationMs, playing,
// ended } about every 250 ms while playing and once on a pause. control, a
// ref, holds { play, unmute } while the player of this uri is live, the
// contract the web sibling needs for a press; expo-video needs no gesture.

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createVideoPlayer, VideoView } from 'expo-video'
import {
  VIDEO_PROGRESS_MS,
  isLocalPlayable,
  playbackError,
  progressFromSeconds,
  reduceVideo,
  refusedSourceError,
  videoEffects,
  videoPlayers,
  videoState
} from './videoPlayback'

const FITS = new Set(['contain', 'cover', 'fill'])

export default function VideoPlayer ({ uri, playing = false, muted = false, controls = false, fit = 'contain', style, onReady, onEnd, onError, onSoundRefused, onProgress, control }) {
  const [current, setCurrent] = useState(null)
  const callbacks = useRef({})
  callbacks.current = { onReady, onEnd, onError, onSoundRefused, onProgress }
  const mutedRef = useRef(muted === true)
  mutedRef.current = muted === true
  const state = useRef(videoState(null))

  // A layout effect: its cleanup runs in the commit itself, before the
  // parent's passive cleanups, and stops and releases the player. expo-video
  // finishes the native teardown later, on the main thread, so a file the
  // caller deletes then is unlinked while the player may still hold it open:
  // the open descriptor keeps the data until it closes.
  useLayoutEffect(() => {
    state.current = videoState(uri, { muted: mutedRef.current })
    if (!isLocalPlayable(uri)) {
      try { callbacks.current.onError?.(refusedSourceError()) } catch {}
      return undefined
    }
    const token = {}
    let p = createVideoPlayer({ uri })
    const apply = (event) => {
      if (p === null) return
      const prev = state.current
      const next = reduceVideo(prev, { ...event, uri })
      state.current = next
      for (const effect of videoEffects(prev, next)) emit(callbacks.current, effect)
      if (next.status === 'ended' || next.status === 'error') videoPlayers.release(token)
    }
    const position = (extra) => progressFromSeconds({ currentTime: p.currentTime, duration: p.duration, ...extra })
    configure(p, {
      loop: false,
      muted: mutedRef.current,
      allowsExternalPlayback: false,
      staysActiveInBackground: false,
      showNowPlayingNotification: false,
      timeUpdateEventInterval: VIDEO_PROGRESS_MS / 1000
    })
    const subs = [
      p.addListener('statusChange', ({ status }) => {
        if (status === 'readyToPlay') apply({ type: 'ready', durationMs: position().durationMs })
        else if (status === 'error') apply({ type: 'error' })
      }),
      p.addListener('playingChange', ({ isPlaying }) => {
        // A change queued before another video claimed and paused this one
        // must not take the registry back from it.
        if (isPlaying && p !== null && p.playing === true) videoPlayers.claim(token, () => { if (p !== null) p.pause() })
        apply({ type: 'progress', ...position({ playing: isPlaying === true }) })
      }),
      p.addListener('timeUpdate', ({ currentTime }) => {
        apply({ type: 'progress', ...progressFromSeconds({ currentTime, duration: p.duration, playing: p.playing }) })
      }),
      p.addListener('playToEnd', () => apply({ type: 'ended', durationMs: position().durationMs }))
    ]
    const entry = { player: p, token, uri, released: false }
    setCurrent(entry)
    return () => {
      const released = p
      p = null
      entry.released = true
      videoPlayers.release(token)
      for (const sub of subs) { try { sub.remove() } catch {} }
      try { released.pause() } catch {}
      try { released.release() } catch {}
      setCurrent(null)
    }
  }, [uri])

  // In the commit that swaps the uri, current still holds the old player until
  // the new one is set: the view unmounts now instead of staying bound to a
  // player being released, and the effects skip a released player, which
  // expo-video would throw on.
  const live = current !== null && current.uri === uri && !current.released ? current : null
  useEffect(() => {
    if (live !== null && !live.released) configure(live.player, { muted: muted === true })
  }, [live, muted])

  useEffect(() => {
    if (live === null || live.released) return
    const { player, token } = live
    try {
      if (playing === true) {
        videoPlayers.claim(token, () => { try { player.pause() } catch {} })
        if (state.current.status === 'ended') player.replay()
        else player.play()
      } else {
        player.pause()
      }
    } catch {}
  }, [live, playing])

  useLayoutEffect(() => {
    if (!control || live === null || live.released) return undefined
    const handle = {
      play: () => {
        if (live.released) return
        const { player, token } = live
        try {
          videoPlayers.claim(token, () => { try { player.pause() } catch {} })
          if (state.current.status === 'ended') player.replay()
          else player.play()
        } catch {}
      },
      unmute: () => {
        if (!live.released) configure(live.player, { muted: false })
      }
    }
    control.current = handle
    return () => {
      if (control.current === handle) control.current = null
    }
  }, [live, control])

  if (live === null) return null
  return (
    <VideoView
      player={live.player}
      style={style}
      nativeControls={controls === true}
      contentFit={FITS.has(fit) ? fit : 'contain'}
      fullscreenOptions={{ enable: false }}
      allowsPictureInPicture={false}
      startsPictureInPictureAutomatically={false}
      allowsVideoFrameAnalysis={false}
    />
  )
}

// A property one platform lacks (allowsExternalPlayback is iOS only) must not
// stop the others from being set.
function configure (player, props) {
  for (const [key, value] of Object.entries(props)) {
    try { player[key] = value } catch {}
  }
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
