'use strict'

// Sobre o Varanda (#50): the license and the encarregado channel, with the
// build lines Ajustes already computes. The contact must not drift from the
// legal texts.
const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const read = (name) => readFileSync(join(__dirname, '../src', name), 'utf8')
const load = () => import('../src/about.js')

test('aboutSections lists the build, the license and the encarregado', async (t) => {
  const { aboutSections, LICENSE_NAME, LICENSE_URL, REPOSITORY } = await load()
  const sections = aboutSections({ appLine: 'Varanda Android, abc1234', serverLine: 'Servidor def5678' })
  t.alike(sections.map((s) => s.title), ['Versão', 'Licença', 'Encarregado de dados'])
  t.alike(sections[0].lines, ['Varanda Android, abc1234', 'Servidor def5678'])
  t.ok(sections[1].lines.some((l) => l.includes(LICENSE_NAME)) && sections[1].lines.includes(LICENSE_URL) && sections[1].lines.includes(REPOSITORY))
  t.ok(/ainda não nomeado/i.test(sections[2].lines[0]), 'says the encarregado is not named yet')
})

test('aboutSections drops missing build lines and keeps the rest', async (t) => {
  const { aboutSections } = await load()
  t.alike(aboutSections({ appLine: 'Varanda web', serverLine: '' })[0].lines, ['Varanda web'])
  t.alike(aboutSections({}).map((s) => s.title), ['Licença', 'Encarregado de dados'], 'no build lines, no Versão section')
  t.alike(aboutSections().map((s) => s.title), ['Licença', 'Encarregado de dados'])
})

test('the license matches the package and the contact matches the legal texts', async (t) => {
  const { LICENSE_NAME, CONTACT } = await load()
  const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'))
  t.is(pkg.license.replace('-', ' ').replace('Noncommercial-', 'Noncommercial '), LICENSE_NAME)
  t.ok(read('legal.js').includes(CONTACT), 'legal.js uses the same address')
})

test('Ajustes opens Sobre from the list and keeps it mounted like the other sub-screens', (t) => {
  const src = read('screens/Ajustes.js')
  t.ok(src.includes('sobre: ABOUT_TITLE,'), 'the sheet title')
  t.ok(src.includes("<Item icon='info' label={ABOUT_TITLE} onPress={() => onNavigate('sobre')} />"), 'a row in the list')
  t.ok(src.includes("<View style={shown('sobre')}>\n          <Sobre appLine={lines.appLine} serverLine={lines.serverLine} />"), 'the screen gets the footer lines')
  t.ok(src.indexOf("onNavigate('termos')") < src.indexOf("onNavigate('sobre')"), 'after Termos e privacidade')
})
