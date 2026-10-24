'use strict'

// Finishes the web export after `expo export --platform web`: renders the
// service worker template (scripts/sw.js) into dist/sw.js with this release's
// id and precache list, and marks dist/index.html with the same release id
// (<meta name="varanda-release">) so the worker can refuse an index.html
// from another release while it installs.
// Usage: node scripts/finish-web.js [dist] -> prints one summary line, exit 0/1.
// Running it twice on the same dist yields byte-identical files.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const VERSION_TOKEN = '__VARANDA_VERSION__'
const PRECACHE_TOKEN = '__VARANDA_PRECACHE__'
const RELEASE_META_RE = /<meta name="varanda-release" content="[^"]*">/g
const EXCLUDED = new Set(['/metadata.json', '/sw.js'])

const sha256hex = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')

// Every regular file under distDir as a sorted root-relative POSIX path,
// except Expo's metadata.json, the worker itself and source maps.
function listAssets (distDir) {
  const out = []
  const walk = (dir, rel) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel + '/' + ent.name
      if (ent.isDirectory()) {
        walk(path.join(dir, ent.name), relPath)
      } else if (ent.isFile() && !EXCLUDED.has(relPath) && !ent.name.endsWith('.map')) {
        out.push(relPath)
      }
    }
  }
  walk(distDir, '')
  return out.sort()
}

// Fills the template's two tokens. The leading `/* global ... */` line names
// them for the linter only; they are dropped from it so the comment does not
// receive the precache list.
function renderWorker (template, { version, assets }) {
  let text = template
  const firstLine = text.slice(0, text.indexOf('\n') + 1)
  if (firstLine.startsWith('/* global')) {
    const cleaned = firstLine.replace(/,\s*__VARANDA_(VERSION|PRECACHE)__/g, '')
    text = cleaned + text.slice(firstLine.length)
  }
  for (const token of [VERSION_TOKEN, PRECACHE_TOKEN]) {
    if (!text.includes(token)) throw new Error('sw.js template is missing ' + token)
  }
  return text
    .split(VERSION_TOKEN).join(JSON.stringify(version))
    .split(PRECACHE_TOKEN).join(JSON.stringify(assets))
}

function requireFiles (distDir) {
  for (const name of ['index.html', 'varanda-node.js', 'manifest.webmanifest']) {
    if (!fs.existsSync(path.join(distDir, name))) {
      throw new Error('exportação web incompleta: falta ' + name + ' em ' + distDir)
    }
  }
  const bundleDir = path.join(distDir, '_expo', 'static', 'js', 'web')
  const bundles = fs.existsSync(bundleDir) ? fs.readdirSync(bundleDir).filter((n) => n.endsWith('.js')) : []
  if (bundles.length === 0) {
    throw new Error('exportação web incompleta: nenhum _expo/static/js/web/*.js em ' + distDir)
  }
}

function finishWeb (distDir, templateFile = path.join(__dirname, 'sw.js')) {
  requireFiles(distDir)
  const template = fs.readFileSync(templateFile)
  const indexFile = path.join(distDir, 'index.html')
  // Without any previous release meta, so a second run hashes the same bytes.
  const index = fs.readFileSync(indexFile, 'utf8').replace(RELEASE_META_RE, '')

  const assets = listAssets(distDir)
  const hash = crypto.createHash('sha256')
  hash.update(sha256hex(template) + '\n')
  const entries = []
  for (const url of assets) {
    const bytes = url === '/index.html' ? Buffer.from(index, 'utf8') : fs.readFileSync(path.join(distDir, url))
    const digest = sha256hex(bytes)
    hash.update(url + '\n' + digest + '\n')
    // /index.html gets its final hash below, once the release meta is in.
    entries.push({ url, sha256: url === '/index.html' ? null : digest })
  }
  const version = hash.digest('hex').slice(0, 16)

  if (!index.includes('</head>')) throw new Error('exportação web inválida: index.html sem </head>')
  const marked = index.replace('</head>', '<meta name="varanda-release" content="' + version + '"></head>')
  // The worker also checks the final index.html byte for byte: a copy torn by
  // an in-place deploy can already carry the release meta. The version does
  // not depend on sw.js, so this hash can go into it.
  const indexEntry = entries.find((e) => e.url === '/index.html')
  if (indexEntry) indexEntry.sha256 = sha256hex(Buffer.from(marked, 'utf8'))
  const worker = renderWorker(template.toString('utf8'), { version, assets: entries })
  fs.writeFileSync(indexFile, marked)
  fs.writeFileSync(path.join(distDir, 'sw.js'), worker)

  const bytes = Buffer.byteLength(worker)
  console.log('sw.js: ' + bytes + ' bytes, ' + entries.length + ' arquivos, versão ' + version)
  return { version, bytes, entries }
}

function main () {
  const distDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', 'dist')
  try {
    finishWeb(distDir)
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
}

if (require.main === module) main()

module.exports = { listAssets, renderWorker, finishWeb }
