let sessionValue = null

export function musicAutoStore () {
  return {
    getItem (key) {
      if (sessionValue !== null) return sessionValue
      try {
        return globalThis.localStorage?.getItem(key) ?? null
      } catch {
        return null
      }
    },
    setItem (key, value) {
      sessionValue = value
      try {
        globalThis.localStorage?.setItem(key, value)
      } catch {}
    }
  }
}
