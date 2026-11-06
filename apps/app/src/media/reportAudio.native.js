// Native: reads the bytes of the voice note a report carries (src/report.js
// prepareAnexo). The source is the file:// copy the node wrote for the chat
// (media/chatMedia.js); it is read in place and left to the chat's own
// cleanup. -> Uint8Array; throws when it cannot be read.

import { File } from 'expo-file-system'

export async function readReportAudio (uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file://')) throw new Error('áudio indisponível')
  return new File(uri).bytes()
}
