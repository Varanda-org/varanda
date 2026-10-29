// Module hooks for test/workletId.test.js: src/client/native.js with the
// native modules and the generated worklet bundle replaced by stubs (and
// @varanda/rpc re-exported by name, see stub-rpc.mjs).
const stubs = {
  'react-native-bare-kit': './stub-bare-kit.mjs',
  'expo-file-system': './stub-file-system.mjs',
  '@varanda/rpc': './stub-rpc.mjs'
}

export async function resolve (specifier, context, next) {
  if (stubs[specifier]) return { url: new URL(stubs[specifier], import.meta.url).href, shortCircuit: true }
  if (specifier.endsWith('assets/worklet/main.bundle.js')) return { url: new URL('./stub-bundle.mjs', import.meta.url).href, shortCircuit: true }
  return next(specifier, context)
}
