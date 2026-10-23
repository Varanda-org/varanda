'use strict'
// Bundle stub for Node-only modules (random-access-file and Node builtins)
// that the member graph still references: the module loads, every use
// throws.
function unavailable () {
  throw new Error('indisponível no navegador')
}

module.exports = new Proxy(unavailable, {
  get (target, prop) {
    if (prop === '__esModule') return false
    if (prop === 'default') return module.exports
    return unavailable
  },
  apply: unavailable,
  construct: unavailable
})
