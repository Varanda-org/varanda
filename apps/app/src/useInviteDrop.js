import { useCallback, useEffect, useRef, useState } from 'react'
import { invitePolicy, invitesStart, invitesSummary } from './account'
import { createInviteDropMonitor } from './inviteDrop.js'
import { loadInviteSeen, saveInviteSeen } from './inviteSeenStore'

export function useInviteDrop ({ enabled, member, request, seenElsewhere, onMarked }) {
  const [note, setNote] = useState(null)
  const monitor = useRef(null)
  const hooks = useRef({})
  hooks.current = { seenElsewhere, onMarked }
  if (monitor.current === null) {
    monitor.current = createInviteDropMonitor({
      policy: invitePolicy,
      start: invitesStart,
      summary: invitesSummary,
      store: { load: loadInviteSeen, save: saveInviteSeen },
      setInterval,
      clearInterval,
      onNote: setNote,
      seenElsewhere: (record) => (hooks.current.seenElsewhere ? hooks.current.seenElsewhere(record) : false),
      onMarked: (record) => { if (hooks.current.onMarked) hooks.current.onMarked(record) }
    })
  }
  useEffect(() => {
    const active = monitor.current
    active.update({ enabled, member, request })
    return () => active.stop()
  }, [enabled, member, request])
  const markSeen = useCallback((record) => monitor.current.markSeen(record), [])
  const dismiss = useCallback(() => monitor.current.dismiss(), [])
  const recheck = useCallback(() => monitor.current.recheck(), [])
  return { note: enabled && note && note.member === member ? note : null, markSeen, dismiss, recheck }
}
