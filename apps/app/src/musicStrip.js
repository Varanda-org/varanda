// The bars are DECORATIVE, derived from the track id and the bar index,
// never from the audio. Nothing analyses audio and none may be added.
// The design is Instagram's: a fixed 15 s window stays centred and the
// whole-track strip slides under it, so one second is always 8 pt, even
// on a two-hour track. Pure ES module: no React, React Native or Node
// built-ins, so the same math runs in the app and under plain node.

import { clampStart, maxStart, SNIPPET_S } from './music.js'

// One second is always this many points, on a short track and on a two-hour one.
export const PX_PER_S = 8
// Pitch is wider than the bar so two bars never touch. The screen reads both;
// the math below only needs the pitch.
export const BAR_PITCH = 4
export const BAR_WIDTH = 3
// A two-hour strip is thousands of bars. The screen only mounts this many.
export const MAX_BARS = 200

const FNV_OFFSET = 2166136261
const FNV_PRIME = 16777619
// Bars a little outside the viewport are included so a drag does not pop
// them in a frame late. The margin stays fixed: it does not grow with the track.
const BAR_OVERSCAN = 40

// maxStart is 0 both when the track is shorter than the snippet and when the
// duration is one the rules refuse, so a short track is recognized on its own.
// Anything else would name seconds the player will never seek.
function acceptedDuration (duration) {
  if (maxStart(duration) > 0) return duration
  if (Number.isInteger(duration) && duration >= 1 && duration <= SNIPPET_S) return duration
  return null
}

// The centred frame. An unknown duration still reserves the 15 s width, so
// the layout does not jump when the item arrives.
export function windowPx (duration) {
  const accepted = acceptedDuration(duration)
  const seconds = accepted === null ? SNIPPET_S : Math.min(SNIPPET_S, accepted)
  return seconds * PX_PER_S
}

// The whole track at the same scale as the frame. 0 when the duration is
// not one the snippet rules accept.
export function stripPx (duration) {
  const accepted = acceptedDuration(duration)
  if (accepted === null) return 0
  return Math.max(windowPx(duration), accepted * PX_PER_S)
}

function fnv1a (text) {
  let hash = FNV_OFFSET
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, FNV_PRIME)
  }
  return hash >>> 0
}

// Neighbouring bars would share a height if the index were only added.
function xorshift (value) {
  let x = value >>> 0
  x ^= x << 13
  x >>>= 0
  x ^= x >>> 17
  x ^= x << 5
  return x >>> 0
}

// 0.25 keeps a stub: a zero height would look like a missing beat.
export function barHeight (id, index) {
  if (!Number.isInteger(index) || index < 0) return 0.25
  const mixed = xorshift(Math.imul(fnv1a(typeof id === 'string' ? id : '') ^ index, FNV_PRIME))
  return 0.25 + ((mixed / 0xffffffff) * 0.75)
}

// translateX of the whole track under the centred window. A viewport that
// cannot be measured stays at 0 so the strip does not jump to NaN.
export function stripOffset (start, viewport, duration) {
  if (typeof viewport !== 'number' || !Number.isFinite(viewport) || viewport <= 0) return 0
  const centred = (viewport - windowPx(duration)) / 2
  return centred - (clampStart(start, duration) * PX_PER_S)
}

// A finger moving left (negative dx) reveals later audio, so the start moves
// forward. The result stays inside the snippet's legal range.
export function startFromDrag (originStart, dx, duration) {
  if (typeof dx !== 'number' || !Number.isFinite(dx)) return clampStart(originStart, duration)
  return clampStart(Math.round(originStart - (dx / PX_PER_S)), duration)
}

// Indexes only: a two-hour track is thousands of bars, and nothing here
// builds one entry per second.
export function visibleBars (translateX, viewport, duration) {
  if (typeof translateX !== 'number' || !Number.isFinite(translateX)) return { first: 0, count: 0 }
  if (typeof viewport !== 'number' || !Number.isFinite(viewport) || viewport <= 0) return { first: 0, count: 0 }
  const limit = Math.ceil(stripPx(duration) / BAR_PITCH) - 1
  if (limit < 0) return { first: 0, count: 0 }
  const left = -translateX - BAR_OVERSCAN
  const right = -translateX + viewport + BAR_OVERSCAN
  let first = Math.ceil(left / BAR_PITCH)
  let last = Math.floor(right / BAR_PITCH)
  if (first < 0) first = 0
  if (last > limit) last = limit
  if (last < first) return { first: 0, count: 0 }
  if (last - first + 1 > MAX_BARS) {
    const mid = Math.round((-translateX + viewport / 2) / BAR_PITCH)
    first = Math.max(first, mid - Math.floor(MAX_BARS / 2))
    first = Math.min(first, last - MAX_BARS + 1)
    return { first, count: MAX_BARS }
  }
  return { first, count: Math.min(MAX_BARS, (last - first) + 1) }
}
