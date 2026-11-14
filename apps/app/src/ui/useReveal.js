import { useEffect, useRef, useState } from 'react'
import { Animated } from 'react-native'
import { useReduceMotion } from './StackLayer'
import { motion } from './theme'

// Fades a provider player in once it is ready. A player that mounts ready
// never fades (settled starts true); only a later false -> true change does.
// settled turns true `linger` ms after the fade ends, so a cover underneath can
// stay for a moment.
export function useReveal (ready, linger = 0) {
  const reduceMotion = useReduceMotion()
  const opacity = useRef(new Animated.Value(ready ? 1 : 0)).current
  const [settled, setSettled] = useState(ready === true)
  const run = useRef(null)
  const timer = useRef(null)
  // A stale completion must not set state after a newer run or an unmount.
  const counter = useRef(0)

  const cancel = () => {
    counter.current++
    if (run.current) run.current.stop()
    run.current = null
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  const settle = (id) => {
    if (id !== counter.current) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      if (id === counter.current) setSettled(true)
    }, linger)
  }

  useEffect(() => {
    if (!ready) {
      cancel()
      opacity.setValue(0)
      setSettled(false)
      return
    }
    // Already fully shown: mounted ready, or settled by an earlier run.
    if (settled && !run.current && !timer.current) return
    cancel()
    const id = counter.current
    if (reduceMotion) {
      opacity.setValue(1)
      settle(id)
      return
    }
    // JS driver: react-native-web has no native driver and warns if asked.
    // isInteraction false: a feed of fades must not hold the list window (loopMotion).
    const anim = Animated.timing(opacity, {
      toValue: 1,
      duration: motion.fast,
      useNativeDriver: false,
      isInteraction: false
    })
    run.current = anim
    anim.start(({ finished }) => {
      if (id !== counter.current) return
      run.current = null
      if (finished === true) settle(id)
    })
  }, [ready, reduceMotion])

  useEffect(() => cancel, [])

  return { opacity, settled }
}
