'use strict'

// Fails a store build whose Firebase config would leave push off. .easignore
// keeps google-services.json out of the upload, and the push-device module
// builds with empty Firebase fields when its config file is missing or
// incomplete, so a Play build would otherwise ship without push and nobody
// would notice. The file checked is the one Gradle reads: the one named by
// VARANDA_GOOGLE_SERVICES_JSON, else android/app/google-services.json.
// The checks mirror what modules/push-device/android/build.gradle reads: the
// first client whose package_name is the app's, its api_key[0].current_key and
// mobilesdk_app_id, and project_info.project_id and project_number.
// The file holds a Firebase API key, and the path is the builder's, so only a
// reason token is ever printed: never the content, a value or the path.
// Usage: node scripts/check-firebase-config.js -> one line, exit 0/1.

const fs = require('fs')
const path = require('path')

const FALLBACK_FILE = path.join(__dirname, '..', 'android', 'app', 'google-services.json')

const PACKAGE_NAME = 'app.varanda'

const filled = (value) => typeof value === 'string' && value.trim() !== ''

// Returns null when the config is usable, or a short reason token.
function check (text) {
  let config
  try {
    config = JSON.parse(text)
  } catch {
    return 'invalid-json'
  }
  if (!config || typeof config !== 'object') return 'invalid-json'
  const clients = Array.isArray(config.client) ? config.client : []
  const client = clients.find((c) => c?.client_info?.android_client_info?.package_name === PACKAGE_NAME)
  if (!client) return 'no-client-for-package'
  const apiKey = Array.isArray(client.api_key) ? client.api_key[0] : null
  if (!filled(apiKey?.current_key)) return 'missing-api-key'
  if (!filled(client.client_info.mobilesdk_app_id)) return 'missing-app-id'
  if (!filled(config.project_info?.project_id)) return 'missing-project-id'
  if (!filled(config.project_info?.project_number)) return 'missing-project-number'
  return null
}

function main (env = process.env, fallback = FALLBACK_FILE) {
  // Same choice as modules/push-device/android/build.gradle.
  let file = env.VARANDA_GOOGLE_SERVICES_JSON
  if (!filled(file)) {
    if (!fs.existsSync(fallback)) return 'unset'
    file = fallback
  }
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    // The error message names the path.
    return 'unreadable'
  }
  return check(text)
}

if (require.main === module) {
  const reason = main()
  if (reason) {
    console.error('check-firebase-config: ' + reason)
    process.exitCode = 1
  } else {
    console.log('check-firebase-config: ok')
  }
}

module.exports = { check, main, PACKAGE_NAME }
