'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const load = () => import('../src/newGroup.js')
const conversas = () => fs.readFileSync(path.join(__dirname, '../src/screens/Conversas.js'), 'utf8')
const comunidade = () => fs.readFileSync(path.join(__dirname, '../src/screens/Comunidade.js'), 'utf8')
const creator = { role: 'creator', state: 'ready' }
const hidden = { show: false, enabled: false, reason: '' }
const allowed = { show: true, enabled: true, reason: '' }

test('creatorCommunities keeps ready creator rows in list order', async (t) => {
  const { creatorCommunities } = await load()
  const first = { ...creator, community: 'a' }
  const last = { ...creator, community: 'b' }
  t.alike(creatorCommunities([
    null,
    first,
    { ...creator, state: 'pending' },
    { role: 'creator' },
    { role: 'admin', state: 'ready' },
    { role: 'member', state: 'ready' },
    last
  ]), [first, last])
  t.alike(creatorCommunities([]), [])
  t.alike(creatorCommunities(null), [])
  t.alike(creatorCommunities({ communities: [first] }), [])
})

test('newGroupCount includes dropped groups and requires both arrays', async (t) => {
  const { newGroupCount } = await load()
  t.is(newGroupCount({ groups: ['geral', 'group'], dropped: ['dropped'] }), 3)
  t.is(newGroupCount({ groups: [], dropped: [] }), 0)
  t.is(newGroupCount({ groups: [], dropped: null }), null)
  t.is(newGroupCount({ groups: 'invalid', dropped: [] }), null)
  t.is(newGroupCount({ groups: [] }), null)
  t.is(newGroupCount({ dropped: [] }), null)
  t.is(newGroupCount(undefined), null)
})

test('newGroupGate hides pending information and roles other than creator', async (t) => {
  const { newGroupGate } = await load()
  t.alike(newGroupGate(null), hidden)
  t.alike(newGroupGate('creator'), hidden)
  t.alike(newGroupGate({ ...creator, state: 'pending' }), hidden)
  t.alike(newGroupGate({ role: 'admin', state: 'pending' }), hidden)
  t.alike(newGroupGate({ role: 'member', state: 'ready' }), hidden)
  t.alike(newGroupGate({}), hidden)
  t.alike(newGroupGate({ role: 'admin', state: 'ready' }), {
    ...hidden,
    reason: 'Só quem criou a comunidade cria grupos.'
  })
})

test('newGroupGate checks device before root authority and capacity', async (t) => {
  const { newGroupGate } = await load()
  const wrongDevice = { show: true, enabled: false, reason: 'Novo grupo só funciona no aparelho que criou a comunidade.' }
  const noAuthority = { show: true, enabled: false, reason: 'Esta comunidade não recebe mais grupos novos.' }
  const full = { ...creator, groups: Array(32).fill('group'), dropped: [] }
  t.alike(newGroupGate({ ...creator, rootHere: false }), wrongDevice)
  t.alike(newGroupGate({ ...full, rootHere: false, rootAuthority: false }), wrongDevice)
  t.alike(newGroupGate({ ...creator, rootAuthority: false }), noAuthority)
  t.alike(newGroupGate({ ...full, rootHere: true, rootAuthority: false }), noAuthority)
})

test('newGroupGate allows core responses and blocks creators at or above 32 slots', async (t) => {
  const { NEW_GROUP_LIMIT, newGroupGate } = await load()
  const full = { show: true, enabled: false, reason: 'A comunidade chegou ao limite de 32 grupos.' }
  const groups = Array(31).fill('group')
  t.is(NEW_GROUP_LIMIT, 32)
  t.alike(newGroupGate(creator), allowed)
  t.alike(newGroupGate({ ...creator, groups, dropped: [] }), allowed)
  t.alike(newGroupGate({ ...creator, rootHere: true, rootAuthority: true, groups, dropped: ['dropped'] }), full)
  t.alike(newGroupGate({ ...creator, groups: [...groups, 'another'], dropped: [] }), full)
  t.alike(newGroupGate({ ...creator, groups: [...groups, 'another'], dropped: ['dropped'] }), full)
})

test('Conversas opens the group picker for the personal profile and keeps the Page entry point', (t) => {
  const source = conversas()
  t.ok(source.includes('onNewGroup={pageKey === null'), 'only the personal action opens the picker')
  t.ok(source.includes(": typeof onOpenCommunities === 'function' ? () => onOpenCommunities() : undefined}"), 'the Page action opens communities')
  t.ok(/<NovoGrupoComunidade\s+open=\{pageKey === null && pickingGroupCommunity\}/.test(source), 'the picker is hidden on a Page')
  t.ok(/<NovoGrupo\s+community=\{groupCommunity\}\s+visible=\{pageKey === null && groupCommunity !== null\}/.test(source), 'the group form is hidden on a Page')
})

test('Conversas resets group creation and its notice when the acting page changes', (t) => {
  const [, reset = ''] = conversas().match(/useEffect\(\(\) => \{\s+if \(pageKey !== null\) setPickingGroupCommunity\(false\)([\s\S]*?)\n\s*\}, \[pageKey\]\)/) || []
  t.ok(reset.includes('setGroupCommunity(null)'), 'the page change closes the group form')
  t.ok(reset.includes('setCreatedGroupNotice(null)'), 'the page change clears the group notice')
})

test('Comunidade wires group creation and its availability to the groups header', (t) => {
  const source = comunidade()
  t.ok(/const gate = newGroupGate\(info\)\s+const canCreate = isMember && can\('create', role\) && gate\.show && gate\.enabled/.test(source), 'creation requires membership, permission and an enabled gate')
  t.ok(source.includes("<SectionHeader right={canCreate ? <Pill label='Novo grupo' onPress={() => { setCreateNote(null); setNewGroup(true) }} disabled={offline} /> : null}>"), 'the header holds the creation action and disables it offline')
  t.ok(source.includes("{groupCount === null ? 'Grupos' : 'Grupos · ' + groupCount + ' de ' + NEW_GROUP_LIMIT}"), 'the header includes the count and limit when known')
  t.ok(source.includes("{isMember && !canCreate && gate.reason !== '' ? <View style={styles.block}><Soft>{gate.reason}</Soft></View> : null}"), 'members see a reason when creation is unavailable and the gate gives one')
  t.absent(/<Btn\s+label=['"]Novo grupo['"]/.test(source), 'the old bottom creation button is gone')
})
