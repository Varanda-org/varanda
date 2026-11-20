// Records every directory the client creates under the stub paths, and keeps
// files in memory: globalThis.__stubDirs (Set of directory URIs) and
// globalThis.__stubFsFiles (Map of URI to { bytes, mtime }). The clock for
// modification times is globalThis.__stubNow when set, Date.now otherwise.
const dirs = () => (globalThis.__stubDirs ??= new Set())
const files = () => (globalThis.__stubFsFiles ??= new Map())
const now = () => typeof globalThis.__stubNow === 'number' ? globalThis.__stubNow : Date.now()

export const Paths = {
  document: { uri: 'file:///stub/Documents/' },
  cache: { uri: 'file:///stub/Caches/' }
}

const parentOf = (uri) => uri.slice(0, uri.lastIndexOf('/', uri.length - 2) + 1)

export class Directory {
  constructor (parent, name) {
    this.uri = parent.uri + name + '/'
  }

  get name () {
    return this.uri.slice(parentOf(this.uri).length, -1)
  }

  get exists () {
    return dirs().has(this.uri)
  }

  create (opts = {}) {
    if (dirs().has(this.uri) && opts.idempotent === false) throw new Error('exists')
    if (opts.intermediates) {
      for (let p = parentOf(this.uri); p.length > 'file:///'.length; p = parentOf(p)) dirs().add(p)
    }
    dirs().add(this.uri)
  }

  delete () {
    if (!dirs().has(this.uri)) throw new Error('missing')
    for (const d of [...dirs()]) if (d.startsWith(this.uri)) dirs().delete(d)
    for (const f of [...files().keys()]) if (f.startsWith(this.uri)) files().delete(f)
  }

  // Direct children only, like the real list().
  list () {
    if (!dirs().has(this.uri)) throw new Error('missing')
    const out = []
    for (const d of dirs()) {
      if (d !== this.uri && parentOf(d) === this.uri) out.push(new Directory(this, d.slice(this.uri.length, -1)))
    }
    for (const f of files().keys()) {
      if (parentOf(f) === this.uri) out.push(new File(this, f.slice(this.uri.length)))
    }
    return out
  }
}

export class File {
  constructor (dir, name) {
    this.uri = dir.uri + name
  }

  get name () {
    return this.uri.slice(parentOf(this.uri).length)
  }

  get exists () {
    return files().has(this.uri)
  }

  get size () {
    const f = files().get(this.uri)
    return f ? f.bytes.byteLength : 0
  }

  get modificationTime () {
    const f = files().get(this.uri)
    return f ? f.mtime : null
  }

  create () {
    if (!dirs().has(parentOf(this.uri))) throw new Error('no directory')
    if (files().has(this.uri)) throw new Error('exists')
    files().set(this.uri, { bytes: new Uint8Array(0), mtime: now() })
  }

  write (bytes) {
    if (globalThis.__stubWriteFails) throw new Error('disk full')
    files().set(this.uri, { bytes: Uint8Array.from(bytes), mtime: now() })
  }

  delete () {
    if (!files().has(this.uri)) throw new Error('missing')
    files().delete(this.uri)
  }

  move (dest) {
    if (!files().has(this.uri)) throw new Error('missing')
    if (files().has(dest.uri)) throw new Error('destination exists')
    if (globalThis.__stubMoveFails) throw new Error('move failed')
    files().set(dest.uri, files().get(this.uri))
    files().delete(this.uri)
    this.uri = dest.uri
  }
}
