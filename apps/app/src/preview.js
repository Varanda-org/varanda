import rpc from '@varanda/rpc'
import { findLinks } from './links.js'

const { MAX_CARD_URL, cardUrlHost, parseOg } = rpc

// A page URL core's link card accepts once normalized (cardUrlHost: a dotted
// hostname, never an IP literal, so the device never fetches a LAN address).
// The fragment is kept, as core keeps it.
function pageUrl (value) {
  try {
    if (typeof value !== 'string' || !value || value.length > MAX_CARD_URL) return null
    if (!/^https:\/\//i.test(value)) return null
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null
    return cardUrlHost(parsed.href) === parsed.hostname ? parsed : null
  } catch {
    return null
  }
}

// The card of `html` fetched from `url`, read by the reader the account
// service uses too (parseOg of @varanda/rpc), so both build the same card.
export function extractPreview (html, url) {
  try {
    const page = pageUrl(url)
    if (!page || typeof html !== 'string') return null
    const { title, desc, imageUrl } = parseOg(html, page.href)
    if (!title) return null
    return { url: page.href, host: page.hostname.toLowerCase(), title, desc, imageUrl }
  } catch {
    return null
  }
}

export function previewTarget (text) {
  return findLinks(text).find(({ href }) => href.startsWith('https://'))?.href ?? null
}
