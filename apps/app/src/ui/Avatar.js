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
// ladder of ../media/cache.js while mounted; any final failure leaves the
// initials. A fetched image that does not render is loaded once more per
// mount (avatarErrorStep), then leaves the initials. localUri (a blob: URL
// the editor just made) is drawn as is. Without a hosted node nothing is fetched.
// persist is false for authors the device does not follow (cache: 'no-store'
// on the web; natively no cache option, see fetchMedia). With persist the
// verified photo also goes to the kept store (../media/keptLoad.js) and the
// next start draws it from there with no fetch. persist 'peek' (a stranger
// the Espiadinha shows) is fetched as with false; only the bounded peek
// kinds of the kept store may hold it. persist 'copy' (a reopened screen's
// saved copy) is fetched as with true for a followed author and as with
// false for anyone else (../media/keptLoad.js fetchPersist).
//
// A private group picture (privateItem) is opened only by the node. Two props,
// both off by default, let a reopened screen draw it before the node answers:
// groupThumb { author, sha } (the image author and plainSha256) draws the
// decrypted copy kept under that pair until the live picture resolves, and
// only while no live picture with another plainSha256 is given; with
// keepGroupThumb the decrypted picture is kept under (mediaAuthor,
// plainSha256) once its SHA-256 matches. Only the plaintext is kept: the key,
// nonce and core never reach the store.

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
import { fetchPersist, loadKept, persistMode, registerKeptStore } from '../media/keptLoad'
import { readReportAudio as readLocalBytes } from '../media/reportAudio'
import { bumpCacheGeneration, cacheGeneration, copyReadAllowed, groupThumbKeepAllowed, registerLocalCache } from '../localCaches'
import { isAppClient } from '../appClient'
import { useBlocks } from '../blocksProvider'
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

// A reload after an Image error reads no kept copy (it may be the file that
// failed) and replaces it only with bytes that passed the verified fetch, so
// a failed fetch leaves the offline copy as it was.
const noKept = () => null
const replaceKept = (kind, author, d, bytes) => keptStore.keep(kind, author, d, bytes, { replace: true })

// key -> the URL its last reload in this run resolved to. A replaced kept
// file keeps its URI, so an error on that URL (in this row or another one
// that still drew the old bytes) cannot be told apart from the new file
// failing: it is drawn again, never fetched again, and a photo the decoder
// always refuses costs one fetch per run. Any other URL of the key reloads.
const refreshed = new Map()
const REFRESHED_MAX = 256

function rememberRefresh (key, url) {
  refreshed.delete(key)
  refreshed.set(key, url)
  if (refreshed.size > REFRESHED_MAX) refreshed.delete(refreshed.keys().next().value)
}

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

// What an Image error on a drawn avatar does. A URL the cache handed out
// (`cached`) may name a file that is gone (cache.clear and LRU eviction
// delete it) or that the decoder refuses (a kept file served again every
// start): the first error per key and mount loads it once more, any other
// leaves the initials. `reloaded`: the keys already reloaded (not mutated).
// -> { reloaded, step: 'reload' | 'broken' }
export function avatarErrorStep (reloaded, { key, cached }) {
  if (cached !== true || typeof key !== 'string' || reloaded.has(key)) return { reloaded, step: 'broken' }
  return { reloaded: new Set([...reloaded, key]), step: 'reload' }
}

// -> { url, key, reload }: a blob: or file: URL to draw, or null; the cache
// key it came from; reload(url) lets go of that URL and loads the key again,
// null when nothing is fetched (kept-only mode).
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
  // { key, url } of the drawn URL that failed: loads of the key skip the
  // kept copy, and do not draw that URL from memory (another mount may have
  // read it back from the kept store), until one succeeds, also on the
  // retry ladder.
  const refreshRef = useRef(null)
  const [result, setResult] = useState(() => {
    const hit = key ? cache.peek(key) : null
    return { key: hit ? key : null, url: hit }
  })
  useEffect(() => {
    if (!key) return
    if (autoRef.current.key !== key) autoRef.current = { key, done: 0 }
    let alive = true
    let timer = null
    const pending = refreshRef.current
    const refresh = pending !== null && pending.key === key
    const hit = cache.peek(key)
    if (hit && !(refresh && hit === pending.url)) {
      setResult({ key, url: hit })
      return
    }
    if (hit) cache.forget(key, hit)
    const fresh = attempt > 0
    // Only bytes that passed fetchAvatarBytes (descriptor, SHA-256 and
    // still-image checks) are kept, so a kept hit needs no check again.
    // Read now, not when the load leaves the queue: a purge while it waits
    // must still prevent the keep.
    const requestedGeneration = cacheGeneration()
    const loadAny = () => loadKept({
      kind: 'avatars',
      author: publicKey,
      d: picture,
      persist,
      keptUrl: refresh ? noKept : keptStore.keptUrl,
      keptBytes: refresh ? undefined : keptStore.keptBytes,
      keep: refresh ? replaceKept : keptStore.keep,
      // A stranger's photo ('peek', or 'copy' not followed) never goes to the
      // unmanaged HTTP cache: only the bounded kinds may keep it.
      fetchBytes: (d) => fetchAvatarBytes(publicKey, d, { ...mediaHashDeps(), persist: fetchPersist(persist, publicKey), fresh, fetch: mediaFetch() }),
      urlFromBytes,
      generation: cacheGeneration,
      requestedGeneration
    })
    const remembered = (url) => {
      rememberRefresh(key, url)
      return url
    }
    const load = refresh ? () => loadAny().then(remembered) : loadAny
    cache.get(key, load).then(
      (url) => {
        if (refreshRef.current !== null && refreshRef.current.key === key) refreshRef.current = null
        if (alive) setResult({ key, url })
      },
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
  if (keptOnly) return { url: kept, key: keptKey, reload: null }
  const reload = (url) => {
    if (key === null) return
    // Another URL held for the key is a copy another row already loaded
    // again: drawn as is. An entry the cache cleared or evicted counts as
    // the one that failed.
    const held = cache.peek(key)
    if (refreshed.get(key) !== url && (held === null || held === url)) {
      cache.forget(key, url)
      refreshRef.current = { key, url }
    }
    setResult({ key: null, url: null })
    setAttempt((n) => n + 1)
  }
  return { url: key !== null && result.key === key && isShownUrl(result.url) ? result.url : null, key, reload: key !== null ? reload : null }
}

const HEX64 = /^[0-9a-f]{64}$/
// The copy store's cap. A kept picture is only what the live draw accepts
// (usePrivateAvatarUrl): a 512x512 JPEG.
export const GROUP_THUMB_MAX_BYTES = 262144
const GROUP_THUMB_MIME = 'image/jpeg'
const GROUP_THUMB_SIDE = 512

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

function wipe (bytes) {
  try { if (bytes instanceof Uint8Array) bytes.fill(0) } catch {}
}

// The pairs kept in this run, so a list does not hash and write the same
// picture once per row. A purge (new cache generation) forgets them.
const thumbsKept = new Set()
const THUMBS_KEPT_MAX = 256
let thumbsGeneration = null

function thumbKeptBefore (pair, generation) {
  if (thumbsGeneration !== generation) {
    thumbsKept.clear()
    thumbsGeneration = generation
  }
  return thumbsKept.has(pair)
}

// Keeps the decrypted picture of a private group image under (author, sha),
// the image author and its plainSha256. The store trusts its caller, so the
// checks are here: an author the block list allows, a JPEG measured at
// 512x512 (w, h), at most GROUP_THUMB_MAX_BYTES and a SHA-256 equal to sha.
// Bytes not handed to the store are wiped.
// deps: { allowed(author), keep(author, sha, bytes, mime), subtle, generation() }.
// -> Promise<boolean>, true when the store got the bytes. Never rejects.
export async function keepGroupThumbBytes ({ author, sha, bytes, mime, w, h }, deps) {
  let handed = false
  try {
    if (typeof author !== 'string' || !HEX64.test(author) || typeof sha !== 'string' || !HEX64.test(sha)) return false
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > GROUP_THUMB_MAX_BYTES) return false
    if (mime !== GROUP_THUMB_MIME || w !== GROUP_THUMB_SIDE || h !== GROUP_THUMB_SIDE) return false
    if (deps.allowed(author) !== true) return false
    const subtle = deps.subtle
    if (!subtle || typeof subtle.digest !== 'function') return false
    const requested = deps.generation()
    const hex = toHex(new Uint8Array(await subtle.digest('SHA-256', bytes)))
    if (hex !== sha) return false
    // A block or a purge while the hash ran wins.
    if (deps.generation() !== requested || deps.allowed(author) !== true) return false
    handed = true
    deps.keep(author, sha, bytes, mime)
    return true
  } catch {
    return false
  } finally {
    if (!handed) wipe(bytes)
  }
}

const thumbSubtle = () => mediaHashDeps().subtle || (typeof crypto !== 'undefined' && crypto.subtle) || null

// -> the keeper chatMedia's sourceFor offers the plaintext to, or null when
// this picture needs none.
function groupThumbKeeper (author, sha) {
  if (typeof author !== 'string' || !HEX64.test(author) || typeof sha !== 'string' || !HEX64.test(sha)) return null
  const pair = author + '-' + sha
  if (thumbKeptBefore(pair, cacheGeneration())) return null
  return (bytes, mime, w, h) => {
    keepGroupThumbBytes({ author, sha, bytes, mime, w, h }, {
      allowed: groupThumbKeepAllowed,
      keep: keptStore.keepGroupThumb,
      subtle: thumbSubtle(),
      generation: cacheGeneration
    }).then((ok) => {
      if (!ok) return
      thumbsKept.add(pair)
      if (thumbsKept.size > THUMBS_KEPT_MAX) thumbsKept.delete(thumbsKept.values().next().value)
    })
  }
}

// The kept decrypted picture for a valid groupThumb, or null: a file URI on
// native, a blob: URL of the kept bytes on the web (revoked when let go of).
// Only once the block list allows a copy of this author to be read.
function useKeptGroupThumb (thumb) {
  const author = thumb !== null ? thumb.author : null
  const sha = thumb !== null ? thumb.sha : null
  // copyReadAllowed reads the block list, which changes with no prop: the
  // blocks context redraws this row when it arrives or changes.
  useBlocks()
  const readable = author !== null && copyReadAllowed(author)
  const [result, setResult] = useState(null)
  useEffect(() => {
    if (!readable) {
      setResult(null)
      return
    }
    let alive = true
    let made = null
    let got = null
    try {
      got = keptStore.keptGroupThumb(author, sha)
    } catch {}
    if (typeof got === 'string') {
      if (isShownUrl(got)) setResult({ author, sha, url: got })
    } else if (got && typeof got.then === 'function') {
      got.then((bytes) => {
        if (!alive || !(bytes instanceof Uint8Array) || bytes.byteLength === 0) return
        // A block that landed while the store read wins.
        if (!copyReadAllowed(author)) return
        let url = null
        try {
          url = urlFromBytes(bytes, 'image/jpeg')
        } catch {}
        if (!isShownUrl(url)) return
        made = url
        setResult({ author, sha, url })
      }, () => {})
    }
    return () => {
      alive = false
      if (made !== null) revokeUrl(made)
    }
  }, [author, sha, readable])
  return readable && result !== null && result.author === author && result.sha === sha ? result.url : null
}

// A groupThumb prop both strings of 64 lowercase hex, else null.
function validGroupThumb (thumb) {
  return thumb && typeof thumb === 'object' && typeof thumb.author === 'string' && HEX64.test(thumb.author) &&
    typeof thumb.sha === 'string' && HEX64.test(thumb.sha)
    ? { author: thumb.author, sha: thumb.sha }
    : null
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

function usePrivateAvatarUrl (mediaAuthor, item, keepThumb) {
  const node = useNodeHandle()
  const identity = useMemberKey()
  const ref = { kind: 'group', diary: mediaAuthor, item }
  const key = validPrivateGroupImage(item) && node && node.media && typeof node.media.read === 'function'
    ? chatMediaKey(identity, ref)
    : null
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState(null)
  const autoRef = useRef({ key: null, node: null, done: 0 })
  const keeping = key !== null && keepThumb === true
  useEffect(() => onChatMediaReturn(() => setAttempt((n) => n + 1)), [])
  useEffect(() => {
    if (autoRef.current.key !== key || autoRef.current.node !== node) autoRef.current = { key, node, done: 0 }
    if (key === null) return
    let alive = true
    let timer = null
    const ctx = { node, identity, display, fetchDeps: { ...mediaHashDeps(), ...(isAppClient() ? { fetch: expoFetch } : {}) } }
    const keep = keeping ? groupThumbKeeper(mediaAuthor, item.plainSha256) : null
    if (keep !== null) {
      ctx.keep = keep
      ctx.readFile = readLocalBytes
    }
    sourceFor(ref, ctx).then((entry) => {
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
  }, [key, attempt, node, keeping])
  const entry = key !== null && result && result.key === key && result.attempt === attempt && result.node === node ? result.entry : null
  return entry && entry.mime === 'image/jpeg' && entry.w === 512 && entry.h === 512 && isShownUrl(entry.uri) ? entry.uri : null
}

export function initialsSize (size) {
  return Math.max(8, Math.round(size * 0.36))
}

export function Avatar ({ name, publicKey, mediaAuthor = publicKey, size = 44, ring = false, picture, privateItem, persist = false, localUri, shape = 'circle', groupThumb = null, keepGroupThumb = false }) {
  const { colors } = useTheme()
  const privateImage = privateItem !== undefined && privateItem !== null
  const avatar = useAvatarUrl(mediaAuthor, privateImage ? null : picture, persistMode(persist))
  const fetched = avatar.url
  const opened = usePrivateAvatarUrl(mediaAuthor, privateImage && picture == null ? privateItem : null, keepGroupThumb === true)
  // The kept picture stands in only for the same picture: a live item with
  // another plainSha256 or author, or a public picture, hides it.
  const asked = validGroupThumb(groupThumb)
  const thumb = asked !== null && picture == null && (!privateImage ||
    (validPrivateGroupImage(privateItem) && privateItem.plainSha256 === asked.sha && mediaAuthor === asked.author))
    ? asked
    : null
  const keptThumb = useKeptGroupThumb(thumb)
  // The URL that failed to render; the initials stay for it.
  const [broken, setBroken] = useState(null)
  const reloadedRef = useRef(new Set())
  // Part of the Image key: a photo kept again has the same file URI, so only
  // a new Image draws it instead of the one that failed.
  const [reloads, setReloads] = useState(0)
  // A local URL that failed (primeAvatar may revoke it when the cache already
  // holds a verified copy) falls back to the fetched one.
  const live = privateImage ? opened : isShownUrl(localUri) && localUri !== broken ? localUri : fetched
  const uri = live !== null ? live : keptThumb
  const photo = uri !== null && uri !== broken ? uri : null
  // Only the node's own URI is chat media; a kept picture is not pinned.
  const pinned = privateImage && photo !== null && photo === opened ? photo : null
  useEffect(() => (pinned !== null ? pinChatMedia(pinned) : undefined), [pinned])
  const onImageError = () => {
    const cached = !privateImage && avatar.reload !== null && photo === fetched
    const out = avatarErrorStep(reloadedRef.current, { key: avatar.key, cached })
    reloadedRef.current = out.reloaded
    if (out.step !== 'reload') {
      setBroken(photo)
      return
    }
    avatar.reload(photo)
    setReloads((n) => n + 1)
  }
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
          key={reloads}
          source={{ uri: photo }}
          style={[styles.fill, { borderRadius: corner }]}
          resizeMode='cover'
          accessible={false}
          accessibilityIgnoresInvertColors
          onError={onImageError}
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
