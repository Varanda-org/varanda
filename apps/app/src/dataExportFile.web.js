export const exportDelivery = Object.freeze({ save: true, share: false })

export function saveExport (name, text) {
  try {
    const blob = new globalThis.Blob([text], { type: 'application/json' })
    const url = globalThis.URL.createObjectURL(blob)
    try {
      const a = globalThis.document.createElement('a')
      a.href = url
      a.download = name
      a.rel = 'noopener'
      globalThis.document.body.appendChild(a)
      try { a.click() } finally { a.remove() }
    } finally {
      setTimeout(() => globalThis.URL.revokeObjectURL(url), 1000)
    }
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

// The browser keeps no copy of its own: the download is the only one.
export function clearExportCache () {}

export async function shareExport () {
  return { ok: false, reason: 'unavailable' }
}
