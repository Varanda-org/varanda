'use strict'

const test = require('brittle')
const { buildExport, checkExport, exportPreferences, exportFileName, EXPORT_FORMAT, EXPORT_VERSION, EXPORT_APPEARANCES } = require('..')

const KEY = 'ab'.repeat(32)
const ASSOC = 'cd'.repeat(32)
const AT = '2026-11-25T12:00:00.000Z'

function parts (over = {}) {
  return {
    key: KEY,
    head: { association: ASSOC, length: 3, profile: { name: 'Ana', bio: 'oi' } },
    follows: ['11'.repeat(32), '22'.repeat(32)],
    entries: [
      { seq: 0, record: { type: 'profile', name: 'Ana', bio: 'oi', at: AT } },
      { seq: 2, record: { type: 'post', text: 'a "q"\nb </script> \ud800', at: AT, replyTo: null } }
    ],
    invalid: [{ seq: 1, reason: 'deleted' }],
    preferences: exportPreferences({ previews: true, wifiOnly: false, appearance: 'dark' }, null),
    exportedAt: AT,
    ...over
  }
}

test('buildExport output parses and passes checkExport', (t) => {
  const text = buildExport(parts())
  t.ok(text.endsWith('}\n'))
  const doc = JSON.parse(text)
  t.is(checkExport(doc), null)
  t.alike(Object.keys(doc), ['format', 'version', 'exportedAt', 'key', 'association', 'profile', 'follows', 'preferences', 'diary'])
  t.is(doc.format, EXPORT_FORMAT)
  t.is(doc.version, EXPORT_VERSION)
  t.alike(doc.profile, { name: 'Ana', bio: 'oi' })
  t.alike(doc.diary.entries, parts().entries.map((e) => JSON.parse(JSON.stringify(e))))
  for (const e of parts().entries) t.ok(text.split('\n').includes('      ' + JSON.stringify(e) + (e.seq === 2 ? '' : ',')), 'one line per entry')
  t.ok(text.split('\n').includes('      ' + JSON.stringify({ seq: 1, reason: 'deleted' })))
})

test('buildExport: text round trips, empty lists and no profile', (t) => {
  const record = { type: 'post', text: '"\\\n\r\t</script><!-- \u2028 \ud800 \u{1f600}', at: AT, replyTo: null }
  const doc = JSON.parse(buildExport(parts({ entries: [{ seq: 0, record }] })))
  t.is(doc.diary.entries[0].record.text, record.text)
  const empty = buildExport(parts({ head: { association: ASSOC, length: 0, profile: null }, follows: [], entries: [], invalid: [] }))
  const d = JSON.parse(empty)
  t.is(checkExport(d), null)
  t.is(d.profile, null)
  t.alike(d.follows, [])
  t.alike(d.diary, { length: 0, entries: [], invalid: [] })
})

test('exportPreferences is an allowlist', (t) => {
  const head = { blocked: [KEY, 'zz', 3], muted: null }
  t.alike(exportPreferences({ previews: true, wifiOnly: false, appearance: 'light', token: 'secret', extra: 1 }, head), {
    previews: true, wifiOnly: false, appearance: 'light', blocked: [KEY], muted: null
  })
  t.alike(exportPreferences({ previews: 'yes', wifiOnly: 1, appearance: 'neon' }, undefined), {
    previews: null, wifiOnly: null, appearance: null, blocked: null, muted: null
  })
  t.alike(Object.keys(exportPreferences(undefined, null)), ['previews', 'wifiOnly', 'appearance', 'blocked', 'muted'])
  t.alike(EXPORT_APPEARANCES, ['system', 'light', 'dark'])
})

test('checkExport refuses malformed documents', (t) => {
  const good = () => JSON.parse(buildExport(parts()))
  t.is(checkExport(good()), null)
  const d1 = good(); d1.version = 2
  t.ok(checkExport(d1))
  const d2 = good(); d2.format = 'x'
  t.ok(checkExport(d2))
  const d3 = good(); d3.extra = 1
  t.ok(checkExport(d3))
  const d4 = good(); d4.diary.entries.reverse()
  t.ok(checkExport(d4), 'descending seqs')
  const d5 = good(); d5.diary.length = 1
  t.ok(checkExport(d5), 'more blocks than length')
  const d6 = good(); d6.key = 'AB'.repeat(32)
  t.ok(checkExport(d6))
  const d7 = good(); d7.preferences.token = 'x'
  t.ok(checkExport(d7))
  const d8 = good(); d8.follows = ['nope']
  t.ok(checkExport(d8))
  const d9 = good(); d9.diary.length = 3; d9.diary.entries[1].seq = 3; d9.diary.invalid = []
  t.is(checkExport(d9), 'diary seq', 'seq at or past length')
  const d10 = good(); d10.diary.invalid = [{ seq: 2, reason: 'deleted' }]
  t.is(checkExport(d10), 'diary seq', 'same seq in entries and invalid')
  const reordered = good()
  t.ok(checkExport({ key: reordered.key, ...reordered }), 'key order')
  t.ok(checkExport(null))
  t.ok(checkExport([]))
})

test('exportFileName', (t) => {
  const name = exportFileName(KEY, Date.UTC(2026, 10, 25, 23, 59))
  t.ok(/^varanda-dados-[0-9a-f]{8}-\d{4}-\d{2}-\d{2}\.json$/.test(name), name)
  t.is(name, 'varanda-dados-abababab-2026-11-25.json')
})
