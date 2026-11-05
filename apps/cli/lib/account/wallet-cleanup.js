'use strict'

const fs = require('node:fs')
const path = require('node:path')

// The payments account was removed; its files (and a temp file a crash left
// behind writeJsonAtomic in @varanda/core/lib/store.js) are deleted at serve
// startup. Names only: no byte is ever read and nothing here logs or throws.
const NAMES = new Set(['wallet.json', 'wallet-ops.json'])
const TEMP_RE = /^\.(wallet|wallet-ops)\.json\.\d+\.[0-9a-f]{12}\.tmp$/

function isTarget (name) {
  return NAMES.has(name) || TEMP_RE.test(name)
}

// -> { removed: [name], failed: [{ file, code }] }. A symlink is unlinked,
// never followed; a directory is left alone.
function removeWalletFiles (dir) {
  const removed = []
  const failed = []
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    if (err && err.code !== 'ENOENT') failed.push({ file: '.', code: (err && err.code) || 'erro' })
    return { removed, failed }
  }
  for (const entry of entries) {
    const name = entry.name
    if (!isTarget(name) || entry.isDirectory()) continue
    try {
      fs.unlinkSync(path.join(dir, name))
      removed.push(name)
    } catch (err) {
      if (err && err.code === 'ENOENT') continue
      failed.push({ file: name, code: (err && err.code) || 'erro' })
    }
  }
  return { removed, failed }
}

module.exports = { removeWalletFiles }
