'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')

test('the profile header keeps its actions on one row', (t) => {
  const src = read('ui/ProfileHeader.js')
  t.ok(src.includes("flexWrap: 'nowrap'"), 'actions row does not wrap')
  t.ok(src.includes('flexBasis: 0'), 'pills share the width')
  t.ok(src.includes('more'), 'draws a more element')
})

test('the profile header stacks its pills at large text instead of breaking words', (t) => {
  const src = read('ui/ProfileHeader.js')
  t.ok(src.includes('useWindowDimensions().fontScale > STACK_SCALE'), 'decided by the font scale')
  t.ok(/actionsStacked: \{ flexDirection: 'column', alignItems: 'stretch'/.test(src), 'full-width column')
  t.ok(src.includes('stacked ? styles.actionsStacked : styles.actions'), 'one row at normal size')
})

test('another person profile moves secondary actions into the overflow', (t) => {
  const src = read('screens/Membro.js')
  t.ok(src.includes('<MoreButton'), 'uses MoreButton')
  t.ok(/label: 'Denunciar a conta', danger: true/.test(src), 'report row is danger')
  t.ok(src.includes("label: 'Compartilhar perfil'"), 'share row')
  t.ok(src.includes('.slice(0, 2)'), 'at most two pills')
  t.absent(/<Pill\s+label='denunciar a conta'/.test(src), 'no report pill')
})

test('the own diary uses two pills and an icon-only share', (t) => {
  const src = read('screens/Diario.js')
  t.ok(src.includes("icon='compartilhar' accessibilityLabel='compartilhar perfil'"), 'icon-only share')
  t.ok(src.includes("icon='lixeira' accessibilityLabel='apagar'"), 'icon-only delete')
  t.ok(src.includes("label='Enviar tudo'"), 'Enviar tudo')
})

test('a shared profile link names the @nome only once it is verified', (t) => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'screens', 'Membro.js'), 'utf8')
  t.ok(src.includes('username: header.verified === true ? header.username || null : null'), 'a seed or stale @nome falls back to the key link')
})

test('one follower is "1 seguidor"', (t) => {
  const fs = require('fs')
  const path = require('path')
  for (const f of ['Diario.js', 'Membro.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'screens', f), 'utf8')
    t.ok(/seguidores === 1 \? 'seguidor' : 'seguidores'/.test(src), f)
  }
})

test('the Anúncios row is a link above the tabs, and the page actions have icons', (t) => {
  const src = read('screens/Membro.js')
  const i = src.indexOf('const listingsRow')
  const row = src.slice(i, src.indexOf('const ratingsRow'))
  t.ok(row.includes("accessibilityRole='link'"), 'link role')
  t.ok(row.includes("<Icon name='seta'"), 'chevron')
  const header = read('ui/ProfileHeader.js')
  t.ok(header.indexOf('{rows || null}') !== -1 && header.indexOf('{rows || null}') < header.indexOf('{tabs || null}'), 'rows render before the tabs')
  for (const label of ['Agir como esta página', 'Deixar de agir como a página', 'Ajustes da página', 'Seguir como a página', 'Deixar de seguir como a página', 'Compartilhar perfil']) {
    const at = src.indexOf(label)
    t.ok(at !== -1 && /icon: /.test(src.slice(src.lastIndexOf('{', at) - 0, at)), label + ' has an icon')
  }
})

test('stacked pills keep the more button on the last pill row', (t) => {
  const src = read('ui/ProfileHeader.js')
  t.ok(src.includes('lastStacked'), 'last row wrapper')
  t.ok(src.includes('if (stacked && last && more)'), 'the last stacked pill takes the more button beside it')
  t.ok(src.includes('!(stacked && shownActions.length > 0)'), 'the more button is not repeated alone below the pills')
})
