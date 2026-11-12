import rpc from '@varanda/rpc'
import { MAX_MEDIA_PER_POST } from './media/plan.js'

const { MAX_TEXT, displayText } = rpc

export const SHARE_TTL_MS = 3600000
export const SHARE_SKEW_MS = 60000
export const SHARE_ID = /^[0-9]{13}-[0-9a-f]{32}$/
export const EXPIRED_TEXT = 'o compartilhamento expirou'
export const EMPTY = Object.freeze({ held: null, phase: 'idle', owner: null, last: null, taken: false })

function clean (value) {
  if (typeof value !== 'string') return ''
  return displayText(value.slice(0, 4000).replace(/\r\n?/g, '\n'), { multiline: true })
    .replace(/\ufffd/g, '')
    .trim()
}

export function composeShareText ({ title, text, url }) {
  const cleanedText = clean(text)
  const body = cleanedText || clean(title)
  const cleanedUrl = clean(url)
  const validUrl = /^https?:\/\//i.test(cleanedUrl) &&
    cleanedUrl.length <= 2000 &&
    !/\s/.test(cleanedUrl) &&
    !body.includes(cleanedUrl)
  const bodyChars = Array.from(body)
  if (validUrl) {
    const urlChars = Array.from(cleanedUrl)
    if (body === '') {
      return urlChars.length <= MAX_TEXT
        ? { text: cleanedUrl, clipped: false }
        : { text: '', clipped: true }
    }
    if (bodyChars.length + 1 + urlChars.length <= MAX_TEXT) {
      return { text: body + '\n' + cleanedUrl, clipped: false }
    }
    return {
      text: bodyChars.slice(0, MAX_TEXT).join('').trimEnd(),
      clipped: true
    }
  }
  return {
    text: bodyChars.slice(0, MAX_TEXT).join(''),
    clipped: bodyChars.length > MAX_TEXT
  }
}

function isPlainObject (value) {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function acceptedFile (file) {
  if (file === null || typeof file !== 'object') return null
  if (typeof file.uri === 'string' && typeof file.mimeType === 'string') {
    return {
      uri: file.uri,
      mimeType: file.mimeType,
      width: file.width,
      height: file.height
    }
  }
  if (typeof file.type === 'string' && typeof file.size === 'number') return file
  return null
}

export function acceptShare (raw, now) {
  if (!isPlainObject(raw)) return null
  if (typeof raw.id !== 'string' || !SHARE_ID.test(raw.id)) return null
  if (!Number.isSafeInteger(raw.at) || raw.at !== Number(raw.id.slice(0, 13))) return null
  if (!(raw.at <= now + SHARE_SKEW_MS) || !Array.isArray(raw.files)) return null

  const files = []
  for (const offered of raw.files) {
    const file = acceptedFile(offered)
    if (file !== null && files.length < MAX_MEDIA_PER_POST) files.push(file)
  }
  const composed = composeShareText(raw)
  if (composed.text === '' && files.length === 0) return null
  const total = Number.isSafeInteger(raw.total) ? raw.total : 0
  const announced = Math.max(total, raw.files.length)
  const dropped = Math.max(0, announced - MAX_MEDIA_PER_POST)
  const failed = Math.max(0, announced - files.length - dropped)
  return {
    id: raw.id,
    at: raw.at,
    text: composed.text,
    clipped: composed.clipped,
    files,
    dropped,
    failed
  }
}

function key (value) {
  return typeof value === 'string' && value !== '' ? value : null
}

function droppedState (id) {
  return { ...EMPTY, last: id }
}

export function shareStep (state, event) {
  if (event.type === 'inbox') {
    const share = event.share
    if (share == null || (state.held && state.held.id === share.id) || state.last === share.id) {
      return { state, effects: [] }
    }
    const effects = state.held ? [{ type: 'release', id: state.held.id }] : []
    return {
      state: {
        held: share,
        phase: 'idle',
        owner: key(event.ownKey),
        last: state.held ? state.held.id : state.last,
        taken: false
      },
      effects
    }
  }

  if (event.type === 'tick') {
    if (state.held === null) return { state, effects: [] }
    if (!state.taken && event.now - state.held.at > SHARE_TTL_MS) {
      return {
        state: droppedState(state.held.id),
        effects: [
          { type: 'release', id: state.held.id },
          { type: 'toast', text: EXPIRED_TEXT }
        ]
      }
    }
    // Sair or Recomeçar left no account on the device: a share bound to the
    // account that left is dropped, never handed to the next one.
    if (event.gone === true && state.owner !== null) {
      return {
        state: droppedState(state.held.id),
        effects: [{ type: 'release', id: state.held.id }]
      }
    }
    // ownKey is the account stored on the device, known while locked too: the
    // share binds to it before the lock check, or one that arrived before the
    // first status read would stay unbound behind a locked account and survive
    // Recomeçar.
    const ownKey = key(event.ownKey)
    if (state.owner !== null && ownKey !== null && state.owner !== ownKey) {
      return {
        state: droppedState(state.held.id),
        effects: [{ type: 'release', id: state.held.id }]
      }
    }
    const current = state.owner === null && ownKey !== null ? { ...state, owner: ownKey } : state
    if (event.locked === true) {
      if (current.phase === 'idle') return { state: current, effects: [] }
      return { state: { ...current, phase: 'idle', taken: false }, effects: [] }
    }
    if (current.phase === 'idle' && event.ready === true && ownKey !== null) {
      return {
        state: { ...current, phase: 'shown' },
        effects: [{ type: 'open' }]
      }
    }
    return { state: current, effects: [] }
  }

  if (event.type === 'taken') {
    if (state.phase !== 'shown' || state.held.id !== event.id) return { state, effects: [] }
    return { state: { ...state, taken: true }, effects: [] }
  }

  if (event.type === 'done') {
    if (state.held === null || state.held.id !== event.id) return { state, effects: [] }
    return {
      state: droppedState(state.held.id),
      effects: [{ type: 'release', id: state.held.id }]
    }
  }

  if (event.type === 'requeue' && state.phase === 'shown' && !state.taken) {
    return { state: { ...state, phase: 'idle' }, effects: [] }
  }
  return { state, effects: [] }
}

// The post field has no length cap, so a draft may already be over max: only
// the shared text is ever cut or left out, never what the person typed.
export function mergeDraft (draft, sharedText, max) {
  if (sharedText === '') return { text: draft, kept: true }
  if (draft.trim() === '') {
    const chars = Array.from(sharedText)
    return { text: chars.slice(0, max).join(''), kept: chars.length <= max }
  }
  const merged = draft + '\n' + sharedText
  if (Array.from(merged).length <= max) return { text: merged, kept: true }
  return { text: draft, kept: false }
}

export function shareNote ({ canAttach, hadFiles, noRoom, dropped, failed = 0, kept, clipped }) {
  let note = ''
  if (hadFiles && !canAttach) note = 'não dá para anexar fotos agora'
  else if (noRoom > 0) note = 'até ' + MAX_MEDIA_PER_POST + ' fotos por publicação'
  else if (dropped > 0) note = 'só as ' + MAX_MEDIA_PER_POST + ' primeiras fotos foram anexadas'
  else if (kept === false) note = 'o texto compartilhado não coube no rascunho'
  else if (clipped) note = 'o texto compartilhado foi cortado em ' + MAX_TEXT + ' caracteres'
  if (failed > 0) return note + (note === '' ? '' : '. ') + 'algumas fotos não puderam ser abertas'
  return note
}
