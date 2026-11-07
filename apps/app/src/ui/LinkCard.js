// A link card: what the sender's device read once from a page it linked
// (docs/protocol.md, "Link cards"), drawn from that stored data only. Showing
// it never contacts the site: no request to the URL, no site icon, no
// prefetch, no frame, no player. The title, description and host are peer
// text and go through displayText. The host shown is the one the URL really
// opens (cardUrlHost), so a card cannot name one site and open another; a
// card whose URL fails that rule is not drawn at all.
//
// The thumbnail comes only from the stored image descriptor, through the
// same device-local paths photos use, and never from the URL:
//   thumb = { kind: 'post', author, persist }: a diary post's public
//     descriptor, read by ./MediaView like a post photo (hosted node only).
//   thumb = { kind: 'group', diary, identity }: a group post's descriptor or
//     private item, read by ../media/chatMedia.js sourceFor like a chat photo.
//   thumb = { kind: 'dm', from, id, identity }: a DM card's item, opened by
//     the node (media.read with index 'card') through ../media/chatMedia.js
//     sourceFor like a DM photo.
//   none: no thumbnail, a neutral link tile instead.
// What reaches the Image is always a blob: or file:// URI (MediaView refuses
// anything else).
//
// Opening the URL is an explicit tap (openExternal), distinct from drawing.
//
// Props:
//   card: { url, host, title, desc, image } (stored), or
//   draft: { url, host, title, desc } the composer's draft, with imageUri (a
//     local URI the composer passes) and onDismiss (the remove button).
//   thumb: see above. onLongPress: handed to the card (a bubble's actions).

import { useEffect, useState } from 'react'
import { fetch as expoFetch } from 'expo/fetch'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { cardUrlHost, displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { isAppClient } from '../appClient'
import { openExternal } from '../openExternal'
import { chatMediaKey, pinChatMedia, sourceFor } from '../media/chatMedia'
import { revokeUrl, urlFromBytes } from '../media/display'
import { Icon } from './Icon'
import { MediaView } from './MediaView'
import { useStyles, useTheme } from './ThemeProvider'
import { layout, radius, space } from './theme'

export const LINK_CARD_OPEN = 'Abrir link'
export const LINK_CARD_DISMISS = 'Remover prévia do link'

const THUMB = 64
const display = { urlFromBytes, revokeUrl }
const fetchDeps = () => (isAppClient() ? { fetch: expoFetch } : {})

const textOf = (v) => (typeof v === 'string' ? displayText(v).trim() : '')

// The chatMedia ref of a group or DM card's thumbnail, or null.
export function chatThumbRef (thumb, image) {
  if (!thumb || typeof thumb !== 'object' || !image || typeof image !== 'object') return null
  if (thumb.kind === 'group') return { kind: 'group', diary: thumb.diary, item: image }
  if (thumb.kind === 'dm') return { kind: 'dm', from: thumb.from, id: thumb.id, index: 'card', item: image }
  return null
}

// The device-local URI of a group or DM card's thumbnail, or null while
// loading or when it cannot be shown. Pinned while on screen.
function useChatThumb (thumb, image) {
  const node = useNode()
  const ref = chatThumbRef(thumb, image)
  const identity = ref !== null ? thumb.identity : null
  const key = ref ? chatMediaKey(identity, ref) : null
  const [got, setGot] = useState({ key: null, uri: null })
  useEffect(() => {
    if (key === null) return undefined
    let alive = true
    sourceFor(ref, { node, identity, display, fetchDeps: fetchDeps() }).then((entry) => {
      if (alive) setGot({ key, uri: entry && typeof entry.uri === 'string' ? entry.uri : null })
    })
    return () => { alive = false }
    // The ref is identified by its key; node only matters when it changes media.
  }, [key, node && node.media])
  const uri = key !== null && got.key === key ? got.uri : null
  useEffect(() => (typeof uri === 'string' ? pinChatMedia(uri) : undefined), [uri])
  return uri
}

export function LinkCard ({ card, draft, imageUri, onDismiss, thumb, onLongPress }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const data = draft || card
  const url = data && typeof data === 'object' && typeof data.url === 'string' ? data.url : ''
  const host = cardUrlHost(url)
  const stored = !draft && card && typeof card === 'object' ? card.image : null
  const chatUri = useChatThumb(draft ? null : thumb, stored)
  if (host === null) return null
  const title = textOf(data.title)
  const desc = textOf(data.desc)
  const shownHost = displayText(host)
  const open = () => openExternal(url)
  const label = LINK_CARD_OPEN + ': ' + (title ? title + ', ' : '') + shownHost

  let picture = null
  if (draft) {
    if (typeof imageUri === 'string' && imageUri !== '') picture = <MediaView uri={imageUri} label='prévia do link' style={styles.fill} />
  } else if (stored && thumb && thumb.kind === 'post' && typeof thumb.author === 'string') {
    picture = <MediaView author={thumb.author} descriptor={stored} persist={thumb.persist !== false} label='prévia do link' style={styles.fill} onPress={open} />
  } else if (typeof chatUri === 'string') {
    picture = <MediaView uri={chatUri} label='prévia do link' style={styles.fill} onPress={open} />
  }

  return (
    <View style={styles.card}>
      <Pressable
        accessibilityRole='link'
        accessibilityLabel={label}
        onPress={open}
        onLongPress={typeof onLongPress === 'function' ? onLongPress : undefined}
        delayLongPress={350}
        style={({ pressed }) => [styles.body, pressed && styles.pressed]}
      >
        <View style={styles.thumb}>
          {picture || <Icon name='link' size={22} color={colors.soft} />}
        </View>
        <View style={styles.words}>
          {title ? <Text style={styles.title} numberOfLines={2}>{title}</Text> : null}
          {desc ? <Text style={styles.desc} numberOfLines={2}>{desc}</Text> : null}
          <Text style={styles.host} numberOfLines={1}>{shownHost}</Text>
        </View>
      </Pressable>
      {draft && typeof onDismiss === 'function'
        ? (
          <Pressable
            accessibilityRole='button'
            accessibilityLabel={LINK_CARD_DISMISS}
            onPress={onDismiss}
            style={({ pressed }) => [styles.dismiss, pressed && styles.pressed]}
          >
            <Icon name='fechar' size={18} color={colors.soft} />
          </Pressable>
          )
        : null}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'stretch',
    marginTop: space.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    backgroundColor: colors.card,
    overflow: 'hidden'
  },
  body: { flex: 1, flexDirection: 'row', alignItems: 'center', minHeight: Math.max(layout.hit, THUMB), gap: space.sm },
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
  dismiss: { width: layout.hit, minHeight: layout.hit, alignItems: 'center', justifyContent: 'center' }
})
