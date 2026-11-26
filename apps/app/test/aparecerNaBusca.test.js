'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const settings = readFileSync(join(__dirname, '../src/screens/Ajustes.js'), 'utf8')
const sheet = readFileSync(join(__dirname, '../src/screens/AparecerNaBusca.js'), 'utf8')
const help = readFileSync(join(__dirname, '../src/help.js'), 'utf8')

test('the hosted settings list opens the account search sheet after the public groups row', (t) => {
  t.ok(/\{hosted \? <Item[^\n]+label=\{GROUPS_SHOW_TITLE\}[^\n]+\n\s*\{hosted \? <Item icon='lupa' label=\{SEARCH_SHOW_TITLE\} onPress=\{\(\) => setSearchShowOpen\(true\)\} \/> : null\}/.test(settings))
  t.ok(settings.includes("const searchShowActive = hosted && screen === 'lista' && searchShowOpen"))
  t.ok(settings.includes('<SearchShowSheet open={searchShowActive}'))
  t.ok(sheet.includes("export const SEARCH_SHOW_TITLE = 'Aparecer na busca'"))
  t.ok(sheet.includes('<HelpNote doc={HELP.aparecerNaBusca}>'), 'the explanation opens from the (i)')
  t.ok(help.includes('aparecerNaBusca: Object.freeze({'))
  for (const src of [settings, sheet, help]) t.absent(src.includes('\u2014'))
})

test('the sheet reads the own choice before offering a switch, and a failed read offers no guess', (t) => {
  t.ok(sheet.includes("requestRef.current('search.state', {})"))
  t.ok(/on !== null\s*\? <SwitchRow/.test(sheet))
  t.ok(sheet.includes('Não foi possível ler agora.'))
  t.ok(sheet.includes("label='Tentar de novo' onPress={retry}"))
  t.ok(sheet.includes('node.online === false || act.pending'))
  t.absent(/Platform\.OS/.test(sheet))
})

test('a change sends one RPC and an uncertain result only re-reads', (t) => {
  const change = sheet.match(/^ {2}const change = async \(next\) => \{[\s\S]*?^ {2}\}/m)?.[0] || ''
  t.is((sheet.match(/'search\.show'/g) || []).length, 1)
  t.ok(change.includes("act.run(() => node.request('search.show', { on: next }))"))
  t.ok(/else if \(result\.uncertain\) \{\s*setOn\(null\)\s*retry\(\)\s*\}/.test(change))
  t.absent(/\b(?:for|while)\s*\(|change\(/.test(change))
})
