'use strict'

const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')

const root = path.join(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const MODULE = 'modules/push-device/android'
const KOTLIN = MODULE + '/src/main/java/app/varanda/pushdevice/'
const gradle = read(MODULE + '/build.gradle')
const manifest = read(MODULE + '/src/main/AndroidManifest.xml')
const moduleSource = read(KOTLIN + 'PushDeviceModule.kt')
const service = read(KOTLIN + 'PushDeviceService.kt')
const fields = ['FIREBASE_API_KEY', 'FIREBASE_APPLICATION_ID', 'FIREBASE_PROJECT_ID', 'FIREBASE_GCM_SENDER_ID']

function gradleFiles (dir) {
  const skipped = new Set(['node_modules', 'build', 'dist', '.git', '.gradle', '.expo', '.cxx', 'Pods'])
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (skipped.has(entry.name)) return []
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) return gradleFiles(file)
    return entry.isFile() && /\.gradle(?:\.kts)?$/.test(entry.name) ? [file] : []
  })
}

test('Android push uses only the exact supported Firebase messaging client', (t) => {
  const dependencies = [...gradle.matchAll(/\bimplementation\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
  t.alike(dependencies, ['com.google.firebase:firebase-messaging:26.0.1'])
  t.absent(dependencies.some((dependency) => /[+^~[\]()]/.test(dependency)), 'no version range')
  t.ok(gradle.includes("id 'com.android.library'"))
  t.ok(gradle.includes("id 'expo-module-gradle-plugin'"))
  t.ok(gradle.includes('namespace "app.varanda.pushdevice"'))
  const files = gradleFiles(root)
  t.ok(files.length > 0)
  for (const file of files) {
    t.absent(fs.readFileSync(file, 'utf8').includes('com.google.gms.google-services'), path.relative(root, file))
  }
})

test('Firebase stays out of the hand-maintained app Gradle and manifest', (t) => {
  for (const file of ['android/app/build.gradle', 'android/app/src/main/AndroidManifest.xml']) {
    t.absent(/firebase|google-services/i.test(read(file)), file)
  }
})

test('Firebase config comes from an operator file and is excluded from git and EAS uploads', (t) => {
  t.ok(gradle.includes("System.getenv('VARANDA_GOOGLE_SERVICES_JSON')"))
  t.ok(gradle.includes("configPath ? file(configPath) : new File(projectDir, '../../../android/app/google-services.json')"))
  t.ok(gradle.includes('new JsonSlurper().parse(configFile)'))
  t.ok(/try\s*\{\s*if \(configFile.isFile\(\)\)[\s\S]*?catch \(Exception ignored\)/.test(gradle), 'missing or unparsable config does not fail the build')
  for (const [file, pattern] of [['.gitignore', 'google-services.json'], ['../../.easignore', '**/google-services.json']]) {
    const source = read(file)
    t.ok(source.split('\n').includes(pattern), file)
    t.ok(source.includes('EAS file secret through VARANDA_GOOGLE_SERVICES_JSON'), file + ' explains the operator input')
  }
  const eas = read('../../.easignore')
  t.ok(eas.indexOf('**/google-services.json') > eas.indexOf('# secrets and signing material'))
})

test('BuildConfig selects the matching package and preserves the unconfigured fallback', (t) => {
  t.ok(/buildFeatures\s*\{\s*buildConfig true\s*\}/.test(gradle))
  t.ok(gradle.includes('androidComponents.finalizeDsl'))
  t.ok(gradle.includes("rootProject.findProject(':app')?.extensions?.findByName('android')"))
  t.ok(gradle.includes('appAndroid?.defaultConfig?.applicationId'))
  t.ok(gradle.includes('appAndroid.buildTypes.findByName(buildType.name)?.applicationIdSuffix'))
  t.ok(/applicationId \? clients\?\.find\s*\{\s*it.client_info\?\.android_client_info\?\.package_name == applicationId\s*\} : clients\?\.find\(\)/.test(gradle), 'first client only when the package is unknown')
  for (const field of fields) t.ok(gradle.includes(field + ": ''"), field + ' defaults empty')
  for (const key of ['current_key', 'mobilesdk_app_id', 'project_id', 'project_number']) t.ok(gradle.includes(key), key)
  t.ok(gradle.includes("fields.replaceAll { key, value -> '' }"), 'malformed config resets every field')
  t.ok(gradle.includes("buildType.buildConfigField 'String', name, JsonOutput.toJson(value.toString())"), 'values are escaped as string literals')
  for (const field of fields) t.ok(moduleSource.includes('BuildConfig.' + field + '.isNotEmpty()'), field + ' required at runtime')
  t.ok(moduleSource.includes('Function("transport") { if (configured()) "fcm" else null }'))
  t.ok(/private fun getToken\(promise: Promise\)\s*\{\s*if \(!configured\(\)\)\s*\{\s*promise.resolve\(null\)\s*return/.test(moduleSource))
  t.ok(/initializeFirebase\(context: Context\): Boolean\s*\{\s*if \(!configured\(\)\) return false/.test(moduleSource))
  t.ok(moduleSource.includes('FirebaseApp.getApps(context).none { it.name == FirebaseApp.DEFAULT_APP_NAME }'))
  for (const setter of ['setApiKey', 'setApplicationId', 'setProjectId', 'setGcmSenderId']) t.ok(moduleSource.includes('.' + setter + '(BuildConfig.'), setter)
})

test('the private FCM service disables auto-init and analytics and declares notification defaults', (t) => {
  t.ok(manifest.includes('<uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>'))
  const services = [...manifest.matchAll(/<service\b([^>]*)>([\s\S]*?)<\/service>/g)]
  t.is(services.length, 1)
  t.ok(services[0][1].includes('android:name="app.varanda.pushdevice.PushDeviceService"'))
  t.ok(services[0][1].includes('android:exported="false"'))
  t.ok(services[0][2].includes('android:name="com.google.firebase.MESSAGING_EVENT"'))
  for (const flag of ['firebase_messaging_auto_init_enabled', 'firebase_analytics_collection_enabled']) {
    t.ok(manifest.includes('android:name="' + flag + '" android:value="false"'), flag)
  }
  t.ok(manifest.includes('android:name="com.google.firebase.messaging.default_notification_icon" android:resource="@drawable/ic_notification"'))
  t.ok(manifest.includes('android:name="com.google.firebase.messaging.default_notification_channel_id" android:value="conversas"'))
  t.absent(/(?:setAutoInitEnabled|setAnalyticsCollectionEnabled)\(true\)|isAutoInitEnabled\s*=\s*true/.test(moduleSource + service))
})

test('notification permissions use Expo on Android 13 and notification settings on Android 12', (t) => {
  t.ok(moduleSource.includes('NotificationManagerCompat.from(context).areNotificationsEnabled()'))
  t.ok(/Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU\)\s*\{\s*done\(if \(enabled\) "granted" else "denied"\)/.test(moduleSource))
  t.ok(moduleSource.includes('permissions.getPermissions('))
  t.ok(moduleSource.includes('permissions.askForPermissions('))
  t.ok(moduleSource.includes('Manifest.permission.POST_NOTIFICATIONS'))
  t.ok(moduleSource.includes('status != "undetermined" || Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU'))
  t.ok(moduleSource.includes('permissions == null || appContext.currentActivity == null'))
  const permission = moduleSource.slice(moduleSource.indexOf('AsyncFunction("permission")'), moduleSource.indexOf('AsyncFunction("request")'))
  t.absent(permission.includes('askForPermissions'), 'permission never prompts')
  t.ok(permission.includes('.runOnQueue(Queues.MAIN)'))
})

test('token requests require permission and settle once within 20 seconds', (t) => {
  t.ok(moduleSource.includes('status != "granted" || settled.get()'))
  t.ok(moduleSource.includes('FirebaseMessaging.getInstance().token.addOnCompleteListener'))
  t.ok(moduleSource.includes('finish(if (task.isSuccessful) task.result else null)'))
  t.ok(moduleSource.includes('handler.postDelayed(timeout, 20_000L)'))
  t.ok(moduleSource.includes('handler.removeCallbacks(timeout)'))
  t.is((moduleSource.match(/settled.compareAndSet\(false, true\)/g) || []).length, 2, 'timeout and completion share a single settlement guard')
  t.ok(/catch \(e: Exception\)\s*\{\s*finish\(null\)/.test(moduleSource))
})

test('notification taps consume and validate the kind for cold launch and running activity', (t) => {
  t.ok(moduleSource.includes('Name("PushDevice")'))
  t.ok(moduleSource.includes('Events("onToken", "onIntent")'))
  t.ok(moduleSource.includes('consumeIntent(appContext.currentActivity?.intent)'))
  t.ok(/OnNewIntent\s*\{ intent ->\s*consumeIntent\(intent\)\?\.let \{ receiveIntent\(it\) \}/.test(moduleSource))
  t.ok(moduleSource.includes('intent.getStringExtra("k")'))
  t.ok(moduleSource.includes('if (kind in setOf("dm", "dm-page", "group", "group-private")) kind else null'))
  t.ok(/finally\s*\{\s*intent.removeExtra\("k"\)/.test(moduleSource), 'including invalid kinds')
})

test('Android keeps the latest tap pending until it is read or observed', (t) => {
  t.ok(moduleSource.includes('private var pendingIntent: String? = null'))
  t.ok(moduleSource.includes('private var observingIntents = false'))
  t.ok(/OnStartObserving\("onIntent"\)\s*\{\s*Handler\(Looper.getMainLooper\(\)\).post\s*\{\s*observingIntents = true\s*takeIntent\(\)\?\.let \{ emit\("onIntent", mapOf\("kind" to it\)\) \}/.test(moduleSource), 'only intent observers drain the pending tap on the main queue')
  t.ok(/OnStopObserving\("onIntent"\)\s*\{\s*Handler\(Looper.getMainLooper\(\)\).post \{ observingIntents = false \}/.test(moduleSource))
  t.ok(/AsyncFunction\("launchIntent"\)\s*\{\s*takeIntent\(\)\s*\}.runOnQueue\(Queues.MAIN\)/.test(moduleSource))
  t.ok(/private fun takeIntent\(\): String\?\s*\{\s*val launch = consumeIntent\(appContext.currentActivity\?\.intent\)\s*val kind = pendingIntent \?: launch\s*pendingIntent = null\s*return kind/.test(moduleSource), 'read and observer flush clear the same slot and consume the activity extra')
  t.ok(/private fun receiveIntent\(kind: String\)\s*\{\s*if \(observingIntents\)\s*\{\s*emit\("onIntent", mapOf\("kind" to kind\)\)\s*\} else \{\s*pendingIntent = kind\s*\}/.test(moduleSource), 'a tap is either emitted or retained, never both')
})

test('token rotations reach a live module and foreground messages show nothing', (t) => {
  t.ok(service.includes('class PushDeviceService : FirebaseMessagingService()'))
  t.ok(service.includes('PushDeviceModule.initializeFirebase(applicationContext)'), 'background process can initialize before Expo')
  t.ok(/override fun onNewToken\(token: String\)\s*\{\s*PushDeviceModule.onToken\(token\)\s*\}/.test(service))
  t.ok(moduleSource.includes('WeakReference<PushDeviceModule>'))
  t.ok(moduleSource.includes('if (active?.get() === this@PushDeviceModule) active = null'), 'a destroyed runtime cannot clear a newer module')
  t.ok(moduleSource.includes('if (configured()) active?.get()?.emit("onToken", mapOf("token" to token))'))
  const noComments = service.replace(/\/\/[^\n]*/g, '')
  t.ok(/override fun onMessageReceived\(message: RemoteMessage\)\s*\{\s*\}/.test(noComments))
  t.absent(/NotificationCompat|\.notify\(/.test(service))
})

test('the channel is high importance and its status icon is monochrome at 24dp', (t) => {
  t.ok(/OnCreate\s*\{[\s\S]*?createNotificationChannel\(/.test(moduleSource))
  t.ok(moduleSource.includes('NotificationChannel("conversas", "Conversas", NotificationManager.IMPORTANCE_HIGH)'))
  const icon = read('android/app/src/main/res/drawable/ic_notification.xml')
  t.ok(icon.includes('<vector'))
  t.ok(icon.includes('android:width="24dp" android:height="24dp"'))
  t.alike([...new Set([...icon.matchAll(/android:fillColor="([^"]*)"/g)].map((m) => m[1]))], ['#FFFFFFFF'])
})

test('the native module and service never log device tokens', (t) => {
  for (const [name, source] of [['module', moduleSource], ['service', service]]) {
    t.absent(/\bLog\s*\./.test(source), name + ' has no Log call')
    t.absent(source.includes('android.util.Log'), name + ' does not import Log')
    t.absent(/\b(?:print|println|printStackTrace)\s*\(/.test(source), name + ' prints nothing')
    t.absent(source.includes('\u2014'), name + ' has no em dash')
  }
})
