'use strict'

// Push goes off before an identity is replaced (src/pushSwitch.js, wired in
// src/screens/Identidade.js), and the Ajustes row logic (pushRowView).
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const identidade = fs.readFileSync(path.join(__dirname, '..', 'src', 'screens', 'Identidade.js'), 'utf8')
const ajustes = fs.readFileSync(path.join(__dirname, '..', 'src', 'screens', 'Ajustes.js'), 'utf8')

test('turnOffBeforeSwitch: turns off with the old member, before the switch', async (t) => {
  const { turnOffBeforeSwitch } = await import('../src/pushSwitch.js')
  const order = []
  await turnOffBeforeSwitch(async (arg) => { order.push(['off', arg.member]) }, { node: {}, member: 'old' })
  order.push(['replace'])
  t.alike(order, [['off', 'old'], ['replace']])
})

test('turnOffBeforeSwitch: a failing turn-off never blocks the switch, sync or async', async (t) => {
  const { turnOffBeforeSwitch } = await import('../src/pushSwitch.js')
  let switched = 0
  await turnOffBeforeSwitch(async () => { throw new Error('rede') }, {})
  switched++
  await turnOffBeforeSwitch(() => { throw new Error('sync') }, {})
  switched++
  await turnOffBeforeSwitch(undefined, {})
  switched++
  t.is(switched, 3)
})

test('Identidade: reset and create-anyway turn push off before replacing the identity', (t) => {
  t.ok(identidade.includes("import { turnOffBeforeSwitch } from '../pushSwitch'"))
  const reset = identidade.slice(identidade.indexOf('const doReset = () => {'), identidade.indexOf('A profile invite (App.js'))
  t.ok(reset.indexOf('turnOffBeforeSwitch(pushStore.turnOffPush') !== -1, 'reset turns push off')
  t.ok(reset.indexOf('turnOffBeforeSwitch(') < reset.indexOf('passkey.reset()'), 'before the reset')
  const reg = identidade.slice(identidade.indexOf('const doRegister = '), identidade.indexOf('const doComplete = '))
  t.ok(reg.indexOf('turnOffBeforeSwitch(pushStore.turnOffPush') !== -1, 'register turns push off')
  t.ok(reg.indexOf('turnOffBeforeSwitch(') < reg.indexOf('ceremony('), 'before the ceremony')
  t.absent(/await turnOffBeforeSwitch/.test(reg), 'the click is never awaited before the ceremony')
  t.absent(identidade.includes('\u2014'), 'no em dash')
})

const base = { support: 'ok', key: 'k', permission: 'default', subscribed: false, registered: false, swUpToDate: true }

test('pushRowView: hidden without a member, a key or browser support', async (t) => {
  const { pushRowView, PUSH_UNSUPPORTED } = await import('../src/push-state.js')
  t.is(pushRowView({ push: null }).row, false)
  t.is(pushRowView({ push: { ...base, key: null } }).row, false, 'no key: row hidden')
  t.is(pushRowView({ push: { ...base, support: 'not-hosted' } }).row, false)
  const un = pushRowView({ push: { ...base, support: 'unsupported' } })
  t.is(un.row, false)
  t.is(un.note, PUSH_UNSUPPORTED)
})

test('pushRowView: Ligados only when browser and service agree, Desligados otherwise, none when unknown', async (t) => {
  const { pushRowView, PUSH_UNKNOWN, PUSH_DENIED } = await import('../src/push-state.js')
  const on = pushRowView({ push: { ...base, subscribed: true, registered: true } })
  t.alike([on.row, on.trailing, on.ui.on], [true, 'Ligados', true])
  const off = pushRowView({ push: base })
  t.alike([off.row, off.trailing, off.ui.disabled], [true, 'Desligados', false])
  const lost = pushRowView({ push: { ...base, subscribed: true, registered: false } })
  t.is(lost.trailing, 'Desligados', 'a row lost on the service side is not shown as working')
  const unknown = pushRowView({ push: { ...base, subscribed: true, registered: null } })
  t.alike([unknown.trailing, unknown.note], [null, PUSH_UNKNOWN])
  const denied = pushRowView({ push: { ...base, permission: 'denied' } })
  t.alike([denied.ui.disabled, denied.note], [true, PUSH_DENIED])
  t.is(pushRowView({ push: base, pending: true }).ui.disabled, true, 'disabled while a change is pending')
  t.is(pushRowView({ push: { ...base, permission: 'denied' }, error: PUSH_DENIED }).note, '', 'a note equal to the error is not repeated')
})

test('Ajustes: the row comes from pushRowView and toggles through the store', (t) => {
  t.ok(ajustes.includes('pushRowView({ push, pending: pushPending, error: pushError })'))
  t.ok(ajustes.includes('pushStore.togglePush({ node, member })'))
  t.ok(ajustes.includes('pushHint(push)'), 'the hint with the delay note is shown')
})
