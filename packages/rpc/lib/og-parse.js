'use strict'

// The one inert reader of a page's link card metadata (docs/protocol.md,
// "Link cards"), shared by the app (apps/app/src/preview.js) and the account
// service (apps/cli/lib/account/preview-routes.js), so both build the same
// card from the same page. A linear scan of the markup: nothing is run or
// loaded. Zero dependencies, no Node built-ins. Never throws.

const { MAX_CARD_URL, MAX_CARD_TITLE, MAX_CARD_DESC, cardText, cardUrlHost } = require('./link-card')

const MAX_OG_HTML = 512 * 1024
// Elements whose content is never markup this reader looks at.
const SKIPPED = ['script', 'style', 'noscript', 'textarea']
const TAG_NAME_RE = /<(\/?)([a-zA-Z][^\s/>]*)/y
const ENTITY_RE = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/g
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
// Zero-width and directional marks the card text rule keeps but a title
// never needs: they only hide or reorder what the reader sees.
const INVISIBLE_RE = /[\u200b-\u200f\u2060\ufeff]/g
const WS = /[\t\n\f\r ]/

// One pass, so `&amp;lt;` is `&lt;`. A numeric reference outside Unicode,
// to a surrogate or to NUL is U+FFFD; an unknown name stays as written.
function decodeEntities (text) {
  return text.replace(ENTITY_RE, (whole, body) => {
    if (body[0] !== '#') {
      const key = body.toLowerCase()
      return Object.hasOwn(NAMED, key) ? NAMED[key] : whole
    }
    const hex = body[1] === 'x' || body[1] === 'X'
    const digits = (hex ? body.slice(2) : body.slice(1)).replace(/^0+/, '')
    if (digits.length > 8) return '�'
    const cp = digits === '' ? 0 : parseInt(digits, hex ? 16 : 10)
    if (cp < 1 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '�'
    return String.fromCodePoint(cp)
  })
}

// Raw page text as card text: entities decoded first, so a character a
// reference spells is removed like a literal one.
function ogText (raw, max) {
  if (typeof raw !== 'string') return ''
  return cardText(decodeEntities(raw).replace(INVISIBLE_RE, ''), max)
}

// An image URL a card may carry: the raw attribute decoded, resolved
// against `base`, https with no credentials, its fragment dropped, and
// accepted by cardUrlHost. null otherwise.
function ogImageUrl (raw, base) {
  try {
    if (typeof raw !== 'string' || typeof base !== 'string') return null
    const value = decodeEntities(raw).trim()
    if (value === '' || value.length > MAX_CARD_URL) return null
    const url = new URL(value, base)
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null
    url.hash = ''
    return cardUrlHost(url.href) === url.hostname ? url.href : null
  } catch {
    return null
  }
}

// The attributes of the tag whose name ends at `from`, read as HTML does
// (a quote opens a value only after `=`), and the index of the `>` that
// ends the tag, or null when the input ends first. First spelling wins.
function readTag (html, from) {
  const attrs = Object.create(null)
  let i = from
  const n = html.length
  while (i < n) {
    const ch = html[i]
    if (ch === '>') return { end: i, attrs }
    if (WS.test(ch) || ch === '/') {
      i++
      continue
    }
    let j = i + 1
    while (j < n && !WS.test(html[j]) && html[j] !== '/' && html[j] !== '>' && html[j] !== '=') j++
    const name = html.slice(i, j).toLowerCase()
    while (j < n && WS.test(html[j])) j++
    let value = ''
    if (html[j] === '=') {
      j++
      while (j < n && WS.test(html[j])) j++
      const q = html[j]
      if (q === '"' || q === "'") {
        const close = html.indexOf(q, j + 1)
        if (close === -1) return null
        value = html.slice(j + 1, close)
        j = close + 1
      } else {
        const start = j
        while (j < n && !WS.test(html[j]) && html[j] !== '>') j++
        value = html.slice(start, j)
      }
    }
    if (!(name in attrs)) attrs[name] = value
    i = j
  }
  return null
}

// The index just past the end tag `</name ...>` at or after `from`, and
// where that end tag starts; null when there is none.
function endTag (html, name, from) {
  const re = new RegExp('</' + name + '(?=[\\s/>])', 'gi')
  re.lastIndex = from
  const m = re.exec(html)
  if (m === null) return null
  const gt = html.indexOf('>', re.lastIndex)
  return gt === -1 ? null : { start: m.index, next: gt + 1 }
}

// The raw metadata of `html`: { title, ogTitle, ogDesc, desc, ogImage }, each
// the first usable value of its key (raw text, or a resolved image URL).
function scan (html, base) {
  const found = Object.create(null)
  const keep = (key, raw, max) => {
    if (found[key] === undefined && ogText(raw, max) !== '') found[key] = raw
  }
  let i = 0
  let templates = 0
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt === -1) break
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      if (end === -1) break
      i = end + 3
      continue
    }
    TAG_NAME_RE.lastIndex = lt
    const m = TAG_NAME_RE.exec(html)
    if (m === null) {
      const next = html[lt + 1]
      // `<!x>`, `<?x>` and `</3>` are bogus comments up to the next `>`.
      if (next === '!' || next === '?' || next === '/') {
        const gt = html.indexOf('>', lt + 2)
        if (gt === -1) break
        i = gt + 1
      } else {
        i = lt + 1
      }
      continue
    }
    const tag = readTag(html, TAG_NAME_RE.lastIndex)
    if (tag === null) break
    i = tag.end + 1
    const closing = m[1] === '/'
    const name = m[2].toLowerCase()
    if (name === 'template') {
      templates = Math.max(0, templates + (closing ? -1 : 1))
      continue
    }
    if (closing) continue
    if (SKIPPED.includes(name) || name === 'title') {
      // Raw text and RCDATA: only the matching end tag ends them.
      const end = endTag(html, name, i)
      if (end === null) break
      if (name === 'title' && templates === 0) keep('title', html.slice(i, end.start), MAX_CARD_TITLE)
      i = end.next
      continue
    }
    if (templates > 0 || name !== 'meta') continue
    const a = tag.attrs
    const key = decodeEntities(a.property || a.name || '').trim().toLowerCase()
    const content = a.content
    if (typeof content !== 'string') continue
    if (key === 'og:title') keep('ogTitle', content, MAX_CARD_TITLE)
    else if (key === 'og:description') keep('ogDesc', content, MAX_CARD_DESC)
    else if (key === 'description') keep('desc', content, MAX_CARD_DESC)
    else if (key === 'og:image' && found.ogImage === undefined) {
      const url = ogImageUrl(content, base)
      if (url !== null) found.ogImage = url
    }
  }
  return found
}

// The card fields of a page read from `html` at `pageUrl` (the URL it was
// fetched from, after redirects): { title, desc, imageUrl }. `title` is
// og:title, else <title>; `desc` og:description, else meta description;
// both '' when absent. `imageUrl` is the resolved og:image or null.
function parseOg (html, pageUrl) {
  try {
    if (typeof html !== 'string') return { title: '', desc: '', imageUrl: null }
    const found = scan(html.slice(0, MAX_OG_HTML), typeof pageUrl === 'string' ? pageUrl : null)
    return {
      title: ogText(found.ogTitle ?? found.title ?? '', MAX_CARD_TITLE),
      desc: ogText(found.ogDesc ?? found.desc ?? '', MAX_CARD_DESC),
      imageUrl: found.ogImage ?? null
    }
  } catch {
    return { title: '', desc: '', imageUrl: null }
  }
}

module.exports = { MAX_OG_HTML, parseOg, ogText, ogImageUrl, decodeEntities }
