'use strict'

const test = require('brittle')
const { readFileSync } = require('fs')
const { join } = require('path')

test('msUntilMidnight counts to the next local midnight', async (t) => {
  const { msUntilMidnight } = await import('../src/dayClock.js')
  t.is(msUntilMidnight(new Date(2026, 9, 10, 23, 59, 0).getTime()), 60 * 1000)
  t.is(msUntilMidnight(new Date(2026, 11, 31, 23, 59, 59, 999).getTime()), 1, 'year end rolls over')
  t.is(msUntilMidnight(new Date(2026, 9, 10, 0, 0, 0, 0).getTime()), new Date(2026, 9, 11).getTime() - new Date(2026, 9, 10).getTime(), 'exactly at midnight aims at the next one')
})

test('useNow refreshes on resume and at midnight and cleans up', (t) => {
  const src = readFileSync(join(__dirname, '../src/ui/index.js'), 'utf8')
  const body = src.slice(src.indexOf('export function useNow'), src.indexOf('export function useBottomPad'))
  t.ok(body.includes("AppState.addEventListener('change'"))
  t.ok(body.includes("state === 'active'"))
  t.ok(body.includes('msUntilMidnight()'))
  t.ok(body.includes('sub.remove()'))
  t.ok(body.includes('clearTimeout(midnight)'))
})
