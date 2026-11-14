'use strict'

// The public HTML page of one shared diary post (/p/<author>/<seq>), for
// people without an account. Everything in `record`, `name` and `username`
// comes from a peer's diary through the seeder, so every string is stripped
// of unsafe code points and HTML-escaped here. The page is served on the
// installation's own origin: it has no script, no external resource, no
// inline handler and exactly one anchor (back into the app). Pure, never
// throws: a malformed field renders as absent.

const { displayText } = require('@varanda/rpc')

const MAX_PHOTOS = 4
// packages/core/lib/records.js MAX_MEDIA_PER_POST: a longer list is not a
// valid post, so it renders as no media at all.
const MAX_MEDIA_ITEMS = 10
const OG_DESCRIPTION_MAX = 200
// Caps far above what records.js accepts (text 1000, names far less), so a
// hostile caller cannot make the page huge.
const MAX_TEXT_CHARS = 1000
const MAX_NAME_CHARS = 80
const MAX_USERNAME_CHARS = 40
const MAX_CARD_CHARS = 300
const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
const VIDEO_MIME = 'video/mp4'
const HEX64 = /^[0-9a-f]{64}$/
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/

// Same behaviour as feira-page.js clean: displayText marks every unsafe code
// point with U+FFFD and a public page drops them instead.
function clean (value, multiline) {
  if (typeof value !== 'string') return ''
  return displayText(value, { multiline: multiline === true }).replace(/\uFFFD/g, '')
}

function esc (value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

// First `max` code points. The UTF-16 slice first keeps the work bounded on a
// huge string; a surrogate pair it splits leaves a lone surrogate, which
// clean() drops.
function cut (value, max) {
  if (typeof value !== 'string') return ''
  const head = value.length > max * 2 ? value.slice(0, max * 2) : value
  const chars = Array.from(head)
  return chars.length > max ? chars.slice(0, max).join('') : head
}

function cleanCut (value, max, multiline) {
  return clean(cut(value, max), multiline)
}

function isPlainObject (v) {
  if (v === null || typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function mimeOf (item) {
  return isPlainObject(item) && typeof item.mime === 'string' ? item.mime : ''
}

// The photos the page shows, in the order the /p/<author>/<seq>/foto/<i>
// route must serve them (i = 1..items.length): the record's image items in
// media order. A video post shows only its cover (its first image, the JPEG
// poster records.js puts at media[0]) and never counts extra photos.
// Returns { items, more, video }. Never throws.
function postPhotos (record) {
  const none = { items: [], more: 0, video: false }
  try {
    if (!isPlainObject(record)) return none
    const media = record.media
    if (!Array.isArray(media) || media.length < 1 || media.length > MAX_MEDIA_ITEMS) return none
    const images = []
    let video = false
    for (let i = 0; i < media.length; i++) {
      const mime = mimeOf(media[i])
      if (mime === VIDEO_MIME) video = true
      else if (IMAGE_MIMES.includes(mime)) images.push(media[i])
    }
    if (video) return { items: images.slice(0, 1), more: 0, video: true }
    return { items: images.slice(0, MAX_PHOTOS), more: Math.max(0, images.length - MAX_PHOTOS), video: false }
  } catch {
    return none
  }
}

// 'dd/mm/aaaa' in Brasília time (UTC-3, no DST), as the app's scheduleDate
// (apps/app/src/accountDeletion.js) tells dates; '' for anything else.
function dateOf (at) {
  if (typeof at !== 'string' || !ISO_DATE.test(at)) return ''
  const ms = Date.parse(at)
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms - 3 * 3600 * 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return pad(d.getUTCDate()) + '/' + pad(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear()
}

// The origin og:image is built on: a bare https origin, or '' (no og:image).
function httpsOrigin (origin) {
  try {
    if (typeof origin !== 'string' || !/^https:\/\/[^/\s]/i.test(origin) || /\s/.test(origin)) return ''
    const u = new URL(origin)
    if (u.protocol !== 'https:' || u.username !== '' || u.password !== '') return ''
    if (u.pathname !== '/' || u.search !== '' || u.hash !== '') return ''
    return u.origin
  } catch {
    return ''
  }
}

function validTarget (author, seq) {
  return typeof author === 'string' && HEX64.test(author) && Number.isSafeInteger(seq) && seq >= 1
}

const STYLE = 'body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#faf7f2;color:#1f1b16;line-height:1.5}' +
  'main{max-width:640px;margin:0 auto;padding:24px 16px}' +
  'h1{font-size:1.5rem;margin:8px 0;overflow-wrap:anywhere}' +
  '.kicker{font-size:.85rem;text-transform:uppercase;letter-spacing:.05em;color:#6b5f52;margin:0}' +
  '.meta{color:#6b5f52;margin:4px 0;overflow-wrap:anywhere}' +
  '.label{color:#6b5f52;font-size:.9rem;margin:12px 0}' +
  '.photos{display:grid;grid-template-columns:1fr;gap:8px;margin:16px 0}' +
  '.photos img{display:block;width:100%;height:auto;border-radius:8px;background:#eee}' +
  '.text{white-space:pre-wrap;overflow-wrap:anywhere;margin:16px 0}' +
  '.card{border:1px solid #e4dccf;border-radius:8px;padding:12px;margin:16px 0;overflow-wrap:anywhere}' +
  '.card-title{display:block;font-weight:600}' +
  '.card-host{display:block;color:#6b5f52;font-size:.9rem}' +
  '.enter{display:inline-block;box-sizing:border-box;min-height:44px;min-width:44px;padding:12px 20px;border-radius:999px;background:#2f6b3a;color:#fff;text-decoration:none;font-weight:600}' +
  '.note{color:#6b5f52;font-size:.9rem;margin-top:16px}'

function shell (head, body) {
  return '<!doctype html>\n<html lang="pt-BR">\n<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<meta name="color-scheme" content="light">\n' +
    '<meta name="robots" content="noindex, nofollow, noarchive">\n' +
    head +
    '<style>' + STYLE + '</style>\n' +
    '</head>\n<body>\n<main>\n' + body + '</main>\n</body>\n</html>\n'
}

// A bad author or seq never reaches a path: the page only points at the app.
const FALLBACK = shell(
  '<title>Publicação na Varanda</title>\n',
  '<h1>Publicação na Varanda</h1>\n' +
  '<p><a class="enter" href="/">Ver na Varanda</a></p>\n'
)

function render (origin, author, seq, record, rawName, rawUsername) {
  const post = isPlainObject(record) ? record : {}
  const name = cleanCut(rawName, MAX_NAME_CHARS, false).trim()
  const username = cleanCut(rawUsername, MAX_USERNAME_CHARS, false).trim()
  const text = cleanCut(post.text, MAX_TEXT_CHARS, true)
  const date = dateOf(post.at)
  const photos = postPhotos(post)
  const base = '/p/' + author + '/' + seq
  const appPath = '/publicacao/' + author + '/' + seq

  const ogTitle = name !== '' ? 'Publicação de ' + name + ' na Varanda' : 'Publicação na Varanda'
  const description = cut(text.replace(/\s+/g, ' ').trim(), OG_DESCRIPTION_MAX)
  const imageOrigin = httpsOrigin(origin)

  let head = '<title>' + esc(ogTitle) + '</title>\n' +
    '<meta property="og:type" content="website">\n' +
    '<meta property="og:title" content="' + esc(ogTitle) + '">\n' +
    '<meta property="og:description" content="' + esc(description) + '">\n'
  if (photos.items.length > 0 && imageOrigin !== '') {
    head += '<meta property="og:image" content="' + esc(imageOrigin + base + '/foto/1') + '">\n'
  }

  let html = '<p class="kicker">Varanda</p>\n'
  if (name !== '') html += '<h1>' + esc(name) + '</h1>\n'
  else if (username !== '') html += '<h1>@' + esc(username) + '</h1>\n'
  else html += '<h1>Publicação na Varanda</h1>\n'
  if (name !== '' && username !== '') html += '<p class="meta">@' + esc(username) + '</p>\n'
  if (date !== '') html += '<p class="meta">' + esc(date) + '</p>\n'

  if (isPlainObject(post.quote)) html += '<p class="label">Cita outra publicação</p>\n'
  else if (isPlainObject(post.replyTo)) html += '<p class="label">Em resposta a outra publicação</p>\n'

  if (text !== '') html += '<p class="text">' + esc(text) + '</p>\n'

  if (photos.items.length > 0) {
    html += '<div class="photos">\n'
    for (let i = 1; i <= photos.items.length; i++) {
      const alt = photos.video ? 'Capa do vídeo' : 'Foto ' + i
      html += '<img src="' + esc(base + '/foto/' + i) + '" alt="' + esc(alt) + '" loading="lazy">\n'
    }
    html += '</div>\n'
  }
  if (photos.video) html += '<p class="label">Vídeo disponível na Varanda</p>\n'
  else if (photos.more > 0) html += '<p class="label">Mais ' + photos.more + (photos.more === 1 ? ' foto' : ' fotos') + ' na Varanda</p>\n'

  if (isPlainObject(post.preview)) {
    const title = cleanCut(post.preview.title, MAX_CARD_CHARS, false).trim()
    const host = cleanCut(post.preview.host, MAX_CARD_CHARS, false).trim()
    if (title !== '' || host !== '') {
      html += '<p class="card">'
      if (title !== '') html += '<span class="card-title">' + esc(title) + '</span>'
      if (host !== '') html += '<span class="card-host">' + esc(host) + '</span>'
      html += '</p>\n'
    }
  }

  html += '<p><a class="enter" href="' + esc(appPath) + '">Ver na Varanda</a></p>\n' +
    '<p class="note">Para ver mais, entre ou crie sua conta. Pode ser preciso um convite.</p>\n'
  return shell(head, html)
}

// renderPostPage({ origin, author, seq, record, name, username }) -> string,
// a full HTML document. `origin` is the installation's https origin (only for
// the absolute og:image); `author` a lowercase hex64 and `seq` a safe integer
// >= 1, else the fallback page that only points at '/'.
function renderPostPage (args) {
  try {
    if (!isPlainObject(args)) return FALLBACK
    const { origin, author, seq, record, name, username } = args
    if (!validTarget(author, seq)) return FALLBACK
    return render(origin, author, seq, record, name, username)
  } catch {
    return FALLBACK
  }
}

module.exports = { renderPostPage, postPhotos, MAX_PHOTOS }
