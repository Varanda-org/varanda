'use strict'

// Static files of the web export (--ui). The URL path is decoded once; NUL,
// backslashes and any segment starting with '.' ('..', dotfiles) are refused;
// the target is realpathed and must stay inside the realpath of the root (a
// symlink out of the root is refused). An extensionless path that is not a
// file falls back to index.html (SPA). No directory listings.

const fs = require('node:fs')
const path = require('node:path')

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
}

function contentType (file) {
  return TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream'
}

function inside (root, real) {
  return real === root || real.startsWith(root + path.sep)
}

// A regular file inside root, by realpath -> its real path, else null.
async function realFile (root, target) {
  let real
  try {
    real = await fs.promises.realpath(target)
  } catch {
    return { real: null, missing: true }
  }
  if (!inside(root, real)) return { real: null, missing: false }
  let stat
  try {
    stat = await fs.promises.stat(real)
  } catch {
    return { real: null, missing: true }
  }
  return stat.isFile() ? { real, missing: false } : { real: null, missing: true, directory: stat.isDirectory() }
}

// URL (request target) -> the decoded path segments, or null when refused.
function segmentsOf (url) {
  if (typeof url !== 'string' || !url.startsWith('/')) return null
  const raw = url.split('?')[0].split('#')[0]
  let decoded
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return null
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null
  const segments = decoded.split('/').filter((s) => s.length > 0)
  if (segments.some((s) => s.startsWith('.'))) return null
  return segments
}

// -> { file, type } or null (404).
async function resolveStatic (root, url) {
  const segments = segmentsOf(url)
  if (segments === null) return null
  const index = async () => {
    const r = await realFile(root, path.join(root, 'index.html'))
    return r.real === null ? null : { file: r.real, type: contentType(r.real) }
  }
  if (segments.length === 0) return index()
  const target = path.join(root, ...segments)
  const r = await realFile(root, target)
  if (r.real !== null) return { file: r.real, type: contentType(r.real) }
  // Escaped the root (symlink): refused, never a fallback.
  if (!r.missing) return null
  if (path.extname(segments[segments.length - 1]) === '') return index()
  return null
}

module.exports = { resolveStatic, segmentsOf, contentType }
