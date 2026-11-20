'use strict'

// Reads `aapt2 dump permissions <apk>` on stdin and fails when the merged
// manifest asks for a permission AndroidManifest.xml removes with
// tools:node="remove" (a library can add one back) or for the advertising ID,
// which the Play Data safety form says we never use. Prints the full sorted
// list, which is what the Data safety answers are checked against, and,
// given the output of `aapt2 dump badging <apk>` as a file, the target and
// compile SDK levels Play checks. Messages about failures go to stderr.
//   aapt2 dump permissions app.apk | node scripts/check-apk-permissions.js [badging.txt]
const fs = require('node:fs')

const BANNED = [
  'android.permission.CAMERA',
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
  'com.google.android.gms.permission.AD_ID'
]

function parsePermissions (text) {
  const names = new Set()
  for (const m of text.matchAll(/^uses-permission(?:-sdk-23)?: name='([^']+)'/gm)) names.add(m[1])
  return [...names].sort()
}

function parseSdk (badging) {
  const target = badging.match(/^targetSdkVersion:'(\d+)'/m)
  const compile = badging.match(/compileSdkVersion='(\d+)'/)
  return { target: target ? Number(target[1]) : null, compile: compile ? Number(compile[1]) : null }
}

// Returns the failure reasons; empty means the list is acceptable.
function checkPermissions (names) {
  if (names.length === 0) return ['no uses-permission line read (not aapt2 dump permissions output?)']
  return names.filter((n) => BANNED.includes(n)).map((n) => n + ' is in the merged manifest')
}

module.exports = { parsePermissions, parseSdk, checkPermissions, BANNED }

if (require.main === module) {
  const names = parsePermissions(fs.readFileSync(0, 'utf8'))
  console.log('permissions (' + names.length + '):')
  for (const n of names) console.log('  ' + n)
  const failures = checkPermissions(names)
  if (process.argv[2]) {
    const sdk = parseSdk(fs.readFileSync(process.argv[2], 'utf8'))
    console.log('targetSdkVersion: ' + sdk.target)
    console.log('compileSdkVersion: ' + sdk.compile)
    if (sdk.target === null || sdk.compile === null) failures.push('targetSdkVersion or compileSdkVersion missing from the badging')
  }
  if (failures.length > 0) {
    for (const f of failures) console.error('check-apk-permissions: FAIL: ' + f)
    process.exit(1)
  }
}
