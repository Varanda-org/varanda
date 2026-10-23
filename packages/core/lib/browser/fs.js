'use strict'
// Browser stub for #fs: the browser has no filesystem, so the core's storage
// modules load but every call fails loudly.
function unavailable () {
  throw new Error('indisponível no navegador')
}

module.exports = {
  constants: {},
  existsSync: unavailable,
  readFileSync: unavailable,
  writeFileSync: unavailable,
  mkdirSync: unavailable,
  openSync: unavailable,
  fstatSync: unavailable,
  lstatSync: unavailable,
  statSync: unavailable,
  closeSync: unavailable,
  renameSync: unavailable,
  rmSync: unavailable,
  unlinkSync: unavailable,
  linkSync: unavailable,
  chmodSync: unavailable,
  fchmodSync: unavailable,
  fsyncSync: unavailable
}
