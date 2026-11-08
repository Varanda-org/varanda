// metro.config.js blocks the node (packages/core, packages/web-member) and
// the worklet sources from the app bundle. Node resolves those imports, so
// every other test passes while expo export fails: the deploy's web build
// broke this way on a vitrine fixture importing web-member's sodium.
'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const APP = path.join(__dirname, '..')
const ROOT = path.join(APP, '../..')
const BLOCKED_PACKAGES = ['@varanda/core', '@varanda/web-member']
const BLOCKED_DIRS = [path.join(ROOT, 'packages', 'core'), path.join(ROOT, 'packages', 'web-member')]
// Metro blocks only the top level of worklet/, as metro.config.js does.
const WORKLET = path.join(APP, 'worklet')

function sources (dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(file))
    else if (entry.name.endsWith('.js')) out.push(file)
  }
  return out
}

function withoutComments (src) {
  return src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')
}

function specifiers (src) {
  const out = []
  const patterns = [
    /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ]
  for (const re of patterns) {
    for (const m of src.matchAll(re)) out.push(m[1])
  }
  return out
}

function blocked (file, spec) {
  if (BLOCKED_PACKAGES.some((name) => spec === name || spec.startsWith(name + '/'))) return true
  if (!spec.startsWith('.')) return false
  const target = path.resolve(path.dirname(file), spec)
  if (path.dirname(target) === WORKLET) return true
  return BLOCKED_DIRS.some((dir) => target === dir || target.startsWith(dir + path.sep))
}

test('blocked: a web-member import is caught', (t) => {
  const file = path.join(APP, 'src', 'vitrine', 'fixtures.js')
  const found = specifiers("import sodium from '@varanda/web-member/lib/sodium-browser'\nimport x from '../../../../packages/core/lib/safe.js'\nimport w from '../../worklet/main.js'\nimport b from '../../assets/worklet/main.bundle.js'\nrequire('@varanda/rpc')")
  t.alike(found.filter((spec) => blocked(file, spec)), ['@varanda/web-member/lib/sodium-browser', '../../../../packages/core/lib/safe.js', '../../worklet/main.js'])
})

test('app sources import nothing Metro blocks', (t) => {
  const files = [...sources(path.join(APP, 'src')), path.join(APP, 'App.js'), path.join(APP, 'index.js')]
  t.ok(files.length > 10, 'app sources are scanned')
  const offenders = []
  for (const file of files) {
    for (const spec of specifiers(withoutComments(fs.readFileSync(file, 'utf8')))) {
      if (blocked(file, spec)) offenders.push(path.relative(APP, file) + ': ' + spec)
    }
  }
  t.alike(offenders, [])
})
