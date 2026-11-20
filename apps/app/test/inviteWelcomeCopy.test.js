'use strict'

// Welcome copy for a personal invite (src/inviteWelcomeCopy.js), a pure ES
// module; import() loads it here through Node's module syntax detection.
const test = require('brittle')
const fs = require('fs')
const path = require('path')
const { DESIGNS, REGIONS } = require('@varanda/rpc')

const load = () => import('../src/inviteWelcomeCopy.js')

const UNKNOWN = {
  region: null,
  tag: null,
  tagLabel: null,
  title: 'Tem lugar pra você.',
  line: 'A varanda está aberta.'
}

test('regionOf agrees with REGIONS and rejects unknown ids', async (t) => {
  const { regionOf } = await load()
  let count = 0
  for (const region of REGIONS) {
    for (const design of region.designs) {
      t.is(regionOf(design), region.id, design)
      count++
    }
  }
  t.is(count, 13)
  t.is(DESIGNS.length, 13)
  t.is(regionOf(null), null)
  t.is(regionOf(''), null)
  t.is(regionOf('nao-existe'), null)
  t.is(regionOf(undefined), null)
  t.is(regionOf(1), null)
})

test('DESIGN_LINES covers every design, frozen, one calm sentence each', async (t) => {
  const { DESIGN_LINES, WELCOME_TITLE, WELCOME_NEUTRAL_LINE } = await load()
  t.alike(Object.keys(DESIGN_LINES).sort(), [...DESIGNS].sort())
  t.ok(Object.isFrozen(DESIGN_LINES))
  t.alike({ ...DESIGN_LINES }, {
    marajoara: 'Losangos e espirais, feitos com calma.',
    aguas: 'Dois rios lado a lado, sem pressa.',
    vitoria: 'Folhas largas sobre a água parada.',
    cordel: 'Sol alto e história boa de contar.',
    bandeirinhas: 'As bandeirinhas já estão no alto.',
    chita: 'Flor miúda, cor por todo lado.',
    ipe: 'O ipê abriu, é tempo de visita.',
    pantanal: 'Água rasa e horizonte largo.',
    azulejo: 'Azulejo na parede, café na mesa.',
    copacabana: 'O mar vai e volta, sem cansar.',
    minas: 'Conversa baixa ao pé da serra.',
    araucaria: 'Sombra de araucária e ar frio.',
    chimarrao: 'A cuia está passando na roda.'
  })
  for (const text of [WELCOME_TITLE, WELCOME_NEUTRAL_LINE, ...Object.values(DESIGN_LINES)]) {
    t.ok(text.length >= 1 && text.length <= 44, text)
    t.ok(text.endsWith('.'), text)
    t.absent(text.includes('!'), text)
    t.absent(text.includes('?'), text)
    t.absent(text.includes('\n'), text)
    t.absent(text.includes('\u2014'), text)
  }
})

test('exported strings avoid caricature', async (t) => {
  const copy = await load()
  function checkStrings (value) {
    if (typeof value === 'string') {
      t.absent(value.includes('\u2014'))
      const tokens = value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z]+/)
      t.absent(tokens.some((token) => ['oxe', 'uai', 'tche', 'bah'].includes(token)))
    } else if (value && typeof value === 'object') {
      for (const child of Object.values(value)) checkStrings(child)
    }
  }
  checkStrings(copy)
  for (const design of DESIGNS) checkStrings(copy.welcomeCopy(design))
  checkStrings(copy.welcomeCopy(null))
})

test('welcomeCopy for bandeirinhas names the inviter design', async (t) => {
  const { welcomeCopy } = await load()
  t.alike(welcomeCopy('bandeirinhas'), {
    region: 'nordeste',
    tag: 'Nordeste \u00b7 Bandeirinhas',
    tagLabel: 'Cartão Bandeirinhas, Nordeste',
    title: 'Tem lugar pra você.',
    line: 'As bandeirinhas já estão no alto.'
  })
})

test('welcomeCopy for an unknown design is the neutral welcome', async (t) => {
  const { welcomeCopy } = await load()
  t.alike(welcomeCopy('nao-existe'), UNKNOWN)
  t.alike(welcomeCopy(null), UNKNOWN)
  t.alike(welcomeCopy(''), UNKNOWN)
  t.alike(welcomeCopy(undefined), UNKNOWN)
})

test('welcomeCopy results are fresh and only the welcome fields', async (t) => {
  const { welcomeCopy, WELCOME_TITLE } = await load()
  const keys = ['line', 'region', 'tag', 'tagLabel', 'title']
  const a = welcomeCopy('bandeirinhas')
  const b = welcomeCopy('bandeirinhas')
  t.ok(a !== b)
  t.alike(Object.keys(a).sort(), keys)
  a.line = 'mudou'
  a.title = 'mudou'
  a.tag = 'mudou'
  t.is(b.line, 'As bandeirinhas já estão no alto.')
  t.is(b.title, WELCOME_TITLE)
  t.is(welcomeCopy('bandeirinhas').line, 'As bandeirinhas já estão no alto.')
  const unknownA = welcomeCopy('nao-existe')
  const unknownB = welcomeCopy(null)
  t.ok(unknownA !== unknownB)
  t.alike(unknownA, unknownB)
  t.alike(Object.keys(unknownA).sort(), keys)
})

test('welcome copy module stays free of display text and UI runtimes', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '../src/inviteWelcomeCopy.js'), 'utf8')
  t.ok(source.includes("from './inviteCardCopy.js'"))
  t.absent(source.includes('displayText'))
  t.absent(source.includes("from 'react"))
  t.absent(source.includes('react-native'))
  t.absent(source.includes('\u2014'))
  t.absent(source.includes('require('))
  t.absent(source.includes('Math.random'))
})
