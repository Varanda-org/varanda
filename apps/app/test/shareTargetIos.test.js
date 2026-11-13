'use strict'

// The iOS side of the share target (modules/share-intake/ios): the module
// config and podspec that link it, and the guards in the Swift that no JS test
// can run. The files are read as text.
const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')

const root = path.join(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

const MODULE = 'modules/share-intake/'
const SWIFT = MODULE + 'ios/ShareIntakeModule.swift'
const PODSPEC = MODULE + 'ios/ShareIntake.podspec'
const CONFIG = MODULE + 'expo-module.config.json'

// The pins below look for code, so whole line comments are dropped first
// ("file://" inside a string must stay).
const swift = () => read(SWIFT).replace(/^[ \t]*\/\/[^\n]*$/gm, '')

// The brace-balanced body of the first declaration that starts with `head`.
function body (source, head) {
  const at = source.indexOf(head)
  if (at === -1) return ''
  const open = source.indexOf('{', at)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1)
  }
  return ''
}

function ordered (t, text, needles, message) {
  const found = needles.map((needle) => text.indexOf(needle))
  t.ok(found.every((i) => i !== -1), message + ': every step present')
  t.ok(found.every((i, n) => n === 0 || i > found[n - 1]), message + ': in order')
}

test('the module config links the Swift module and keeps the Android one', (t) => {
  t.alike(JSON.parse(read(CONFIG)), {
    platforms: ['apple', 'android'],
    apple: { modules: ['ShareIntakeModule'] },
    android: { modules: ['app.varanda.shareintake.ShareIntakeModule'] }
  })
})

test('the podspec is ShareIntake for iOS 18, static, on ExpoModulesCore', (t) => {
  const spec = read(PODSPEC)
  t.ok(/s\.name\s*=\s*'ShareIntake'/.test(spec), 'name')
  t.ok(/:ios\s*=>\s*'18\.0'/.test(spec), 'iOS 18.0')
  t.ok(/s\.static_framework\s*=\s*true/.test(spec), 'static framework')
  t.ok(/s\.dependency\s+'ExpoModulesCore'/.test(spec), 'ExpoModulesCore')
})

test('the module is ShareIntake with peek, release and sweep, and the app group is pinned', (t) => {
  const src = swift()
  t.ok(src.includes('Name("ShareIntake")'))
  t.ok(src.includes('Events("onPending")'))
  for (const name of ['peek', 'release', 'sweep']) t.ok(src.includes('AsyncFunction("' + name + '")'), name)
  t.ok(src.includes('static let appGroup = "group.app.varanda"'), 'app group literal')
  t.ok(src.includes('containerURL(forSecurityApplicationGroupIdentifier: appGroup)'), 'container from the app group')
})

test('nothing is logged', (t) => {
  const src = swift()
  t.absent(/\b(print|NSLog|debugPrint|os_log)\s*\(/.test(src))
  t.absent(/\bLogger\b|\blog\.(info|warn|error|debug)\b/.test(src))
})

test('the import copies into <id>.tmp, writes its manifest, renames, and only then drops the inbox entry', (t) => {
  const src = swift()
  t.ok(src.includes('private static let tmpSuffix = ".tmp"'), 'tmp suffix')
  const run = body(src, 'func importEntry(')
  ordered(t, run, [
    'if isFile(target.appendingPathComponent(manifestName))',
    'let tmp = root.appendingPathComponent(id + tmpSuffix, isDirectory: true)',
    'remove(tmp)',
    'try fm.createDirectory(at: tmp',
    'admit(',
    'try writeManifest(share, in: tmp)',
    'try fm.moveItem(at: tmp, to: target)'
  ], 'transaction')
  const rename = run.indexOf('try fm.moveItem(at: tmp, to: target)')
  t.ok(run.lastIndexOf('dropInbox(entry)') > rename, 'the inbox entry goes after the rename')
  // Between the first write and the rename the inbox entry is only dropped
  // when there is nothing to import, and then the .tmp goes with it.
  const copying = run.slice(run.indexOf('try fm.createDirectory(at: tmp'), rename)
  const empty = body(copying, 'if manifest.title.isEmpty')
  t.ok(empty.includes('remove(tmp)') && empty.includes('return'), 'an empty share leaves no .tmp')
  t.absent(copying.replace(empty, '').includes('dropInbox'), 'no inbox drop before the rename')
  const failure = body(run.slice(run.indexOf('} catch')), '} catch')
  t.ok(failure.includes('remove(tmp)'), 'a failed import removes its .tmp')
  t.absent(failure.includes('dropInbox'), 'a failed import keeps the inbox entry')
})

test('the stored manifest is written last through a temporary file and a rename', (t) => {
  const src = swift()
  t.ok(src.includes('private static let manifestTmp = "manifest.json.tmp"'))
  const write = body(src, 'func writeManifest(')
  ordered(t, write, [
    'let tmp = dir.appendingPathComponent(manifestTmp',
    'try data.write(to: tmp)',
    'try fm.moveItem(at: tmp, to: dir.appendingPathComponent(manifestName'
  ], 'manifest')
})

test('inbox files are copied, never moved', (t) => {
  const src = swift()
  const admit = body(src, 'func admit(')
  t.ok(admit.includes('try fm.copyItem(at: source, to: part)'), 'copy from the inbox')
  for (const match of src.matchAll(/\bmoveItem\(at:\s*([A-Za-z]+)/g)) {
    t.ok(['tmp', 'part', 'dir'].includes(match[1]), 'moveItem only on app cache paths, not ' + match[1])
  }
})

test('a failed copy keeps the inbox entry for the next peek', (t) => {
  const src = swift()
  t.ok(src.includes('func admit(_ source: URL, into dir: URL, index: Int) throws -> StoredFile?'), 'admit throws')
  const admit = body(src, 'func admit(')
  t.is((admit.match(/throw error/g) || []).length, 2, 'a failed copy or rename throws')
  t.ok(body(src, 'func importEntry(').includes('try admit('), 'the import hands the failure to its catch')
})

test('a manifest that cannot be read keeps the inbox for the next peek', (t) => {
  const src = swift()
  const run = body(src, 'func importNewest(')
  const failed = run.indexOf('if readFailed(entry.appendingPathComponent(manifestName)) { return }')
  t.ok(failed > 0 && failed < run.lastIndexOf('dropInbox(entry)'), 'a read failure returns before any drop')
  const read = body(src, 'func readFailed(')
  t.ok(read.includes('size > maxManifestBytes { return false }'), 'an oversized manifest is bad, not unreadable')
})

test('stored file names are digits plus one of six extensions', (t) => {
  const src = swift()
  const admit = body(src, 'func admit(')
  t.ok(admit.includes('let name = String(index) + "." + fileExtension(image.mime)'), 'name from index and mime')
  const ext = body(src, 'func fileExtension(')
  const returned = [...ext.matchAll(/return "([^"]*)"/g)].map((m) => m[1]).sort()
  t.alike(returned, ['gif', 'heic', 'img', 'jpg', 'png', 'webp'])
  t.ok(src.includes('"^[0-9]{1,2}\\\\.(jpg|png|gif|webp|heic|img)$"'), 'read side checks the same shape')
  t.ok(/stored\.count\)/.test(body(src, 'func importEntry(')), 'index is the place among stored files')
  t.ok(src.includes('static let maxFiles = 10'))
})

test('uris are built from the plain path, never a percent encoded one', (t) => {
  const src = swift()
  t.ok(src.includes('"uri": "file://" + fileURL.path,'))
  t.absent(src.includes('absoluteString'))
})

test('only the formats Android decodes are admitted, sized by the primary image', (t) => {
  const src = swift()
  t.ok(src.includes('static let allowedTypes: [UTType] = [UTType.jpeg, .png, .gif, .webP, .heic, .heif]\n    + [UTType("public.avif")].compactMap { $0 }'), 'JPEG, PNG, GIF, WebP, HEIC, HEIF and AVIF')
  const probe = body(src, 'func probe(')
  t.ok(probe.includes('allowedTypes.contains(where: { type.conforms(to: $0) }),'), 'the probe checks that list')
  t.absent(probe.includes('conforms(to: .image)'), 'not any image type')
  t.ok(probe.includes('CGImageSourceCopyPropertiesAtIndex(source, CGImageSourceGetPrimaryImageIndex(source), options)'), 'the primary image is the one sized')
  const listed = probe.indexOf('allowedTypes.contains(')
  t.ok(listed > 0 && listed < probe.indexOf('CGImageSourceGetCount(source) > 0'), 'the type is checked before any reader parses the file')
})

test('a shared image has to fit the composer limit and a pixel budget', (t) => {
  const src = swift()
  const side = /MAX_MEDIA_DIMENSION = (\d+)/.exec(read('src/media/plan.js'))
  t.ok(side && src.includes('static let maxSide = ' + side[1]), 'sides up to MAX_MEDIA_DIMENSION')
  t.ok(src.includes('static let maxPixels = 100_000_000'), '100 megapixels')
  t.ok(body(src, 'func probe(').includes('width <= maxSide, height <= maxSide, width * height <= maxPixels else { return nil }'), 'the probe refuses past either')
})

test('the copy is checked as a regular file before it is probed', (t) => {
  const admit = body(swift(), 'func admit(')
  const copied = admit.indexOf('copiedAttrs[.type] as? FileAttributeType == .typeRegular,')
  t.ok(copied > admit.indexOf('try fm.copyItem(at: source, to: part)'), 'after the copy')
  t.ok(copied < admit.indexOf('let image = probe(part)'), 'before the probe')
})

test('the varanda-share directory is excluded from backup', (t) => {
  const appRoot = body(swift(), 'func appRoot(')
  t.ok(appRoot.includes('values.isExcludedFromBackup = true'))
  t.ok(appRoot.includes('root.setResourceValues(values)'))
})
