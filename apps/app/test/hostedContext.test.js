'use strict'

// Feed rows (PostRow) must not subscribe to the whole node value: it is
// rebuilt on every sync flag, and a memoized row would redraw each time.
// useHosted() is only that boolean, provided beside both node providers.
const test = require('brittle')
const fs = require('fs')
const path = require('path')
const read = (file) => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')

test('PostRow reads hosted from its own context', (t) => {
  const row = read('ui/PostRow.js')
  t.absent(row.includes('useNode('), 'PostRow does not call useNode')
  t.ok(row.includes('useHosted('), 'PostRow calls useHosted')
  const node = read('node.js')
  t.ok(node.includes('export function useHosted'), 'node.js exports useHosted')
  t.ok(node.includes('const HostedContext = createContext(false)'), 'default is the boolean false')
  const providers = node.split('<HostedContext.Provider').length - 1
  t.ok(providers >= 2, 'live provider and vitrine provider')
  t.ok(node.includes('<HostedContext.Provider value={hosted}>'), 'live value is the plain boolean')
  t.ok(node.includes('<HostedContext.Provider value>'), 'vitrine value is the plain boolean true')
})
