// A link card for an allowlisted music link (../musicEmbed embedOf), with a
// button that plays it in the provider's own player.
//
// Closed (the default, and the only state before a tap) it is drawn from the
// stored card only, as ./LinkCard is: nothing contacts the provider, no frame
// is mounted, and the thumbnail is the stored descriptor read like a post
// photo. The notice under it says what a tap sends to the provider, so the
// tap on "Tocar aqui" is the person's informed choice.
//
// Open, ./EmbedFrame holds the player at the full card width with nothing
// drawn over it, so the player's own controls are the ones the person sees
// and taps. One player plays at a time (claimPlayback, bound: the App stops
// it on a tab, screen or foreground change), and it closes when its slot is
// mostly off screen, so nothing keeps playing from a row scrolled
// away. A card too narrow for the provider's player opens the provider
// outside the app instead.
//
// Props: embed (embedOf of card.url), card (the stored link card), thumb
// ({ kind: 'post', author, persist } as for ./LinkCard), onLongPress.

import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { cardUrlHost, displayText } from '@varanda/rpc'
import {
  EMBED_BASE_URL,
  EMBED_CLOSE,
  EMBED_PLAY,
  EMBED_PROVIDER_NAMES,
  embedHeight,
  embedHtml,
  embedNotice,
  topNavigationAllowed
} from '../musicEmbed'
import { openExternal } from '../openExternal'
import { claimPlayback } from '../media/chatMedia'
import { EmbedFrame } from './EmbedFrame'
import { Icon } from './Icon'
import { TabBarShown } from './tabBarShown'
import { MediaView } from './MediaView'
import { useStyles, useTheme } from './ThemeProvider'
import { layout, radius, space } from './theme'

const THUMB = 64
export const VISIBILITY_MS = 500
// A just-tapped player may still be scrolling into view, so it is not closed
// in its first 2 s.
export const OPEN_GRACE_MS = 2000
// A tall player stays while a meaningful part of it shows.
const SEEN_ENOUGH = 120

const textOf = (v) => (typeof v === 'string' ? displayText(v).trim() : '')

// Whether a slot at (x, y) of w by h has less than half of its width, or less
// than min(half of its height, SEEN_ENOUGH) pt of its height, inside the band
// from top to bottom and 0 to width. The band is where the list is
// seen: measureInWindow reports the slot unclipped, so a slot under the top
// bar or the tab bar would otherwise count as on screen. A slot that cannot
// be measured counts as hidden, so a player whose row left the screen never
// keeps playing.
export function mostlyHidden (x, y, w, h, top, bottom, width) {
  if (![x, y, w, h, top, bottom, width].every(Number.isFinite) || !(w > 0) || !(h > 0)) return true
  const seenW = Math.max(0, Math.min(x + w, width) - Math.max(x, 0))
  const seenH = Math.max(0, Math.min(y + h, bottom) - Math.max(y, top))
  return seenW * 2 < w || seenH < Math.min(h / 2, SEEN_ENOUGH)
}

export function MusicEmbedCard ({ embed, card, thumb, onLongPress }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const win = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const tabBarShown = useContext(TabBarShown)
  const [open, setOpen] = useState(false)
  const [width, setWidth] = useState(0)
  const slot = useRef(null)
  const release = useRef(null)
  const alive = useRef(true)
  const openedLandscape = useRef(false)

  const close = useCallback(() => {
    const done = release.current
    release.current = null
    if (typeof done === 'function') done()
    if (alive.current) setOpen(false)
  }, [])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      close()
    }
  }, [close])

  useEffect(() => {
    if (!open) return undefined
    // A pushed screen has no tab bar (TabBarShown), so its band reaches the
    // bottom of the window; with no provider the bar counts, the early side.
    const top = insets.top + layout.topBar
    const bottom = win.height - (insets.bottom + (tabBarShown ? layout.tabBar : 0))
    const openedAt = Date.now()
    const timer = setInterval(() => {
      // Just tapped: the person may still be scrolling it into view.
      if (Date.now() - openedAt < OPEN_GRACE_MS) return
      // The app is portrait only, so a window that turned after the tap means a
      // full-screen player rotated it and the inline slot is not what the person
      // sees; the check resumes when the window turns back.
      if ((win.width > win.height) !== openedLandscape.current) return
      // A slot that cannot be measured counts as hidden.
      const view = slot.current
      if (!view || typeof view.measureInWindow !== 'function') {
        if (alive.current) close()
        return
      }
      try {
        view.measureInWindow((x, y, w, h) => {
          if (alive.current && mostlyHidden(x, y, w, h, top, bottom, win.width)) close()
        })
      } catch {
        if (alive.current) close()
      }
    }, VISIBILITY_MS)
    return () => clearInterval(timer)
  }, [open, close, win.width, win.height, insets.top, insets.bottom, tabBarShown])

  const url = card && typeof card === 'object' && typeof card.url === 'string' ? card.url : ''
  const host = cardUrlHost(url)
  const name = embed && typeof embed === 'object' && Object.prototype.hasOwnProperty.call(EMBED_PROVIDER_NAMES, embed.provider)
    ? EMBED_PROVIDER_NAMES[embed.provider]
    : null
  if (host === null || name === null) return null

  const title = textOf(card.title)
  const desc = textOf(card.desc)
  const shownHost = displayText(host)
  const openLabel = 'Abrir no ' + name
  const openPage = () => openExternal(url)
  const longPress = typeof onLongPress === 'function' ? onLongPress : undefined
  const onLayout = (event) => {
    const w = event && event.nativeEvent && event.nativeEvent.layout ? event.nativeEvent.layout.width : NaN
    if (Number.isFinite(w)) setWidth(w)
  }

  const play = () => {
    if (!(width > 0) || width < embed.minWidth) {
      openPage()
      return
    }
    // Opened first: a claim refused on the spot closes it again in order.
    openedLandscape.current = win.width > win.height
    setOpen(true)
    const previous = release.current
    if (typeof previous === 'function') previous()
    release.current = claimPlayback({ pause: close }, { bound: true })
  }

  const openLink = (
    <Pressable
      accessibilityRole='link'
      accessibilityLabel={openLabel}
      onPress={openPage}
      onLongPress={longPress}
      delayLongPress={350}
      hitSlop={4}
      style={({ pressed }) => [styles.action, pressed && styles.pressed]}
    >
      <Text style={styles.link}>{openLabel}</Text>
    </Pressable>
  )

  if (open) {
    const height = embedHeight(embed, width)
    return (
      <View style={styles.wrap} onLayout={onLayout}>
        <View ref={slot} collapsable={false} style={{ width: '100%', height }}>
          <EmbedFrame
            embedUrl={embed.embedUrl}
            html={embedHtml(embed)}
            baseUrl={EMBED_BASE_URL}
            allowTop={topNavigationAllowed}
            height={height}
            title={'Player do ' + name}
          />
        </View>
        <View style={styles.actions}>
          <Pressable
            accessibilityRole='button'
            accessibilityLabel={EMBED_CLOSE}
            onPress={close}
            hitSlop={4}
            style={({ pressed }) => [styles.action, styles.closeButton, pressed && styles.pressed]}
          >
            <Icon name='fechar' size={16} color={colors.ink} />
            <Text style={styles.closeText}>{EMBED_CLOSE}</Text>
          </Pressable>
          {openLink}
        </View>
      </View>
    )
  }

  let picture = null
  const stored = card.image
  if (stored && thumb && thumb.kind === 'post' && typeof thumb.author === 'string') {
    picture = <MediaView author={thumb.author} descriptor={stored} persist={thumb.persist !== false} label='prévia do link' style={styles.fill} tapRetry={false} />
  }

  return (
    <View style={[styles.wrap, styles.card]} onLayout={onLayout}>
      <View style={styles.body}>
        <View style={styles.thumb}>
          {picture || <Icon name='tocar' size={22} color={colors.soft} />}
        </View>
        <View style={styles.words}>
          {title ? <Text style={styles.title} numberOfLines={2}>{title}</Text> : null}
          {desc ? <Text style={styles.desc} numberOfLines={2}>{desc}</Text> : null}
          <Text style={styles.host} numberOfLines={1}>{shownHost}</Text>
        </View>
      </View>
      <View style={styles.actions}>
        <Pressable
          accessibilityRole='button'
          accessibilityLabel={EMBED_PLAY + ': ' + name}
          onPress={play}
          onLongPress={longPress}
          delayLongPress={350}
          hitSlop={4}
          style={({ pressed }) => [styles.action, styles.playButton, pressed && styles.pressed]}
        >
          <Icon name='tocar' size={16} color={colors.accentInk} />
          <Text style={styles.playText}>{EMBED_PLAY}</Text>
        </Pressable>
        {openLink}
      </View>
      <Text style={styles.notice}>{embedNotice(embed.provider)}</Text>
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  wrap: { marginTop: space.sm },
  card: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    backgroundColor: colors.card,
    overflow: 'hidden',
    paddingBottom: space.sm
  },
  body: { flexDirection: 'row', alignItems: 'center', minHeight: Math.max(layout.hit, THUMB), gap: space.sm },
  pressed: { opacity: 0.7 },
  thumb: {
    width: THUMB,
    alignSelf: 'stretch',
    minHeight: THUMB,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.skeleton
  },
  fill: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 },
  words: { flex: 1, paddingVertical: space.sm, paddingRight: space.sm, gap: 2 },
  title: { fontSize: 15, lineHeight: 20, fontWeight: '700', color: colors.ink },
  desc: { fontSize: 13, lineHeight: 18, color: colors.soft },
  host: { fontSize: 12, lineHeight: 16, color: colors.soft },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm, paddingHorizontal: space.sm, paddingTop: space.sm },
  action: { minHeight: layout.hit, flexDirection: 'row', alignItems: 'center', gap: space.xs },
  playButton: { paddingHorizontal: space.md, borderRadius: radius.pill, backgroundColor: colors.accent },
  playText: { fontSize: 14, fontWeight: '700', color: colors.accentInk },
  closeButton: { paddingHorizontal: space.md, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.outline },
  closeText: { fontSize: 14, fontWeight: '600', color: colors.ink },
  link: { fontSize: 14, fontWeight: '600', color: colors.accent },
  notice: { fontSize: 12, lineHeight: 16, color: colors.soft, paddingHorizontal: space.sm, paddingTop: space.xs }
})
