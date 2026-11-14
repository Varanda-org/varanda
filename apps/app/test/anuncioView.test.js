'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { displayText } = require('@varanda/rpc')
const load = () => import('../src/anuncioView.js')
const read = (file) => readFileSync(join(__dirname, '../src', file), 'utf8')
const sale = { kind: 'produto', price: 25000, cat: 'esporte', place: { city: 'São Paulo', uf: 'SP' } }

test('sticky actions follow ownership, callbacks and priced offers', async (t) => {
  const { stickyActions } = await load()
  const talk = { id: 'conversar', label: 'Conversar', primary: true }
  const offer = { id: 'oferta', label: 'Fazer oferta', primary: false }
  t.alike(stickyActions(sale, { owner: true, canTalk: true, canOffer: true }), [{ id: 'editar', label: 'Editar', primary: true }])
  t.alike(stickyActions(sale, { canTalk: true, canOffer: true }), [talk, offer])
  t.alike(stickyActions(sale, { canTalk: true, canOffer: false }), [talk])
  t.alike(stickyActions(sale, { canOffer: true }), [offer])
  t.alike(stickyActions(sale), [])
  t.alike(stickyActions(null, { owner: true }), [])
  for (const extra of [{ kind: 'procura' }, { kind: 'unknown' }, { price: null }, { price: 0 }, { price: -1 }, { price: '25000' }, { price: NaN }]) {
    t.alike(stickyActions({ ...sale, ...extra }, { canTalk: true, canOffer: true }), [talk])
  }
  t.alike(stickyActions({ ...sale, kind: 'servico' }, { canOffer: true }), [offer])
})

test('seller summary shares trust lines and the Brasilia month boundary', async (t) => {
  const { sellerSummary } = await load()
  const name = 'Ana\u001b\u202e'
  const trust = { certDate: '2025-02-01T12:00:00Z', verifiedName: 'Ana', mutuals: ['Bia'] }
  t.alike(sellerSummary({ name, since: '2026-04-01T01:00:00Z', trust }), {
    name: displayText(name),
    avatarName: displayText(name),
    lines: [
      { key: 'memberSince', text: 'Na Varanda desde março de 2026' },
      { key: 'verifiedName', text: 'Nome verificado: Ana' },
      { key: 'mutuals', text: 'Seguido por Bia' }
    ]
  })
  t.alike(sellerSummary(), { name: 'Quem anunciou', avatarName: '', lines: [] })
  t.alike(sellerSummary({ since: 'bad date', trust: null }), { name: 'Quem anunciou', avatarName: '', lines: [] })
  const { trustLines } = await import('../src/feira.js')
  t.alike(sellerSummary({ trust }).lines, trustLines(trust))
})

test('seller avatar keeps the real name separate from its visible fallback', async (t) => {
  const { sellerSummary } = await load()
  for (const name of [undefined, null, '', 42]) {
    t.alike(sellerSummary({ name }), { name: 'Quem anunciou', avatarName: '', lines: [] })
  }
  const name = 'Ana\u001b\u202e'
  t.is(sellerSummary({ name }).avatarName, displayText(name), 'avatar uses safe peer text')
  const src = read('screens/Anuncio.js')
  t.ok(src.includes('avatar={<Avatar name={seller.avatarName} publicKey={listing.author} />}') && src.includes('name={seller.name}'), 'only visible seller text uses the fallback')
})

test('detail chips show category, city and kind with safe peer text', async (t) => {
  const { detailChips } = await load()
  t.alike(detailChips(sale), [
    { id: 'category', label: 'Esporte' },
    { id: 'city', label: 'São Paulo/SP' },
    { id: 'kind', label: 'Produto' }
  ])
  t.alike(detailChips({ kind: 'procura' }), [{ id: 'kind', label: 'Procura-se' }])
  t.alike(detailChips(null), [])
  t.alike(detailChips({}), [])
  const unsafe = 'Casa\u001b\u202e'
  t.alike(detailChips({ catLabel: unsafe, place: { city: unsafe } }), [
    { id: 'category', label: displayText(unsafe) },
    { id: 'city', label: displayText(unsafe) }
  ])
})

test('listing keeps secondary and owner controls around its new sticky actions', (t) => {
  const src = read('screens/Anuncio.js')
  const pills = src.slice(src.indexOf('<View style={styles.secondaryActions}>'), src.indexOf('<Text style={styles.section}>Descrição'))
  for (const label of ["accessibilityLabel='Compartilhar'", "accessibilityLabel={saved ? 'Salvo' : 'Salvar'}", "label='Avaliar'"]) {
    t.ok(pills.includes(label), label + ' stays under the title')
  }
  t.absent(pills.includes('Denunciar'), 'report left the pill row')
  t.ok(pills.includes("icon='compartilhar'") && pills.includes("icon='estrela'") && !pills.includes("label='Compartilhar'"), 'share and save are icon-only pills')
  t.ok(pills.includes('filled={saved} iconFilled={saved}'), 'a saved listing shows a solid star, not only an accent fill')
  t.ok(readFileSync(join(__dirname, '..', 'src', 'ui', 'Pill.js'), 'utf8').includes('filled={iconFilled === true}'), 'Pill draws the solid icon on request')
  const top = src.slice(src.indexOf('<TopBar'), src.indexOf('<ScrollView'))
  t.ok(top.includes('<MoreButton') && top.includes("label: 'Denunciar'") && top.includes('onDenunciar(reportTarget(listing))'), 'Denunciar lives in the more button')
  const card = read('ui/SellerCard.js')
  t.absent(card.includes('borderRadius') || card.includes('backgroundColor'), 'seller card is a flat row')
  t.ok(card.includes('borderTopWidth: 1, borderBottomWidth: 1'), 'seller card keeps hairlines')
  t.is(src.split('<MediaGrid').length, 2, 'one viewer only')
  t.ok(src.includes('<View style={styles.bleed}><MediaGrid') && src.includes('bleed: { marginHorizontal: -space.lg'), 'photos bleed past the body padding')
  const owner = src.slice(src.indexOf('<View style={styles.ownerActions}>'), src.indexOf('</ScrollView>'))
  t.ok(owner.includes("label={confirmDelete ? 'Confirmar: apagar' : 'Apagar'}") && owner.includes('onPress={apagar}'), 'delete confirmation remains in the owner section')
  t.ok(owner.includes('acts.statuses.map') && owner.includes('setStatus(b.status)'), 'owner keeps status controls')
  t.ok(owner.includes('Sem conexão. Para mudar o anúncio, conecte-se.') && owner.includes('{note}') && owner.includes('{action.error}'), 'feedback remains above the bar')
  t.ok(src.includes("actions.filter((item) => item.id !== 'editar' || (typeof onEditar === 'function' && online))"), 'edit keeps its callback and online guards')
  t.ok(src.includes('canTalk: acts.conversar && typeof onConversar') && src.includes("canOffer: acts.conversar && typeof onOffer === 'function'"), 'sticky actions respect detailActions and optional handlers')
  t.ok(src.includes('price: { ...type.price,'), 'price uses its token')
  t.ok(src.indexOf('<MediaGrid') < src.indexOf('<Text style={styles.price}') && src.indexOf('<Text style={styles.price}') < src.indexOf('<Text style={styles.title}'), 'photos, price and title order')
  t.ok(src.indexOf('detailChips(listing).map') < src.indexOf('>Descrição') && src.indexOf('>Descrição') < src.indexOf('<SellerCard'), 'chips and description precede the seller')
  t.ok(src.includes('onOpenListings={() =>') || src.includes("onOpenListings={typeof onOpenListings === 'function' ? () => onOpenListings(listing.author) : undefined}"), 'seller listings callback gets the author')
  t.ok(src.includes('paddingBottom: barActions.length > 0 ? Math.max(space.lg, barHeight) : space.lg') && src.includes('onHeightChange={setBarHeight}'), 'scroll reserves the measured safe-area bar height')
  t.ok(src.indexOf('<StickyBar') > src.indexOf('</ScrollView>'), 'bar stays outside scrolling content')
})

test('action feedback appears once, inside the visible bar or inline without it', (t) => {
  const src = read('screens/Anuncio.js')
  const bar = src.slice(src.indexOf('<StickyBar'), src.indexOf('<PageNoticeSheet'))
  t.ok(bar.includes('message={barActions.length > 0 ? { text: note, error: action.error } : undefined}'), 'only the visible bar receives both messages')
  t.ok(src.includes("{barActions.length === 0 && note !== '' ? <Soft>{note}</Soft> : null}") && src.split('<Soft>{note}</Soft>').length === 2, 'note stays inline only without the bar')
  t.ok(src.includes("{barActions.length === 0 && action.error !== '' ? <ErrorText>{action.error}</ErrorText> : null}") && src.split('<ErrorText>{action.error}</ErrorText>').length === 2, 'error stays inline only without the bar')
})

test('sticky feedback is safe, themed and announced above the buttons', (t) => {
  const src = read('ui/StickyBar.js')
  const aboveButtons = src.slice(src.indexOf('return ('), src.indexOf('<View style={[styles.buttons'))
  t.ok(aboveButtons.includes("{message?.text ? <Text style={styles.message} accessibilityLiveRegion='polite' accessibilityRole='text'>{displayText(message.text)}</Text> : null}") && /message: \{[^\n]+color: colors.soft/.test(src), 'note is a safe soft live message above the buttons')
  t.ok(aboveButtons.includes("{message?.error ? <Text style={[styles.message, styles.error]} accessibilityLiveRegion='polite' accessibilityRole='alert'>{displayText(message.error)}</Text> : null}") && src.includes('error: { color: colors.danger }'), 'error is a safe danger live alert above the buttons')
})

test('scroll reserves the initial safe-area bar estimate and keeps body padding', (t) => {
  const src = read('screens/Anuncio.js')
  t.ok(src.includes('const insets = useSafeAreaInsets()') && src.includes('const [barHeight, setBarHeight] = useState(layout.hit + space.md * 2 + insets.bottom + 1)') && src.includes('onHeightChange={setBarHeight}'), 'estimate includes the button, vertical padding, safe area and border until measured')
  t.ok(src.includes('body: { padding: space.lg,') && src.includes('paddingBottom: barActions.length > 0 ? Math.max(space.lg, barHeight) : space.lg'), 'bottom padding never falls below body padding')
})

test('conversation and offer share the page gate and resume the chosen action', (t) => {
  const src = read('screens/Anuncio.js')
  const gate = src.slice(src.indexOf('const contactSeller ='), src.indexOf('const startConversation ='))
  const literal = 'listing.page === true && !pageNoticeSeen(pageNoticeStore(), listing.author)'
  t.ok(gate.includes(literal) && src.split(literal).length === 2, 'one notice gate for both actions')
  t.ok(gate.includes('setPageNotice(id)') && gate.includes('await continueContact(id)'), 'notice remembers which button opened it')
  t.ok(src.includes("contactSeller('conversar')") && src.includes("contactSeller('oferta')"), 'both handlers enter the gate')
  const proceed = src.slice(src.indexOf('const continueContact ='), src.indexOf('const contactSeller ='))
  t.ok(/if \(id === 'oferta'\) await action\.run\(\(\) => onOffer\(listing\)\)\s+else if \(id === 'conversar'\) await startConversation\(\)/.test(proceed), 'each remembered id resumes its own handler')
  t.ok(src.includes('continueContact(pageNotice)'), 'sheet resumes the remembered action')
})

test('contact resume reports an unavailable action but stays quiet while pending', (t) => {
  const src = read('screens/Anuncio.js')
  const proceed = src.slice(src.indexOf('const continueContact ='), src.indexOf('const contactSeller ='))
  t.ok(/if \(action.pending \|\| contactAction.current !== null\) return\s+if \(!barActions.some\(\(item\) => item.id === id\)\) \{\s+setNote\('Não deu para continuar agora\. Tente de novo\.'\)\s+return\s+\}/.test(proceed), 'only an unavailable action produces feedback')
})

test('only the running contact action is busy while all bar actions stay disabled', (t) => {
  const src = read('screens/Anuncio.js')
  const proceed = src.slice(src.indexOf('const continueContact ='), src.indexOf('const contactSeller ='))
  t.ok(src.includes('const contactAction = useRef(null)') && src.includes('disabled: action.pending, pending: item.id === contactAction.current && action.pending'), 'busy state belongs to the running id')
  t.ok(/contactAction.current = id\s+setNote\(''\)\s+try \{/.test(proceed) && /finally \{\s+contactAction.current = null/.test(proceed), 'running id is remembered before dispatch and cleared after success or failure')
})

test('description heading and body share the nonempty text guard', (t) => {
  const src = read('screens/Anuncio.js')
  t.ok(/\{listing.text\s+\? \(\s+<>\s+<Text style=\{styles.section\}>Descrição<\/Text>\s+<Text style=\{styles.text\}>\{listing.text\}<\/Text>\s+<\/>\s+\)\s+: null\}/.test(src), 'empty descriptions render neither heading nor body')
})
