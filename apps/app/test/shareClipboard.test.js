'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const nav = fs.readFileSync(path.join(__dirname, '../src/shareNav.native.js'), 'utf8')
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'))

test('native shareNav exposes a write-only clipboard', (t) => {
  t.ok(nav.includes('expo-clipboard'))
  t.ok(nav.includes('writeText'))
  t.absent(nav.includes('getStringAsync'))
})

test('expo-clipboard is pinned to the SDK 55 line', (t) => {
  t.ok(/^55\.0\.\d+$/.test(pkg.dependencies['expo-clipboard']))
})
