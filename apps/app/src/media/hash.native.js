// SHA-256 of photo bytes through the platform's native digest (expo-crypto),
// shaped like WebCrypto's subtle so ./fetch.js's digestHex takes it as is.
// Hermes has no WebCrypto, and @noble/hashes in JS costs tens of ms per
// photo on the UI thread. If the native module is missing or throws at load,
// nativeSubtle stays undefined and fetch.js keeps its noble fallback.

let nativeSubtle
try {
  const { digest, CryptoDigestAlgorithm } = require('expo-crypto')
  if (typeof digest === 'function' && CryptoDigestAlgorithm && CryptoDigestAlgorithm.SHA256 === 'SHA-256') {
    nativeSubtle = Object.freeze({
      digest (algorithm, bytes) {
        // Only the one hash fetch.js compares with descriptor.sha256.
        if (algorithm !== 'SHA-256') return Promise.reject(new Error('algoritmo não suportado'))
        // A view into a larger buffer would hash bytes outside it natively.
        const exact = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice()
        return digest(CryptoDigestAlgorithm.SHA256, exact)
      }
    })
  }
} catch {
  nativeSubtle = undefined
}

export { nativeSubtle }
