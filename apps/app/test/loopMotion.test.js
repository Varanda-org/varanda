'use strict'

// Endless animations (src/ui/loopMotion.js), a pure ES module; import()
// loads it here through Node's module syntax detection.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const load = () => import('../src/ui/loopMotion.js')
const SRC = path.join(__dirname, '../src')

function sources (dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(file))
    else if (entry.name.endsWith('.js')) out.push(file)
  }
  return out
}

test('loopTiming: never an interaction, the rest kept', async (t) => {
  const { loopTiming } = await load()
  const config = { toValue: 1, duration: 600, useNativeDriver: false }
  t.alike(loopTiming(config), { toValue: 1, duration: 600, useNativeDriver: false, isInteraction: false })
  t.is(loopTiming({ ...config, isInteraction: true }).isInteraction, false)
  t.alike(config, { toValue: 1, duration: 600, useNativeDriver: false }, 'the input is not changed')
})

// An Animated.timing that counts as an interaction inside an endless loop
// holds every FlatList at its first rows on the web: each one goes through
// loopTiming.
test('loopTiming: every Animated.loop uses it', (t) => {
  const files = sources(SRC).filter((file) => fs.readFileSync(file, 'utf8').includes('Animated.loop('))
  t.ok(files.length >= 2, 'the skeleton and the splash pulse loop')
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8')
    const name = path.relative(SRC, file)
    const timings = (src.match(/Animated\.timing\(/g) || []).length
    const looped = (src.match(/Animated\.timing\([^,]+,\s*loopTiming\(/g) || []).length
    t.ok(looped > 0, name + ': its loop goes through loopTiming')
    if (name === 'ui/States.js') t.is(looped, 2, name + ': both skeleton steps')
    if (name === 'ui/Splash.js') t.ok(timings > looped, name + ': the one-off entrance stays as it was')
  }
})

test('loopMotion: stays pure', (t) => {
  const src = fs.readFileSync(path.join(SRC, 'ui/loopMotion.js'), 'utf8')
  for (const bad of ["from 'react", 'require(', 'node:', './theme']) {
    t.absent(src.includes(bad), bad)
  }
})
