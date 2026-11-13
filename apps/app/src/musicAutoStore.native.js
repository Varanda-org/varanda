let prefStore = null

export function musicAutoStore () {
  if (prefStore !== null) return prefStore
  const { File, Paths } = require('expo-file-system')
  const file = (suffix = '') => new File(Paths.document, 'varanda-musica-sozinha.json' + suffix)

  function removeQuietly (f) {
    try {
      if (f.exists) f.delete()
    } catch {}
  }

  prefStore = {
    getItem () {
      // Unreadable is not absent: a stored opt-out that cannot be read must
      // not turn music back on, so a file nobody can read reads as invalid.
      let present = false
      for (const suffix of ['', '.bak']) {
        try {
          const f = file(suffix)
          if (!f.exists) continue
          present = true
          return f.textSync()
        } catch {}
      }
      return present ? '' : null
    },
    setItem (_key, value) {
      // File.write truncates in place and can lose an opt-out mid-write.
      // move never overwrites, so keep a backup until the new file is in place.
      removeQuietly(file('.tmp'))
      try {
        file('.tmp').create()
        file('.tmp').write(value)
      } catch (err) {
        removeQuietly(file('.tmp'))
        throw err
      }
      if (!file().exists && file('.bak').exists) {
        try { file('.bak').move(file()) } catch {}
      }
      // A backup that could not be restored is still the only good copy.
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
  }
  return prefStore
}
