'use strict'
// Browser stub for #process: just enough for modules to load (clock.js uses
// performance.now in browsers and never reaches hrtime).
module.exports = {
  env: {},
  platform: 'browser',
  hrtime: undefined,
  on () {},
  once () {},
  off () {},
  cwd () { return '/' }
}
