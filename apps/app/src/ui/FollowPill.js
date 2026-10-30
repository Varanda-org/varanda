// The sheet is the trigger's own child so it nests in whichever Modal is
// open, as in Help.js. Cancelar sends nothing, so dismissal is safe.

import { useEffect, useState } from 'react'
import { Text, View } from 'react-native'
import { Sheet } from './Sheet'
import { Btn, Soft } from './index'
import { Pill } from './Pill'
import { colors, type } from './theme'
import { FOLLOW_LABEL, FOLLOWING_LABEL, UNFOLLOW_LABEL, UNFOLLOW_NOTE, unfollowQuestion } from '../follow'

export function FollowPill ({ following, title, pending, disabled, onFollow, onUnfollow }) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (following !== true) setOpen(false)
  }, [following])

  if (following !== true) {
    return (
      <Pill
        label={FOLLOW_LABEL}
        filled
        onPress={onFollow}
        pending={pending}
        disabled={disabled || following === null}
        accessibilityLabel={'seguir ' + title}
      />
    )
  }

  return (
    <>
      <Pill
        label={FOLLOWING_LABEL}
        onPress={() => setOpen(true)}
        pending={pending}
        disabled={disabled}
        accessibilityLabel={'deixar de seguir ' + title}
      />
      {open
        ? (
          <Sheet open onClose={() => setOpen(false)} title={FOLLOWING_LABEL}>
            <View style={{ padding: 16, gap: 12 }}>
              <Text accessibilityRole='header' style={{ ...type.sheetTitle, color: colors.ink }}>{unfollowQuestion(title)}</Text>
              <Soft>{UNFOLLOW_NOTE}</Soft>
              <Btn
                danger
                label={UNFOLLOW_LABEL}
                onPress={() => {
                  setOpen(false)
                  onUnfollow()
                }}
              />
              <Btn secondary label='Cancelar' onPress={() => setOpen(false)} />
            </View>
          </Sheet>
          )
        : null}
    </>
  )
}
