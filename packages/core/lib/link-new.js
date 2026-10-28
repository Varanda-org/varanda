'use strict'

const fs = require('#fs')

// Publishes the finished temp file `tmp` as `file` only if `file` does not
// exist (EEXIST otherwise): a hard link, so a concurrent writer can never be
// clobbered. Android denies link() to apps (SELinux, EACCES), so only that
// error falls back to an lstat check and a rename. Not EPERM: other file
// systems (FAT, exFAT, some network volumes) answer link() with it, and callers
// such as the moderator and account key creation count on EEXIST to never
// overwrite a secret key. The lstat and rename pair is not atomic against
// another writer; it is accepted on Android because the app's data dir is
// private to one worklet.
function linkNew (tmp, file) {
  try {
    fs.linkSync(tmp, file)
    return
  } catch (err) {
    if (err.code !== 'EACCES') throw err
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
