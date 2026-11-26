// Alt text (descriptions) for post media. Pure: no React, no Node built-ins.
import rpc from '@varanda/rpc'
import { slideLabel } from './carousel.js'

const { MAX_ALT, displayText } = rpc

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g

function clip (text) {
  return Array.from(text).slice(0, MAX_ALT).join('')
}

export function lineUp (alt, media) {
  if (!Array.isArray(alt) || !Array.isArray(media) || alt.length !== media.length) return null
  for (const entry of alt) if (entry !== null && typeof entry !== 'string') return null
  return alt
}

export function altText (alt, index) {
  const entry = Array.isArray(alt) ? alt[index] : null
  if (typeof entry !== 'string') return ''
  return clip(displayText(entry).trim())
}

export function photoLabel ({ alt, media, index, count }) {
  const base = slideLabel(index, count)
  const desc = altText(lineUp(alt, media), index)
  return desc ? desc + ', ' + base : base
}

export function videoLabel ({ alt, media, seconds }) {
  const base = 'vídeo de ' + seconds + (seconds === 1 ? ' segundo' : ' segundos')
  const list = lineUp(alt, media)
  const desc = altText(list, 1) || altText(list, 0)
  return desc ? desc + ', ' + base : base
}

export function cleanAltInput (text) {
  const flat = String(text === null || text === undefined ? '' : text).replace(CONTROL, ' ')
  return clip(flat)
}

export function altParam (texts) {
  if (!Array.isArray(texts)) return null
  const out = texts.map((t) => {
    const s = typeof t === 'string' ? t.trim() : ''
    return s === '' ? null : s
  })
  return out.every((t) => t === null) ? null : out
}

export function videoAltParam (text) {
  const s = typeof text === 'string' ? text.trim() : ''
  return s === '' ? null : [null, s]
}

export function validAlt (alt, media) {
  const list = lineUp(alt, media)
  if (list === null) return false
  return list.every((e) => e === null || (e.length > 0 && Array.from(e).length <= MAX_ALT))
}
