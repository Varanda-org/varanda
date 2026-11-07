'use strict'

// The app worklet's browser node keeps the seeder lease off, like the browser
// page (docs/rpc.md 6.1): a visible app holds its seeder link, and the app's
// visibility handling stops the sync in the background. A non-zero
// leaseHoldMs in the worklet would drop the link after the settled hold and
// make every read reopen the cores from flash.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')

const workletPath = path.join(__dirname, '..', 'worklet', 'web-node.js')

function sessionCall (source) {
  const start = source.indexOf('createBrowserSession({')
  if (start === -1) return null
  const end = source.indexOf('\n  })', start)
  return end === -1 ? null : source.slice(start, end + 5)
}

test('worklet web node passes leaseHoldMs: 0 to createBrowserSession', (t) => {
  const source = fs.readFileSync(workletPath, 'utf8')
  const call = sessionCall(source)
  t.ok(call !== null, 'the createBrowserSession call is found')
  t.ok(/\bleaseHoldMs:\s*0\b/.test(call), 'leaseHoldMs is 0')
})

test('worklet web node sets no non-zero lease hold', (t) => {
  const source = fs.readFileSync(workletPath, 'utf8')
  const call = sessionCall(source) || ''
  t.absent(/\bleaseHoldMs:\s*(?!0\b)\S/.test(call), 'no leaseHoldMs other than 0 in the call')
  t.absent(/\bLEASE_HOLD_MS\b/.test(source), 'no LEASE_HOLD_MS constant left to pass')
})
