/* global document, AbortController */

// The photos of a post under its text (1 to 10, MAX_MEDIA_PER_POST in
// ../media/plan.js). One keeps its aspect ratio (clamped 0.5..2). Two to ten
// are a swipeable MediaCarousel with dots and a counter, so each photo gets
// the full width instead of a thumbnail; quote cards pass mosaic to keep the
// compact grid (two side by side, one big and two stacked, 2x2), which has no
// room for dots. Past four, that grid still shows the first four tiles and
// paints "+N" on the last one. The scrim takes no touches and stays out of
// assistive tech, so a tap still opens the viewer on photo 4, and the viewer
// gets every photo. A tap opens the full-screen viewer, which fits the photo,
// moves with the same carousel, the arrow buttons or the keyboard arrows (web,
// only while open), closes with its button or Escape, and labels each photo
// 'foto N de M'. Closing leaves the feed on the last photo seen. Descriptors
// are passed through untouched: MediaView validates them before any request.
// A video post is the pair [JPEG poster, video/mp4]. The feed and a quote
// show that poster once, with a play mark and the duration. Nothing of the
// clip is fetched before a tap, which plays inside the post with sound and
// platform controls. claimPlayback, bound, shares one player with music and
// voice notes: another player, a tab or screen change, a full-screen photo,
// backgrounding the app or scrolling mostly away returns the cover and
// releases the file. 'ver em tela cheia' keeps the same file and position.
// A failed load waits for one explicit retry.
// persist (default true) goes to every tile and the viewer: false for authors
// the device does not follow. The rounded clip sits on the photo frame, not
// the outer view, so the dots row below it is never cut.

import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Modal, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { fetch as expoFetch } from 'expo/fetch'
import { useEscapeLayer } from './escapeLayer'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { isAppClient } from '../appClient'
import { counterText, frameRatio, slideLabel } from '../carousel'
import { revokeUrl, urlFromBytes } from '../media/display'
import { fetchVideo } from '../media/fetch'
import { durationLabel, MAX_MEDIA_PER_POST, gridLayout, mosaicLayout, videoPair } from '../media/plan'
import { claimPlayback, stopBoundPlayback } from '../media/chatMedia'
import VideoPlayer from '../media/VideoPlayer'
import { useHosted } from '../node'
import { Icon } from './Icon'
import { MediaCarousel } from './MediaCarousel'
import { MediaView, mediaHashDeps } from './MediaView'
import { OPEN_GRACE_MS, VISIBILITY_MS, holdEmbeds, mostlyHidden } from '../embedLive'
import { TabBarShown } from './tabBarShown'
import { layout } from './theme'

const GAP = 2

const stopClick = (e) => { if (e && typeof e.stopPropagation === 'function') e.stopPropagation() }
// On the web, Enter and Space press the post's Pressable. The inline frame
// stops only those, so Escape on a focused player still reaches the app.
const stopPressKeys = (e) => {
  if (e && (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar')) stopClick(e)
}

// Same choice as MediaView: the native app streams through expo/fetch so the
// byte cap can abort the download.
const mediaFetch = () => (isAppClient() ? expoFetch : undefined)

function ratioOf (d) {
  const r = d && d.width > 0 && d.height > 0 ? d.width / d.height : 1
  return Number.isFinite(r) ? Math.max(0.5, Math.min(2, r)) : 1
}

// The same whole second durationLabel shows, so the spoken count matches the chip.
function videoSeconds (ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 0
  return Math.ceil(ms / 1000)
}

function videoId (d) {
  if (!d || typeof d !== 'object') return ''
  return [d.core, d.start, d.blocks, d.bytes, d.sha256, d.ms, d.width, d.height, d.mime].join(':')
}

function Viewer ({ author, media, index, onIndex, onClose, persist }) {
  const insets = useSafeAreaInsets()
  const open = index !== null
  const count = media.length
  const go = (delta) => {
    if (index === null) return
    const next = index + delta
    if (next >= 0 && next < count) onIndex(next)
  }
  const goRef = useRef(go)
  goRef.current = go
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  // The full-screen viewer hides a playing music player without a screen change the App could see.
  // Provider frames stay unmounted for as long as the viewer is open.
  useEffect(() => {
    if (!open) return undefined
    stopBoundPlayback()
    return holdEmbeds()
  }, [open])

  // Escape closes only the viewer, even over a sheet (src/ui/escapeLayer.js).
  useEscapeLayer(!!open, () => closeRef.current(), 'viewer')
  useEffect(() => {
    if (!open || Platform.OS !== 'web' || typeof document === 'undefined') return
    const onKey = (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      // Left alone, the browser also scrolls the feed carousel under the
      // viewer, the last strip that was clicked.
      event.preventDefault()
      goRef.current(event.key === 'ArrowLeft' ? -1 : 1)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null
  return (
    <Modal visible animationType='fade' transparent={false} statusBarTranslucent onRequestClose={onClose}>
      <View
        onClick={stopClick}
        onStartShouldSetResponder={() => true}
        style={[styles.viewer, { paddingTop: insets.top, paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right }]}
      >
        <View style={styles.viewerTop}>
          <Pressable accessibilityRole='button' accessibilityLabel='fechar' onPress={onClose} hitSlop={10} style={styles.viewerBtn}>
            <Icon name='x' size={26} color='#ffffff' />
          </Pressable>
          {count > 1 ? <Text style={styles.viewerCount}>{counterText(index, count)}</Text> : null}
          <View style={styles.viewerBtn} />
        </View>
        <View style={styles.viewerBody}>
          <MediaCarousel
            author={author}
            media={media}
            persist={persist}
            index={index}
            onIndex={onIndex}
            fit='contain'
            dark
            showDots
            showCounter={false}
            showArrows={false}
            claimTouch
            frameStyle={styles.viewerFrame}
            style={styles.viewerImage}
          />
          {index > 0
            ? (
              <Pressable accessibilityRole='button' accessibilityLabel='foto anterior' onPress={() => go(-1)} style={[styles.arrow, styles.arrowLeft]}>
                <Icon name='chevron-left' size={30} color='#ffffff' />
              </Pressable>
              )
            : null}
          {index < count - 1
            ? (
              <Pressable accessibilityRole='button' accessibilityLabel='próxima foto' onPress={() => go(1)} style={[styles.arrow, styles.arrowRight]}>
                <Icon name='chevron-right' size={30} color='#ffffff' />
              </Pressable>
              )
            : null}
        </View>
      </View>
    </Modal>
  )
}

function useVideoClip ({ author, video }) {
  const hosted = useHosted() === true
  const id = videoId(video)
  const videoRef = useRef(video)
  videoRef.current = video
  const [attempt, setAttempt] = useState(-1)
  const [phase, setPhase] = useState('loading')
  const [uri, setUri] = useState(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (uri === null) return undefined
    const current = uri
    // VideoPlayer's layout cleanup runs before this passive cleanup, so the
    // file is free to delete or the blob free to revoke.
    return () => { revokeUrl(current) }
  }, [uri])

  useEffect(() => {
    if (attempt < 0) return undefined
    let alive = true
    // This attempt owns the URL it made: an unmount between setUri and its
    // commit drops the state update, and then only this cleanup can release
    // it. revokeUrl is idempotent, so the [uri] cleanup may release it too.
    let made = null
    const descriptor = videoRef.current
    if (hosted !== true) {
      setUri(null)
      setPhase('error')
      return () => { alive = false }
    }
    setUri(null)
    setPhase('loading')
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null
    fetchVideo(author, descriptor, {
      ...mediaHashDeps(),
      fetch: mediaFetch(),
      urlFromBytes,
      signal: ctrl !== null ? ctrl.signal : undefined
    }).then((got) => {
      if (!alive) {
        if (typeof got === 'string' && got !== '') revokeUrl(got)
        return
      }
      if (typeof got !== 'string' || got === '') {
        setPhase('error')
        return
      }
      made = got
      setUri(got)
      setPhase('ready')
    }, () => {
      if (alive) setPhase('error')
    })
    // hosted is read for this attempt only: a later connection does not fetch
    // by itself. The person taps 'Tentar de novo'.
    return () => {
      alive = false
      if (ctrl !== null) ctrl.abort()
      if (made !== null) revokeUrl(made)
    }
  }, [author, id, attempt])

  const fail = useCallback(() => {
    if (!mounted.current) return
    setUri(null)
    setPhase('error')
  }, [])
  const retry = useCallback(() => {
    setUri(null)
    setPhase('loading')
    setAttempt((n) => n + 1)
  }, [])

  const start = useCallback(() => {
    setAttempt((n) => n < 0 ? 0 : n)
  }, [])
  const reset = useCallback(() => {
    setAttempt(-1)
    setUri(null)
    setPhase('loading')
  }, [])

  return { active: attempt >= 0, phase, uri, start, retry, fail, reset }
}

function VideoStage ({ uri, full, startMs, playing, muted, setMuted, blocked, setBlocked, control, onProgress, fail }) {
  return (
    <View style={styles.viewerImage}>
      <VideoPlayer
        uri={uri}
        playing={playing}
        muted={muted}
        controls
        fit='contain'
        inline={!full}
        startMs={startMs}
        style={styles.viewerImage}
        onError={fail}
        onSoundRefused={() => setMuted(true)}
        onPlayBlocked={() => setBlocked(true)}
        onProgress={onProgress}
        control={control}
      />
      {muted || blocked
        ? (
          <View pointerEvents='box-none' style={full ? styles.videoBar : styles.videoChipsOverlay}>
            <View style={full ? styles.videoBarContent : styles.videoChips}>
              {blocked ? <Text style={styles.videoHint}>Toque no play para assistir</Text> : null}
              {muted
                ? (
                  <Pressable accessibilityRole='button' accessibilityLabel='Ativar som' onPress={() => { control.current?.unmute(); setMuted(false) }} style={styles.retryBtn}>
                    <Text style={styles.retryText}>Ativar som</Text>
                  </Pressable>
                  )
                : null}
            </View>
          </View>
          )
        : null}
    </View>
  )
}

// The poster owns the press so even a failed image can start the clip inside
// the post. Its image and marks take no touches and stay out of assistive
// tech. No player or clip request exists before this explicit tap.
function VideoPoster ({ author, poster, video, persist, onPress }) {
  const seconds = videoSeconds(video && video.ms)
  const label = 'vídeo de ' + seconds + (seconds === 1 ? ' segundo' : ' segundos')
  return (
    <Pressable
      accessibilityRole='button'
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.videoFrame, pressed && styles.pressed]}
    >
      <View pointerEvents='none' accessibilityElementsHidden importantForAccessibility='no-hide-descendants' aria-hidden>
        <MediaView
          author={author}
          descriptor={poster}
          persist={persist}
          label={label}
          style={[styles.cell, styles.clip, { width: '100%', aspectRatio: frameRatio([poster]) }]}
          tapRetry={false}
        />
      </View>
      <View pointerEvents='none' style={styles.videoOverlay} accessibilityElementsHidden importantForAccessibility='no-hide-descendants' aria-hidden>
        <View style={styles.playMark}>
          <Icon name='tocar' size={22} color='#ffffff' />
        </View>
        <View style={styles.durationMark}>
          <Text style={styles.durationText}>{durationLabel(video && video.ms)}</Text>
        </View>
      </View>
    </Pressable>
  )
}

// Full screen borrows the tile's file and position, so expanding never
// downloads again. A failed load still waits for one explicit retry. Closing
// this layer returns to the inline player; losing the bound claim instead
// closes the tile and releases its file after the player's layout cleanup.
function VideoViewer ({ clip, stage, onRetry, onClose }) {
  const insets = useSafeAreaInsets()
  useEscapeLayer(true, onClose, 'viewer')
  // Mounted only while the video is full screen: the cards under it must not
  // load their players again after the video's claim drops them.
  useEffect(() => holdEmbeds(), [])

  let body
  if (clip.phase === 'ready') {
    body = <View style={styles.viewerImage}>{stage}</View>
  } else if (clip.phase === 'error') {
    body = (
      <View style={styles.videoStatus}>
        <Text accessibilityRole='alert' style={styles.videoStatusText}>vídeo indisponível</Text>
        <Pressable accessibilityRole='button' accessibilityLabel='Tentar de novo' onPress={onRetry} style={styles.retryBtn}>
          <Text style={styles.retryText}>Tentar de novo</Text>
        </Pressable>
      </View>
    )
  } else {
    // fetchVideo resolves with the whole file or fails: there is no byte count.
    body = (
      <View style={styles.videoStatus}>
        <ActivityIndicator color='#ffffff' accessibilityLabel='carregando o vídeo' />
      </View>
    )
  }

  return (
    <Modal visible animationType='fade' transparent={false} statusBarTranslucent onRequestClose={onClose}>
      <View
        onClick={stopClick}
        onKeyDown={stopClick}
        onStartShouldSetResponder={() => true}
        style={[styles.viewer, { paddingTop: insets.top, paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right }]}
      >
        <View style={styles.viewerTop}>
          <Pressable accessibilityRole='button' accessibilityLabel='fechar' onPress={onClose} hitSlop={10} style={styles.viewerBtn}>
            <Icon name='x' size={26} color='#ffffff' />
          </Pressable>
          <View style={styles.viewerBtn} />
        </View>
        <View style={styles.viewerBody}>
          {body}
        </View>
      </View>
    </Modal>
  )
}

function VideoTile ({ author, poster, video, persist }) {
  const clip = useVideoClip({ author, video })
  const insets = useSafeAreaInsets()
  const win = useWindowDimensions()
  const tabBarShown = useContext(TabBarShown)
  const [full, setFull] = useState(false)
  const [playing, setPlaying] = useState(true)
  const [muted, setMuted] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const control = useRef(null)
  const position = useRef(0)
  const frame = useRef(null)
  const release = useRef(null)
  const alive = useRef(true)

  const close = useCallback(() => {
    const done = release.current
    release.current = null
    if (typeof done === 'function') done()
    if (alive.current) {
      setFull(false)
      clip.reset()
    }
  }, [clip.reset])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      close()
    }
  }, [close])

  useEffect(() => {
    if (!clip.active || full) return undefined
    // The same rule as music players: nothing keeps playing from a row
    // scrolled mostly away, with 2 s for a just-tapped row to settle.
    const top = insets.top + layout.topBar
    const bottom = win.height - (insets.bottom + (tabBarShown ? layout.tabBar : 0))
    const openedAt = Date.now()
    // measureInWindow answers later: a measure still in flight when this
    // check ends (full screen opened, the layout changed) must not close.
    let armed = true
    const timer = setInterval(() => {
      if (Date.now() - openedAt < OPEN_GRACE_MS) return
      const view = frame.current
      if (!view || typeof view.measureInWindow !== 'function') {
        if (alive.current) close()
        return
      }
      try {
        view.measureInWindow((x, y, w, h) => {
          if (armed && alive.current && mostlyHidden(x, y, w, h, top, bottom, win.width)) close()
        })
      } catch {
        if (alive.current) close()
      }
    }, VISIBILITY_MS)
    return () => {
      armed = false
      clearInterval(timer)
    }
  }, [clip.active, full, close, insets.top, insets.bottom, win.height, win.width, tabBarShown])

  const start = () => {
    setMuted(false)
    setBlocked(false)
    setPlaying(true)
    position.current = 0
    clip.start()
    const previous = release.current
    if (typeof previous === 'function') previous()
    release.current = claimPlayback({ pause: close }, { bound: true })
  }
  const retry = () => {
    setMuted(false)
    setBlocked(false)
    clip.retry()
  }
  const handoff = () => {
    const p = control.current?.progress?.()
    if (p == null) return
    if (Number.isFinite(p.ms)) position.current = p.ms
    setPlaying(p.playing === true)
  }
  const expand = () => {
    handoff()
    setFull(true)
  }
  const closeFull = () => {
    handoff()
    setFull(false)
  }
  const onProgress = (p) => {
    if (p && Number.isFinite(p.ms)) position.current = p.ms
    if (p && p.playing) setBlocked(false)
  }

  if (!clip.active) return <VideoPoster author={author} poster={poster} video={video} persist={persist} onPress={start} />

  const seconds = videoSeconds(video && video.ms)
  const label = 'vídeo de ' + seconds + (seconds === 1 ? ' segundo' : ' segundos')
  return (
    <>
      <View
        ref={frame}
        collapsable={false}
        onClick={stopClick}
        onKeyDown={stopPressKeys}
        onStartShouldSetResponder={() => true}
        style={[styles.videoFrame, styles.videoActive, { aspectRatio: frameRatio([poster]) }]}
      >
        {clip.phase === 'loading' || full
          ? (
            <View pointerEvents='none' accessibilityElementsHidden importantForAccessibility='no-hide-descendants' aria-hidden>
              <MediaView
                author={author}
                descriptor={poster}
                persist={persist}
                label={label}
                style={[styles.cell, styles.clip, { width: '100%', aspectRatio: frameRatio([poster]) }]}
                tapRetry={false}
              />
            </View>
            )
          : null}
        {clip.phase === 'loading'
          ? (
            <View style={[styles.videoOverlay, styles.videoLoading, styles.videoStatus]}>
              <ActivityIndicator color='#ffffff' accessibilityLabel='carregando o vídeo' />
            </View>
            )
          : null}
        {clip.phase === 'error' && !full
          ? (
            <View style={[styles.videoOverlay, styles.videoStatus]}>
              <Text accessibilityRole='alert' style={styles.videoStatusText}>vídeo indisponível</Text>
              <Pressable accessibilityRole='button' accessibilityLabel='Tentar de novo' onPress={retry} style={styles.retryBtn}>
                <Text style={styles.retryText}>Tentar de novo</Text>
              </Pressable>
            </View>
            )
          : null}
        {clip.phase === 'ready' && !full
          ? (
            <>
              <VideoStage
                uri={clip.uri}
                full={false}
                startMs={position.current}
                playing={playing}
                muted={muted}
                setMuted={setMuted}
                blocked={blocked}
                setBlocked={setBlocked}
                control={control}
                onProgress={onProgress}
                fail={clip.fail}
              />
              <View pointerEvents='box-none' style={styles.videoTools}>
                <Pressable accessibilityRole='button' accessibilityLabel='ver em tela cheia' onPress={expand} style={styles.expandBtn}>
                  <Icon name='expandir' size={22} color='#ffffff' />
                </Pressable>
              </View>
            </>
            )
          : null}
      </View>
      {full
        ? (
          <VideoViewer
            clip={clip}
            stage={
              <VideoStage
                full
                uri={clip.uri}
                startMs={position.current}
                playing={playing}
                muted={muted}
                setMuted={setMuted}
                blocked={blocked}
                setBlocked={setBlocked}
                control={control}
                onProgress={onProgress}
                fail={clip.fail}
              />
            }
            onRetry={retry}
            onClose={closeFull}
          />
          )
        : null}
    </>
  )
}

export function MediaGrid ({ author, media, persist = true, mosaic = false }) {
  const [viewing, setViewing] = useState(null)
  const [feedIndex, setFeedIndex] = useState(0)
  const [focusTick, setFocusTick] = useState(0)
  const lastViewed = useRef(null)
  // The feed moves to the last photo seen only once the viewer is gone: on
  // the web the closing modal hands focus back to the photo that opened it,
  // and that focus cancels a scroll already under way. The carousel then
  // moves that focus to the photo on screen (focusRequest).
  useEffect(() => {
    if (viewing !== null || lastViewed.current === null) return
    setFeedIndex(lastViewed.current)
    setFocusTick((n) => n + 1)
    lastViewed.current = null
  }, [viewing])
  if (!Array.isArray(media) || media.length === 0) return null
  const pair = videoPair(media)
  if (pair) {
    return (
      <View style={styles.grid}>
        <VideoTile
          key={String(author) + ':' + videoId(pair.video)}
          author={author}
          poster={pair.poster}
          video={pair.video}
          persist={persist}
        />
      </View>
    )
  }
  const items = media.slice(0, MAX_MEDIA_PER_POST)
  const mosaicPlan = mosaic ? mosaicLayout(items.length) : null
  const layout = mosaic ? (mosaicPlan && mosaicPlan.kind) : gridLayout(items.length)
  const more = mosaicPlan ? mosaicPlan.more : 0
  const n = items.length
  const tile = (i, style) => (
    <MediaView
      key={i}
      author={author}
      descriptor={items[i]}
      persist={persist}
      label={slideLabel(i, n)}
      style={[styles.cell, style]}
      onPress={() => setViewing(i)}
    />
  )
  const closeViewer = () => {
    lastViewed.current = viewing
    setViewing(null)
  }
  let body
  if (layout === 'one') {
    body = tile(0, [styles.clip, { width: '100%', aspectRatio: ratioOf(items[0]) }])
  } else if (!mosaic) {
    body = (
      <MediaCarousel
        author={author}
        media={items}
        persist={persist}
        index={feedIndex}
        onIndex={setFeedIndex}
        fit='cover'
        showDots
        showCounter
        showArrows
        onPressItem={(i) => setViewing(i)}
        focusRequest={focusTick}
        frameStyle={[styles.carouselFrame, { aspectRatio: frameRatio(items) }]}
      />
    )
  } else if (layout === 'two') {
    body = <View style={[styles.box, styles.row]}>{tile(0, styles.flex)}{tile(1, styles.flex)}</View>
  } else if (layout === 'three') {
    body = (
      <View style={[styles.box, styles.row]}>
        {tile(0, styles.flex)}
        <View style={[styles.flex, styles.column]}>{tile(1, styles.flex)}{tile(2, styles.flex)}</View>
      </View>
    )
  } else if (layout === 'four') {
    body = (
      <View style={[styles.box, styles.column]}>
        <View style={[styles.flex, styles.row]}>{tile(0, styles.flex)}{tile(1, styles.flex)}</View>
        <View style={[styles.flex, styles.row]}>
          {tile(2, styles.flex)}
          {more > 0
            ? (
              <View style={styles.moreCell}>
                {tile(3, styles.flex)}
                <View
                  pointerEvents='none'
                  style={styles.moreScrim}
                  accessibilityElementsHidden
                  importantForAccessibility='no-hide-descendants'
                  aria-hidden
                >
                  <Text style={styles.moreText}>{'+' + more}</Text>
                </View>
              </View>
              )
            : tile(3, styles.flex)}
        </View>
      </View>
    )
  }
  return (
    <View style={styles.grid}>
      {body}
      <Viewer
        author={author}
        media={items}
        index={viewing}
        onIndex={setViewing}
        onClose={closeViewer}
        persist={persist}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  grid: { marginTop: 8 },
  clip: { borderRadius: 14, overflow: 'hidden' },
  carouselFrame: { width: '100%', borderRadius: 14, overflow: 'hidden' },
  box: { width: '100%', aspectRatio: 16 / 9, gap: GAP, borderRadius: 14, overflow: 'hidden' },
  row: { flexDirection: 'row', gap: GAP },
  column: { flexDirection: 'column', gap: GAP },
  flex: { flex: 1 },
  cell: { position: 'relative' },
  moreCell: { flex: 1, position: 'relative' },
  moreScrim: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)'
  },
  moreText: { color: '#ffffff', fontSize: 20, lineHeight: 24, fontWeight: '700' },
  viewer: { flex: 1, backgroundColor: '#000000' },
  viewerTop: { height: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12 },
  viewerBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  viewerCount: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
  viewerBody: { flex: 1, justifyContent: 'center' },
  viewerImage: { flex: 1 },
  viewerFrame: { flex: 1 },
  arrow: {
    position: 'absolute',
    top: '50%',
    marginTop: -24,
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)'
  },
  arrowLeft: { left: 12 },
  arrowRight: { right: 12 },
  videoFrame: { width: '100%', position: 'relative', borderRadius: 14, overflow: 'hidden' },
  videoActive: { backgroundColor: '#000000' },
  videoOverlay: { ...StyleSheet.absoluteFillObject },
  videoLoading: { backgroundColor: 'rgba(0,0,0,0.55)' },
  videoTools: { position: 'absolute', top: 8, left: 8, right: 8, flexDirection: 'row' },
  videoChipsOverlay: { position: 'absolute', top: 8, left: 60, right: 8, alignItems: 'flex-start' },
  videoChips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, paddingHorizontal: 8, borderRadius: 22, backgroundColor: 'rgba(0,0,0,0.65)' },
  expandBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.65)' },
  playMark: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    width: 44,
    height: 44,
    marginTop: -22,
    marginLeft: -22,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)'
  },
  durationMark: {
    position: 'absolute',
    left: 8,
    bottom: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: 'rgba(0,0,0,0.45)'
  },
  durationText: { color: '#ffffff', fontSize: 12, lineHeight: 16, fontWeight: '700', fontVariant: ['tabular-nums'] },
  videoStatus: { alignItems: 'center', justifyContent: 'center', gap: 16, paddingHorizontal: 24 },
  videoStatusText: { color: '#ffffff', fontSize: 16, lineHeight: 22, fontWeight: '600', textAlign: 'center' },
  retryBtn: {
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center'
  },
  retryText: { color: '#ffffff', fontSize: 15, lineHeight: 20, fontWeight: '700' },
  videoBar: { alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 24 },
  videoBarContent: { alignItems: 'center', gap: 12 },
  videoHint: { color: '#ffffff', fontSize: 15, lineHeight: 20, textAlign: 'center' },
  pressed: { opacity: 0.85 }
})
