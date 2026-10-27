// One photo of a post. Only the hosted web app (hostedPage) fetches it: the
// bytes come from the same origin's /media route and are shown only after
// ../media/fetch.js verified their length and SHA-256 against the
// descriptor, as an Image with a blob: URL (never anything else). Natively,
// with varanda-serve or on a page that is not hosted, a neutral 'foto' tile
// is shown and nothing is fetched. While loading: a soft placeholder (the
// parent gives the tile its aspect ratio). On failure: 'foto indisponível';
// a tap retries. A 404 or a network error (blocks reach the seeder a moment
// after the post) is first retried automatically after 2, 5 and 15 s while
// the tile is mounted (retryDelay); a length or SHA-256 mismatch never is.
// URLs live in a shared LRU (../media/cache.js). persist (default true) is
// false for authors the device does not follow: their photos are fetched with
// cache: 'no-store' so nothing of them is kept on the device.

import { useEffect, useRef, useState } from 'react'
import { Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { hostedPage } from '../configStore'
import { loadMediaUrl, validDescriptor } from '../media/fetch'
import { createMediaCache, mediaKey, retryDelay } from '../media/cache'
import { Icon } from './Icon'
import { colors } from './theme'

const canFetch = Platform.OS === 'web' && hostedPage === true

const cache = createMediaCache({ max: 64, concurrency: 4 })

const isBlobUrl = (url) => typeof url === 'string' && url.startsWith('blob:')

// -> { state: 'off' | 'loading' | 'ok' | 'error', url, retry }
function useMedia (author, descriptor, persist) {
  const valid = validDescriptor(descriptor)
  const key = valid ? mediaKey(descriptor) : null
  const [attempt, setAttempt] = useState(0)
  // Automatic retries done for this key (bounded by retryDelay).
  const autoRef = useRef({ key: null, done: 0 })
  const [result, setResult] = useState(() => {
    const hit = canFetch && key ? cache.peek(key) : null
    return hit ? { key, url: hit, error: false } : { key: null, url: null, error: false }
  })
  useEffect(() => {
    if (!canFetch || !key) return
    if (autoRef.current.key !== key) autoRef.current = { key, done: 0 }
    let alive = true
    let timer = null
    const hit = cache.peek(key)
    if (hit) {
      setResult({ key, url: hit, error: false })
      return
    }
    setResult({ key, url: null, error: false })
    const fresh = attempt > 0
    cache.get(key, () => loadMediaUrl(author, descriptor, { fresh, persist })).then(
      (url) => { if (alive) setResult({ key, url, error: false }) },
      (err) => {
        if (!alive) return
        const delay = retryDelay(err, autoRef.current.done)
        if (delay === null) {
          setResult({ key, url: null, error: true })
          return
        }
        // Still 'loading' while an automatic retry is pending; the retry goes
        // through the cache again (shared, at most 4 at once).
        autoRef.current.done++
        timer = setTimeout(() => { if (alive) setAttempt((n) => n + 1) }, delay)
      }
    )
    return () => {
      alive = false
      if (timer !== null) clearTimeout(timer)
    }
    // The descriptor is identified by its key (deps omit the object itself).
  }, [author, key, attempt, persist])
  const retry = () => setAttempt((n) => n + 1)
  if (!canFetch) return { state: 'off', url: null, retry }
  if (!key) return { state: 'error', url: null, retry }
  if (result.key !== key) return { state: 'loading', url: null, retry }
  if (result.error) return { state: 'error', url: null, retry }
  if (isBlobUrl(result.url)) return { state: 'ok', url: result.url, retry }
  return { state: 'loading', url: null, retry }
}

export function MediaView ({ author, descriptor, label = 'foto', fit = 'cover', style, onPress, dark, persist = true }) {
  const { state, url, retry } = useMedia(author, descriptor, persist !== false)
  const failed = state === 'error'
  const press = failed ? retry : onPress
  const a11y = failed ? label + ', indisponível; toque para tentar de novo' : label
  let inner
  if (state === 'ok') {
    inner = <Image source={{ uri: url }} style={styles.fill} resizeMode={fit} accessibilityIgnoresInvertColors />
  } else if (state === 'loading') {
    inner = <View style={[styles.fill, dark ? styles.loadingDark : styles.loading]} />
  } else {
    inner = (
      <View style={[styles.fill, styles.neutral, dark && styles.neutralDark]}>
        <Icon name='image' size={22} color={dark ? '#d8d8d8' : colors.soft} />
        <Text style={[styles.neutralText, dark && styles.neutralTextDark]}>{failed ? 'foto indisponível' : 'foto'}</Text>
      </View>
    )
  }
  if (typeof press !== 'function') {
    return (
      <View style={[styles.tile, style]} accessible accessibilityRole='image' accessibilityLabel={a11y}>
        {inner}
      </View>
    )
  }
  return (
    <Pressable
      style={({ pressed }) => [styles.tile, style, pressed && styles.pressed]}
      accessibilityRole='button'
      accessibilityLabel={a11y}
      onPress={press}
    >
      {inner}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  tile: { overflow: 'hidden' },
  fill: { ...StyleSheet.absoluteFillObject },
  loading: { backgroundColor: colors.skeleton },
  loadingDark: { backgroundColor: 'rgba(255,255,255,0.08)' },
  neutral: { backgroundColor: colors.skeleton, alignItems: 'center', justifyContent: 'center', gap: 6 },
  neutralDark: { backgroundColor: 'rgba(255,255,255,0.08)' },
  neutralText: { fontSize: 13, lineHeight: 16, color: colors.soft },
  neutralTextDark: { color: '#d8d8d8' },
  pressed: { opacity: 0.85 }
})
