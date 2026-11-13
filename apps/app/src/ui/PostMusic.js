// The Audius music of a post (../music musicRefOf of its stored card): a
// compact sticker where the card was, and a track or snippet plays by itself
// while the post is on screen, like a story.
//
// A playlist, and every post while the Ajustes switch is off
// (../postMusic musicAutoEnabled), keeps ./MusicPlayerCard unchanged. Mounting
// asks nothing: the sticker draws the stored card, and the association hears
// of the song only when it starts. It starts by itself once the sticker has
// been seen on two checks in a row (../postMusic ambientStep, every
// EMBED_TICK_MS) on the visible screen (./screenVisible), and only while no
// other player holds playback and no provider frame is loaded: claiming
// playback would pause the one and drop the other. Nothing starts by itself
// while a screen reader runs or before its answer (./screenReader), after a
// refusal of sound, a tap that silenced a post or the daily limit
// (holdMusicAuto, for every post until the next tap on a sticker), or after an
// automatic failure of this song, which shows no error and is remembered for
// the session even once the row unmounts (an automatic fallback keeps the
// sticker, so a tap can still try). Every playback of the
// row, tapped or not, stops when the sticker leaves the band, a sheet or
// another screen covers it, the node goes offline or the app goes to the
// background.
//
// The cover is asked only after this row's item was answered, for the same
// member, origin and music, and only while the row is seen. While music is
// silenced, a row the person did not tap shows only a cover already in memory.
// A refused sound keeps a 'Tocar música' chip until a tap here or playback.
//
// Every music card keeps the artist, the title, the Audius source and the page
// link (Terms, docs/protocol.md). No progress bar, seek or queue here.
//
// Props: card (the stored link card), music (musicRefOf of its URL).

import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { displayText } from '@varanda/rpc'
import { EMBED_IDLE, EMBED_LIVE, EMBED_TICK_MS, embedSlots, embedsHeld, mostlyHidden, onEmbedHold } from '../embedLive'
import { playbackBusy, playbackEpoch } from '../media/chatMedia'
import { MUSIC_LIMIT_TEXT, MUSIC_SOURCE, SNIPPET_BADGE, musicInfoLine, musicOriginOf, musicRowLine } from '../music'
import { musicAutoStore } from '../musicAutoStore'
import { useHosted, useNode } from '../node'
import { openExternal } from '../openExternal'
import { ambientKind, ambientStep, clearMusicAutoHold, holdMusicAuto, markMusicAutoFailed, musicAutoEnabled, musicAutoFailed, musicAutoHeld, onMusicAutoChange, onMusicAutoHold } from '../postMusic'
import { Icon } from './Icon'
import { LinkCard } from './LinkCard'
import { MusicCover } from './MusicCover'
import { MusicEqualizer } from './MusicEqualizer'
import { MusicPlayerCard, createMusicPlayback, musicPlayerIdle } from './MusicPlayerCard'
import { screenReaderKnown, screenReaderOn } from './screenReader'
import { EmbedBandBottom, ScreenVisible, SheetDepth } from './screenVisible'
import { TabBarShown } from './tabBarShown'
import { useStyles, useTheme } from './ThemeProvider'
import { layout, radius, space } from './theme'
import { useMusicCover } from './useMusicCover'

export default function PostMusic ({ card, music }) {
  const hosted = useHosted()
  const [auto, setAuto] = useState(() => musicAutoEnabled(musicAutoStore()))
  useEffect(() => {
    const sync = () => setAuto(musicAutoEnabled(musicAutoStore()))
    sync()
    return onMusicAutoChange(sync)
  }, [])
  if (!ambientKind(music) || !auto) return <MusicPlayerCard card={card} music={music} />
  if (hosted !== true) return <LinkCard card={card} />
  return <AmbientMusic key={card.url} card={card} music={music} />
}

function AmbientMusic ({ card, music }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const node = useNode()
  const win = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const tabBarShown = useContext(TabBarShown)
  const visible = useContext(ScreenVisible)
  const depth = useContext(SheetDepth)
  const band = useContext(EmbedBandBottom)
  const [held, setHeld] = useState(() => embedsHeld(depth))
  useEffect(() => {
    const sync = () => setHeld(embedsHeld(depth))
    sync()
    return onEmbedHold(sync)
  }, [depth])

  const member = node.passkey && node.passkey.status && typeof node.passkey.status.publicKey === 'string'
    ? node.passkey.status.publicKey.toLowerCase()
    : null
  const enabled = musicOriginOf(node) !== null
  const origin = node.accountOrigin || musicOriginOf(node)
  const request = node.request
  const [state, setState] = useState(musicPlayerIdle)
  const [shownNow, setShownNow] = useState(false)
  const [silenced, setSilenced] = useState(musicAutoHeld)
  useEffect(() => {
    const sync = () => setSilenced(musicAutoHeld())
    sync()
    return onMusicAutoHold(sync)
  }, [])
  // A refusal keeps its chip until a tap here or real playback, even after
  // scrolling away disposed the player: the session hold stays meanwhile.
  const [refused, setRefused] = useState(false)
  const shownRef = useRef(false)
  const stepRef = useRef(EMBED_IDLE)
  const phaseRef = useRef('idle')
  // 'auto' | 'manual': an automatic attempt fails quietly and only once.
  const attemptRef = useRef(null)
  const failedRef = useRef(false)
  const failKey = JSON.stringify([member, origin, music.kind, music.id, music.start])
  const failKeyRef = useRef(failKey)
  failKeyRef.current = failKey
  const root = useRef(null)
  const playback = useMemo(() => {
    // The reset effect below lands on the next render. Stamp the playback
    // that produced this state so the render that first sees a new account
    // does not ask for the previous item.
    const coverOf = { member, origin, kind: music.kind, id: music.id, start: music.start }
    return createMusicPlayback({ member, origin, request, enabled }, music, (next) => {
      phaseRef.current = next.phase
      const auto = attemptRef.current === 'auto'
      // Here, not in an effect: another row's next check must already see the hold.
      if (next.blocked) {
        holdMusicAuto()
        setRefused(true)
      } else if (next.phase === 'playing') {
        setRefused(false)
      }
      // An automatic fallback is a quiet failure too: the sticker stays for a tap.
      if (auto && (next.error || next.fallback)) {
        failedRef.current = true
        markMusicAutoFailed(failKey)
      }
      // A spent quota is spent for every row, tapped or not.
      if (next.error === MUSIC_LIMIT_TEXT) holdMusicAuto()
      setState({ ...next, coverOf, auto })
    })
  }, [member, origin, request, enabled, music.kind, music.id, music.start])
  const controller = useRef(playback)
  controller.current = playback
  useEffect(() => {
    setState(musicPlayerIdle)
    setRefused(false)
    phaseRef.current = 'idle'
    stepRef.current = EMBED_IDLE
    // A failure under another account or song says nothing about this one;
    // the session record (musicAutoFailed) is keyed by both.
    failedRef.current = false
    return () => playback.release()
  }, [playback])

  const active = visible && !held && node.online !== false

  useEffect(() => {
    const see = (shown) => {
      if (shownRef.current === shown) return
      shownRef.current = shown
      setShownNow(shown)
    }
    const halt = () => {
      if (stepRef.current.live || phaseRef.current !== 'idle') controller.current.stop()
      stepRef.current = EMBED_IDLE
      see(false)
    }
    if (!active) {
      halt()
      return undefined
    }
    // measureInWindow answers later: an answer from an earlier run of this
    // effect must never apply.
    let cancelled = false
    // A pushed screen has no tab bar (TabBarShown), so its band reaches the
    // bottom of the window; with no provider the bar counts, the early side.
    const top = insets.top + layout.topBar
    const bottom = win.height - (insets.bottom + (tabBarShown ? layout.tabBar : 0))
    // Each check's answer applies only while it is the latest check, and an
    // answer still missing at the next tick counts as hidden.
    let round = 0
    let pending = false
    const check = () => {
      if (cancelled) return
      const id = ++round
      const missed = pending
      pending = false
      const settle = (hidden) => {
        pending = false
        see(!hidden)
        // Read here, right before the step: the controller claims playback
        // synchronously inside press(), so two rows never start together.
        // A claim pauses whoever played and a loaded provider frame drops on
        // any claim: an automatic start must do neither.
        const autoOk = !musicAutoHeld() && screenReaderKnown() && !screenReaderOn()
        const busy = !autoOk || playbackBusy() || embedSlots.count() > 0
        const { state: next, action } = ambientStep(stepRef.current, { hidden, busy, failed: failedRef.current || musicAutoFailed(failKeyRef.current) })
        stepRef.current = next
        if (action === 'start') {
          // press() pauses or cancels a job that is not idle.
          if (phaseRef.current === 'idle') {
            attemptRef.current = 'auto'
            controller.current.press(playbackEpoch(), { auto: true })
          }
        } else if (action === 'stop') {
          stepRef.current = EMBED_IDLE
          controller.current.stop()
        }
      }
      const unseen = () => settle(true)
      const view = root.current
      if (!view || typeof view.measureInWindow !== 'function') {
        unseen()
        return
      }
      if (missed) unseen()
      pending = true
      try {
        view.measureInWindow((x, y, w, h) => {
          if (cancelled || id !== round) return
          if (!band || typeof band.measure !== 'function') {
            settle(mostlyHidden(x, y, w, h, top, bottom, win.width))
            return
          }
          // A composer under the list lowers the band to its top. A band that
          // cannot tell where the composer is counts the check as hidden: the
          // row may be behind the composer.
          let answered = false
          const withLimit = (limit) => {
            if (answered) return
            answered = true
            if (cancelled || id !== round) return
            if (!(typeof limit === 'number' && Number.isFinite(limit) && limit > 0)) {
              settle(true)
              return
            }
            settle(mostlyHidden(x, y, w, h, top, Math.min(bottom, limit), win.width))
          }
          try {
            band.measure(withLimit)
          } catch {
            withLimit(null)
          }
        })
      } catch {
        unseen()
      }
    }
    // The dwell counts ticks: a row that is not live waits for the first one,
    // so a re-run right after a tick cannot count two checks at once. A live
    // row is checked at once and may stop.
    if (stepRef.current.live) check()
    const timer = setInterval(check, EMBED_TICK_MS)
    return () => { cancelled = true; clearInterval(timer) }
  }, [active, win.width, win.height, insets.top, insets.bottom, tabBarShown, band])

  const owned = state.coverOf
  const samePlayback = owned && owned.member === member && owned.origin === origin && owned.kind === music.kind && owned.id === music.id && owned.start === music.start
  // Silenced, a row shows only a cover already in memory, even one the person
  // tapped earlier (docs/protocol.md and the Privacy text: no request while
  // silenced); the tap that plays again clears the silence first. The state
  // re-renders this row when another row silences music, and the live read
  // covers the render right after a hold set here.
  const coverMode = !shownNow || !active ? false : (silenced || musicAutoHeld()) ? 'cached' : true
  const cover = useMusicCover('track', samePlayback ? state.item : null, { member, origin, request }, coverMode)

  if (!enabled || (state.fallback && !state.auto)) return <LinkCard card={card} />

  const { item, phase } = state
  const sounding = phase === 'playing' || phase === 'loading'
  const onTap = () => {
    if (phaseRef.current === 'playing' || phaseRef.current === 'loading') {
      playback.stop()
      holdMusicAuto()
      return
    }
    // Only the visibility checks stop a song when the row leaves: none run now.
    if (!active) return
    setRefused(false)
    clearMusicAutoHold()
    attemptRef.current = 'manual'
    // Live, so the checks stop a tapped song when the row leaves the screen.
    stepRef.current = EMBED_LIVE
    playback.press(playbackEpoch())
  }
  const title = displayText(item ? item.title : card.title)
  const line = displayText(item ? (musicInfoLine(item) || musicRowLine(item)) : card.desc)
  const hint = [title, displayText(item ? item.artist : card.desc)].filter((part) => part !== '').join(', ')
  return (
    <View>
      <View ref={root} collapsable={false} style={styles.row}>
        <Pressable
          accessibilityRole='button'
          accessibilityLabel={sounding ? 'Silenciar música' : 'Tocar música'}
          accessibilityHint={hint}
          onPress={onTap}
          style={({ pressed }) => [styles.sticker, pressed && styles.pressed]}
        >
          <MusicCover size={40} uri={cover} />
          <View style={styles.meta}>
            <Text style={styles.title} numberOfLines={1}>{title}</Text>
            <Text style={styles.artist} numberOfLines={1}>{line}</Text>
          </View>
          {music.kind === 'snippet' ? <Text style={styles.badge}>{SNIPPET_BADGE}</Text> : null}
          {phase === 'playing'
            ? <MusicEqualizer playing />
            : phase === 'loading'
              ? <ActivityIndicator color={colors.ink} />
              : <Icon name='tocar' size={16} color={colors.ink} />}
        </Pressable>
        <Pressable
          accessibilityRole='link'
          accessibilityLabel='Abrir no Audius'
          onPress={() => openExternal(item ? item.url : card.url)}
          style={({ pressed }) => [styles.source, pressed && styles.pressed]}
        >
          <Icon name='externo' size={16} color={colors.ink} />
          <Text style={styles.text}>{MUSIC_SOURCE}</Text>
        </Pressable>
        {(state.blocked || refused) && !sounding
          ? (
            <Pressable accessibilityRole='button' onPress={onTap} style={({ pressed }) => [styles.chip, pressed && styles.pressed]}>
              <Text style={styles.text}>Tocar música</Text>
            </Pressable>
            )
          : null}
      </View>
      {state.error && !state.auto ? <Text style={styles.error} accessibilityLiveRegion='polite'>{state.error}</Text> : null}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  row: { marginTop: space.sm, minHeight: layout.hit, flexDirection: 'row', alignItems: 'center', gap: space.xs },
  sticker: {
    flexShrink: 1,
    minHeight: layout.hit,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRadius: radius.lg,
    backgroundColor: colors.card
  },
  // minWidth 0 lets a long title ellipsize instead of stretching the row.
  meta: { flexShrink: 1, minWidth: 0, flexDirection: 'column' },
  title: { fontSize: 13, lineHeight: 18, fontWeight: '700', color: colors.ink },
  artist: { fontSize: 12, lineHeight: 16, color: colors.soft },
  badge: { fontSize: 11, lineHeight: 16, paddingHorizontal: space.xs, borderRadius: radius.sm, backgroundColor: colors.bg, color: colors.soft },
  source: {
    minWidth: layout.hit,
    minHeight: layout.hit,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.sm,
    borderRadius: radius.lg,
    backgroundColor: colors.card
  },
  chip: { minHeight: layout.hit, justifyContent: 'center', paddingHorizontal: space.sm, borderRadius: radius.md, backgroundColor: colors.card },
  pressed: { opacity: 0.7 },
  text: { fontSize: 13, lineHeight: 18, color: colors.ink },
  error: { fontSize: 13, lineHeight: 18, color: colors.soft, paddingTop: space.xs }
})
