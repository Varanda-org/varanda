// Records every directory the client creates under the stub paths.
export const Paths = {
  document: { uri: 'file:///stub/Documents/' },
  cache: { uri: 'file:///stub/Caches/' }
}

export class Directory {
  constructor (parent, name) {
    this.uri = parent.uri + name + '/'
  }

  get exists () {
    return (globalThis.__stubDirs ??= new Set()).has(this.uri)
  }

  create () {
    ;(globalThis.__stubDirs ??= new Set()).add(this.uri)
  }
}
