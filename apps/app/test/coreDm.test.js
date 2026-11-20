'use strict'

// src/coreDm.js: the Conversas screens on a core node (#352).
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')

const load = () => import('../src/coreDm.js')
const usage = (message) => Object.assign(new Error(message), { code: 'USAGE' })

function coreNode (answer) {
  const calls = []
  const request = async (method, params) => {
    calls.push(method)
    const a = typeof answer === 'function' ? answer(method, params) : answer
    if (a instanceof Error) throw a
    return a
  }
  return { hosted: false, accountOrigin: 'https://conta.example.org', request, calls }
}

test('probeCoreDm reads the node answer to one dm.list', async (t) => {
  const { probeCoreDm, CORE_DM_NONE, CORE_DM_OFF } = await load()
  t.is(await probeCoreDm(coreNode(usage(CORE_DM_NONE))), 'none', 'no engine: today')
  t.is(await probeCoreDm(coreNode(usage(CORE_DM_OFF))), 'off', 'an engine never enabled')
  t.is(await probeCoreDm(coreNode({ conversations: [] })), 'on')
  t.is(await probeCoreDm(coreNode(usage('lista de bloqueio ilegível neste aparelho'))), 'on', 'its own refusal shows on the screen')
  const hosted = coreNode({})
  t.is(await probeCoreDm({ ...hosted, hosted: true }), 'hosted')
  t.is(hosted.calls.length, 0, 'a hosted node is never asked')
  const flaky = coreNode(Object.assign(new Error('fechado'), { code: 'CLOSED' }))
  await t.exception(probeCoreDm(flaky), /fechado/, 'a failure is neither answer')
})

test('the probe is kept per node and asked again after forgetCoreDm', async (t) => {
  const { probeCoreDm, forgetCoreDm, CORE_DM_OFF } = await load()
  let enabled = false
  const node = coreNode(() => (enabled ? {} : usage(CORE_DM_OFF)))
  t.is(await probeCoreDm(node), 'off')
  t.is(await probeCoreDm(node), 'off')
  t.is(node.calls.length, 1, 'kept')
  enabled = true
  forgetCoreDm(node)
  t.is(await probeCoreDm(node), 'on', 'after dm.enable')
  t.is(node.calls.length, 2)
  const failing = coreNode(Object.assign(new Error('fechado'), { code: 'CLOSED' }))
  await t.exception(probeCoreDm(failing))
  await t.exception(probeCoreDm(failing))
  t.is(failing.calls.length, 2, 'a failure is not kept')
})

test('dmScreenGate: hosted by the passkey, core by the probe', async (t) => {
  const { dmScreenGate } = await load()
  t.alike(dmScreenGate({ hosted: true, unlocked: true, core: 'hosted' }), { ready: true, locked: false, activate: false })
  t.alike(dmScreenGate({ hosted: true, unlocked: false, core: 'hosted' }), { ready: false, locked: true, activate: false })
  t.alike(dmScreenGate({ hosted: false, unlocked: false, core: 'on' }), { ready: true, locked: false, activate: false }, 'no passkey on core')
  t.alike(dmScreenGate({ hosted: false, unlocked: false, core: 'off' }), { ready: false, locked: false, activate: true })
  for (const core of ['none', null]) t.alike(dmScreenGate({ hosted: false, unlocked: false, core }), { ready: false, locked: false, activate: false }, String(core) + ': today')
})

test('the activation text keeps the Terms core-node sentence', async (t) => {
  const { CORE_DM_ACTIVATE_NOTE } = await load()
  const legal = fs.readFileSync(path.join(__dirname, '../src/legal.js'), 'utf8')
  t.ok(legal.includes('sem nenhuma passkey que as proteja'), 'the Terms say no passkey protects them')
  t.ok(/arquivo neste aparelho, sem passkey/.test(CORE_DM_ACTIVATE_NOTE))
  t.ok(CORE_DM_ACTIVATE_NOTE.includes('quem perder essa pasta perde estas Conversas'))
  const engine = fs.readFileSync(path.join(__dirname, '../../../packages/web-member/lib/core-dm.js'), 'utf8')
  const session = fs.readFileSync(path.join(__dirname, '../../../packages/core/lib/session.js'), 'utf8')
  const { CORE_DM_OFF, CORE_DM_NONE } = await load()
  t.ok(engine.includes("const DM_OFF = '" + CORE_DM_OFF + "'"))
  t.ok(session.includes("const DM_WEB_ONLY = '" + CORE_DM_NONE + "'"))
})

test('Conversas, Mensagens and Mensagem open on a core node through the gate, not hosted && unlocked', (t) => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '../src/screens', f), 'utf8')
  for (const f of ['Conversas.js', 'Mensagens.js', 'Mensagem.js']) {
    const src = read(f)
    t.ok(src.includes('dmScreenGate({ hosted, unlocked, core: core.state })'), f)
    t.absent(src.includes('const ready = hosted && unlocked'), f + ': no hosted-only ready')
  }
  t.absent(read('Conversas.js').includes('if (!hosted) return'), 'the list is not hosted-only')
  t.ok(read('Mensagem.js').includes('if (!gate.ready) {'), 'the thread opens on a ready core node')
})

test('probeCorePageGroups: today a core node refuses group.read as a Página; with PR 7 it reads', async (t) => {
  const { probeCorePageGroups, CORE_DM_NONE } = await load()
  const P = 'ab'.repeat(32)
  const today = coreNode(usage(CORE_DM_NONE))
  t.is(await probeCorePageGroups(today, P), 'none', 'USAGE today: groups stay unavailable')
  const pr7 = coreNode((method, params) => (method === 'group.read' && params.page === P ? { items: [], next: null } : new Error('x')))
  t.is(await probeCorePageGroups(pr7, P), 'on', 'a read')
  t.is(await probeCorePageGroups(coreNode(Object.assign(new Error('grupo não encontrado'), { code: 'NOT_FOUND' })), P), 'on', 'a refusal for that group is still a read')
  t.is(await probeCorePageGroups(pr7, P), 'on')
  t.is(pr7.calls.length, 1, 'kept per node')
  t.is(await probeCorePageGroups({ ...today, hosted: true }, P), 'hosted')
  t.is(await probeCorePageGroups(coreNode({}), null), 'none', 'not a Página')
  await t.exception(probeCorePageGroups(coreNode(Object.assign(new Error('fechado'), { code: 'CLOSED' })), P))
})

test('groupScreenOpen: hosted always; core only as a Página that reads groups', async (t) => {
  const { groupScreenOpen } = await load()
  const page = { page: true, key: 'ab'.repeat(32) }
  const self = { page: false, key: null }
  t.is(groupScreenOpen({ hosted: true, asPage: self, core: 'hosted' }), true)
  t.is(groupScreenOpen({ hosted: false, asPage: page, core: 'on' }), true)
  t.is(groupScreenOpen({ hosted: false, asPage: page, core: 'none' }), false, 'today')
  t.is(groupScreenOpen({ hosted: false, asPage: page, core: null }), false, 'unknown')
  t.is(groupScreenOpen({ hosted: false, asPage: self, core: 'on' }), false, 'personal groups stay hosted-only')
  const src = fs.readFileSync(path.join(__dirname, '../src/screens/Grupo.js'), 'utf8')
  t.ok(src.includes('const open = groupScreenOpen({ hosted, asPage, core: coreGroups })'))
  t.ok(src.includes('if (!open) {'), 'the screen opens through the gate')
  t.absent(src.includes('    if (!hosted) return\n    const mine = ++seqRef.current'), 'the load is not hosted-only')
})
