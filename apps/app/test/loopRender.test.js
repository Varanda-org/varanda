'use strict'
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const UI = path.join(__dirname, '..', 'src', 'ui')
const read = (name) => fs.readFileSync(path.join(UI, name), 'utf8')

test('Skeleton draws still and stays out of the shared pulse while its screen is hidden', (t) => {
  const src = read('States.js')
  const body = src.slice(src.indexOf('export function Skeleton ('), src.indexOf('export function SkeletonProfile'))
  t.ok(src.includes("import { ScreenVisible } from './screenVisible'"), 'imports ScreenVisible')
  t.ok(body.includes('useContext(ScreenVisible)'), 'reads ScreenVisible')
  t.ok(/const reduce = reduceMotion \|\| !seen/.test(body), 'hidden counts as the still path')
  t.ok(/if \(reduce\) return\s+startSharedPulse\(\)/.test(body), 'the pulse starts only when not still')
  t.ok(body.includes('[reduce]'), 'the effect follows the visibility')
  t.ok(body.includes('const Block = reduce ? View : Animated.View'), 'still path is a plain View')
})

test('MusicEqualizer bars run on the native driver off the web', (t) => {
  const src = read('MusicEqualizer.js')
  t.ok(src.includes('const native = Platform.select({ web: false, default: true })'), 'driver constant, false on web')
  t.absent(src.includes('useNativeDriver: false'), 'no JS-driven timing left')
  t.is((src.match(/useNativeDriver: native/g) || []).length, 2, 'both steps')
  t.ok(src.includes('loopTiming({'), 'still through loopTiming')
  t.ok(src.includes('bars.forEach((value) => value.setValue(0.6))'), 'rest at 0.6 kept')
})

test('the screen visibility default stays false', (t) => {
  t.ok(read('screenVisible.js').includes('export const ScreenVisible = createContext(false)'))
})

test('GardenSceneView sway runs on the native driver off the web', (t) => {
  const src = read('GardenSceneView.js')
  t.ok(src.includes('const native = Platform.select({ web: false, default: true })'), 'driver constant, false on web')
  t.absent(src.includes('useNativeDriver: false'), 'no JS-driven timing left')
  t.is((src.match(/useNativeDriver: native/g) || []).length, 1, 'the one loop step')
  t.ok(src.includes('loopTiming({'), 'still through loopTiming')
})
