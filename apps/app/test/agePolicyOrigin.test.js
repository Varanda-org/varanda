'use strict'

// App.js is the shell. Read it as text so this test never loads JSX.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')

const source = () => fs.readFileSync(path.join(__dirname, '../App.js'), 'utf8')

test('the age policy is keyed by the installation it was read from', (t) => {
  const s = source()
  t.ok(s.includes("const ageOrigin = installationOrigin() || globalThis.location?.origin || ''"))
  t.ok(s.includes('const [agePolicyEntry, setAgePolicyEntry] = useState(null)'))
  t.ok(s.includes('setAgePolicyEntry({ origin, policy: p })'))
  t.ok(s.includes('agePolicyEntry !== null && agePolicyEntry.origin === ageOrigin ? agePolicyEntry.policy : undefined'))
  t.absent(s.includes('const [agePolicy, setAgePolicy] = useState('))
})

test('an answer read for another installation is never applied', (t) => {
  const s = source()
  t.ok(s.includes('const origin = ageOrigin'))
  t.ok(s.includes('}, [ageHosted, ready, agePolicyKnown, agePolicyTick, ageOrigin])'))
  t.ok(s.includes('agePolicyTries.current = 0'))
})
