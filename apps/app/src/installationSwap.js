// Whether the installation the app talks to changed under a person who was
// already on one. '' is "not known yet" (a cold start before the saved
// installation loads), so going from '' to an origin is not a swap and must
// keep an invite captured from a link meanwhile.
export function swappedInstallation (previous, current) {
  return typeof previous === 'string' && previous !== '' && typeof current === 'string' && current !== previous
}
