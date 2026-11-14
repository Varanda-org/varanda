// The cover is drawn from stored data only and never opens a link. Read as
// text because the UI files pull in react-native.
'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const SRC = path.join(__dirname, '../src')

// String literals are kept whole, so a '//' inside a URL never hides the
// rest of its line.
function withoutComments (src) {
  return src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')
}

const src = withoutComments(fs.readFileSync(path.join(SRC, 'ui', 'EmbedCover.js'), 'utf8'))

test('EmbedCover stays on stored data and opens nothing', (t) => {
  t.absent(/\bfetch\s*\(/.test(src), 'no fetch call')
  t.absent(/['"`]https?:\/\//i.test(src), 'no http(s) literal')
  t.absent(/ActivityIndicator/.test(src), 'no spinner')
  t.absent(/Platform\.OS/.test(src), 'no Platform.OS')
  t.absent(/colors\.text\b/.test(src), 'no unknown color key')
  t.absent(/openExternal/.test(src), 'no link opening')
  t.absent(/onPress\s*=/.test(src), 'no onPress')
})

test('EmbedCover structure', (t) => {
  t.ok(/displayText\(/.test(src), 'peer text goes through displayText')
  t.is((src.match(/<Pressable\b/g) || []).length, 1, 'exactly one Pressable')
  t.ok(/accessibilityRole='image'/.test(src), 'image role')
  const views = src.match(/<MediaView\b[^>]*>/g) || []
  t.ok(views.length > 0, 'draws MediaView')
  t.ok(views.every((v) => v.includes('tapRetry={false}')), 'every MediaView has tapRetry off')
  const hook = src.indexOf('useChatThumb(')
  const firstReturn = src.indexOf('return', src.indexOf('export function EmbedCover'))
  t.ok(hook > 0 && hook < firstReturn, 'useChatThumb is called before any return')
  t.ok(src.includes('coverLayout(') && src.includes('coverSource(') && src.includes('coverLabel('), 'uses the pure rules')
})
