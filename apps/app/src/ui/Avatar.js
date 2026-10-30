// A round avatar with the person's initials on the stripe colour picked by
// the first byte of the key. With no name it shows a person glyph instead:
// no character derived from a key is ever drawn. Decorative: the name is
// read elsewhere.
//
// A profile photo is drawn over the initials only on a hosted node (as
// MediaView does for post photos): the bytes come from the installation's
// /media route, verified by ../media/avatar.js (SHA-256, still image, exact
// 512x512), and only a blob: URL (web) or a cache file:// URI (native, from
// ../media/display) is ever drawn. Retryable failures retry
// after 2, 5 and 15 s while mounted; any final failure, or an image that
// does not render, leaves the initials. localUri (a blob: URL the editor
// just made) is drawn as is. Without a hosted node nothing is fetched.
// persist is false for authors the device does not follow (cache: 'no-store'
// on the web; natively no cache option, see fetchMedia).

import { useEffect, useRef, useState } from 'react'
import { fetch as expoFetch } from 'expo/fetch'
import { Image, StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { avatarColorOf } from '../format'
import { avatarKey, loadAvatarUrl, validAvatar } from '../media/avatar'
import { createMediaCache, retryDelay } from '../media/cache'
import { revokeUrl, urlFromBytes } from '../media/display'
import { isAppClient } from '../appClient'
import { Icon } from './Icon'
import { colors, stripes } from './theme'

// The native app streams media through expo/fetch so the byte cap stops the
// download (see fetchMedia); the web keeps the global fetch.
const mediaFetch = () => (isAppClient() ? expoFetch : undefined)

const cache = createMediaCache({ max: 128, concurrency: 4, revoke: revokeUrl })

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
  const node = useNode()
  const canFetch = node !== null && node.hosted === true
  const key = canFetch && typeof publicKey === 'string' && validAvatar(picture) ? avatarKey(publicKey, picture) : null
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
    cache.get(key, () => loadAvatarUrl(publicKey, picture, { persist, fresh, urlFromBytes, fetch: mediaFetch() })).then(
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

export function Avatar ({ name, publicKey, size = 44, ring = false, picture, persist = false, localUri }) {
  const fetched = useAvatarUrl(publicKey, picture, persist !== false)
  // The URL that failed to render; the initials stay for it.
  const [broken, setBroken] = useState(null)
  // A local URL that failed (primeAvatar may revoke it when the cache already
  // holds a verified copy) falls back to the fetched one.
  const uri = isShownUrl(localUri) && localUri !== broken ? localUri : fetched
  const photo = uri !== null && uri !== broken ? uri : null
  const stripe = stripes[avatarColorOf(publicKey)]
  const fontSize = size >= 80 ? 30 : size <= 40 ? 15 : 16
  const initials = initialsFromName(name)
  const circle = (
    <View
      style={[styles.circle, { width: size, height: size, borderRadius: size / 2, backgroundColor: stripe.bg }]}
      accessible={false}
      importantForAccessibility='no-hide-descendants'
    >
      {initials === ''
        ? <Icon name='pessoa' size={size * 0.5} color={stripe.ink} />
        : <Text style={[styles.initials, { color: stripe.ink, fontSize }]} numberOfLines={1}>{displayText(initials)}</Text>}
      {photo !== null && (
        <Image
          source={{ uri: photo }}
          style={[styles.fill, { borderRadius: size / 2 }]}
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
  return (
    <View
      style={[styles.circle, { width: outer, height: outer, borderRadius: outer / 2, backgroundColor: colors.bg }]}
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
