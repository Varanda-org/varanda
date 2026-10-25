// Screen identity rules: unnamed people never inherit key characters.
'use strict'

const test = require('brittle')
const load = () => import('../src/who.js')

test('whoOf chooses a trimmed name, a valid username, or sem nome', async (t) => {
  const { UNNAMED, whoOf } = await load()
  t.is(UNNAMED, 'sem nome')
  const cases = [
    [undefined, 'sem nome', null, null, false],
    [null, 'sem nome', null, null, true],
    [{}, 'sem nome', null, null, true],
    [{ name: '  Ana Maria  ', username: 'ana' }, 'Ana Maria', '@ana', 'Ana Maria', true],
    [{ name: 'Ana', username: null }, 'Ana', null, 'Ana', true],
    [{ name: 'Ana', username: '' }, 'Ana', null, 'Ana', true],
    [{ name: '', username: 'ana' }, 'ana', '@ana', 'ana', true],
    [{ name: ' \t\n ', username: 'ana' }, 'ana', '@ana', 'ana', true],
    [{ name: null, username: 'ana' }, 'ana', '@ana', 'ana', true],
    [{ name: 123, username: 'ana' }, 'ana', '@ana', 'ana', true],
    [{ name: ' \t ', username: null }, 'sem nome', null, null, true],
    [{ name: '', username: '', key: 'abcdef'.repeat(11) }, 'sem nome', null, null, true]
  ]
  for (const username of ['Ana', 'abc123', '@ana']) {
    cases.push([{ name: 'Ana', username }, 'Ana', null, 'Ana', true])
    cases.push([{ name: '', username }, 'sem nome', null, null, true])
  }
  for (const [profile, title, subtitle, avatarName, known] of cases) {
    if (profile) Object.freeze(profile)
    t.alike(whoOf(profile), { title, subtitle, avatarName, known })
  }
})

test('a display name can never pass for a verified @nome', async (t) => {
  const { whoOf } = await load()
  const verified = whoOf(Object.freeze({ name: null, username: 'alice' }))
  t.alike(verified, { title: 'alice', subtitle: '@alice', avatarName: 'alice', known: true })
  // Free-form names written as handles, look-alike at-signs included: the
  // title drops them, and no subtitle exists without a verified username.
  const hidden = ['​', '‌', '‍', '‎', '‏', '⁠', '﻿', '­', '͏', '؜', '᠎', '‪', '⁦', 'ㅤ', '️',
    '￰', '\u{1bca0}', '\u{1d173}', '\u{e0001}', '\u{e0041}', '\u{e0100}', '\u{e01ef}']
  const spoofs = ['@alice', '  @alice', '@@alice', '＠alice', '﹫alice', '@ alice']
  for (const h of hidden) spoofs.push(h + '@alice', '@' + h + 'alice', h + h + '＠alice', ' ' + h + ' @alice')
  for (const name of spoofs) {
    const impostor = whoOf(Object.freeze({ name, username: null }))
    t.is(impostor.title, 'alice', JSON.stringify(name))
    t.is(impostor.subtitle, null)
    t.not(impostor.subtitle, verified.subtitle)
  }
  // An at-sign alone, or a name of invisible characters only, is no name.
  for (const name of ['@', '\u{e0100}', '​‍', '\u{e0100}@', ' ㅤ ', '﻿\u{1d173}']) {
    t.is(whoOf(Object.freeze({ name, username: null })).title, 'sem nome', JSON.stringify(name))
    t.is(whoOf(Object.freeze({ name, username: 'ana' })).title, 'ana', JSON.stringify(name))
  }
  // Invisibles inside a visible name are left alone (only a leading run goes).
  t.is(whoOf(Object.freeze({ name: 'Ana​Maria', username: null })).title, 'Ana​Maria')
})

test('username validation and atName reject malformed and six-hex handles', async (t) => {
  const { isValidUsername, atName } = await load()
  for (const username of ['ana', 'ana_123', 'a'.repeat(20), 'abcdefg', 'abc12_']) {
    t.is(isValidUsername(username), true)
    t.is(atName(username), '@' + username)
  }
  for (const username of [undefined, null, '', 'an', 'a'.repeat(21), 'Ana', 'abc123', 'abcdef', '123456', '@ana', 'ana ', ' ana', 'ana-maria', 'ana maria', '1ana', 'josé', 123, {}, ['ana']]) {
    t.is(isValidUsername(username), false)
    t.is(atName(username), null)
  }
})

test('replyNameOf shows a pending mark until the profile is looked up', async (t) => {
  const { replyNameOf, PENDING_NAME, UNNAMED } = await load()
  t.is(replyNameOf(undefined), PENDING_NAME)
  t.is(replyNameOf(null), UNNAMED)
  t.is(replyNameOf(Object.freeze({ name: 'Ana', username: 'ana' })), 'Ana')
  t.is(replyNameOf(Object.freeze({ name: '', username: 'ana' })), 'ana')
})
