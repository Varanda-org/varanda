// The browser HTTP cache already keeps the photos of followed authors (the
// fetch uses force-cache for them), so the web keeps no separate store.

export const KEEP_MAX_BYTES = 67108864
export const KEEP_MAX_FILES = 2000
export const KEEP_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
export const KEEP_RELEASE_GRACE_MS = 120000

export function keptUrl () { return null }
export function keep () { return null }
export function dropKeptRanges () { return null }
export function dropKeptAuthors () { return null }
export function keepOnlyKeptAuthors () { return null }
export function releaseKept () { return null }
export function wipeKept () { return null }
export function trimKept () { return null }
