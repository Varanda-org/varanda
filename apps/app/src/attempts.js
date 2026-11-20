// Numbers the start attempts of the node connection (src/node.js). Work that
// outlives its attempt (a connect in flight, a background /varanda.json
// revalidation) checks its token before acting, so an obsolete answer can
// never reinstall a connection or overwrite the phase of a newer attempt.

export function createAttempts () {
  let token = 0
  return {
    begin () {
      token += 1
      return token
    },
    isCurrent (t) {
      return t === token
    },
    current () {
      return token
    }
  }
}
