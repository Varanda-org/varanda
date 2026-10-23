// Hypercore 10 constructor options the member diary is created with, as
// measured by test/seeder-link.test.js against the Hypercore 11 seeder: an
// empty object means the installed hypercore 10.38.2 defaults (compat mode,
// key === signer public key, default signer manifest version 1) were gated
// and served by the seeder without any override. createMember spreads these
// first and the caller's overrides last.
const DIARY_OPTIONS = {}

module.exports = { DIARY_OPTIONS }
