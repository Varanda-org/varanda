/* global navigator */
// Whether the tap that is running may still start a WebAuthn ceremony after
// an await (the browser's transient user activation). A browser without the
// UserActivation API answers false: the person taps again instead of seeing
// a ceremony refused.
export function tapActive () {
  try {
    const ua = typeof navigator === 'object' && navigator !== null ? navigator.userActivation : null
    return !!ua && ua.isActive === true
  } catch {
    return false
  }
}
