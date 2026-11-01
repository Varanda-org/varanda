'use strict'

// CadeiraAjustes and Comunidade are JSX, so this reads them as text.
// window.location is absent on the phone. window.addEventListener (the
// sheet's Escape handler) is a different use and must stay.
const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')

const screens = path.join(__dirname, '../src/screens')
const files = ['CadeiraAjustes.js', 'Comunidade.js']
const shareFns = { 'CadeiraAjustes.js': 'shareInvite', 'Comunidade.js': 'shareCommunity' }

function read (name) {
  return fs.readFileSync(path.join(screens, name), 'utf8')
}

function shareBody (src, name) {
  const marker = 'const ' + name + ' = async'
  const at = src.indexOf(marker)
  if (at < 0) return ''
  const rest = src.slice(at)
  const end = rest.indexOf('\n  const ', marker.length)
  return end < 0 ? rest : rest.slice(0, end)
}

test('group and community share links use the installation origin', (t) => {
  for (const name of files) {
    const src = read(name)
    t.is(src.includes('window.location'), false, name)
    t.ok(src.includes('installationOrigin'), name)
    t.ok(src.includes('installationOrigin() || globalThis.location?.origin || \'\''), name)
    const body = shareBody(src, shareFns[name])
    const guard = body.indexOf('base === \'\'')
    const share = body.search(/shareUrl\s*\(|copyText\s*\(/)
    t.ok(guard !== -1 && share !== -1 && guard < share, name + ' refuses an empty origin before sharing')
    t.ok(body.includes('Não foi possível copiar o link.'), name)
  }
  t.ok(read('CadeiraAjustes.js').includes('window.addEventListener'))
})
