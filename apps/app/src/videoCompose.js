import rpc from '@varanda/rpc'
import { MAX_VIDEO_MS, MAX_VIDEO_BYTES, MAX_MOMENT_VIDEO_MS, MAX_MOMENT_VIDEO_BYTES, MAX_VIDEO_DIMENSION, MAX_VIDEO_PIXELS, checkFile } from './media/plan.js'
import { validDescriptor, validVideoDescriptor } from './media/fetch.js'

export const VIDEO_OR_PHOTOS = 'Um vídeo ou fotos, não os dois.'
export const VIDEO_OR_PREVIEW = 'Um vídeo ou prévia de link, não os dois. Remova a prévia para escolher um vídeo.'
export const MOMENT_ONE_MEDIA = 'Um momento leva uma foto ou um vídeo.'
export const MEDIA_FULL = 'Este aparelho não tem mais espaço para fotos e vídeos.'
export const VIDEO_PICK_FAILED = 'Não foi possível abrir seus vídeos. Tente de novo.'

export function mediaComposeError (err) {
  return err && err.uncertain !== true && err.message === 'espaço de fotos deste aparelho esgotado' ? MEDIA_FULL : ''
}

export function canComposeVideo ({ node, asPage = null, pickVideo, prepareVideo }) {
  return !!node && node.online !== false && node.media?.video === true && asPage === null &&
    typeof pickVideo === 'function' && typeof prepareVideo === 'function'
}

export function videoLimits (moment = false) {
  return moment
    ? { maxMs: MAX_MOMENT_VIDEO_MS, maxBytes: MAX_MOMENT_VIDEO_BYTES }
    : { maxMs: MAX_VIDEO_MS, maxBytes: MAX_VIDEO_BYTES }
}

export function videoConflict ({ photos = 0, preview = false, moment = false } = {}) {
  if (photos > 0) return moment ? MOMENT_ONE_MEDIA : VIDEO_OR_PHOTOS
  return preview ? VIDEO_OR_PREVIEW : ''
}

export function readyVideo (file, moment = false) {
  const { maxMs, maxBytes } = videoLimits(moment)
  if (!file || file.mime !== 'video/mp4' || !(file.bytes instanceof Uint8Array) ||
    file.bytes.length < 1 || file.bytes.length > maxBytes || !Number.isInteger(file.ms) || file.ms < 1 || file.ms > maxMs) return false
  if (![file.width, file.height].every(n => Number.isInteger(n) && n > 0 && n <= MAX_VIDEO_DIMENSION) || file.width * file.height > MAX_VIDEO_PIXELS) return false
  const poster = file.poster
  return !!poster && poster.mime === 'image/jpeg' && poster.bytes instanceof Uint8Array &&
    checkFile({ ...poster, bytes: poster.bytes.length }) === null
}

export function videoPostValid ({ file, text = '', quote = false, photos = 0, preview = false }) {
  return videoConflict({ photos, preview }) === '' && readyVideo(file) &&
    [...text].length <= rpc.MAX_TEXT && (!quote || [...text].length > 0)
}

export function videoMomentValid ({ file, text = '', photos = 0, preparing = false }) {
  return !preparing && photos === 0 && [...text].length <= 200 && readyVideo(file, true)
}

// Dependencies do the I/O; this draft owns generations and cached descriptors.
// Picking and preparing never call upload. Only an explicit send does that.
export function createVideoDraft ({ changed = () => {}, moment = false } = {}) {
  let state = { phase: 'empty', file: null }
  let generation = 0
  let controller = null
  let poster = null
  let video = null
  const set = (next) => { state = next; changed(state) }
  const clear = () => {
    generation++
    if (controller) controller.abort()
    controller = null
    poster = null
    video = null
    set({ phase: 'empty', file: null })
  }
  return {
    get state () { return state },
    clear,
    cancelPreparation () { if (state.phase === 'preparing') clear() },
    async pick ({ pickVideo, prepareVideo, ...selection }) {
      if (state.phase !== 'empty') return false
      const conflict = videoConflict({ ...selection, moment })
      if (conflict) throw new Error(conflict)
      const gen = ++generation
      controller = new AbortController()
      const signal = controller.signal
      const live = () => gen === generation && !signal.aborted
      set({ phase: 'preparing', file: null })
      try {
        let picked
        try {
          picked = await pickVideo()
        } catch {
          // The picker's own text may be English or not an Error at all.
          throw new Error(VIDEO_PICK_FAILED)
        }
        // Handed over even when the draft was cleared meanwhile: the aborted
        // signal makes prepareVideo return at once, after it deletes the
        // picker's copy of the video.
        const file = picked ? await prepareVideo(picked, { ...videoLimits(moment), signal }) : null
        if (!live()) return false
        if (file === null) { clear(); return false }
        if (!readyVideo(file, moment)) throw new Error('Este vídeo não cabe no formato aceito.')
        set({ phase: 'ready', file })
        return true
      } catch (err) {
        if (!live()) return false
        clear()
        throw err
      } finally {
        if (gen === generation) controller = null
      }
    },
    async upload (upload) {
      if (state.phase !== 'ready' || !readyVideo(state.file)) return null
      const gen = generation
      const file = state.file
      set({ phase: 'uploading', file })
      try {
        if (poster === null) {
          const d = await upload({ ...file.poster })
          if (gen !== generation) return null
          if (!validDescriptor(d) || d.mime !== 'image/jpeg') throw new Error('Resposta inválida ao enviar a capa do vídeo.')
          poster = d
        }
        if (video === null) {
          const { bytes, mime, width, height, ms } = file
          const d = await upload({ bytes, mime, width, height, ms, kind: 'video' })
          if (gen !== generation) return null
          if (!validVideoDescriptor(d)) throw new Error('Resposta inválida ao enviar o vídeo.')
          video = d
        }
        return [poster, video]
      } catch (err) {
        if (gen !== generation) return null
        throw err
      } finally {
        if (gen === generation) set({ phase: 'ready', file })
      }
    }
  }
}
