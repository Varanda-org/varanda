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
  t.is(v.THIRSTY_LABEL, 'precisa de água')
  t.is(v.WHO_WATERED, 'Quem regou')
  t.is(v.CONSENT_SWITCH_LABEL, 'Entendi e quero participar')
})

test('decor and gift labels cover the contract ids', async (t) => {
  const { DECOR_LABELS, DECOR_TITLE, GIFT_LABELS, decorLabel, decorLine, giftLabel } = await import('../src/varandinhaView.js')
  t.is(DECOR_TITLE, 'Enfeites')
  t.alike(Object.keys(DECOR_LABELS), [...rpc.garden.GARDEN_DECOR_IDS])
  t.is(DECOR_LABELS.rede, 'Rede')
  t.is(DECOR_LABELS.varal, 'Varal')
  t.is(DECOR_LABELS.gato, 'Gato')
  t.is(DECOR_LABELS.pisca, 'Pisca-pisca')
  for (const id of rpc.garden.GARDEN_DECOR_IDS) t.ok(decorLabel(id).length > 0, id)
  t.is(decorLabel('rosa'), '')
  t.is(decorLabel('__proto__'), '')
  t.is(decorLabel(undefined), '')
  t.is(decorLine([]), '')
  t.is(decorLine(null), '')
  t.is(decorLine(undefined), '')
  t.is(decorLine(['desconhecido']), '')
  t.is(decorLine(['rede']), 'Enfeites: Rede')
  t.is(decorLine(['rede', 'varal', 'gato', 'pisca']), 'Enfeites: Rede, Varal, Gato, Pisca-pisca')
  t.alike(Object.keys(GIFT_LABELS).sort(), rpc.garden.GARDEN_PLANTS.map((p) => p.id).sort())
  t.is(GIFT_LABELS.manjericao, 'Maço de manjericão')
  t.is(GIFT_LABELS.tomate, 'Tomates-cereja')
  t.is(GIFT_LABELS.pimenta, 'Pimentas')
  t.is(GIFT_LABELS.alecrim, 'Ramo de alecrim')
  t.is(GIFT_LABELS.samambaia, 'Muda de samambaia')
  t.is(GIFT_LABELS.espada, 'Muda de espada-de-são-jorge')
  for (const p of rpc.garden.GARDEN_PLANTS) t.ok(giftLabel(p.id).length > 0, p.id)
  t.is(giftLabel('rosa'), '')
  t.is(giftLabel('__proto__'), '')
  t.is(giftLabel(undefined), '')
})

test('stall copy, plurals and shelf lines', async (t) => {
  const v = await import('../src/varandinhaView.js')
  t.is(v.STALL_TITLE, 'Barraquinha')
  t.ok(Object.isFrozen(v.STALL_ACTIONS))
  t.alike(Object.values(v.STALL_ACTIONS), ['Dar de presente', 'Aceitar', 'Tirar da prateleira', 'Desfazer'])
  t.alike(Object.values(v.ACTIONS), ['Plantar', 'Regar', 'Arrancar', 'Guardar', 'Descartar'])
  t.is(v.PENDING_TITLE, 'Mimos para aceitar')
  t.is(v.SHELF_TITLE, 'Na prateleira')
  t.is(v.GAVE_TITLE, 'Você deu')
  t.is(v.PENDING_EMPTY, 'Nenhum mimo para aceitar.')
  t.is(v.SHELF_EMPTY, 'A prateleira está vazia.')
  t.is(v.GAVE_EMPTY, 'Você não deu mimos nesta semana.')
  t.is(v.PICK_EMPTY, 'Ninguém que você segue está na Varandinha.')
  t.is(v.stallLine(true), 'Hoje tem barraquinha.')
  t.is(v.stallLine(false), 'A barraquinha abre aos sábados.')
  t.is(v.pendingGiftsLabel(1), '1 mimo para aceitar')
  t.is(v.pendingGiftsLabel(2), '2 mimos para aceitar')
  t.is(v.pendingGiftsLabel(0), '0 mimos para aceitar')
  t.is(v.shelfLine('tomate', 'Ana'), 'Tomates-cereja, presente de Ana')
  t.is(v.shelfLine('manjericao', 'Lia'), 'Maço de manjericão, presente de Lia')
  t.is(v.shelfLine('tomate', ''), 'Tomates-cereja')
  t.is(v.shelfLine('tomate'), 'Tomates-cereja')
  t.is(v.shelfLine('pimenta', null), 'Pimentas')
  const bidi = String.fromCharCode(0x202e)
  const bell = String.fromCharCode(7)
  const hostile = v.shelfLine('tomate', 'A' + bidi + 'b' + bell + '\n<x>')
  t.ok(hostile.startsWith('Tomates-cereja, presente de A'), 'a peer name still shows')
  t.absent(hostile.includes(bidi) || hostile.includes(bell) || hostile.includes('\n'), 'a peer name is cleaned by displayText')
  t.is(v.GIVE_PUBLIC, 'O mimo fica público no seu diário, com a pessoa, o item e a data. O vaso fica vazio.')
  t.is(v.TAKE_PUBLIC, 'Aceitar grava no seu diário, em público, de quem veio o mimo.')
  t.is(v.UNGIVE_NOTE, 'O mimo sai da prateleira da pessoa. O vaso não volta.')
  t.is(v.LEAVE_STALL_LINE, 'Os mimos que vizinhos deram a você ficam no diário deles.')
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
  t.is(CONSENT_LINES.length, 6)
  t.is(CONSENT_LINES[4], 'Sair da Varandinha marca os seus registros do jogo como apagados, mas cópias que outras pessoas já buscaram podem continuar. As regas que vizinhos fizeram na sua varanda ficam no diário deles.')
  t.is(CONSENT_LINES[5], 'Os enfeites que você escolhe e os mimos que você dá ou aceita, com a pessoa, o item e a data, também ficam públicos no seu diário.')
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
  'este vaso não tem planta para regar',
  'a barraquinha só abre aos sábados',
  'não dá para dar um mimo para si',
  'você só dá mimos para quem você segue',
  'você já deu um mimo para esta pessoa hoje',
  'você já deu o máximo de mimos por hoje',
  'este vaso ainda não está pronto',
  'este mimo não está mais disponível',
  'você já aceitou o máximo de mimos por hoje',
  'este registro não é um mimo seu'
]

test('refusalNotice returns the twenty-one node refusals and null for anything else', async (t) => {
  const { refusalNotice, NOTICES } = await import('../src/varandinhaView.js')
  t.is(REFUSALS.length, 21)
  for (const message of REFUSALS) {
    t.is(refusalNotice(message), message)
    t.ok(Object.values(NOTICES).includes(message), message + ' is a notice')
  }
  for (const other of ['semeador indisponível', 'boom', '', ' ' + REFUSALS[0], REFUSALS[0] + '.', null, undefined, 7, {}]) t.is(refusalNotice(other), null)
  t.is(NOTICES.uncertain, 'Não sabemos se a jogada foi guardada. Confira a varanda antes de tentar de novo.')
  for (const key of ['unreachable', 'indexing', 'incomplete', 'notHosted', 'uncertain']) t.ok(typeof NOTICES[key] === 'string' && NOTICES[key].length > 10, key)
  t.absent(/Só na versão web/.test(NOTICES.notHosted))
})

test('no string of the module holds an em dash, an en dash, the classifieds name or a web-only notice', async (t) => {
  const view = await import('../src/varandinhaView.js')
  const strings = []
  const walk = (v) => {
    if (typeof v === 'string') strings.push(v)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(view)
  t.ok(strings.length > 40)
  const made = [
    view.pendingLabel(1), view.pendingLabel(5),
    view.visitorLine(0), view.visitorLine(1), view.visitorLine(2),
    view.readyIn(NOW + H, NOW),
    view.pendingGiftsLabel(1), view.pendingGiftsLabel(5),
    view.stallLine(true), view.stallLine(false),
    view.shelfLine('tomate', 'Ana'), view.shelfLine('tomate'),
    view.decorLine(['rede', 'gato']), view.decorLine([])
  ]
  for (const s of strings.concat(made)) {
    t.absent(s.includes('—') || s.includes('–'), s)
    t.absent(s.includes('Feira') || s.includes('feira'), s)
    t.absent(s.includes('Só na versão web'), s)
  }
})

test('varandinha help tells the stall and the enfeites without naming the classifieds', async (t) => {
  const { HELP } = await import('../src/help.js')
  const paragraphs = HELP.varandinha.paragraphs
  t.is(paragraphs.length, 7)
  t.ok(paragraphs[0].startsWith('As plantas crescem'))
  t.ok(paragraphs[4].includes('Não tem compra, ranking nem prêmio.'))
  const added = paragraphs.slice(5).join(' ')
  t.ok(added.includes('A barraquinha abre aos sábados.'))
  t.ok(added.includes('vaso pronto'))
  t.ok(added.includes('alguém que você segue'))
  t.ok(added.includes('prateleira'))
  t.ok(added.includes('aceita'))
  t.ok(added.includes('sábado seguinte'))
  t.ok(added.includes('enfeites são opcionais'))
  t.ok(added.includes('lista fixa'))
  t.ok(added.includes('públicos'))
  t.ok(added.includes('aparência'))
  t.ok(added.includes('não são um prêmio'))
  t.absent(added.includes('Feira') || added.includes('feira') || added.includes('\u2014') || added.includes('–'))
})

// A restyle that drops a key from makeStyles leaves its users unstyled with
// no error, so every styles.<key> the screens read must still be defined.
test('the Varandinha screens define every style key they read', (t) => {
  const fs = require('fs')
  const path = require('path')
  for (const file of ['Varandinha.js', 'VarandinhaRua.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'screens', file), 'utf8')
    const start = src.indexOf('const makeStyles = ')
    t.ok(start > 0, file + ' has makeStyles')
    const defined = new Set([...src.slice(start).matchAll(/^ {2}([a-zA-Z]+): /gm)].map((m) => m[1]))
    const used = new Set([...src.slice(0, start).matchAll(/\bstyles\.([a-zA-Z]+)/g)].map((m) => m[1]))
    t.ok(used.size > 0, file + ' reads styles')
    for (const key of used) t.ok(defined.has(key), file + ' defines styles.' + key)
  }
})

// Android breaks a line after a hyphen only with hyphenation on. Without it a
// large font split the narrow grid cell's "Espada-de-são-jorge" inside "jorge".
test('the plant grid lets Android break a plant name after its hyphens', (t) => {
  const fs = require('fs')
  const path = require('path')
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'screens', 'Varandinha.js'), 'utf8')
  const name = src.match(/<Text style=\{\[g\.tileName, styles\.plantName\]\}[^>]*>/)
  t.ok(name, 'the grid draws the plant name')
  t.ok(name && name[0].includes("android_hyphenationFrequency='normal'"), 'the name allows hyphen breaks')
})
