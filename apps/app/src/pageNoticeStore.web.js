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
