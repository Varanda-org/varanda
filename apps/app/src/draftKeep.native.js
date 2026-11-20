// The app keeps running when a share arrives (src/useSharedIntent.js reads
// it on the next foreground), so the draft is still in memory: nothing to
// keep. See src/draftKeep.web.js.

export function takeDraft () {
  return ''
}

export function watchDraft () {
  return function () {}
}

export function dropDraft () {}
