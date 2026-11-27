// The phone keeps these photos as files in ./keep.native.js, so the web
// stores' methods answer nothing here.

function inert () {
  return {
    bind: async () => false,
    read: async () => null,
    put: async () => false,
    readThumb: async () => null,
    putThumb: async () => false,
    dropAuthors: async () => false,
    dropRanges: async () => false,
    retain: async () => false,
    retainThumbs: async () => false,
    wipe: async () => false
  }
}

export const peekPhotos = inert()
export const copyPhotos = inert()
