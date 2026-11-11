'use strict'

// The varanda:// URLs the native app is opened with (src/linkReturn.js).
const test = require('brittle')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const load = () => import('../src/linkReturn.js')
const R = crypto.randomBytes(32).toString('base64url')
const CODE = 'aB3_-'.repeat(8) + 'xyz'
const KEY = 'ab'.repeat(32)

async function withOrigin (t, origin) {
  const { setInstallation } = await import('../src/installation.js')
  t.ok(setInstallation(origin))
  t.teardown(() => setInstallation(null))
}

test('parseAppReturn: varanda://conta is not a return in any shape', async (t) => {
  const { parseAppReturn } = await load()
  for (const outcome of ['ok', 'erro', 'cancelado', 'lista-de-espera', 'convite-invalido']) {
    t.is(parseAppReturn('varanda://conta?conta=' + outcome), null, outcome)
    t.is(parseAppReturn('varanda://conta?conta=' + outcome + '&codigo=' + R), null, outcome + ' with a code')
  }
  for (const url of [
    'varanda://conta?conta=ok&codigo=' + R + '#frag', 'varanda://conta?x=1&conta=erro&y',
    'varanda://conta?conta=ok&codigo=' + R + '&codigo=' + R, 'varanda://conta?codigo=' + R, 'varanda://conta?'
  ]) {
    t.is(parseAppReturn(url), null, url)
  }
})

test('parseAppReturn: the age return', async (t) => {
  const { parseAppReturn } = await load()
  t.alike(parseAppReturn('varanda://idade?volta=1'), { kind: 'idade' })
  t.alike(parseAppReturn('varanda://idade?status=x&volta=1'), { kind: 'idade' })
  for (const bad of ['varanda://idade?volta=0', 'varanda://idade?', 'varanda://idade', 'varanda://idade?volta=1&volta=1']) {
    t.is(parseAppReturn(bad), null, bad)
  }
})

test('parseAppReturn: strict on scheme and host', async (t) => {
  const { parseAppReturn } = await load()
  for (const bad of [
    'varanda://conta', 'varanda://conta/?conta=ok', 'varanda:///conta?conta=ok', 'Varanda://conta?conta=ok',
    'varanda://CONTA?conta=ok', 'varanda://conta.evil?conta=ok', 'https://conta?conta=ok', 'evil://conta?conta=ok',
    'varanda://conta?conta=talvez', 'varanda://conta?conta=OK', 'varanda://conta?conta=ok\n', ' varanda://conta?conta=ok',
    'varanda://conta?conta=ok&codigo=' + 'A'.repeat(400), 'varanda://x?conta=ok', null, 5, undefined
  ]) {
    t.is(parseAppReturn(bad), null, String(bad))
  }
})

test('parseAppLink: empty-host varanda paths', async (t) => {
  const { parseAppLink } = await load()
  t.alike(parseAppLink('varanda:///convite/' + CODE), { kind: 'convite', code: CODE })
  t.alike(parseAppLink('varanda:///@Ana_01'), { kind: 'perfil', username: 'ana_01' })
  t.alike(parseAppLink('varanda:///m/' + KEY.toUpperCase()), { kind: 'perfil', key: KEY })
  t.alike(parseAppLink('varanda:///convite/' + CODE + '?x=1'), { kind: 'convite', code: CODE })
})

test('parseAppLink: rejects host forms and malformed links', async (t) => {
  const { parseAppLink } = await load()
  for (const bad of [
    'varanda://convite/' + CODE, 'varanda://@ana', 'varanda://m/' + KEY, 'varanda:////convite/' + CODE,
    'varanda:///convite/' + CODE.slice(1), 'varanda:///convite/' + CODE + '/x', 'varanda:///@an',
    'varanda:///@ana%2F', 'varanda:///m/' + KEY.slice(1), 'varanda:///', 'varanda:///conta?conta=ok',
    'https://example.test/convite/' + CODE, 'varanda:///@ana\\x', null, ''
  ]) {
    t.is(parseAppLink(bad), null, String(bad))
  }
})

test('parseAppLink: https only on the installation origin', async (t) => {
  const { parseAppLink } = await load()
  await withOrigin(t, 'https://varanda.example')
  t.alike(parseAppLink('https://varanda.example/convite/' + CODE), { kind: 'convite', code: CODE })
  t.alike(parseAppLink('https://varanda.example/@ana'), { kind: 'perfil', username: 'ana' })
  t.alike(parseAppLink('https://varanda.example/m/' + KEY + '#x'), { kind: 'perfil', key: KEY })
  for (const bad of [
    'https://varanda.example.evil/convite/' + CODE, 'https://evil.example/convite/' + CODE,
    'http://varanda.example/convite/' + CODE, 'https://varanda.example@evil.example/convite/' + CODE,
    'https://evil.example/https://varanda.example/convite/' + CODE, 'https://varanda.example//evil.example/@ana',
    'https://VARANDA.example/@ana', 'https://varanda.example:8443/@ana'
  ]) {
    t.is(parseAppLink(bad), null, bad)
  }
})

test('parseAppLink: no https link while the installation is a loopback http one', async (t) => {
  const { parseAppLink } = await load()
  await withOrigin(t, 'http://127.0.0.1:8790')
  t.is(parseAppLink('http://127.0.0.1:8790/convite/' + CODE), null)
})

test('parseAppLink: group and community links', async (t) => {
  const { parseAppLink } = await load()
  t.alike(parseAppLink('varanda:///g/' + KEY), { kind: 'grupo', key: KEY })
  t.alike(parseAppLink('varanda:///c/' + KEY), { kind: 'comunidade', key: KEY })
  t.alike(parseAppLink('varanda:///g/' + KEY + '?x=1'), { kind: 'grupo', key: KEY })
  for (const bad of [
    'varanda:///g/' + KEY.toUpperCase(), 'varanda:///c/' + KEY.toUpperCase(),
    'varanda:///g/' + KEY.slice(1), 'varanda:///c/' + KEY.slice(1),
    'varanda:///g/' + KEY + '/x', 'varanda:///c/' + KEY + '/x',
    'varanda://g/' + KEY, 'varanda://c/' + KEY, 'varanda:////g/' + KEY,
    'https://varanda.example/g/' + KEY, 'https://varanda.example/c/' + KEY
  ]) {
    t.is(parseAppLink(bad), null, bad)
  }
})

test('parseAppLink: https group and community links only on the installation origin', async (t) => {
  const { parseAppLink } = await load()
  await withOrigin(t, 'https://varanda.example')
  t.alike(parseAppLink('https://varanda.example/g/' + KEY), { kind: 'grupo', key: KEY })
  t.alike(parseAppLink('https://varanda.example/c/' + KEY + '#x'), { kind: 'comunidade', key: KEY })
  for (const bad of [
    'https://evil.example/g/' + KEY, 'https://varanda.example.evil/c/' + KEY,
    'http://varanda.example/g/' + KEY, 'https://varanda.example//g/' + KEY,
    'https://varanda.example/g/' + KEY.toUpperCase()
  ]) {
    t.is(parseAppLink(bad), null, bad)
  }
})

test('parseAppLink: no https group link while the installation is a loopback http one', async (t) => {
  const { parseAppLink } = await load()
  await withOrigin(t, 'http://127.0.0.1:8790')
  t.is(parseAppLink('http://127.0.0.1:8790/g/' + KEY), null)
  t.is(parseAppLink('http://127.0.0.1:8790/c/' + KEY), null)
})

test('parseAppLink: listing links accept both paths and ignore fragments', async (t) => {
  const { parseAppLink, parseInviteInput } = await load()
  await withOrigin(t, 'https://varanda.example')
  for (const prefix of ['https://varanda.example', 'varanda://']) {
    for (const path of ['/anuncio/', '/f/']) {
      const url = prefix + path + KEY + '/12'
      const target = { kind: 'anuncio', author: KEY, seq: 12 }
      t.alike(parseAppLink(url), target)
      t.alike(parseAppLink(url + '#fragment'), target)
      t.alike(parseAppLink(url + '?x=1#fragment'), target)
      t.is(parseInviteInput(url), null, 'a listing is not an invite')
    }
  }
  const upper = 'AB'.repeat(32)
  t.alike(parseAppLink('varanda:///anuncio/' + upper + '/3'), { kind: 'anuncio', author: upper.toLowerCase(), seq: 3 }, 'uppercase hex is lowercased, as on the web')
})

test('parseAppLink: listing links reject malformed paths and foreign origins', async (t) => {
  const { parseAppLink } = await load()
  await withOrigin(t, 'https://varanda.example')
  for (const path of ['/anuncio/', '/f/']) {
    for (const tail of [KEY.slice(1) + '/1', KEY + '/1/extra', KEY + '/1/', KEY, KEY + '/0', KEY + '/01', KEY + '/-1', KEY + '/1.5', KEY + '/9007199254740992']) {
      t.is(parseAppLink('https://varanda.example' + path + tail), null, tail)
    }
    for (const origin of ['https://foreign.example', 'https://varanda.example.evil', 'https://varanda.example@evil.example', 'https://varanda.example:8443', 'http://varanda.example']) {
      t.is(parseAppLink(origin + path + KEY + '/1'), null, origin)
    }
  }
})

test('parseAppLink: listing https links wait for the installation', async (t) => {
  const { parseAppLink, waitsForInstallation } = await load()
  const { setInstallation } = await import('../src/installation.js')
  setInstallation(null)
  t.teardown(() => setInstallation(null))
  const url = 'https://varanda.example/anuncio/' + KEY + '/1'
  t.is(parseAppLink(url), null)
  t.ok(waitsForInstallation(url))
  t.ok(setInstallation('https://varanda.example'))
  t.absent(waitsForInstallation(url))
  t.alike(parseAppLink(url), { kind: 'anuncio', author: KEY, seq: 1 })
})

test('parseInviteInput: a group or community link is not an invite', async (t) => {
  const { parseInviteInput, parseAppLink } = await load()
  await withOrigin(t, 'https://varanda.example')
  for (const url of ['https://varanda.example/g/' + KEY, 'varanda:///g/' + KEY, 'varanda:///c/' + KEY]) {
    t.ok(parseAppLink(url), url + ' parses as a link')
    t.is(parseInviteInput(url), null, url)
  }
})

test('parseInviteInput: bare code or a full invite link', async (t) => {
  const { parseInviteInput } = await load()
  await withOrigin(t, 'https://varanda.example')
  t.is(parseInviteInput('  ' + CODE + '\n'), CODE)
  t.is(parseInviteInput('https://varanda.example/convite/' + CODE), CODE)
  t.is(parseInviteInput(' varanda:///convite/' + CODE + ' '), CODE)
  for (const bad of ['https://evil.example/convite/' + CODE, CODE.slice(2), 'https://varanda.example/@ana', '', null]) {
    t.is(parseInviteInput(bad), null, String(bad))
  }
})

test('parseInviteInput: a 400-char card link still yields the code', async (t) => {
  const { parseInviteInput } = await load()
  await withOrigin(t, 'https://varanda.example')
  for (const prefix of ['varanda:///convite/' + CODE + '?c=3#c1.', 'https://varanda.example/convite/' + CODE + '?c=3#c1.']) {
    const url = prefix + 'A'.repeat(400 - prefix.length)
    t.is(url.length, 400)
    t.is(parseInviteInput(url), CODE, prefix.slice(0, 12))
  }
})

test('parseInviteInput: a 401-char card link yields nothing', async (t) => {
  const { parseInviteInput } = await load()
  await withOrigin(t, 'https://varanda.example')
  for (const prefix of ['varanda:///convite/' + CODE + '?c=3#c1.', 'https://varanda.example/convite/' + CODE + '?c=3#c1.']) {
    const url = prefix + 'A'.repeat(401 - prefix.length)
    t.is(url.length, 401)
    t.is(parseInviteInput(url), null, prefix.slice(0, 12))
  }
})

test('invite refusals and the native drop', async (t) => {
  const { isInviteRefusal, dropsHeldInvite } = await load()
  t.ok(isInviteRefusal({ code: 'convite-obrigatorio' }))
  t.ok(isInviteRefusal({ code: 'convite-invalido' }))
  t.absent(isInviteRefusal({ code: 'expirado' }))
  t.absent(isInviteRefusal(null))
  t.ok(dropsHeldInvite({ code: 'convite-invalido' }, true), 'the app drops a refused code')
  t.absent(dropsHeldInvite({ code: 'convite-invalido' }, false), 'the web keeps its stored code')
  t.absent(dropsHeldInvite({ code: 'convite-obrigatorio' }, true))
  t.absent(dropsHeldInvite({ code: 'lista-de-espera' }, true))
  t.absent(dropsHeldInvite(undefined, true))
})

test('invitePasteShown decision', async (t) => {
  const { invitePasteShown } = await load()
  t.ok(invitePasteShown({ native: true, required: true, held: false }))
  t.ok(invitePasteShown({ native: true, required: false, held: false, refused: true }), 'a refusal shows it even when the policy read failed')
  t.absent(invitePasteShown({ native: true, required: true, held: true }), 'a held code hides it')
  t.absent(invitePasteShown({ native: true, required: true, held: true, refused: true }))
  t.absent(invitePasteShown({ native: true, required: false, held: false }))
  t.absent(invitePasteShown({ native: true, required: undefined, held: false }))
  t.absent(invitePasteShown({ native: false, required: true, held: false, refused: true }), 'never on the web')
  t.absent(invitePasteShown())
})

test('createLinkToken: an older lookup is stale once a newer link arrives', async (t) => {
  const { createLinkToken } = await load()
  const tok = createLinkToken()
  const first = tok.current()
  t.ok(tok.isCurrent(first))
  const a = tok.next()
  t.ok(tok.isCurrent(a))
  t.absent(tok.isCurrent(first))
  const b = tok.next()
  t.absent(tok.isCurrent(a), 'the lookup for the older link is ignored')
  t.ok(tok.isCurrent(b))
})

test('native store: a convite-invalido answer drops the held code so the field shows again', async (t) => {
  const { dropsHeldInvite, invitePasteShown } = await load()
  const n = await import('../src/signupInviteStore.native.js')
  t.teardown(() => n.dropSignupInvite())
  t.ok(n.captureSignupInvite(CODE, { paste: true }))
  t.absent(invitePasteShown({ native: true, required: true, held: n.loadSignupInvite() !== null }))
  const err = { code: 'convite-invalido' }
  if (dropsHeldInvite(err, true)) n.dropSignupInvite()
  t.is(n.loadSignupInvite(), null)
  t.ok(invitePasteShown({ native: true, required: true, held: n.loadSignupInvite() !== null, refused: true }))
})

test('waitsForInstallation holds only a clean https link while no installation is loaded', async (t) => {
  const { waitsForInstallation, parseAppLink } = await load()
  const { setInstallation } = await import('../src/installation.js')
  setInstallation(null)
  t.is(waitsForInstallation('https://bora.varanda.app/c/' + KEY), true)
  for (const bad of [
    'varanda:///c/' + KEY, 'http://bora.varanda.app/c/' + KEY, 'https://bora.varanda.app/c/ ' + KEY,
    'https://bora.varanda.app/c/' + KEY + '\n', 'https://bora.varanda.app/' + 'a'.repeat(400), null, undefined, 42, {}
  ]) {
    t.is(waitsForInstallation(bad), false, String(bad))
  }
  await withOrigin(t, 'https://varanda.example')
  t.is(waitsForInstallation('https://bora.varanda.app/c/' + KEY), false)
  t.is(waitsForInstallation('https://varanda.example/c/' + KEY), false)
  t.alike(parseAppLink('https://varanda.example/c/' + KEY), { kind: 'comunidade', key: KEY })
  t.is(parseAppLink('https://bora.varanda.app/c/' + KEY), null)
})

test('the shell has no Google return and no linkReturnTaker', async (t) => {
  const s = fs.readFileSync(path.join(__dirname, '../App.js'), 'utf8')
  for (const gone of ['LINK_RETURN', 'linkReturnTaker', 'linkReturnRef', 'dropLinkReturn', 'linkReturned', "setAjustes('conta')"]) {
    t.absent(s.includes(gone), gone)
  }
  const m = await load()
  t.is(m.linkReturnTaker, undefined)
  for (const kept of ['createLinkToken', 'parseAppLink', 'parseAppReturn', 'parseInviteInput', 'invitePasteShown', 'dropsHeldInvite', 'isInviteRefusal', 'waitsForInstallation']) {
    t.is(typeof m[kept], 'function', kept)
  }
  const src = fs.readFileSync(path.join(__dirname, '../src/linkReturn.js'), 'utf8')
  t.absent(src.includes('Platform'))
})

test('the signup offer is armed by the setup card when it lands the certificate', (t) => {
  const s = fs.readFileSync(path.join(__dirname, '../App.js'), 'utf8')
  t.ok(s.includes('const takeLinked = useCallback(() => { signupRef.current = true }, [])'))
  t.is(s.split('signupRef.current = true').length - 1, 1)
  const prop = 'onLinked={takeLinked}'
  t.is(s.split(prop).length - 1, 1)
  const open = s.indexOf('<Identidade active={ready} embedded setup')
  t.ok(s.slice(open, s.indexOf('/>', open)).includes(prop))
  const id = fs.readFileSync(path.join(__dirname, '../src/screens/Identidade.js'), 'utf8')
  t.ok(id.includes('onLinked={setup ? onLinked : undefined}'))
  const call = "if (typeof onLinked === 'function') onLinked()"
  const at = id.indexOf(call)
  t.ok(at > id.indexOf("await node.request('cert.add', { cert })"))
  const aj = fs.readFileSync(path.join(__dirname, '../src/screens/Ajustes.js'), 'utf8')
  t.absent(aj.includes('onLinked'))
})

test('the phone explainer comes before Telefone and its delete never opens the Ajustes list', (t) => {
  const s = fs.readFileSync(path.join(__dirname, '../App.js'), 'utf8')
  t.ok(/import \{ showExplainer \} from '\.\/src\/phoneExplainer'/.test(s))
  const aviso = "} else if (step === 'telefone' && phoneAviso) {"
  const base = "} else if (step === 'telefone') {"
  t.ok(s.includes(aviso))
  t.ok(s.indexOf(aviso) < s.indexOf(base))
  t.ok(s.includes('<TelefoneAviso onContinue={() => setPhoneAckFor(member)} onDelete={openAvisoDelete} />'))
  t.ok(s.includes('const phoneAviso = showExplainer({'))
  t.ok(s.includes('acknowledged: member !== null && phoneAckFor === member'))
  t.ok(s.includes("setAjustes(deleteFromAviso && screen !== 'excluir' ? null : screen)"))
  t.ok(s.includes('screen={ajustes} onNavigate={navigateAjustes}'))
  t.ok(s.includes('useEffect(() => { if (ajustes === null) setDeleteFromAviso(false) }, [ajustes])'))
  const open = s.slice(s.indexOf('const openAvisoDelete = useCallback'), s.indexOf('const navigateAjustes'))
  t.ok(open.includes('setDeleteFromAviso(true)'))
  t.ok(open.includes("setAjustes('excluir')"))
  t.absent(/phoneAck[^\n]*(Storage|storage|save|persist)/.test(s))
})

test('a lock drops the post-signup install offer', (t) => {
  const s = fs.readFileSync(path.join(__dirname, '../App.js'), 'utf8')
  t.ok(s.includes('useEffect(() => {\n    if (!locked) return\n    signupRef.current = false\n    setInstallCardOpen(false)\n  }, [locked])'))
  t.ok(s.indexOf('signupRef.current = false\n    setInstallCardOpen(false)') > s.indexOf('const [installCardOpen, setInstallCardOpen] = useState(false)'))
})
