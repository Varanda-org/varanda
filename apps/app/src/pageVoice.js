// A page's voice note, prepared as the person's node prepares one
// (web-member session voiceUpload): the recorder's file still carries
// udta and meta, so it is read with metadata tolerated, its ms must be
// within AUDIO_MS_TOLERANCE of the container's, and the stripped copy (what
// the service's strict check accepts) is what gets hashed and uploaded.
import rpc from '@varanda/rpc'

const { AUDIO_MS_TOLERANCE, MAX_AUDIO_MS, audioBounds, stripAudioMetadata } = rpc

// -> { bytes, ms } with the container's ms, or null when the recording is no
// voice note a page may upload.
export function pageVoice ({ bytes, ms } = {}) {
  if (!(bytes instanceof Uint8Array) || !Number.isSafeInteger(ms) || ms < 1 || ms > MAX_AUDIO_MS) return null
  const audio = audioBounds(bytes, { metadata: true })
  if (audio === null || Math.abs(ms - audio.ms) > AUDIO_MS_TOLERANCE) return null
  const copy = stripAudioMetadata(bytes)
  return copy === null ? null : { bytes: copy, ms: audio.ms }
}
