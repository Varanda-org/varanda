// The Eventos screen (src/screens/Eventos.js) read as source text, like the
// other screen tests: what it asks, how it sorts and what it never does.
'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const APP = join(__dirname, '..')
const read = (rel) => readFileSync(join(APP, rel), 'utf8')
const code = (rel) => read(rel).replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')

test('Eventos: a member list and the Agenda, in three sections', (t) => {
  const src = read('src/screens/Eventos.js')
  t.ok(src.includes('fetchEvents'), 'the member list comes from the seeder')
  t.ok(src.includes("'group.events'"), 'the Agenda folds group.events')
  t.ok(src.includes('params.groups'), 'the Agenda is chosen by params.groups')
  for (const label of ['Próximos', 'Já passaram', 'Cancelados', 'Eventos', 'Agenda']) t.ok(src.includes("'" + label + "'"), label)
})

test('Eventos: no Platform check, no post rows, no notification module', (t) => {
  const src = code('src/screens/Eventos.js')
  t.absent(/Platform\.OS/.test(src), 'capability, not platform')
  t.absent(src.includes('<PostRow'), 'it renders EventCard rows, no PostRow')
  t.absent(/expo-notifications|Notifications\./.test(src), 'no notification module')
  t.ok(src.includes('EventCard'), 'rows are EventCards')
})

test('Eventos: reachable from nav, tabs and App', (t) => {
  t.ok(read('src/nav.js').includes("'eventos'"), 'nav')
  t.ok(read('src/tabs.js').includes("'eventos'"), 'tabs')
  const app = read('App.js')
  t.ok(app.includes("entry.screen === 'eventos'"), 'App layer')
  t.ok(app.includes('onOpenEventos') && app.includes('onOpenAgenda'), 'App handlers')
})

test('Eventos: a seeder pointer or a failed peek never fakes a cancellation', (t) => {
  const src = code('src/screens/Eventos.js')
  t.ok(/if \(record && !record\.event\) return null/.test(src), 'a live post without an event is dropped')
  t.ok(/gone: !record \}/.test(src), 'only a missing post is gone')
  t.ok(/!peeked\.get\(key\)\) throw/.test(src), 'no answer from the diary is a failed read')
})

test('Reminders: diary events only, and only a peek that answered drops one', (t) => {
  const card = code('src/ui/EventCard.js')
  t.ok(/const remindable = scope !== null && valid && !grouped/.test(card), 'group events keep no reminder')
  t.absent(/\{scope !== null && !past/.test(card), 'the reminder button follows remindable')
  const banner = code('src/ui/ReminderBanner.js')
  t.ok(/\} else if \(peek\) \{\s*removeReminder/.test(banner), 'a busy or unreachable diary keeps the reminder')
  t.ok(banner.includes('[firstRef, id, minute]'), 'the title read is tried again each minute')
})
