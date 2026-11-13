'use strict'

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const read = (file) => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')

test('profile header wraps counts, uses token spacing and adapts its avatar', (t) => {
  const src = read('ui/ProfileHeader.js')
  t.ok(/countsRow: \{[^\n]*flexWrap: 'wrap'/.test(src))
  t.ok(src.includes('counts: { ...type.postMeta, color: colors.soft, flexShrink: 1 }'))
  t.ok(src.includes('columnGap: space.lg, rowGap: space.sm, marginTop: space.sm'))
  t.ok(src.includes('bio: { ...type.postText, color: colors.ink, marginTop: space.sm }'))
  t.ok(src.includes("data: { width: '100%', maxWidth: layout.column, alignSelf: 'center'"))
  t.ok(src.includes('size={avatarSize}'))
  t.ok(src.includes('marginTop: -avatarSize / 2'))
  const size = src.match(/const avatarSize = (.+)/)
  t.ok(size)
  if (!size) return
  for (const [width, expected] of [[390, 88], [1280, 72]]) {
    t.is(vm.runInNewContext(size[1], { width, layout: { column: 640, hit: 44 }, space: { xxl: 32, sm: 8 } }), expected)
  }
})

test('profiles show a skeleton header and rows on the first load', (t) => {
  const header = read('ui/ProfileHeader.js')
  t.ok(/\{loading\s+\? <SkeletonRow \/>/.test(header))
  const diary = read('screens/Diario.js')
  t.ok(diary.includes('{loadError ? <View style={[styles.plainBand, { height: bandHeight }]} /> : <ProfileHeader loading bandHeight={bandHeight} />}'))
  t.ok(diary.includes('plainBand: { backgroundColor: colors.bg }'))
  const member = read('screens/Membro.js')
  t.ok(member.includes('loading={full && profilePending && !header.name && !header.username}'))
  for (const src of [diary, member]) t.ok(src.includes('<><SkeletonRow /><SkeletonRow /><SkeletonRow /></>'))
})

test('header actions and the sticky bar use press feedback', (t) => {
  const header = read('ui/ProfileHeader.js')
  t.ok(/<PressScale[\s\S]*?onPress={onBack}/.test(header))
  t.ok(/<PressScale\s+key={c.label}/.test(header))
  t.absent(header.includes('ProfileAction'))
  const diary = read('screens/Diario.js')
  t.ok(diary.includes("<Pill key='edit'"))
  t.ok(diary.includes("<Pill key='share'"))
  t.ok(/<PressScale\s+accessibilityRole='button'\s+accessibilityLabel='Ajustes'/.test(diary))
  t.ok(read('screens/Membro.js').includes("<Pill icon='mensagem'"))
  t.ok(read('ui/ProfileBar.js').includes('<PressScale'))
})

test('outbox and member progress share an accessible status badge', (t) => {
  const diary = read('screens/Diario.js')
  for (const [icon, label] of [['sinc', 'enviando…'], ['seta_cima', 'toque para enviar'], ['semconexao', 'vai sair quando a conexão voltar']]) {
    t.ok(diary.includes("<ProfileStatus icon='" + icon + "' label='" + label + "' />"))
  }
  const header = read('ui/ProfileHeader.js')
  t.ok(header.includes("<View style={styles.status} accessible accessibilityLabel={label} accessibilityLiveRegion='polite'>"))
  t.ok(header.includes('<Icon name={icon} size={space.lg} />'))
  t.ok(header.includes('backgroundColor: colors.warm'))
  const member = read('screens/Membro.js')
  t.ok(member.includes("<ProfileStatus icon='sinc' label='Ainda montando a lista completa…' />"))
  t.ok(member.includes("if (phase === 'ready' && !indexing && complete === false)"))
})

test('member empty state waits for a complete diary and offers no action', (t) => {
  const src = read('screens/Membro.js')
  t.ok(src.includes("else if (unavailable === 0 && atEnd && !indexing && complete !== false) empty = <EmptyState icon='lapis' title='Nenhuma publicação ainda' body={isPage ? 'As publicações desta Página aparecem aqui.' : 'As publicações desta pessoa aparecem aqui.'} />"))
})

test('member ratings have a heading and listings have no unverified count', (t) => {
  const src = read('screens/Membro.js')
  t.ok(src.includes("<Text accessibilityRole='header' style={styles.rosterName}>Avaliações</Text>"))
  t.absent(src.includes('listingCount'))
  t.absent(src.includes('setListingCount'))
  t.ok(src.includes("<PressScale accessibilityRole='link' accessibilityLabel='Anúncios'"))
  t.ok(src.includes('<Text style={styles.linkText}>Anúncios</Text>'))
})

test('notices explain capability limits and page unavailability', async (t) => {
  const src = read('screens/Avisos.js')
  t.ok(src.includes("import { NOT_HOSTED } from '../pessoas'"))
  t.ok(src.includes("if (notice === 'web-only' && node.hosted !== true) {\n    empty = <EmptyState icon='sino' title='Avisos indisponíveis' body={NOT_HOSTED} actionLabel='Saiba mais' onAction={() => setHelpOpen(true)} />"))
  t.ok(src.includes("} else if (notice === 'web-only') {\n    empty = <EmptyState icon='sino' title='Avisos indisponíveis' body='Os Avisos não estão disponíveis nesta conexão.' />"))
  t.ok(src.includes("body='A instalação ainda não oferece avisos para páginas. Tente de novo mais tarde.' actionLabel='Tentar de novo' onAction={loadFirst}"))
  t.ok(src.includes('<HelpSheet open={helpOpen} onClose={() => setHelpOpen(false)} doc={HELP.avisos} />'))
  const { noticesNotice } = await import('../src/notices.js')
  t.is(noticesNotice({ hosted: false, supported: true, online: true, loadedAt: null }), 'web-only')
  t.is(noticesNotice({ hosted: true, supported: false, online: true, loadedAt: null }), 'unsupported')
})

test('notices use skeleton rows and feedback for both row destinations', (t) => {
  const src = read('screens/Avisos.js')
  t.ok(src.includes('empty = <><SkeletonRow /><SkeletonRow /><SkeletonRow /></>'))
  const row = src.slice(src.indexOf('function NoticeRow'), src.indexOf('export default function Avisos'))
  t.is((row.match(/<PressScale\s/g) || []).length, 2)
})

test('notice press feedback forwards the original destination hints', (t) => {
  const press = read('ui/PressScale.js')
  t.ok(press.includes("accessibilityLabel, accessibilityHint, accessibilityRole = 'button'"))
  t.ok(press.includes('accessibilityHint={accessibilityHint}'))
  const src = read('screens/Avisos.js')
  t.ok(src.includes("accessibilityHint={ref === null ? undefined : 'abre a conversa'}"))
  t.ok(src.includes("accessibilityHint='abre o perfil'"))
})

test('member header stops loading when an unnamed profile answers before posts', async (t) => {
  const src = read('screens/Membro.js')
  t.ok(src.includes('const [profilePending, setProfilePending] = useState(true)'))
  const start = src.indexOf('const load = useCallback(async (refreshing = false) => {')
  const end = src.indexOf('    if (blockedHere) {', start)
  const prefix = src.slice(src.indexOf('=> {', start) + 4, end)
  let resolveProfile
  let profilePending = false
  const genRef = { current: 0 }
  const context = {
    genRef,
    commit: () => {},
    INITIAL_POSTS: {},
    commitHeader: () => {},
    headerRef: { current: {} },
    setProfilePending: (pending) => { profilePending = pending },
    blockedHere: true,
    readProfile: () => new Promise((resolve) => { resolveProfile = resolve })
  }
  const load = vm.runInNewContext('(async (refreshing = false) => {' + prefix + '})', context)
  const expression = src.match(/loading={(full && [^}]+)}/)[1]
  const loading = () => vm.runInNewContext(expression, {
    full: true,
    profilePending,
    header: { name: null, username: null, verified: true },
    posts: { phase: 'loading' }
  })
  const pending = load()
  t.ok(loading(), 'the initial profile read is still pending')
  resolveProfile(true)
  await pending
  t.absent(loading(), 'an unnamed verified profile exposes actions while posts still load')
  const refresh = load(true)
  t.absent(loading(), 'refresh keeps an unnamed profile header and its actions visible')
  resolveProfile(true)
  await refresh
  t.absent(loading(), 'the refreshed profile header remains visible')
  const failed = load()
  resolveProfile(false)
  await failed
  t.absent(loading(), 'a failed profile read also exposes the fallback header')
  const stale = load()
  genRef.current++
  resolveProfile(true)
  await stale
  t.ok(profilePending, 'an obsolete read cannot settle the current header')
})
