// One post of the preview a visitor sees before sign-in (./PostLinkOpen.js),
// drawn with a timeline row's metrics but none of its behaviour: every press
// calls onAsk, and nothing reaches a node, a URL or another menu. Not
// ./PostRow: its 'mais' opens a report sheet, its text links are live and it
// says relative time. The model comes from ../postPreview.js and its strings
// are raw peer text, so each goes through displayText; the text is plain,
// with no link, mention or hashtag parsing.
//
// `skeleton` draws the same row with no peer content, whether the preview is
// still loading or will never come. `hidden` takes every control out of the
// accessibility tree and the tab order (the dimmed rows under the preview).

import { useEffect, useRef, useState } from 'react'
import { Image, Pressable, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { photoUrl } from '../postPreview'
import {
  A11Y_CARD, A11Y_LIKE, A11Y_MORE, A11Y_OPEN, A11Y_PROFILE, A11Y_REPLY, A11Y_REPOST, VIDEO_LINE,
  PHOTO_RETRY_MS, PHOTO_STALL_MS, TILE_START, morePhotosLine, photoLabel, relationLine, tileMayLoad, tileSettled, tileStep
} from '../postPreviewCopy'
import { whoOf } from '../who'
import { Avatar } from './Avatar'
import { Icon } from './Icon'
import { layout, radius, type } from './theme'
import { useStyles, useTheme } from './ThemeProvider'

const ICON = 20
const AVATAR = 40
const TEXT_LINES = 12

export function PostLinkPreviewRow ({ model, origin, post, onAsk, skeleton, hidden }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const shown = skeleton !== true && model !== null && typeof model === 'object'
  const ask = () => { if (typeof onAsk === 'function') onAsk() }
  const off = hidden === true ? { accessible: false, focusable: false, tabIndex: -1 } : null
  const who = shown ? whoOf({ name: model.name, username: model.username }) : null
  const title = who !== null ? displayText(who.title) : ''
  const handle = who !== null && who.subtitle ? displayText(who.subtitle) : null
  const date = shown && model.date !== '' ? displayText(model.date) : ''
  const relation = shown ? relationLine(model.relation) : ''
  const text = shown && model.text !== '' ? displayText(model.text, { multiline: true }) : ''
  const more = shown ? morePhotosLine(model.morePhotos) : ''
  const card = shown && model.card !== null ? { title: displayText(model.card.title), host: displayText(model.card.host) } : null
  const bodyLabel = [A11Y_OPEN, title, handle, date, relation, text].filter(Boolean).join('. ')
  return (
    <Pressable accessible={false} focusable={false} tabIndex={-1} onPress={ask} style={styles.row}>
      <View style={styles.main}>
        <Pressable
          accessibilityRole='button'
          accessibilityLabel={A11Y_PROFILE}
          onPress={ask}
          {...off}
          style={({ pressed }) => [styles.avatarHit, pressed && styles.pressed]}
        >
          {shown
            ? <Avatar name={who.avatarName} size={AVATAR} />
            : <View style={styles.skAvatar} />}
        </Pressable>
        <View style={styles.body}>
          <Pressable
            accessibilityRole='button'
            accessibilityLabel={bodyLabel}
            onPress={ask}
            {...off}
            style={({ pressed }) => pressed && styles.pressed}
          >
            <View accessibilityElementsHidden importantForAccessibility='no-hide-descendants'>
              {shown
                ? (
                  <View style={styles.head}>
                    <Text style={styles.name} numberOfLines={1}>{title}</Text>
                    {handle ? <Text style={styles.handle} numberOfLines={1}>{handle}</Text> : null}
                    {date ? <Text style={styles.time} numberOfLines={1}>{(handle ? ' · ' : '· ') + date}</Text> : null}
                  </View>
                  )
                : (
                  <View style={styles.skHead}>
                    <View style={[styles.skBar, styles.skName]} />
                    <View style={[styles.skBar, styles.skHandle]} />
                  </View>
                  )}
              {relation ? <Text style={styles.relation} numberOfLines={1}>{relation}</Text> : null}
              {shown
                ? (text ? <Text style={styles.text} numberOfLines={TEXT_LINES}>{text}</Text> : null)
                : (
                  <View style={styles.skLines}>
                    <View style={[styles.skBar, { width: '92%' }]} />
                    <View style={[styles.skBar, { width: '84%' }]} />
                    <View style={[styles.skBar, { width: '56%' }]} />
                  </View>
                  )}
            </View>
          </Pressable>
          {shown
            ? (model.photoCount > 0 ? <PhotoGrid count={model.photoCount} video={model.video} origin={origin} post={post} onAsk={ask} off={off} /> : null)
            : <Pressable onPress={ask} accessible={false} focusable={false} tabIndex={-1} style={styles.skMedia} />}
          {more ? <Line label={more} onAsk={ask} off={off} /> : null}
          {shown && model.video ? <Line label={VIDEO_LINE} onAsk={ask} off={off} /> : null}
          {card !== null
            ? (
              <Pressable
                accessibilityRole='button'
                accessibilityLabel={A11Y_CARD + '. ' + card.title + '. ' + card.host}
                onPress={ask}
                {...off}
                style={({ pressed }) => [styles.card, pressed && styles.pressed]}
              >
                <View style={styles.cardBody} accessibilityElementsHidden importantForAccessibility='no-hide-descendants'>
                  <Text style={styles.cardTitle} numberOfLines={2}>{card.title}</Text>
                  <View style={styles.cardHostRow}>
                    <Icon name='link' size={14} color={colors.soft} />
                    <Text style={styles.cardHost} numberOfLines={1}>{card.host}</Text>
                  </View>
                </View>
              </Pressable>
              )
            : null}
          <View style={styles.headActions}>
            <Action label={A11Y_MORE} onPress={ask} off={off}>
              <Icon name='mais' size={ICON} color={colors.soft} />
            </Action>
          </View>
          <View style={styles.bar}>
            <Action label={A11Y_REPLY} onPress={ask} off={off}>
              <Icon name='resposta' size={ICON} color={colors.soft} />
            </Action>
            <Action label={A11Y_REPOST} onPress={ask} off={off}>
              <Icon name='republicar' size={ICON} color={colors.soft} />
            </Action>
            <Action label={A11Y_LIKE} onPress={ask} off={off}>
              <Icon name='coracao' size={ICON} color={colors.soft} />
            </Action>
          </View>
        </View>
      </View>
    </Pressable>
  )
}

function Action ({ label, onPress, off, children }) {
  const styles = useStyles(makeStyles)
  return (
    <Pressable
      accessibilityRole='button'
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={6}
      {...off}
      style={({ pressed }) => [styles.action, pressed && styles.pressed]}
    >
      {children}
    </Pressable>
  )
}

function Line ({ label, onAsk, off }) {
  const styles = useStyles(makeStyles)
  return (
    <Pressable
      accessibilityRole='button'
      accessibilityLabel={label}
      onPress={onAsk}
      {...off}
      style={({ pressed }) => [styles.line, pressed && styles.pressed]}
    >
      <Text style={styles.lineText}>{label}</Text>
    </Pressable>
  )
}

function PhotoGrid ({ count, video, origin, post, onAsk, off }) {
  const styles = useStyles(makeStyles)
  const [settled, setSettled] = useState(0)
  const onSettled = (index) => setSettled((s) => Math.max(s, index + 1))
  const tiles = []
  for (let i = 0; i < count; i++) {
    tiles.push(
      <PhotoTile
        key={i}
        index={i}
        single={count === 1}
        uri={photoUrl(origin, post, i + 1)}
        label={photoLabel(i + 1, video)}
        video={video}
        mayLoad={tileMayLoad(i, settled)}
        onSettled={onSettled}
        onAsk={onAsk}
        off={off}
      />
    )
  }
  return <View style={count === 1 ? styles.gridOne : styles.grid}>{tiles}</View>
}

function PhotoTile ({ index, single, uri, label, video, mayLoad, onSettled, onAsk, off }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const [tile, setTile] = useState(() => (typeof uri === 'string' ? TILE_START : { ...TILE_START, phase: 'failed' }))
  const reported = useRef(false)
  const step = (event) => setTile((t) => tileStep(t, event))
  useEffect(() => {
    if (!reported.current && tileSettled(tile)) {
      reported.current = true
      onSettled(index)
    }
  }, [tile])
  useEffect(() => {
    if (!mayLoad || tile.phase !== 'waiting') return
    const timer = setTimeout(() => step('retry'), PHOTO_RETRY_MS)
    return () => clearTimeout(timer)
  }, [mayLoad, tile.phase])
  useEffect(() => {
    if (!mayLoad || tile.phase !== 'loading' || tile.stalled) return
    const timer = setTimeout(() => step('stall'), PHOTO_STALL_MS)
    return () => clearTimeout(timer)
  }, [mayLoad, tile.phase, tile.attempt, tile.stalled])
  const showImage = mayLoad && (tile.phase === 'loading' || tile.phase === 'loaded')
  return (
    <View style={single ? styles.tileOne : styles.tile}>
      <Pressable
        accessibilityRole='button'
        accessibilityLabel={label}
        onPress={onAsk}
        {...off}
        style={({ pressed }) => [styles.tileFace, pressed && styles.pressed]}
      >
        {tile.phase === 'failed'
          ? <View style={styles.tilePlaceholder}><Icon name='imagem' size={24} color={colors.soft} /></View>
          : null}
        {showImage
          ? (
            <Image
              key={tile.attempt}
              source={{ uri }}
              style={styles.fill}
              resizeMode='cover'
              accessible={false}
              accessibilityIgnoresInvertColors
              onLoad={() => step('load')}
              onError={() => step('error')}
            />
            )
          : null}
        {video
          ? <View style={styles.play}><View style={styles.playDisc}><Icon name='tocar' size={24} color={colors.toastInk} /></View></View>
          : null}
      </Pressable>
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  row: {
    paddingTop: 16,
    paddingHorizontal: 16,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    backgroundColor: colors.bg
  },
  main: { flexDirection: 'row', gap: 12 },
  // A 44 pt target around the 40 pt avatar that still takes 40 pt of the row.
  avatarHit: { alignSelf: 'flex-start', width: layout.hit, height: layout.hit, margin: (AVATAR - layout.hit) / 2, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, minWidth: 0 },
  head: { flexDirection: 'row', alignItems: 'baseline', paddingRight: layout.hit },
  name: { ...type.postName, color: colors.ink, flexShrink: 1, marginRight: 6 },
  handle: { ...type.meta, color: colors.soft, flexShrink: 10000, minWidth: 32 },
  time: { ...type.meta, color: colors.soft, flexShrink: 0 },
  relation: { ...type.meta, color: colors.soft, marginTop: 2 },
  text: { ...type.postText, color: colors.ink, marginTop: 3 },
  line: { alignSelf: 'flex-start', minHeight: layout.hit, justifyContent: 'center' },
  lineText: { ...type.meta, color: colors.soft, fontWeight: '600' },
  card: { marginTop: 8, minHeight: layout.hit, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card },
  cardBody: { paddingHorizontal: 12, paddingVertical: 10, gap: 4 },
  cardTitle: { ...type.tileTitle, color: colors.ink },
  cardHostRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  cardHost: { ...type.meta, color: colors.soft, flexShrink: 1 },
  gridOne: { marginTop: 8 },
  grid: { marginTop: 8, marginHorizontal: -2, flexDirection: 'row', flexWrap: 'wrap' },
  tileOne: { width: '100%', aspectRatio: 4 / 3 },
  tile: { width: '50%', aspectRatio: 1, padding: 2 },
  tileFace: { flex: 1, borderRadius: radius.md, overflow: 'hidden', backgroundColor: colors.skeleton },
  tilePlaceholder: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  fill: { ...StyleSheet.absoluteFillObject },
  play: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  playDisc: { width: 52, height: 52, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.toastBg, opacity: 0.85 },
  headActions: { position: 'absolute', top: -12, right: 0, flexDirection: 'row', alignItems: 'center' },
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 0, marginBottom: -4, marginLeft: -8, maxWidth: 360 },
  action: { flexDirection: 'row', alignItems: 'center', minHeight: layout.hit, minWidth: 44, paddingHorizontal: 8, justifyContent: 'center' },
  skAvatar: { width: AVATAR, height: AVATAR, borderRadius: AVATAR / 2, backgroundColor: colors.skeleton },
  skHead: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 20, paddingRight: layout.hit },
  skBar: { height: 12, borderRadius: 6, backgroundColor: colors.skeleton },
  skName: { width: '34%' },
  skHandle: { width: '22%' },
  skLines: { gap: 8, marginTop: 8 },
  skMedia: { marginTop: 10, width: '100%', aspectRatio: 4 / 3, borderRadius: radius.md, backgroundColor: colors.skeleton },
  pressed: { opacity: 0.6 }
})
