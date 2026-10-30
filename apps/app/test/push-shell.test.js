// Wiring of the push note in the shell and the Ajustes row to the one store,
// read as text because both files pull in react-native.
'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8')
const ajustes = fs.readFileSync(path.join(__dirname, '..', 'src', 'screens', 'Ajustes.js'), 'utf8')

test('the shell shows the push note after the release and install notes', (t) => {
  const update = app.indexOf('<UpdateNote')
  const install = app.indexOf('<InstallNote')
  const push = app.indexOf('<PushNote')
  t.ok(update !== -1 && update < install, 'UpdateNote before InstallNote')
  t.ok(install !== -1 && install < push, 'InstallNote before PushNote')
  t.is(app.split('<PushNote').length - 1, 1, 'PushNote mounted once')
  const jsx = app.slice(push, app.indexOf('/>', push))
  t.ok(jsx.includes('push.activatePush('), 'Ativar calls activatePush')
  t.ok(jsx.includes('push.dismissPush('), 'close calls dismissPush')
  t.absent(jsx.includes('togglePush('), 'the note never toggles')
  t.ok(app.includes("from './src/usePush'"), 'App.js uses the shared store')
  t.ok(/if \(locked\) readPush\(null\)/.test(app), 'any lock drops the push view')
  t.ok(app.includes("push.note === 'offer' && pushMember !== null && push.member === pushMember ? <PushNote"), 'the note shows only while this member is eligible')
})

test('Ajustes shows the row only while this member is eligible', (t) => {
  t.ok(ajustes.includes('const push = pushEligible && pushStore.member === member ? pushStore.state : null'), 'row gated on eligibility')
})

test('Ajustes drives the same store', (t) => {
  t.ok(/import \{ usePush \} from '\.\.\/usePush'/.test(ajustes), 'imports usePush')
  t.ok(ajustes.includes('togglePush('), 'row toggles through the store')
  t.ok(ajustes.includes('turnOffPush('), 'Sair and Recomeçar turn off through the store')
  for (const gone of ['pushOp', 'pushBusy', 'const readPush', "from '../pushClient'"]) {
    t.absent(ajustes.includes(gone), 'no local ' + gone)
  }
})

test('no em dash in the wired files', (t) => {
  t.absent(app.includes('\u2014'), 'App.js')
  t.absent(ajustes.includes('\u2014'), 'Ajustes.js')
})
