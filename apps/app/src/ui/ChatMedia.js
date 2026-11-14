// The photos and GIFs of one chat message, inside its bubble (DMs and
// groups): one to four images laid out by chatSend.js chatMediaLayout (one
// keeps its aspect, two side by side, three and four in a grid), never wider
// than 240 pt, with the bubble's rounded corners. The caption is the
// bubble's text, drawn under this block by Bubble.
//
// Every image comes from ../media/chatMedia.js sourceFor only: a device-local
// URI the node opened (DM and private group items) or bytes fetched from the
// installation that served the app and checked against their descriptor
// (public group items). Nothing here builds a network address. While loading
// a cell is a placeholder of its final size; an item that cannot be shown
// reads 'Mídia indisponível' and the text of the message still shows. A cell
// whose fetch may work later retries on a tap (a read, never a send).
//
// In a message request (deferred) nothing downloads by itself: each cell is
// a placeholder of its size reading 'Toque para ver a foto' and reads its
// item only after that tap. Once the request is accepted the cells load.
// A cell or the viewer showing a URI pins it, so the cache never revokes it
// while it is on screen.
//
// A tap on a shown image opens it full screen (MediaView with the same local
// URI); there it pinches, double taps to zoom and drags down to close, and
// it also closes with its button or the system back.
//
// A long press on an image is the bubble's (its actions: Responder,
// Denunciar), never the viewer's: Bubble passes onLongPress down.
//
// A voice note (one audio/mp4 item, never next to photos) renders as a
// VoiceBubble instead, from the same source and the same deferral.
//
// Props: { refs, identity, mine, deferred, onLongPress }. refs: chatSend.js chatMediaRefs output;
// identity: the own diary key (the cache is per identity).

import { useEffect, useState } from 'react'
import { fetch as expoFetch } from 'expo/fetch'
import { Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useNode } from '../node'
import { isAppClient } from '../appClient'
import { chatMediaKey, isVoiceItem, onChatMediaReturn, pinChatMedia, shouldLoad, sourceFor } from '../media/chatMedia'
import { revokeUrl, urlFromBytes } from '../media/display'
import { chatMediaLayout, itemSize } from '../chatSend'
import { useEscapeLayer } from './escapeLayer'
import { holdEmbeds } from '../embedLive'
import { Icon } from './Icon'
import { MediaView } from './MediaView'
import { ZoomView } from './ZoomView'
import { VOICE_HEIGHT, VOICE_WIDTH, VoiceBubble } from './VoiceBubble'
import { useStyles, useTheme } from './ThemeProvider'
import { radius, space } from './theme'

export const MEDIA_UNAVAILABLE = 'Mídia indisponível'
export const MEDIA_TAP_TO_LOAD = 'Toque para ver a foto'

const display = { urlFromBytes, revokeUrl }
const fetchDeps = () => (isAppClient() ? { fetch: expoFetch } : {})

// Keeps `uri` from being evicted while it is on screen.
function usePinned (uri) {
  useEffect(() => (typeof uri === 'string' ? pinChatMedia(uri) : undefined), [uri])
}

// The stated aspect of an item, for the viewer's pan limits; without one
// they fall back to the whole frame.
function itemRatio (item) {
  const { w, h } = itemSize(item)
  return w > 0 && h > 0 ? w / h : undefined
}

// -> { state: 'held' | 'loading' | 'ok' | 'off', uri, retry, show }
function useChatSource (ref, identity, deferred) {
  const node = useNode()
  const key = chatMediaKey(identity, ref)
  const [attempt, setAttempt] = useState(0)
  const [tapped, setTapped] = useState(false)
  // Back from a background clear: read again (chatMedia onAppStateChange).
  useEffect(() => onChatMediaReturn(() => setAttempt((n) => n + 1)), [])
  const [result, setResult] = useState({ key: null, attempt: -1, entry: null })
  const load = shouldLoad({ deferred, tapped })
  // A refreshed row can mark an item gone (or back): that changes the answer.
  const gone = !!(ref && ref.item && ref.item.unavailable === true)
  useEffect(() => {
    if (key === null || !load) return undefined
    let alive = true
    sourceFor(ref, { node, identity, display, fetchDeps: fetchDeps() }).then((entry) => {
      if (alive) setResult({ key, attempt, gone, entry })
    })
    return () => { alive = false }
    // The ref is identified by its key (and whether it is gone); node only
    // matters when it changes media.
  }, [key, attempt, load, gone, node && node.media])
  const retry = () => setAttempt((n) => n + 1)
  if (key === null) return { state: 'off', uri: null, retry: null }
  if (!load) return { state: 'held', uri: null, retry: null, show: () => setTapped(true) }
  if (result.key !== key || result.attempt !== attempt || result.gone !== gone) return { state: 'loading', uri: null, retry: null }
  const entry = result.entry
  if (entry && typeof entry.uri === 'string') return { state: 'ok', uri: entry.uri, retry: null }
  return { state: 'off', uri: null, retry: entry && entry.retryable === true ? retry : null }
}

function Cell ({ refItem, identity, deferred, cell, count, index, onOpen, onLongPress }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const { state, uri, retry, show } = useChatSource(refItem, identity, deferred)
  usePinned(uri)
  const label = count > 1 ? 'Foto ' + (index + 1) + ' de ' + count : 'Foto'
  const box = { position: 'absolute', left: cell.left, top: cell.top, width: cell.width, height: cell.height }
  if (state === 'held') {
    return (
      <Pressable
        accessibilityRole='button'
        accessibilityLabel={MEDIA_TAP_TO_LOAD + (count > 1 ? ', foto ' + (index + 1) + ' de ' + count : '')}
        onPress={show}
        onLongPress={onLongPress}
        delayLongPress={350}
        style={({ pressed }) => [box, styles.cell, styles.neutral, pressed && styles.pressed]}
      >
        <Icon name='imagem' size={20} color={colors.soft} />
        <Text style={styles.off} numberOfLines={2}>{MEDIA_TAP_TO_LOAD}</Text>
      </Pressable>
    )
  }
  if (state === 'ok') {
    return (
      <Pressable
        accessibilityRole='imagebutton'
        accessibilityLabel={'Abrir foto' + (count > 1 ? ' ' + (index + 1) + ' de ' + count : '')}
        onPress={() => onOpen(uri, itemRatio(refItem && refItem.item))}
        onLongPress={onLongPress}
        delayLongPress={350}
        style={({ pressed }) => [box, styles.cell, pressed && styles.pressed]}
      >
        <MediaView uri={uri} label={label} fit='cover' style={styles.fill} />
      </Pressable>
    )
  }
  if (state === 'loading') {
    return <View style={[box, styles.cell, styles.loading]} accessible accessibilityRole='image' accessibilityLabel={label + ', carregando'} />
  }
  const inner = (
    <>
      <Icon name='imagem' size={20} color={colors.soft} />
      <Text style={styles.off} numberOfLines={2}>{MEDIA_UNAVAILABLE}</Text>
    </>
  )
  if (typeof retry === 'function') {
    return (
      <Pressable
        accessibilityRole='button'
        accessibilityLabel={MEDIA_UNAVAILABLE + ', toque para tentar de novo'}
        onPress={retry}
        onLongPress={onLongPress}
        delayLongPress={350}
        style={({ pressed }) => [box, styles.cell, styles.neutral, pressed && styles.pressed]}
      >
        {inner}
      </Pressable>
    )
  }
  return (
    <View style={[box, styles.cell, styles.neutral]} accessible accessibilityRole='image' accessibilityLabel={MEDIA_UNAVAILABLE}>
      {inner}
    </View>
  )
}

function Viewer ({ uri, ratio, onClose }) {
  const styles = useStyles(makeStyles)
  const insets = useSafeAreaInsets()
  usePinned(uri)
  // Escape closes only the photo, never the conversation behind it.
  useEscapeLayer(uri !== null, onClose, 'viewer')
  // The photo covers the conversation: provider frames stay unmounted while
  // it is open.
  useEffect(() => (uri !== null ? holdEmbeds() : undefined), [uri !== null])
  return (
    <Modal visible={uri !== null} transparent animationType='fade' statusBarTranslucent onRequestClose={onClose}>
      <View style={styles.viewer}>
        {uri !== null
          ? (
            <ZoomView style={styles.viewerImage} ratio={ratio} resetKey={uri} onDismiss={onClose}>
              <MediaView uri={uri} label='Foto' fit='contain' style={styles.viewerImage} dark />
            </ZoomView>
            )
          : null}
        <Pressable
          accessibilityRole='button'
          accessibilityLabel='Fechar foto'
          onPress={onClose}
          hitSlop={8}
          style={[styles.close, { top: insets.top + space.sm }]}
        >
          <Icon name='fechar' size={22} color='#ffffff' />
        </Pressable>
      </View>
    </Modal>
  )
}

// The block's layout for `refs` on a screen `screen` points wide: the
// bubble column is 80% of the row, so a narrow phone gets a narrower block.
// Bubble uses the same numbers to hug the block, so a caption wraps under the
// photos instead of widening the bubble past them, as in WhatsApp.
export function chatMediaBlock (refs, screen) {
  const list = Array.isArray(refs) ? refs : []
  if (isVoiceRefs(list)) return { width: VOICE_WIDTH, height: VOICE_HEIGHT, cells: [] }
  return chatMediaLayout(list.map((ref) => itemSize(ref.item)), Math.floor(screen * 0.8) - space.md * 2)
}

function isVoiceRefs (list) {
  return list.length === 1 && !!list[0] && isVoiceItem(list[0].item)
}

function VoiceCell ({ refItem, identity, deferred, mine, onLongPress }) {
  const { state, uri, retry, show } = useChatSource(refItem, identity, deferred)
  usePinned(uri)
  const ms = refItem && refItem.item && Number.isInteger(refItem.item.ms) ? refItem.item.ms : 0
  return <VoiceBubble state={state} uri={uri} retry={retry} show={show} durationMs={ms} mine={mine} onLongPress={onLongPress} />
}

export function ChatMedia ({ refs, identity, mine = false, deferred = false, onLongPress }) {
  const styles = useStyles(makeStyles)
  const { width: screen } = useWindowDimensions()
  const [open, setOpen] = useState(null)
  const [openRatio, setOpenRatio] = useState(undefined)
  // Back from a background clear the open photo's file is gone: close the
  // viewer (the cell reads again and can be opened anew).
  useEffect(() => onChatMediaReturn(() => setOpen(null)), [])
  const openPhoto = (uri, ratio) => {
    setOpenRatio(ratio)
    setOpen(uri)
  }
  const list = Array.isArray(refs) ? refs : []
  if (isVoiceRefs(list)) {
    return <VoiceCell refItem={list[0]} identity={identity} deferred={deferred === true} mine={mine} onLongPress={onLongPress} />
  }
  const layout = chatMediaBlock(list, screen)
  if (layout === null) return null
  return (
    <View
      style={[styles.block, { width: layout.width, height: layout.height }, mine && styles.blockMine]}
      accessibilityLabel={list.length > 1 ? list.length + ' fotos' : 'Foto'}
    >
      {list.map((ref, i) => (
        <Cell key={i} refItem={ref} identity={identity} deferred={deferred === true} cell={layout.cells[i]} count={list.length} index={i} onOpen={openPhoto} onLongPress={onLongPress} />
      ))}
      <Viewer uri={open} ratio={openRatio} onClose={() => setOpen(null)} />
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  block: { borderRadius: radius.bubble - 4, overflow: 'hidden', marginBottom: space.xs, alignSelf: 'flex-start' },
  blockMine: { alignSelf: 'flex-end' },
  cell: { overflow: 'hidden', backgroundColor: colors.skeleton },
  fill: { ...StyleSheet.absoluteFillObject },
  loading: { backgroundColor: colors.skeleton },
  neutral: { alignItems: 'center', justifyContent: 'center', gap: space.xs, padding: space.sm },
  off: { fontSize: 13, lineHeight: 17, color: colors.soft, textAlign: 'center' },
  pressed: { opacity: 0.85 },
  viewer: { flex: 1, backgroundColor: '#000000' },
  viewerImage: { ...StyleSheet.absoluteFillObject },
  close: {
    position: 'absolute',
    right: space.md,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)'
  }
})
