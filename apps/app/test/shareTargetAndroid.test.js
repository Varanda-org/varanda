'use strict'

// The Android share target (modules/share-intake/android): which shares the
// receiver accepts, that MainActivity stays out of it, and the guards in the
// Kotlin that no JS test can run. The files are read as text.
const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')

const root = path.join(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const uncommented = (xml) => xml.replace(/<!--[\s\S]*?-->/g, '')

const MODULE = 'modules/share-intake/android'
const MODULE_MANIFEST = MODULE + '/src/main/AndroidManifest.xml'
const APP_MANIFEST = 'android/app/src/main/AndroidManifest.xml'
const KOTLIN = MODULE + '/src/main/java/app/varanda/shareintake/'
const KOTLIN_FILES = ['ShareReceiverActivity.kt', 'ShareInbox.kt', 'ShareIntakeModule.kt'].map((name) => KOTLIN + name)

const attrs = (xml, name) => [...xml.matchAll(new RegExp('android:' + name + '="([^"]*)"', 'g'))].map((m) => m[1])

function activities (xml) {
  return [...uncommented(xml).matchAll(/<activity\b([^>]*)>([\s\S]*?)<\/activity>/g)]
    .map((m) => ({ head: m[1], body: m[2] }))
}

function filters (body) {
  return [...body.matchAll(/<intent-filter\b[^>]*>([\s\S]*?)<\/intent-filter>/g)].map((m) => ({
    actions: attrs(m[1].match(/<action\b[^>]*>/g).join(' '), 'name'),
    categories: attrs((m[1].match(/<category\b[^>]*>/g) || []).join(' '), 'name'),
    mimeTypes: attrs((m[1].match(/<data\b[^>]*>/g) || []).join(' '), 'mimeType')
  }))
}

test('the receiver activity is exported, off the recents and out of other tasks', (t) => {
  const list = activities(read(MODULE_MANIFEST))
  t.is(list.length, 1, 'one activity')
  const head = list[0].head
  t.alike(attrs(head, 'name'), ['app.varanda.shareintake.ShareReceiverActivity'])
  t.alike(attrs(head, 'exported'), ['true'])
  t.alike(attrs(head, 'excludeFromRecents'), ['true'])
  t.alike(attrs(head, 'noHistory'), ['true'])
  t.alike(attrs(head, 'taskAffinity'), [''])
  t.alike(attrs(head, 'theme'), ['@android:style/Theme.Translucent.NoTitleBar'])
  // The copy opens each Uri as Varanda: the sender must be able to read it.
  t.alike(attrs(head, 'requireContentUriPermissionFromCaller'), ['read'])
})

// A recreated receiver cancels the copy in progress, so a rotation, a theme
// switch or a font change must not recreate it.
test('the receiver handles its own configuration changes', (t) => {
  const head = activities(read(MODULE_MANIFEST))[0].head
  const values = attrs(head, 'configChanges')
  t.is(values.length, 1, 'one configChanges attribute')
  t.alike((values[0] || '').split('|').sort(), [
    'density', 'fontScale', 'keyboard', 'keyboardHidden', 'layoutDirection', 'locale',
    'navigation', 'orientation', 'screenLayout', 'screenSize', 'smallestScreenSize', 'uiMode'
  ])
})

test('the receiver takes exactly SEND image/*, SEND text/plain and SEND_MULTIPLE image/*', (t) => {
  const found = filters(activities(read(MODULE_MANIFEST))[0].body)
  t.is(found.length, 3, 'three intent filters')
  for (const f of found) {
    t.alike(f.categories, ['android.intent.category.DEFAULT'], 'each filter has DEFAULT')
    t.is(f.actions.length, 1, 'one action per filter')
    t.is(f.mimeTypes.length, 1, 'one mime type per filter')
  }
  const pairs = found.map((f) => f.actions[0] + ' ' + f.mimeTypes[0]).sort()
  t.alike(pairs, [
    'android.intent.action.SEND image/*',
    'android.intent.action.SEND text/plain',
    'android.intent.action.SEND_MULTIPLE image/*'
  ])
})

test('the module manifest offers no video, audio, any type or uri list, and asks no permission', (t) => {
  const xml = uncommented(read(MODULE_MANIFEST))
  const mimeTypes = attrs(xml, 'mimeType')
  t.ok(mimeTypes.length > 0)
  for (const mime of mimeTypes) {
    t.absent(mime.startsWith('video/'), mime)
    t.absent(mime.startsWith('audio/'), mime)
    t.absent(mime.startsWith('*'), mime)
    t.absent(mime === 'text/uri-list', mime)
  }
  for (const banned of ['video/', 'audio/', '*/*', 'uri-list', '<uses-permission', '<provider']) {
    t.absent(xml.includes(banned), banned)
  }
})

test('MainActivity still has no SEND action', (t) => {
  const xml = uncommented(read(APP_MANIFEST))
  t.absent(xml.includes('android.intent.action.SEND'), 'SEND and SEND_MULTIPLE stay on the module receiver')
})

test('the module build.gradle adds no dependency', (t) => {
  const gradle = read(MODULE + '/build.gradle')
  t.ok(gradle.includes('namespace "app.varanda.shareintake"'))
  t.absent(/\bdependencies\s*\{/.test(gradle))
})

test('the Kotlin never logs', (t) => {
  for (const file of KOTLIN_FILES) {
    const source = read(file)
    t.absent(/\bLog\./.test(source), file + ' has no Log. call')
    t.absent(source.includes('android.util.Log'), file + ' does not import Log')
    t.absent(/\bprintln\(|printStackTrace\(/.test(source), file + ' prints nothing')
  }
})

// Removing any of these turns the receiver into a way for another app to read
// Varanda's own files or to fill the cache.
test('the inbox keeps its guards', (t) => {
  const inbox = read(KOTLIN + 'ShareInbox.kt')
  t.ok(inbox.includes('const val MAX_FILES = 10'))
  t.ok(inbox.includes('const val MAX_BYTES = 50L * 1024 * 1024'))
  t.ok(inbox.includes('const val MAX_TEXT = 4000'))
  t.ok(inbox.includes('if (uri.scheme != "content") return null'), 'content Uris only')
  t.ok(inbox.includes('if (isOwnProvider(context, uri)) return null'), 'never Varanda\'s own providers')
  t.ok(inbox.includes('resolveContentProvider(bare, 0)'))
  t.ok(inbox.includes('info.packageName == context.packageName'))
  t.ok(inbox.includes('SecureRandom'))
  t.ok(/if \(extra is List<\*>\) \{[\s\S]*?if \(extra\.any \{ it !is Uri \}\) return emptyList\(\)\s*for \(item in extra\) found\.add\(item as Uri\)/.test(inbox), 'a stream list with anything but Uris is refused whole, never read past the system check')
  const activity = read(KOTLIN + 'ShareReceiverActivity.kt')
  t.ok(activity.includes('getLaunchIntentForPackage(packageName)'), 'Varanda opens through its plain launcher intent')
  t.absent(/\bsetIntent\(|putExtra\(|setData\(|\.data\s*=/.test(activity), 'the launch intent carries nothing shared')
})

// A sender that stops writing must not hold the copy forever, a finished
// share must not be lost or offered twice, and nothing unrotated or unsynced
// may be named by a manifest.
test('the capture stalls, cancels, syncs and releases safely', (t) => {
  const inbox = read(KOTLIN + 'ShareInbox.kt')
  t.ok(inbox.includes('const val STALL_MS = 30_000L'), 'a file stalls after 30 s without a byte')
  t.ok(inbox.includes('openAssetFileDescriptor(uri, "r", attempt.signal)'), 'the open is cancellable and the read holds a descriptor that can be closed')
  t.ok(inbox.includes('guard.attach(attempt, afd.parcelFileDescriptor)') && inbox.includes('afd.createInputStream()'), 'an image served from inside a larger file is read as its own slice')
  t.absent(/\.openFileDescriptor\(/.test(inbox), 'openFileDescriptor refuses asset-backed images')
  t.ok(/fun cancel\(\) \{\s*lock\.withLock \{\s*stopped = true\s*current\?\.let \{ abandon\(it\) \}/.test(inbox), 'cancel abandons the file in progress')
  t.ok(/private fun abandon\(attempt: Attempt\) \{\s*attempt\.abandoned = true[\s\S]*?signal\.cancel\(\)[\s\S]*?pfd\.close\(\)/.test(inbox), 'abandon cancels the open and closes the descriptor')
  t.ok(inbox.includes('if (++zeros >= MAX_ZERO_READS) throw Stalled()'), 'repeated empty reads are a stall')

  // A provider can block in openFile and ignore the signal: only a thread per
  // file, left behind on a stall, lets the rest of the share go on.
  t.ok(/"varanda-share-file"\)\s*thread\.isDaemon = true\s*try \{\s*thread\.start\(\)\s*\} catch \(e: Throwable\) \{\s*live\.decrementAndGet\(\)/.test(inbox), 'each file is opened and copied on its own daemon thread, and a thread that never started is not counted')
  // Abandoned threads are never joined: without a cap across the process, a
  // sender that keeps sharing from a stuck provider piles them up.
  t.ok(inbox.includes('private const val MAX_LIVE = 16'), 'at most 16 file threads alive in the process')
  t.ok(/if \(live\.incrementAndGet\(\) > MAX_LIVE\) \{\s*live\.decrementAndGet\(\)\s*return false\s*\}\s*val thread = Thread/.test(inbox), 'past the cap the file is skipped before a thread starts')
  t.ok(/Thread\(\{\s*try \{\s*settle\(attempt, work\)\s*\} finally \{\s*live\.decrementAndGet\(\)/.test(inbox), 'a file thread leaves the count only when its work returns')
  t.ok(/fetch\(context, uri, attempt, guard\)[\s\S]*?private fun fetch\([^)]*\): Boolean \{[\s\S]*?val afd = context\.contentResolver\.openAssetFileDescriptor/.test(inbox), 'the open runs inside the file thread\'s work')
  t.ok(inbox.includes('SystemClock.elapsedRealtime() - attempt.last <= STALL_MS'), 'the capture waits only while the file makes progress')
  t.ok(/finally \{\s*lock\.withLock \{[^}]*if \(!attempt\.finished\) abandon\(attempt\)/.test(inbox), 'a file thread that did not finish is abandoned, not joined')
  t.absent(/\.join\(/.test(inbox), 'no file thread is ever joined')
  t.ok(/if \(!guard\.copy\(part\)[^\n]*\n\s*part\.delete\(\)\s*return null/.test(inbox), 'a stalled file counts as not kept')
  t.ok(inbox.includes('val part = File(dir, i.toString() + PART)'), 'a later file never reuses an abandoned thread\'s part name')
  t.ok(/val handed = lock\.withLock \{\s*if \(attempt\.abandoned\) \{\s*false\s*\} else \{\s*attempt\.kept = kept\s*attempt\.finished = true/.test(inbox), 'a file thread hands over its part only if it still owns the attempt, under the lock')
  t.ok(/if \(!handed\) attempt\.part\.delete\(\)/.test(inbox), 'an abandoned file thread deletes its own part')
  t.ok(/return lock\.withLock \{\s*try \{\s*if \(attempt\.abandoned\) throw Stalled\(\)\s*val sink = FileOutputStream\(attempt\.part\)/.test(inbox), 'an abandoned file thread creates nothing in the share')
  t.ok(/catch \(e: Exception\) \{\s*quietly \{ pfd\.close\(\) \}\s*throw e/.test(inbox), 'a late open on an abandoned attempt closes its descriptor')
  t.ok(/fun progress\(attempt: Attempt\) \{\s*lock\.withLock \{\s*if \(attempt\.abandoned\) throw Stalled\(\)/.test(inbox), 'an abandoned file thread stops copying')
  t.absent(/private fun fetch[\s\S]*?\n {2}\}\n/.exec(inbox)[0].includes('renameTo'), 'only the capture thread renames a part into place')
  t.ok(/sink\.write\(buf, 0, read\)\s*\}[\s\S]{0,200}sink\.fd\.sync\(\)/.test(inbox), 'each image is synced before the manifest names it')
  t.ok(inbox.includes('if (carriesExif(mime)) null else false'), 'unreadable EXIF in a format that has it is refused')
  t.ok(/null -> \{\s*target\.delete\(\)\s*null/.test(inbox), 'a refused orientation keeps no file')
  t.ok(inbox.includes('private const val GONE = ".gone"'))
  t.ok(/fun release\(context: Context, id: String\) \{\s*if \(!isId\(id\)\) return\s*drop\(/.test(inbox), 'release goes through the tombstone')
  t.ok(/if \(dir\.renameTo\(tomb\)\) \{\s*tomb\.deleteRecursively\(\)\s*\} else \{\s*File\(dir, MANIFEST\)\.delete\(\)/.test(inbox), 'a release that cannot rename drops the manifest first')
  t.ok(inbox.includes('if (name.endsWith(GONE) || !isId(name) ||'), 'sweep drops tombstones whatever their age')
  t.absent(/\.gone/.test(inbox.match(/private val ID = Regex\("([^"]*)"\)/)[1]), 'a tombstone never matches the id pattern')

  const activity = read(KOTLIN + 'ShareReceiverActivity.kt')
  t.ok(/override fun onDestroy\(\) \{\s*guard\.cancel\(\)/.test(activity), 'leaving closes the descriptor being read')
  t.ok(/"varanda-share-capture"\)\s*worker\.isDaemon = true/.test(activity), 'the copy runs on a named daemon thread')
  t.absent(activity.includes('Executors'), 'no executor thread outlives the activity')
  t.ok(activity.includes('if (guard.cancelled || isDestroyed || isFinishing) return'), 'a gone receiver keeps a stored share and shows nothing')
  t.absent(activity.includes('ShareInbox.release'), 'the receiver never drops a share it stored')
})

test('the new text has no em dash', (t) => {
  for (const file of [MODULE_MANIFEST, MODULE + '/build.gradle', ...KOTLIN_FILES, 'test/shareTargetAndroid.test.js']) {
    t.absent(read(file).includes('\u2014'), file)
  }
})
