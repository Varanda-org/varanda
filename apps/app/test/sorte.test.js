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

test('saltOfKey takes the first 16 chars of a lowercase 64-hex key', async (t) => {
  const { saltOfKey, isSalt } = await load()
  const key = 'ab'.repeat(32)
  t.is(saltOfKey(key), 'ab'.repeat(8))
  t.ok(isSalt(saltOfKey(key)))
  for (const bad of [key.toUpperCase(), key.slice(0, 63), key + '0', 'zz'.repeat(32), '', 5, null, undefined, {}]) t.is(saltOfKey(bad), null)
})

test('two keys can give different lines on the same date, one key never does', async (t) => {
  const { saltOfKey, sorteDoDia } = await load()
  const a = saltOfKey('0123456789abcdef'.repeat(4))
  const b = saltOfKey('fedcba9876543210'.repeat(4))
  const lines = new Set()
  for (let d = 1; d <= 28; d++) {
    const date = new Date(2026, 10, d)
    t.is(sorteDoDia(date, a), sorteDoDia(date, saltOfKey('0123456789abcdef'.repeat(4))))
    lines.add(sorteDoDia(date, a) === sorteDoDia(date, b))
  }
  t.ok(lines.has(false))
})

test('isSalt validates 16 lowercase hex', async (t) => {
  const { isSalt, sorteDoDia, SORTES } = await load()
  t.ok(isSalt(SALT_A))
  for (const bad of [null, 5, '', 'xyz', 'ABCDEF0123456789', SALT_A + '0']) t.is(isSalt(bad), false)
  t.ok(SORTES.includes(sorteDoDia(new Date(2026, 5, 1), undefined)))
})

test('the module is pure: no network, no account data', async (t) => {
  const code = readFileSync(join(__dirname, '..', 'src', 'sorte.js'), 'utf8')
  t.absent(/fetch|XMLHttpRequest|WebSocket|require\(|from '/.test(code))
})

test('the salt stores never write the diary or the account, and the card holds no salt state', async (t) => {
  const src = (...p) => readFileSync(join(__dirname, '..', 'src', ...p), 'utf8')
  for (const f of ['sorteStore.web.js', 'sorteStore.native.js']) {
    const code = src(f)
    t.absent(code.includes('setItem'), f + ': no setItem')
    t.absent(code.includes('.write('), f + ': no .write(')
    t.absent(code.includes('.create('), f + ': no .create(')
  }
  const card = src('ui', 'SorteCard.js')
  t.absent(card.includes('useState'), 'SorteCard: no useState')
  t.absent(card.includes('loadSalt'), 'SorteCard: no loadSalt')
  t.ok(card.includes('saltOfKey(ownerKey)'), 'SorteCard: salt comes from the diary key')
  t.ok(card.includes('if (salt === null) return null'), 'SorteCard: no card without a salt')
})

test('the old per-device salt is forgotten once per load from the root, for everyone', async (t) => {
  const app = readFileSync(join(__dirname, '..', 'App.js'), 'utf8')
  t.ok(app.includes("import { forgetSalt } from './src/sorteStore'"))
  const root = app.slice(app.indexOf('export default function App ('))
  t.ok(root.includes('useEffect(() => { forgetSalt() }, [])'))
})
