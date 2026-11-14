// A link card for an allowlisted music link (../musicEmbed embedOf) that loads
// the provider's own player by itself.
//
// The player loads once the card has been in the band, or near it (up to two
// band heights ahead or behind, ../embedLive embedNear), on two checks in a
// row (embedStep, every EMBED_TICK_MS) on the visible screen (./screenVisible:
// the screen the person is looking at, or the sheet the card sits in), so it
// is ready before the person reaches it. At most four frames load app-wide
// (embedSlots), a cap that drops, never under two, each time the system ends
// a frame's content process. Nothing autoplays: the person starts the player
// with its own controls, and nothing is drawn over it. A loaded player stays,
// playback included, however far the person scrolls, so scrolling back finds
// the same provider page. In a list (./RefreshableList) the frame is drawn by
// the list's player layer (./EmbedLayer) over this card's slot, so it
// outlives the row when the list unmounts it, and the card takes the same
// frame again when the row comes back. Elsewhere (the composer's draft, a
// header) the card draws the frame itself.
//
// The app cannot see play or pause inside the frame, so a frame the person
// touched counts as playing, and so does every frame while a screen reader
// runs or has not answered yet (embedTouched, read at each decision). When
// the card's screen stops being the one looked at (a sheet or a menu over it,
// another tab, a covered screen), a touched frame unloads at once and an
// untouched one stays loaded, parked as the farthest, and gives its slot up
// as soon as another card asks for it; a lock or the background unloads every
// frame. Another player starting in the app unloads a touched frame only. A
// frame also unloads when its row leaves the list or the card leaves a row
// that stays, and when the system ends its content process. A frame found out
// of the band on two checks in a row is asked to yield to a card that needs a
// slot (a card about to come into view asks only an untouched frame at least
// 400 pt farther away), and yields on its own next check only if that check
// still finds it out of the band; no card ever changes another card's state.
//
// Until the provider page has loaded, the slot draws ./EmbedCover at the
// player's own size, built from stored data only, so the player shows up in
// place instead of growing out of a small row; a tap on it does nothing. The
// frame loads above it, transparent and out of touches, fades in when ready,
// and the cover stays a moment longer so no gap flashes during the fade. The
// slot keeps the player's height in every state, so loading or unloading the
// frame never moves the list. The card never claims playback, so a silent
// frame never stops a voice note, an Audius card or a momento.
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
import { Animated, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native'
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
import { coverLingers } from '../embedCover'
import { EMBED_IDLE, EMBED_PARKED, EMBED_TICK_MS, EMBED_WAITING, bandGap, embedNear, embedSlots, embedStays, embedStep, embedTouched, embedsHeld, embedsHeldAll, mostlyHidden, onEmbedHold } from '../embedLive'
import { playbackClaimCount } from '../media/chatMedia'
import { EmbedCover } from './EmbedCover'
import { EmbedFrame } from './EmbedFrame'
import { Icon } from './Icon'
import { LINK_CARD_DISMISS, LinkCard } from './LinkCard'
import { screenReaderKnown, screenReaderOn } from './screenReader'
import { EmbedBandBottom, EmbedHost, EmbedRowKey, RowShift, ScreenVisible, SheetDepth } from './screenVisible'
import { TabBarShown } from './tabBarShown'
import { useReveal } from './useReveal'
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

// Whether the provider page of a kept frame has loaded, so a card that comes
// back draws no stored card over it on its first commit.
function keptReady (host, key) {
  if (!key) return false
  const entry = host.keep.list().find((e) => e.key === key)
  return !!entry && entry.ready === true
}

// Read at the moment of each decision: the frame can be touched, and a
// screen reader turned on, at any time after it loaded.
function touchedNow (release) {
  return embedTouched(embedSlots.engaged(release), screenReaderOn(), screenReaderKnown())
}

// What the slot pool is told at each call: while a screen reader runs, or has
// not answered yet, every frame counts as touched, whoever holds it.
function readerTouchNow () {
  return embedTouched(false, screenReaderOn(), screenReaderKnown())
}

// What the slot draws. The stored card stays until the provider page has
// loaded; the list's layer then draws the frame over an empty slot (hosted),
// or the card's own frame, loading under the stored card meanwhile, shows.
function slotParts (live, hosted, ready) {
  return {
    standIn: !live || !ready,
    empty: live && hosted && ready,
    frame: live && !hosted
  }
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
  const [locked, setLocked] = useState(() => embedsHeldAll())
  useEffect(() => {
    const sync = () => {
      setHeld(embedsHeld(depth))
      setLocked(embedsHeldAll())
    }
    sync()
    return onEmbedHold(sync)
  }, [depth])
  // A kept frame starts parked: the mount effect takes it, with its slot,
  // before any check.
  const [state, setState] = useState(() => (key && host.keep.has(key) ? EMBED_PARKED : EMBED_IDLE))
  const stateRef = useRef(state)
  const [width, setWidth] = useState(() => keptWidth(host, key))
  const [ready, setReady] = useState(() => keptReady(host, key))
  const slot = useRef(null)
  const release = useRef(null)
  // The kind of this card's request for a slot while it waits: 'visible',
  // 'preload', or '' for none.
  const request = useRef('')
  // The key the list's layer draws this card's live frame under, or ''. Kept
  // apart from key: a cleanup for an old key runs after key has moved on.
  const hosted = useRef('')
  // The layer refused the frame (another card holds key): drawn here instead.
  const [inline, setInline] = useState(false)
  const placeRound = useRef(0)
  const alive = useRef(true)
  const base = useRef(win.width > win.height)
  const claims = useRef(playbackClaimCount())
  // Whether this card's frame was touched at its last check.
  const touchSeen = useRef(false)

  const fits = width > 0 && width >= embed.minWidth
  const active = visible && !held && fits

  // A check whose answer is late passes mayYield false: it still counts
  // toward parking, but only a fresh answer may give the slot away.
  // gap is the slot's distance to the band (0 in it, Infinity unknown): a
  // card about to come into view takes a slot only from a holder much
  // farther away, and a parked holder reports how far it is.
  const apply = (next, mayYield = true, gap) => {
    if (mayYield && next === EMBED_PARKED && release.current !== null && embedSlots.yielding(release.current, gap, readerTouchNow())) next = EMBED_IDLE
    // A visible request outlives the check that made it: a holder would still
    // yield to it after this card left the band. It goes once, when the card
    // is found out of the band, and the card asks again as a preload.
    if (stateRef.current === EMBED_WAITING && request.current === 'visible' && gap > 0) {
      embedSlots.withdraw()
      request.current = ''
    }
    if (next.live && !stateRef.current.live) {
      const done = embedSlots.acquire(gap, Date.now(), readerTouchNow())
      if (done === null) {
        next = EMBED_WAITING
        request.current = gap > 0 ? 'preload' : 'visible'
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
    if (next !== EMBED_WAITING) request.current = ''
    if (!next.live && release.current !== null) {
      const done = release.current
      release.current = null
      done()
    }
    if (next.live && release.current !== null) embedSlots.park(release.current, next === EMBED_PARKED, gap)
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
        // have closed a touched frame: an orphan would miss it, so it goes now.
        if (playbackClaimCount() !== claims.current && touchedNow(done)) {
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
    setReady(kept !== null && keptReady(host, key))
    if (kept !== null) {
      release.current = kept.release
      // A touch made while the frame had no card predates the claims checked
      // just below, so it forgives none of them.
      touchSeen.current = embedSlots.engaged(release.current)
      hosted.current = key
      if (!stateRef.current.live) {
        stateRef.current = EMBED_PARKED
        setState(EMBED_PARKED)
      }
      // A player that started while the frame had no card, after the list
      // last checked, closes a touched one as this card's own check would.
      const seen = host.claimsSeen()
      if (playbackClaimCount() !== seen && touchedNow(release.current)) apply(EMBED_IDLE)
      else claims.current = seen
    } else if (stateRef.current.live) {
      apply(EMBED_IDLE)
    }
    // A new key while mounted: the frame kept under the old one goes.
    return () => { if (alive.current) apply(EMBED_IDLE) }
  }, [key])

  // The list drops a kept frame on its own (its content process died, its
  // row left the data, its screen was left): the card shows the stored card
  // again. It also tells when the frame's provider page has loaded.
  useEffect(() => {
    if (!key) return undefined
    const offKeep = host.keep.subscribe(() => {
      if (hosted.current === '') return
      if (!host.keep.has(hosted.current)) {
        hosted.current = ''
        // The drop ran the release already.
        release.current = null
        apply(EMBED_IDLE)
        return
      }
      if (keptReady(host, hosted.current)) setReady(true)
    })
    const offContent = host.onContentChange(placeFrame)
    return () => { offKeep(); offContent() }
  }, [key])

  // A frame that unloads loads again from the start, so the stored card shows
  // until that next load finishes.
  useEffect(() => { if (!state.live) setReady(false) }, [state.live])

  useEffect(() => {
    if (!active) {
      // Unseen, an untouched frame stays loaded but parked as the farthest,
      // so it gives its slot up at once to a card that asks; no measurement
      // and no new load start meanwhile.
      if (!stateRef.current.live || !fits || !embedStays(touchedNow(release.current), locked)) {
        apply(EMBED_IDLE)
        return undefined
      }
      const keep = () => {
        if (!stateRef.current.live) return
        if (embedStays(touchedNow(release.current), locked)) apply(EMBED_PARKED, true, Infinity)
        else apply(EMBED_IDLE)
      }
      keep()
      const idle = setInterval(keep, EMBED_TICK_MS)
      return () => clearInterval(idle)
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
      // A touch wins over every claim made before it: an automatic start that
      // raced the person's tap must not close the player they just tapped.
      // Only a claim made after the touch closes it.
      const touching = embedSlots.engaged(release.current)
      const at = embedSlots.engagedAt(release.current)
      if (touching && !touchSeen.current && Number.isFinite(at)) claims.current = Math.max(claims.current, at)
      touchSeen.current = touching
      const allowed = count === claims.current || !touchedNow(release.current)
      claims.current = count
      // Another player started in the app: a touched frame drops now, not
      // when a measurement answers, and may come back, silent, after the
      // dwell. An untouched one cannot be playing, so it stays.
      if (!allowed) {
        apply(EMBED_IDLE)
        return
      }
      // Only a touched player can be in native full screen, so an untouched
      // frame re-bases to a real rotation instead of counting as turned.
      if (embedSlots.count() === 0 || !stateRef.current.live || !touchedNow(release.current)) base.current = win.width > win.height
      // A turned window usually means a native full-screen player rotated it:
      // a loaded frame stays while it is turned.
      const turned = (win.width > win.height) !== base.current
      const settle = (hidden, mayYield = true, gap = Infinity, near = false) => {
        pending = false
        const free = stateRef.current.live || embedSlots.free(gap, readerTouchNow())
        apply(embedStep(stateRef.current, { hidden, near, allowed, turned, free }), mayYield, gap)
      }
      // A slot near the band counts toward the dwell like a visible one. A
      // hidden slot that only touches the band is 0 pt away, yet still a
      // preload: the pool reads a gap of 0 as a visible card.
      const answer = (x, y, w, h, lower) => {
        const hidden = mostlyHidden(x, y, w, h, top, lower, win.width)
        const gap = hidden ? Math.max(bandGap(x, y, w, h, top, lower, win.width), 1) : 0
        settle(hidden, true, gap, embedNear(gap, top, lower))
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
            answer(x, y, w, h, bottom)
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
            answer(x, y, w, h, Math.min(bottom, limit))
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
  }, [active, fits, locked, win.width, win.height, insets.top, insets.bottom, tabBarShown, band])

  const data = draft || card
  const url = data && typeof data === 'object' && typeof data.url === 'string' ? data.url : ''
  const linkHost = cardUrlHost(url)
  const name = Object.prototype.hasOwnProperty.call(EMBED_PROVIDER_NAMES, embed.provider)
    ? EMBED_PROVIDER_NAMES[embed.provider]
    : null
  const height = embedHeight(embed, width)
  const live = state.live
  const { opacity, settled } = useReveal(live && ready, 100)

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
    // On the web a hidden screen is display none and reports width 0: kept,
    // that width would close the frame this card keeps loaded, or re-size it
    // to nothing.
    if (!Number.isFinite(w) || (w <= 0 && (!visible || held))) return
    setWidth(w)
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

  const parts = slotParts(live, key !== '' && !inline, ready)
  const lingers = coverLingers(parts.standIn, live, ready, settled)
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
        {parts.standIn || lingers
          // First child, so the frame draws over it. The claim keeps a tap on
          // or beside it from reaching a quote's or a bubble's Pressable;
          // while it only lingers under the fading frame it takes no touch.
          ? (
            <View
              key='cover'
              style={styles.cover}
              pointerEvents={parts.standIn ? 'auto' : 'none'}
              accessibilityElementsHidden={!parts.standIn}
              importantForAccessibility={parts.standIn ? 'auto' : 'no-hide-descendants'}
              onStartShouldSetResponder={() => true}
            >
              <EmbedCover provider={embed.provider} name={name} card={draft ? undefined : card} draft={draft || undefined} imageUri={imageUri} thumb={thumb} width={width} height={height} onLongPress={onLongPress} />
            </View>
            )
          : null}
        {parts.empty
          // The layer draws the frame over this empty slot; the claim keeps a
          // tap before the first placement from reaching a quote or a bubble.
          ? <View key='empty' style={{ height }} accessibilityLabel={'Player do ' + name} onStartShouldSetResponder={() => true} />
          : null}
        {parts.frame
          // Over the cover, transparent and out of touches until the
          // provider page has loaded; the key keeps it mounted when it shows.
          ? (
            <Animated.View key='frame' style={settled ? styles.frame : [styles.frame, { opacity: ready ? opacity : 0 }]} pointerEvents={ready ? 'auto' : 'none'}>
              <EmbedFrame
                embedUrl={embed.embedUrl}
                html={embedHtml(embed)}
                baseUrl={EMBED_BASE_URL}
                allowTop={topNavigationAllowed}
                height={height}
                title={'Player do ' + name}
                // Kept loaded behind another screen, a sheet or a menu: nobody
                // can see it, so an open it asks for is not the person's.
                onOpen={ready && active ? openFromPlayer : undefined}
                parked={!ready}
                onReady={() => setReady(true)}
                onEngage={(on) => embedSlots.engage(release.current, on, playbackClaimCount())}
                onGone={() => { embedSlots.shrink(Date.now()); apply(EMBED_IDLE) }}
              />
            </Animated.View>
            )
          : null}
      </View>
      {actions}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  wrap: { marginTop: space.sm },
  slot: { width: '100%', overflow: 'hidden' },
  cover: { ...StyleSheet.absoluteFillObject },
  frame: { ...StyleSheet.absoluteFillObject },
  pressed: { opacity: 0.7 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: space.sm, paddingTop: space.sm },
  dismiss: { width: layout.hit, minHeight: layout.hit, alignItems: 'center', justifyContent: 'center' }
})
