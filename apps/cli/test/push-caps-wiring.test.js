'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

test('account opens the guarded push capability store and passes it to the server', (t) => {
  const source = readFileSync(join(__dirname, '../lib/commands/account.js'), 'utf8')
  t.ok(/const \{ openPushCapsStore \} = require\('\.\.\/account\/push-caps-store'\)/.test(source), 'imports the capability store')
  t.ok(/pushCapsStore = openPushCapsStore\(flags\.dataDir, \{ guard: held \}\)/.test(source), 'opens it in the account data dir under the writer guard')
  t.ok(/if \(!pushCapsStore\.available\(\)\) log\(\{ event: 'push', reason: 'indisponivel' \}\)/.test(source), 'logs unavailability like the push store')
  t.ok(/const push = \{\s*pushStore,\s*pushCapsStore,/.test(source), 'passes capabilities alongside subscriptions')
})
