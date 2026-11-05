// The account service sends no CORS headers and checks the Origin, so a page
// on another origin (the varanda-serve web UI) can never reach it.
export const CROSS_ORIGIN_PAGES = false
