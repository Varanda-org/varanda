// Module hooks for test/workletId.test.js: src/client/native.js with the
// native modules and the generated worklet bundle replaced by stubs (and
// @varanda/rpc re-exported by name, see stub-rpc.mjs). expo-video is stubbed
// too (stub-video.mjs), so a module that imports it loads in Node, and so is
// modules/video-prep, as a device without it (src/media/videoPrep.native.js).
const videoPrep = `
export function isAvailable () { return false }
export async function prepare () { const err = new Error('unsupported'); err.code = 'UNSUPPORTED'; throw err }
`
const stubs = {
  'react-native-bare-kit': './stub-bare-kit.mjs',
  'expo-file-system': './stub-file-system.mjs',
  'expo-video': './stub-video.mjs',
  '@varanda/rpc': './stub-rpc.mjs',
  '../../modules/video-prep': 'data:text/javascript,' + encodeURIComponent(videoPrep)
}

export async function resolve (specifier, context, next) {
  if (stubs[specifier]) return { url: new URL(stubs[specifier], import.meta.url).href, shortCircuit: true }
  if (specifier.endsWith('assets/worklet/main.bundle.js')) return { url: new URL('./stub-bundle.mjs', import.meta.url).href, shortCircuit: true }
  return next(specifier, context)
}
