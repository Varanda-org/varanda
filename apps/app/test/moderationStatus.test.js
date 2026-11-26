'use strict'

// The Sobre line for the applied moderation list (moderation.status,
// docs/rpc.md 5.177): the list's local calendar day, a plain "none yet"
// before any list arrived, and nothing for an answer it cannot read.
const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const load = () => import('../src/moderationStatus.js')

test('moderationLine shows the day of the applied list', async (t) => {
  const { moderationLine } = await load()
  // Noon UTC: the same calendar day in every zone from -11 h to +11 h.
  t.is(moderationLine({ seq: 3, date: '2026-03-04T12:00:00.000Z', moderatorDate: '2026-01-01T00:00:00.000Z' }), 'Lista de moderação de 04/03/2026.')
  t.is(moderationLine({ seq: 40, date: '2026-11-20T12:00:00.000Z', moderatorDate: '2026-10-01T12:00:00.000Z' }), 'Lista de moderação de 20/11/2026.')
})

test('moderationLine says when no list arrived yet', async (t) => {
  const { moderationLine, MODERATION_NONE } = await load()
  t.is(moderationLine({ seq: null, date: null, moderatorDate: null }), MODERATION_NONE)
})

test('moderationLine leaves out an answer it cannot read', async (t) => {
  const { moderationLine } = await load()
  for (const answer of [null, undefined, 'x', {}, { seq: 0, date: '2026-03-04T12:00:00.000Z' }, { seq: 1.5, date: '2026-03-04T12:00:00.000Z' }, { seq: 2, date: 'ontem' }, { seq: 2, date: null }, { seq: null, date: '2026-03-04T12:00:00.000Z' }]) {
    t.is(moderationLine(answer), '', JSON.stringify(answer))
  }
})

test('Sobre puts the line behind the moderation help', (t) => {
  const src = readFileSync(join(__dirname, '../src/screens/Sobre.js'), 'utf8')
  t.ok(src.includes('<HelpNote doc={HELP.moderacao}>'), 'the explanation stays behind the (i)')
  const ajustes = readFileSync(join(__dirname, '../src/screens/Ajustes.js'), 'utf8')
  t.ok(ajustes.includes("node.request('moderation.status', {})"), 'Ajustes reads moderation.status for Sobre')
})
