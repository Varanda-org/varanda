'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const src = readFileSync(join(__dirname, '../src/ui/MemberRow.js'), 'utf8')

test('MemberRow uses meta type, a small follow pill and no divider', (t) => {
  t.ok(src.includes('...type.meta'), 'handle uses type.meta')
  t.absent(src.includes('type.postMeta'))
  t.ok(/<FollowPill\s+small\b/.test(src), 'small follow pill')
  t.ok(src.includes('persist={following === true}'))
  t.ok(src.includes('size={48}'), '48 avatar')
  t.ok(src.includes('...type.rowName'), 'name uses the row name token')
  t.absent(src.includes('marginLeft: 72'), 'no inset divider')
  t.absent(src.includes('StyleSheet.hairlineWidth'), 'no hairline')
  t.absent(/borderBottomWidth: 1/.test(src), 'no full-width 1 px rule')
})
