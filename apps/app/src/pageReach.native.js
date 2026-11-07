// Native fetch sends no Origin, so a core node reaches the account service
// on another origin (src/pageGate.js setCoreReach).
export const CROSS_ORIGIN_PAGES = true
