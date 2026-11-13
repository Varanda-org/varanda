'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const load = () => import('../src/pressMotion.js')

test('pressScale shrinks only while pressed without reduced motion', async (t) => {
  const { pressScale } = await load()
  t.is(pressScale({ pressed: true, reduceMotion: false }), 0.97)
  t.is(pressScale({ pressed: false, reduceMotion: false }), 1)
  t.is(pressScale({ pressed: true, reduceMotion: true }), 1)
  t.is(pressScale({ pressed: false, reduceMotion: true }), 1)
})

test('pressTiming uses the caller duration and removes motion when requested', async (t) => {
  const { pressTiming } = await load()
  for (const ms of [0, 90, 150, 1600]) {
    t.is(pressTiming(false, ms), ms)
    t.is(pressTiming(true, ms), 0)
  }
})

test('pressMotion loads without UI or platform dependencies', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '../src/pressMotion.js'), 'utf8')
  t.absent(/\b(?:import|require)\s*\(?/.test(src), 'no runtime imports')
  t.absent(src.includes('\u2014'), 'no em dash')
})
