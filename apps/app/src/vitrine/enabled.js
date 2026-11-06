// The Vitrine (fixture data behind the real screens, for the visual review in
// docs/design-review.md) needs both a development bundle and the opt-in env
// var: a release bundle has __DEV__ false, so no env value can turn it on.
// Pure ES module: imports nothing, so Node's import() tests it.

export function vitrineEnabled (env, dev) {
  return dev === true && env !== null && typeof env === 'object' && env.EXPO_PUBLIC_VARANDA_VITRINE === '1'
}
