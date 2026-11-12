// The share seams in the shell hook, Publicar and App.js have no React test
// renderer here, so they are pinned as source text: each pin guards a rule
// that keeps shared files alive while Publicar is still reading them.
'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const APP = join(__dirname, '..')
const read = (rel) => readFileSync(join(APP, rel), 'utf8')

test('the hook never peeks or sweeps while Publicar holds a share', (t) => {
  const hook = read('src/useSharedIntent.js')
  t.ok(/const blocked = \(\) => \{[\s\S]*?if \(stateRef\.current\.taken\) \{\s*pendingRead\.current = true\s*return true/.test(hook), 'a read while taken is deferred, not run')
  t.ok(/const read = \(\) => \{\s*if \(blocked\(\)\) return\s*return shareIntake\.peek\(\)/.test(hook), 'peek runs only past the guard')
  t.ok(/if \(!blocked\(\)\) shareIntake\.sweep\(SHARE_TTL_MS\)/.test(hook), 'sweep runs only past the guard')
  t.ok(/if \(wasTaken && !next\.state\.taken && pendingRead\.current\) \{\s*pendingRead\.current = false/.test(hook), 'one deferred read runs once the share is let go')
  t.ok(/return \(\) => \{\s*alive = false/.test(hook), 'an answer after unmount is ignored')
  t.ok(/shareIntake\.listen\(read\)/.test(hook), 'wake-ups go through the same guarded read')
  t.ok(/send\(\{ type: 'tick', ready, locked, ownKey, gone, now: Date\.now\(\) \}\)/.test(hook), 'every tick says whether the account left')
})

test('Publicar claims a share before reading its files and lets go only while mounted', (t) => {
  const src = read('src/screens/Publicar.js')
  t.ok(/!frozen && !busy && !moment\.pending\)\) return\s*appliedShareRef\.current = shared\.id\s*onSharedTaken\(shared\.id\)/.test(src), 'taken is sent first, and never during a Momento upload')
  t.ok(/\[open, shared && shared\.id, frozen, busy, moment\.pending\]/.test(src), 'the effect runs again when the Momento upload ends')
  t.ok(/if \(mountedRef\.current\) onSharedDone\(shared\.id\)/.test(src), 'done after unmount would drop files the remount needs')
  t.ok(/addFiles\(shared\.files,/.test(src), 'shared photos take the picker encode path')
  t.is((src.match(/failed: shared\.failed \|\| 0/g) || []).length, 2, 'both notes count the photos that could not be opened')
})

test('the shell holds a share off the deleted-account screen and wires taken', (t) => {
  const app = read('App.js')
  t.ok(app.includes('ready: atTabs && atShell && !coveringBoot && !(deletedState !== null && member !== null && passkey !== null)'), 'ready mirrors the ContaExcluida early return')
  t.ok(app.includes('if (deletedState !== null && member !== null && passkey !== null) {'), 'the early return it mirrors is still there')
  t.ok(/: \(pkStatus !== null && pkStatus\.exists === true && \(pkStatus\.signedOut !== true \|\| pkStatus\.unlocked === true\) && typeof pkStatus\.publicKey === 'string' \? pkStatus\.publicKey\.toLowerCase\(\) : null\)/.test(app), 'the share owner is the stored account, known while locked, and the unlocked one behind a sign-out marker')
  t.ok(app.includes('ownKey: shareOwner,\n    gone: passkey !== null && pkStatus !== null && shareOwner === null,'), 'Sair or Recomeçar marks the account as gone')
  t.ok(app.includes('onSharedTaken={(id) => share.taken(id)}'), 'Publicar can claim the share')
  t.ok(app.includes('onSharedDone={(id) => share.done(id)}'), 'Publicar can let it go')
})
