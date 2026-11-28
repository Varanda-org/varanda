// Native: there is no Web Push on iOS or Android, so no service worker needs the
// block or mute list. Same exports as the web file, so callers never branch.

export function reportBlocks () {}

export function reportMutes () {}

export function clearPushLists () {}

export function openPushLists () {}
