'use strict'

// The hand edits of ios/ and android/ that `expo prebuild` would overwrite,
// as pure text transforms (plugins/with-hardening.js applies them as config
// plugin mods, test/hardening.test.js runs them without Expo). Each one is
// idempotent and throws when the generated file no longer has the text it
// anchors on, so a template change fails the prebuild instead of silently
// dropping a security fix.

const BACKUP_CALL = '    excludeNodeDataFromBackup()\n'

const BACKUP_METHOD = `  // The node's data dir (Documents/varanda, apps/app/src/client/native.js)
  // holds the key material of the member's diary: keep it out of iCloud and
  // device backups. The attribute on the directory covers everything in it.
  private func excludeNodeDataFromBackup() {
    guard let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
    var dir = documents.appendingPathComponent("varanda", isDirectory: true)
    do {
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try dir.setResourceValues(values)
    } catch {
      NSLog("varanda: could not exclude the node data from backup: %@", error.localizedDescription)
    }
  }
`

const RELEASE_SIGNING = `        // Release signing comes only from outside the repository (e.g.
        // ~/.gradle/gradle.properties): the debug keystore above is public, so
        // a release signed with it could be "updated" by anyone. Without these
        // properties a release build fails at signing.
        release {
            if (findProperty('VARANDA_RELEASE_STORE_FILE')) {
                storeFile file(findProperty('VARANDA_RELEASE_STORE_FILE'))
                storePassword findProperty('VARANDA_RELEASE_STORE_PASSWORD')
                keyAlias findProperty('VARANDA_RELEASE_KEY_ALIAS')
                keyPassword findProperty('VARANDA_RELEASE_KEY_PASSWORD')
            }
        }
`

const DEBUG_SUFFIX = `        debug {
            signingConfig signingConfigs.debug
            // A debug build (public key) can never update a release install.
            applicationIdSuffix '.debug'
        }`

const DESUGARING_OPTIONS = `    // The AWS Face Liveness SDK (its Amplify core libraries) needs core
    // library desugaring in the app module.
    compileOptions {
        coreLibraryDesugaringEnabled true
    }
`

const DESUGARING_LIBRARY = '    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")\n\n'

const ARCHITECTURES = 'arm64-v8a,x86_64'
const ARCHITECTURES_COMMENT = [
  'Keep in sync with apps/app/scripts/link-addons.sh: bare-link only produces',
  '.so addons for arm64-v8a and x86_64; adding other ABIs here breaks the node.'
]

const KOTLIN_PLUGIN = '    classpath(\'org.jetbrains.kotlin:kotlin-gradle-plugin\')\n'

const KOTLIN_PLUGIN_PINNED = `    // Pinned to android.kotlinVersion (expoLibs reads it from
    // gradle.properties): without a version the React Native Gradle plugin
    // brings its own older Kotlin, which cannot read the metadata of the
    // face liveness SDK's dependencies.
    classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:\${expoLibs.versions.kotlin.get()}")
`

function replaceOnce (source, anchor, replacement, marker, what) {
  if (source.includes(marker)) return source
  if (!source.includes(anchor)) throw new Error('native-hardening: cannot apply "' + what + '": the generated file changed')
  return source.replace(anchor, () => replacement)
}

function patchAppDelegate (source) {
  const call = '    let delegate = ReactNativeDelegate()\n'
  const linking = '  // Linking API\n'
  source = replaceOnce(source, call, BACKUP_CALL + call, BACKUP_CALL, 'iCloud and backup exclusion call')
  return replaceOnce(source, linking, BACKUP_METHOD + '\n' + linking, 'private func excludeNodeDataFromBackup', 'iCloud and backup exclusion method')
}

function patchBuildGradle (source) {
  const debugKey = "            keyPassword 'android'\n        }\n"
  source = replaceOnce(source, debugKey + '    }\n    buildTypes {', debugKey + RELEASE_SIGNING + '    }\n    buildTypes {', 'VARANDA_RELEASE_STORE_FILE', 'release signing config')
  source = replaceOnce(source, '        debug {\n            signingConfig signingConfigs.debug\n        }', DEBUG_SUFFIX, "applicationIdSuffix '.debug'", 'debug application ID suffix')
  const caution = '            // Caution! In production, you need to generate your own keystore file.\n' +
    '            // see https://reactnative.dev/docs/signed-apk-android.\n' +
    '            signingConfig signingConfigs.debug\n'
  source = replaceOnce(source, caution, '            signingConfig signingConfigs.release\n', 'signingConfig signingConfigs.release', 'release build type signing')
  const compileSdk = '    compileSdk rootProject.ext.compileSdkVersion\n'
  source = replaceOnce(source, compileSdk, compileSdk + DESUGARING_OPTIONS, 'coreLibraryDesugaringEnabled', 'core library desugaring option')
  const hermes = '    if (hermesEnabled.toBoolean()) {\n'
  return replaceOnce(source, hermes, DESUGARING_LIBRARY + hermes, 'desugar_jdk_libs', 'core library desugaring library')
}

// The project-level android/build.gradle.
function patchProjectBuildGradle (source) {
  return replaceOnce(source, KOTLIN_PLUGIN, KOTLIN_PLUGIN_PINNED, 'expoLibs.versions.kotlin', 'Kotlin Gradle plugin version')
}

// `items` is what expo parses gradle.properties into.
function patchGradleProperties (items) {
  const index = items.findIndex(item => item.type === 'property' && item.key === 'reactNativeArchitectures')
  if (index === -1) throw new Error('native-hardening: cannot apply "ABI list": the generated file changed')
  items[index].value = ARCHITECTURES
  const noted = items.some(item => item.type === 'comment' && item.value === ARCHITECTURES_COMMENT[0])
  if (!noted) items.splice(index, 0, ...ARCHITECTURES_COMMENT.map(value => ({ type: 'comment', value })))
  return items
}

module.exports = { patchAppDelegate, patchBuildGradle, patchProjectBuildGradle, patchGradleProperties }
