'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const load = () => import('../src/webAnchor.js')

test('a half-hidden first row anchors the list', async (t) => {
  const { pickAnchor } = await load()
  t.is(pickAnchor([{ top: -20, bottom: 30 }]), 0)
})

test('rows above the viewport are skipped', async (t) => {
  const { pickAnchor } = await load()
  t.is(pickAnchor([
    { top: -100, bottom: -50 },
    { top: -50, bottom: 0 },
    { top: 0, bottom: 50 }
  ]), 2)
})

test('empty and non-array inputs have no anchor', async (t) => {
  const { pickAnchor } = await load()
  t.is(pickAnchor([]), -1)
  t.is(pickAnchor(null), -1)
  t.is(pickAnchor({ top: 0, bottom: 50 }), -1)
})

test('a list fully above the viewport has no anchor', async (t) => {
  const { pickAnchor } = await load()
  t.is(pickAnchor([{ top: -100, bottom: -50 }, { top: -50, bottom: 0 }]), -1)
})

test('invalid row rects are skipped', async (t) => {
  const { pickAnchor } = await load()
  t.is(pickAnchor([
    { top: NaN, bottom: 10 },
    { top: 0, bottom: Infinity },
    { top: '0', bottom: 10 },
    null,
    { top: 10, bottom: 30 }
  ]), 4)
})

test('the anchor shift follows the direction of the row movement', async (t) => {
  const { anchorShift } = await load()
  t.is(anchorShift(-20, 30), 50)
  t.is(anchorShift(30, -20), -50)
})

test('invalid positions need no correction', async (t) => {
  const { anchorShift } = await load()
  t.is(anchorShift(NaN, 10), 0)
  t.is(anchorShift(10, Infinity), 0)
  t.is(anchorShift('0', 10), 0)
})

test('anchor shifts under half a pixel are ignored', async (t) => {
  const { anchorShift } = await load()
  t.is(anchorShift(0, 0.3), 0)
  t.is(anchorShift(0.3, 0), 0)
  t.is(anchorShift(0, 0.5), 0.5)
})

test('an older page in front of the old first row is a prepend', async (t) => {
  const { isPrepend } = await load()
  const rows = (...keys) => keys.map((key) => ({ key }))
  t.ok(isPrepend(rows('c', 'd'), rows('a', 'b', 'c', 'd'), (row) => row.key))
  t.ok(isPrepend(rows('c', 'd'), rows('a', 'b', 'c', 'd')), 'row.key without a keyExtractor')
})

test('other data changes are not prepends', async (t) => {
  const { isPrepend } = await load()
  const rows = (...keys) => keys.map((key) => ({ key }))
  t.absent(isPrepend(rows('a', 'b'), rows('a', 'b', 'c')), 'appended at the end')
  t.absent(isPrepend(rows('a', 'b'), rows('a', 'b')), 'same rows, new reactions')
  t.absent(isPrepend([], rows('a')), 'first load')
  t.absent(isPrepend(rows('a', 'b'), rows('x', 'y')), 'replaced history')
  t.absent(isPrepend(rows('a'), []), 'emptied')
  t.absent(isPrepend(null, rows('a')), 'no previous data')
  t.absent(isPrepend([{}], rows('a', 'b')), 'no key on the old first row')
})

test('the private chat opts into scroll anchoring on the web', (t) => {
  const read = (file) => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')
  // Each list's own props: from its tag to the closing tag at the same indent.
  const listProps = (src, tag = '<RefreshableList') => {
    const lists = []
    for (let start = src.indexOf(tag); start !== -1; start = src.indexOf(tag, start + 1)) {
      const indent = src.slice(src.lastIndexOf('\n', start) + 1, start)
      const end = src.indexOf('\n' + indent + '/>', start)
      if (end !== -1) lists.push(src.slice(start, end))
    }
    return lists
  }
  const chat = listProps(read('screens/Mensagem.js')).find((props) => props.includes("perfId='mensagem'"))
  t.ok(chat && /\n\s+allRowsOnWeb\n/.test(chat), 'Mensagem.js enables allRowsOnWeb on its chat list')
  const groupLists = listProps(read('screens/Grupo.js'))
  const groupChat = listProps(read('screens/Grupo.js'), '<GroupChatList').find((props) => props.includes("perfId='grupo'"))
  t.ok(groupChat && /\n\s+allRowsOnWeb\n/.test(groupChat), 'Grupo.js enables allRowsOnWeb on its chat list')
  t.ok(groupLists.length === 1 && !/allRowsOnWeb/.test(groupLists[0]), 'the Tópicos list stays windowed')
  const list = read('ui/RefreshableList.js')
  t.ok(list.includes('getSnapshotBeforeUpdate'), 'the list captures the anchor before DOM updates')
  t.absent(/overflowAnchor/.test(list), 'the browser keeps its own scroll anchoring for rows that grow later')
  t.ok(/import\s+\{[^}]+\}\s+from '\.\.\/webAnchor'/.test(list), 'the list imports the anchor helpers')
})
