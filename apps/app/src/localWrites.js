// Stamp of the last successful local write that changes what the own Diario
// lists or counts. A repost, undo or like made in another tab does not bump
// Diario's refresh prop, so Diario compares this stamp with its load time.

let last = 0

export function noteLocalWrite (now = Date.now()) {
  last = now
}

export function lastLocalWrite () {
  return last
}
