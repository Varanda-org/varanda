'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { linkNew } = require('@varanda/core/lib/link-new')
const { fsyncDir } = require('@varanda/core/lib/member')

function exists (file) {
  return new Error('o arquivo de saída já existe: ' + file)
}

// Throws when `file` is there, even as a dangling symlink (lstat does not
// follow it).
function refuseExisting (file) {
  let stat
  try {
    stat = fs.lstatSync(file)
  } catch (err) {
    if (err.code === 'ENOENT') return
    throw err
  }
  if (stat.isSymbolicLink()) throw new Error('o arquivo de saída é um link simbólico: ' + file)
  throw exists(file)
}

// Writes `text` to a new file: a unique temp file next to it ('wx', fsynced),
// published by linkNew, which never replaces a file or follows a symlink, and
// the new entry is fsynced in its directory.
function writeNew (file, text) {
  refuseExisting(file)
  const tmp = path.join(path.dirname(file), '.' + path.basename(file) + '.' + crypto.randomBytes(12).toString('hex') + '.tmp')
  const fd = fs.openSync(tmp, 'wx', 0o666)
  try {
    try {
      fs.writeFileSync(fd, text)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    try {
      linkNew(tmp, file)
    } catch (err) {
      if (err.code === 'EEXIST') throw exists(file)
      throw err
    }
    fsyncDir(path.dirname(file))
  } finally {
    try { fs.unlinkSync(tmp) } catch {}
  }
}

module.exports = { refuseExisting, writeNew }
