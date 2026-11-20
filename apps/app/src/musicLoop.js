import { clampStart, snippetEndMs, snippetTick, seekReached, musicErrorText, MUSIC_SEEK_TEXT } from './music.js'

export const MAX_LOOPS = 8
export const loopIdle = { phase: 'idle', ms: 0, error: '' }

export function createSnippetLoop ({ audiusPlay, createStreamPlayer, claimPlayback, playbackEpoch, now = Date.now }, session, notify) {
  let item = null
  let start = 0
  let current = null

  function publish (job, phase, ms = start * 1000, error = '') {
    job.phase = phase
    job.ms = ms
    notify({ phase, ms, error })
  }

  function dispose (job) {
    if (current === job) current = null
    job.playPending = null
    job.controller.abort()
    clearTimeout(job.timer)
    for (const off of job.offs.splice(0)) off()
    if (job.player) { job.player.pause(); job.player.release() }
    job.unclaim?.()
    job.ticket = null
  }

  function live (job) {
    if (current !== job) return false
    if (job.epoch !== playbackEpoch()) {
      dispose(job)
      publish(job, 'idle')
      return false
    }
    return !job.lost
  }

  function fail (job, err, seeking = false) {
    // A lost claim is still this job until the element is dropped: leaving it
    // paused makes the next tap seek a player that will never answer.
    if (current !== job) return
    const silent = err?.code === 'superseded' || err?.code === 'released'
    const seekError = seeking || err?.code === 'seek' || err?.code === 'seek-timeout' || err?.code === 'seek-range'
    const error = silent ? '' : seekError ? MUSIC_SEEK_TEXT : musicErrorText(err)
    dispose(job)
    publish(job, 'idle', start * 1000, error)
  }

  function claim (job) {
    job.epoch = playbackEpoch()
    job.lost = false
    const yieldPlayback = () => {
      if (current !== job) return
      job.lost = true
      job.version++
      job.wantsPlay = false
      job.playPending = null
      job.target = null
      job.controller.abort()
      clearTimeout(job.timer)
      job.player?.pause()
      publish(job, job.player ? 'paused' : 'idle', job.ms)
    }
    job.unclaim?.()
    const epoch = job.epoch
    job.unclaim = claimPlayback({ pause: yieldPlayback }, { bound: true, epoch })
  }

  function playError (job, err) {
    if (current !== job) return
    const refused = err?.name === 'NotAllowedError' || err?.cause?.name === 'NotAllowedError'
    if (refused && !job.lost) stop()
    else if (!refused) fail(job, err)
  }

  async function play (job) {
    if (!live(job) || !job.wantsPlay) return
    const version = job.version
    // Stays set until the first playing sample, a rejected play(), or this
    // controller stops, pauses, seeks or releases. play() resolving is too
    // early: the native player reports paused once more before it is audible,
    // and treating that as an interruption drops the snippet window.
    const pending = job.playPending = {}
    publish(job, 'loading')
    try {
      await job.player.play()
      live(job)
    } catch (err) {
      if (job.playPending === pending) job.playPending = null
      if (!live(job) || version !== job.version) return
      playError(job, err)
    }
  }

  async function drain (job) {
    job.seeking = true
    job.playPending = null
    clearTimeout(job.timer)
    job.player.pause()
    // The seek can take SEEK_WAIT_MS. Publish before it resolves so a second
    // tap sees the resume and a playing editor does not keep a stale position.
    if (job.wantsPlay) publish(job, 'loading')
    try {
      while (live(job) && job.target !== null) {
        const target = job.target
        job.target = null
        try {
          await job.player.seek(target)
        } catch (err) {
          const silent = err?.code === 'superseded' || err?.code === 'released'
          if (!silent && live(job) && job.target !== null && job.target !== target) continue
          fail(job, err, true)
          return
        }
        if (!live(job)) return
        if (job.target !== null) continue
        if (snippetTick({ ms: target, startMs: start * 1000, endMs: snippetEndMs(start, item.duration) }) === 'stop') {
          fail(job, null, true)
          return
        }
        job.ms = target
      }
    } finally {
      job.seeking = false
      job.drain = null
    }
    if (!live(job)) return
    if (job.wantsPlay) await play(job)
    else publish(job, 'paused')
  }

  function seek (job) {
    job.version++
    job.target = start * 1000
    if (!job.player || job.lost) return
    if (!job.seeking) job.drain = drain(job)
    return job.drain
  }

  function restart (job) {
    if (!live(job) || job.seeking || !job.wantsPlay) return
    if (job.loops === MAX_LOOPS) {
      job.wantsPlay = false
      // The seek back can take SEEK_WAIT_MS. Publish before it resolves so
      // the control does not stay on playing while the audio is already pausing.
      publish(job, 'paused', start * 1000, '')
    } else job.loops++
    return seek(job)
  }

  async function load () {
    if (current) dispose(current)
    const job = {
      controller: new AbortController(),
      player: null,
      ticket: null,
      offs: [],
      unclaim: null,
      timer: null,
      epoch: null,
      lost: false,
      phase: 'loading',
      ms: start * 1000,
      wantsPlay: true,
      playPending: null,
      loops: 0,
      seeking: false,
      target: null,
      drain: null,
      version: 0
    }
    current = job
    publish(job, 'loading')
    claim(job)
    if (!live(job)) return
    try {
      const ticket = await audiusPlay(item.id, { ...session, signal: job.controller.signal })
      if (!live(job)) return
      job.ticket = ticket
      const player = job.player = createStreamPlayer(ticket.url, { origin: ticket.base })
      job.offs.push(player.onError((err) => {
        // Both stream players report a failed seek and then reject that seek.
        // Failing here releases the player, so the rejection arrives as
        // 'released' and a newer start queued in drain is never tried.
        if (job.seeking && (err?.code === 'seek' || err?.code === 'seek-timeout')) return
        if (job.seeking) fail(job, err)
        else playError(job, err)
      }))
      job.offs.push(player.onProgress((update) => {
        if (!live(job) || job.seeking || !job.wantsPlay) return
        clearTimeout(job.timer)
        const startMs = start * 1000
        const endMs = snippetEndMs(start, item.duration)
        if (update.playing === true) job.playPending = null
        if (!seekReached(update.ms, startMs)) {
          job.wantsPlay = false
          job.playPending = null
          job.version++
          job.player.pause()
          publish(job, 'paused', startMs, MUSIC_SEEK_TEXT)
          return
        }
        if (update.ended || snippetTick({ ms: update.ms, startMs, endMs }) === 'stop') {
          restart(job)
          return
        }
        // An interruption reports paused without buffering. Leaving wantsPlay
        // set would make the next tap stop, so recovery would take two taps.
        if (update.playing === false && !update.buffering && !job.playPending) {
          job.wantsPlay = false
          publish(job, 'paused', update.ms)
          return
        }
        const playing = update.playing === true && update.buffering === false
        publish(job, playing ? 'playing' : 'loading', update.ms)
        if (playing) job.timer = setTimeout(() => restart(job), Math.max(0, endMs - update.ms))
      }))
      await seek(job)
    } catch (err) {
      if (current !== job || job.lost || job.controller.signal.aborted) return
      fail(job, err)
    }
  }

  function open (next, value) {
    if (item?.id === next.id) return setStart(value)
    item = next
    start = clampStart(value, item.duration)
    return load()
  }

  function setStart (value) {
    if (!item) return
    start = clampStart(value, item.duration)
    if (!current || !live(current)) return
    // Dragging the window is attention, same as a tap: the allowance starts over.
    current.loops = 0
    return seek(current)
  }

  function toggle () {
    if (!item) return
    const job = current
    if (job && !job.lost && job.wantsPlay) return stop()
    if (job && !job.lost && !job.ticket) {
      job.wantsPlay = true
      publish(job, 'loading')
      return
    }
    if (!job?.ticket || Date.parse(job.ticket.expiresAt) <= now()) return load()
    if (job.lost) claim(job)
    if (!live(job)) return
    job.loops = 0
    job.wantsPlay = true
    return seek(job)
  }

  function stop () {
    const job = current
    if (!job) return
    job.wantsPlay = false
    job.playPending = null
    job.version++
    clearTimeout(job.timer)
    job.player?.pause()
    publish(job, job.player ? 'paused' : 'idle', job.ms)
  }

  function release () {
    if (current) dispose(current)
    item = null
    start = 0
  }

  return { open, setStart, toggle, stop, release }
}
