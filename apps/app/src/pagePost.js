// A page post, reply or quote: the same media and link preview a person's
// post carries. A video and a preview cannot travel together. No I/O of its
// own; the screen injects the upload.

import { readyVideo } from './videoCompose.js'
import { pageError } from './pages.js'
import { validDescriptor, validVideoDescriptor } from './media/fetch.js'

// { text } always. media when it is a non-empty array. preview when it is
// not null. Media with a preview is pedido-invalido: no record carries both.
export function pagePostOp ({ text, media = null, preview = null }) {
  const hasMedia = Array.isArray(media) && media.length > 0
  if (hasMedia && preview !== null) throw pageError('pedido-invalido')
  const op = { text }
  if (hasMedia) op.media = media
  if (preview !== null) op.preview = preview
  return op
}

function descriptorOf (answer, valid, message) {
  const d = answer && typeof answer === 'object' && !Array.isArray(answer) ? answer.descriptor : undefined
  if (!valid(d)) {
    const err = new Error(message)
    err.uncertain = true
    throw err
  }
  return d
}

const validPoster = (d) => validDescriptor(d) && d.mime === 'image/jpeg'

// Uploads the JPEG poster, then the video with its duration, each once.
// upload is the screen's pagesMedia wrapper. file is a readyVideo() file.
// poster is an already uploaded poster descriptor from an earlier attempt:
// its upload is skipped. When the video upload throws, the poster descriptor
// is on err.poster so the caller can resume; this never retries.
// -> [posterDescriptor, videoDescriptor] from each answer's descriptor.
export async function prepPageVideo ({ upload, file, poster = null }) {
  if (!readyVideo(file) || typeof upload !== 'function') throw pageError('pedido-invalido')
  let posterDescriptor = poster
  if (!validPoster(posterDescriptor)) {
    const answer = await upload({
      bytes: file.poster.bytes,
      mime: file.poster.mime,
      width: file.poster.width,
      height: file.poster.height
    })
    posterDescriptor = descriptorOf(answer, validPoster, 'Resposta inválida ao enviar a capa do vídeo.')
  }
  try {
    const videoAnswer = await upload({
      bytes: file.bytes,
      mime: file.mime,
      width: file.width,
      height: file.height,
      ms: file.ms
    })
    return [posterDescriptor, descriptorOf(videoAnswer, validVideoDescriptor, 'Resposta inválida ao enviar o vídeo.')]
  } catch (err) {
    if (err && typeof err === 'object') err.poster = posterDescriptor
    throw err
  }
}
