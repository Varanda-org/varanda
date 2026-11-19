// A round (or, with shape='square', rounded-square) avatar with the person's initials on the stripe colour picked by
// the first byte of the key. With no name it shows a person glyph instead:
// no character derived from a key is ever drawn. Decorative: the name is
// read elsewhere. mediaAuthor defaults to publicKey for profiles; groups
// pass the diary that owns the image, or null when that author is unknown.
//
// A profile photo is drawn over the initials only on a hosted node (as
// MediaView does for post photos): the bytes come from the installation's
// /media route, verified by ../media/avatar.js (SHA-256, still image, exact
// 512x512), and only a blob: URL (web) or a cache file:// URI (native, from
// ../media/display) is ever drawn. Retryable failures retry on the
// ladder of ../media/cache.js while mounted; any final failure, or an image that
// does not render, leaves the initials. localUri (a blob: URL the editor
// just made) is drawn as is. Without a hosted node nothing is fetched.
// persist is false for authors the device does not follow (cache: 'no-store'
// on the web; natively no cache option, see fetchMedia). With persist the
// verified photo also goes to the kept store (../media/keptLoad.js) and the
// next start draws it from there with no fetch.

import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { fetch as expoFetch } from 'expo/fetch'
import { Image, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { useHosted, useMemberKey, useNodeHandle } from '../node'
import { validPrivateGroupImage } from '../groupImage'
import { avatarColorOf } from '../format'
import { avatarKey, fetchAvatarBytes, validAvatar } from '../media/avatar'
import { createMediaCache, onRevokedRanges, retryDelay } from '../media/cache'
import { revokeUrl, urlFromBytes } from '../media/display'
import * as display from '../media/display'
import { chatMediaKey, onChatMediaReturn, pinChatMedia, sourceFor } from '../media/chatMedia'
import * as keptStore from '../media/keep'
import { loadKept, registerKeptStore } from '../media/keptLoad'
import { bumpCacheGeneration, cacheGeneration, registerLocalCache } from '../localCaches'
import { isAppClient } from '../appClient'
import { Icon } from './Icon'
import { KeptOnlyContext, keptOnlyUrl, mediaHashDeps } from './MediaView'
import { stripes } from './theme'
import { useTheme } from './ThemeProvider'

// The native app streams media through expo/fetch so the byte cap stops the
// download (see fetchMedia); the web keeps the global fetch.
const mediaFetch = () => (isAppClient() ? expoFetch : undefined)

const cache = createMediaCache({ max: 128, concurrency: 4, revoke: revokeUrl })

// Same registration as MediaView's; it runs once whichever module loads first.
registerKeptStore({ onRevokedRanges, bumpCacheGeneration, registerLocalCache, store: keptStore, cache })

const isShownUrl = (url) => typeof url === 'string' && (url.startsWith('blob:') || url.startsWith('file:'))

// Hands a blob: URL of verified bytes (the editor's own upload) to the
// cache, which then owns it; a URL already cached for the key wins. The
// caller must pass bytes that passed checkAvatarBytes and whose SHA-256 the
// descriptor carries: a cache hit is drawn without a second check.
export function primeAvatar (author, descriptor, blobUrl) {
  if (!validAvatar(descriptor) || !isShownUrl(blobUrl)) return
  const key = avatarKey(author, descriptor)
  const revoke = () => revokeUrl(blobUrl)
  const hit = cache.peek(key)
  if (hit === blobUrl) return
  if (hit !== null) {
    revoke()
    return
  }
  // A load already in flight for the key keeps its own loader; if it fails
  // (a 404 before the blocks reach the seeder), the retry runs this one.
  const prime = () => cache.get(key, () => Promise.resolve(blobUrl))
  const settle = (url) => { if (url !== blobUrl) revoke() }
  prime().then(settle, () => prime().then(settle, revoke))
}

// -> a blob: or file: URL to draw, or null.
function useAvatarUrl (publicKey, picture, persist) {
  const hosted = useHosted()
  // Kept-only mode (./MediaView.js KeptOnlyContext): the kept copy or the
  // initials, never a fetch.
  const keptOnly = useContext(KeptOnlyContext) === true
  const canFetch = !keptOnly && hosted === true
  const keptKey = keptOnly && typeof publicKey === 'string' && /^[0-9a-f]{64}$/i.test(publicKey) && validAvatar(picture) ? avatarKey(publicKey, picture) : null
  const kept = useMemo(() => (keptKey !== null ? keptOnlyUrl('avatars', publicKey, picture, persist) : null), [keptKey, publicKey, persist])
  const key = canFetch && typeof publicKey === 'string' && /^[0-9a-f]{64}$/i.test(publicKey) && validAvatar(picture) ? avatarKey(publicKey, picture) : null
  const [attempt, setAttempt] = useState(0)
  const autoRef = useRef({ key: null, done: 0 })
  const [result, setResult] = useState(() => {
    const hit = key ? cache.peek(key) : null
    return { key: hit ? key : null, url: hit }
  })
  useEffect(() => {
    if (!key) return
    if (autoRef.current.key !== key) autoRef.current = { key, done: 0 }
    let alive = true
    let timer = null
    const hit = cache.peek(key)
    if (hit) {
      setResult({ key, url: hit })
      return
    }
    const fresh = attempt > 0
    // Only bytes that passed fetchAvatarBytes (descriptor, SHA-256 and
    // still-image checks) are kept, so a kept hit needs no check again.
    // Read now, not when the load leaves the queue: a purge while it waits
    // must still prevent the keep.
    const requestedGeneration = cacheGeneration()
    const load = () => loadKept({
      kind: 'avatars',
      author: publicKey,
      d: picture,
      persist,
      keptUrl: keptStore.keptUrl,
      keep: keptStore.keep,
      fetchBytes: (d) => fetchAvatarBytes(publicKey, d, { ...mediaHashDeps(), persist, fresh, fetch: mediaFetch() }),
      urlFromBytes,
      generation: cacheGeneration,
      requestedGeneration
    })
    cache.get(key, load).then(
      (url) => { if (alive) setResult({ key, url }) },
      (err) => {
        if (!alive) return
        const delay = retryDelay(err, autoRef.current.done)
        if (delay === null) return
        autoRef.current.done++
        timer = setTimeout(() => { if (alive) setAttempt((n) => n + 1) }, delay)
      }
    )
    return () => {
      alive = false
      if (timer !== null) clearTimeout(timer)
    }
    // The descriptor is identified by its key (deps omit the object itself).
  }, [publicKey, key, attempt, persist])
  if (keptOnly) return kept
  return key !== null && result.key === key && isShownUrl(result.url) ? result.url : null
}

// First letter of the first and last word, or two letters of a single word;
// '' when the name is missing or blank.
function initialsFromName (name) {
  const upper = (s) => s.toLocaleUpperCase('pt-BR')
  const words = typeof name === 'string' ? name.trim().split(/\s+/).filter((w) => w !== '') : []
  if (words.length >= 2) return upper(Array.from(words[0])[0] + Array.from(words[words.length - 1])[0])
  if (words.length === 1) return upper(Array.from(words[0]).slice(0, 2).join(''))
  return ''
}

function usePrivateAvatarUrl (mediaAuthor, item) {
  const node = useNodeHandle()
  const identity = useMemberKey()
  const ref = { kind: 'group', diary: mediaAuthor, item }
  const key = validPrivateGroupImage(item) && node && node.media && typeof node.media.read === 'function'
    ? chatMediaKey(identity, ref)
    : null
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState(null)
  const autoRef = useRef({ key: null, node: null, done: 0 })
  useEffect(() => onChatMediaReturn(() => setAttempt((n) => n + 1)), [])
  useEffect(() => {
    if (autoRef.current.key !== key || autoRef.current.node !== node) autoRef.current = { key, node, done: 0 }
    if (key === null) return
    let alive = true
    let timer = null
    sourceFor(ref, { node, identity, display }).then((entry) => {
      if (!alive) return
      setResult({ key, attempt, node, entry })
      // Private blocks may arrive after the row, so retry only transient reads.
      const delay = entry && entry.unavailable === true ? retryDelay(entry, autoRef.current.done) : null
      if (delay === null) return
      autoRef.current.done++
      timer = setTimeout(() => { if (alive) setAttempt((n) => n + 1) }, delay)
    }, () => {
      if (alive) setResult(null)
    })
    return () => {
      alive = false
      if (timer !== null) clearTimeout(timer)
    }
  }, [key, attempt, node])
  const entry = key !== null && result && result.key === key && result.attempt === attempt && result.node === node ? result.entry : null
  return entry && entry.mime === 'image/jpeg' && entry.w === 512 && entry.h === 512 && isShownUrl(entry.uri) ? entry.uri : null
}

export function initialsSize (size) {
  return Math.max(8, Math.round(size * 0.36))
}

export function Avatar ({ name, publicKey, mediaAuthor = publicKey, size = 44, ring = false, picture, privateItem, persist = false, localUri, shape = 'circle' }) {
  const { colors } = useTheme()
  const privateImage = privateItem !== undefined && privateItem !== null
  const fetched = useAvatarUrl(mediaAuthor, privateImage ? null : picture, persist !== false)
  const opened = usePrivateAvatarUrl(mediaAuthor, privateImage && picture == null ? privateItem : null)
  // The URL that failed to render; the initials stay for it.
  const [broken, setBroken] = useState(null)
  // A local URL that failed (primeAvatar may revoke it when the cache already
  // holds a verified copy) falls back to the fetched one.
  const uri = privateImage ? opened : isShownUrl(localUri) && localUri !== broken ? localUri : fetched
  const photo = uri !== null && uri !== broken ? uri : null
  useEffect(() => (privateImage && photo !== null ? pinChatMedia(photo) : undefined), [privateImage, photo])
  const corner = shape === 'square' ? Math.round(size * 0.3) : size / 2
  const stripe = stripes[avatarColorOf(publicKey)]
  // Sized to the circle and never scaled with the system text size: two
  // letters at 15 pt did not fit a 20 pt quote avatar, and Dynamic Type turned
  // every avatar into "J…".
  const fontSize = initialsSize(size)
  const initials = initialsFromName(name)
  const circle = (
    <View
      style={[styles.circle, { width: size, height: size, borderRadius: corner, backgroundColor: stripe.bg }]}
      accessible={false}
      importantForAccessibility='no-hide-descendants'
    >
      {initials === ''
        ? <Icon name='pessoa' size={size * 0.5} color={stripe.ink} />
        : <Text style={[styles.initials, { color: stripe.ink, fontSize }]} numberOfLines={1} allowFontScaling={false}>{displayText(initials)}</Text>}
      {photo !== null && (
        <Image
          source={{ uri: photo }}
          style={[styles.fill, { borderRadius: corner }]}
          resizeMode='cover'
          accessible={false}
          accessibilityIgnoresInvertColors
          onError={() => setBroken(photo)}
        />
      )}
    </View>
  )
  if (!ring) return circle
  const outer = size + 8
  const outerCorner = shape === 'square' ? Math.round(outer * 0.3) : outer / 2
  return (
    <View
      style={[styles.circle, { width: outer, height: outer, borderRadius: outerCorner, backgroundColor: colors.bg }]}
      accessible={false}
      importantForAccessibility='no-hide-descendants'
    >
      {circle}
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { ...StyleSheet.absoluteFillObject },
  circle: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  initials: { fontWeight: '700' }
})
