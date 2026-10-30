// Pure: a GIF's logical screen size from its header (signature, then width
// and height as little-endian 16-bit numbers at bytes 6-9). null when the
// bytes are not a GIF. Shared by the web and native encoders.
export function gifSize (bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 10) return null
  let sig = ''
  for (let i = 0; i < 6; i++) sig += String.fromCharCode(bytes[i])
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return null
  return { width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8) }
}
