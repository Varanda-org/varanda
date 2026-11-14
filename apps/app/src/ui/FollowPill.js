// The sheet is the trigger's own child so it nests in whichever Modal is
// open, as in Help.js. Cancelar sends nothing, so dismissal is safe.
// A press flips the pill at once but calls the caller exactly once: the
// caller owns the one request and its re-read, and nothing here resends it.

import { useEffect, useRef, useState } from 'react'
import { Text, View } from 'react-native'
import { Sheet } from './Sheet'
import { Btn, Soft } from './index'
import { Pill } from './Pill'
import { type } from './theme'
import { useTheme } from './ThemeProvider'
import { tap } from './haptics'
import { FOLLOW_LABEL, FOLLOWING_LABEL, UNFOLLOW_LABEL, UNFOLLOW_NOTE, followView, unfollowQuestion } from '../follow'

export function FollowPill ({ following, title, pending, disabled, onFollow, onUnfollow, label = FOLLOW_LABEL, small }) {
  const { colors } = useTheme()
  const [open, setOpen] = useState(false)
  const [intent, setIntent] = useState(null)
  // State lands on the next render; two presses in one frame both see it
  // unset, so the press is held in a ref too.
  const pressed = useRef(false)
  const view = followView({ following, pending, intent })

  // Callers set `pending` in the same handler as the press, so the commit
  // that shows the press shows it pending; once it is not, the request has
  // settled (or never started) and the caller's `following` is the truth.
  // Only this render's own intent is cleared: an effect running late must
  // not wipe a press made after its render.
  useEffect(() => {
    if (pending !== true && intent !== null) {
      pressed.current = false
      setIntent(null)
    }
  }, [pending, intent])

  useEffect(() => {
    if (view.following !== true) setOpen(false)
  }, [view.following])

  const press = (on, call) => {
    if (pressed.current || view.busy || disabled || following === null) return
    pressed.current = true
    setIntent(on)
    call()
  }

  if (view.following !== true) {
    return (
      <Pill
        label={label}
        filled
        small={small}
        onPress={() => press(true, () => {
          tap('light')
          onFollow()
        })}
        pending={view.busy}
        disabled={disabled || following === null}
        accessibilityLabel={'seguir ' + title}
      />
    )
  }

  return (
    <>
      <Pill
        label={FOLLOWING_LABEL}
        small={small}
        onPress={() => {
          if (!view.busy) setOpen(true)
        }}
        pending={view.busy}
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
                  press(false, onUnfollow)
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
