'use strict'

const fs = require('fs')
const path = require('path')
const test = require('brittle')
const load = () => import('../src/attempts.js')

test('begin hands out a new token and invalidates every older one', async (t) => {
  const { createAttempts } = await load()
  const attempts = createAttempts()
  const first = attempts.begin()
  t.ok(Number.isInteger(first))
  t.is(attempts.current(), first)
  t.ok(attempts.isCurrent(first))

  const second = attempts.begin()
  t.not(second, first)
  t.is(attempts.current(), second)
  t.ok(attempts.isCurrent(second))
  t.absent(attempts.isCurrent(first), 'the older token is obsolete')

  const third = attempts.begin()
  t.absent(attempts.isCurrent(first))
  t.absent(attempts.isCurrent(second))
  t.ok(attempts.isCurrent(third))
})

test('instances are independent; foreign values are never current', async (t) => {
  const { createAttempts } = await load()
  const a = createAttempts()
  const b = createAttempts()
  const ta = a.begin()
  a.begin()
  t.is(b.current(), 0)
  b.begin()
  t.absent(a.isCurrent(ta))
  for (const value of [undefined, null, '1', NaN, {}]) t.absent(a.isCurrent(value), String(value))
})

test('the module is pure: no React, react-native or Node imports', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '../src/attempts.js'), 'utf8')
  t.absent(/\bimport\b|\brequire\(/.test(source))
})
