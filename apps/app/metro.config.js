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
// time by src/client/browser.js.

const path = require('path')
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)

function escape (p) {
  return p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const root = path.resolve(__dirname, '../..')
const blocked = [
  new RegExp('^' + escape(path.join(root, 'packages', 'core') + path.sep) + '.*$'),
  new RegExp('^' + escape(path.join(root, 'packages', 'web-member') + path.sep) + '.*$'),
  new RegExp('^' + escape(path.join(__dirname, 'worklet') + path.sep) + '[^' + escape(path.sep) + ']*\\.js$')
]

const existing = config.resolver.blockList
config.resolver.blockList = [].concat(existing === undefined || existing === null ? [] : existing, blocked)

module.exports = config
