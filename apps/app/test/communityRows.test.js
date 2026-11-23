'use strict'

const test = require('brittle')
const { readFileSync } = require('fs')
const { join } = require('path')

const load = () => import('../src/communityRows.js')
const missing = { name: null, visibility: null, general: false }
const labels = { general: 'Geral', private: 'grupo privado' }

test('rowVisibility prefers the node and accepts only known values from the index', async (t) => {
  const { rowVisibility } = await load()
  t.is(rowVisibility({ visibility: 'public' }, { visibility: 'private' }), 'public')
  t.is(rowVisibility({ visibility: 'private' }, { visibility: 'public' }), 'private')
  t.is(rowVisibility(missing, { visibility: 'public' }), 'public')
  t.is(rowVisibility({ visibility: 'unrecognized' }, { visibility: 'private' }), 'private')
  t.is(rowVisibility(missing, { visibility: 'unrecognized' }), null)
  t.is(rowVisibility(missing, { visibility: null }), null)
  t.is(rowVisibility(missing), null)
})

test('rowTitle uses names first and reserves the private label for known private groups', async (t) => {
  const { rowTitle } = await load()
  const hint = { name: 'Jardim no índice', visibility: 'public' }
  t.is(rowTitle({ ...missing, name: 'Jardim' }, hint, labels), 'Jardim')
  t.is(rowTitle({ ...missing, name: '', general: true }, hint, labels), hint.name)
  t.is(rowTitle({ ...missing, general: true, visibility: 'private' }, { name: '' }, labels), labels.general)
  t.is(rowTitle({ ...missing, visibility: 'private' }, undefined, labels), labels.private)
  t.is(rowTitle(missing, { name: null, visibility: 'private' }, labels), labels.private)
  t.is(rowTitle({ ...missing, visibility: 'public' }, undefined, labels), 'Grupo')
  t.is(rowTitle(missing, undefined, labels), 'Grupo')
})

test('rowVisibilityText labels known visibility and leaves unknown visibility blank', async (t) => {
  const { rowVisibilityText } = await load()
  const { visibilityLabel } = await import('../src/groups.js')
  t.is(rowVisibilityText({ visibility: 'private' }, { visibility: 'public' }, visibilityLabel), 'grupo privado')
  t.is(rowVisibilityText(missing, { visibility: 'public' }, visibilityLabel), 'grupo público')
  t.is(rowVisibilityText(missing, { visibility: null }, visibilityLabel), '')
})

test('needNames looks for a missing non-General root in a non-pending community', async (t) => {
  const { needNames } = await load()
  t.is(needNames(null), false)
  t.is(needNames('ready'), false)
  t.is(needNames({ state: 'pending', groups: [missing] }), false)
  t.is(needNames({ state: 'ready' }), false)
  t.is(needNames({ groups: [] }), false)
  t.is(needNames({ groups: [{ ...missing, name: '' }] }), false)
  t.is(needNames({ groups: [{ ...missing, name: 'Jardim' }] }), false)
  t.is(needNames({ groups: [{ ...missing, visibility: 'private' }] }), false)
  t.is(needNames({ groups: [{ ...missing, visibility: 'public' }] }), false)
  t.is(needNames({ groups: [{ ...missing, visibility: undefined }] }), false)
  t.is(needNames({ groups: [{ ...missing, general: true }] }), false)
  t.is(needNames({ state: 'ready', groups: [{ ...missing, general: true }, missing] }), true)
  t.is(needNames({ groups: [missing] }), true)
})

test('Comunidade fetches index hints without switching a held community to the index view', (t) => {
  const src = readFileSync(join(__dirname, '../src/screens/Comunidade.js'), 'utf8')
  t.ok(src.includes('const wantNames = hosted && needNames(info)'))
  t.ok(src.includes('if (!needIndex && !wantNames) {'))
  t.ok(src.includes('}, [needIndex, wantNames, loadIndex])'))
  t.ok(src.includes("const fromIndex = needIndex && idx.status === 'done'"))
  t.ok(src.includes("const indexName = idx.status === 'done' && needIndex &&"))
})

test('Comunidade uses index hints only for unknown rows and labels only known visibility', (t) => {
  const src = readFileSync(join(__dirname, '../src/screens/Comunidade.js'), 'utf8')
  t.ok(src.includes('const hint = g.visibility === null ? hintFor(g.group) : undefined'))
  t.ok(src.includes('displayText(rowTitle(g, hint, ROW_LABELS))'))
  t.ok(src.includes('rowVisibilityText(g, hint, visibilityLabel)'))
  t.absent(src.includes('visibilityLabel(g.visibility)'))
  t.ok(src.includes("detail={membersLabel(g.writerCount) || (g.visibility === 'private' ? 'grupo privado' : '')}"))
})

test('awaitsIndex waits only for a pending community whose index read has not answered', async (t) => {
  const { awaitsIndex } = await load()
  const pend = { state: 'pending', groups: [] }
  t.is(awaitsIndex(pend, 'idle'), true)
  t.is(awaitsIndex(pend, 'loading'), true)
  t.is(awaitsIndex(pend, 'done'), false)
  t.is(awaitsIndex(pend, 'error'), false)
  t.is(awaitsIndex(pend), false)
  t.is(awaitsIndex(null, 'loading'), false)
  t.is(awaitsIndex('pending', 'loading'), false)
  t.is(awaitsIndex({ state: 'ready', groups: [] }, 'loading'), false)
  t.is(awaitsIndex({ state: 'ready', role: 'pending', groups: [] }, 'idle'), false)
  t.is(awaitsIndex({ groups: [] }, 'loading'), false)
})

test('Comunidade shows placeholders, not the empty list, while a pending community waits on the index', (t) => {
  const src = readFileSync(join(__dirname, '../src/screens/Comunidade.js'), 'utf8')
  t.ok(src.includes('const indexWait = awaitsIndex(info, idx.status)'))
  const nullAt = src.indexOf('} else if (info === null) {')
  const waitAt = src.indexOf('} else if (indexWait) {')
  t.ok(nullAt > 0 && waitAt > nullAt, 'after the info === null skeleton')
  t.ok(waitAt < src.indexOf('const joinable ='), 'before the held-community body')
  t.ok(/else if \(indexWait\) \{\s+(\/\/[^\n]*\n\s+)*body = <View>.*<SkeletonRow/.test(src), 'skeleton body')
})
