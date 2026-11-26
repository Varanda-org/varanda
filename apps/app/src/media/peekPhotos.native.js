// The phone keeps these photos as files in ./keep.native.js, so the web
// store's methods answer nothing here.

export const peekPhotos = {
  bind: async () => false,
  read: async () => null,
  put: async () => false,
  dropAuthors: async () => false,
  dropRanges: async () => false,
  retain: async () => false,
  wipe: async () => false
}
