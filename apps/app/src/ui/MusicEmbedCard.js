// A link card for an allowlisted music link (../musicEmbed embedOf) that loads
// the provider's own player by itself.
//
// The player loads once the card has been seen on two checks in a row
// (../embedLive embedStep, every EMBED_TICK_MS) on the visible screen
// (./screenVisible: the screen the person is looking at, or the sheet the
// card sits in), and at most two frames load app-wide (embedSlots). Nothing
// autoplays: the person starts the player with its own controls, and nothing
// is drawn over it. A loaded player stays, playback included, while its card
// is scrolled out of the band on the same visible screen, so scrolling back
// finds the same provider page. It unloads at once when the card is held (a
// sheet, a menu or the photo viewer over it, another tab, a covered screen, a
// lock, the background), when another player starts in the app, when the
// list unmounts its row, or when a check finds its card more than three window
// heights past the band (a list may keep a row mounted for good). A frame
// found out of the band on two checks in a row is asked to yield to a card
// that became visible, and yields on its own next check only if that check
// still finds it out of the band; no card ever changes another card's state.
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
// thumb (as for ./LinkCard), onLongPress.

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
import { EMBED_IDLE, EMBED_PARKED, EMBED_TICK_MS, EMBED_WAITING, embedSlots, embedStep, embedsHeld, farFromBand, mostlyHidden, onEmbedHold } from '../embedLive'
import { playbackClaimCount } from '../media/chatMedia'
import { EmbedFrame } from './EmbedFrame'
import { Icon } from './Icon'
import { LINK_CARD_DISMISS, LinkCard } from './LinkCard'
import { EmbedBandBottom, ScreenVisible, SheetDepth } from './screenVisible'
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

export function MusicEmbedCard ({ embed: given, card, draft, imageUri, onDismiss, thumb, onLongPress }) {
  const embed = given && typeof given === 'object' ? given : NO_EMBED
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
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
  const [state, setState] = useState(EMBED_IDLE)
  const stateRef = useRef(EMBED_IDLE)
  const [width, setWidth] = useState(0)
  const slot = useRef(null)
  const release = useRef(null)
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

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (stateRef.current === EMBED_WAITING) embedSlots.withdraw()
      stateRef.current = EMBED_IDLE
      const done = release.current
      release.current = null
      if (typeof done === 'function') done()
    }
  }, [])

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
      const settle = (hidden, mayYield = true, far = false) => {
        pending = false
        apply(embedStep(stateRef.current, { hidden, allowed, turned, free, far }), mayYield)
      }
      const unseen = () => settle(true)
      const view = slot.current
      if (!view || typeof view.measureInWindow !== 'function') {
        unseen()
        return
      }
      if (missed) settle(true, false)
      pending = true
      try {
        view.measureInWindow((x, y, w, h) => {
          if (cancelled || !alive.current || id !== round) return
          if (!band || typeof band.measure !== 'function') {
            settle(mostlyHidden(x, y, w, h, top, bottom, win.width), true, farFromBand(y, h, top, bottom, win.height))
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
            settle(mostlyHidden(x, y, w, h, top, lower, win.width), true, farFromBand(y, h, top, lower, win.height))
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
  const host = cardUrlHost(url)
  const name = Object.prototype.hasOwnProperty.call(EMBED_PROVIDER_NAMES, embed.provider)
    ? EMBED_PROVIDER_NAMES[embed.provider]
    : null
  if (host === null || name === null) return null

  const openFromPlayer = (target) => {
    const out = embedExitUrl(embed, target)
    if (out !== null) openExternal(out)
  }
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

  const height = embedHeight(embed, width)
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
        // No touch claim here: on Android the view holding the JS responder
        // intercepts the moves of its children, which would cancel a drag
        // inside the player. The stand-in and the WebView claim instead.
        onClick={stopClick}
        onKeyDown={stopPressKeys}
      >
        {state.live && active
          ? (
            <EmbedFrame
              embedUrl={embed.embedUrl}
              html={embedHtml(embed)}
              baseUrl={EMBED_BASE_URL}
              allowTop={topNavigationAllowed}
              height={height}
              title={'Player do ' + name}
              onOpen={openFromPlayer}
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
