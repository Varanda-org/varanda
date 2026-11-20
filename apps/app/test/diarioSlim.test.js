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
