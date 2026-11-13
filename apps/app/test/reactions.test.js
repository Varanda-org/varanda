// Reaction list: toggle, replace, optimistic counts and labels (reactions.js).
'use strict'

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')

const load = () => import('../src/reactions.js')
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')

test('QUICK is the six reaction emoji', async (t) => {
  const { QUICK } = await load()
  t.alike(QUICK.map((emoji) => [...emoji].map((ch) => ch.codePointAt(0))), [
    [0x2764, 0xfe0f],
    [0x1f44d],
    [0x1f602],
    [0x1f62e],
    [0x1f622],
    [0x1f64f]
  ])
  t.is(QUICK.length, 6)
  t.ok(Object.isFrozen(QUICK))
})

test('toggle clears the own emoji and a later tap brings it back', async (t) => {
  const { QUICK, toggleOf, applyOptimistic } = await load()
  const like = QUICK[1]
  let rows = [{ emoji: like, count: 3, mine: true }]
  t.is(toggleOf(rows, like), '')
  rows = applyOptimistic(rows, toggleOf(rows, like))
  t.alike(rows, [{ emoji: like, count: 2, mine: false }])
  t.is(toggleOf(rows, like), like)
  rows = applyOptimistic(rows, toggleOf(rows, like))
  t.alike(rows, [{ emoji: like, count: 3, mine: true }])
  t.is(toggleOf([], ''), '')
  t.is(toggleOf(null, like), like)
  t.is(toggleOf([{ emoji: like, count: 1, mine: false }], like), like)
})

test('toggleOf follows the chip aggregate', async (t) => {
  const { QUICK, toggleOf } = await load()
  const like = QUICK[1]
  // A mine flag on a count the chips drop is not already yours.
  t.is(toggleOf([{ emoji: like, count: 0, mine: true }], like), like)
  t.is(toggleOf([{ emoji: like, count: 1.2, mine: true }], like), like)
})

test('replace moves the own reaction onto the new emoji', async (t) => {
  const { QUICK, toggleOf, applyOptimistic } = await load()
  const [heart, like, joy] = QUICK
  const start = [
    { emoji: heart, count: 2, mine: true },
    { emoji: like, count: 4, mine: false }
  ]
  t.is(toggleOf(start, joy), joy)
  t.alike(applyOptimistic(start, toggleOf(start, joy)), [
    { emoji: heart, count: 1, mine: false },
    { emoji: like, count: 4, mine: false },
    { emoji: joy, count: 1, mine: true }
  ])
  const ontoLike = applyOptimistic(start, toggleOf(start, like))
  t.alike(ontoLike, [
    { emoji: heart, count: 1, mine: false },
    { emoji: like, count: 5, mine: true }
  ])
  t.is(ontoLike.filter((row) => row.mine).length, 1)
  t.alike(applyOptimistic([{ emoji: heart, count: 1, mine: true }], like), [
    { emoji: like, count: 1, mine: true }
  ])
  t.alike(start, [
    { emoji: heart, count: 2, mine: true },
    { emoji: like, count: 4, mine: false }
  ])
})

test('optimistic counts never go below zero', async (t) => {
  const { QUICK, applyOptimistic } = await load()
  const [heart, like, joy] = QUICK
  const frozen = Object.freeze([Object.freeze({ emoji: like, count: 1, mine: true })])
  t.alike(applyOptimistic(frozen, ''), [])
  t.alike(frozen, [{ emoji: like, count: 1, mine: true }])
  t.alike(applyOptimistic([{ emoji: like, count: 0, mine: true }], ''), [])
  t.alike(applyOptimistic([{ emoji: like, count: -4, mine: true }], ''), [])
  t.alike(applyOptimistic([
    { emoji: like, count: 1.2, mine: true },
    { emoji: heart, count: Number.NaN, mine: false }
  ], joy), [
    { emoji: joy, count: 1, mine: true }
  ])
  const messy = applyOptimistic([
    { emoji: like, count: -1, mine: true },
    { emoji: heart, count: 1, mine: true },
    { emoji: joy, count: 2, mine: false }
  ], '')
  t.alike(messy, [{ emoji: joy, count: 2, mine: false }])
  for (const row of messy) t.ok(Number.isSafeInteger(row.count) && row.count > 0)
  t.alike(applyOptimistic(null, like), [{ emoji: like, count: 1, mine: true }])
  const same = applyOptimistic([{ emoji: heart, count: 2, mine: true }], heart)
  t.alike(same, [{ emoji: heart, count: 2, mine: true }])
})

test('chip labels name the emoji, the count and your own reaction', async (t) => {
  const { QUICK, reactionChips, reactionName } = await load()
  const [heart, like, joy] = QUICK
  t.alike(reactionChips([
    { emoji: heart, count: 3, mine: true },
    { emoji: like, count: 1, mine: false },
    { emoji: joy, count: 0, mine: false }
  ]), [
    { emoji: heart, count: 3, mine: true, label: reactionName(heart) + ', 3 reações, sua reação' },
    { emoji: like, count: 1, mine: false, label: reactionName(like) + ', 1 reação' }
  ])
  t.alike(reactionChips([
    { emoji: like, count: 1, mine: false },
    { emoji: like, count: 1, mine: true }
  ]), [
    { emoji: like, count: 2, mine: true, label: reactionName(like) + ', 2 reações, sua reação' }
  ])
  const many = QUICK.map((emoji) => ({ emoji, count: 1, mine: false }))
  many.push({ emoji: 'X', count: 1, mine: false })
  t.is(reactionChips(many).length, 6)
  t.is(reactionChips(many, { max: 2 }).length, 2)
  t.alike(reactionChips(many, { max: 0 }), [])
  t.is(reactionChips(many, null).length, 6)
  t.alike(reactionChips(undefined), [])
  t.alike(reactionChips([{ emoji: '', count: 4, mine: true }, { emoji: 3, count: 1 }]), [])
})

test('the own chip replaces the last visible one when it falls past max', async (t) => {
  const { reactionChips } = await load()
  const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((emoji, i) => ({
    emoji,
    count: 1,
    mine: i === 6
  }))
  t.alike(reactionChips(rows, { max: 6 }).map((chip) => [chip.emoji, chip.count, chip.mine]), [
    ['a', 1, false],
    ['b', 1, false],
    ['c', 1, false],
    ['d', 1, false],
    ['e', 1, false],
    ['g', 1, true]
  ])
})

test('reactorsLabel lists up to three names and says how many remain', async (t) => {
  const { reactorsLabel } = await load()
  t.is(reactorsLabel(['Ana'], 1), 'Ana')
  t.is(reactorsLabel(['Ana', 'Bia'], 2), 'Ana e Bia')
  t.is(reactorsLabel(['Ana', 'Bia', 'Caio'], 3), 'Ana, Bia e Caio')
  t.is(reactorsLabel(['Ana', 'Bia', 'Caio', 'Duda'], 4), 'Ana, Bia, Caio e mais 1')
  t.is(reactorsLabel(['Ana', 'Bia', 'Caio'], 8), 'Ana, Bia, Caio e mais 5')
  t.is(reactorsLabel(['Ana'], 4), 'Ana e mais 3')
  t.is(reactorsLabel(['Ana', 'Bia', 'Caio', 'Duda']), 'Ana, Bia, Caio e mais 1')
  t.is(reactorsLabel([' Ana ', '  ', 'Bia', 3, 'Caio']), 'Ana, Bia e Caio')
  t.is(reactorsLabel(['Ana', 'Bia', 'Caio'], 2), 'Ana e Bia')
  t.is(reactorsLabel([], 1), '1 pessoa')
  t.is(reactorsLabel([], 2), '2 pessoas')
  t.is(reactorsLabel([], 10), '10 pessoas')
  t.is(reactorsLabel(null), '0 pessoas')
  t.is(reactorsLabel(['Ana'], 0), '')
})

test('whoLines lists every name the sheet was given', async (t) => {
  const { whoLines } = await load()
  const names = ['Ana', 'Bia', 'Caio', 'Duda', 'Eva', 'Fio', 'Gabi', 'Hugo', 'Ivo', 'Juca']
  t.alike(whoLines(names, 10), names)
  t.alike(whoLines(names, 12), names.concat(['e mais 2']))
  t.alike(whoLines([], 1), ['1 pessoa'])
  t.alike(whoLines([], 7), ['7 pessoas'])
  t.alike(whoLines(['Ana', 'Bia', 'Caio', 'Duda'], 2), ['Ana', 'Bia', 'Caio', 'Duda'])
  t.alike(whoLines([' Ana ', '  ', 'Bia'], 4), ['Ana', 'Bia', 'e mais 2'])
})

test('reactionName returns the pt-BR name, not the emoji', async (t) => {
  const { QUICK, reactionName } = await load()
  const names = [
    'coração vermelho',
    'positivo',
    'chorando de rir',
    'surpreso',
    'triste',
    'gratidão'
  ]
  t.alike(QUICK.map(reactionName), names)
  for (const emoji of QUICK) t.ok(reactionName(emoji) !== emoji)
  t.is(reactionName('?'), '?')
  t.is(reactionName(''), '')
})

test('reactions.js stays free of UI and node imports', (t) => {
  const src = read('src/reactions.js')
  t.ok(!src.includes('react-native'))
  t.ok(!/from\s+['"]react['"]/.test(src))
  t.ok(!src.includes('ui/theme'))
  t.ok(!/from\s+['"]node:/.test(src))
  t.ok(!/from\s+['"]fs['"]/.test(src))
  t.ok(!/from\s+['"]path['"]/.test(src))
})

test('reaction UI blocks use the sheet, the picker and press scale', (t) => {
  const chips = read('src/ui/Reactions.js')
  const picker = read('src/ui/ReactionPicker.js')
  // Split so this file does not contain the words it forbids.
  const hidden = ['li' + 'da', 'entre' + 'gue', 'digi' + 'tando']
  const platform = 'Platform' + '.OS'
  t.ok(chips.includes('PressScale'))
  t.ok(chips.includes('colors.accentSoft'))
  t.ok(chips.includes('colors.inputOff'))
  t.ok(chips.includes('colors.line'))
  t.ok(/\bcolors\.accent\b/.test(chips))
  t.ok(chips.includes('CHIP_MIN = 32'))
  t.ok(chips.includes('hitSlop'))
  t.ok(chips.includes('layout.hit'))
  t.ok(chips.includes('mais reações'))
  t.ok(chips.includes('onLongPress'))
  t.ok(chips.includes('onShowWho'))
  t.ok(chips.includes('reactionName(emoji)'))
  t.ok(picker.includes('EmojiPicker'))
  t.ok(picker.includes('<Sheet'))
  t.ok(picker.includes('Quem reagiu'))
  t.ok(picker.includes('whoLines(namesOf(row), count).map((line) => displayText(line))'))
  t.ok(picker.includes('lines.map((line, j)'))
  t.ok(picker.includes('{ emoji, names: string[], count }'))
  t.ok(picker.includes('displayText'))
  t.absent(/row\.name\b/.test(picker))
  t.absent(picker.includes('reactorsLabel'))
  for (const src of [read('src/reactions.js'), chips, picker, read('test/reactions.test.js')]) {
    t.ok(!src.includes(platform))
    t.ok(!Array.from(src).some((ch) => ch.codePointAt(0) === 0x2014))
    for (const word of hidden) t.ok(!src.includes(word))
  }
})

test('quick targets are at least 44 pt wide on a 320 pt screen', (t) => {
  const src = read('src/ui/Reactions.js')
  const theme = read('src/ui/theme.js')
  const spaceSrc = theme.slice(theme.indexOf('export const space'), theme.indexOf('export const radius'))
  const quick = (src.match(/\n {2}quick:\s*\{[^}]*\}/) || [''])[0]
  const hit = (src.match(/\n {2}quickHit:\s*\{[^}]*\}/) || [''])[0]
  const pad = quick.match(/paddingHorizontal:\s*space\.(\w+)/)
  const token = pad ? pad[1] : ''
  const found = token ? spaceSrc.match(new RegExp('\\b' + token + ':\\s*(\\d+)')) : null
  const side = found ? Number(found[1]) : NaN
  const screen = 320
  const targets = 7
  const min = 44
  t.is(token, 'xs')
  t.is(side, 4)
  t.ok(screen - 2 * side >= targets * min)
  t.ok((screen - 2 * side) / targets >= min)
  t.ok(/minHeight:\s*layout\.hit/.test(hit))
  t.is(Number((theme.match(/\bhit:\s*(\d+)/) || [])[1]), min)
})
