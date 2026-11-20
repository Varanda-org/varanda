// expo-video for tests run in Node: players are plain objects that record
// their calls in globalThis.__stubVideo.log and keep their listeners, so a
// test can fire 'statusChange', 'playingChange', 'timeUpdate' or 'playToEnd'
// with player.emit(type, payload). VideoView renders nothing.
const box = () => (globalThis.__stubVideo ??= { log: [], players: [] })

export class VideoPlayer {
  constructor (source) {
    this.source = source
    this.playing = false
    this.muted = false
    this.loop = false
    this.currentTime = 0
    this.duration = 0
    this.status = 'loading'
    this.allowsExternalPlayback = true
    this.staysActiveInBackground = false
    this.showNowPlayingNotification = false
    this.timeUpdateEventInterval = 0
    this.released = false
    this.listeners = new Map()
    box().players.push(this)
    box().log.push('new ' + (source && source.uri))
  }

  addListener (type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type).add(fn)
    return { remove: () => { this.listeners.get(type)?.delete(fn) } }
  }

  emit (type, payload) {
    for (const fn of [...(this.listeners.get(type) || [])]) fn(payload)
  }

  play () { box().log.push('play'); this.playing = true }
  pause () { box().log.push('pause'); this.playing = false }
  replay () { box().log.push('replay'); this.currentTime = 0; this.playing = true }
  release () { box().log.push('release'); this.released = true; this.listeners.clear() }
}

export function createVideoPlayer (source) {
  return new VideoPlayer(typeof source === 'string' ? { uri: source } : source)
}

export function useVideoPlayer (source, setup) {
  const player = createVideoPlayer(source)
  if (typeof setup === 'function') setup(player)
  return player
}

export function VideoView () {
  return null
}

export function isPictureInPictureSupported () {
  return false
}
