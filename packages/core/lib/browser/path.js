'use strict'
// Browser stub for #path: path handling is only needed by the filesystem
// code, which is unavailable in the browser.
function unavailable () {
  throw new Error('indisponível no navegador')
}

module.exports = {
  join: unavailable,
  resolve: unavailable,
  dirname: unavailable,
  basename: unavailable,
  isAbsolute: unavailable
}
