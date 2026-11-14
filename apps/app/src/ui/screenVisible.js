import { createContext } from 'react'

// ScreenVisible is true only on the screen the person is looking at. Hidden
// tabs and covered stack entries stay mounted, and measureInWindow still
// reports their rows as on screen, so a card cannot tell by measuring. The
// default false is the safe side: with no provider a card never loads a
// third-party frame.
export const ScreenVisible = createContext(false)

// True while something covers every screen (composer, Ajustes, report, help,
// page notice, lock, background).
export const ScreenCovered = createContext(false)

// How many open sheets enclose this tree.
export const SheetDepth = createContext(0)

// null, or { measure(done) } from a list with a composer under it: done(y)
// gets the composer's window top, or null. Measured on every check, since a
// stored onLayout value goes stale when the keyboard moves the composer.
export const EmbedBandBottom = createContext(null)

// null, or the player layer of the list a card is drawn in (./EmbedLayer
// useEmbedHost). A list unmounts rows far from the screen, and a frame drawn
// inside its row would go with it, so a card in a list hands its loaded frame
// to the list instead.
export const EmbedHost = createContext(null)

// The key of the list row a card sits in, '' outside a row: the frame a
// list keeps for a row is found again by this key when the row comes back.
export const EmbedRowKey = createContext('')

// null, or the Animated value a row moves its content by (./SwipeReply): a
// frame drawn outside the row, in the list's layer, moves with it.
export const RowShift = createContext(null)
