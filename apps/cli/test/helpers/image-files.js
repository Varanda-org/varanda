'use strict'

// Preloaded with `node -r` by the tests that run the CLI as the seeder image
// would (deploy/seeder/Dockerfile): any file of this repository that the
// root .dockerignore leaves out of the image fails to load, as it does in the
// image. node_modules is out of scope, since npm ci fills it there. #876
// loaded @varanda/web-member at startup, the image had none of its code, and
// `seed` crashed before its health check.

const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')

const root = path.resolve(__dirname, '../../../..')

const rules = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l !== '' && !l.startsWith('#'))
  .map((r) => {
    const admit = r.startsWith('!')
    const pattern = admit ? r.slice(1) : r
    // Only the forms the file uses today; anything else must be modelled here
    // before this check can be trusted.
    if (pattern !== '*' && !/^\*\*\/[^*?[\]/]+$/.test(pattern) && /[*?[\]]/.test(pattern)) {
      throw new Error('image-files: .dockerignore rule not modelled: ' + r)
    }
    return { admit, pattern }
  })

// Docker matches a rule against the path and each of its parents.
function matches (pattern, segs) {
  if (pattern === '*') return true
  if (pattern.startsWith('**/')) return segs.includes(pattern.slice(3))
  const want = pattern.split('/')
  return want.length <= segs.length && want.every((s, i) => s === segs[i])
}

// The last matching rule wins.
function shipped (rel) {
  const segs = rel.split(path.sep)
  let inImage = true
  for (const { admit, pattern } of rules) {
    if (matches(pattern, segs)) inImage = admit
  }
  return inImage
}

const resolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  const file = resolve.call(this, request, ...rest)
  if (!path.isAbsolute(file)) return file
  const rel = path.relative(root, file)
  if (rel.startsWith('..') || rel.split(path.sep).includes('node_modules')) return file
  if (!shipped(rel)) {
    const err = new Error("Cannot find module '" + request + "' (" + rel + ' is not in the seeder image)')
    err.code = 'MODULE_NOT_FOUND'
    throw err
  }
  return file
}
