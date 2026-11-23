'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const settings = readFileSync(join(__dirname, '../src/screens/Ajustes.js'), 'utf8')

test('the hosted settings list opens the public groups sheet after the wall row', (t) => {
  t.ok(settings.includes('const hosted = node.hosted === true'))
  t.ok(/\{hosted \? <Item[^\n]+label=\{WALL_TITLE\}[^\n]+\n\s*\{hosted \? <Item[^\n]+label=\{GROUPS_SHOW_TITLE\} onPress=\{openGroupsShow\} \/> : null\}/.test(settings))
  t.ok(settings.includes("const GROUPS_SHOW_TITLE = 'Grupos públicos no perfil'"))
  t.ok(settings.includes("const GROUPS_SHOW_LABEL = 'Mostrar no meu perfil os grupos públicos de que participo'"))
  t.ok(settings.includes('Desligado, o seu perfil não lista esses grupos e você não entra na conta de Grupos de quem você segue de outras pessoas. Dentro de cada grupo público a sua participação continua pública.'))
  t.absent(settings.includes('\u2014'))
})

test('the sheet reads the own diary before offering a switch', (t) => {
  t.ok(settings.includes('const ownKey = own.key'))
  t.ok(settings.includes('fetchStandaloneGroupsOf(ownKey)'))
  t.ok(settings.includes('if (res.ok) setGroupsShow(!res.value.hidden)'))
  t.ok(/groupsShow !== null\s*\? <SwitchRow/.test(settings))
  t.ok(settings.includes('Não foi possível ler agora.'))
  t.ok(settings.includes("label='Tentar de novo' onPress={retryGroupsShow}"))
  t.ok(settings.includes('node.online === false || groupsShowAct.pending'))
})

test('a change sends one RPC and an uncertain result only re-reads', (t) => {
  const change = settings.match(/^ {2}const changeGroupsShow = async \(on\) => \{[\s\S]*?^ {2}\}/m)?.[0] || ''
  t.is((settings.match(/'groups\.show'/g) || []).length, 1)
  t.ok(change.includes("groupsShowAct.run(() => node.request('groups.show', { on }))"))
  t.ok(/else if \(result\.uncertain\) \{\s*setGroupsShow\(null\)\s*retryGroupsShow\(\)\s*\}/.test(change))
  t.absent(/\b(?:for|while)\s*\(|changeGroupsShow\(/.test(change))
  t.ok(settings.includes('<ErrorText>{groupsShowAct.error}</ErrorText>'))
})
