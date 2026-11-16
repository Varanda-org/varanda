'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const load = () => import('../src/sorte.js')
const SALT_A = '0123456789abcdef'
const SALT_B = 'fedcba9876543210'

test('at least 60 distinct bundled lines, none with an em dash', async (t) => {
  const { SORTES } = await load()
  t.ok(SORTES.length >= 60)
  t.is(new Set(SORTES).size, SORTES.length)
  for (const s of SORTES) {
    t.ok(typeof s === 'string' && s.length > 10 && s.length < 140, s)
    t.absent(s.includes(String.fromCharCode(0x2014)))
  }
})

test('same date and salt give the same line, any hour of the day', async (t) => {
  const { sorteDoDia } = await load()
  const a = sorteDoDia(new Date(2026, 10, 15, 0, 5), SALT_A)
  t.is(sorteDoDia(new Date(2026, 10, 15, 23, 59), SALT_A), a)
})

test('the line changes across days and across salts', async (t) => {
  const { sorteDoDia } = await load()
  const days = new Set()
  const perSalt = new Set()
  for (let d = 1; d <= 28; d++) {
    days.add(sorteDoDia(new Date(2026, 10, d), SALT_A))
    perSalt.add(sorteDoDia(new Date(2026, 10, d), SALT_B) === sorteDoDia(new Date(2026, 10, d), SALT_A))
  }
  t.ok(days.size > 10)
  t.ok(perSalt.has(false))
})

test('dateKey uses the local calendar and survives a bad date', async (t) => {
  const { dateKey } = await load()
  t.is(dateKey(new Date(2026, 0, 5, 23, 59)), '2026-01-05')
  t.is(dateKey(new Date(NaN)), dateKey(new Date(0)))
  t.is(dateKey('x'), dateKey(new Date(0)))
})

test('salts are random 16 hex and validated', async (t) => {
  const { newSalt, isSalt, sorteDoDia, SORTES } = await load()
  const s = newSalt()
  t.ok(isSalt(s))
  t.not(s, newSalt())
  for (const bad of [null, 5, '', 'xyz', 'ABCDEF0123456789', SALT_A + '0']) t.is(isSalt(bad), false)
  t.ok(SORTES.includes(sorteDoDia(new Date(2026, 5, 1), undefined)))
})

test('the module is pure: no network, no account data', async (t) => {
  const code = readFileSync(join(__dirname, '..', 'src', 'sorte.js'), 'utf8')
  t.absent(/fetch|XMLHttpRequest|WebSocket|require\(|from '/.test(code))
})
