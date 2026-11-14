'use strict'

// useReveal (src/ui/useReveal.js) is a React hook, so its source is pinned.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const raw = fs.readFileSync(path.join(__dirname, '../src/ui/useReveal.js'), 'utf8')
const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

test('useReveal: the fade config', (t) => {
  t.ok(src.includes('useNativeDriver: false'), 'JS driver')
  t.ok(src.includes('isInteraction: false'), 'not an interaction')
  t.ok(src.includes('duration: motion.fast'))
  t.ok(src.includes("from './theme'"))
})

test('useReveal: mounting ready never fades', (t) => {
  t.ok(src.includes('new Animated.Value(ready ? 1 : 0)'))
  t.ok(src.includes('useState(ready === true)'))
  t.ok(src.includes('useRef(new Animated.Value('), 'created once')
})

test('useReveal: reduced motion snaps', (t) => {
  t.ok(/if \(reduceMotion\) \{\s*opacity\.setValue\(1\)/.test(src))
  t.ok(src.includes('[ready, reduceMotion]'))
})

test('useReveal: timers and stale runs', (t) => {
  t.ok(src.includes('clearTimeout(timer.current)'))
  t.ok(/useEffect\(\(\) => cancel, \[\]\)/.test(src), 'unmount cancels')
  t.ok(/if \(!ready\) \{\s*cancel\(\)\s*opacity\.setValue\(0\)\s*setSettled\(false\)/.test(src), 'ready false resets')
  t.ok(src.includes('counter.current++'))
  t.ok((src.match(/id !== counter\.current/g) || []).length >= 2, 'stale completions return early')
  t.ok(src.includes('finished === true'))
})

test('useReveal: no platform switch, no em dash', (t) => {
  t.absent(src.includes('Platform'))
  t.absent(raw.includes('\u2014'))
})
