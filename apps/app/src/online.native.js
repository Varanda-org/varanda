// iOS/Android: what the operating system says about the network
// (@react-native-community/netinfo). Only a definite "not connected" counts
// as offline: an unknown state (null, not yet measured) is online, so the app
// never shows 'Sem internet' or queues a post on a guess. A seeder or HTTP
// failure is never turned into offline here.
//
// NetInfo's own reachability probe is turned off: it would send requests to a
// third party (clients3.google.com by default), and where that host is blocked
// but the installation is reachable it would report "no internet" and hold
// every post in the outbox. So isInternetReachable is ignored; the OS
// connection state (no traffic of its own) is the only signal.

import NetInfo from '@react-native-community/netinfo'
import { AppState } from 'react-native'

// NetInfo state -> boolean. Pure, so the tests need no native module.
export function onlineFromState (state) {
  if (state === null || typeof state !== 'object') return true
  return state.isConnected !== false
}

let configured = false
let last = null
// Bumped on every listener event: an older fetch() answer must not replace it.
let version = 0
const subscribers = new Set()
let stopNetInfo = null
let stopAppState = null

// Once, before the first fetch or listener (configure drops listeners added
// before it).
function setup () {
  if (configured) return
  configured = true
  try {
    NetInfo.configure({ reachabilityShouldRun: () => false })
  } catch {}
}

function apply (state) {
  const before = onlineFromState(last)
  last = state
  const now = onlineFromState(state)
  if (now === before) return
  for (const fn of [...subscribers]) {
    try { fn(now) } catch {}
  }
}

function refresh () {
  const asked = version
  try {
    Promise.resolve(NetInfo.fetch()).then((state) => {
      if (asked === version) apply(state)
    }, () => {})
  } catch {}
}

// The last known state; the first call asks NetInfo once in the background
// (the answer arrives later, until then the state is unknown: online).
let fetched = false
export function isOnline () {
  setup()
  if (!fetched) {
    fetched = true
    refresh()
  }
  return onlineFromState(last)
}

// iOS may miss network changes while the app is in the background, so the
// state is asked again on every return to the foreground. Both listeners
// live only while someone is subscribed.
function start () {
  try {
    const stop = NetInfo.addEventListener((state) => {
      version++
      apply(state)
    })
    stopNetInfo = typeof stop === 'function' ? stop : null
  } catch {}
  try {
    const sub = AppState.addEventListener('change', (status) => {
      if (status === 'active') refresh()
    })
    stopAppState = sub && typeof sub.remove === 'function' ? () => sub.remove() : null
  } catch {}
}

function stop () {
  for (const fn of [stopNetInfo, stopAppState]) {
    try { if (fn) fn() } catch {}
  }
  stopNetInfo = null
  stopAppState = null
}

// fn(isOnline()) on every change. -> unsubscribe.
export function subscribeOnline (fn) {
  setup()
  const entry = (value) => fn(value)
  subscribers.add(entry)
  if (subscribers.size === 1) start()
  return () => {
    if (!subscribers.delete(entry)) return
    if (subscribers.size === 0) stop()
  }
}
