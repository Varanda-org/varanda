// A link card for an allowlisted music link (../musicEmbed embedOf) that loads
// the provider's own player by itself.
//
// The player loads once the card has been seen on two checks in a row
// (../embedLive embedStep, every EMBED_TICK_MS) on the visible screen
// (./screenVisible: the screen the person is looking at, or the sheet the
// card sits in), and at most two frames load app-wide (embedSlots). Nothing
// autoplays: the person starts the player with its own controls, and nothing
// is drawn over it. A loaded player stays, playback included, for as long as
// its screen is the one looked at, however far the person scrolls, so
// scrolling back finds the same provider page. In a list (./RefreshableList)
// the frame is drawn by the list's player layer (./EmbedLayer) over this
// card's slot, so it outlives the row when the list unmounts it, and the card
// takes the same frame again when the row comes back. Elsewhere (the
// composer's draft, a header) the card draws the frame itself. It unloads at
// once when the card is held (a sheet, a menu or the photo viewer over it,
// another tab, a covered screen, a lock, the background), when another player
// starts in the app, when its row leaves the list or the card leaves a row
// that stays, or when the system ends its content process. A frame found out
// of the band on two checks in a row is asked to yield to a card that became
// visible, and yields on its own next check only if that check still finds it
// out of the band; no card ever changes another card's state.
// Until a player loads, the slot holds the stored ./LinkCard drawn from stored
// data only: nothing contacts the provider, and a tap opens the link. The slot
// keeps the player's height in every state, so loading or unloading the frame
// never moves the list. The card never claims playback, so a silent frame
// never stops a voice note, an Audius card or a momento.
//
// The frame's sandbox grants popups but no top navigation. On native a popup
// is cancelled and its address leaves the app only through embedExitUrl,
// which keeps it on the provider's own domains; on the web it opens a new tab
// that keeps the sandbox.
//
// Props: embed (embedOf of the link), card (the stored link card) or draft
// (the composer's draft, with imageUri and onDismiss, its remove button),
// thumb (as for ./LinkCard), onLongPress, part (optional: tells apart two
// cards of one row, a post's and its quote's).

import { useContext, useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, View, useWindowDimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { cardUrlHost } from '@varanda/rpc'
import {
  EMBED_BASE_URL,
  EMBED_PROVIDER_NAMES,
  embedHeight,
  embedExitUrl,
  embedHtml,
  topNavigationAllowed
} from '../musicEmbed'
import { openExternal } from '../openExternal'
import { embedKey } from '../embedKeep'
import { EMBED_IDLE, EMBED_PARKED, EMBED_TICK_MS, EMBED_WAITING, embedSlots, embedStep, embedsHeld, mostlyHidden, onEmbedHold } from '../embedLive'
import { playbackClaimCount } from '../media/chatMedia'
import { EmbedFrame } from './EmbedFrame'
import { Icon } from './Icon'
import { LINK_CARD_DISMISS, LinkCard } from './LinkCard'
import { EmbedBandBottom, EmbedHost, EmbedRowKey, RowShift, ScreenVisible, SheetDepth } from './screenVisible'
import { TabBarShown } from './tabBarShown'
import { useStyles, useTheme } from './ThemeProvider'
import { layout, space } from './theme'

const NO_EMBED = Object.freeze({})

// A tap or a key inside the slot stays there: a quote opens its post on a
// tap and a chat bubble its actions on a long press.
const stopClick = (e) => { if (e && typeof e.stopPropagation === 'function') e.stopPropagation() }
// On the web, Enter and Space press the post's Pressable. The inline frame
// stops only those, so Escape on a focused player still reaches the app.
const stopPressKeys = (e) => {
  if (e && (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar')) stopClick(e)
}

// The width a kept frame was drawn at, so a card that comes back is active on
// its first commit: with no width it would count as not fitting and close the
// frame it is about to take again.
function keptWidth (host, key) {
  if (!key) return 0
  const entry = host.keep.list().find((e) => e.key === key)
  const w = entry && entry.spec ? entry.spec.width : NaN
  return Number.isFinite(w) && w > 0 ? w : 0
}

export function MusicEmbedCard ({ embed: given, card, draft, imageUri, onDismiss, thumb, onLongPress, part }) {
  const embed = given && typeof given === 'object' ? given : NO_EMBED
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const win = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const tabBarShown = useContext(TabBarShown)
  const visible = useContext(ScreenVisible)
  const depth = useContext(SheetDepth)
  const band = useContext(EmbedBandBottom)
  const host = useContext(EmbedHost)
  const rowKey = useContext(EmbedRowKey)
  const shift = useContext(RowShift)
  // '' draws the frame here: the composer's draft and any card outside a
  // list row.
  const key = host && !draft ? embedKey(rowKey, part, embed.embedUrl) : ''
  const [held, setHeld] = useState(() => embedsHeld(depth))
  useEffect(() => {
    const sync = () => setHeld(embedsHeld(depth))
    sync()
    return onEmbedHold(sync)
  }, [depth])
  // A kept frame starts parked: the mount effect takes it, with its slot,
  // before any check.
  const [state, setState] = useState(() => (key && host.keep.has(key) ? EMBED_PARKED : EMBED_IDLE))
  const stateRef = useRef(state)
  const [width, setWidth] = useState(() => keptWidth(host, key))
  const slot = useRef(null)
  const release = useRef(null)
  // The key the list's layer draws this card's live frame under, or ''. Kept
  // apart from key: a cleanup for an old key runs after key has moved on.
  const hosted = useRef('')
  // The layer refused the frame (another card holds key): drawn here instead.
  const [inline, setInline] = useState(false)
  const placeRound = useRef(0)
  const alive = useRef(true)
  const base = useRef(win.width > win.height)
  const claims = useRef(playbackClaimCount())

  const fits = width > 0 && width >= embed.minWidth
  const active = visible && !held && fits

  // A check whose answer is late passes mayYield false: it still counts
  // toward parking, but only a fresh answer may give the slot away.
  const apply = (next, mayYield = true) => {
    if (mayYield && next === EMBED_PARKED && release.current !== null && embedSlots.yielding(release.current)) next = EMBED_IDLE
    if (next.live && !stateRef.current.live) {
      const done = embedSlots.acquire()
      if (done === null) {
        next = EMBED_WAITING
      } else {
        release.current = done
        base.current = win.width > win.height
      }
    }
    if (!next.live && hosted.current !== '') {
      const kept = hosted.current
      hosted.current = ''
      // The drop ran the release: running it again here could free a slot
      // the next card took meanwhile.
      if (host.keep.drop(kept)) release.current = null
    }
    if (stateRef.current === EMBED_WAITING && next !== EMBED_WAITING && !next.live) embedSlots.withdraw()
    if (!next.live && release.current !== null) {
      const done = release.current
      release.current = null
      done()
    }
    if (next.live && release.current !== null) embedSlots.park(release.current, next === EMBED_PARKED)
    const changed = next !== stateRef.current
    stateRef.current = next
    if (alive.current && changed) setState(next)
  }

  // Measured against the list's scroll content, the ancestor of both this
  // slot and the layer: the new architecture measures a view only against
  // one of its ancestors, and the layer is a sibling of the rows.
  const placeFrame = () => {
    const kept = hosted.current
    if (kept === '' || !alive.current) return
    const id = ++placeRound.current
    const put = (rect) => {
      if (alive.current && hosted.current === kept && id === placeRound.current) host.keep.place(kept, rect)
    }
    const view = slot.current
    const content = host.content()
    if (!view || content === null || typeof view.measureLayout !== 'function') {
      put(null)
      return
    }
    try {
      view.measureLayout(content, (x, y, w, h) => {
        const o = host.origin()
        put({ x: x - o.x, y: y - o.y, w, h })
      }, () => put(null))
    } catch {
      put(null)
    }
  }

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (stateRef.current === EMBED_WAITING) embedSlots.withdraw()
      const kept = stateRef.current.live ? hosted.current : ''
      hosted.current = ''
      stateRef.current = EMBED_IDLE
      const done = release.current
      release.current = null
      // The list keeps the frame, and its slot, for the row's return. A
      // keep already disposed (the list left with its screen) refuses it.
      if (kept !== '' && typeof done === 'function') {
        // Another player started since this card's last check, which would
        // have closed the frame: an orphan would miss it, so it goes now.
        if (playbackClaimCount() !== claims.current) {
          if (host.keep.drop(kept)) return
        } else {
          embedSlots.park(done, true)
          if (host.keep.orphan(kept)) return
        }
      }
      if (typeof done === 'function') done()
    }
  }, [])

  // Before the check effect, which would close a parked state with no slot.
  useEffect(() => {
    const kept = key ? host.keep.claim(key) : null
    if (kept !== null) {
      release.current = kept.release
      hosted.current = key
      if (!stateRef.current.live) {
        stateRef.current = EMBED_PARKED
        setState(EMBED_PARKED)
      }
      // A player that started while the frame had no card, after the list
      // last checked, closes it as this card's own check would have.
      const seen = host.claimsSeen()
      if (playbackClaimCount() !== seen) apply(EMBED_IDLE)
      else claims.current = seen
    } else if (stateRef.current.live) {
      apply(EMBED_IDLE)
    }
    // A new key while mounted: the frame kept under the old one goes.
    return () => { if (alive.current) apply(EMBED_IDLE) }
  }, [key])

  // The list drops a kept frame on its own (its content process died, its
  // row left the data, its screen was left): the card shows the stored card
  // again.
  useEffect(() => {
    if (!key) return undefined
    const offKeep = host.keep.subscribe(() => {
      if (hosted.current !== '' && !host.keep.has(hosted.current)) {
        hosted.current = ''
        // The drop ran the release already.
        release.current = null
        apply(EMBED_IDLE)
      }
    })
    const offContent = host.onContentChange(placeFrame)
    return () => { offKeep(); offContent() }
  }, [key])

  useEffect(() => {
    if (!active) {
      apply(EMBED_IDLE)
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
      // Before any early return: an answer from an earlier check, which may
      // predate a drop below, must never apply.
      const id = ++round
      const missed = pending
      pending = false
      const count = playbackClaimCount()
      const allowed = count === claims.current
      claims.current = count
      // Another player started in the app: the frame drops now, not when a
      // measurement answers, and may come back, silent, after the dwell.
      if (!allowed) {
        apply(EMBED_IDLE)
        return
      }
      if (embedSlots.count() === 0 || !stateRef.current.live) base.current = win.width > win.height
      // A turned window usually means a native full-screen player rotated it:
      // a loaded frame stays while it is turned.
      const turned = (win.width > win.height) !== base.current
      const free = stateRef.current.live || embedSlots.free()
      const settle = (hidden, mayYield = true) => {
        pending = false
        apply(embedStep(stateRef.current, { hidden, allowed, turned, free }), mayYield)
      }
      const unseen = () => settle(true)
      const view = slot.current
      if (!view || typeof view.measureInWindow !== 'function') {
        unseen()
        return
      }
      placeFrame()
      if (missed) settle(true, false)
      pending = true
      try {
        view.measureInWindow((x, y, w, h) => {
          if (cancelled || !alive.current || id !== round) return
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
            if (cancelled || !alive.current || id !== round) return
            if (!(typeof limit === 'number' && Number.isFinite(limit) && limit > 0)) {
              settle(true)
              return
            }
            const lower = Math.min(bottom, limit)
            settle(mostlyHidden(x, y, w, h, top, lower, win.width))
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
    // The dwell counts ticks: a card that is not live waits for the first
    // one, so a re-run right after a tick cannot count two checks at once. A
    // live frame is checked at once and may drop.
    if (stateRef.current.live) check()
    const timer = setInterval(check, EMBED_TICK_MS)
    return () => { cancelled = true; clearInterval(timer) }
  }, [active, win.width, win.height, insets.top, insets.bottom, tabBarShown, band])

  const data = draft || card
  const url = data && typeof data === 'object' && typeof data.url === 'string' ? data.url : ''
  const linkHost = cardUrlHost(url)
  const name = Object.prototype.hasOwnProperty.call(EMBED_PROVIDER_NAMES, embed.provider)
    ? EMBED_PROVIDER_NAMES[embed.provider]
    : null
  const height = embedHeight(embed, width)
  const live = state.live && active

  const openFromPlayer = (target) => {
    const out = embedExitUrl(embed, target)
    if (out !== null) openExternal(out)
  }

  // Handed to the list's layer on going live and again when the size or the
  // key changes; the same release keeps the same frame.
  useEffect(() => {
    if (!key || !live || name === null || release.current === null) return
    const shown = host.keep.show(key, {
      embedUrl: embed.embedUrl,
      html: embedHtml(embed),
      baseUrl: EMBED_BASE_URL,
      allowTop: topNavigationAllowed,
      height,
      width,
      title: 'Player do ' + name,
      onOpen: openFromPlayer,
      shift
    }, release.current, rowKey)
    hosted.current = shown ? key : ''
    setInline(!shown)
    if (shown) placeFrame()
  }, [live, height, width, key, shift])

  if (linkHost === null || name === null) return null
  const onLayout = (event) => {
    const w = event && event.nativeEvent && event.nativeEvent.layout ? event.nativeEvent.layout.width : NaN
    if (Number.isFinite(w)) setWidth(w)
  }

  const plain = <LinkCard card={draft ? undefined : card} draft={draft || undefined} imageUri={imageUri} thumb={thumb} onLongPress={onLongPress} />
  const actions = typeof onDismiss === 'function'
    ? (
      <View style={styles.actions}>
        <Pressable
          accessibilityRole='button'
          accessibilityLabel={LINK_CARD_DISMISS}
          onPress={onDismiss}
          hitSlop={4}
          style={({ pressed }) => [styles.dismiss, pressed && styles.pressed]}
        >
          <Icon name='fechar' size={18} color={colors.soft} />
        </Pressable>
      </View>
      )
    : null

  const tooNarrow = width > 0 && width < embed.minWidth
  // Album, playlist and SoundCloud set players are 352 to 450 pt tall: in the
  // composer one would push the text field off the screen. Decided only while
  // no frame is live: a native full-screen player turns the window, and the
  // loaded frame must stay.
  const tooTall = !!draft && !state.live && height > win.height / 3
  if (tooNarrow || tooTall) {
    return (
      <View onLayout={onLayout}>
        {plain}
        {actions}
      </View>
    )
  }

  return (
    <View style={styles.wrap} onLayout={onLayout}>
      <View
        ref={slot}
        collapsable={false}
        style={[styles.slot, { height }]}
        onLayout={() => placeFrame()}
        // No touch claim here: on Android the view holding the JS responder
        // intercepts the moves of its children, which would cancel a drag
        // inside the player. The stand-in and the frame claim instead.
        onClick={stopClick}
        onKeyDown={stopPressKeys}
      >
        {live && key !== '' && !inline
          // The layer draws the frame over this empty slot; the claim keeps a
          // tap before the first placement from reaching a quote or a bubble.
          ? <View style={{ height }} accessibilityLabel={'Player do ' + name} onStartShouldSetResponder={() => true} />
          : state.live && active
            ? (
              <EmbedFrame
                embedUrl={embed.embedUrl}
                html={embedHtml(embed)}
                baseUrl={EMBED_BASE_URL}
                allowTop={topNavigationAllowed}
                height={height}
                title={'Player do ' + name}
                onOpen={openFromPlayer}
                onGone={() => apply(EMBED_IDLE)}
              />
              )
            : (
              // The responder is negotiated from the touched node upward, so the
              // card's own Pressable takes a tap on it, and this claim keeps a
              // tap beside it from reaching a quote's or a bubble's Pressable.
              <View style={styles.standIn} onStartShouldSetResponder={() => true}>{plain}</View>
              )}
      </View>
      {actions}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  wrap: { marginTop: space.sm },
  slot: { width: '100%', overflow: 'hidden' },
  standIn: { flex: 1, justifyContent: 'center' },
  pressed: { opacity: 0.7 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: space.sm, paddingTop: space.sm },
  dismiss: { width: layout.hit, minHeight: layout.hit, alignItems: 'center', justifyContent: 'center' }
})
