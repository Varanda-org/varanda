import { plainOf } from './richText.js'
import rpc from '@varanda/rpc'

const { displayText } = rpc

// Mirrors packages/core/lib/member.js PREVIEW_CODE_POINTS and PREVIEW_MAX in packages/web-member/lib/member-ops.js, packages/web-member/lib/dm.js and apps/cli/lib/account/pages-dm.js.
export const NODE_PREVIEW_CODE_POINTS = 140

export function plainPreview (value) {
  if (typeof value !== 'string') return plainOf(value)
  return plainOf(value, { clipped: Array.from(value).length >= NODE_PREVIEW_CODE_POINTS })
}

export function quoteText (text) {
  if (typeof text !== 'string') return ''
  return Array.from(displayText(plainOf(text).replace(/[\r\n\u2028\u2029]+/g, ' '))).slice(0, 90).join('')
}
