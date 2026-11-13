// The attach sheet of a chat composer and the photos it stages.
//
// AttachSheet: opened by the composer's clip button. 'Foto' (the gallery, up
// to four images; a GIF chosen there is a photo whose bytes are kept as they
// are), and 'GIF' (GifPicker.js) only where the account service offers the
// search to this member (`gif`). 'Áudio' keeps its slot below but stays out
// of the sheet: a planned option must never read as available.
//
// useChatAttachments: the staged photos of one composer. Each chosen file is
// encoded at once (../media/encode: a photo is re-encoded, which strips EXIF
// and the GPS position; a GIF keeps its bytes) and its container bounds are
// read (chatSend.js boundedFile, mediaBounds from @varanda/rpc) before it can
// be uploaded. A thumbnail is a device-local URL of those bytes, released on
// remove, clear and unmount. Nothing is uploaded here: the screen sends.
// pick(file) stages an already fetched file (a GIF from GifPicker, checked
// there like a gallery GIF) without opening the gallery; it is bounded again
// here, so every staged file passed the same check.

import { useCallback, useEffect, useRef, useState } from 'react'
import { pickImages } from '../media/attach'
import { encodeFile } from '../media/encode'
import { revokeUrl, urlFromBytes } from '../media/display'
import { MAX_MEDIA_PER_MESSAGE } from '../media/plan'
import { boundedFile } from '../chatSend'
import { errorText } from './index'
import { ActionsSheet } from './ActionsSheet'

// `planned` options are kept for their PRs and filtered out of the sheet.
const OPTIONS = [
  { key: 'photo', label: 'Foto', icon: 'imagem', hint: 'da galeria, até 4' },
  { key: 'gif', label: 'GIF', icon: 'imagem', planned: true },
  { key: 'audio', label: 'Áudio', icon: 'microfone', planned: true }
]

export const ATTACH_OPTIONS = OPTIONS.filter((o) => o.planned !== true)

// The planned GIF slot is the one option a capability turns on.
export function attachOptions ({ gif = false } = {}) {
  return OPTIONS.filter((o) => o.planned !== true || (o.key === 'gif' && gif === true))
}

// A compact bottom panel as tall as its rows (ActionsSheet), as the chat
// apps' attach menus are; the picker opens only once the panel is gone, so
// the system picker never stacks on a closing sheet.
export function AttachSheet ({ open, onClose, onPick, gif = false }) {
  const actions = attachOptions({ gif }).map((option) => ({
    icon: option.icon,
    label: option.label,
    onPress: () => onPick(option.key)
  }))
  return <ActionsSheet open={open} onClose={onClose} title='Anexar' actions={actions} />
}

let lastId = 0

// -> { items, pick, remove, clear, files, ready, busy, note }
// items: [{ id, status: 'encoding' | 'ready' | 'invalid', thumb, file, error }]
// files: the ready files in order ({ bytes, mime, width, height }).
export function useChatAttachments () {
  const [items, setItems] = useState([])
  const [note, setNote] = useState('')
  const liveRef = useRef(new Set())
  const thumbsRef = useRef(new Map())
  const genRef = useRef(0)

  const drop = (id) => {
    const thumb = thumbsRef.current.get(id)
    thumbsRef.current.delete(id)
    if (thumb) revokeUrl(thumb)
  }
  const patch = (id, next) => setItems((list) => list.map((item) => (item.id === id ? { ...item, ...next } : item)))

  const clear = useCallback(() => {
    genRef.current++
    for (const id of Array.from(thumbsRef.current.keys())) drop(id)
    liveRef.current = new Set()
    setItems([])
    setNote('')
  }, [])

  useEffect(() => () => {
    genRef.current++
    for (const id of Array.from(thumbsRef.current.keys())) drop(id)
  }, [])

  const remove = useCallback((id) => {
    liveRef.current.delete(id)
    drop(id)
    setItems((list) => list.filter((item) => item.id !== id))
    setNote('')
  }, [])

  const pick = useCallback(async (ready) => {
    setNote('')
    // Taken before the picker opens: a clear or an unmount while it is open
    // makes its late result stale, and nothing is staged or created from it.
    const gen = genRef.current
    const given = ready && typeof ready === 'object' && ready.bytes instanceof Uint8Array ? ready : null
    let picked
    if (given !== null) {
      picked = [given]
    } else {
      try {
        picked = await pickImages(MAX_MEDIA_PER_MESSAGE)
      } catch {
        return
      }
    }
    if (gen !== genRef.current) return
    if (!Array.isArray(picked) || picked.length === 0) return
    const room = Math.max(0, MAX_MEDIA_PER_MESSAGE - liveRef.current.size)
    if (picked.length > room) setNote('até ' + MAX_MEDIA_PER_MESSAGE + ' fotos por mensagem')
    const chosen = picked.slice(0, room).map((source) => ({ id: ++lastId, source }))
    if (chosen.length === 0) return
    for (const { id } of chosen) liveRef.current.add(id)
    setItems((list) => [...list, ...chosen.map(({ id }) => ({ id, status: 'encoding', thumb: null, file: null, error: '' }))])
    // One at a time: decoding large photos in parallel takes a lot of memory.
    for (const { id, source } of chosen) {
      if (gen !== genRef.current) return
      let file = null
      let error = ''
      try {
        file = boundedFile(given !== null ? source : await encodeFile(source))
        if (file === null) error = 'formato não aceito'
      } catch (err) {
        error = errorText(err)
      }
      if (gen !== genRef.current || !liveRef.current.has(id)) continue
      if (file === null) {
        patch(id, { status: 'invalid', error })
        continue
      }
      let thumb = null
      try {
        thumb = urlFromBytes(file.bytes, file.mime)
      } catch {}
      if (thumb !== null && (gen !== genRef.current || !liveRef.current.has(id))) {
        revokeUrl(thumb)
        continue
      }
      if (thumb !== null) thumbsRef.current.set(id, thumb)
      patch(id, { status: 'ready', file, thumb })
    }
  }, [])

  const files = items.filter((item) => item.status === 'ready').map((item) => item.file)
  const busy = items.some((item) => item.status === 'encoding')
  const ready = items.length > 0 && !busy && items.every((item) => item.status === 'ready')
  return { items, pick, remove, clear, files, ready, busy, note }
}
