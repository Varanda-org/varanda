'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const shelf = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'CommunityShelf.js'), 'utf8')

test('CommunityShelf sanitizes the name, hides when empty and keeps the order rule behind help', (t) => {
  t.ok(/import \{ displayText \} from '@varanda\/rpc'/.test(shelf), 'imports displayText')
  t.ok(shelf.includes('const name = displayText(item.name)'), 'sanitizes the community name')
  t.ok(shelf.includes('if (list.length === 0) return null'), 'hides when empty')
  t.ok(shelf.includes("accessibilityRole='header'"), 'heading role')
  t.ok(shelf.includes("<HelpButton doc={{ title: 'Ordem de ' + title, paragraphs: [orderText] }}"), 'order rule in help')
  t.absent(/<Text[^>]*>\s*\{orderText\}\s*<\/Text>/.test(shelf), 'no inline order rule')
  t.ok(shelf.includes('{meta ? <Text style={styles.detail}>{meta}</Text> : null}'), 'member count and join mode line')
  t.ok(shelf.includes('accessibilityLabel={[name, meta].filter(Boolean).join'), 'label carries name and meta')
  t.absent(shelf.includes('Platform.OS'), 'no platform branch')
  t.absent(shelf.includes('\u2014'), 'no em dash')
})

test('CommunityShelf opens the community, keyed by community', (t) => {
  t.ok(shelf.includes('key={item.community}'), 'keyed by community')
  t.ok(shelf.includes("if (typeof onOpen === 'function') onOpen(item.community)"), 'opens the community when there is a handler')
  t.absent(shelf.includes('item.group'), 'never a group key')
})
