'use strict'

const test = require('brittle')
const rpc = require('..')
const ic = require('../lib/invite-card')

const {
  DESIGNS,
  REGIONS,
  designIndex,
  designAt,
  isInviteCode,
  isInviteCardExpires,
  canonicalInviteCardText,
  buildInviteCardUrl,
  parseInviteCardUrl,
  messageRoom
} = ic

const ORIGIN = 'https://bora.varanda.app'
const CODE = 'A'.repeat(42) + 'w'
const MEMBER = 'ab'.repeat(32)
const SIGNATURE = 'cd'.repeat(64)
const EXPIRES = 1800000000

function card (over) {
  return {
    origin: ORIGIN,
    code: CODE,
    design: 'cordel',
    name: 'Joana',
    message: 'Oi!',
    expires: EXPIRES,
    member: MEMBER,
    signature: SIGNATURE,
    ...over
  }
}

function fields (c) {
  return { code: c.code, design: c.design, name: c.name, message: c.message, expires: c.expires, member: c.member, signature: c.signature }
}

test('invite card: exported from the package index', (t) => {
  for (const k of Object.keys(ic)) t.is(rpc[k], ic[k], k)
  t.is(rpc.INVITE_CARD_MAX_URL, 400)
  t.is(rpc.FRAGMENT_MARK, '#c1.')
  t.is(rpc.NAME_MAX, 40)
  t.is(rpc.MESSAGE_MAX_BYTES, 200)
})

test('invite card: design order is pinned and append-only', (t) => {
  t.alike(DESIGNS, [
    'marajoara', 'aguas', 'vitoria', 'cordel', 'bandeirinhas', 'chita', 'ipe',
    'pantanal', 'azulejo', 'copacabana', 'minas', 'araucaria', 'chimarrao'
  ])
  t.ok(Object.isFrozen(DESIGNS))
  t.ok(Object.isFrozen(REGIONS))
  t.alike(REGIONS.map((r) => r.id), ['norte', 'nordeste', 'centro-oeste', 'sudeste', 'sul'])
  t.alike(REGIONS[2].designs, ['ipe', 'pantanal'])
  t.is(designIndex('marajoara'), 0)
  t.is(designIndex('chimarrao'), 12)
  t.is(designIndex('nada'), -1)
  t.is(designIndex(3), -1)
  t.is(designAt(3), 'cordel')
  t.is(designAt(13), null)
  t.is(designAt(-1), null)
  t.is(designAt('0'), null)
})

test('invite card: regions cover every design exactly once', (t) => {
  const all = REGIONS.flatMap((r) => r.designs)
  t.is(all.length, DESIGNS.length)
  t.alike([...all].sort(), [...DESIGNS].sort())
  t.is(new Set(all).size, all.length)
})

test('invite card: code and expires', (t) => {
  t.ok(isInviteCode(CODE))
  t.absent(isInviteCode(CODE + 'A'))
  t.absent(isInviteCode(CODE.slice(1) + '='))
  t.absent(isInviteCode(null))
  t.ok(isInviteCardExpires(1))
  t.ok(isInviteCardExpires(2 ** 32 - 1))
  t.absent(isInviteCardExpires(2 ** 32))
  t.absent(isInviteCardExpires(0))
  t.absent(isInviteCardExpires(1.5))
  t.absent(isInviteCardExpires('1'))
})

test('invite card: canonical text', (t) => {
  t.is(canonicalInviteCardText('  Joana  ', 40), 'Joana')
  t.is(canonicalInviteCardText('Joáo', 40), 'Joáo', 'NFC')
  t.is(canonicalInviteCardText('a'.repeat(40), 40), 'a'.repeat(40))
  t.is(canonicalInviteCardText('a'.repeat(41), 40), null, '41 code points')
  t.is(canonicalInviteCardText('\u{1F600}'.repeat(40), 40), '\u{1F600}'.repeat(40), 'counts code points')
  t.is(canonicalInviteCardText('Jo\ud800ana', 40), null, 'lone surrogate')
  t.is(canonicalInviteCardText('Jo‏ana', 40), null, 'bidi mark')
  t.is(canonicalInviteCardText('Jo‮ana', 40), null, 'bidi override')
  t.is(canonicalInviteCardText('a\nb', 40), null, 'LF in a name')
  t.is(canonicalInviteCardText('a\nb', 40, { multiline: true }), 'a\nb')
  t.is(canonicalInviteCardText('a\r\nb', 40, { multiline: true }), null, 'CR')
  t.is(canonicalInviteCardText('   ', 40), null, 'empty after trim')
  t.is(canonicalInviteCardText(5, 40), null)
})

test('invite card: round trip with accents and LF in the message', (t) => {
  const c = card({ design: 'chimarrao', name: 'José Araújo', message: 'Vem pra cá, viu?\nTem café \u{1F600}' })
  const url = buildInviteCardUrl(c)
  t.ok(url.startsWith(ORIGIN + '/convite/' + CODE + '?c=12#c1.'))
  t.alike(parseInviteCardUrl(url), fields(c))
  const plain = url.replace('?c=12', '')
  t.alike(parseInviteCardUrl(plain), fields(c), 'query is optional')
  t.alike(parseInviteCardUrl(url.replace(CODE + '?', CODE + '/?')), fields(c), 'trailing slash')
  t.alike(parseInviteCardUrl(url.replace(ORIGIN, 'varanda://')), fields(c), 'app link form')
  t.alike(parseInviteCardUrl(plain.replace(ORIGIN, 'varanda://')), fields(c))
  const local = buildInviteCardUrl(card({ origin: 'http://127.0.0.1:8080' }))
  t.alike(parseInviteCardUrl(local), fields(card()))
})

test('invite card: build refuses bad input', (t) => {
  t.ok(buildInviteCardUrl(card()))
  t.is(buildInviteCardUrl(card({ origin: 'http://bora.varanda.app' })), null)
  t.is(buildInviteCardUrl(card({ origin: ORIGIN + '/' })), null)
  t.is(buildInviteCardUrl(card({ origin: 'https://Bora.varanda.app' })), null)
  t.is(buildInviteCardUrl(card({ code: 'abc' })), null)
  t.is(buildInviteCardUrl(card({ design: 'nada' })), null)
  t.is(buildInviteCardUrl(card({ expires: 0 })), null)
  t.is(buildInviteCardUrl(card({ member: MEMBER.toUpperCase() })), null)
  t.is(buildInviteCardUrl(card({ signature: MEMBER })), null)
  t.is(buildInviteCardUrl(card({ name: ' Joana' })), null, 'non-canonical name')
  t.is(buildInviteCardUrl(card({ name: 'a'.repeat(41) })), null)
  t.is(buildInviteCardUrl(card({ name: 'Jo\ud800' })), null)
  t.is(buildInviteCardUrl(card({ name: 'Jo‎ana' })), null)
  t.is(buildInviteCardUrl(card({ message: '' })), null)
  t.is(buildInviteCardUrl(card({ message: 'x'.repeat(200) })), null, 'URL above 400')
  t.is(buildInviteCardUrl(), null)
})

test('invite card: message room at bora.varanda.app', (t) => {
  // Fixed part: 'https://bora.varanda.app' (24) + '/convite/' (9) + code (43)
  // + '?c=0' (4) + '#c1.' (4) = 84 chars, so 400 - 84 = 316 base64url chars
  // carry floor(316 * 3 / 4) = 237 bytes. Minus 103 fixed body bytes and a
  // 40-byte name: 237 - 103 - 40 = 94 bytes left for the message.
  const base = { origin: ORIGIN, code: CODE, design: 'marajoara', name: 'n'.repeat(40), expires: EXPIRES }
  t.is(messageRoom(base), 94)
  t.is(messageRoom({ ...base, design: 'chimarrao' }), 93, "'?c=12' takes one more char")
  t.is(messageRoom({ ...base, name: 'bad‏' }), 0)
  t.is(messageRoom({ ...base, code: 'x' }), 0)
  t.is(messageRoom(), 0)

  const full = buildInviteCardUrl(card({ ...base, message: 'm'.repeat(94) }))
  t.is(full.length, 400)
  t.is(buildInviteCardUrl(card({ ...base, message: 'm'.repeat(95) })), null)
})

test('invite card: 400 chars parse, 401 do not', (t) => {
  const base = { design: 'marajoara', name: 'n'.repeat(40), message: 'm'.repeat(94) }
  const url = buildInviteCardUrl(card(base))
  t.is(url.length, 400)
  t.alike(parseInviteCardUrl(url), fields(card(base)))
  const longer = url.replace('https://bora', 'https://xbora')
  t.is(longer.length, 401)
  t.is(parseInviteCardUrl(longer), null)
  const shorter = buildInviteCardUrl(card({ ...base, message: 'm'.repeat(93) })).replace('https://bora', 'https://xbora')
  t.is(shorter.length, 400)
  t.ok(parseInviteCardUrl(shorter), 'the same origin parses within 400')
})

test('invite card: altered or padded body rejected', (t) => {
  const url = buildInviteCardUrl(card({ message: 'Oi!!' }))
  const body = url.slice(url.indexOf('#c1.') + 4)
  const head = url.slice(0, url.indexOf('#c1.') + 4)
  t.ok(parseInviteCardUrl(url))
  t.is(parseInviteCardUrl(url + '='), null, 'padding')
  t.is(parseInviteCardUrl(url + '=='), null, 'padding')
  t.is(parseInviteCardUrl(url + 'A'), null, 'leftover')
  t.is(parseInviteCardUrl(head + body.slice(0, -4)), null, 'missing bytes')
  t.is(parseInviteCardUrl(head + body.slice(0, -1)), null, 'truncated')
  // body is 103 + 5 + 4 = 112 bytes: 150 chars, the last one carries 4 zero bits.
  t.is(body.length, 150)
  const last = body[body.length - 1]
  const bumped = last === 'A' ? 'B' : String.fromCharCode(last.charCodeAt(0) + 1)
  t.is(parseInviteCardUrl(head + body.slice(0, -1) + bumped), null, 'non-canonical last char')
  t.is(parseInviteCardUrl(head + body.replace(/^./, '+')), null, 'not base64url')
  t.is(parseInviteCardUrl(url.replace('#c1.', '#c2.')), null)
  t.is(parseInviteCardUrl(url.replace('?c=3', '?c=4')), null, 'query differs from the body')
  t.is(parseInviteCardUrl(url.replace('?c=3', '?c=03')), null, 'leading zero')
  t.is(parseInviteCardUrl(url.replace('?c=3', '?c=3&x=1')), null, 'other params')
  t.is(parseInviteCardUrl(url.replace('?c=3', '?d=3')), null)
  t.is(parseInviteCardUrl(url.replace('?c=3', '?')), null)
  t.is(parseInviteCardUrl(url.replace('/convite/', '/convites/')), null)
  t.is(parseInviteCardUrl(url.replace('https://', 'http://')), null)
  t.is(parseInviteCardUrl(url.replace('https://', 'varanda://')), null)
  t.is(parseInviteCardUrl(url.replace('#', ' #')), null, 'whitespace')
  t.is(parseInviteCardUrl(url.replace('#', '\\#')), null, 'backslash')
  t.is(parseInviteCardUrl(null), null)
})

// Hand-built bodies, to reach the decoder checks build never produces.
function rawUrl (bytes) {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  const body = Buffer.from(bin, 'latin1').toString('base64url')
  return ORIGIN + '/convite/' + CODE + '#c1.' + body
}

function rawBody ({ design = 0, expires = EXPIRES, name = [0x4a], message = [0x6f] } = {}) {
  return [
    design, (expires >>> 24) & 255, (expires >>> 16) & 255, (expires >>> 8) & 255, expires & 255,
    name.length, ...name, message.length, ...message,
    ...new Array(32).fill(1), ...new Array(64).fill(2)
  ]
}

test('invite card: decoded fields must be valid and canonical', (t) => {
  t.alike(parseInviteCardUrl(rawUrl(rawBody())), {
    code: CODE, design: 'marajoara', name: 'J', message: 'o', expires: EXPIRES, member: '01'.repeat(32), signature: '02'.repeat(64)
  })
  t.is(parseInviteCardUrl(rawUrl(rawBody({ design: 13 }))), null, 'design out of range')
  t.is(parseInviteCardUrl(rawUrl(rawBody({ expires: 0 }))), null, 'zero expires')
  t.is(parseInviteCardUrl(rawUrl(rawBody({ name: [] }))), null, 'empty name')
  t.is(parseInviteCardUrl(rawUrl(rawBody({ message: [] }))), null, 'empty message')
  t.is(parseInviteCardUrl(rawUrl(rawBody({ name: [0x20, 0x4a] }))), null, 'untrimmed name')
  t.is(parseInviteCardUrl(rawUrl(rawBody({ name: [0x61, 0xcc, 0x81] }))), null, 'not NFC')
  t.is(parseInviteCardUrl(rawUrl(rawBody({ name: [0xed, 0xa0, 0x80] }))), null, 'encoded surrogate')
  t.is(parseInviteCardUrl(rawUrl(rawBody({ name: [0xc3] }))), null, 'bad UTF-8')
  t.is(parseInviteCardUrl(rawUrl(rawBody({ name: [0xe2, 0x80, 0x8f] }))), null, 'bidi mark')
  t.is(parseInviteCardUrl(rawUrl(rawBody({ name: [0x61, 0x0a, 0x62] }))), null, 'LF in name')
  t.ok(parseInviteCardUrl(rawUrl(rawBody({ message: [0x61, 0x0a, 0x62] }))), 'LF in message')
  t.is(parseInviteCardUrl(rawUrl(rawBody({ name: new Array(41).fill(0x61) }))), null, '41 code points')
  t.is(parseInviteCardUrl(rawUrl([...rawBody(), 0])), null, 'leftover byte')
  t.is(parseInviteCardUrl(rawUrl(rawBody().slice(0, -1))), null, 'missing byte')
  const lying = rawBody()
  lying[5] = 200
  t.is(parseInviteCardUrl(rawUrl(lying)), null, 'name length past the end')
})
