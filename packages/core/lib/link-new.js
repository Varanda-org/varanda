'use strict'

const fs = require('#fs')

// Publishes the finished temp file `tmp` as `file` only if `file` does not
// exist (EEXIST otherwise): a hard link, so a concurrent writer can never be
// clobbered. Android denies link() to apps (SELinux, EACCES), so there it
// falls back to an lstat check and a rename. That pair is not atomic against
// another writer, which the callers rule out: they run under the store lock or
// in a data dir private to one process.
function linkNew (tmp, file) {
  try {
    fs.linkSync(tmp, file)
    return
  } catch (err) {
    if (err.code !== 'EACCES' && err.code !== 'EPERM') throw err
  }
  try {
    fs.lstatSync(file)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    fs.renameSync(tmp, file)
    return
  }
  const exists = new Error('EEXIST: file already exists, link \'' + tmp + '\' -> \'' + file + '\'')
  exists.code = 'EEXIST'
  throw exists
}

module.exports = { linkNew }
