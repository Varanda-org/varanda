'use strict'

// GrupoAjustes is JSX, so this reads the files as text.
// window.location is absent on the phone. window.addEventListener (the
// sheet's Escape handler) is a different use and must stay.
const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')

const screens = path.join(__dirname, '../src/screens')
const srcDir = path.join(__dirname, '../src')
const files = ['GrupoAjustes.js', 'communityShare.js']
const dirs = { 'GrupoAjustes.js': screens, 'communityShare.js': srcDir }
const shareFns = { 'GrupoAjustes.js': 'shareInvite', 'communityShare.js': 'shareCommunity' }
// A screen's share function ends at the next const inside the component; the
// top-level one in communityShare.js ends with its closing brace.
const ends = { 'GrupoAjustes.js': '\n  const ', 'communityShare.js': '\n}\n' }

function read (name) {
  return fs.readFileSync(path.join(dirs[name] || screens, name), 'utf8')
}

function shareBody (src, name, endAt) {
  const marker = 'const ' + name + ' = async'
  const at = src.indexOf(marker)
  if (at < 0) return ''
  const rest = src.slice(at)
  const end = rest.indexOf(endAt, marker.length)
  return end < 0 ? rest : rest.slice(0, end)
}

test('group and community share links use the installation origin', (t) => {
  for (const name of files) {
    const src = read(name)
    t.is(src.includes('window.location'), false, name)
    t.ok(src.includes('installationOrigin'), name)
    t.ok(src.includes('installationOrigin() || globalThis.location?.origin || \'\''), name)
    const body = shareBody(src, shareFns[name], ends[name])
    const guard = body.indexOf('base === \'\'')
    const share = body.search(/shareUrl\s*\(|copyText\s*\(/)
    t.ok(guard !== -1 && share !== -1 && guard < share, name + ' refuses an empty origin before sharing')
    t.ok(body.includes('Não foi possível copiar o link.'), name)
  }
  t.ok(read('GrupoAjustes.js').includes('window.addEventListener'))
})
