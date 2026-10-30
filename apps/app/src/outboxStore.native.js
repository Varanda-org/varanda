// iOS/Android. The outbox (see ./outbox) as text in the app's document dir
// (next to varanda-config.json, never inside the node data dir), so a post
// written without connection survives a restart. Same format and rules as
// outboxStore.web.js: the stored text is parsed by parseOutbox, which drops
// every malformed item, and nothing stored is trusted (outboxProvider.js only
// sends what the person approved in this session). Read synchronously like
// localStorage on the web.

import { File, Paths } from 'expo-file-system'
import { parseOutbox, serializeOutbox, hexId } from './outbox'

const FILE_NAME = 'varanda-outbox.json'

export const outboxAvailable = true

function file (suffix = '') {
  return new File(Paths.document, FILE_NAME + suffix)
}

function removeQuietly (f) {
  try {
    if (f.exists) f.delete()
  } catch {}
}

// File.write truncates in place, so a failed write would leave a partial
// queue that parses as empty and loses every unsent post. The text goes whole
// to a .tmp file, the old one is set aside (.bak) and only dropped once the
// new one is in place. move never overwrites, hence the steps (same as
// configStore.native.js).
function replaceFile (text) {
  removeQuietly(file('.tmp'))
  try {
    file('.tmp').create()
    file('.tmp').write(text)
  } catch (err) {
    removeQuietly(file('.tmp'))
    throw err
  }
  if (!file().exists && file('.bak').exists) {
    try { file('.bak').move(file()) } catch {}
  }
  // A .bak that could not be put back is still the only good copy: keep it.
  if (file().exists) removeQuietly(file('.bak'))
  const hadCurrent = file().exists
  try {
    if (hadCurrent) file().move(file('.bak'))
    file('.tmp').move(file())
  } catch (err) {
    if (hadCurrent && !file().exists && file('.bak').exists) {
      try { file('.bak').move(file()) } catch {}
    }
    removeQuietly(file('.tmp'))
    throw err
  }
  removeQuietly(file('.bak'))
}

export function loadOutbox () {
  try {
    let f = file()
    // Interrupted between setting the old file aside and moving the new one
    // in: the old queue still counts.
    if (!f.exists) f = file('.bak')
    if (!f.exists) return []
    return parseOutbox(f.textSync())
  } catch {
    return []
  }
}

// false means NOT saved (disk full or unavailable): the previous file stays.
export function saveOutbox (items) {
  try {
    replaceFile(serializeOutbox(items))
    return true
  } catch {
    return false
  }
}

// Never Math.random: an id must not be guessable or collide across restarts.
export function randomId () {
  const bytes = new Uint8Array(8)
  globalThis.crypto.getRandomValues(bytes)
  return hexId(bytes)
}
