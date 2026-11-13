'use strict'

const test = require('brittle')
const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

const load = () => import('../src/dm-open.js')

test('dm-open notifies every subscriber and stops after unsubscribe', async (t) => {
  const { onDmOpen, requestDmOpen } = await load()
  let a = 0
  let b = 0
  const offA = onDmOpen(() => { a++ })
  const offB = onDmOpen(() => { b++ })
  requestDmOpen()
  t.is(a, 1)
  t.is(b, 1)
  offA()
  requestDmOpen()
  t.is(a, 1)
  t.is(b, 2)
  offB()
  requestDmOpen()
  t.is(b, 2)
})

test('dm-open lets a listener unsubscribe while being notified', async (t) => {
  const { onDmOpen, requestDmOpen } = await load()
  let calls = 0
  const off = onDmOpen(() => { calls++; off() })
  requestDmOpen()
  requestDmOpen()
  t.is(calls, 1)
})

// Built from parts so this file does not carry the words it forbids.
const STATE_WORDS = new RegExp(['\\bl' + 'ida\\b', 'entre' + 'gue', 'digi' + 'tando'].join('|'), 'i')

test('Conversas is one list with three chips, a pinned Pedidos dot and nav pushes', async (t) => {
  const { FILTERS, FILTER_LABELS, requestsRow, communitiesRow } = await import('../src/conversas.js')
  t.alike(FILTERS.map((id) => FILTER_LABELS[id]), ['Todas', 'Não lidas', 'Grupos'])
  t.is(requestsRow({ requests: true }).unread, true)
  t.is(requestsRow({ requests: false }).unread, false)
  t.is(communitiesRow().kind, 'communities')
  const src = readFileSync(join(__dirname, '../src/screens/Conversas.js'), 'utf8')
  t.ok(src.includes('<FilterChips options={FILTERS.map((id) => ({ id, label: FILTER_LABELS[id] }))} selected={filter} onSelect={setFilter} />'), 'the three chips')
  t.ok(src.includes('applyFilter([requestsRow({ requests: inbox.requests }), communitiesRow(), ...rows], filter)'), 'Pedidos and Comunidades pinned above the merged rows')
  t.ok(src.includes("<PinnedRow icon='conversas' title={item.title} dot={item.unread === true} chevron onPress={() => { if (typeof onOpenRequests === 'function') onOpenRequests() }} />"), 'Pedidos shows a dot and pushes the request folder')
  t.ok(src.includes("<PinnedRow icon='gente' title={item.title} chevron onPress={() => { if (typeof onOpenCommunities === 'function') onOpenCommunities() }} />"), 'Comunidades is a compact pinned row with a chevron')
  t.ok(src.includes('{dot ? <View style={styles.dot} /> : null}'), 'a dot, never a count')
  t.ok(src.includes('<Icon name={icon} size={24} color={colors.accent} />') && src.includes('const PINNED_HEIGHT = 56'), 'a 24 pt accent glyph in a 56 pt row')
  t.absent(src.includes('<Mensagens') || src.includes('setView('), 'the request folder is a stacked screen, not an inline view')
  t.ok(src.includes('onOpenCommunities()'), 'the Comunidades row pushes the browse screen')
  t.ok(src.includes('onOpenThread(item.peer)') && src.includes('onOpenGroup(item.group)'))
  t.ok(src.includes('<NovaConversa') && src.includes('open={composing === true}'), 'the "+" opens the NovaConversa sheet')
  t.ok(src.includes('<NovaComunidade'), 'Nova comunidade still creates from the sheet')
  t.ok(src.includes('eachLimited(wanted, INFO_AT_ONCE,') && src.includes('export const INFO_AT_ONCE = 4'), 'bounded community.info reads')
  t.ok(src.includes("export const PARTIAL_TEXT = 'Algumas conversas ainda não carregaram.'"))
  t.ok(src.includes("export const EMPTY_TEXT = 'Nenhuma conversa ainda'"))
  t.absent(src.includes('selectorItems') || src.includes("accessibilityRole='tablist'"), 'no segmented selector')
  t.absent(src.includes("'group.seen'"), 'the list never marks a group seen')
  t.ok(src.includes("const SEARCH_PLACEHOLDER = 'Buscar conversas'") && src.includes('placeholder={SEARCH_PLACEHOLDER}'), 'a persistent search field')
  t.ok(src.indexOf('<TextInput') < src.indexOf('<FilterChips'), 'the search field sits above the chips')
  t.ok(src.includes("accessibilityLabel='limpar busca'") && src.includes("onPress={() => setQuery('')}"), 'a clear X empties the search')
  t.absent(src.includes('searching') || src.includes('onSearching'), 'no header search toggle')
  t.ok(src.includes('recent={recent}') && src.includes('RECENT_MAX') && readFileSync(join(__dirname, '../src/conversas.js'), 'utf8').includes('export const RECENT_MAX = 8'), 'recent partners go to the sheet')
  const wake = src.slice(src.indexOf('const lastShow = useRef(showInbox)'), src.indexOf('}, [showInbox])'))
  t.ok(wake.includes("setFilter('todas')") && wake.includes("setQuery('')"), 'a notification open clears the chip and the search')
  const footer = src.slice(src.indexOf('let footer = null'), src.indexOf('const renderItem'))
  t.ok(footer.indexOf('inbox.pageError') < footer.indexOf('items.length === 0'), 'a failed older page wins over the empty filter text')
  t.ok(footer.includes('<Soft>{PARTIAL_TEXT}</Soft>') && footer.includes("<Pill label='tentar de novo' onPress={() => inbox.loadMore()} />"), 'the failed page shows the note and the retry')
  const mensagens = readFileSync(join(__dirname, '../src/screens/Mensagens.js'), 'utf8')
  t.absent(mensagens.includes('LABELS.newMessage') || mensagens.includes("folder: 'inbox'"), 'no Nova mensagem footer and no inbox in the request folder')
  t.ok(mensagens.includes("dm('dm.list', { folder: 'request' })"))
  t.ok(mensagens.includes('<TopBar title={requestsRow(null).title} onBack={onBack} />'), 'the folder has its own top bar and back')
  t.ok(mensagens.includes('<ConversationRow') && mensagens.includes('onPress={() => onOpenThread(item.peer)}'), 'compact rows open the thread')
  t.ok(mensagens.includes('<Soft>{LABELS.requestNote}</Soft>'), 'one short note on top')
  t.absent(mensagens.includes('LABELS.accept') || mensagens.includes("'dm.set'") || mensagens.includes('lupa'), 'no inline decisions and no search in the folder')
  const sheet = readFileSync(join(__dirname, '../src/screens/NovaConversa.js'), 'utf8')
  t.ok(sheet.indexOf("label='Novo grupo'") > 0 && sheet.indexOf("label='Novo grupo'") < sheet.indexOf("label='Nova comunidade'"), 'Novo grupo comes first')
  t.ok(sheet.includes('color={colors.accentInk}') && sheet.includes('backgroundColor: colors.accent'), 'filled accent circles')
  t.ok(sheet.includes('Conversas recentes') && sheet.includes("who.title === UNNAMED ? 'Pessoa'"), 'recent partners never read sem nome')
  for (const file of ['Conversas.js', 'Mensagens.js', 'Comunidades.js', 'NovaConversa.js']) {
    const text = readFileSync(join(__dirname, '../src/screens', file), 'utf8')
    t.absent(text.includes(String.fromCharCode(0x2014)), file + ' has no em dash')
    t.absent(STATE_WORDS.test(text), file + ' names no read, delivered or typing state')
  }
})

test('dm-open has no imports', async (t) => {
  const source = readFileSync(join(__dirname, '../src/dm-open.js'), 'utf8')
  t.absent(source.split('\n').some((line) => line.startsWith('import ')))
  t.absent(source.includes('initialSegment') || source.includes('DEFAULT_SEGMENT'), 'no segment helpers left')
  t.absent(source.includes(String.fromCharCode(0x2014)))
})

const screen = () => import('../src/dm-screen.js')
const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const ID = '1'.repeat(32)

test('thread rows keep two senders that share an id apart', async (t) => {
  const { threadRows } = await screen()
  const at = '2026-11-01T10:00:00.000Z'
  const rows = threadRows([
    { id: ID, from: B, text: 'deles', at, mine: false, replyTo: null },
    { id: ID, from: A, text: 'minha', at, mine: true, replyTo: null }
  ])
  t.is(rows.length, 2)
  t.alike(rows.map((r) => r.key), [A + ':' + ID, B + ':' + ID])
  t.alike(rows.map((r) => r.mine), [true, false])
  t.alike(rows.map((r) => r.rawText), ['minha', 'deles'])
  t.alike(rows.map((r) => r.text), ['minha', 'deles'])
  t.alike(rows.map((r) => r.from), [A, B])
})

test('thread rows pair each message with its own source in time order', async (t) => {
  const { threadRows } = await screen()
  const rows = threadRows([
    { id: '2'.repeat(32), from: B, text: 'depois', at: '2026-11-01T10:01:00.000Z', mine: false, replyTo: ID },
    { id: ID, from: A, text: 'antes', at: '2026-11-01T10:00:00.000Z', mine: true, replyTo: null },
    null,
    { from: A, text: 'sem id' }
  ])
  t.alike(rows.map((r) => r.rawText), ['antes', 'depois'])
  t.alike(rows.map((r) => r.mine), [true, false])
  t.is(rows[1].replyTo, 'antes')
})

test('an older thread page is prepended and the held copy wins', async (t) => {
  const { mergeMessages } = await screen()
  const old = { id: '3'.repeat(32), from: A, text: 'velha', at: '2026-10-01T10:00:00.000Z' }
  const mine = { id: ID, from: A, text: 'x', at: '2026-11-01T10:00:00.000Z' }
  const theirs = { id: ID, from: B, text: 'y', at: '2026-11-01T10:00:00.000Z' }
  const merged = mergeMessages([old, mine], [{ ...mine, deleted: true }, theirs])
  t.is(merged.length, 3)
  t.ok(merged.find((m) => m.from === A && m.id === ID).deleted)
  t.ok(merged.includes(old))
})

test('a newest thread page replaces its window and keeps only older rows', async (t) => {
  const { refreshThread } = await screen()
  const msg = (id, from, at) => ({ id: id.repeat(32), from, text: id, at })
  const older = msg('1', A, '2026-10-01T10:00:00.000Z')
  const gone = msg('2', B, '2026-11-01T10:05:00.000Z')
  const kept = msg('3', A, '2026-11-01T10:00:00.000Z')
  const fresh = msg('4', B, '2026-11-01T10:10:00.000Z')
  const out = refreshThread([older, kept, gone], [kept, fresh])
  t.alike(out.messages.map((m) => m.text), ['1', '3', '4'])
  t.ok(out.keepOlder)
  const none = refreshThread([kept, gone], [kept, fresh])
  t.alike(none.messages.map((m) => m.text), ['3', '4'])
  t.absent(none.keepOlder)
  const empty = refreshThread([older, kept], [])
  t.alike(empty.messages, [])
  t.absent(empty.keepOlder)
})

test('a refresh keeps a held row tied with the page oldest time', async (t) => {
  const { refreshThread } = await screen()
  const at = '2026-11-01T10:00:00.000Z'
  // Same time and id: the node may order the two senders either way, so the
  // page can cut the tie and leave one of them for the older page.
  const tiedA = { id: ID, from: A, text: 'a', at }
  const tiedB = { id: ID, from: B, text: 'b', at }
  const fresh = { id: '4'.repeat(32), from: B, text: 'c', at: '2026-11-01T10:10:00.000Z' }
  const out = refreshThread([tiedA, tiedB, fresh], [tiedB, fresh])
  t.alike(out.messages.map((m) => m.text).sort(), ['a', 'b', 'c'])
  const changed = refreshThread([tiedA, tiedB], [{ ...tiedA, deleted: true }, tiedB])
  t.is(changed.messages.length, 2)
  t.ok(changed.messages.find((m) => m.from === A).deleted)
})

test('the newest key is the last message of the newest page', async (t) => {
  const { newestOf } = await screen()
  const page = [{ id: ID, from: A, at: '2026-11-01T10:00:00.000Z' }, { id: '2'.repeat(32), from: B, at: '2026-11-01T09:00:00.000Z' }]
  t.is(newestOf(page), B + ':' + '2'.repeat(32))
  t.is(newestOf([]), '')
  t.is(newestOf(null), '')
})

test('a conversation preview is one line', async (t) => {
  const { previewLine } = await screen()
  t.is(previewLine('oi\ntudo\r\nbem'), 'oi tudo bem')
  t.is(previewLine(null), '')
})

test('App.js lists the groups on the Conversas tab and stacks Comunidades and Pedidos', async (t) => {
  const app = readFileSync(join(__dirname, '../App.js'), 'utf8')
  t.absent(app.includes('convSegment') || app.includes('onSegment='), 'no segment coupling')
  t.ok(app.includes("const groupsTab = tab === 'comunidades'"))
  t.ok(app.includes("if (entry.screen === 'comunidades') {") && app.includes('<Comunidades onBack={goBack} onOpenGroup={openGroup} onOpenCommunity={openCommunity} />'))
  t.ok(app.includes("pushScreen({ screen: 'comunidades' })"))
  t.absent(app.includes("{ icon: 'lupa',") || app.includes('convSearch'), 'no lupa in the Conversas top bar')
  t.ok(app.includes("{ icon: 'plus', label: 'nova conversa', onPress: () => setConvCompose(true) }"), '+ in the top bar')
  t.ok(app.includes("if (entry.screen === 'pedidos') {") && app.includes('<Mensagens onBack={goBack} onOpenThread={openMessage} />'), 'Pedidos is a stacked screen')
  t.ok(app.includes("pushScreen({ screen: 'pedidos' })") && app.includes('onOpenRequests={openRequests}'), 'the pinned row pushes it')
  t.ok(app.includes('composing={convCompose}') && app.includes('onOpenCommunities={openCommunities}') && app.includes('seenTick={seenTick}'))
  t.ok(app.includes('onSeen={bumpSeen}'), 'group.seen still reported by an opened group')
})

test('an uncertain send stays held until a different text is confirmed', async (t) => {
  const { sendPlan } = await screen()
  t.is(sendPlan(null, 'oi', null), 'send')
  t.is(sendPlan({ text: 'oi', quoteId: null }, 'oi', null), 'retry')
  t.is(sendPlan({ text: 'oi', quoteId: ID }, 'oi', ID), 'retry')
  t.is(sendPlan({ text: 'oi', quoteId: ID }, 'oi', null), 'confirm')
  t.is(sendPlan({ text: 'oi', quoteId: null }, 'oi!', null), 'confirm')
})

test('dm-screen stays pure', async (t) => {
  const source = readFileSync(join(__dirname, '../src/dm-screen.js'), 'utf8')
  const imports = source.split('\n').filter((line) => line.startsWith('import '))
  t.alike(imports, ["import { threadOf } from './dm.js'", "import { dayHeading } from './format.js'", "import { sendPlan as attachmentSendPlan } from './attach-plan.js'", "import { plainPreview } from './chatPreview.js'"])
  t.absent(source.includes(String.fromCharCode(0x2014)))
})

test('an uncertain attachment send requires confirmation after a selection changes', async (t) => {
  const { sendPlan } = await screen()
  const first = { name: 'first' }
  const second = { name: 'second' }
  const hold = { text: '', quoteId: ID, attachments: [first, second] }
  t.is(sendPlan(null, '', ID, [first]), 'send')
  t.is(sendPlan(hold, '', ID, [first, second]), 'retry')
  t.is(sendPlan(hold, '', ID, [second, first]), 'confirm')
  t.is(sendPlan(hold, '', ID, [first]), 'confirm')
  t.is(sendPlan(hold, '', ID, [first, { ...second }]), 'confirm')
  t.is(sendPlan(hold, '', ID), 'confirm')
  t.is(sendPlan({ text: '', quoteId: ID }, '', ID, [first]), 'confirm')
})

test('day marks sit on the first row of each local day', async (t) => {
  const { withDayMarks } = await screen()
  const now = new Date(2026, 9, 23, 12).getTime()
  const at = (d, h, m = 0) => new Date(2026, 9, d, h, m).toISOString()
  const rows = [{ at: at(22, 9) }, { at: at(22, 10) }, { at: at(23, 8) }, { at: 'x' }, { at: at(23, 9) }]
  const marked = withDayMarks(rows, now)
  t.alike(marked.map((r) => r.dayMark), ['ontem', null, 'hoje', null, null])
  t.is(marked[0].at, rows[0].at)
  const old = withDayMarks([{ at: new Date(2025, 2, 4, 9).toISOString() }, { at: new Date(2026, 2, 4, 9).toISOString() }], now)
  t.alike(old.map((r) => r.dayMark), ['4 mar 2025', '4 mar'])
})

test('bubbleShape groups same-side rows within five minutes', async (t) => {
  const { withDayMarks, bubbleShape } = await screen()
  const now = new Date(2026, 9, 23, 12).getTime()
  const at = (d, h, m) => new Date(2026, 9, d, h, m).toISOString()
  const row = (mine, when, from = 'a') => ({ mine, from: mine ? 'me' : from, at: when })
  const shapes = (rows) => { const r = withDayMarks(rows, now); return r.map((_, i) => bubbleShape(r, i)) }
  t.alike(shapes([row(true, at(23, 9, 0)), row(true, at(23, 9, 2)), row(true, at(23, 9, 4))]), ['first', 'middle', 'last'])
  t.alike(shapes([row(true, at(23, 9, 0)), row(false, at(23, 9, 1)), row(true, at(23, 9, 2))]), ['single', 'single', 'single'])
  t.alike(shapes([row(true, at(23, 9, 0)), row(true, at(23, 9, 6))]), ['single', 'single'], 'a 6 minute gap splits')
  t.alike(shapes([row(true, at(22, 23, 59)), row(true, new Date(2026, 9, 23, 0, 1).toISOString())]), ['single', 'single'], 'a day break splits')
  t.alike(shapes([row(true, 'x'), row(true, 'x')]), ['single', 'single'])
  t.alike(shapes([row(false, at(23, 9, 0), 'a'), row(false, at(23, 9, 1), 'b')]), ['single', 'single'], 'different senders split')
})

test('bubble groups span at most five minutes from their first message', async (t) => {
  const { bubbleShape, withDayMarks, DM_GROUP_MS } = await screen()
  const start = new Date(2026, 9, 23, 10).getTime()
  const rowsAt = (minutes) => withDayMarks(minutes.map((minute) => ({
    mine: true, from: A, at: new Date(start + minute * 60000).toISOString()
  })), start)
  const shapes = (rows) => rows.map((_, i) => bubbleShape(rows, i))
  t.is(DM_GROUP_MS, 300000)
  t.alike(shapes(rowsAt([0, 4, 9])), ['first', 'last', 'single'])
  const steady = rowsAt([0, 3, 6, 9, 12, 15, 18, 21, 24])
  t.alike(shapes(steady), ['first', 'last', 'first', 'last', 'first', 'last', 'first', 'last', 'single'])
  t.alike(steady.map((_, i) => bubbleShape(steady, steady.length - 1 - i)).reverse(), shapes(steady), 'independent of render order')
  t.alike(shapes(rowsAt([0, 5, 6])), ['first', 'last', 'single'], 'five minutes is inclusive')
})

test('an invite pill ends its bubble group', async (t) => {
  const { bubbleShape, withDayMarks } = await screen()
  const { inviteLinkOf } = await import('../src/inviteMessage.js')
  const origin = 'https://example.test'
  const inviteLink = inviteLinkOf(origin + '/g/' + B, origin)
  t.ok(inviteLink)
  const start = new Date(2026, 9, 23, 10).getTime()
  const rows = withDayMarks([0, 1, 2, 3].map((minute) => ({
    mine: false,
    from: B,
    at: new Date(start + minute * 60000).toISOString(),
    inviteLink: minute === 1 ? inviteLink : null
  })), start)
  const shapes = () => rows.map((_, i) => bubbleShape(rows, i))
  t.alike(shapes(), ['first', 'last', 'first', 'last'], 'the invite can follow a bubble but ends that run')
  rows[0].inviteLink = inviteLink
  t.alike(shapes(), ['single', 'single', 'first', 'last'], 'consecutive invite pills stay apart')
  rows[0].inviteLink = rows[1].inviteLink = null
  t.alike(shapes(), ['first', 'middle', 'middle', 'last'], 'without a rendered pill there is no break')
})

test('an open menu keeps its neighbours from joining it', async (t) => {
  const { bubbleShape, withDayMarks } = await screen()
  const start = new Date(2026, 9, 23, 10).getTime()
  const rows = withDayMarks([0, 1, 2].map((minute) => ({
    key: B + ':m' + minute,
    mine: false,
    from: B,
    at: new Date(start + minute * 60000).toISOString()
  })), start)
  const shapes = (opts) => rows.map((_, i) => bubbleShape(rows, i, opts))
  t.alike(shapes(), ['first', 'middle', 'last'])
  t.alike(shapes({ breakKey: null }), ['first', 'middle', 'last'], 'no open menu changes nothing')
  t.alike(shapes({ breakKey: rows[1].key }), ['single', 'single', 'single'], 'the row above ends its run, the row below starts a new one')
  t.alike(shapes({ breakKey: rows[0].key }), ['single', 'first', 'last'])
  t.alike(shapes({ breakKey: 'other' }), ['first', 'middle', 'last'], 'an unknown key changes nothing')
})

test('a private message links from its raw text, but not beside Abrir convite', (t) => {
  const screen = readFileSync(join(__dirname, '../src/screens/Mensagem.js'), 'utf8')
  t.ok(screen.includes('rawText: link ? undefined : item.rawText'), 'Bubble renders the raw text through MentionText, plain beside the invite button')
  t.absent(existsSync(join(__dirname, '../src/ui/DmMessageRow.js')), 'Bubble replaced the private row')
})

test('mentions in a private message are tappable and open the profile', (t) => {
  const screen = readFileSync(join(__dirname, '../src/screens/Mensagem.js'), 'utf8')
  t.ok(screen.includes('onOpenMention={mentionTap}'), 'the bubble gets the mention handler')
  t.ok(screen.includes('peerProfile.username === username) open()'), 'the peer own @nome opens the profile without a lookup')
  t.ok(screen.includes('onOpenMention(username)'), 'other mentions go to the app resolver')
  t.ok(screen.includes('onOpenMember(peer)'))
})

test('the private header shows the peer and replaces the perfil and mais pills', (t) => {
  const screen = readFileSync(join(__dirname, '../src/screens/Mensagem.js'), 'utf8')
  t.ok(screen.includes('<ChatHeader') && screen.includes('subtitle={peerWho.subtitle || undefined}') && screen.includes('publicKey={peer}'))
  t.ok(screen.includes("peerWho.title === UNNAMED ? 'Pessoa' : peerWho.title"), 'never sem nome')
  t.ok(screen.includes("icon: 'mais', label: 'opções da conversa'"))
  t.absent(screen.includes("label='perfil'") || screen.includes("label='mais'"))
  t.ok(screen.includes('<ChatComposer') && screen.includes('notice={notice}'), 'the uncertain hold lives in the composer notice')
  t.ok(screen.includes("label: 'Responder'") && screen.includes("label: 'Copiar'") && screen.includes('LABELS.report'))
})

test('invite links in a conversation only open a screen, never join', (t) => {
  const read = (p) => readFileSync(join(__dirname, p), 'utf8')
  const screen = read('../src/screens/Mensagem.js')
  t.ok(screen.includes('inviteLinkOf(') && screen.includes('OPEN_INVITE'))
  t.ok(screen.includes("link.kind === 'grupo' ? ', abre o grupo' : ', abre a comunidade'"), 'label follows the link kind')
  t.ok(screen.includes('onPress={() => onOpenInvite(link)}') && screen.includes('origin'))
  t.absent(/join/i.test(screen))
  const app = read('../App.js')
  const at = app.indexOf('onOpenInvite={(link)')
  t.ok(at > 0)
  const line = app.slice(at, app.indexOf('\n', at))
  t.ok(line.includes('openGroup(link.key)') && line.includes('openCommunity(link.key)'))
  t.absent(line.includes('community.join'))
})

test('conversation row: group titles, unread labels and the search share one title rule', (t) => {
  const row = readFileSync(join(__dirname, '../src/ui/ConversationRow.js'), 'utf8')
  const conversas = readFileSync(join(__dirname, '../src/screens/Conversas.js'), 'utf8')
  t.ok(row.includes('unreadLabel(count)') && row.includes('99 ou mais mensagens novas'))
  t.ok(row.includes("item.unread === true\n    ? 'mensagens novas'"))
  t.ok(row.includes("(groupTitle || 'Sem título')") && row.includes('const avatarName = person ? who.avatarName : title'))
  t.ok(row.includes("whoOf({ name: typeof item.name === 'string' ? item.name : '' }).title"), 'a group name drops a leading at-sign like a person name')
  t.ok(row.includes('export function personTitle') && conversas.includes('personTitle(profileOf(row.peer))'))
  t.ok(!conversas.includes('whoOf('))
})

test('groups older than the loaded inbox wait for the next dm.list page', (t) => {
  const conversas = readFileSync(join(__dirname, '../src/screens/Conversas.js'), 'utf8')
  t.ok(conversas.includes('if (!ready || !inbox.next || inbox.rows.length === 0) return merged'), 'no hold once the inbox is complete')
  t.ok(conversas.includes('Date.parse(inbox.rows[inbox.rows.length - 1].at)'), 'cut at the oldest loaded conversation')
  t.ok(conversas.includes("const rows = filter === 'todas' ? paged : merged"), 'Não lidas and Grupos list every group')
  t.ok(conversas.includes('return applyFilter(merged.filter((row) =>'), 'a search covers every group')
})

test('a person row is named only by the names cache, never by row fields', (t) => {
  const row = readFileSync(join(__dirname, '../src/ui/ConversationRow.js'), 'utf8')
  const folder = readFileSync(join(__dirname, '../src/screens/Mensagens.js'), 'utf8')
  t.ok(row.includes('? { name: cached ? cached.name : null, username: cached ? cached.username : null }'))
  t.absent(row.includes('item.username'), 'no username from the row')
  t.absent(folder.includes('name: item.name'), 'the request folder forwards no name')
})

test('a group with one new message shows the badge', (t) => {
  const row = readFileSync(join(__dirname, '../src/ui/ConversationRow.js'), 'utf8')
  t.ok(row.includes('const dot = item.unread === true\n'), 'only a private conversation gets the dot')
  t.ok(row.includes('const unread = dot || count > 0\n'), 'any group count above zero is unread')
})

test('an older inbox page never lands after a fresher first page', (t) => {
  const conversas = readFileSync(join(__dirname, '../src/screens/Conversas.js'), 'utf8')
  t.ok(conversas.includes('if (s.next !== cursor) return s'), 'the append checks the cursor in the state it updates')
  t.ok(conversas.includes("else if (!inbox.requests) footer = <EmptyState icon='conversas' title='Nada novo por aqui' />"), 'no "nada novo" beside an unread Pedidos row')
})

test('App.js hands the mention handler to the private chat', (t) => {
  const app = readFileSync(join(__dirname, '../App.js'), 'utf8')
  t.ok(app.includes('onOpenMember={openMember} onOpenMention={mentionHandler} onReport={setReport}'), 'a mention in a private chat opens the profile')
})

test('a quote of an unloaded message names no author yet', (t) => {
  const screen = readFileSync(join(__dirname, '../src/screens/Mensagem.js'), 'utf8')
  t.ok(screen.includes("    if (!target) return ''\n    return target.mine === true ? OWN_LABEL : quoteName"))
})

test('private chat: quote author, personal retry and one character counter', (t) => {
  const screen = readFileSync(join(__dirname, '../src/screens/Mensagem.js'), 'utf8')
  t.ok(screen.includes('if (held === undefined || String(r.from) < String(held.from)) rowById.set(r.id, r)'), 'a shared id resolves like threadOf')
  t.ok(screen.includes("onPress={typeof hold.retry === 'function' ? retryHeld : () => send(hold.text, hold.quoteId, hold.card || null)}"), 'Tentar de novo resends on a personal account')
  t.ok(screen.includes("{typeof hold.retry === 'function' || pageKey === null"), 'a page never signs a second message from this button')
  t.absent(screen.includes('caracteres restantes'), 'the composer draws the counter once')
})

test('a retried held message keeps a newer draft', (t) => {
  const screen = readFileSync(join(__dirname, '../src/screens/Mensagem.js'), 'utf8')
  t.ok(screen.includes("setDraft((d) => (d === text ? '' : d))"))
  t.ok(screen.includes('setReplyTo((rt) => (rt && rt.id === quoteId ? null : rt))'))
  t.ok(/import \{[^}]*followAutocorrect[^}]*\} from '..\/chatSend'/.test(screen), 'followAutocorrect comes from chatSend')
  t.ok(screen.indexOf('followed.text') > screen.indexOf("setDraft((d) => (d === text ? '' : d))"), 'the autocorrected text is cleared after the pinned line')
  const group = readFileSync(join(__dirname, '../src/screens/Grupo.js'), 'utf8')
  t.ok(/import \{[^}]*followAutocorrect[^}]*\} from '..\/chatSend'/.test(group), 'the group imports followAutocorrect too')
  t.ok(group.includes('if (f && f.text !== text) setDraft((d) => (d === f.text ? \'\' : d))') && group.includes('clearFollowed(followed, text)'), 'the group clears the autocorrected text next to the pinned lines')
})

test('a peer named like the own label never reads as own in a quote', (t) => {
  const screen = readFileSync(join(__dirname, '../src/screens/Mensagem.js'), 'utf8')
  t.ok(screen.includes("const quoteName = readsAs(nameText, OWN_LABEL) ? (peerWho.subtitle || 'Pessoa') : nameText"))
  t.ok(screen.includes('handle: quoteMine(item) ? undefined : quoteHandle'), 'a peer quote carries the verified @nome')
  t.ok(screen.includes('senderKey: quoteMine(item) ? undefined : peer'), 'a peer quote gets the peer color, not the own accent')
})

test('large text grows the Conversas search field and the Avisos rows instead of cutting them', (t) => {
  const screen = readFileSync(join(__dirname, '../src/screens/Conversas.js'), 'utf8')
  const search = screen.slice(screen.indexOf('  search: {'), screen.indexOf('  searchFocused:'))
  t.ok(search.includes('minHeight: layout.hit') && !/\bheight: layout\.hit/.test(search.replace('minHeight', '')), 'the field has a minimum, not a fixed height')
  t.ok(screen.includes('minHeight: layout.hit - 3, paddingVertical: 0'), 'so has its input')
  const avisos = readFileSync(join(__dirname, '../src/screens/Avisos.js'), 'utf8')
  t.ok(avisos.includes('<Text style={styles.name} numberOfLines={2}>'), 'the action line takes two lines')
  const badge = avisos.slice(avisos.indexOf('  kindBadge: {'))
  t.ok(badge.includes('right: -4,') && badge.includes('bottom: -4,'), 'the type badge sits off the initials')
})

test('the Pedidos de mensagem row has the same chevron as Comunidades', (t) => {
  const src = readFileSync(join(__dirname, '../src/screens/Conversas.js'), 'utf8')
  t.ok(src.includes("<PinnedRow icon='conversas' title={item.title} dot={item.unread === true} chevron "))
  t.ok(src.includes("<PinnedRow icon='gente' title={item.title} chevron "))
})

test('round 8: a row without a preview has no empty second line', (t) => {
  const row = readFileSync(join(__dirname, '../src/ui/ConversationRow.js'), 'utf8')
  t.ok(row.includes("{preview !== '' || unread"), 'second line only with a preview or unread')
})

test('conversasReadsAllowed holds hidden-tab reads until the first show', async (t) => {
  const { conversasReadsAllowed } = await import('../src/conversas.js')
  t.is(conversasReadsAllowed({ active: false, shownOnce: false }), false)
  t.is(conversasReadsAllowed({ active: true, shownOnce: false }), true)
  t.is(conversasReadsAllowed({ active: false, shownOnce: true }), true)
  t.is(conversasReadsAllowed(), false)
})

test('Conversas reads and the shell dot wait out the boot', (t) => {
  const conversas = readFileSync(join(__dirname, '../src/screens/Conversas.js'), 'utf8')
  const app = readFileSync(join(__dirname, '../App.js'), 'utf8')
  t.ok(conversas.includes('conversasReadsAllowed({ active, shownOnce: shownOnce.current })'))
  t.ok(conversas.includes('useInbox({ ready: ready && allowed,'))
  t.ok(conversas.includes('enabled: hosted && allowed && pageKey === null'))
  t.ok(app.includes('nodeWhenIdle(4000)') && app.includes('if (dmReady && dmDotGate) readDmDot()'))
  // The mailbox pull finds waiting messages for the dot, so it waits only for
  // a quiet node, never for the tab to be opened.
  t.ok(conversas.includes('const pulls = allowed || quiet'), 'pulls start on the first show or once the node is quiet')
  t.ok(conversas.includes('if (!ready || !pulls) return'), 'the first pull is gated on pulls, not allowed')
  t.ok(conversas.includes('if (!ready || !pulls || !visible) return'), 'the periodic pull is gated on pulls, not allowed')
  t.ok(conversas.includes('const wait = nodeWhenIdle(4000)') && conversas.includes('wait.cancel()'), 'the quiet wait uses whenIdle and is cancelled')
})
