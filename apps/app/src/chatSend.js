// Pure helpers of the chat photo flow (DMs and groups): the bubble layout of
// one to four images, the refs chatMedia.sourceFor takes, the check of an
// encoded file before it can be uploaded, and the send itself: uploads in
// order, then one request built by attach-plan.js composePlan.
//
// No React, no react-native, no Node built-ins: the node calls are injected,
// so the tests drive every phase.
//
// A send commits once. An upload that fails sends nothing (a normal error).
// A request answered uncertain keeps the exact { method, params } it sent;
// only an explicit retryChatSend resends that same operation, never this
// module by itself.

import rpc from '@varanda/rpc'
import { MAX_MEDIA_PER_POST, MEDIA_MIMES, gridLayout } from './media/plan.js'

export const CHAT_MEDIA_MAX_WIDTH = 240
export const CHAT_MEDIA_GAP = 2
// A single image keeps its aspect ratio inside these bounds, so a panorama
// or a long screenshot never takes the whole thread.
const MIN_RATIO = 0.5
const MAX_RATIO = 2

export const SEND_PHASES = Object.freeze(['idle', 'uploading', 'sending', 'done', 'uncertain', 'failed', 'cancelled'])

function ratioOf (item) {
  const w = item && Number.isFinite(item.w) && item.w > 0 ? item.w : null
  const h = item && Number.isFinite(item.h) && item.h > 0 ? item.h : null
  if (w === null || h === null) return 1
  return Math.max(MIN_RATIO, Math.min(MAX_RATIO, w / h))
}

// -> { width, height, cells: [{ left, top, width, height }] } for 1..4
// items ({ w, h } each, sizes may be missing), or null for any other count.
// 1: full width, aspect kept; 2: side by side; 3: two on top, one wide under
// them; 4: a 2x2 grid.
export function chatMediaLayout (items, maxWidth = CHAT_MEDIA_MAX_WIDTH) {
  const list = Array.isArray(items) ? items : []
  const kind = gridLayout(list.length)
  if (kind === null) return null
  const W = Math.max(1, Math.round(Number.isFinite(maxWidth) && maxWidth > 0 ? Math.min(maxWidth, CHAT_MEDIA_MAX_WIDTH) : CHAT_MEDIA_MAX_WIDTH))
  const G = CHAT_MEDIA_GAP
  const half = Math.floor((W - G) / 2)
  if (kind === 'one') {
    const height = Math.round(W / ratioOf(list[0]))
    return { width: W, height, cells: [{ left: 0, top: 0, width: W, height }] }
  }
  if (kind === 'two') {
    return {
      width: W,
      height: half,
      cells: [
        { left: 0, top: 0, width: half, height: half },
        { left: W - half, top: 0, width: half, height: half }
      ]
    }
  }
  const top = [
    { left: 0, top: 0, width: half, height: half },
    { left: W - half, top: 0, width: half, height: half }
  ]
  if (kind === 'three') {
    return { width: W, height: half * 2 + G, cells: [...top, { left: 0, top: half + G, width: W, height: half }] }
  }
  return {
    width: W,
    height: half * 2 + G,
    cells: [...top, { left: 0, top: half + G, width: half, height: half }, { left: W - half, top: half + G, width: half, height: half }]
  }
}

// The size of one item for the layout: a DM blob item and a private group
// item carry w/h, a public group descriptor width/height.
export function itemSize (item) {
  if (!item || typeof item !== 'object') return { w: null, h: null }
  const w = Number.isInteger(item.w) ? item.w : Number.isInteger(item.width) ? item.width : null
  const h = Number.isInteger(item.h) ? item.h : Number.isInteger(item.height) ? item.height : null
  return { w, h }
}

// The chatMedia.sourceFor refs of a DM message or a group item, at most four,
// in order; [] when there is no media or the row cannot name its sender.
export function chatMediaRefs (kind, row) {
  if (!row || typeof row !== 'object' || !Array.isArray(row.media)) return []
  const media = row.media.slice(0, MAX_MEDIA_PER_POST)
  if (kind === 'dm') {
    if (typeof row.from !== 'string' || typeof row.id !== 'string') return []
    return media.map((item, index) => ({ kind: 'dm', from: row.from, id: row.id, index, item }))
  }
  if (kind === 'group') {
    if (typeof row.diary !== 'string') return []
    return media.map((item) => ({ kind: 'group', diary: row.diary, item }))
  }
  return []
}

// An encoded file ({ bytes, mime, width, height }) that may be uploaded: its
// container bounds are read (mediaBounds from @varanda/rpc) before any node
// call, and the size sent is the one the bytes declare. -> the file to
// upload, or null.
export function boundedFile (encoded, bounds = rpc.mediaBounds) {
  if (!encoded || typeof encoded !== 'object') return null
  const { bytes, mime } = encoded
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || !MEDIA_MIMES.includes(mime)) return null
  let b
  try {
    b = bounds(bytes, mime)
  } catch {
    return null
  }
  if (!b || !Number.isInteger(b.width) || !Number.isInteger(b.height)) return null
  return { bytes, mime, width: b.width, height: b.height }
}

// The staged attachments composePlan checks. The node names its own
// upload file; this name only satisfies the request shape.
export function stagedOf (files) {
  return (Array.isArray(files) ? files : []).map((file, i) => ({
    name: i.toString(16).padStart(32, '0') + '.bin',
    mime: file.mime,
    width: file.width,
    height: file.height
  }))
}

// The identity of one posted group media item: a public descriptor by its
// place in the media core, a sealed item by its ciphertext hash.
function groupMediaId (item) {
  if (!item || typeof item !== 'object') return null
  if (typeof item.key === 'string') return typeof item.sha256 === 'string' ? 's:' + item.sha256 : null
  return typeof item.core === 'string' && Number.isSafeInteger(item.start) ? 'p:' + item.core + ':' + item.start : null
}

// Whether an uncertain group.post with photos landed, from a fresh group.read
// ({ items, next, state }). change: { diary, text, sentAt, replyKey, media }
// (media: the items that request carried). An own post at or after the send
// (2 s of slack) with the same text, reply and media identities, in order,
// is 'landed'; absence counts only when the read covered every message.
export function mediaPostLanded (change, view) {
  if (!change || !view || typeof view !== 'object' || view.incomplete === true || !Array.isArray(view.items)) return 'unknown'
  if (typeof change.diary !== 'string' || !Number.isFinite(change.sentAt) || !Array.isArray(change.media)) return 'unknown'
  const want = change.media.map(groupMediaId)
  if (want.length === 0 || want.includes(null)) return 'unknown'
  const floor = change.sentAt - 2000
  const replyKey = change.replyKey === undefined ? null : change.replyKey
  const found = view.items.some((i) => {
    if (!i || i.diary !== change.diary || i.text !== change.text || i.hidden === true) return false
    if (!(Date.parse(i.at) >= floor)) return false
    const key = i.replyTo && typeof i.replyTo === 'object' ? i.replyTo.writer + ':' + i.replyTo.seq : null
    if (key !== replyKey) return false
    const got = Array.isArray(i.media) ? i.media.map(groupMediaId) : []
    return got.length === want.length && got.every((id, n) => id === want[n])
  })
  if (found) return 'landed'
  return view.next === null && view.state === 'ok' ? 'not-landed' : 'unknown'
}

function defaultUncertain (err) {
  return !!(err && err.uncertain === true)
}

// Uploads `files` in order with upload(file, index), builds the request with
// plan.send(results) and sends it once with request(method, params).
// live() is read before each step: once it is false (Cancelar, a closed
// screen) nothing more is uploaded and nothing is sent. onPhase({ phase,
// progress }) follows idle -> uploading -> sending -> done | uncertain |
// failed | cancelled. -> { phase, op?, error?, value? }; never rejects.
export async function runChatSend ({ plan, files = [], upload, request, live = () => true, onPhase = () => {}, uncertain = defaultUncertain }) {
  const steps = files.length + 1
  const tell = (phase, progress) => { try { onPhase({ phase, progress }) } catch {} }
  if (!plan || typeof plan.send !== 'function' || !Array.isArray(plan.uploads) || plan.uploads.length !== files.length) {
    tell('failed', 0)
    return { phase: 'failed', error: new Error('anexos pendentes') }
  }
  const results = []
  for (let i = 0; i < files.length; i++) {
    if (!live()) return { phase: 'cancelled' }
    tell('uploading', i / steps)
    let out
    try {
      out = await upload(files[i], i)
    } catch (error) {
      if (!live()) return { phase: 'cancelled' }
      tell('failed', 0)
      return { phase: 'failed', error }
    }
    if (out === null || typeof out !== 'object') {
      tell('failed', 0)
      return { phase: 'failed', error: new Error('resposta inesperada') }
    }
    results.push(out)
  }
  if (!live()) return { phase: 'cancelled' }
  let op
  try {
    op = plan.send(results)
  } catch (error) {
    tell('failed', 0)
    return { phase: 'failed', error }
  }
  return sendOp({ op, request, tell, uncertain, progress: files.length / steps })
}

// The explicit "Tentar de novo" of an uncertain send: the same op, once.
export function retryChatSend ({ op, request, onPhase = () => {}, uncertain = defaultUncertain }) {
  const tell = (phase, progress) => { try { onPhase({ phase, progress }) } catch {} }
  if (!op || typeof op.method !== 'string' || !op.params) {
    tell('failed', 0)
    return Promise.resolve({ phase: 'failed', error: new Error('nada para reenviar') })
  }
  return sendOp({ op, request, tell, uncertain, progress: 0 })
}

async function sendOp ({ op, request, tell, uncertain, progress }) {
  tell('sending', progress)
  try {
    const value = await request(op.method, op.params)
    tell('done', 1)
    return { phase: 'done', op, value }
  } catch (error) {
    if (uncertain(error)) {
      tell('uncertain', 0)
      return { phase: 'uncertain', op, error }
    }
    tell('failed', 0)
    return { phase: 'failed', op, error }
  }
}
