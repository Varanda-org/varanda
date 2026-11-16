'use strict'

// The share title is the community's name: the button waits for it and the
// old 'Comunidade' to 'Varanda' swap is gone. The screens are JSX, so this
// reads the files as text.
const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')

const read = (...p) => fs.readFileSync(path.join(__dirname, '../src', ...p), 'utf8')

test('shareCommunity never swaps the title and shares nothing without a name', (t) => {
  const src = read('communityShare.js')
  t.is(src.includes("'Varanda'"), false)
  t.ok(/title === ''/.test(src))
  t.ok(src.includes('shareUrl(nav, { url, title })'))
})

test('both community screens disable share until the name is loaded', (t) => {
  const page = read('screens', 'Comunidade.js')
  t.ok(page.includes("label: 'Compartilhar', onPress: share, disabled: loadedName === ''"))
  t.ok(page.includes('shareCommunity({ community, title: loadedName })'))
  const info = read('screens', 'ComunidadeInfo.js')
  t.ok(info.includes("onPress={share} disabled={loadedName === ''}"))
  t.ok(info.includes('shareCommunity({ community, title: loadedName })'))
})
