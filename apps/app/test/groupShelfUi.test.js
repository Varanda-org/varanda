'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', file), 'utf8')
const shelf = read('GroupShelf.js')
const box = read('PublicGroupsBox.js')

test('group discovery components sanitize peer names and hide when empty', (t) => {
  for (const [name, src] of [['GroupShelf', shelf], ['PublicGroupsBox', box]]) {
    t.ok(/import \{ displayText \} from '@varanda\/rpc'/.test(src), name + ' imports displayText')
    t.ok(src.includes('displayText(item.name)'), name + ' sanitizes the group name')
    t.absent(/communityName|styles\.community\b/.test(src), name + ' shows no community line')
    t.ok(src.includes('if (list.length === 0) return null'), name + ' hides when empty')
    t.absent(src.includes('Platform.OS'), name + ' shares platform behavior')
    t.absent(src.includes('\u2014'), name + ' uses no em dash')
    t.absent(src.includes('<CommunitiesBox'), name + ' renders its own interface')
  }
})

test('GroupShelf labels its heading and puts the ordering in help beside it', (t) => {
  t.ok(shelf.includes("accessibilityRole='header'"), 'heading role')
  t.ok(/\{title\}<\/Text>\s*\{orderText \? <HelpButton doc=\{\{ title: 'Ordem de ' \+ title, paragraphs: \[orderText\] \}\} size=\{18\} \/> : null\}/.test(shelf), 'help beside the title only when there is an order rule')
  t.absent(/<Text[^>]*>\s*\{orderText\}\s*<\/Text>/.test(shelf), 'no inline order rule')
  t.ok(/<Text[^>]*>\{note\}<\/Text>/.test(shelf), 'note stays visible')
})

test('PublicGroupsBox limits the strip and exposes every group in a sheet', (t) => {
  t.ok(box.includes('export const STRIP_MAX = 8'), 'strip cap')
  t.ok(box.includes('list.slice(0, STRIP_MAX)'), 'strip is capped')
  t.ok(box.includes("'Ver todos ('"), 'see all label')
  t.ok(box.includes("closeLabel='Fechar'"), 'sheet close label')
  t.ok(box.includes('list.map((item) => groupButton(item, true))'), 'sheet contains the full list')
  t.ok(box.includes('minHeight: 40,') && !/\bheight: 40\b/.test(box), 'chips can grow with large text')
})

test('the see all chip appears only past the strip cap, as in CommunitiesBox', (t) => {
  const chip = box.indexOf('accessibilityLabel={allLabel}')
  const gate = box.indexOf('{list.length > STRIP_MAX')
  t.ok(gate > -1 && gate < chip, 'the chip is gated by list.length > STRIP_MAX')
})

test('a row without a handler does nothing when pressed', (t) => {
  for (const [name, src] of [['GroupShelf', shelf], ['PublicGroupsBox', box]]) {
    t.ok(src.includes("if (typeof onOpen === 'function') onOpen(item.group)"), name + ' checks onOpen')
    t.absent(/[^)] onOpen\(item\.group\)/.test(src.replace("if (typeof onOpen === 'function') onOpen(item.group)", '')), name + ' never calls onOpen unchecked')
  }
})
