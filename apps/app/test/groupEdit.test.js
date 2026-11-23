'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const { runInNewContext } = require('vm')
const { MAX_GROUP_ABOUT } = require('@varanda/rpc')

const load = () => import('../src/groupEdit.js')
const screen = (name) => fs.readFileSync(path.join(__dirname, '../src/screens', name), 'utf8')

test('aboutReady trims, detects changes and clears with null', async (t) => {
  const { aboutReady } = await load()
  t.alike(aboutReady('  Livros e conversas  ', null), { value: 'Livros e conversas', ok: true })
  t.alike(aboutReady(' Livros ', 'Livros'), { value: 'Livros', ok: false })
  t.alike(aboutReady('  ', 'Livros'), { value: null, ok: true })
  t.alike(aboutReady('', null), { value: null, ok: false })
})

test('aboutReady counts Unicode code points and requires a single line', async (t) => {
  const { ABOUT_MAX, aboutReady } = await load()
  t.is(ABOUT_MAX, MAX_GROUP_ABOUT)
  const atLimit = '📚'.repeat(ABOUT_MAX)
  t.alike(aboutReady(atLimit, null), { value: atLimit, ok: true })
  t.alike(aboutReady(atLimit + 'a', null), { value: atLimit + 'a', ok: false })
  for (const br of ['\n', '\r', '\v', '\f', '\u0085', '\u2028', '\u2029']) {
    t.alike(aboutReady('a' + br + 'b', null), { value: 'a' + br + 'b', ok: false })
  }
  t.alike(aboutReady('Livros\n', null), { value: 'Livros', ok: false })
  for (const ch of ['\t', '\u0000', '\u001b', '\u007f', '\u009f', '\u202a', '\u202e', '\u2066', '\u2069']) {
    t.is(aboutReady('a' + ch + 'b', null).ok, false, 'the node refuses U+' + ch.codePointAt(0).toString(16).padStart(4, '0'))
  }
  t.is(aboutReady('a\u00a0b \u200d \u2030', null).ok, true, 'other characters pass')
})

test('group metadata editing checks the creator and explicit root availability', async (t) => {
  const { editState, GROUP_ROOT_TEXT, GROUP_CHARTER_WAIT_TEXT, GROUP_CHARTER_ENDED_TEXT } = await load()
  t.is(editState({ rootHere: true }, 'creator'), 'edit')
  t.is(editState({ rootHere: false }, 'creator'), 'other-device')
  t.is(editState({}, 'creator'), 'edit', 'older and core nodes omit rootHere')
  t.is(GROUP_ROOT_TEXT, 'Nome, descrição, entrada e foto não podem ser mudados neste aparelho.')
  t.absent(GROUP_CHARTER_WAIT_TEXT.includes('\u2014'))
  t.absent(GROUP_CHARTER_ENDED_TEXT.includes('\u2014'))
  t.is(GROUP_CHARTER_WAIT_TEXT, 'Este aparelho ainda não pode mudar nome, descrição, entrada e foto. Aguarde a sincronização.')
  t.is(GROUP_CHARTER_ENDED_TEXT, 'Nome, descrição, entrada e foto deste grupo não podem mais ser mudados.')

  const here = { role: 'creator', rootHere: false, charterHere: true }
  t.is(editState(here, 'creator'), 'edit')
  t.is(editState({ ...here, charterHere: false }, 'creator'), 'wait')
  t.is(editState({ ...here, charterHere: false, rootAuthority: false }, 'creator'), 'ended')
  t.is(editState({ rootHere: true, charterHere: false }, 'creator'), 'wait', 'a false charter does not fall back to the root')
  t.is(editState({ rootHere: false }, 'creator'), 'other-device', 'an info without charterHere keeps the root rule')
  t.is(editState(here, 'admin'), 'none', 'an admin who is not the creator still gets no rename')

  for (const role of ['admin', 'member', 'requested', 'pending', 'left', 'banned', null]) {
    t.is(editState({ rootHere: true }, role), 'none')
    t.is(editState({ rootHere: false }, role), 'none')
    t.is(editState({ rootHere: false, charterHere: true }, role), 'none')
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
  t.ok(source.includes("editing === 'other-device'") && source.includes('GROUP_ROOT_TEXT'))
  t.ok(source.includes("editing === 'wait'") && source.includes('GROUP_CHARTER_WAIT_TEXT'))
  t.ok(source.includes("editing === 'ended'") && source.includes('GROUP_CHARTER_ENDED_TEXT'))
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

test('GrupoAjustes verifies an uncertain description write with group.info and does not resend', async (t) => {
  const { reconcile } = await import('../src/groups.js')
  const source = screen('GrupoAjustes.js')
  const handlers = source.slice(source.indexOf('  const verify = '), source.indexOf('  // Pages group.members'))
  const saveAbout = source.split('\n').find((line) => line.startsWith('  const saveAbout = '))
  const group = 'group-key'
  const about = 'Livros e conversas'
  const info = { about }
  const calls = []
  const checks = []
  const views = []
  const drafts = []
  const save = runInNewContext(handlers + saveAbout + '\nsaveAbout', {
    group,
    request: async (method, params) => {
      calls.push([method, { ...params }])
      if (method === 'group.about') throw Object.assign(new Error('timeout'), { uncertain: true })
      if (method === 'group.info') return info
      throw new Error('Unexpected request: ' + method)
    },
    act: {
      run: async (fn) => {
        try {
          return { ok: true, value: await fn() }
        } catch (err) {
          return { ok: false, uncertain: err.uncertain === true }
        }
      }
    },
    reconcile: (change, view) => {
      views.push({ ...view })
      return reconcile(change, view)
    },
    setInfo: () => {},
    setConfirm: () => {},
    setCheck: (check) => checks.push(check),
    setAboutDraft: (draft) => drafts.push(draft)
  })
  await save(about)
  await new Promise(setImmediate)
  t.alike(calls, [['group.about', { group, about }], ['group.info', { group }]])
  t.alike(views, [{ info }])
  t.alike(checks, [null, null], 'the recorded description clears the uncertainty')
  t.alike(drafts, [null])
})

test('ComunidadeInfo renders charter wait and ended apart from the staff reminder', (t) => {
  const source = screen('ComunidadeInfo.js')
  t.ok(source.includes("staffNote === 'root' || staffNote === 'wait' || staffNote === 'ended'"))
  t.ok(source.includes('DEVICE_CHARTER_WAIT_TEXT') && source.includes('DEVICE_CHARTER_ENDED_TEXT') && source.includes('DEVICE_ROOT_TEXT'))
  t.ok(source.includes("staffNote !== 'root' && staffNote !== 'wait' && staffNote !== 'ended'"))
})

test('the description control shows only when the node reports about, and a refusal blocks the save', (t) => {
  for (const name of ['GrupoAjustes.js', 'ComunidadeInfo.js']) {
    const source = screen(name)
    t.ok(source.includes('{info.about !== undefined && ('), name + ': an older node that omits about shows no control')
    const button = source.slice(source.indexOf("<Btn label='Salvar descrição'"))
    const disabled = button.slice(button.indexOf('disabled={'), button.indexOf('pending='))
    t.ok(disabled.includes('!about.ok'), name + ': an invalid description disables the save')
    t.ok(disabled.includes("aboutRefused !== ''"), name + ': a refused word disables the save')
  }
})
