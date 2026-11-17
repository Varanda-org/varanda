'use strict'

const test = require('brittle')
const rpc = require('@varanda/rpc')

const NOW = Date.UTC(2026, 10, 16, 15, 0, 0)
const MIN = 60000
const H = 3600000

test('plant labels cover exactly the contract plants', async (t) => {
  const { PLANT_LABELS, plantLabel } = await import('../src/varandinhaView.js')
  t.alike(Object.keys(PLANT_LABELS).sort(), rpc.garden.GARDEN_PLANTS.map((p) => p.id).sort())
  t.is(PLANT_LABELS.manjericao, 'Manjericão')
  t.is(PLANT_LABELS.tomate, 'Tomate-cereja')
  t.is(PLANT_LABELS.pimenta, 'Pimenta')
  t.is(PLANT_LABELS.alecrim, 'Alecrim')
  t.is(PLANT_LABELS.samambaia, 'Samambaia')
  t.is(PLANT_LABELS.espada, 'Espada-de-são-jorge')
  t.is(plantLabel('tomate'), 'Tomate-cereja')
  t.is(plantLabel('rosa'), '')
  t.is(plantLabel('__proto__'), '')
  t.is(plantLabel(undefined), '')
})

test('titles, actions and stages', async (t) => {
  const v = await import('../src/varandinhaView.js')
  t.is(v.TITLE, 'Varandinha')
  t.is(v.STREET_TITLE, 'Varandas da rua')
  t.alike(Object.values(v.ACTIONS), ['Plantar', 'Regar', 'Arrancar', 'Guardar', 'Descartar'])
  t.is(v.STAGE_LABELS.length, 4)
  t.is(v.SOIL_LABELS.dry, 'seca')
  t.is(v.SOIL_LABELS.wet, 'molhada')
  t.is(v.WHO_WATERED, 'Quem regou')
  t.is(v.CONSENT_SWITCH_LABEL, 'Entendi e quero participar')
})

test('harvest verbs', async (t) => {
  const { harvestVerb } = await import('../src/varandinhaView.js')
  for (const id of ['manjericao', 'tomate', 'pimenta', 'alecrim']) t.is(harvestVerb(id), 'Colher', id)
  for (const id of ['samambaia', 'espada']) t.is(harvestVerb(id), 'Tirar muda', id)
})

test('readyIn counts down in whole units and never goes negative', async (t) => {
  const { readyIn } = await import('../src/varandinhaView.js')
  t.is(readyIn(NOW - H, NOW), 'pronta', 'past')
  t.is(readyIn(NOW, NOW), 'pronta', 'exact')
  t.is(readyIn(NOW + 1, NOW), 'pronta em 1 min')
  t.is(readyIn(NOW + 25 * MIN, NOW), 'pronta em 25 min')
  t.is(readyIn(NOW + 25 * MIN - 1, NOW), 'pronta em 25 min')
  t.is(readyIn(NOW + 59 * MIN + 1, NOW), 'pronta em 60 min')
  t.is(readyIn(NOW + 3 * H, NOW), 'pronta em 3 h')
  t.is(readyIn(NOW + 3 * H + MIN, NOW), 'pronta em 4 h')
  t.is(readyIn(NOW + 23 * H, NOW), 'pronta em 23 h')
  t.is(readyIn(NOW + 47 * H, NOW), 'pronta em 2 d')
  for (const bad of [NaN, undefined, null, 'x', Infinity]) {
    t.is(readyIn(bad, NOW), 'pronta', String(bad))
    t.is(readyIn(NOW + H, bad), 'pronta', 'now ' + String(bad))
  }
  t.absent(readyIn(NaN, NaN).includes('NaN'))
})

test('pendingLabel and visitorLine plurals', async (t) => {
  const { pendingLabel, visitorLine } = await import('../src/varandinhaView.js')
  t.is(pendingLabel(1), '1 ação por guardar')
  t.is(pendingLabel(2), '2 ações por guardar')
  t.is(pendingLabel(24), '24 ações por guardar')
  t.is(visitorLine(0), 'Ninguém regou ainda')
  t.is(visitorLine(NaN), 'Ninguém regou ainda')
  t.is(visitorLine(undefined), 'Ninguém regou ainda')
  t.is(visitorLine(1), '1 vizinho regou')
  t.is(visitorLine(3), '3 vizinhos regaram')
})

test('wateredDay labels a watering day like the visits list', async (t) => {
  const { wateredDay } = await import('../src/varandinhaView.js')
  const local = new Date(2026, 10, 16, 15).getTime()
  t.is(wateredDay(new Date(2026, 10, 16, 9).toISOString(), local), 'hoje')
  t.is(wateredDay(new Date(2026, 10, 15, 22).getTime(), local), 'ontem')
  t.is(wateredDay(new Date(2026, 10, 12, 12).toISOString(), local), '12 nov')
  t.is(wateredDay('lixo', local), '')
  t.is(wateredDay(undefined, local), '')
})

test('the consent lines say what is public and what leaving does', async (t) => {
  const { CONSENT_LINES } = await import('../src/varandinhaView.js')
  const text = CONSENT_LINES.join(' ')
  t.ok(CONSENT_LINES.length >= 4)
  t.ok(/opcional/.test(text) && /desligada/.test(text))
  t.ok(/públic/.test(text))
  t.ok(/plant/.test(text) && /rega/.test(text) && /colheita/.test(text))
  t.ok(/vê o seu nome/.test(text))
  t.ok(/compra, ranking nem prêmio/.test(text))
  t.ok(/marca os seus registros do jogo como apagados/.test(text))
  t.ok(/cópias que outras pessoas já buscaram podem continuar/.test(text))
  t.ok(/diário deles/.test(text))
})

const REFUSALS = [
  'ligue a Varandinha para jogar',
  'você já cuidou da varanda o máximo de vezes por hoje',
  'jogada inválida',
  'não dá para regar a própria varanda',
  'você bloqueou esta pessoa',
  'ligue a Varandinha para regar',
  'você só rega a varanda de quem você segue',
  'você já regou esta varanda hoje',
  'você já regou o máximo de varandas por hoje',
  'esta pessoa não está na Varandinha',
  'páginas não têm Varandinha',
  'este vaso não tem planta para regar'
]

test('refusalNotice returns the twelve node refusals and null for anything else', async (t) => {
  const { refusalNotice, NOTICES } = await import('../src/varandinhaView.js')
  t.is(REFUSALS.length, 12)
  for (const message of REFUSALS) {
    t.is(refusalNotice(message), message)
    t.ok(Object.values(NOTICES).includes(message), message + ' is a notice')
  }
  for (const other of ['semeador indisponível', 'boom', '', ' ' + REFUSALS[0], REFUSALS[0] + '.', null, undefined, 7, {}]) t.is(refusalNotice(other), null)
  t.is(NOTICES.uncertain, 'Não sabemos se a jogada foi guardada. Confira a varanda antes de tentar de novo.')
  for (const key of ['unreachable', 'indexing', 'incomplete', 'notHosted', 'uncertain']) t.ok(typeof NOTICES[key] === 'string' && NOTICES[key].length > 10, key)
  t.absent(/Só na versão web/.test(NOTICES.notHosted))
})

test('no string of the module holds an em dash, an en dash or a web-only notice', async (t) => {
  const view = await import('../src/varandinhaView.js')
  const strings = []
  const walk = (v) => {
    if (typeof v === 'string') strings.push(v)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(view)
  t.ok(strings.length > 40)
  for (const s of strings) {
    t.absent(s.includes('—') || s.includes('–'), s)
    t.absent(s.includes('Só na versão web'), s)
  }
  for (const s of [view.pendingLabel(1), view.pendingLabel(5), view.visitorLine(0), view.visitorLine(1), view.visitorLine(2), view.readyIn(NOW + H, NOW)]) {
    t.absent(s.includes('—') || s.includes('–'), s)
  }
})
