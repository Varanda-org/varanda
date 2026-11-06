// GIF search for a chat composer: a Sheet with a search field and a
// two-column grid. Every request goes to the account origin (src/account.js
// gifSearch / gifImage with the member's GIF session); the service names
// GIFs by opaque ids, so no provider host is ever shown, fetched or sent.
// A cell's tiny GIF arrives as bytes, becomes a device-local URL
// (../media/display) and is released when the cell leaves the grid or the
// sheet closes. A pick fetches the full bytes, runs the gallery GIF checks
// (gif.js gifFileFrom: the header, the size limits, mediaBounds from
// @varanda/rpc) and hands the file to onPick, which stages it like a gallery
// GIF: readers then load it only from Varanda storage, never the provider.
//
// useGifReady: whether the GIF row shows (the policy is on for this
// installation and the member is linked). Any failure hides it.
//
// Props: { open, onClose, onPick(file), member, origin, request }

import { useEffect, useReducer, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { gifImage, gifReady, gifSearch } from '../account'
import { GIF_DEBOUNCE_MS, gifFileFrom, gifIdle, gifNotice, gifOriginOf, gifQueue, gifReduce, gifErrorText } from '../gif'
import { revokeUrl, urlFromBytes } from '../media/display'
import { Icon } from './Icon'
import { Sheet } from './Sheet'
import { useStyles, useTheme } from './ThemeProvider'
import { radius, space, webInputReset } from './theme'

const GAP = space.xs

// gifOriginOf (../gif): GIF only on a hosted node; elsewhere null.
export { gifOriginOf }

export function useGifReady ({ node, member }) {
  const [ready, setReady] = useState(false)
  const origin = gifOriginOf(node)
  const online = node !== null && node !== undefined && node.online !== false
  useEffect(() => {
    let live = true
    setReady(false)
    if (origin === null || !online || typeof member !== 'string') return
    gifReady({ member, origin }).then((ok) => { if (live) setReady(ok === true) }, () => {})
    return () => { live = false }
  }, [origin, online, member])
  return ready
}

function GifTile ({ item, size, session, queue, onPress, picking }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const [uri, setUri] = useState(null)
  useEffect(() => {
    let live = true
    let made = null
    queue.run(() => (live ? gifImage(item.id, 'tiny', session) : null)).then((bytes) => {
      if (!live || !(bytes instanceof Uint8Array)) return
      try {
        made = urlFromBytes(bytes, 'image/gif')
      } catch {
        return
      }
      setUri(made)
    }, () => {})
    return () => {
      live = false
      if (made !== null) revokeUrl(made)
    }
  }, [item.id, session, queue])
  const height = Math.max(48, Math.min(size * 1.6, Math.round(size * item.height / item.width)))
  return (
    <Pressable
      accessibilityRole='button'
      accessibilityLabel='Enviar este GIF'
      disabled={picking !== null}
      onPress={() => onPress(item)}
      style={({ pressed }) => [styles.tile, { width: size, height }, pressed && styles.pressed]}
    >
      {uri !== null ? <Image source={{ uri }} style={styles.image} resizeMode='cover' /> : null}
      {picking === item.id ? <View style={styles.busy}><ActivityIndicator color={colors.accentInk} /></View> : null}
    </Pressable>
  )
}

export function GifPicker ({ open, onClose, onPick, member, origin, request }) {
  return (
    <Sheet open={open} onClose={onClose} title='GIF'>
      {open ? <GifSearch onClose={onClose} onPick={onPick} member={member} origin={origin} request={request} /> : null}
    </Sheet>
  )
}

function GifSearch ({ onClose, onPick, member, origin, request }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const [text, setText] = useState('')
  const [state, dispatch] = useReducer(gifReduce, gifIdle)
  const [width, setWidth] = useState(0)
  const [picking, setPicking] = useState(null)
  const [pickError, setPickError] = useState('')
  const queueRef = useRef(null)
  if (queueRef.current === null) queueRef.current = gifQueue(4)
  const sessionRef = useRef(null)
  if (sessionRef.current === null || sessionRef.current.member !== member || sessionRef.current.origin !== origin || sessionRef.current.request !== request) {
    sessionRef.current = { member, origin, request }
  }
  const session = sessionRef.current
  const liveRef = useRef(true)
  useEffect(() => () => { liveRef.current = false }, [])

  useEffect(() => {
    const timer = setTimeout(() => dispatch({ type: 'query', text }), GIF_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [text])

  const { phase, gen, query, next } = state
  useEffect(() => {
    if (phase !== 'loading' && phase !== 'more') return
    const cursor = phase === 'more' ? next : undefined
    gifSearch(query, { cursor, ...session }).then(
      (page) => { if (liveRef.current) dispatch({ type: 'page', gen, page }) },
      (error) => { if (liveRef.current) dispatch({ type: 'fail', gen, error }) }
    )
    // gen alone names the request; the rest only rides along.
  }, [gen])

  const pick = async (item) => {
    if (picking !== null) return
    setPicking(item.id)
    setPickError('')
    let file = null
    try {
      file = gifFileFrom(await gifImage(item.id, 'full', session))
      if (file === null) throw new Error('formato')
    } catch (err) {
      if (liveRef.current) {
        setPicking(null)
        setPickError(err && typeof err.code === 'string' ? gifErrorText(err) : 'Este GIF não pode ser enviado')
      }
      return
    }
    if (!liveRef.current) return
    setPicking(null)
    onPick(file)
    onClose()
  }

  const size = width > 0 ? Math.floor((width - GAP) / 2) : 0
  const notice = pickError || gifNotice(state) || state.error
  return (
    <View style={styles.root} onLayout={(e) => setWidth(e.nativeEvent.layout.width - space.lg * 2)}>
      <View style={styles.searchRow}>
        <Icon name='lupa' size={18} color={colors.soft} />
        <TextInput
          style={[styles.input, webInputReset]}
          value={text}
          onChangeText={setText}
          placeholder='Buscar GIF'
          placeholderTextColor={colors.placeholder}
          autoCapitalize='none'
          autoCorrect={false}
          autoFocus
          returnKeyType='search'
          accessibilityLabel='buscar GIF'
        />
      </View>
      {notice ? <Text style={styles.notice} accessibilityLiveRegion='polite'>{notice}</Text> : null}
      {phase === 'loading' ? <ActivityIndicator style={styles.spinner} color={colors.soft} /> : null}
      {size > 0
        ? (
          <FlatList
            data={state.items}
            keyExtractor={(item) => item.id}
            numColumns={2}
            columnWrapperStyle={styles.column}
            contentContainerStyle={styles.grid}
            keyboardShouldPersistTaps='handled'
            removeClippedSubviews
            onEndReachedThreshold={0.6}
            onEndReached={() => dispatch({ type: 'more' })}
            ListFooterComponent={phase === 'more' ? <ActivityIndicator style={styles.spinner} color={colors.soft} /> : null}
            renderItem={({ item }) => (
              <GifTile item={item} size={size} session={session} queue={queueRef.current} onPress={pick} picking={picking} />
            )}
          />
          )
        : null}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  root: { flex: 1, paddingHorizontal: space.lg },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 40,
    paddingHorizontal: space.md,
    borderRadius: radius.lg,
    backgroundColor: colors.bg,
    marginBottom: space.sm
  },
  input: { flex: 1, minWidth: 0, fontSize: 16, paddingVertical: space.sm, color: colors.ink },
  notice: { fontSize: 15, lineHeight: 20, color: colors.soft, textAlign: 'center', paddingVertical: space.md },
  spinner: { paddingVertical: space.md },
  grid: { paddingBottom: space.xl, gap: GAP },
  column: { gap: GAP, alignItems: 'flex-start' },
  tile: { borderRadius: radius.sm, overflow: 'hidden', backgroundColor: colors.bg },
  image: { width: '100%', height: '100%' },
  busy: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.35)' },
  pressed: { opacity: 0.7 }
})
