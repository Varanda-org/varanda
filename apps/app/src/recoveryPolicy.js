// Whether the first recovery run blocks the screens. A device whose diary
// already carries its member certificate opens its local tabs at once (a
// hidden background run would be preempted by the first feed.read/log.read
// anyway: the session aborts a live run before every read). Without the
// certificate the recovery run is what brings the diary from the seeder, so it
// blocks while the browser may be online, and does not block when the browser
// says it is offline.
export function blockingRecovery ({ onLine, memberCert }) {
  return memberCert !== true && onLine !== false
}
