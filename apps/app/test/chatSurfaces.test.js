'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const read = (file) => readFileSync(join(__dirname, '../src', file + '.js'), 'utf8')
const conversations = read('screens/Conversas')
const messages = read('screens/Mensagens')
const communities = read('screens/Comunidades')
const community = read('screens/Comunidade')
const row = read('ui/ConversationRow')
const box = read('ui/CommunitiesBox')
const chips = read('ui/FilterChips')

test('chat lists use row skeletons for the first load', (t) => {
  for (const src of [conversations, messages, communities, community]) {
    t.ok(src.includes('SkeletonRow } from'), 'imports the shared row skeleton')
    t.ok(src.includes('[0, 1, 2].map((key) => <SkeletonRow key={key} />)'), 'a list of placeholders')
    t.absent(/<Spinner\b|<Skeleton\s/.test(src), 'no bare spinner or post placeholder')
  }
  t.ok(/if \(!loaded\) footer = <View>.*<SkeletonRow/.test(conversations))
  t.ok(/else if \(!loaded\) empty = <View>.*<SkeletonRow/.test(messages))
  t.ok(/else if \(!list.loaded\) \{\s+empty = <View>.*<SkeletonRow/.test(communities))
  t.ok(/else if \(info === null\) \{\s+body = <View>.*<SkeletonRow/.test(community))
})

test('inbox empty actions match the available paths and successful requests only offer back', (t) => {
  t.ok(conversations.includes("title='Nenhuma conversa encontrada.' actionLabel='Limpar busca' onAction={() => setQuery('')}"))
  t.ok(conversations.includes("title={EMPTY_TEXT} body={EMPTY_BODY} actionLabel={typeof onComposing === 'function' ? 'Nova conversa' : undefined} onAction={typeof onComposing === 'function' ? () => onComposing(true) : undefined}"), 'new conversation needs its own handler')
  t.ok(conversations.includes("body='Os grupos das suas comunidades aparecem aqui.' actionLabel='Comunidades' onAction={onOpenCommunities}"))
  t.ok(conversations.includes("secondaryLabel='Nova comunidade' onSecondary={pageKey === null ? () => setCreating(true) : undefined}"))
  const defaults = conversations.slice(conversations.indexOf('  const EmptyState ='), conversations.indexOf('  const sheets ='))
  t.ok(defaults.includes("actionLabel='Todas'\n      onAction={() => setFilter('todas')}"), 'unread empty clears its filter')
  t.ok(defaults.includes("secondaryLabel='Nova conversa'") && defaults.includes('onComposing(true)'), 'search and unread can start a conversation')
  t.ok(conversations.includes("else if (!inbox.requests) footer = <EmptyState icon='conversas' title='Nada novo por aqui' />"), 'a pending request is not presented as empty')
  t.ok(messages.includes("title={LABELS.emptyRequests} actionLabel='Voltar' onAction={onBack} />"), 'successful empty requests do not offer retry')
  t.ok(messages.includes("body={LOCKED_TEXT} actionLabel='Voltar' onAction={onBack}"))
})

test('community search distinguishes an unfinished empty index and preserves refinement with hits', (t) => {
  const state = communities.slice(communities.indexOf('  let searchState = null'), communities.indexOf('  const discover ='))
  const conditions = ["if (search.status === 'loading')", "else if (search.status === 'error')", "else if (search.status === 'done')", 'if (search.groups.length === 0)', 'if (search.indexing)', 'else if (search.partial)', 'else searchState = <EmptyState']
  let previous = -1
  for (const condition of conditions) {
    const at = state.indexOf(condition)
    t.ok(at > previous, condition)
    previous = at
  }
  const discover = communities.slice(communities.indexOf('  const discover ='), communities.indexOf('  const header ='))
  t.is((discover.match(/\{searchState\}/g) || []).length, 1, 'one status slot')
  t.absent(discover.includes('<Soft>Buscando') || discover.includes('search.more'), 'no parallel status outside the slot')
  t.ok(discover.includes("search.status === 'done' && hits.length > 0"))
  t.ok(state.includes("!search.unavailable ? <Btn label='Tentar de novo'"), 'unavailable index is not retried')
  t.ok(state.includes("title='Nenhum grupo público encontrado.' actionLabel='Limpar busca' onAction={() => setQuery('')}"))
  t.ok(state.includes("if (search.indexing) searchState = <EmptyState icon='gente' title='A busca ainda está sendo atualizada; tente de novo depois.' actionLabel='Tentar de novo' onAction={() => search.retry()}"), 'indexing takes precedence over partial and offers retry')
  t.ok(state.includes("else if (search.partial) searchState = <EmptyState icon='gente' title='Alguns grupos podem faltar'"), 'partial emptiness is not a confirmed miss')
  t.ok(state.includes('{search.indexing ? <Soft>A busca ainda está sendo atualizada; tente de novo depois.</Soft> : search.partial ? <Soft>Alguns grupos podem faltar</Soft> : null}\n          {search.more ? <Soft>Há mais resultados: refine a busca.</Soft> : null}'), 'refinement remains visible alongside either unfinished-index note')
})

test('the Nova comunidade + shows only on the hosted, non-page list', (t) => {
  t.ok(communities.includes('const plus = hosted && pageKey === null\n'))
  t.ok(communities.includes("accessibilityLabel='Nova comunidade'"))
  t.ok(communities.includes('right={plus}'))
})

test('community empty lists explain their scope and offer existing actions', (t) => {
  const empty = communities.slice(communities.indexOf('  let empty'), communities.indexOf('  const renderItem'))
  t.ok(empty.includes('até 32 grupos sob a mesma moderação'))
  t.ok(empty.includes("actionLabel={pageKey === null ? 'Nova comunidade' : 'Voltar'}"))
  t.ok(empty.includes('onAction={pageKey === null ? () => setCreating(true) : onBack}'))
  t.ok(community.includes("title='Nenhum grupo ainda.' actionLabel='Voltar' onAction={onBack} />"), 'successful empty index does not offer retry')
  t.ok(community.includes("actionLabel={canCreate && !offline ? 'Novo grupo' : 'Tentar de novo'} onAction={canCreate && !offline ? () => setNewGroup(true) : load}"), 'creation keeps its permission and offline gates')
})

test('conversation accessible label includes safe name, preview, time and unread amount', (t) => {
  const expression = row.match(/ {2}const label = (.+)\n/)[1]
  const label = new Function('title', 'own', 'OWN_LABEL', 'spokenPreview', 'time', 'unread', 'unreadText', 'return ' + expression) // eslint-disable-line no-new-func
  t.is(label('Ana', false, 'Você', 'Até amanhã', '2 min', true, '3 mensagens novas'), 'Ana, Até amanhã, 2 min, 3 mensagens novas')
  t.is(label('Jardim', true, 'Você', 'Oi', 'agora', false, ''), 'Jardim, Você: Oi, agora')
  t.is(label('Ana', false, 'Você', '', null, false, ''), 'Ana')
  t.ok(row.includes('displayText(item.preview)') && row.includes('personTitle(profile)'), 'peer text is cleaned before the label')
  t.is((row.match(/accessibilityLabel=/g) || []).length, 1, 'one label for the row')
  t.ok(row.includes('accessibilityLabel={label}') && row.includes('<PressScale'))
  for (const src of [row, community]) {
    t.ok(src.includes("fontWeight: '700'"), 'unread title is heavier')
    t.ok(src.includes("flexShrink: 0, textAlign: 'right'"), 'time stays on the right')
    t.ok(src.includes('minHeight: 72'), 'shared row rhythm')
    t.ok(src.includes('numberOfLines={1}'), 'single line preview')
  }
  t.ok(row.includes('unread && styles.titleUnread'))
  t.ok(row.includes('previewUnread: { color: colors.ink, fontWeight: \'700\' }') && row.includes('unread && styles.previewUnread'), 'unread preview is ink at 700')
  t.ok(community.includes('unread && styles.nameUnread'))
})

test('community row label includes the last sender and time without exposing hidden messages', async (t) => {
  const { lastLine, lastIsOwn, OWN_LABEL, unreadLabel } = await import('../src/groups.js')
  const { displayText } = require('@varanda/rpc')
  const expression = community.match(/accessibilityLabel=\{(\[title, .+)\}/)[1]
  const label = new Function('title', 'own', 'OWN_LABEL', 'detail', 'displayText', 'time', 'unread', 'const spokenPreview = displayText(detail || ""); return ' + expression) // eslint-disable-line no-new-func
  const last = { name: 'Bia', preview: 'Olá', at: '2026-11-12T12:00:00Z' }
  t.is(label('Jardim', lastIsOwn(last), OWN_LABEL, lastLine(last), displayText, '2 min', unreadLabel(2)), 'Jardim, Bia: Olá, 2 min, 2 mensagens novas, abre o grupo')
  const own = { ...last, mine: true }
  t.ok(label('Jardim', lastIsOwn(own), OWN_LABEL, lastLine(own), displayText, 'agora', unreadLabel(1)).includes('Você: Olá, agora, 1 mensagem nova'))
  const hidden = { ...last, hidden: true }
  const hiddenLabel = label('Jardim', lastIsOwn(hidden), OWN_LABEL, lastLine(hidden), displayText, '2 min', '')
  t.absent(hiddenLabel.includes('Bia') || hiddenLabel.includes('Olá'))
  t.ok(hiddenLabel.includes('mensagem escondida, 2 min'))
})

test('group row announcements distinguish peer names that read as the own label', async (t) => {
  const { readsAs } = await import('../src/who.js')
  const { mergeRows } = await import('../src/conversas.js')
  const { lastLine, lastIsOwn } = await import('../src/groups.js')
  const { displayText } = require('@varanda/rpc')
  for (const src of [row, community]) {
    t.ok(/import \{[^}]*\breadsAs\b[^}]*\} from '\.\.\/who'/.test(src), 'uses the shared name comparison')
    const spoken = src.match(/ {2}const spokenPreview = (.+)\n/)[1]
    const expression = src === row ? src.match(/ {2}const label = (.+)\n/)[1] : src.match(/accessibilityLabel=\{(\[title, .+)\}/)[1]
    const announce = new Function('preview', 'own', 'readsAs', 'person', 'const OWN_LABEL = "Você"; const title = "Jardim"; const time = "agora"; const unread = false; const spokenPreview = ' + spoken + '; return ' + expression) // eslint-disable-line no-new-func
    const line = (last) => src === row ? mergeRows({ groups: [{ group: 'g', last }] })[0].subtitle : lastLine(last)
    for (const name of ['Você', 'Vo\u200bcê', 'Vo\u00adcê', '\u2060Você\ufe0f', 'Ｖｏｃê', 'VOCÊ']) {
      const last = { name, preview: 'Olá' }
      const label = announce(displayText(line(last)), lastIsOwn(last), readsAs, false)
      t.ok(label.startsWith('Jardim, Pessoa: Olá, agora'), JSON.stringify(name))
    }
    const own = { name: 'Você', preview: 'Olá', mine: true }
    t.ok(announce(displayText(line(own)), lastIsOwn(own), readsAs, false).startsWith('Jardim, Você: Olá, agora'), 'own message keeps its marker')
    const peer = { name: 'Ana', preview: 'Você: Olá' }
    t.ok(announce(displayText(line(peer)), lastIsOwn(peer), readsAs, false).startsWith('Jardim, Ana: Você: Olá, agora'), 'ordinary sender and message stay intact')
    const hidden = { ...own, hidden: true }
    t.ok(announce(displayText(line(hidden)), lastIsOwn(hidden), readsAs, false).startsWith('Jardim, mensagem escondida, agora'), 'hidden sender and message stay hidden')
    if (src === row) t.is(announce('Você: Olá', false, readsAs, true), 'Jardim, Você: Olá, agora', 'DM content has no sender prefix to rewrite')
  }
})

test('message activation follows heading, explanation and button reading order', (t) => {
  t.ok(messages.includes("<Text style={styles.name} accessibilityRole='header'>{pageInboxTitle(actingLabel())}</Text>"))
  const card = messages.slice(messages.indexOf("  if (keys.phase === 'activate'"), messages.indexOf("  } else if (keys.phase === 'ask-owner')"))
  const title = card.indexOf("accessibilityRole='header'")
  const note = card.indexOf('<Soft>{rotate ? PAGE_DM_ROTATE_TEXT')
  const action = card.indexOf('<Btn')
  t.ok(title >= 0 && title < note && note < action)
})

test('profile community chips preserve empty hiding, full labels and large text wrapping', (t) => {
  t.ok(box.includes('if (list.length === 0) return null'))
  t.ok(box.includes('<PressScale') && !box.includes('<Pressable'))
  t.ok(box.includes('accessibilityLabel={displayText(item.name)}'))
  t.ok(box.includes('<Text style={styles.sheetText} numberOfLines={2}>'))
})

test('chat presentation adds no receipt, presence, typing, platform gates or em dash', (t) => {
  for (const src of [row, conversations, messages, communities, community, box]) {
    const text = src.replaceAll('Não lidas', '')
    for (const word of ['lida', 'entregue', 'digitando']) t.absent(text.toLowerCase().includes(word), word)
    t.absent(/\b(?:typing|presence|delivered|readAt)\s*[:=]/i.test(text))
    t.absent(src.includes('Platform.OS'))
    t.absent(src.includes('\u2014'))
  }
})

test('conversation rows use the row name type and the chips carry no rule', (t) => {
  t.ok(row.includes('...type.rowName'))
  t.absent(row.includes('...type.postName'))
  t.absent(chips.includes('borderBottomWidth'))
})
