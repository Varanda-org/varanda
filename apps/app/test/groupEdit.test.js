'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const { runInNewContext } = require('vm')

const load = () => import('../src/groupEdit.js')
const screen = (name) => fs.readFileSync(path.join(__dirname, '../src/screens', name), 'utf8')

test('group metadata editing checks the creator and explicit root availability', async (t) => {
  const { editState, GROUP_ROOT_TEXT } = await load()
  t.is(editState({ rootHere: true }, 'creator'), 'edit')
  t.is(editState({ rootHere: false }, 'creator'), 'other-device')
  t.is(editState({}, 'creator'), 'edit', 'older and core nodes omit rootHere')
  t.is(GROUP_ROOT_TEXT, 'Nome, entrada e foto não podem ser mudados neste aparelho.')

  for (const role of ['admin', 'member', 'requested', 'pending', 'left', 'banned', null]) {
    t.is(editState({ rootHere: true }, role), 'none')
    t.is(editState({ rootHere: false }, role), 'none')
  }
})

test('only public groups can choose how people join', async (t) => {
  const { joinOptions } = await load()
  t.alike(joinOptions({ visibility: 'public' }), [
    { value: 'open', label: 'Aberta' },
    { value: 'approval', label: 'Com aprovação' }
  ])
  t.alike(joinOptions({ visibility: 'private', join: 'approval' }), [])
  t.alike(joinOptions({}), [])
})

test('the general group follows the entry policy of its community', async (t) => {
  const { joinOptions } = await load()
  const info = { visibility: 'public', community: 'community-key' }
  t.alike(joinOptions(info, { group: 'general-key', general: 'general-key' }), [])
})

test('other public groups in a community can choose how people join', async (t) => {
  const { joinOptions } = await load()
  const info = { visibility: 'public', community: 'community-key' }
  t.alike(joinOptions(info, { group: 'group-key', general: 'general-key' }), [
    { value: 'open', label: 'Aberta' },
    { value: 'approval', label: 'Com aprovação' }
  ])
})

test('groups in a community wait until the general group is known', async (t) => {
  const { joinOptions } = await load()
  const info = { visibility: 'public', community: 'community-key' }
  t.alike(joinOptions(info, { group: 'group-key', general: undefined }), [])
  t.alike(joinOptions(info, { group: 'group-key', general: null }), [])
})

test('GrupoAjustes gates editing by device and the join choice by public options', (t) => {
  const source = screen('GrupoAjustes.js')
  t.ok(source.includes('const editing = editState(info, role)'))
  t.ok(/\{editing === 'edit'\s*\?\s*\(\s*<View>\s*<OpenRow label='Nome'/.test(source), 'controls require edit permission')
  t.ok(source.includes('const options = joinOptions(info, { group, general })'), 'the join choice receives the group and general keys')
  t.ok(/\{options\.length > 0\s*\?\s*\(\s*<View[^>]*>\s*<Choice\s+label='Entrada'\s+options=\{options\}/.test(source), 'the join choice needs public options')
})

test('GrupoAjustes writes group metadata only when the join choice changes', (t) => {
  const source = screen('GrupoAjustes.js')
  const [, handler] = source.match(/<Choice\s+label='Entrada'[\s\S]*?onChange=\{(\(join\) => [\s\S]*?)\}\s+disabled=/) || []
  t.ok(handler, 'the join choice has a change handler')
  if (!handler) return

  const calls = []
  const group = 'group-key'
  const onChange = runInNewContext('(' + handler + ')', {
    info: { join: 'open' },
    group,
    mutate: (method, params, change) => calls.push([method, { ...params }, { ...change }])
  })
  onChange('open')
  t.alike(calls, [], 'tapping the selected option sends no request')
  calls.length = 0
  onChange('approval')
  t.alike(calls, [['group.meta', { group, join: 'approval' }, { action: 'meta', join: 'approval' }]], 'a new choice sends exactly one request')
})

test('GrupoAjustes clears the name draft only after a rename succeeds', (t) => {
  const source = screen('GrupoAjustes.js')
  t.ok(/if \(r\.ok\) \{\s+if \(change\.name !== undefined\) setNameDraft\(''\)/.test(source), 'direct success preserves the draft for join changes')
  t.ok(/if \(verdict === 'landed'\) \{\s+setCheck\(null\)\s+if \(change\.name !== undefined\) setNameDraft\(''\)/.test(source), 'verified success preserves the draft for join changes')
})

test('ComunidadeInfo excludes the root note from the staff reminder', (t) => {
  const source = screen('ComunidadeInfo.js')
  t.ok(source.includes("{staffNote && staffNote !== 'root' ?"))
})
