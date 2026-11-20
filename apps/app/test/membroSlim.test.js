import test from 'brittle'
import { readFileSync } from 'node:fs'
import { avatarMoments } from '../src/profileSlim.js'

const read = (file) => readFileSync(new URL(file, import.meta.url), 'utf8')
const src = read('../src/screens/Membro.js')
const app = read('../App.js')
const header = src.slice(src.indexOf('      <ProfileHeader'), src.indexOf('      {profileUrl !== null'))

test('member avatar opens live moments only for self or a followed author on a hosted node', (t) => {
  t.ok(src.includes('onOpenVarandinha, onOpenMomentos, onToast'), 'accepts the viewer handler')
  t.ok(src.includes('const momentsData = useMoments({ ownKey, active: true, tick })'), 'follow changes and refresh reload moments')
  t.ok(src.includes('const seenState = useMomentSeen()'), 'uses the shared seen state')
  t.ok(src.includes('avatarMoments({ data: momentsData, author, ownKey, seen: seenState.seen, now })'), 'live ring uses this author and the visible clock')
  t.ok(src.includes("node.hosted === true && !blockedHere && (own || isFollowed) && typeof onOpenMomentos === 'function' && ring !== null"), 'all ring gates are required')
  t.ok(src.includes('unseen: seenState.loaded && ring.unseen'), 'seen state must finish loading before highlighting')
  t.ok(src.includes("label: own ? 'seus momentos' : 'momentos de ' + displayText(who.title)"), 'display-safe accessible label')
  t.ok(src.includes('onPress: () => onOpenMomentos(author)'), 'opens this author')
  t.ok(header.includes('moments={moments}'), 'wires the ring into the avatar')
  t.ok(src.indexOf('const momentsData = useMoments') < src.indexOf('  if (!full) {\n    return ('), 'hooks precede the offline return')
})

test('member about link opens a sheet with the about card, best friends and visible ratings', (t) => {
  const sheet = src.slice(src.indexOf('      <AboutSheet'), src.indexOf('      </AboutSheet>'))
  t.ok(src.includes('const [aboutOpen, setAboutOpen] = useState(false)'), 'sheet starts closed')
  t.ok(header.includes('link={aboutEntry({ about: extraShown.about, top: topShown, ratings: ratingsRow !== null && !blockedHere })'), 'link only when there is content')
  t.ok(src.includes('const topShown = hostedHere && !own && topRead.view && (topRead.view.rows.length > 0 || topRead.view.notice)'), 'preserves best-friends visibility')
  t.ok(header.includes('<AboutLink label={ABOUT_LABEL}'), 'shared Sobre label')
  t.ok(header.includes('aboutHint(extraShown.about, ratingsRow !== null && !blockedHere ? [summaryLabel(rated.summary)] : [])'), 'hint includes only visible ratings')
  t.ok(header.includes('onPress={() => setAboutOpen(true)}'), 'opens the sheet')
  t.absent(/\n\s+(about|top)=/.test(header), 'expanded content leaves the header')
  t.ok(sheet.includes('open={aboutOpen} onClose={() => setAboutOpen(false)} title={ABOUT_LABEL}'), 'sheet can close')
  t.ok(sheet.includes('<View style={styles.aboutSection}>\n              <AboutCard about={extraShown.about} theme={extraShown.theme} />'), 'about card retains its theme and the sheet side padding')
  t.ok(sheet.includes('<View style={styles.aboutSection}>\n              <TopFriendsRow rows={topRead.view.rows} notice={topRead.view.notice}'), 'best friends retain rows, notice and the sheet side padding')
  t.ok(src.includes('aboutSection: { paddingHorizontal: space.xl }'), 'the sheet pads like the own profile sheet')
  t.ok(sheet.includes("onOpen={typeof onOpenMember === 'function' ? (...args) => { setAboutOpen(false); onOpenMember(...args) } : undefined}"), 'closes before opening a friend and keeps the name seed')
  t.ok(sheet.includes('{!blockedHere ? ratingsRow : null}'), 'blocked profiles cannot show ratings')
  t.absent(src.includes('SorteCard'), 'no fortune card on another profile')
})

test('member shortcuts preserve visibility and open each destination for this author', (t) => {
  t.ok(header.includes('rows={blockedHere ? null : <ProfileShortcuts'), 'blocked profiles have no strip')
  t.ok(header.includes('items={shortcutList(MEMBER_SHORTCUTS, { anuncios: listingsRow, recados: recadosRow, varandinha: varandinhaRow, eventos: eventosRow })}'), 'shared order and per-destination flags')
  t.ok(header.includes('onOpen={openShortcut}'), 'strip dispatches selections')
  for (const [flag, handler] of [['listingsRow', 'onOpenListings'], ['recadosRow', 'onOpenRecados'], ['eventosRow', 'onOpenEventos']]) {
    t.ok(src.includes(`const ${flag} = node.hosted === true && !(isPage && lifecycle.moved) && typeof ${handler} === 'function'\n`), flag + ' keeps its original condition')
  }
  t.ok(src.includes("const varandinhaRow = hostedHere && gardenOn && typeof onOpenVarandinha === 'function'\n"), 'garden requires its verified flag')
  for (const [id, handler] of [['anuncios', 'onOpenListings'], ['recados', 'onOpenRecados'], ['varandinha', 'onOpenVarandinha'], ['eventos', 'onOpenEventos']]) {
    t.ok(src.includes(`if (id === '${id}') ${handler}(author)`), id + ' opens this author')
  }
  t.absent(/\blink(Row|Text):/.test(src), 'old row styles removed')
  t.ok(src.includes('pressed: '), 'roster press feedback retained')
})

test('stack passes the author-aware momentos handler to Membro', (t) => {
  const props = app.slice(app.indexOf('    const screenProps = {'), app.indexOf('    const renderStackEntry'))
  t.ok(props.includes('onOpenMomentos: openMomentos'), 'shared stack props include the handler')
  t.ok(app.includes(': MembroMemo\n') && app.includes('<Screen entry={entry} {...screenProps}'), 'member receives the shared props')
  t.ok(app.includes('const openMomentos = useCallback((key) => {'), 'viewer accepts an author key')
  t.ok(app.includes("pushScreen({ screen: 'momentos', key: key.toLowerCase(), params: {} })"), 'viewer starts at that author')
})

test('an author absent after an unfollow has no live avatar ring', (t) => {
  const ownKey = 'a'.repeat(64)
  const author = 'b'.repeat(64)
  const now = 1000000
  const item = { ref: author + ':1', at: new Date(now - 1000).toISOString() }
  const data = { phase: 'ready', own: [], authors: [{ author, items: [item] }] }
  const input = { data, author, ownKey, seen: [], now }
  t.alike(avatarMoments(input), { count: 1, unseen: true }, 'live unseen author has a ring')
  t.alike(avatarMoments({ ...input, seen: [item.ref] }), { count: 1, unseen: false }, 'seen ring remains tappable')
  t.is(avatarMoments({ ...input, data: { ...data, authors: [] } }), null, 'unfollowed author absent from the read has no ring')
  t.is(avatarMoments({ ...input, now: now + 86400000 }), null, 'expired moments have no ring')
})

test('member profile stays shared across platforms and uses no em dash', (t) => {
  t.absent(src.includes('Platform.OS'))
  t.absent(src.includes('\u2014'))
})
