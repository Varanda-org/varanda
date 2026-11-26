import rpc from '@varanda/rpc'
import { MAX_MEDIA_PER_POST } from './media/plan.js'
import { previewTarget } from './preview.js'

const { MAX_TEXT, displayText } = rpc

export const SHARE_TTL_MS = 3600000
export const SHARE_SKEW_MS = 60000
export const SHARE_ID = /^[0-9]{13}-[0-9a-f]{32}$/
export const EXPIRED_TEXT = 'o compartilhamento expirou'
// The web worker could not store a share (src/shareIntake.web.js takeLost).
export const LOST_TEXT = 'o compartilhamento não coube no espaço do navegador'
// A shared video met a draft that already holds one.
export const VIDEO_HELD_TEXT = 'o rascunho já tem um vídeo'
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

function isVideo (offered) {
  if (offered === null || typeof offered !== 'object') return false
  const mime = typeof offered.mimeType === 'string' ? offered.mimeType : offered.type
  return typeof mime === 'string' && /^video\//i.test(mime)
}

// total counts the photos offered and videos the videos, so a video that
// could not be copied is told apart from a photo that could not.
// video: the first video, used only when no photo came along, since a post
// holds a video or photos. videoNote: '' or why a video offered is not used
// ('photos', 'failed', 'extra': the ones after the first).
export function acceptShare (raw, now) {
  if (!isPlainObject(raw)) return null
  if (typeof raw.id !== 'string' || !SHARE_ID.test(raw.id)) return null
  if (!Number.isSafeInteger(raw.at) || raw.at !== Number(raw.id.slice(0, 13))) return null
  if (!(raw.at <= now + SHARE_SKEW_MS) || !Array.isArray(raw.files)) return null

  const files = []
  let photoEntries = 0
  let videoEntries = 0
  let video = null
  for (const offered of raw.files) {
    const file = acceptedFile(offered)
    if (isVideo(offered)) {
      videoEntries++
      if (file !== null && video === null) video = file
      continue
    }
    photoEntries++
    if (file !== null && files.length < MAX_MEDIA_PER_POST) files.push(file)
  }
  const composed = composeShareText(raw)
  if (files.length > 0) video = null
  const videos = Math.max(Number.isSafeInteger(raw.videos) ? raw.videos : 0, videoEntries)
  // A video that did not arrive still opens the composer, to say so (the
  // PWA keeps such a share; Android and iOS say it in their own sheet).
  if (composed.text === '' && files.length === 0 && video === null && videos === 0) return null
  const total = Number.isSafeInteger(raw.total) ? raw.total : 0
  const announced = Math.max(total, photoEntries)
  const dropped = Math.max(0, announced - MAX_MEDIA_PER_POST)
  const failed = Math.max(0, announced - files.length - dropped)
  let videoNote = ''
  if (videos > 0 && files.length > 0) videoNote = 'photos'
  else if (videos > 0 && video === null) videoNote = 'failed'
  else if (videos > 1) videoNote = 'extra'
  return {
    id: raw.id,
    at: raw.at,
    text: composed.text,
    clipped: composed.clipped,
    files,
    dropped,
    failed,
    video,
    videoNote
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

  // Publicar loaded the photos and some failed to open: it keeps the files
  // for a retry and frees them itself. The shell lets go without releasing,
  // so the next share is read meanwhile.
  if (event.type === 'loaded') {
    if (state.phase !== 'shown' || !state.taken || state.held.id !== event.id) return { state, effects: [] }
    return { state: droppedState(state.held.id), effects: [] }
  }

  // Publicar no longer needs a share it kept after 'loaded'.
  if (event.type === 'free') {
    if (typeof event.id !== 'string' || !SHARE_ID.test(event.id)) return { state, effects: [] }
    if (state.held !== null && state.held.id === event.id) {
      return { state: droppedState(state.held.id), effects: [{ type: 'release', id: event.id }] }
    }
    return { state, effects: [{ type: 'release', id: event.id }] }
  }

  if (event.type === 'requeue' && state.phase === 'shown' && !state.taken) {
    return { state: { ...state, phase: 'idle' }, effects: [] }
  }
  return { state, effects: [] }
}

// A size or format refusal fails the same way on every try.
export function retryableEncode (message) {
  return typeof message === 'string' && message !== '' && message !== 'formato não aceito' && !message.endsWith('grande demais')
}

// The ids of a share's photos that failed to open and may work on a retry.
// None: the share is done now. Some: it is held until each one loads on a
// retry or leaves the draft (removed, published or discarded).
export function holdShare (id, failed) {
  const ids = Array.from(new Set(Array.isArray(failed) ? failed : []))
  return ids.length === 0 ? { hold: null, done: id } : { hold: { id, ids }, done: null }
}

export function settleHold (hold, settled) {
  if (hold === null || !Array.isArray(settled)) return { hold, done: null }
  const gone = new Set(settled)
  const ids = hold.ids.filter((x) => !gone.has(x))
  if (ids.length === hold.ids.length) return { hold, done: null }
  return ids.length === 0 ? { hold: null, done: hold.id } : { hold: { id: hold.id, ids }, done: null }
}

// The post text kept across a page load (src/draftKeep.web.js) goes before
// what is already in the draft, which can only be a share's text applied
// first. As in mergeDraft, what the person typed is never cut: when both do
// not fit, the kept text alone stays.
export function restoreDraft (kept, current, max) {
  if (typeof kept !== 'string' || kept === '') return current
  if (typeof current !== 'string' || current.trim() === '' || current === kept) return kept
  const merged = kept + '\n' + current
  return Array.from(merged).length <= max ? merged : kept
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

// A link the share brought builds its preview only once the person asks for
// it or edits the text. The hold is the merged text, or null when the share
// changed nothing the preview would read (no link, or the draft's own link
// still comes first). A hold still on the draft moves to the next share's
// text, even when that share did not fit, so a later share never starts the
// preview the first one held.
export function sharedLinkHold (draft, merged, hold = null) {
  if (typeof draft !== 'string' || typeof merged !== 'string') return null
  const target = previewTarget(merged)
  if (target === null) return null
  return target !== previewTarget(draft) || linkHeld(hold, draft) ? merged : null
}

// Any change to the text ends the hold for good.
export function linkHeld (hold, text) {
  return typeof hold === 'string' && hold === text && previewTarget(text) !== null
}

const VIDEO_NOTES = {
  photos: 'o vídeo ficou de fora, uma publicação leva um vídeo ou fotos',
  failed: 'o vídeo não pôde ser recebido',
  extra: 'só o primeiro vídeo foi anexado'
}

export function shareNote ({ canAttach, hadFiles, noRoom, dropped, failed = 0, kept, clipped, hadVideo = false, canVideo = false, videoNote = '' }) {
  let note = ''
  if (hadFiles && !canAttach) note = 'não dá para anexar fotos agora'
  else if (hadVideo && !canVideo) note = 'não dá para anexar vídeos agora'
  else if (noRoom > 0) note = 'até ' + MAX_MEDIA_PER_POST + ' fotos por publicação'
  else if (dropped > 0) note = 'só as ' + MAX_MEDIA_PER_POST + ' primeiras fotos foram anexadas'
  else if (kept === false) note = 'o texto compartilhado não coube no rascunho'
  else if (clipped) note = 'o texto compartilhado foi cortado em ' + MAX_TEXT + ' caracteres'
  const more = []
  if (failed > 0) more.push('algumas fotos não puderam ser abertas')
  if (typeof VIDEO_NOTES[videoNote] === 'string') more.push(VIDEO_NOTES[videoNote])
  return [note, ...more].filter((x) => x !== '').join('. ')
}

export function shareMomentKind (share) {
  if (share === null || typeof share !== 'object' || !Array.isArray(share.files)) return null
  if (share.dropped !== 0 || share.failed !== 0 || share.videoNote !== '') return null
  if (share.files.length === 1 && share.video === null) return 'photo'
  if (share.files.length === 0 && share.video !== null) return 'video'
  return null
}

export function shareAsks ({ share, canMoment }) {
  const kind = shareMomentKind(share)
  if (kind === null) return false
  return (typeof canMoment === 'function' ? canMoment(kind) : canMoment) === true
}

// clipped: the share was already cut to the post limit before it got here.
export function momentShareText (draft, sharedText, max, clipped = false) {
  draft = typeof draft === 'string' ? draft : ''
  sharedText = typeof sharedText === 'string' ? sharedText : ''
  const { text, kept } = mergeDraft(draft, sharedText, max)
  const note = kept
    ? (clipped === true ? 'o texto compartilhado foi cortado em ' + MAX_TEXT + ' caracteres' : '')
    : draft.trim() !== ''
      ? 'o texto compartilhado não coube no momento'
      : 'o texto compartilhado foi cortado em ' + max + ' caracteres'
  return { text, note }
}

export const MOMENT_SHARE_BACK = 'não dá para publicar momentos agora, o compartilhamento abriu como publicação'

export function momentShareBack (seconds) {
  return Number.isInteger(seconds) && seconds > 0
    ? 'o vídeo passa de ' + seconds + ' segundos, por isso abriu como publicação'
    : MOMENT_SHARE_BACK
}
