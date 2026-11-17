'use strict'

// writeJsonAtomic for the account service's sidecar files, with the service
// lock asked once more right before the rename, after the temp file is
// written, fsynced and closed. A process whose event loop stalled past the
// lock's stale window (a long fsync, a suspended process) may have lost the
// lock while it read, merged or fsynced; asking again this late keeps it from
// renaming over what the new holder already wrote. A false answer, or a throw
// from guard(), leaves the target as it was and the temp file removed, and
// the write throws an error that isRefused() tells apart from an ordinary
// failure, so each store answers it with the refusal it gives when guard()
// is false before the write, with memory and any dirty mark untouched.
//
// What remains is the few synchronous instructions between this check and
// the rename itself: a holder suspended exactly there while another process
// takes the lock over still lands its rename. The check each store makes
// after the rename refuses to acknowledge that write.

const { writeJsonAtomic } = require('@varanda/core/lib/store')

const REFUSED = Symbol('refused')

// guard() as a boolean: a throw counts as a refusal. For a store that
// renames or unlinks on its own instead of through writeJsonAtomic.
function held (guard) {
  try {
    return Boolean(guard())
  } catch {
    return false
  }
}

// `write` is the writer with writeJsonAtomic's signature, for a store that
// takes an injected one; it must call `beforeRename` before its rename.
function writeGuarded (file, obj, mode, guard, write = writeJsonAtomic) {
  let refused = false
  const beforeRename = () => {
    if (held(guard)) return
    refused = true
    throw refusal()
  }
  try {
    write(file, obj, mode, { beforeRename })
  } catch (err) {
    // A failed temp cleanup must not hide the refusal: the target was not
    // replaced either way.
    if (refused) throw refusal()
    throw err
  }
}

function refusal () {
  const err = new Error('indisponivel')
  err.code = 'indisponivel'
  err[REFUSED] = true
  return err
}

function isRefused (err) {
  return Boolean(err && err[REFUSED] === true)
}

module.exports = { writeGuarded, isRefused, held }
