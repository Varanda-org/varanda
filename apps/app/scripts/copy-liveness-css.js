'use strict'

// Copies the face liveness stylesheet to <dir>/liveness/amplify-ui.css (see
// src/livenessDetector.web.js). finish-web.js calls it on dist for the
// export; `npm run web` runs it on public, which the dev server serves but
// never copies into dist by itself.
// Usage: node scripts/copy-liveness-css.js <dir> -> exit 0/1.
// Running it twice yields the same byte-identical file.

const fs = require('fs')
const path = require('path')

const LIVENESS_CSS = '@aws-amplify/ui-react-liveness/styles.css'
const LIVENESS_TARGET = path.join('liveness', 'amplify-ui.css')

// Resolved from apps/app, where the detector imports the package from.
function livenessSource () {
  try {
    return require.resolve(LIVENESS_CSS, { paths: [path.join(__dirname, '..')] })
  } catch {
    return null
  }
}

// Served same origin (style-src 'self') and precached with the rest, instead
// of being bundled into the global stylesheet every page loads.
function copyLivenessCss (dir, source = livenessSource()) {
  if (!source || !fs.existsSync(source)) {
    throw new Error('falta o estilo da verificação de rosto: ' + (source || LIVENESS_CSS) + ' (rode npm ci)')
  }
  const target = path.join(dir, LIVENESS_TARGET)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(source, target)
  return target
}

function main () {
  if (!process.argv[2]) {
    console.error('uso: node scripts/copy-liveness-css.js <pasta>')
    process.exit(1)
  }
  try {
    copyLivenessCss(path.resolve(process.argv[2]))
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
}

if (require.main === module) main()

module.exports = { LIVENESS_TARGET, livenessSource, copyLivenessCss }
