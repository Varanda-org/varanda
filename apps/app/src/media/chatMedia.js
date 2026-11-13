// Device-local sources for chat photos and GIFs (DMs and community groups).
// Pure: no React, no react-native, no Node built-ins; the node handle and
// the display module (./display: urlFromBytes, revokeUrl) are injected per
// call, so this file loads in Node for the tests.
//
// Privacy: a DM item or a private group item is opened only by the node
// (media.read on the handle); this module never builds a network URL for
// one, never asks the seeder's DM blob route and never fetches from a third
// party. Only a public group item (a plain descriptor, no key) is fetched,
// through ./fetch.js, from the installation that served the app, with its
// length and SHA-256 checked there.
//
// What reaches the screen is always a device-local URI: a blob: URL made from
// bytes the node or the fetch handed over (web), or the file:// path the
// worklet wrote (native). Bytes are bounded with mediaBounds (@varanda/rpc,
// never @varanda/core: metro blocks it) before any URL exists, so a decoder
// never sees a canvas past the limits. A native file was bounded by the node
// that wrote it.
//
// Entries live in the LRU of ./cache.js, keyed by identity and message ref,
// so one person's photos never answer another's after a switch. A URL a cell
// still shows is pinned (pin) and outlives its eviction until unpinned.
// Eviction,
// clear (lock, sign-out) and an identity change release every URL: a blob:
// URL is revoked, a node file is forgotten through the host's
// media.forgetReadFile(name), and clear also calls media.clearReadFiles().
// Bytes this module received are zero-filled once turned into a URL (a Blob
// and a written file keep their own copy), so media.read hands over a fresh
// array it does not reuse.
//
// Voice notes (audio/mp4) follow the same paths: their bytes are checked with
// audioBounds (@varanda/rpc), which refuses a container with any track other
// than sound, before any URL exists; a native file is accepted only as the
// node answered it, since the worklet checked it the same way. An audio
// entry has no picture size (w and h 0) and carries its duration in ms.

import rpc from '@varanda/rpc'
import { createMediaCache, mediaKey } from './cache.js'
import { fetchMedia, validDescriptor } from './fetch.js'
import { MEDIA_MIMES } from './plan.js'

const HEX64 = /^[0-9a-f]{64}$/
const MSG_ID = /^[0-9a-f]{32}$/
// What the worklet names its plaintext files; anything else is not ours to
// forget.
const READ_FILE = /^[0-9A-Za-z._-]{1,128}$/

const UNAVAILABLE = Object.freeze({ unavailable: true })

export const AUDIO_MIME = 'audio/mp4'
// The plaintext cap of a voice note (packages/core records MAX_AUDIO_BYTES).
export const MAX_AUDIO_BYTES = 1572864
const AUDIO_DESCRIPTOR_KEYS = ['blocks', 'bytes', 'core', 'height', 'mime', 'ms', 'sha256', 'start', 'width']

export const CHAT_MEDIA_MAX = 48

// 0..3: a media item of the message; 'card': its link card thumbnail.
const isIndex = (n) => (Number.isInteger(n) && n >= 0 && n < 4) || n === 'card'

function goneError () {
  return new Error('apagada')
}

// A node read that threw: the blob may reach the seeder later or the
// network may come back, so the cell offers a tap to read again (a read,
// never a send). Only a bad ref (TypeError) is final; a gone item arrives as
// { unavailable: true } in the message itself and never gets here.
function readFailed (err) {
  if (err instanceof TypeError) return err
  return Object.assign(new Error('indisponível'), { retryable: true })
}

function unavailable (retryable) {
  return retryable === true ? { unavailable: true, retryable: true } : UNAVAILABLE
}

// The cache key of a ref, or null when the ref is not well formed.
// dm: { kind: 'dm', from, id, index } (index 0..3 or 'card'); group: { kind: 'group', diary, item }.
export function chatMediaKey (identity, ref) {
  if (typeof identity !== 'string' || !HEX64.test(identity)) return null
  if (!ref || typeof ref !== 'object') return null
  if (ref.kind === 'dm') {
    if (typeof ref.from !== 'string' || !HEX64.test(ref.from)) return null
    if (typeof ref.id !== 'string' || !MSG_ID.test(ref.id) || !isIndex(ref.index)) return null
    return identity + '|dm|' + ref.from + '|' + ref.id + '|' + ref.index
  }
  if (ref.kind === 'group') {
    if (typeof ref.diary !== 'string' || !HEX64.test(ref.diary)) return null
    const item = ref.item
    if (!item || typeof item !== 'object') return null
    if (typeof item.core !== 'string' || !HEX64.test(item.core)) return null
    if (typeof item.sha256 !== 'string' || !HEX64.test(item.sha256)) return null
    if (!Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.blocks)) return null
    return identity + '|group|' + ref.diary + '|' + mediaKey(item)
  }
  return null
}

// A private group item carries its key; a public one is the plain
// descriptor of protocol section 2.
function isPrivateGroupItem (item) {
  return !!item && typeof item === 'object' && typeof item.key === 'string'
}

// The plaintext mime the ref's item promises, or null when unknown.
function expectedMime (ref) {
  const item = ref.item
  if (!item || typeof item !== 'object') return null
  if (ref.kind === 'group') return isPrivateGroupItem(item) ? item.plainMime : item.mime
  return typeof item.mime === 'string' ? item.mime : null
}

// A public voice note descriptor (exact keys): a post descriptor with no
// picture size and its duration.
export function isAudioDescriptor (d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return false
  const keys = Object.keys(d).sort()
  if (keys.length !== AUDIO_DESCRIPTOR_KEYS.length || keys.some((k, i) => k !== AUDIO_DESCRIPTOR_KEYS[i])) return false
  return d.mime === AUDIO_MIME && typeof d.core === 'string' && HEX64.test(d.core) &&
    typeof d.sha256 === 'string' && HEX64.test(d.sha256) &&
    Number.isSafeInteger(d.start) && d.start >= 1 && Number.isSafeInteger(d.blocks) && d.blocks >= 1 &&
    Number.isSafeInteger(d.bytes) && d.bytes >= 1 && d.bytes <= MAX_AUDIO_BYTES &&
    d.width === 0 && d.height === 0 && Number.isInteger(d.ms) && d.ms >= 1 && d.ms <= rpc.MAX_AUDIO_MS
}

// Whether a chat item (DM item, public descriptor or private item) is a voice
// note.
export function isVoiceItem (item) {
  if (!item || typeof item !== 'object') return false
  return (typeof item.plainMime === 'string' ? item.plainMime : item.mime) === AUDIO_MIME
}

// Whether a declared voice note length agrees with the container's (ms
// from audioBounds): a peer's ms is not trusted, recorders round a little.
function msAgrees (declared, ms) {
  return declared === undefined || (Number.isInteger(declared) && Math.abs(declared - ms) <= rpc.AUDIO_MS_TOLERANCE)
}

// The ms a chat item declares, if any.
function declaredMs (ref) {
  return ref && ref.item && typeof ref.item === 'object' && ref.item.ms !== undefined ? ref.item.ms : undefined
}

// -> { width: 0, height: 0, ms } for audio-only MPEG-4 bytes whose duration
// agrees with `declared`, else null. The ms shown is the container's.
function boundedAudio (bytes, audioBounds, declared) {
  if (bytes.byteLength > MAX_AUDIO_BYTES || typeof audioBounds !== 'function') return null
  try {
    const a = audioBounds(bytes)
    if (!a || !Number.isInteger(a.ms) || a.ms < 1 || !msAgrees(declared, a.ms)) return null
    return { width: 0, height: 0, ms: a.ms }
  } catch {
    return null
  }
}

function bounded (bytes, mime, bounds, audioBounds, declared) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return null
  if (mime === AUDIO_MIME) return boundedAudio(bytes, audioBounds, declared)
  if (!MEDIA_MIMES.includes(mime)) return null
  try {
    return bounds(bytes, mime) || null
  } catch {
    return null
  }
}

function wipe (bytes) {
  try { if (bytes instanceof Uint8Array) bytes.fill(0) } catch {}
}

function readFileName (uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file://') || uri.includes('?') || uri.includes('#')) return null
  const name = uri.slice(uri.lastIndexOf('/') + 1)
  return READ_FILE.test(name) ? name : null
}

function dims (n) {
  return Number.isInteger(n) && n >= 1 ? n : null
}

// A source for one chat item. Every instance is cleared by clearChatMedia.
const instances = new Set()
// Node media handles any instance read from, for the host-wide sweep on lock.
const hosts = new Set()

export function createChatMedia ({ max = CHAT_MEDIA_MAX, concurrency = 2, bounds = rpc.mediaBounds, audioBounds = rpc.audioBounds, fetch: fetchItem = fetchMedia } = {}) {
  const releases = new Map()
  // The screen entry of each cached URL, so a hit answers with its size.
  const entries = new Map()
  let epoch = 0
  let owner = null

  const release = (url) => {
    const fn = releases.get(url)
    releases.delete(url)
    entries.delete(url)
    if (typeof fn === 'function') {
      try { fn() } catch {}
    }
  }

  // URLs a mounted cell or the open viewer shows. Eviction never pulls one
  // from under the screen: it is released when its last holder lets go, so
  // the set may pass `max` for a while. A clear (lock, switch) releases
  // everything regardless.
  const pins = new Map()
  const parked = new Set()
  let clearing = false

  const evict = (url) => {
    if (!clearing && pins.has(url)) parked.add(url)
    else release(url)
  }

  const cache = createMediaCache({ max, concurrency, revoke: evict })

  const pin = (url) => {
    if (typeof url !== 'string' || url === '') return () => {}
    pins.set(url, (pins.get(url) || 0) + 1)
    let done = false
    return () => {
      if (done) return
      done = true
      const n = (pins.get(url) || 1) - 1
      if (n > 0) {
        pins.set(url, n)
        return
      }
      pins.delete(url)
      if (parked.delete(url)) release(url)
    }
  }

  // Stores how to release `url` and returns the entry the screen gets.
  const own = (url, fn, mime, w, h, ms) => {
    const out = Number.isInteger(ms) ? { uri: url, mime, w, h, ms } : { uri: url, mime, w, h }
    releases.set(url, fn)
    entries.set(url, out)
    return out
  }

  const fromBytes = (bytes, mime, display, declared) => {
    const b = bounded(bytes, mime, bounds, audioBounds, declared)
    if (b === null || !display || typeof display.urlFromBytes !== 'function') {
      wipe(bytes)
      return null
    }
    let url
    try {
      url = display.urlFromBytes(bytes, mime)
    } finally {
      wipe(bytes)
    }
    if (typeof url !== 'string' || url === '') return null
    const revoke = typeof display.revokeUrl === 'function' ? display.revokeUrl : () => {}
    return own(url, () => revoke(url), mime, b.width, b.height, b.ms)
  }

  // A private item or a DM item: only the node opens it.
  const fromNode = async (ref, media, display, want) => {
    const read = ref.kind === 'dm'
      ? { kind: 'dm', from: ref.from, id: ref.id, index: ref.index }
      : { kind: 'group', diary: ref.diary, item: ref.item }
    let got
    try {
      got = await media.read(read)
    } catch (err) {
      throw readFailed(err)
    }
    if (!got || typeof got !== 'object') return null
    const mime = got.mime
    if (want !== null && mime !== want) {
      wipe(got.bytes)
      forgetFile(media, got.uri)
      return null
    }
    if (got.bytes !== undefined) return fromBytes(got.bytes, mime, display, declaredMs(ref))
    const name = readFileName(got.uri)
    // The worklet checked a voice note with audioBounds and answers w/h 0
    // and the container's ms, which must agree with the item's. A host that
    // does not pass ms on leaves the item's, which the node already held to
    // the container.
    if (mime === AUDIO_MIME) {
      const declared = declaredMs(ref)
      const ms = got.ms !== undefined ? got.ms : declared
      if (name === null || (got.w !== undefined && got.w !== 0) || (got.h !== undefined && got.h !== 0) ||
        (ms !== undefined && !(Number.isInteger(ms) && ms >= 1 && ms <= rpc.MAX_AUDIO_MS && msAgrees(declared, ms)))) {
        forgetFile(media, got.uri)
        return null
      }
      return own(got.uri, () => forgetFile(media, got.uri), mime, 0, 0, ms)
    }
    // The worklet measured the bytes; a file without a real size was not
    // bounded and is never handed to the decoder.
    const w = dims(got.w)
    const h = dims(got.h)
    if (name === null || !MEDIA_MIMES.includes(mime) || w === null || h === null) {
      forgetFile(media, got.uri)
      return null
    }
    return own(got.uri, () => forgetFile(media, got.uri), mime, w, h)
  }

  const fromSeeder = async (ref, display, deps) => {
    const d = ref.item
    if (!validDescriptor(d) && !isAudioDescriptor(d)) return null
    // chat: a public group voice note is a chat item (fetch.js accepts audio
    // descriptors for chats only, never for diary posts).
    const bytes = await fetchItem(ref.diary, d, { ...deps, chat: true, persist: !!deps && deps.persist === true })
    return fromBytes(bytes, d.mime, display, d.ms)
  }

  // Forgets only the files this instance holds (each entry's release):
  // another instance may still show its own read files.
  const clear = () => {
    epoch++
    clearing = true
    try {
      cache.clear()
    } finally {
      clearing = false
    }
    for (const url of [...parked]) release(url)
    parked.clear()
  }

  // -> { uri, mime, w, h } or { unavailable: true } (retryable: true when a
  // node read or a public fetch may succeed later). Never rejects.
  // ref: { kind: 'dm', from, id, index, item? } or { kind: 'group', diary, item }.
  // ctx: { node, identity, display, fetchDeps? }.
  const sourceFor = async (ref, ctx = {}) => {
    try {
      if (!ref || typeof ref !== 'object') return UNAVAILABLE
      if (ref.item && ref.item.unavailable === true) return UNAVAILABLE
      const identity = ctx.identity
      const base = chatMediaKey(identity, ref)
      if (base === null) return UNAVAILABLE
      if (owner !== null && owner !== identity) clear()
      owner = identity
      const started = epoch
      const key = started + '|' + base
      const hit = cache.peek(key)
      if (hit !== null) return entries.get(hit) || UNAVAILABLE
      // A forward asks the cache first and reads fresh bytes itself on a
      // miss (bytesFor): a read here would be thrown away.
      if (ctx.cachedOnly === true) return UNAVAILABLE
      const publicItem = ref.kind === 'group' && !isPrivateGroupItem(ref.item)
      const media = ctx.node && ctx.node.media
      if (!publicItem && (!media || typeof media.read !== 'function')) return UNAVAILABLE
      if (!publicItem) hosts.add(media)
      const display = ctx.display || null
      const want = expectedMime(ref)
      const entry = await cache.get(key, async () => {
        // Queued before a clear or a switch: never start the stale read.
        if (epoch !== started) throw goneError()
        const out = publicItem
          ? await fromSeeder(ref, display, ctx.fetchDeps)
          : await fromNode(ref, media, display, want)
        if (out === null) throw new Error('indisponível')
        // Locked or switched while the read ran: keep nothing.
        if (epoch !== started) {
          release(out.uri)
          throw goneError()
        }
        return out.uri
      })
      // Cleared between the load and the store: the entry is not kept.
      if (epoch !== started) {
        release(entry)
        return UNAVAILABLE
      }
      return entries.get(entry) || UNAVAILABLE
    } catch (err) {
      return unavailable(err && err.retryable)
    }
  }

  // The plaintext of one item for a forward, as bytes, with no display URL:
  // a native display only takes images, so a voice note turned into a URL
  // there would be lost. Same checks as sourceFor (mime, bounds, SHA-256 of
  // a public fetch); nothing is cached. A node file is read with
  // ctx.readFile(uri) and forgotten at once. The caller owns the bytes and
  // wipes them after the upload.
  // -> { bytes, mime, w, h, ms? } or null. Never rejects.
  const bytesFor = async (ref, ctx = {}) => {
    let fileMedia = null
    let fileUri = null
    try {
      if (!ref || typeof ref !== 'object') return null
      if (ref.item && ref.item.unavailable === true) return null
      if (chatMediaKey(ctx.identity, ref) === null) return null
      const out = (bytes, mime, declared) => {
        const b = bounded(bytes, mime, bounds, audioBounds, declared)
        if (b === null) {
          wipe(bytes)
          return null
        }
        return Number.isInteger(b.ms) ? { bytes, mime, w: 0, h: 0, ms: b.ms } : { bytes, mime, w: b.width, h: b.height }
      }
      if (ref.kind === 'group' && !isPrivateGroupItem(ref.item)) {
        const d = ref.item
        if (!validDescriptor(d) && !isAudioDescriptor(d)) return null
        const deps = ctx.fetchDeps
        const bytes = await fetchItem(ref.diary, d, { ...deps, chat: true, persist: !!deps && deps.persist === true })
        return out(bytes, d.mime, d.ms)
      }
      const media = ctx.node && ctx.node.media
      if (!media || typeof media.read !== 'function') return null
      hosts.add(media)
      const read = ref.kind === 'dm'
        ? { kind: 'dm', from: ref.from, id: ref.id, index: ref.index }
        : { kind: 'group', diary: ref.diary, item: ref.item }
      const got = await media.read(read)
      if (!got || typeof got !== 'object') return null
      if (typeof got.uri === 'string') {
        fileMedia = media
        fileUri = got.uri
      }
      const want = expectedMime(ref)
      if (want !== null && got.mime !== want) {
        wipe(got.bytes)
        return null
      }
      if (got.bytes !== undefined) return out(got.bytes, got.mime, declaredMs(ref))
      if (readFileName(got.uri) === null || typeof ctx.readFile !== 'function') return null
      return out(await ctx.readFile(got.uri), got.mime, declaredMs(ref))
    } catch {
      return null
    } finally {
      if (fileUri !== null) forgetFile(fileMedia, fileUri)
    }
  }

  const api = {
    sourceFor,
    bytesFor,
    pin,
    clear,
    get size () { return cache.size }
  }
  instances.add(api)
  return api
}

function forgetFile (media, uri) {
  const name = readFileName(uri)
  if (name === null || !media || typeof media.forgetReadFile !== 'function') return
  try { media.forgetReadFile(name) } catch {}
}

const shared = createChatMedia()

export function sourceFor (ref, ctx) {
  return shared.sourceFor(ref, ctx)
}

// Holds `uri` on screen: eviction waits until the returned function is
// called. -> unpin (idempotent).
export function pinChatMedia (uri) {
  return shared.pin(uri)
}

// Whether a chat cell may read its item now. In a message request nothing
// downloads by itself (docs/rpc.md, dm.thread): a deferred cell reads only
// after its own tap; once the request is accepted, cells load as usual.
export function shouldLoad ({ deferred, tapped } = {}) {
  return deferred !== true || tapped === true
}

// Called on lock and sign-out: revokes every blob: URL, forgets every node
// file and drops loads still running.
export function clearChatMedia () {
  for (const api of instances) api.clear()
  for (const media of hosts) {
    try { if (typeof media.clearReadFiles === 'function') media.clearReadFiles() } catch {}
  }
  hosts.clear()
}

// Native plaintext files live only while the app is in the foreground: going
// to the background clears them (and every cached source), so a crash or
// force-quit there leaves nothing on disk; images read again on return.
// canClear: the node handle's media has clearReadFiles (the capability, not
// the platform).
// After such a clear, the photos still on screen point at deleted files:
// they read again once the app is active, never while it is in the
// background (that would write the plaintext files the clear just removed).
const returnListeners = new Set()
let clearedInBackground = false

export function onChatMediaReturn (fn) {
  returnListeners.add(fn)
  return () => { returnListeners.delete(fn) }
}

export function onAppStateChange (state, { canClear, clear = clearChatMedia } = {}) {
  if (state === 'active' && clearedInBackground) {
    clearedInBackground = false
    for (const fn of [...returnListeners]) {
      try { fn() } catch {}
    }
    return false
  }
  if (state !== 'background' || canClear !== true) return false
  clear()
  clearedInBackground = true
  return true
}

// One player plays at a time: claiming playback pauses whatever played
// before. -> release(), which forgets the claim only if it is still current.
let activePlayer = null
let activeBound = false
let currentPlaybackEpoch = 0
let playbackClaims = 0

export function playbackClaimCount () {
  return playbackClaims
}

// A repeat of the same screen must not expire a claim that already read the epoch.
export function screenWatcher () {
  let last = null
  return (key) => {
    if (key === last) return false
    last = key
    return true
  }
}

// Read it at the tap (or after the screen is shown), never in a layout effect.
export function playbackEpoch () {
  return currentPlaybackEpoch
}

export function claimPlayback (player, { bound = false, epoch = currentPlaybackEpoch } = {}) {
  if (!player || typeof player.pause !== 'function') return () => {}
  if (bound && epoch !== currentPlaybackEpoch) {
    try { player.pause() } catch {}
    return () => {}
  }
  if (activePlayer !== null && activePlayer !== player) {
    try { activePlayer.pause() } catch {}
  }
  // A provider frame cannot be paused from outside, so its card watches this
  // count and drops the frame when any other player starts.
  playbackClaims++
  activePlayer = player
  activeBound = bound
  return () => {
    if (activePlayer === player) {
      activePlayer = null
      // stopPlayback leaves this set, so a claim that let go must clear it
      // or the next leave still takes the bound path.
      activeBound = false
    }
  }
}

export function stopBoundPlayback () {
  // Pending loads must expire even when no player has claimed playback yet.
  currentPlaybackEpoch++
  if (activeBound) stopPlayback()
}

export function stopPlayback () {
  const p = activePlayer
  activePlayer = null
  if (p !== null) {
    try { p.pause() } catch {}
  }
}
