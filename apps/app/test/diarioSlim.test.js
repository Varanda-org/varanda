'use strict'

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')

const src = fs.readFileSync(path.join(__dirname, '../src/screens/Diario.js'), 'utf8')
const header = src.slice(src.indexOf('<ProfileHeader\n'), src.indexOf('{outboxList}'))
const sheet = src.slice(src.indexOf('<AboutSheet '), src.indexOf('</AboutSheet>'))

test('Diario: shortcut chips precede the banner, community strips and measured tabs', (t) => {
  const order = ['rows={', '<ProfileShortcuts', 'tabs={', '<ReminderBanner', '<CommunitiesBox', '<PublicGroupsBox', '<View onLayout={(e) => setSegmentedHeight(e.nativeEvent.layout.height)}>', '<Segmented options={tabs} selected={shownTab} onSelect={setTab} />']
  let previous = -1
  for (const part of order) {
    const index = header.indexOf(part)
    t.ok(index > previous, part + ' follows the previous slot')
    previous = index
  }
  t.ok(header.includes('shortcutList(OWN_SHORTCUTS, { salvos: showSalvos, eventos: showEventos, visitas: showVisitas, recados: showRecados, varandinha: showVarandinha })'))
  for (const [id, call] of [['salvos', 'onOpenSalvos()'], ['eventos', 'onOpenEventos(ownPublicKey)'], ['visitas', 'onOpenVisitas()'], ['recados', 'onOpenRecados(ownPublicKey)'], ['varandinha', 'onOpenVarandinha(ownPublicKey)']]) {
    t.ok(header.includes("if (id === '" + id + "') " + call), id + ' keeps its destination')
  }
  t.absent(src.includes('ListGroup'))
  t.absent(src.includes('ListRow'))
  t.absent(src.includes('shortcuts:'))
})

test('Diario: share sits beside the unchanged edit corner', (t) => {
  t.ok(/cornerActions=\{\[\s*profileUrl !== null \? <Pill key='share' icon='compartilhar' accessibilityLabel='compartilhar perfil'/.test(header))
  t.absent(/\bactions=/.test(header))
  t.ok(header.includes("corner={<Pill key='edit' label='Editar perfil' onPress={() => setEditing(true)} maxFontSizeMultiplier={TEXT_CAP} />}"))
  t.ok(header.includes('shareProfileDirect(profileUrl).then((done) => { if (!done) setSharing(true) })'))
})

test('Diario: the about link opens a sheet with padded about, friends and fortune', (t) => {
  t.ok(header.includes('link={<AboutLink label={ABOUT_LABEL_OWN} hint={aboutHint(extraShown.about)} onPress={() => setAboutOpen(true)} />}'))
  t.absent(/\b(?:about|top)=/.test(header))
  t.ok(src.includes('const [aboutOpen, setAboutOpen] = useState(false)'))
  t.ok(sheet.startsWith('<AboutSheet open={aboutOpen} onClose={() => setAboutOpen(false)} title={ABOUT_LABEL_OWN}>'))
  t.ok(sheet.includes('<AboutCard about={extraShown.about} theme={extraShown.theme} />'))
  t.ok(sheet.includes('<Soft>Você ainda não escreveu o Sobre mim.</Soft>'))
  t.ok(sheet.indexOf("rich.status === 'ready'") !== -1 && sheet.indexOf("rich.status === 'ready'") < sheet.indexOf('Você ainda não escreveu o Sobre mim.'), 'the empty text waits for a settled read')
  t.ok(sheet.includes("rich.status === 'failed' || rich.status === 'unsure'") && sheet.includes("'Não deu para ler o seu perfil agora.'") && sheet.includes("'Não deu para ler o seu diário inteiro agora.'"), 'a failed or partial read says so instead of claiming the Sobre mim is empty')
  t.ok(sheet.includes("node.hosted === true ? <Pill label='Editar perfil' onPress={() => { setAboutOpen(false); setEditing(true) }} /> : null"))
  t.ok(sheet.includes("node.hosted === true && typeof onOpenTop === 'function'"))
  t.ok(sheet.includes('onEdit={() => { setAboutOpen(false); onOpenTop() }}'))
  t.ok(sheet.includes("onOpen={typeof onOpenMember === 'function' ? (...args) => { setAboutOpen(false); onOpenMember(...args) } : undefined}"))
  t.ok(sheet.indexOf('<TopFriendsRow') > sheet.indexOf('<AboutCard'))
  t.ok(sheet.indexOf('<SorteCard ownerKey={topOwner} />') > sheet.indexOf('<TopFriendsRow'))
  t.is((sheet.match(/<View style=\{styles.aboutSection\}>/g) || []).length, 3)
  t.ok(src.includes('aboutSection: { paddingHorizontal: space.xl, gap: space.md }'))
})

test('Diario: the avatar ring uses the own live moments and waits for seen state', (t) => {
  t.ok(src.includes('const seenState = useMomentSeen()'))
  t.ok(src.includes('avatarMoments({ data: moments, author: ownPublicKey, ownKey: ownPublicKey, seen: seenState.seen, now })'))
  t.ok(header.includes("moments={node.hosted === true && typeof onOpenMomentos === 'function' && ring !== null"))
  t.ok(header.includes("? { unseen: seenState.loaded && ring.unseen, label: 'seus momentos', onPress: () => onOpenMomentos(ownPublicKey) }\n            : null}"))
  for (const removed of ['DiarioMoments', 'PageMoments', 'ConfirmMomentDelete', 'momentDeleting', 'choicePage']) t.absent(src.includes(removed), removed + ' left the profile')
  t.absent(src.includes('Platform.OS'))
  t.absent(src.includes('\u2014'))
})

// readLog of Diario.js, run from its source with a scripted request.
function readLogOf (request, identityRef) {
  const start = src.indexOf('const readLog = useCallback(')
  const text = src.slice(start, src.indexOf('}, [request])', start) + '}, [request])'.length)
  const unknown = src.slice(src.indexOf('export function isUnknownParam'), src.indexOf('\n}\n', src.indexOf('export function isUnknownParam')) + 2).replace('export ', '')
  // eslint-disable-next-line no-new-func
  return new Function('request', 'identityRef', 'useRef', 'useCallback', unknown + '\nconst plainLogEpochRef = useRef(null)\n' + text + '\nreturn readLog')(request, identityRef, (v) => ({ current: v }), (f) => f)
}

function usage (message) {
  return Object.assign(new Error(message), { code: 'USAGE' })
}

test('Diario: both log reads ask for publications only', (t) => {
  t.ok(/const log = await readLog\(\{ limit: LOG_LIMIT_MAX \}\)/.test(src), 'the newest page')
  t.ok(/const log = await readLog\(\{ limit: LOG_LIMIT_MAX, before \}\)/.test(src), 'an older page')
  t.is(src.split("request('log.read'").length - 1, 2, 'only readLog calls log.read')
})

test('Diario: an older node that refuses posts is read once more without it, for the rest of the epoch', async (t) => {
  const calls = []
  let old = true
  const request = async (method, params) => {
    calls.push(params)
    if (old && params.posts === true) throw usage('parâmetro desconhecido')
    return { entries: [], params }
  }
  const identityRef = { current: { epoch: 1 } }
  const readLog = readLogOf(request, identityRef)
  const first = await readLog({ limit: 30 })
  t.alike(calls, [{ limit: 30, posts: true }, { limit: 30 }], 'one repeat, without posts')
  t.alike(first.params, { limit: 30 })
  calls.length = 0
  await readLog({ limit: 30, before: 9 })
  t.alike(calls, [{ limit: 30, before: 9 }], 'remembered for the epoch')
  calls.length = 0
  old = false
  identityRef.current = { epoch: 2 }
  await readLog({ limit: 30 })
  t.alike(calls, [{ limit: 30, posts: true }], 'a new epoch asks again')
})

test('Diario: any other log.read failure is not repeated', async (t) => {
  for (const err of [usage('ocupado'), Object.assign(new Error('parâmetro desconhecido'), { code: 'CLOSED' }), Object.assign(new Error('tempo esgotado'), { code: 'TIMEOUT' })]) {
    const calls = []
    const readLog = readLogOf(async (method, params) => { calls.push(params); throw err }, { current: { epoch: 1 } })
    await t.exception(readLog({ limit: 30 }), new RegExp(err.message))
    t.is(calls.length, 1, err.code + ' ' + err.message + ': one request')
  }
})

test('Diario: with older pages left and no publication shown, the list is never blank', (t) => {
  const block = src.slice(src.indexOf('  const skeleton = '), src.indexOf('  const [editTarget, setEditTarget]'))
  const notEnd = block.slice(block.indexOf('empty = !data.atEnd'), block.indexOf('<EmptyState'))
  t.ok(notEnd.includes('<ErrorState message={olderError} onRetry={loadOlder} pending={loadingMore} />'), 'the error with Tentar de novo')
  t.ok(/loadingMore \|\| newestLoading \|\| postsFill === 'more'\s+\? skeleton/.test(notEnd), 'skeleton rows while loading or filling')
  t.ok(notEnd.includes("<Pill label='Carregar mais' onPress={loadOlder} />"), 'otherwise the button')
  t.absent(notEnd.includes('ListFooter'), 'never a bare ListFooter')
  t.ok(block.includes('const skeleton = <View>{[0, 1, 2].map((row) => <SkeletonRow key={row} />)}</View>'))
  t.ok(src.includes("loadMore: { alignItems: 'center', paddingVertical: space.lg }"))
})
