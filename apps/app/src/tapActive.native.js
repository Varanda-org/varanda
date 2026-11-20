// The native credential managers need no user activation: a ceremony may
// start after an await (src/tapActive.web.js has the browser's rule).
export function tapActive () {
  return true
}
