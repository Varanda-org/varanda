'use strict'

// Metro for the Varanda app (plan A7). The React Native bundle must never
// pull the node: the core (packages/core, reached through the
// node_modules/@varanda/core symlink, which Metro resolves to its real path),
// the browser node (packages/web-member) and the worklet sources
// (worklet/*.js) are blocked. The worklet reaches the app only as the packed
// bundle assets/worklet/main.bundle.js (bare-pack format bundle.cjs: a module
// exporting the bundle text), which lives outside worklet/ and is imported by
// src/client/native.js; the browser node reaches the web build only as the
// static script public/varanda-node.js (npm run build:node), loaded at run
// time by src/client/browser.js. The commit and build date are stamped into
// process.env here, before Metro reads the environment, for the Ajustes version line.

const path = require('path')
const { getDefaultConfig } = require('expo/metro-config')
const { applyBuildInfo } = require('./scripts/resolve-build-info')

const root = path.resolve(__dirname, '../..')
applyBuildInfo({ repoRoot: root })

const config = getDefaultConfig(__dirname)

function escape (p) {
  return p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const blocked = [
  new RegExp('^' + escape(path.join(root, 'packages', 'core') + path.sep) + '.*$'),
  new RegExp('^' + escape(path.join(root, 'packages', 'web-member') + path.sep) + '.*$'),
  new RegExp('^' + escape(path.join(__dirname, 'worklet') + path.sep) + '[^' + escape(path.sep) + ']*\\.js$')
]

const existing = config.resolver.blockList
config.resolver.blockList = [].concat(existing === undefined || existing === null ? [] : existing, blocked)

// A production transform (expo export, export:embed in the Gradle and Xcode
// bundle steps, and expo start --no-dev) inlines process.env.EXPO_PUBLIC_* into the cached
// output, so the key carries the commit and, for those runs, the build date:
// a second export of the same commit must not keep the first one's date.
// `expo start` reads the values at serialization (expo/virtual/env), so the
// date stays out of its key and the warm cache survives a restart.
const exporting = process.argv.slice(2).some((a) => a === 'export' || a === 'export:embed' || a === '--no-dev')
config.cacheVersion = String(config.cacheVersion || '1') + ':' + (process.env.EXPO_PUBLIC_VARANDA_COMMIT || 'none') +
  (exporting ? ':' + process.env.EXPO_PUBLIC_VARANDA_BUILD_DATE : '')

module.exports = config
