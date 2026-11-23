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
  t.ok(/\[open, shared && shared\.id, frozen, busy, moment\.pending, reframing\]/.test(src), 'the effect runs again when the Momento upload ends')
  t.ok(/const done = \(failed\) => \{\s*if \(!mountedRef\.current\) return[\s\S]{0,200}?const next = holdShare\(shared\.id, failed\.filter\(\(id\) => sourcesRef\.current\.has\(id\)\)\)\s*if \(next\.done !== null\) \{\s*onSharedDone\(shared\.id\)/.test(src), 'done after unmount would drop files the remount needs, and only photos still kept for a retry hold the share')
  t.ok(/addFiles\(shared\.files,/.test(src), 'shared photos take the picker encode path')
  t.is((src.match(/failed: shared\.failed \|\| 0/g) || []).length, 2, 'both notes count the photos that could not be opened')
})

test('Publicar builds no preview for a shared link until the person asks or edits', (t) => {
  const src = read('src/screens/Publicar.js')
  t.ok(src.includes('const shareLinkHeld = linkHeld(linkHold, text)'), 'the hold is read from the pure helper')
  t.ok(/useLinkDraft\(\{ text, enabled: open === true && !shareLinkHeld[ ,]/.test(src), 'a held link never builds')
  t.ok(src.includes('setLinkHold((hold) => sharedLinkHold(current, merged.text, hold))'), 'applying a share sets the hold, keeping one still in place')
  t.ok(/if \(linkHold !== null && linkHold !== text\) setLinkHold\(null\)/.test(src), 'an edit releases it')
  t.ok(/<Pill label='Mostrar prévia do link'[^>]*onPress=\{\(\) => setLinkHold\(null\)\}/.test(src), 'the tap releases it')
})

test('the shell holds a share off the deleted-account screen and wires taken', (t) => {
  const app = read('App.js')
  t.ok(app.includes('ready: atTabs && atShell && !coveringBoot && !(deletedState !== null && member !== null && passkey !== null)'), 'ready mirrors the ContaExcluida early return')
  t.ok(app.includes('if (deletedState !== null && member !== null && passkey !== null) {'), 'the early return it mirrors is still there')
  t.ok(/: \(pkStatus !== null && pkStatus\.exists === true && \(pkStatus\.signedOut !== true \|\| pkStatus\.unlocked === true\) && typeof pkStatus\.publicKey === 'string' \? pkStatus\.publicKey\.toLowerCase\(\) : null\)/.test(app), 'the share owner is the stored account, known while locked, and the unlocked one behind a sign-out marker')
  t.ok(app.includes('ownKey: shareOwner,\n    gone: passkey !== null && pkStatus !== null && shareOwner === null,'), 'Sair or Recomeçar marks the account as gone')
  t.ok(app.includes('onSharedTaken={(id) => share.taken(id)}'), 'Publicar can claim the share')
  t.ok(app.includes('onSharedDone={(id) => share.done(id)}'), 'Publicar can let it go')
  t.ok(app.includes('onSharedLoaded={(id) => share.loaded(id)}'), 'Publicar can keep it for a retry')
  t.ok(app.includes('onSharedFree={(id) => share.free(id)}'), 'and free it later')
})

// A shared photo that failed to open keeps its file for 'tentar de novo'
// without blocking the next share, and is freed once nothing needs it.
test('Publicar keeps a share for a retry and frees it once nothing needs it', (t) => {
  const src = read('src/screens/Publicar.js')
  t.ok(/holdRef\.current = next\.hold\s*onSharedLoaded\(shared\.id\)/.test(src), 'a failed photo keeps the share, and the shell lets go of it')
  t.ok(/addFiles\(shared\.files, [\s\S]{0,400}?\.then\(done, \(\) => done\(\[\]\)\)/.test(src), 'a failed load still lets the share go')
  t.ok(/const removeItems = \(ids\) => \{[\s\S]*?sourcesRef\.current\.delete\(id\)[\s\S]*?settleShare\(Array\.from\(gone\)\)\s*\}/.test(src), 'removing, publishing or discarding a photo settles the hold')
  t.ok(/sourcesRef\.current\.delete\(id\)\s*readyItem\(id, encoded\)\s*settleShare\(\[id\]\)/.test(src), 'a retry that opens settles it')
  t.ok(/if \(!again\) \{\s*sourcesRef\.current\.delete\(id\)\s*settleShare\(\[id\]\)/.test(src), 'a retry that fails for good settles it')
  t.ok(/if \(holdRef\.current !== null\) freeRef\.current\(holdRef\.current\.id\)\s*holdRef\.current = null\s*\}, \[\]\)/.test(src), 'unmounting (a lock) frees it')
  t.ok(/if \(holdRef\.current !== null\) \{\s*const old = holdRef\.current[\s\S]*?freeRef\.current\(old\.id\)/.test(src), 'a newer share frees the older one')
  t.ok(/if \(source === undefined \|\| !liveRef\.current\.has\(id\) \|\| held \|\| encodingAny\) return/.test(src), 'one decode at a time, never while sending')
  t.ok(/if \(Date\.now\(\) > source\.until\) \{\s*sourcesRef\.current\.delete\(id\)\s*settleShare\(\[id\]\)\s*patch\(id, \{ error: EXPIRED_TEXT, reencode: false \}\)/.test(src), 'past the share expiry the retry ends, since the sweep took the file')
  t.ok(/\}\)\), shared\.at \+ SHARE_TTL_MS\)\.then\(done/.test(src), 'a shared photo expires with its share')
  t.ok(/const again = retryableEncode\(error\) && sourcesRef\.current\.has\(id\)/.test(src), 'a retry that ends after a newer share replaced its files offers no other')
})

// A shared video goes through the gallery's preparation; its file stays
// until that ends, and the shell is never left holding it.
test('Publicar prepares a shared video and frees its file when the preparation ends', (t) => {
  const src = read('src/screens/Publicar.js')
  const effect = src.slice(src.indexOf('const sharedVideo = shared.video || null'))
  t.ok(effect.indexOf('video.draft.pick(') < effect.indexOf('if (shared.files.length === 0 || !canAttach)'), 'the video is handled before the photo path')
  t.ok(/if \(!canVideo\) \{\s*onSharedDone\(shared\.id\)\s*return\s*\}/.test(effect), 'where no video can be attached, the share is let go with the note')
  t.ok(/if \(video\.draft\.state\.phase !== 'empty'\) \{\s*setNote\(VIDEO_HELD_TEXT\)\s*onSharedDone\(shared\.id\)\s*return\s*\}/.test(effect), 'a draft that already has a video keeps it and says so')
  t.ok(/const id = shared\.id\s*onSharedLoaded\(id\)\s*video\.draft\.pick\(\{\s*pickVideo: async \(\) => sharedVideo,\s*prepareVideo,/.test(effect), 'the shell lets go before the same preparation as the gallery')
  t.ok(/video\.draft\.pick\(\{[\s\S]{0,300}?\}\)\.catch\(\(err\) => \{\s*if \(mountedRef\.current\) setNote\(err\.message\)\s*\}\)\.finally\(\(\) => freeRef\.current\(id\)\)/.test(effect), 'its file is freed however the preparation ends, even unmounted')
})

test('Publicar keeps the plain post text across a web share reload, for the same account', (t) => {
  const src = read('src/screens/Publicar.js')
  t.ok(src.includes("import { dropDraft, takeDraft, watchDraft } from '../draftKeep'"))
  t.ok(src.includes("keptTextRef.current = !replyProp && !quote && asPage === null ? text : ''"), 'never a reply, a quote or a page post')
  t.ok(/const kept = takeDraft\(keepOwner\)/.test(src), 'read for this account only')
  t.ok(/return \(\) => \{\s*stop\(\)\s*dropDraft\(\)\s*\}\s*\}, \[keepOwner\]\)/.test(src), 'a lock or an account change drops it')
  t.ok(src.indexOf('const kept = takeDraft(keepOwner)') < src.indexOf('const merged = mergeDraft(current, shared.text, MAX_TEXT)'), 'restored before a share in the same commit merges into it')
  t.ok(/const current = textRef\.current\s*const merged = mergeDraft\(current, shared\.text, MAX_TEXT\)/.test(src), 'the share merges into the restored text')
})

test('the hook tells once, when the app is ready, that a web share did not fit', (t) => {
  const hook = read('src/useSharedIntent.js')
  t.ok(/if \(shareIntake\.takeLost\(\)\) lostRef\.current = true/.test(hook), 'the marker is read on mount')
  t.ok(/if \(gone === true\) \{\s*lostRef\.current = false\s*return\s*\}\s*if \(ready !== true \|\| locked === true\) return\s*lostRef\.current = false\s*latest\.current\.onToast\(LOST_TEXT\)\s*\}, \[ready, locked, gone\]\)/.test(hook), 'the toast waits for an unlocked, ready app, and never reaches the next account')
})
