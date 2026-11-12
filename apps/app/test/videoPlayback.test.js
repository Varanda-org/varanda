'use strict'

// src/media/videoPlayback.js: the local-uri rule, the playback reducer and
// what the players report from it, and the one-player-at-a-time registry.
// Both VideoPlayer siblings are thin wrappers over these rules. The source
// checks at the end make sure the web sibling never pulls in expo-video and
// both siblings refuse a source that is not local.
const fs = require('fs')
const path = require('path')
const test = require('brittle')

const load = () => import('../src/media/videoPlayback.js')
const FILE = 'file:///data/cache/video/a.mp4'
const OTHER = 'blob:http://localhost/0d4c'

test('isLocalPlayable: only file:// and blob: sources', async (t) => {
  const { isLocalPlayable } = await load()
  t.ok(isLocalPlayable(FILE))
  t.ok(isLocalPlayable(OTHER))
  for (const uri of ['http://example.test/a.mp4', 'https://example.test/a.mp4', 'data:video/mp4;base64,AAAA', 'content://media/1', '/data/a.mp4', 'FILE:///a.mp4', '', null, undefined, 42, { uri: FILE }]) {
    t.absent(isLocalPlayable(uri), 'refuses ' + String(uri))
  }
})

test('videoState: a source that is not local starts as an error and takes no events', async (t) => {
  const { videoState, reduceVideo } = await load()
  for (const uri of ['http://example.test/a.mp4', 'https://example.test/a.mp4', 'data:video/mp4;base64,AAAA']) {
    const s = videoState(uri)
    t.is(s.status, 'error', uri)
    t.is(s.uri, null, uri + ' is not kept')
    t.is(reduceVideo(s, { type: 'ready', uri, durationMs: 1000 }), s, uri + ' ignores ready')
    t.is(reduceVideo(s, { type: 'playing', uri }), s, uri + ' ignores playing')
  }
  const ok = videoState(FILE, { muted: true })
  t.is(ok.status, 'loading')
  t.is(ok.muted, true)
})

test('reduceVideo: ready, playing, progress, paused, ended', async (t) => {
  const { videoState, reduceVideo, remainingMs } = await load()
  let s = videoState(FILE)
  s = reduceVideo(s, { type: 'ready', uri: FILE, durationMs: 12000 })
  t.is(s.status, 'ready')
  t.is(s.durationMs, 12000)
  s = reduceVideo(s, { type: 'playing', uri: FILE })
  t.is(s.status, 'playing')
  s = reduceVideo(s, { type: 'progress', uri: FILE, ms: 4000, durationMs: 12000, playing: true })
  t.is(s.ms, 4000)
  t.is(remainingMs(s), 8000)
  s = reduceVideo(s, { type: 'progress', uri: FILE, ms: 4250, durationMs: 12000, playing: false })
  t.is(s.status, 'paused', 'a progress that stopped playing pauses')
  t.is(s.ms, 4250)
  s = reduceVideo(s, { type: 'playing', uri: FILE })
  s = reduceVideo(s, { type: 'paused', uri: FILE })
  t.is(s.status, 'paused')
  s = reduceVideo(s, { type: 'progress', uri: FILE, ms: 99000, durationMs: 12000, playing: true })
  t.is(s.ms, 12000, 'a position past the end is clamped')
  s = reduceVideo(s, { type: 'ended', uri: FILE })
  t.is(s.status, 'ended')
  t.is(s.ms, 12000)
  t.is(remainingMs(s), 0)
  t.is(reduceVideo(s, { type: 'paused', uri: FILE }), s, 'a pause after the end keeps it ended')
  s = reduceVideo(s, { type: 'playing', uri: FILE })
  t.is(s.status, 'playing', 'a replay plays again')
})

test('reduceVideo: bad numbers, unknown events and an error that sticks', async (t) => {
  const { videoState, reduceVideo } = await load()
  let s = reduceVideo(videoState(FILE), { type: 'ready', uri: FILE, durationMs: 5000 })
  const r = reduceVideo(s, { type: 'progress', uri: FILE, ms: NaN, durationMs: -3, playing: true })
  t.is(r.ms, 0)
  t.is(r.durationMs, 5000, 'a bad duration keeps the known one')
  t.is(reduceVideo(s, { type: 'seek', uri: FILE }), s, 'an unknown event changes nothing')
  t.is(reduceVideo(s, null), s)
  s = reduceVideo(s, { type: 'error', uri: FILE })
  t.is(s.status, 'error')
  t.is(reduceVideo(s, { type: 'playing', uri: FILE }), s, 'nothing leaves the error')
  t.is(reduceVideo(s, { type: 'progress', uri: FILE, ms: 10, playing: true }), s)
})

test('reduceVideo: events from a previous uri are ignored', async (t) => {
  const { videoState, reduceVideo, videoEffects } = await load()
  let s = reduceVideo(videoState(OTHER), { type: 'ready', uri: OTHER, durationMs: 9000 })
  s = reduceVideo(s, { type: 'playing', uri: OTHER })
  for (const event of [
    { type: 'ready', uri: FILE, durationMs: 1 },
    { type: 'playing', uri: FILE },
    { type: 'paused', uri: FILE },
    { type: 'ended', uri: FILE },
    { type: 'error', uri: FILE },
    { type: 'soundRefused', uri: FILE },
    { type: 'progress', uri: FILE, ms: 3000, durationMs: 30000, playing: false },
    { type: 'progress', ms: 3000, durationMs: 30000, playing: true }
  ]) {
    const next = reduceVideo(s, event)
    t.is(next, s, 'stale ' + event.type + ' ignored')
    t.alike(videoEffects(s, next), [], 'and reports nothing')
  }
})

test('reduceVideo: sound refused starts muted and is reported once', async (t) => {
  const { videoState, reduceVideo, videoEffects } = await load()
  const s = reduceVideo(videoState(FILE), { type: 'ready', uri: FILE, durationMs: 3000 })
  t.is(s.muted, false)
  const r = reduceVideo(s, { type: 'soundRefused', uri: FILE })
  t.is(r.muted, true)
  t.is(r.soundRefused, true)
  t.alike(videoEffects(s, r), [{ type: 'soundRefused' }])
  const again = reduceVideo(r, { type: 'soundRefused', uri: FILE })
  t.is(again, r)
  t.alike(videoEffects(r, again), [])
})

test('videoEffects: ready once, progress on every tick and once on a pause, end once', async (t) => {
  const { videoState, reduceVideo, videoEffects } = await load()
  const reports = []
  let s = videoState(FILE)
  const step = (event) => {
    const next = reduceVideo(s, { ...event, uri: FILE })
    reports.push(...videoEffects(s, next))
    s = next
  }
  step({ type: 'ready', durationMs: 10000 })
  step({ type: 'ready', durationMs: 10000 })
  step({ type: 'progress', ms: 0, durationMs: 10000, playing: true })
  step({ type: 'progress', ms: 250, durationMs: 10000, playing: true })
  step({ type: 'progress', ms: 500, durationMs: 10000, playing: true })
  step({ type: 'progress', ms: 520, durationMs: 10000, playing: false })
  step({ type: 'paused' })
  step({ type: 'progress', ms: 520, durationMs: 10000, playing: false })
  step({ type: 'progress', ms: 9900, durationMs: 10000, playing: true })
  step({ type: 'ended' })
  step({ type: 'ended' })
  t.alike(reports, [
    { type: 'ready', durationMs: 10000 },
    { type: 'progress', ms: 0, durationMs: 10000, playing: true, ended: false },
    { type: 'progress', ms: 250, durationMs: 10000, playing: true, ended: false },
    { type: 'progress', ms: 500, durationMs: 10000, playing: true, ended: false },
    { type: 'progress', ms: 520, durationMs: 10000, playing: false, ended: false },
    { type: 'progress', ms: 9900, durationMs: 10000, playing: true, ended: false },
    { type: 'progress', ms: 10000, durationMs: 10000, playing: false, ended: true },
    { type: 'end' }
  ])
})

test('videoEffects: an error is reported once, a progress from a previous uri never', async (t) => {
  const { videoState, reduceVideo, videoEffects } = await load()
  const s = reduceVideo(videoState(FILE), { type: 'ready', uri: FILE, durationMs: 2000 })
  const e = reduceVideo(s, { type: 'error', uri: FILE })
  t.alike(videoEffects(s, e), [{ type: 'error' }])
  t.alike(videoEffects(e, reduceVideo(e, { type: 'error', uri: FILE })), [])
  const fresh = videoState(OTHER)
  t.alike(videoEffects(s, fresh), [], 'a new source is not a step of the old one')
  const late = reduceVideo(fresh, { type: 'progress', uri: FILE, ms: 1500, durationMs: 2000, playing: true })
  t.is(late, fresh)
  t.alike(videoEffects(fresh, late), [])
})

test('progressFromSeconds: seconds to whole milliseconds', async (t) => {
  const { progressFromSeconds } = await load()
  t.alike(progressFromSeconds({ currentTime: 1.2504, duration: 14.9, playing: true }), { ms: 1250, durationMs: 14900, playing: true, ended: false })
  t.alike(progressFromSeconds({ currentTime: NaN, duration: Infinity, playing: 'yes', ended: true }), { ms: 0, durationMs: 0, playing: false, ended: true })
  t.alike(progressFromSeconds(), { ms: 0, durationMs: 0, playing: false, ended: false })
})

test('createPlaybackRegistry: one player at a time', async (t) => {
  const { createPlaybackRegistry, videoPlayers } = await load()
  const r = createPlaybackRegistry()
  const log = []
  const a = {}
  const b = {}
  const c = {}
  r.claim(a, () => log.push('stop a'))
  t.is(r.active(), a)
  r.claim(a, () => log.push('stop a2'))
  t.alike(log, [], 'claiming again does not stop itself')
  r.claim(b, () => { log.push('stop b'); throw new Error('boom') })
  t.alike(log, ['stop a2'], 'the newest stop of the previous holder runs')
  t.is(r.active(), b)
  r.claim(c, () => log.push('stop c'))
  t.alike(log, ['stop a2', 'stop b'], 'a throwing stop does not block the new player')
  t.is(r.active(), c)
  r.release(b)
  t.is(r.active(), c, 'releasing a player that is not active changes nothing')
  r.release(c)
  t.is(r.active(), null)
  r.claim(a, () => log.push('stop a3'))
  t.alike(log, ['stop a2', 'stop b'], 'nothing to stop after a release')
  t.is(typeof videoPlayers.claim, 'function', 'the app shares one registry')
})

test('playRefusal: an abort is ignored, sound refused retries muted once, refused muted is blocked, the rest fails', async (t) => {
  const { playRefusal } = await load()
  const err = (name) => Object.assign(new Error(name), { name })
  t.is(playRefusal(err('AbortError'), false), 'aborted')
  t.is(playRefusal(err('AbortError'), true), 'aborted', 'an abort during the muted retry is not a failure')
  t.is(playRefusal(err('NotAllowedError'), false), 'muteAndRetry')
  t.is(playRefusal(err('NotAllowedError'), true), 'blocked', 'refused while already muted wants a gesture, the file is fine')
  t.is(playRefusal({ name: 'NotAllowedError' }, true), 'blocked')
  t.is(playRefusal(err('NotSupportedError'), false), 'failed')
  t.is(playRefusal(err('NotSupportedError'), true), 'failed')
  t.is(playRefusal(null, false), 'failed')
  t.is(playRefusal(undefined, true), 'failed')
  t.is(playRefusal({ name: 'NotAllowedError' }, undefined), 'muteAndRetry')
})

const src = (name) => fs.readFileSync(path.join(__dirname, '../src/media', name), 'utf8')

test('the siblings: expo-video on the phone only, local sources only', (t) => {
  const web = src('VideoPlayer.web.js')
  const native = src('VideoPlayer.native.js')
  t.absent(/from\s+'expo-video'|require\('expo-video'\)/.test(web), 'the web player does not import expo-video')
  t.ok(native.includes("from 'expo-video'"), 'the phone player uses expo-video')
  for (const [name, code] of [['web', web], ['native', native]]) {
    t.ok(code.includes('isLocalPlayable(uri)'), name + ' checks the source')
    t.ok(code.includes('refusedSourceError()'), name + ' reports a refused source')
  }
  t.ok(web.includes('playsInline'), 'the web player plays inline')
  t.ok(native.includes('fullscreenOptions={{ enable: false }}'), 'no fullscreen on the phone')
  t.ok(native.includes('allowsExternalPlayback: false'), 'no AirPlay')
  t.ok(native.includes('allowsPictureInPicture={false}'), 'no picture-in-picture')
  t.ok(native.includes('staysActiveInBackground: false'), 'no background playback')
})

test('the pure module imports nothing', (t) => {
  const code = src('videoPlayback.js')
  t.absent(/^\s*import\s/m.test(code), 'no imports')
  t.absent(/require\(/.test(code), 'no require')
})

// The siblings cannot load react-native in Node and no renderer that runs
// effects is installed, so these fixes are checked in the source.
test('the phone player never drives a released player or keeps the old one in the view', (t) => {
  const native = src('VideoPlayer.native.js')
  t.ok(native.includes('const entry = { player: p, token, uri, released: false }'), 'the entry keeps its uri')
  t.ok(/entry\.released = true[\s\S]*?released\.release\(\)/.test(native), 'the cleanup marks it released before releasing')
  t.ok(native.includes('current !== null && current.uri === uri && !current.released ? current : null'), 'only the player of this uri is live')
  t.ok(native.includes('if (live === null) return null'), 'no view without the live player')
  t.ok(native.includes('player={live.player}'), 'the view takes the live player')
  t.absent(/player=\{player\}|player=\{current/.test(native), 'the view never takes current directly')
  t.ok(native.includes('if (live !== null && !live.released) configure('), 'muted skips a released player')
  t.ok(native.includes('if (live === null || live.released) return'), 'play and pause skip a released player')
  t.ok(native.includes('if (isPlaying && p !== null && p.playing === true) videoPlayers.claim('), 'a queued playing change of a paused player claims nothing')
  t.ok(/try \{\s*if \(playing === true\)[\s\S]*?player\.replay\(\)[\s\S]*?player\.play\(\)[\s\S]*?player\.pause\(\)\s*\}\s*\} catch \{\}/.test(native), 'play, replay and pause are wrapped in try')
})

test('the web player: a late rejection never restarts a paused video, a final one reports an error', (t) => {
  const web = src('VideoPlayer.web.js')
  const handler = web.slice(web.indexOf('attempt.catch('), web.indexOf('const offs = []'))
  t.ok(handler.length > 0, 'the rejection handler is found')
  t.ok(handler.includes('if (!active || !playingRef.current) return\n        const refusal = playRefusal(err, wasMuted)'), 'stops when the caller paused')
  t.ok(/const wasMuted = el\.muted\n\s*const attempt = el\.play\(\)/.test(web), 'the refusal is judged by the muted state of its own call')
  t.absent(handler.includes('playRefusal(err, el.muted)'), 'never by a muted state a sibling retry set')
  t.ok(/on\('playing', \(\) => \{\s*(\/\/[^\n]*\s*)*if \(el\.paused\) return\s*videoPlayers\.claim/.test(web), 'a queued playing event of a paused video claims nothing')
  t.ok(handler.includes("if (refusal === 'aborted') return"), 'an AbortError is ignored')
  t.ok(handler.includes("if (refusal === 'failed') { fail(); return }"), 'a final rejection fails')
  t.ok(/if \(!playingRef\.current\) return\s*const again = el\.play\(\)/.test(handler), 'checks playing again before the muted retry')
  t.ok(/const retried = playRefusal\(retryErr, true\)\s*if \(retried === 'failed'\) fail\(\)/.test(handler), 'a failed muted retry fails')
  t.absent(handler.includes("type: 'progress'"), 'a rejection no longer passes as a paused tick')
  t.ok(/const fail = \(\) => \{\s*videoPlayers\.release\(token\)\s*apply\(\{ type: 'error' \}\)/.test(web), 'fail gives the registry back and reports an error')
})

test('the web player: refused even muted is blocked, not an error', (t) => {
  const web = src('VideoPlayer.web.js')
  const native = src('VideoPlayer.native.js')
  const handler = web.slice(web.indexOf('attempt.catch('), web.indexOf('const offs = []'))
  t.ok(web.includes('onProgress, onPlayBlocked, control }) {'), 'the web player takes onPlayBlocked')
  t.ok(web.includes('callbacks.current = { onReady, onEnd, onError, onSoundRefused, onProgress, onPlayBlocked }'), 'the latest callback is used')
  t.ok(handler.includes("if (refusal === 'blocked') { block(); return }"), 'a first call refused while muted is blocked')
  t.ok(handler.includes("else if (retried === 'blocked') block()"), 'a refused muted retry is blocked')
  const block = web.slice(web.indexOf('const block = () => {'), web.indexOf('const play = () => {'))
  t.ok(block.length > 0, 'block is found')
  t.ok(/videoPlayers\.release\(token\)\s*if \(blockedSent\) return\s*blockedSent = true\s*try \{ callbacks\.current\.onPlayBlocked\?\.\(\) \} catch \{\}/.test(block), 'gives the registry back, then calls onPlayBlocked once')
  t.absent(/apply\(|onError|removeAttribute|fail\(/.test(block), 'never an error, the source stays')
  t.ok(/pause: \(\) => \{\s*blockedSent = false\s*el\.pause\(\)/.test(web), 'a pause starts a new attempt')
  t.ok(/videoPlayers\.claim\(token, \(\) => \{ if \(active\) el\.pause\(\) \}\)\s*blockedSent = false\s*lastTick/.test(web), 'real playback starts a new attempt')
  t.absent(native.includes('onPlayBlocked?.('), 'the phone player never calls it')
})

// A press calls the player through control in its own handler: a browser that
// wants a gesture may not count the effect that applies the new props later.
test('the web player: control plays and unmutes in the press, for the live player only', (t) => {
  const web = src('VideoPlayer.web.js')
  t.ok(web.includes('onProgress, onPlayBlocked, control }) {'), 'the web player takes control')
  const layout = web.slice(web.indexOf('useLayoutEffect(() => {'), web.indexOf('}, [uri])'))
  t.ok(layout.length > 0, 'the uri effect is found')
  const handle = layout.slice(layout.indexOf('const handle = {'), layout.indexOf('if (ctl) ctl.current = handle'))
  t.ok(handle.length > 0, 'the handle is found')
  t.ok(/play: \(\) => \{\s*if \(!active\) return[\s\S]*?playingRef\.current = true\s*play\(\)\s*\}/.test(handle), 'play() is the helper the effects use, skipped once gone')
  t.ok(/unmute: \(\) => \{\s*if \(active\) el\.muted = false\s*\}/.test(handle), 'unmute() only unmutes, it starts nothing')
  t.absent(/el\.play\(\)/.test(handle), 'no second way to play')
  t.ok(layout.includes('const ctl = controlRef.current') && layout.includes('if (ctl) ctl.current = handle'), 'set while the player of this uri is live')
  t.ok(layout.indexOf('if (ctl) ctl.current = handle') < layout.indexOf('if (playingRef.current) play()'), 'set before the first play')
  const cleanup = layout.slice(layout.indexOf('return () => {'))
  t.ok(cleanup.includes('if (ctl && ctl.current === handle) ctl.current = null'), 'back to null when the player goes away')
  t.ok(/const player = live\.current[\s\S]*?if \(playing === true\) player\.play\(\)/.test(web), 'the playing effect calls the same play')
  t.ok(/live\.current = \{\s*play,/.test(web), 'live holds that same helper')
})

test('the phone player: control plays and unmutes the live player, never a released one', (t) => {
  const native = src('VideoPlayer.native.js')
  t.ok(native.includes('onSoundRefused, onProgress, control }) {'), 'the phone player takes control')
  const at = native.indexOf('const handle = {')
  t.ok(at > 0, 'the handle is found')
  const effect = native.slice(native.lastIndexOf('useLayoutEffect(() => {', at), native.indexOf('}, [live, control])') + 20)
  t.ok(effect.includes('if (!control || live === null || live.released) return undefined'), 'only for the live player')
  t.ok(/play: \(\) => \{\s*if \(live\.released\) return[\s\S]*?try \{\s*videoPlayers\.claim\(token,[\s\S]*?if \(state\.current\.status === 'ended'\) player\.replay\(\)\s*else player\.play\(\)\s*\} catch \{\}/.test(effect), 'play() claims, replays when ended, in try')
  t.ok(/unmute: \(\) => \{\s*if \(!live\.released\) configure\(live\.player, \{ muted: false \}\)/.test(effect), 'unmute() sets muted through configure, which tries each property')
  t.ok(effect.includes('control.current = handle'), 'set for the live player')
  t.ok(/return \(\) => \{\s*if \(control\.current === handle\) control\.current = null\s*\}/.test(effect), 'back to null when the player goes away')
  t.ok(effect.includes('}, [live, control])'), 'a new uri gets a new handle')
})
