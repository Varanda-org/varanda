'use strict'

// The public HTML page of one Feira listing (/f/<author>/<seq>), its generic
// not-found page and the sitemap. Everything in `view` comes from a peer's
// diary through the seeder (listingPublic hands back raw record text), so every
// string is stripped of unsafe code points and HTML-escaped here. The page has
// no script and no external resource: the site CSP allows only same-origin
// images and inline styles. Pure, never throws.

const { displayText, clipText } = require('@varanda/rpc')

const MAX_PHOTOS = 4
const OG_DESCRIPTION_MAX = 160
const INDEXED_STATUSES = ['disponivel', 'reservado']
const PHOTO_PATH = /^\/f\/[0-9a-f]{64}\/[1-9][0-9]{0,15}\/foto\/[0-9]{1,2}$/
// The installed app's own link to the listing. iOS keeps a tap on a link of
// the same host (the enter button's /anuncio/) in Safari, so a universal
// link never opens the app from this page; this custom-scheme link does,
// and only in exactly this shape.
const APP_URL = /^varanda:\/\/\/anuncio\/[0-9a-f]{64}\/[1-9][0-9]{0,15}$/

// displayText marks every unsafe code point with U+FFFD; a public page drops
// them instead, so a hostile title cannot fill the card with marks.
function clean (value, multiline) {
  if (typeof value !== 'string') return ''
  return displayText(value, { multiline: multiline === true }).replace(/\uFFFD/g, '')
}

function esc (value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

// An absolute http(s) URL or a same-origin path; anything else (javascript:,
// protocol-relative, whitespace) is dropped rather than rendered.
function safeUrl (value) {
  const v = clean(value, false)
  if (v === '' || /\s/.test(v)) return ''
  if (/^https?:\/\/[^/]/i.test(v)) return v
  if (v[0] === '/' && v[1] !== '/' && v[1] !== '\\') return v
  return ''
}

function isPhotoPath (value) {
  return typeof value === 'string' && PHOTO_PATH.test(value)
}

function originOf (pageUrl) {
  try {
    if (!/^https?:\/\//i.test(pageUrl)) return ''
    return new URL(pageUrl).origin
  } catch {
    return ''
  }
}

const STYLE = 'body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#faf7f2;color:#1f1b16;line-height:1.5}' +
  'main{max-width:640px;margin:0 auto;padding:24px 16px}' +
  'h1{font-size:1.5rem;margin:8px 0}' +
  '.kicker{font-size:.85rem;text-transform:uppercase;letter-spacing:.05em;color:#6b5f52;margin:0}' +
  '.price{font-size:1.25rem;font-weight:600;margin:4px 0}' +
  '.meta{color:#6b5f52;margin:4px 0}' +
  '.badge{display:inline-block;padding:2px 10px;border-radius:999px;background:#1f1b16;color:#faf7f2;font-size:.85rem;margin:4px 0}' +
  '.photos{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;margin:16px 0}' +
  '.photos img{width:100%;height:auto;border-radius:8px;background:#eee}' +
  '.text{white-space:pre-line;margin:16px 0}' +
  '.seller{margin:16px 0}' +
  '.enter{display:inline-block;padding:12px 20px;border-radius:999px;background:#2f6b3a;color:#fff;text-decoration:none;font-weight:600}' +
  '.note{color:#6b5f52;font-size:.9rem;margin-top:16px}' +
  '@media (prefers-color-scheme:dark){body{background:#16130f;color:#f2ece4}.kicker,.meta,.note{color:#b3a796}.badge{background:#f2ece4;color:#16130f}}'

function shell (head, body) {
  return '<!doctype html>\n<html lang="pt-BR">\n<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    head +
    '<style>' + STYLE + '</style>\n' +
    '</head>\n<body>\n<main>\n' + body + '</main>\n</body>\n</html>\n'
}

function badgeFor (view) {
  if (view.status === 'reservado' || view.status === 'vendido') {
    const label = clean(view.statusLabel, false)
    if (label !== '') return label
    if (view.status === 'reservado') return 'Reservado'
    return view.kind === 'procura' ? 'Encontrado' : 'Vendido'
  }
  return ''
}

function placeOf (view) {
  const city = clean(view.city, false)
  const uf = clean(view.uf, false)
  const bairro = clean(view.bairro, false)
  let place = city
  if (uf !== '') place = place === '' ? uf : place + '/' + uf
  if (bairro !== '') place = place === '' ? bairro : bairro + ', ' + place
  return place
}

function renderListingPage (view) {
  try {
    if (view === null || typeof view !== 'object') return null
    const procura = view.kind === 'procura'
    const title = clean(view.title, false)
    const body = clean(view.text, true)
    const price = clean(view.priceLabel, false)
    const place = placeOf(view)
    const cat = clean(view.catLabel, false)
    const name = clean(view.name, false)
    const username = clean(view.username, false)
    const badge = badgeFor(view)
    const pageUrl = safeUrl(view.pageUrl)
    const enterUrl = safeUrl(view.enterUrl)
    const appUrl = typeof view.appUrl === 'string' && APP_URL.test(view.appUrl) ? view.appUrl : ''
    const photos = (Array.isArray(view.photoUrls) ? view.photoUrls : []).filter(isPhotoPath).slice(0, MAX_PHOTOS)

    const indexed = INDEXED_STATUSES.includes(view.status)
    const description = [price, place, clipText(body.replace(/\s+/g, ' ').trim(), OG_DESCRIPTION_MAX)]
      .filter((s) => s !== '').join(' · ')
    const ogTitle = (procura ? 'Procura-se: ' : '') + title

    let head = '<title>' + esc(ogTitle) + ' | Feira Varanda</title>\n' +
      '<meta name="robots" content="' + (indexed ? 'index,follow' : 'noindex,follow') + '">\n' +
      '<meta name="description" content="' + esc(description) + '">\n' +
      '<meta property="og:type" content="website">\n' +
      '<meta property="og:title" content="' + esc(ogTitle) + '">\n' +
      '<meta property="og:description" content="' + esc(description) + '">\n'
    if (pageUrl !== '') {
      head += '<link rel="canonical" href="' + esc(pageUrl) + '">\n' +
        '<meta property="og:url" content="' + esc(pageUrl) + '">\n'
    }
    if (photos.length > 0 && view.photoUrls[0] === photos[0]) {
      head += '<meta property="og:image" content="' + esc(originOf(pageUrl) + photos[0]) + '">\n'
    }

    let html = '<p class="kicker">Feira' + (cat !== '' ? ' · ' + esc(cat) : '') + '</p>\n' +
      '<h1>' + esc(ogTitle) + '</h1>\n'
    if (badge !== '') html += '<p class="badge">' + esc(badge) + '</p>\n'
    if (price !== '') html += '<p class="price">' + esc(price) + '</p>\n'
    if (place !== '') html += '<p class="meta">' + esc(place) + '</p>\n'
    if (photos.length > 0) {
      html += '<div class="photos">\n'
      photos.forEach((src, i) => {
        html += '<img src="' + esc(src) + '" alt="' + esc('Foto ' + (i + 1) + ' de ' + title) + '" loading="lazy">\n'
      })
      html += '</div>\n'
    }
    if (body !== '') html += '<p class="text">' + esc(body) + '</p>\n'
    if (name !== '' || username !== '') {
      const who = [name, username !== '' ? '@' + username : ''].filter((s) => s !== '').join(' ')
      html += '<p class="seller">' + (procura ? 'Quem procura: ' : 'Quem anuncia: ') + esc(who) + '</p>\n'
    }
    if (enterUrl !== '') {
      html += '<p><a class="enter" href="' + esc(enterUrl) + '">' +
        (procura ? 'Entrar para oferecer' : 'Entrar para conversar') + '</a></p>\n'
    }
    if (appUrl !== '') html += '<p><a class="app" href="' + esc(appUrl) + '">Já tem o app? Abrir no app</a></p>\n'
    html += '<p class="note">O pagamento é combinado entre vocês, fora do aplicativo.</p>\n'
    return shell(head, html)
  } catch {
    return null
  }
}

const NOT_FOUND = shell(
  '<title>Anúncio não encontrado | Feira Varanda</title>\n<meta name="robots" content="noindex,follow">\n',
  '<h1>Anúncio não encontrado</h1>\n<p>Este anúncio não existe ou não está mais disponível.</p>\n'
)

function renderNotFound () {
  return NOT_FOUND
}

function renderSitemap (urls) {
  let out = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
  try {
    if (Array.isArray(urls)) {
      for (const url of urls) {
        const loc = clean(url, false)
        if (loc !== '') out += '<url><loc>' + esc(loc) + '</loc></url>\n'
      }
    }
  } catch {}
  return out + '</urlset>\n'
}

module.exports = { renderListingPage, renderNotFound, renderSitemap, MAX_PHOTOS }
