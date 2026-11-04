'use strict'

// The invite message helpers (src/inviteMessage.js), loaded through import().
const test = require('brittle')

const load = () => import('../src/inviteMessage.js')
const A = 'ab'.repeat(32)
const B = 'cd'.repeat(32)
const O = 'https://bora.varanda.app'
const C_LINK = O + '/c/' + A
const G_LINK = O + '/g/' + B
const len = (s) => Array.from(s).length

test('inviteText builds the community and group wording', async (t) => {
  const { inviteText } = await load()
  t.is(inviteText({ communityName: 'Horta', link: C_LINK }),
    'Convite para a comunidade Horta na Varanda: ' + C_LINK)
  t.is(inviteText({ communityName: '  Horta  ', groupName: ' Sementes ', link: G_LINK }),
    'Convite para o grupo Sementes da comunidade Horta na Varanda: ' + G_LINK)
})

test('inviteText falls back to the unnamed wording', async (t) => {
  const { inviteText } = await load()
  t.is(inviteText({ communityName: '', link: C_LINK }), 'Convite para uma comunidade na Varanda: ' + C_LINK)
  t.is(inviteText({ communityName: 42, link: C_LINK }), 'Convite para uma comunidade na Varanda: ' + C_LINK)
  t.is(inviteText({ communityName: '   ', link: C_LINK }), 'Convite para uma comunidade na Varanda: ' + C_LINK)
  t.is(inviteText({ groupName: 'Sementes', link: G_LINK }),
    'Convite para o grupo Sementes de uma comunidade na Varanda: ' + G_LINK)
  t.is(inviteText({ communityName: 'Horta', groupName: '', link: C_LINK }),
    'Convite para a comunidade Horta na Varanda: ' + C_LINK)
  t.is(inviteText({ communityName: 'Horta', groupName: null, link: C_LINK }),
    'Convite para a comunidade Horta na Varanda: ' + C_LINK)
})

test('inviteText cuts long names to fit 1000 code points and keeps the link', async (t) => {
  const { inviteText } = await load()
  const long = '😀'.repeat(2000)

  const one = inviteText({ communityName: long, link: C_LINK })
  t.is(len(one), 1000)
  t.ok(one.endsWith(' na Varanda: ' + C_LINK))
  t.ok(one.includes('…'))
  t.ok(one.startsWith('Convite para a comunidade 😀'))

  const two = inviteText({ communityName: long, groupName: long, link: G_LINK })
  t.is(len(two), 1000)
  t.ok(two.endsWith(' na Varanda: ' + G_LINK))
  t.is(two.split('…').length, 3, 'both names cut')

  const shortC = inviteText({ communityName: 'Horta', groupName: 'x'.repeat(3000), link: G_LINK })
  t.is(len(shortC), 1000)
  t.ok(shortC.includes(' da comunidade Horta na Varanda: '), 'short name kept whole')

  const shortG = inviteText({ communityName: 'y'.repeat(3000), groupName: 'Sementes', link: G_LINK })
  t.is(len(shortG), 1000)
  t.ok(shortG.startsWith('Convite para o grupo Sementes da comunidade y'))

  const exact = 'Convite para a comunidade  na Varanda: ' + C_LINK
  const fits = 'z'.repeat(1000 - len(exact))
  t.is(inviteText({ communityName: fits, link: C_LINK }), 'Convite para a comunidade ' + fits + ' na Varanda: ' + C_LINK)
  t.is(len(inviteText({ communityName: fits + 'z', link: C_LINK })), 1000)
})

test('inviteText refuses a bad link', async (t) => {
  const { inviteText } = await load()
  t.exception.all(() => inviteText({ communityName: 'Horta', link: 'http://bora.varanda.app/c/' + A }), TypeError)
  t.exception.all(() => inviteText({ communityName: 'Horta', link: '/c/' + A }), TypeError)
  t.exception.all(() => inviteText({ communityName: 'Horta', link: null }), TypeError)
  t.exception.all(() => inviteText({ communityName: 'Horta' }), TypeError)
  t.exception.all(() => inviteText(), TypeError)
  t.exception.all(() => inviteText({ link: 'https://' + 'a'.repeat(1000) }), TypeError)
})

test('inviteLinkOf finds a community or group link', async (t) => {
  const { inviteLinkOf } = await load()
  t.alike(inviteLinkOf(C_LINK, O), { kind: 'comunidade', key: A })
  t.alike(inviteLinkOf(C_LINK + '/', O), { kind: 'comunidade', key: A })
  t.alike(inviteLinkOf(G_LINK, O), { kind: 'grupo', key: B })
  t.alike(inviteLinkOf('Entra aqui ' + C_LINK + ' quando puder', O), { kind: 'comunidade', key: A })
  t.alike(inviteLinkOf('Vem! ' + C_LINK + '.', O), { kind: 'comunidade', key: A })
  t.alike(inviteLinkOf(C_LINK + '!?', O), { kind: 'comunidade', key: A })
  t.alike(inviteLinkOf('linha\n' + C_LINK + '\noutra', O), { kind: 'comunidade', key: A })
})

test('inviteLinkOf round-trips the text inviteText builds', async (t) => {
  const { inviteText, inviteLinkOf } = await load()
  t.alike(inviteLinkOf(inviteText({ communityName: 'Horta', link: C_LINK }), O), { kind: 'comunidade', key: A })
  t.alike(inviteLinkOf(inviteText({ communityName: 'Horta', groupName: 'Sementes', link: G_LINK }), O), { kind: 'grupo', key: B })
  t.alike(inviteLinkOf(inviteText({ link: C_LINK }), O), { kind: 'comunidade', key: A })
  t.alike(inviteLinkOf(inviteText({ communityName: 'x'.repeat(5000), groupName: 'y'.repeat(5000), link: G_LINK }), O), { kind: 'grupo', key: B })
})

test('inviteLinkOf refuses other origins and malformed links', async (t) => {
  const { inviteLinkOf } = await load()
  t.is(inviteLinkOf('https://outra.varanda.app/c/' + A, O), null)
  t.is(inviteLinkOf('https://bora.varanda.app.evil/c/' + A, O), null)
  t.is(inviteLinkOf('https://bora.varanda.app@evil.example/c/' + A, O), null)
  t.is(inviteLinkOf('https://bora.varanda.app:8443/c/' + A, O), null)
  t.is(inviteLinkOf('http://bora.varanda.app/c/' + A, O), null)
  t.is(inviteLinkOf(O + '/c/' + A.toUpperCase(), O), null)
  t.is(inviteLinkOf(O + '/c/' + A.slice(1), O), null)
  t.is(inviteLinkOf(C_LINK + 'x', O), null)
  t.is(inviteLinkOf(C_LINK + 'a', O), null)
  t.is(inviteLinkOf(C_LINK + '/x', O), null)
  t.is(inviteLinkOf(C_LINK + '?x=1', O), null)
  t.is(inviteLinkOf(C_LINK + '#x', O), null)
  t.is(inviteLinkOf(O + '/c/../g/' + B, O), null)
  t.is(inviteLinkOf(O + '/c//' + A, O), null)
  t.is(inviteLinkOf(O + '/m/' + A, O), null)
  t.is(inviteLinkOf(O + '/C/' + A, O), null)
  t.is(inviteLinkOf('x' + C_LINK, O), null)
  t.is(inviteLinkOf('https://evil.example/a:' + C_LINK, O), null)
  t.is(inviteLinkOf('https://evil.example/a(' + C_LINK + ')', O), null)
  t.is(inviteLinkOf('(' + C_LINK + ')', O), null)
  t.is(inviteLinkOf('"' + C_LINK + '"', O), null)
  t.is(inviteLinkOf('link:' + C_LINK, O), null)
  t.is(inviteLinkOf('veja/' + C_LINK, O), null)
  t.is(inviteLinkOf('', O), null)
  t.is(inviteLinkOf('sem link nenhum', O), null)
})

test('inviteLinkOf refuses huge text, non-strings and bad origins', async (t) => {
  const { inviteLinkOf } = await load()
  t.is(inviteLinkOf(C_LINK + ' ' + 'a'.repeat(4000), O), null)
  t.alike(inviteLinkOf(C_LINK + ' ' + 'a'.repeat(4000 - C_LINK.length - 1), O), { kind: 'comunidade', key: A })
  t.is(inviteLinkOf(null, O), null)
  t.is(inviteLinkOf(undefined, O), null)
  t.is(inviteLinkOf(42, O), null)
  t.is(inviteLinkOf({ toString: () => C_LINK }, O), null)
  t.is(inviteLinkOf([C_LINK], O), null)
  t.is(inviteLinkOf(C_LINK, null), null)
  t.is(inviteLinkOf(C_LINK, ''), null)
  t.is(inviteLinkOf(C_LINK, O + '/'), null)
  t.is(inviteLinkOf(O + '/x/c/' + A, O + '/x'), null)
  t.is(inviteLinkOf('http://bora.varanda.app/c/' + A, 'http://bora.varanda.app'), null)
  t.is(inviteLinkOf(C_LINK, 'https://'), null)
})

test('inviteLinkOf takes the last valid occurrence', async (t) => {
  const { inviteLinkOf } = await load()
  t.alike(inviteLinkOf(C_LINK + ' ' + G_LINK, O), { kind: 'grupo', key: B })
  t.alike(inviteLinkOf(G_LINK + ' ' + C_LINK, O), { kind: 'comunidade', key: A })
  t.alike(inviteLinkOf('x' + C_LINK + ' ' + G_LINK, O), { kind: 'grupo', key: B })
  t.alike(inviteLinkOf(O + '/c/' + A.toUpperCase() + ' ' + G_LINK, O), { kind: 'grupo', key: B })
  t.alike(inviteLinkOf('https://bora.varanda.app.evil/c/' + B + ' ' + C_LINK, O), { kind: 'comunidade', key: A })
  t.alike(inviteLinkOf(G_LINK + ' ' + O + '/c/' + A.toUpperCase(), O), { kind: 'grupo', key: B }, 'a later invalid link is skipped')
})

test('a title that is an invite URL does not hijack the invite', async (t) => {
  const { inviteText, inviteLinkOf } = await load()
  const text = inviteText({ communityName: C_LINK, groupName: C_LINK, link: G_LINK, group: true })
  t.alike(inviteLinkOf(text, O), { kind: 'grupo', key: B })
  t.alike(inviteLinkOf(inviteText({ communityName: G_LINK, link: C_LINK }), O), { kind: 'comunidade', key: A })
})

test('inviteText keeps the group wording for a group with no readable title', async (t) => {
  const { inviteText } = await load()
  t.is(inviteText({ communityName: 'Horta', groupName: null, link: G_LINK, group: true }),
    'Convite para um grupo da comunidade Horta na Varanda: ' + G_LINK)
  t.is(inviteText({ communityName: 'Horta', groupName: '   ', link: G_LINK, group: true }),
    'Convite para um grupo da comunidade Horta na Varanda: ' + G_LINK)
  t.is(inviteText({ groupName: '', link: G_LINK, group: true }),
    'Convite para um grupo de uma comunidade na Varanda: ' + G_LINK)
  t.is(inviteText({ communityName: 'Horta', groupName: 'Sementes', link: G_LINK, group: true }),
    'Convite para o grupo Sementes da comunidade Horta na Varanda: ' + G_LINK)
  const longLink = 'https://' + 'a'.repeat(940)
  t.is(inviteText({ groupName: 'Sementes', link: longLink }),
    'Convite para um grupo de uma comunidade na Varanda: ' + longLink, 'fallback keeps the group form')
  t.is(inviteText({ communityName: 'Horta', link: C_LINK, group: false }),
    'Convite para a comunidade Horta na Varanda: ' + C_LINK)
})

test('the exported strings', async (t) => {
  const m = await load()
  t.is(m.INVITE_SENT, 'Convite enviado pelas Conversas.')
  t.is(m.INVITE_UNSURE, 'Não deu para confirmar se o convite foi enviado. Tente de novo: a mensagem não se repete.')
  t.is(m.INVITE_NO_DM, 'Essa pessoa ainda não usa as Conversas. Mande o link pelo Compartilhar.')
  t.is(m.INVITE_NOTE, 'O convite chega como mensagem privada. A pessoa só entra se tocar em Entrar.')
  t.is(m.OPEN_INVITE, 'Abrir convite')
})
