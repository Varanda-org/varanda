// A shared screen that calls the browser leaves the phone behind.
// Product availability follows node.hosted, not Platform.OS === 'web'.
'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const SCREENS = path.join(__dirname, '../src/screens')
const BROWSER_APIS = [
  'window.location',
  'document.createElement',
  'document.body',
  'document.addEventListener',
  'document.visibilityState',
  'document.getElementById',
  'document.createRange',
  'crypto.subtle',
  'globalThis.open(',
  'globalThis.document',
  'globalThis.navigator'
]

function sources (dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(file))
    else if (entry.name.endsWith('.js')) out.push(file)
  }
  return out
}

// String literals are kept whole, so a '//' inside a URL never hides the
// rest of its line.
function withoutComments (src) {
  return src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')
}

test('shared screens stay phone-safe', (t) => {
  const files = [...sources(SCREENS).filter((file) => !/\.(web|native)\.js$/.test(file)), path.join(__dirname, '../src/ui/LinkCard.js'), path.join(__dirname, '../src/ui/CrashBoundary.js')]
  t.ok(files.length > 0, 'shared screens are scanned')
  for (const file of files) {
    const src = withoutComments(fs.readFileSync(file, 'utf8'))
    const forbidden = BROWSER_APIS.filter((api) => src.includes(api))
    t.alike(forbidden, [], path.relative(SCREENS, file) + ': no browser APIs')
  }
})

test('App: hosted product availability does not depend on the web platform', (t) => {
  const src = withoutComments(fs.readFileSync(path.join(__dirname, '../App.js'), 'utf8'))
  t.absent(src.includes("hostedPage === true && Platform.OS === 'web'"), 'hosted availability is platform-independent')
})

test('only src/media/audio.web.js touches MediaRecorder', (t) => {
  const SRC = path.join(__dirname, '../src')
  const files = [...sources(SRC), path.join(__dirname, '../App.js')]
  const users = files.filter((file) => withoutComments(fs.readFileSync(file, 'utf8')).includes('MediaRecorder'))
  t.alike(users.map((file) => path.relative(SRC, file)), [path.join('media', 'audio.web.js')])
})

// A phone with the installation is hosted, so it never meets this title; a
// phone without one is not on the web, and the note must say what is missing.
test('no shared screen tells a phone "Só na versão web"', (t) => {
  const files = sources(SCREENS).filter((file) => !/\.(web|native)\.js$/.test(file))
  t.ok(files.length > 0, 'shared screens are scanned')
  for (const file of files) {
    const src = withoutComments(fs.readFileSync(file, 'utf8'))
    t.absent(src.includes('Só na versão web'), path.relative(SCREENS, file))
  }
})

test('no file under src tells a phone "Só na versão web"', (t) => {
  const src = path.join(__dirname, '../src')
  const files = sources(src)
  t.ok(files.length > 0, 'src is scanned')
  for (const file of files) t.absent(fs.readFileSync(file, 'utf8').includes('Só na versão web'), path.relative(src, file))
})

test('Comunidades, Comunidade and ComunidadeInfo gate on node.hosted with the words Grupo uses', (t) => {
  const read = (name) => fs.readFileSync(path.join(SCREENS, name), 'utf8')
  const grupo = read('Grupo.js')
  const title = /title='(Comunidades indisponíveis)'/.exec(grupo)
  const body = /export const WEB_ONLY_TEXT = '([^']*)'/.exec(grupo)
  t.ok(title && body, 'Grupo states the capability note')
  const comunidades = read('Comunidades.js')
  t.ok(comunidades.includes("export const UNAVAILABLE_TITLE = '" + title[1] + "'"), 'same title as Grupo')
  t.ok(comunidades.includes("export const UNAVAILABLE_MESSAGE = '" + body[1] + "'"), 'same body as Grupo')
  for (const name of ['Comunidades.js', 'Comunidade.js', 'ComunidadeInfo.js']) {
    const src = withoutComments(read(name))
    t.ok(src.includes('title={UNAVAILABLE_TITLE} body={UNAVAILABLE_MESSAGE}'), name + ': shows the shared note')
    t.ok(/if \(!hosted\) \{[\s\S]{0,160}?<EmptyState[^>]*UNAVAILABLE_TITLE/.test(src), name + ': only when the node is not hosted')
    t.absent(src.includes('Platform.OS'), name + ': no platform check')
  }
})
