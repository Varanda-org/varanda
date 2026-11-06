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
  const files = [...sources(SCREENS).filter((file) => !/\.(web|native)\.js$/.test(file)), path.join(__dirname, '../src/ui/LinkCard.js')]
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
