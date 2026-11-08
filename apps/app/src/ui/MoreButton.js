// The "mais ações" button: a 44 pt IconAction that owns an ActionsSheet.
// Renders nothing when no action is usable.

import { useState } from 'react'
import { ActionsSheet, usableActions } from './ActionsSheet'
import { IconAction } from './TopActions'

export function MoreButton ({ label = 'mais ações', title, actions }) {
  const [open, setOpen] = useState(false)
  if (usableActions(actions).length === 0) return null
  return (
    <>
      <IconAction icon='mais' label={label} onPress={() => setOpen(true)} />
      <ActionsSheet open={open} onClose={() => setOpen(false)} title={title} actions={actions} />
    </>
  )
}
