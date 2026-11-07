'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const { DESIGNS, REGIONS, messageRoom, buildInviteCardUrl, INVITE_CARD_MAX_URL } = require('@varanda/rpc')

const load = () => import('../src/inviteCardCopy.js')

test('invite card copy: every design and region has exactly one label and suggestion', async (t) => {
  const copy = await load()
  t.is(copy.DESIGNS, DESIGNS)
  t.is(copy.REGIONS, REGIONS)
  t.alike(Object.keys(copy.REGION_LABELS).sort(), REGIONS.map((region) => region.id).sort())
  t.alike(Object.keys(copy.DESIGN_LABELS).sort(), [...DESIGNS].sort())
  t.alike(Object.keys(copy.SUGGESTIONS).sort(), [...DESIGNS].sort())
  for (const map of [copy.REGION_LABELS, copy.DESIGN_LABELS, copy.SUGGESTIONS]) {
    t.ok(Object.isFrozen(map))
    for (const text of Object.values(map)) {
      t.is(typeof text, 'string')
      t.ok(text.length > 0)
      t.absent(text.includes('\n'))
    }
  }
})

test('invite card copy: suggestions fit the URL with a full ASCII name and design query', async (t) => {
  const { SUGGESTIONS } = await load()
  for (const design of DESIGNS) {
    const card = {
      origin: 'https://bora.varanda.app',
      code: 'c'.repeat(43),
      name: 'n'.repeat(40),
      expires: Date.UTC(2026, 10, 14, 12) / 1000,
      design,
      message: SUGGESTIONS[design],
      member: 'ab'.repeat(32),
      signature: 'cd'.repeat(64)
    }
    const room = messageRoom(card)
    t.is(room, DESIGNS.indexOf(design) < 10 ? 94 : 93, design + ' query included')
    t.ok(Buffer.byteLength(card.message, 'utf8') <= room, design + ' fits in UTF-8')
    const url = buildInviteCardUrl(card)
    t.ok(url !== null && url.length <= INVITE_CARD_MAX_URL, design + ' builds within URL limit')
    t.ok(url && url.includes('?c=' + DESIGNS.indexOf(design) + '#c1.'), design + ' query present')
  }
})

test('invite card copy: arrival text identifies the greeting author', async (t) => {
  const copy = await load()
  t.is(copy.ARRIVAL_DM, 'Oi! Cheguei.')
  t.is(copy.ARRIVAL_TITLE, 'Você chegou com o cartão de @')
  t.is(copy.FOLLOW_LABEL, 'Seguir @')
  t.is(copy.HI_LABEL, 'Mandar um oi')
  t.is(copy.LATER_LABEL, 'Agora não')
  t.is(copy.NO_DM_TEXT, 'Essa pessoa ainda não usa as Conversas.')
  t.is(copy.HOW_LABEL, 'Como funciona')
  t.is(copy.ENTER_LABEL, 'Entrar')
})

test('invite card copy: expiry uses the calendar day in fixed UTC-3', async (t) => {
  const { expiryLine } = await load()
  const before = Date.UTC(2026, 10, 12, 12)
  const expires = Date.UTC(2026, 10, 14, 2) / 1000
  t.is(expiryLine(expires, before), 'Vale até 13 de novembro.')
  t.is(expiryLine(Date.UTC(2026, 10, 14, 3) / 1000, before), 'Vale até 14 de novembro.')
  t.is(expiryLine(expires, Date.UTC(2026, 10, 13, 2, 59, 59)), 'Vale até 13 de novembro.')
  t.is(expiryLine(expires, Date.UTC(2026, 10, 13, 3)), 'Vale até hoje.')
  t.is(expiryLine(expires, Date.UTC(2026, 10, 14, 1)), 'Vale até hoje.', 'different UTC dates, same local day')
  t.is(expiryLine(Date.UTC(2026, 10, 14, 3) / 1000, Date.UTC(2026, 10, 14, 2)), 'Vale até 14 de novembro.', 'same UTC date, different local days')
  t.is(expiryLine(expires, expires * 1000 - 1), 'Vale até hoje.')
  t.is(expiryLine(expires, expires * 1000), 'Este prazo já passou.')
  t.is(expiryLine(expires, expires * 1000 + 1), 'Este prazo já passou.', 'past wins over today')
  t.is(expiryLine(expires, Date.UTC(2027, 10, 13, 12)), 'Este prazo já passou.')
  t.is(expiryLine(Date.UTC(2027, 10, 13, 12) / 1000, before), 'Vale até 13 de novembro.')
  t.is(expiryLine(Date.UTC(2027, 0, 1, 2) / 1000, before), 'Vale até 31 de dezembro.')
  t.is(expiryLine(Date.UTC(2027, 0, 1, 3) / 1000, before), 'Vale até 1º de janeiro.')
})

test('invite card copy: expiry spells every month without a clock', async (t) => {
  const { expiryLine } = await load()
  const months = [
    'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
    'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'
  ]
  for (const [month, name] of months.entries()) {
    t.is(expiryLine(Date.UTC(2027, month, 14, 12) / 1000, Date.UTC(2026, 0, 1)), 'Vale até 14 de ' + name + '.')
  }
})

test('invite card copy: invalid expiry or clock gives no line', async (t) => {
  const { expiryLine } = await load()
  const now = Date.UTC(2026, 10, 12, 12)
  for (const expires of [undefined, null, '', '1794650400', NaN, Infinity, -Infinity, 0, -1, 1.5, Number.MAX_SAFE_INTEGER, {}, []]) {
    t.is(expiryLine(expires, now), '', String(expires))
  }
  for (const invalidNow of [undefined, null, '', String(now), NaN, Infinity, -Infinity, Number.MAX_VALUE, {}, []]) {
    t.is(expiryLine(now / 1000, invalidNow), '', String(invalidNow))
  }
  t.is(expiryLine(), '')
})

test('invite card copy: opening requires an eligible intro and waits at most six seconds', async (t) => {
  const { openingGate, OPEN_WAIT_MS } = await load()
  t.is(OPEN_WAIT_MS, 6000)
  const base = { introShow: true, linkReturn: false, ageReturn: false, card: {}, verified: true, waitedMs: 0, dismissed: false }
  const outcomes = [
    [{ verified: true, waitedMs: 0 }, 'card'],
    [{ verified: true, waitedMs: 6000 }, 'card'],
    [{ verified: true, waitedMs: 6001 }, 'card'],
    [{ verified: null, waitedMs: 0 }, 'wait'],
    [{ verified: null, waitedMs: 5999 }, 'wait'],
    [{ verified: null, waitedMs: 6000 }, 'none'],
    [{ verified: null, waitedMs: 6001 }, 'none'],
    [{ verified: null, waitedMs: undefined }, 'none'],
    [{ verified: null, waitedMs: NaN }, 'none'],
    [{ verified: false }, 'none'],
    [{ verified: undefined }, 'none'],
    [{ verified: 1 }, 'none']
  ]
  const blockers = [
    { introShow: false }, { introShow: undefined },
    { linkReturn: true }, { ageReturn: true },
    { card: null }, { card: undefined }, { dismissed: true }
  ]
  for (const [state, expected] of outcomes) {
    t.is(openingGate({ ...base, ...state }), expected)
    for (const blocker of blockers) {
      t.is(openingGate({ ...base, ...state, ...blocker }), 'none')
    }
  }
  t.is(openingGate(), 'none')
})

test('invite card copy: arrival requires ready, verified, linked and another member', async (t) => {
  const { arrivalGate } = await load()
  const base = { step: 'pronto', verified: true, linked: true, dismissed: false, ownKey: 'ab'.repeat(32), member: 'cd'.repeat(32) }
  t.is(arrivalGate(base), true)
  const blockers = [
    ...['entrar', 'idade', 'vinculo', 'identidade', 'certificado', 'carregando', 'recuperando', undefined].map((step) => ({ step })),
    ...[false, null, undefined, 1].map((verified) => ({ verified })),
    ...[false, null, undefined, 1].map((linked) => ({ linked })),
    { dismissed: true },
    { ownKey: base.member }
  ]
  for (const blocker of blockers) t.is(arrivalGate({ ...base, ...blocker }), false)
  t.is(arrivalGate(), false)
})

test('invite card copy: strings avoid caricature and the module stays platform independent', async (t) => {
  const copy = await load()
  function checkStrings (value) {
    if (typeof value === 'string') {
      t.absent(value.includes('\u2014'))
      const tokens = value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z]+/)
      t.absent(tokens.some((token) => ['oxe', 'uai', 'tche', 'bah'].includes(token)))
    } else if (value && typeof value === 'object') {
      for (const child of Object.values(value)) checkStrings(child)
    }
  }
  checkStrings(copy)
  const source = fs.readFileSync(path.join(__dirname, '../src/inviteCardCopy.js'), 'utf8')
  t.absent(source.includes('\u2014'))
  t.absent(/\bIntl\s*\.|toLocale\w*\s*\(|timeZone\s*:/.test(source))
  t.absent(/\b(?:window|document|localStorage|sessionStorage|process|globalThis)\b|Date\.now\s*\(|new Date\(\)/.test(source))
  t.alike([...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]), ['@varanda/rpc'])
})
