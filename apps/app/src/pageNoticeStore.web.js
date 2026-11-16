import { registerLocalCache } from './localCaches.js'
import { legacyPageNoticeFlags, pageNoticeFlags } from './pageNotice.js'

export function wipePageNotices () {
  try {
    const storage = globalThis.localStorage
    const names = []
    for (let i = 0; i < storage.length; i++) names.push(storage.key(i))
    for (const name of pageNoticeFlags(names)) {
      try { storage.removeItem(name) } catch {}
    }
  } catch {}
}

export function wipeLegacyPageNotices () {
  try {
    const storage = globalThis.localStorage
    const names = []
    for (let i = 0; i < storage.length; i++) names.push(storage.key(i))
    for (const name of legacyPageNoticeFlags(names)) {
      try { storage.removeItem(name) } catch {}
    }
  } catch {}
}

registerLocalCache({ wipe: wipePageNotices })

export function pageNoticeStore () {
  return {
    getItem (key) {
      try { return globalThis.localStorage.getItem(key) } catch { return null }
    },
    setItem (key, value) {
      try { globalThis.localStorage.setItem(key, value) } catch {}
    }
  }
}
