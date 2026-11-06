// Web: reads the bytes of the voice note a report carries (src/report.js
// prepareAnexo). The source is the blob: URL the chat already plays
// (media/chatMedia.js), so the fetch is a local read: anything else is
// refused before any request. -> Uint8Array; throws when it cannot be read.

export async function readReportAudio (uri) {
  if (typeof uri !== 'string' || !uri.startsWith('blob:')) throw new Error('áudio indisponível')
  const res = await globalThis.fetch(uri)
  if (!res || res.ok === false) throw new Error('áudio indisponível')
  return new Uint8Array(await res.arrayBuffer())
}
