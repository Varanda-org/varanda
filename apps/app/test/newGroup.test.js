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
  t.ok(/<NovoGrupo\s+community=\{groupForm\?\.community \?\? null\}\s+standalone=\{groupForm !== null && groupForm\.community === null\}\s+visible=\{pageKey === null && groupForm !== null\}/.test(source), 'the group form is hidden on a Page and opens without community')
  t.ok(source.includes("setGroupForm({ community: typeof community === 'string' ? community : null })"), 'picking no community opens the form instead of closing it')
  t.ok(source.includes('if (groupKey !== null) onOpenGroup(groupKey)') && source.includes('else if (community !== null && typeof onOpenCommunity'), 'a created group opens; only a community group falls back to its community')
})

test('Conversas resets group creation and its notice when the acting page changes', (t) => {
  const [, reset = ''] = conversas().match(/useEffect\(\(\) => \{\s+if \(pageKey !== null\) setPickingGroupCommunity\(false\)([\s\S]*?)\n\s*\}, \[pageKey\]\)/) || []
  t.ok(reset.includes('setGroupForm(null)'), 'the page change closes the group form')
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

const key = (c) => c.repeat(64)
const usage = () => Object.assign(new Error('método desconhecido'), { code: require('@varanda/rpc').USAGE })

test('readStandalone pages every group.standalone answer and keeps member rows', async (t) => {
  const { readStandalone } = await import('../src/groups.js')
  const calls = []
  const pages = [
    { groups: [{ group: key('a'), name: 'A', role: 'creator' }, { group: key('b'), name: 'B', role: 'requested' }], total: 3 },
    { groups: [{ group: key('c'), name: 'C', role: 'member' }, { group: 'bad', role: 'member' }], total: 3 }
  ]
  const read = await readStandalone(async (method, params) => { calls.push([method, params]); return pages.shift() })
  t.alike(calls, [['group.standalone', {}], ['group.standalone', { offset: 2 }]])
  t.is(read.complete, true)
  t.alike(read.groups.map((g) => [g.group, g.community]), [[key('a'), null], [key('c'), null]])
})

test('readStandalone treats an older node as no rows and other failures as partial', async (t) => {
  const { readStandalone } = await import('../src/groups.js')
  t.alike(await readStandalone(async () => { throw usage() }), { groups: [], complete: true })
  t.alike(await readStandalone(async () => { throw new Error('rede') }), { groups: [], complete: false })
  t.alike(await readStandalone(async () => ({ groups: [] })), { groups: [], complete: false })
  t.alike(await readStandalone(async () => ({ groups: [], total: 4 })), { groups: [], complete: false })
})

test('an uncertain create without community confirms only a new key with the name', async (t) => {
  const { standaloneCreateView, createdStandaloneKey } = await load()
  const { reconcile } = await import('../src/groups.js')
  const change = { action: 'create', community: null, name: 'Horta' }
  const old = { group: key('a'), name: 'Horta', role: 'creator' }
  const fresh = { group: key('b'), name: 'Horta', role: 'creator' }
  const before = { groups: [old], complete: true }
  const landed = standaloneCreateView(before, { groups: [old, fresh], complete: true })
  t.is(reconcile(change, landed), 'landed')
  t.is(createdStandaloneKey(landed, 'Horta'), key('b'))
  const missing = standaloneCreateView(before, { groups: [old], complete: true })
  t.is(reconcile(change, missing), 'not-landed')
  t.is(createdStandaloneKey(missing, 'Horta'), null)
  t.is(reconcile(change, standaloneCreateView({ groups: [old], complete: false }, { groups: [old, fresh], complete: true })), 'unknown', 'an incomplete before read proves nothing')
  t.is(reconcile(change, standaloneCreateView(before, { groups: [old], complete: false })), 'unknown')
  const locked = { group: key('c'), name: null, role: 'creator' }
  t.is(reconcile(change, standaloneCreateView(before, { groups: [old, locked], complete: true })), 'unknown', 'a new private group whose name reads null is never not-landed')
  t.is(reconcile(change, standaloneCreateView(before, { groups: [old, locked, fresh], complete: true })), 'unknown', 'two new creator rows cannot tell which is this create')
})

test('withStandaloneRows adds groups without community once, titled by name', async (t) => {
  const { withStandaloneRows } = await load()
  const community = { group: key('a'), community: key('c'), role: 'member' }
  const rows = withStandaloneRows([community], [
    { group: key('a'), name: 'dup', role: 'member', community: null },
    { group: key('b'), name: 'Horta', role: 'creator', community: null },
    { group: key('b'), name: 'Horta again', role: 'creator', community: null },
    { group: key('d'), name: null, role: 'member', community: null }
  ])
  t.alike(rows.map((r) => [r.group, r.community, r.title]), [[key('a'), key('c'), undefined], [key('b'), null, 'Horta'], [key('d'), null, undefined]])
})

test('Conversas lists group.standalone rows and keeps partial', (t) => {
  const source = conversas()
  t.ok(source.includes('const standalone = await readStandalone(requestRef.current)'), 'the tab reads the groups without community')
  t.ok(/if \(!standalone\.complete\) \{\s+partial = true\s+[\s\S]*?missed\.add\(null\)/.test(source), 'a partial standalone read keeps the list partial and its stored rows')
  t.ok(source.includes('const all = withStandaloneRows(rows, standalone.groups)') && source.includes('rowsForStorage(all)'), 'the merged rows are shown and stored')
  t.ok(source.includes("body='Os seus grupos aparecem aqui.'"))
  t.ok(/if \(!standalone\.complete\) \{\s+partial = true\s+[^}]*failed = true/.test(source), 'an incomplete standalone read never lets the dot say nothing unread')
  t.ok(source.includes("import { readStandalone } from '../groups'"), 'the pager comes from groups.js')
})

test('the chooser offers a group without community above the communities, with no gate', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '../src/screens/NovoGrupoComunidade.js'), 'utf8')
  t.ok(source.includes('{standaloneRow}{body}'), 'the row sits above every state, empty and error included')
  t.ok(/const pickStandalone = \(\) => \{[^}]*onPick\(null\)/.test(source), 'picking it calls onPick(null) with no community.info gate')
  t.ok(source.includes("<HelpNote key='standalone' doc={STANDALONE_ROW_DOC}>"), 'the explanation sits behind the (i)')
})

test('NovoGrupo sends no community when standalone and reconciles from group.standalone', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '../src/screens/NovoGrupo.js'), 'utf8')
  t.ok(source.includes("(standalone === true || typeof community === 'string')"), 'ready needs no community string when standalone')
  t.ok(source.includes('if (standalone !== true) params.community = community'), 'group.create omits community when standalone')
  t.ok(source.includes('session.before = standalone === true ? await readStandalone(node.request) : null'), 'the keys before the create are read first')
  t.ok(source.includes('standaloneCreateView(session.before, await readStandalone(node.request))') && source.includes('STANDALONE_UNKNOWN_NOTE'), 'the check uses the standalone reconcile')
  t.is((source.match(/'group\.create'/g) || []).length, 1, 'group.create is sent from one place only, never retried')
})

test('the chooser help does not promise Descobrir yet', async (t) => {
  const { STANDALONE_ROW_HELP, STANDALONE_ROW_DOC } = await load()
  t.is(STANDALONE_ROW_HELP, 'Qualquer pessoa pode criar.')
  t.alike(STANDALONE_ROW_DOC.paragraphs, [STANDALONE_ROW_HELP])
  t.absent('readStandalone' in await load(), 'no re-export: callers import it from groups.js')
})
