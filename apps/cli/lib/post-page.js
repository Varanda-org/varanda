'use strict'

// The public HTML page of one shared diary post (/p/<author>/<seq>), for
// people without an account, drawn as one timeline row of A Rua with the
// app's metrics and its light and dark palettes, so a shared link looks like
// the feed it came from. The avatar is an initials disc drawn from the name,
// never the profile photo. The icons and the two dimmed rows under the button
// are drawings, not controls or posts: nothing on the page but the one anchor
// does anything. Everything in `record`, `name` and `username`
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
// apps/app/src/who.js AT_SIGNS and INVISIBLE: '@', FULLWIDTH and SMALL
// COMMERCIAL AT, and Unicode's Default_Ignorable_Code_Point set as ranges.
// cleanCut keeps these (zero-width space, soft hyphen, Hangul filler), and
// one of them must never become an initial or an empty-looking disc.
const AT_SIGNS = [0x40, 0xff20, 0xfe6b]
const INVISIBLE = [
  [0x00ad, 0x00ad], [0x034f, 0x034f], [0x061c, 0x061c], [0x115f, 0x1160],
  [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200f], [0x202a, 0x202e],
  [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff],
  [0xffa0, 0xffa0], [0xfff0, 0xfff8], [0x1bca0, 0x1bca3], [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff]
]

// Feather v4.29.2 (github.com/feathericons/feather): the glyphs the app draws
// through @expo/vector-icons (apps/app/src/ui/Icon.js), inlined so the row
// matches the app without loading anything. Upstream license:
//
// The MIT License (MIT)
//
// Copyright (c) 2013-2023 Cole Bemis
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
function glyph (inner) {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>'
}
const ICON_REPLY = glyph('<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>')
const ICON_REPOST = glyph('<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>')
const ICON_LIKE = glyph('<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>')
const ICON_MORE = glyph('<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>')
const ICON_LINK = glyph('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>')
const ICON_PLAY = glyph('<polygon points="5 3 19 12 5 21 5 3"/>')
const ICON_USER = glyph('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>')

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

// Palettes from apps/app/src/appearance.js (the dark block follows the
// visitor's system, as the app's "Sistema" mode does), avatar stripes from
// ui/theme.js and row metrics from ui/PostLinkPreviewRow.js. Identical on
// every page, so it never carries peer data.
const STYLE = ':root{--bg:#fbf8f3;--card:#ffffff;--ink:#1f2a24;--soft:#4a554e;--line:rgba(31,42,36,0.10);' +
    '--pillBg:#1d6b4f;--pillInk:#ffffff;--skeleton:rgba(31,42,36,0.08);--disc:#1f2a24;--discInk:#ffffff}' +
  '@media (prefers-color-scheme: dark){:root{--bg:#101010;--card:#1c1c1c;--ink:#f5f5f5;--soft:#c8c8c8;--line:rgba(245,245,245,0.14);' +
    '--pillBg:#5dcaa0;--pillInk:#10241c;--skeleton:rgba(245,245,245,0.10);--disc:#f5f5f5;--discInk:#101010}}' +
  'html{scroll-padding-top:80px;-webkit-text-size-adjust:100%;text-size-adjust:100%}' +
  'body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--ink)}' +
  'p,h1{margin:0}' +
  'svg{display:block;flex:none;width:20px;height:20px}' +
  '.bar{position:sticky;top:0;z-index:1;background:var(--bg)}' +
  '.brand{box-sizing:border-box;max-width:640px;min-height:64px;margin:0 auto;padding:0 16px;display:flex;align-items:center;' +
    'font-family:ui-rounded,"SF Pro Rounded",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:24px;line-height:32px;font-weight:600;letter-spacing:-.24px}' +
  'main{max-width:640px;margin:0 auto;padding-bottom:24px}' +
  'main>h1{font-size:20px;line-height:28px;font-weight:600;padding:8px 16px 12px;overflow-wrap:anywhere}' +
  'main>p{padding:12px 16px}' +
  '.row,.sk{display:flex;gap:12px;padding:16px 16px 6px;border-bottom:1px solid var(--line)}' +
  '.avatar{flex:none;width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;overflow:hidden;' +
    'font-size:14px;line-height:1;font-weight:700;white-space:nowrap}' +
  '.a0{background:#2576b0;color:#ffffff}.a1{background:#e8805a;color:#1f2a24}.a2{background:#f2b705;color:#1f2a24}' +
  '.a3{background:#c23528;color:#ffffff}.a4{background:#1d6b4f;color:#ffffff}' +
  '.body{flex:1;min-width:0;position:relative}' +
  '.head{display:flex;flex-wrap:wrap;align-items:baseline;padding-right:44px}' +
  '.head h1{font-size:15px;line-height:20px;font-weight:600;margin-right:6px;overflow-wrap:anywhere;min-width:0}' +
  '.meta,.dot{font-size:13px;line-height:18px;color:var(--soft);overflow-wrap:anywhere;min-width:0}' +
  '.dot{margin:0 4px}.dot+.meta{white-space:nowrap}' +
  '.more{position:absolute;top:-12px;right:0;width:44px;height:44px;display:flex;align-items:center;justify-content:center;color:var(--soft)}' +
  '.label{display:flex;align-items:center;min-height:44px;font-size:13px;line-height:18px;font-weight:600;color:var(--soft)}' +
  '.more+.label{display:block;min-height:0;margin-top:2px;font-weight:400}' +
  '.text{margin-top:3px;font-size:15.5px;line-height:21px;white-space:pre-wrap;overflow-wrap:anywhere}' +
  '.photos{position:relative;margin-top:8px;display:grid;grid-template-columns:1fr 1fr;gap:4px}' +
  '.photos img{display:block;width:100%;height:auto;aspect-ratio:1;object-fit:cover;border-radius:12px;background:var(--skeleton)}' +
  '.photos.n1{grid-template-columns:1fr}.photos.n1 img{aspect-ratio:4/3}' +
  '.play{position:absolute;top:50%;left:50%;width:52px;height:52px;margin:-26px 0 0 -26px;border-radius:50%;' +
    'display:flex;align-items:center;justify-content:center;background:var(--disc);color:var(--discInk);opacity:.85}' +
  '.play svg{width:24px;height:24px}' +
  '.card{box-sizing:border-box;margin-top:8px;min-height:44px;padding:10px 12px;display:flex;flex-direction:column;gap:4px;' +
    'border:1px solid var(--line);border-radius:12px;background:var(--card);overflow-wrap:anywhere}' +
  '.card-title{font-size:15px;line-height:20px;font-weight:700}' +
  '.card-line{display:flex;align-items:center;gap:6px;color:var(--soft)}' +
  '.card-line svg{width:14px;height:14px}' +
  '.card-host{min-width:0;font-size:13px;line-height:18px}' +
  '.actions{display:flex;align-items:center;justify-content:space-between;max-width:360px;margin:0 0 -4px -8px;color:var(--soft)}' +
  '.act{display:flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;padding:0 8px;box-sizing:border-box}' +
  '.join{padding:12px 16px}' +
  '.enter{display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:100%;min-height:44px;padding:12px 20px;' +
    'border-radius:999px;background:var(--pillBg);color:var(--pillInk);text-decoration:none;font-size:15px;line-height:18px;font-weight:600}' +
  '.enter:focus-visible{outline:3px solid var(--ink);outline-offset:3px}' +
  '.note{margin-top:12px;font-size:13px;line-height:18px;color:var(--soft);text-align:center}' +
  '.sk{opacity:.45;padding-bottom:50px}' +
  '.sk-avatar{flex:none;width:40px;height:40px;border-radius:50%;background:var(--skeleton)}' +
  '.sk-body{flex:1;min-width:0}' +
  '.sk-head{display:flex;align-items:center;gap:8px;min-height:20px;padding-right:44px}' +
  '.sk-bar{height:12px;border-radius:6px;background:var(--skeleton)}' +
  '.sk-name{width:34%}.sk-handle{width:22%}' +
  '.sk-lines{display:flex;flex-direction:column;gap:8px;margin-top:8px}' +
  '.sk-w1{width:92%}.sk-w2{width:84%}.sk-w3{width:56%}' +
  '.sk-media{margin-top:10px;width:100%;aspect-ratio:4/3;border-radius:12px;background:var(--skeleton)}' +
  // At 375 px with 200% zoom the 44 px kept for the "more" drawing left the
  // name about 60 px and broke it mid-word; the drawing is not a control.
  '@media (max-width:300px){.head,.sk-head{padding-right:0}.more{display:none}}'

// A peer-free stand-in row under the post (the app's dimmed skeleton rows).
const SKELETON = '<div class="sk" aria-hidden="true"><div class="sk-avatar"></div><div class="sk-body">' +
  '<div class="sk-head"><div class="sk-bar sk-name"></div><div class="sk-bar sk-handle"></div></div>' +
  '<div class="sk-lines"><div class="sk-bar sk-w1"></div><div class="sk-bar sk-w2"></div><div class="sk-bar sk-w3"></div></div>' +
  '<div class="sk-media"></div></div></div>\n'

function shell (head, body) {
  return '<!doctype html>\n<html lang="pt-BR">\n<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<meta name="color-scheme" content="light dark">\n' +
    '<meta name="robots" content="noindex, nofollow, noarchive">\n' +
    head +
    '<style>' + STYLE + '</style>\n' +
    '</head>\n<body>\n<header class="bar"><p class="brand">Varanda</p></header>\n<main>\n' + body + '</main>\n</body>\n</html>\n'
}

// A bad author or seq never reaches a path: the page only points at the app.
const FALLBACK = shell(
  '<title>Publicação na Varanda</title>\n',
  '<h1>Publicação na Varanda</h1>\n' +
  '<p><a class="enter" href="/">Ver na Varanda</a></p>\n'
)

function invisible (cp) {
  return /\s/.test(String.fromCodePoint(cp)) || INVISIBLE.some(([from, to]) => cp >= from && cp <= to)
}

// who.js displayName: without the leading run of at-signs and invisibles (so
// '@alice' never draws as an '@'), or '' when nothing visible remains.
function displayName (s) {
  const chars = Array.from(s)
  let i = 0
  while (i < chars.length) {
    const cp = chars[i].codePointAt(0)
    if (!AT_SIGNS.includes(cp) && !invisible(cp)) break
    i++
  }
  const rest = chars.slice(i)
  if (!rest.some((ch) => !invisible(ch.codePointAt(0)))) return ''
  return rest.join('').trim()
}

// The name the disc is drawn from, else the username, by the same rule.
function initialsSource (name, username) {
  const shown = displayName(name)
  return shown !== '' ? shown : displayName(username)
}

// apps/app/src/ui/Avatar.js initialsFromName: the first letter of the first
// and last word, or two letters of a single word; '' when nothing is left.
// Letters are visible code points only, so an invisible inside the name is
// never an initial.
function initialsOf (source) {
  const words = source.split(/\s+/)
    .map((w) => Array.from(w).filter((ch) => !invisible(ch.codePointAt(0))))
    .filter((w) => w.length > 0)
  let raw = ''
  if (words.length >= 2) raw = words[0][0] + words[words.length - 1][0]
  else if (words.length === 1) raw = words[0].slice(0, 2).join('')
  return raw.toLocaleUpperCase('pt-BR')
}

// The stripe class comes from the validated hex key (format.js avatarColorOf)
// and is never an inline style.
function avatarHtml (author, name, username) {
  const stripe = parseInt(author.slice(0, 2), 16) % 5
  const initials = initialsOf(initialsSource(name, username))
  return '<div class="avatar a' + stripe + '" aria-hidden="true">' + (initials !== '' ? esc(initials) : ICON_USER) + '</div>\n'
}

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

  let html = '<article class="row">\n' + avatarHtml(author, name, username) +
    '<div class="body">\n<div class="head">\n'
  if (name !== '') html += '<h1>' + esc(name) + '</h1>\n'
  else if (username !== '') html += '<h1>@' + esc(username) + '</h1>\n'
  else html += '<h1>Publicação na Varanda</h1>\n'
  if (name !== '' && username !== '') html += '<p class="meta">@' + esc(username) + '</p>\n'
  if (date !== '') html += '<span class="dot" aria-hidden="true">·</span>\n<p class="meta">' + esc(date) + '</p>\n'
  html += '</div>\n<span class="more" aria-hidden="true">' + ICON_MORE + '</span>\n'

  if (isPlainObject(post.quote)) html += '<p class="label">Cita outra publicação</p>\n'
  else if (isPlainObject(post.replyTo)) html += '<p class="label">Em resposta a outra publicação</p>\n'

  if (text !== '') html += '<p class="text">' + esc(text) + '</p>\n'

  if (photos.items.length > 0) {
    html += '<div class="photos n' + photos.items.length + '">\n'
    for (let i = 1; i <= photos.items.length; i++) {
      const alt = photos.video ? 'Capa do vídeo' : 'Foto ' + i
      html += '<img src="' + esc(base + '/foto/' + i) + '" alt="' + esc(alt) + '" loading="lazy">\n'
    }
    if (photos.video) html += '<span class="play" aria-hidden="true">' + ICON_PLAY + '</span>\n'
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
      if (host !== '') html += '<span class="card-line">' + ICON_LINK + '<span class="card-host">' + esc(host) + '</span></span>'
      html += '</p>\n'
    }
  }

  html += '<div class="actions" aria-hidden="true"><span class="act">' + ICON_REPLY + '</span><span class="act">' + ICON_REPOST +
    '</span><span class="act">' + ICON_LIKE + '</span></div>\n</div>\n</article>\n'

  html += '<div class="join">\n<p><a class="enter" href="' + esc(appPath) + '">Ver na Varanda</a></p>\n' +
    '<p class="note">Para ver mais, entre ou crie sua conta. Pode ser preciso um convite.</p>\n</div>\n' +
    SKELETON + SKELETON
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

// postPreviewData({ record, name, username }) -> the JSON twin of the page
// for the app before sign-in (/p/<D>/<seq>/previa), or null. Exactly what
// render() shows, cleaned and capped as it does but not HTML-escaped (the
// app draws text, never markup): name and username null when the page
// leaves them out, text and date '' when absent, card null or
// { title, host } with at least one non-empty. It carries no URL, key,
// count, timestamp or media descriptor: the photos are only counted.
// Pure, never throws.
function postPreviewData (args) {
  try {
    if (!isPlainObject(args)) return null
    const post = isPlainObject(args.record) ? args.record : {}
    const name = cleanCut(args.name, MAX_NAME_CHARS, false).trim()
    const username = cleanCut(args.username, MAX_USERNAME_CHARS, false).trim()
    const photos = postPhotos(post)
    let relation = null
    if (isPlainObject(post.quote)) relation = 'quote'
    else if (isPlainObject(post.replyTo)) relation = 'reply'
    let card = null
    if (isPlainObject(post.preview)) {
      const title = cleanCut(post.preview.title, MAX_CARD_CHARS, false).trim()
      const host = cleanCut(post.preview.host, MAX_CARD_CHARS, false).trim()
      if (title !== '' || host !== '') card = { title, host }
    }
    return {
      v: 1,
      name: name !== '' ? name : null,
      username: username !== '' ? username : null,
      date: dateOf(post.at),
      text: cleanCut(post.text, MAX_TEXT_CHARS, true),
      photoCount: photos.items.length,
      morePhotos: photos.more,
      video: photos.video,
      relation,
      card
    }
  } catch {
    return null
  }
}

module.exports = { renderPostPage, postPreviewData, postPhotos, MAX_PHOTOS }
