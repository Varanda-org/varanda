'use strict'

const { displayText } = require('@varanda/rpc')

const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']
const LABELS = { g: 'Grupo', c: 'Comunidade', m: 'Perfil', u: 'Perfil' }

function cleanCut (value, max) {
  if (typeof value !== 'string') return ''
  const head = Array.from(value.slice(0, max * 2)).slice(0, max).join('')
  return displayText(head, { multiline: false }).replace(/\uFFFD/g, '').trim()
}

function escapeHtml (value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function meta (attr, key, value) {
  return '<meta ' + attr + '="' + key + '" content="' + escapeHtml(value) + '">\n'
}

function isPlainObject (value) {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

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

function appPath (kind, id) {
  if (typeof id !== 'string') return ''
  if (kind === 'u') {
    const username = id.toLowerCase()
    return /^[a-z][a-z0-9_]{2,19}$/.test(username) && !/^[0-9a-f]{6}$/.test(username) ? '/@' + username : ''
  }
  return ['g', 'c', 'm'].includes(kind) && /^[0-9a-f]{64}$/.test(id) ? '/' + kind + '/' + id : ''
}

function render (origin, kind, path, data) {
  const label = LABELS[kind] || 'Perfil'
  const publicData = path !== '' && isPlainObject(data)
  const name = publicData ? cleanCut(data.name, 80) : ''
  const title = (name || label) + ' na Varanda'
  const category = kind === 'g' || kind === 'c' ? label : 'Página'
  let description = label + ' na Varanda. Abra a Varanda para ver mais.'
  let mime = ''
  if (publicData) {
    description = category + ' na Varanda.'
    if (kind === 'm' || kind === 'u') {
      const username = appPath('u', data.username)
      if (username) description = 'Página ' + username.slice(1) + ' na Varanda.'
      const bio = cleanCut(data.bio, 200)
      if (bio) description = cleanCut(description + ' ' + bio, 200)
    } else {
      const about = cleanCut(data.about, 200)
      if (about) description = about
    }
    const image = kind === 'g' || kind === 'c' ? data.image : data.avatar
    if (isPlainObject(image) && IMAGE_MIMES.includes(image.mime)) mime = cleanCut(image.mime, 80)
  }
  let head = '<title>' + escapeHtml(title) + '</title>\n' +
    meta('name', 'description', description) +
    meta('name', 'robots', 'noindex') +
    meta('property', 'og:title', title) +
    meta('property', 'og:description', description) +
    meta('property', 'og:type', 'website') +
    meta('property', 'og:site_name', 'Varanda') +
    meta('name', 'twitter:card', mime ? 'summary' : 'summary_large_image')
  if (origin !== '') {
    if (publicData) head += meta('property', 'og:url', origin + path)
    head += meta('property', 'og:image', origin + (mime ? '/p' + path + '/imagem' : '/og/convite.png')) +
      meta('property', 'og:image:type', mime || 'image/png') +
      meta('property', 'og:image:width', mime ? '512' : '1200') +
      meta('property', 'og:image:height', mime ? '512' : '630') +
      meta('property', 'og:image:alt', mime ? title : 'Varanda')
  }
  const link = publicData ? origin + path : '/'
  return '<!doctype html>\n<html lang="pt-BR">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' + head +
    '</head>\n<body>\n<h1>' + escapeHtml(title) + '</h1>\n<p>' + escapeHtml(description) + '</p>\n' +
    '<p><a href="' + escapeHtml(link) + '">Ver na Varanda</a></p>\n</body>\n</html>\n'
}

function renderLinkPage (args) {
  let origin = ''
  let kind = 'm'
  try {
    if (!isPlainObject(args)) return render(origin, kind, '', null)
    origin = httpsOrigin(args.origin)
    if (['g', 'c', 'm', 'u'].includes(args.kind)) kind = args.kind
    return render(origin, kind, appPath(args.kind, args.id), args.data)
  } catch {
    // Even malformed peer objects must reveal no target or failure reason.
    return render(origin, kind, '', null)
  }
}

module.exports = { renderLinkPage }
