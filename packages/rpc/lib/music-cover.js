'use strict'

// The still cover shown at a music player's size before the player loads,
// shared by the app's preview builder and the account service. A YouTube
// watch page is larger than either reader's cap, so its og:image can never
// be read; the thumbnail is the one cover address that can be built from the
// video id alone. Zero dependencies, no Node built-ins. Never throws.

const YOUTUBE_COVER_HOST = 'i.ytimg.com'
// Only the canonical page the app's musicEmbed youtube() builds: www or music
// host, an 11 character id, and an optional start of 1 to 86400 seconds.
const YOUTUBE_PAGE = /^https:\/\/(?:www|music)\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})(?:&t=([1-9][0-9]{0,4})s)?$/
const YOUTUBE_MAX_START = 86400

function youtubeCoverUrl (url) {
  if (typeof url !== 'string') return null
  const m = YOUTUBE_PAGE.exec(url)
  if (m === null || (m[2] !== undefined && Number(m[2]) > YOUTUBE_MAX_START)) return null
  return 'https://' + YOUTUBE_COVER_HOST + '/vi/' + m[1] + '/mqdefault.jpg'
}

module.exports = { YOUTUBE_COVER_HOST, youtubeCoverUrl }
