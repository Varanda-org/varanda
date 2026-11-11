// iOS/Android: A Rua's snapshot refreshed in the background
// (./backgroundRefresh.js), and the foreground gate (./foregroundGate.js).
// Imported by index.js before registerRootComponent, since a background
// launch runs the task executor without ever showing the app.
//
// The task runs without the identity: this module never imports the
// identity, the session store or any keychain module, and the run reads no
// DM and no notice (see ./backgroundRefresh.js). It runs only in a process
// that was never active: once the app was in the foreground, the boot
// (src/node.js) owns the node, and a run already going is cancelled by
// cancelBackgroundRefresh() before the boot starts a worklet, since only one
// worklet may exist (./client/native.js startNode).
//
// Registered after the first live A Rua page of a hosted session (App.js),
// unregistered by every wipe of the local caches (sign-out, lock, reset,
// another installation or owner), so no task stays registered without a
// snapshot to refresh.

import { AppState } from 'react-native'
import * as TaskManager from 'expo-task-manager'
import * as BackgroundTask from 'expo-background-task'
import { fetch as expoFetch } from 'expo/fetch'
import { File, Paths } from 'expo-file-system'
import { createForegroundGate, lastUseFresh } from './foregroundGate'
import { runRefresh, shouldRun, BG_MIN_GAP_MS } from './backgroundRefresh'
import { parseSnapshot } from './feedSnapshot'
import { loadSnapshotText, saveSnapshotText } from './feedSnapshotStore'
import { loadConfig, loadInstallation, rememberedConfig } from './configStore'
import { installationOrigin } from './installation'
import { currentClient, startNode, terminateNode } from './client/native'
import { cacheGeneration, registerLocalCache } from './localCaches'
import { loadKept } from './media/keptLoad'
import * as keptStore from './media/keep'
import { fetchMedia } from './media/fetch'
import { checkAvatarBytes, validAvatar } from './media/avatar'
import { nativeSubtle } from './media/hash'

export const TASK_NAME = 'varanda-rua-refresh'
// expo-background-task takes minutes; the system treats it as a minimum.
export const MINIMUM_INTERVAL_MINUTES = BG_MIN_GAP_MS / 60000

const gate = createForegroundGate({
  state: () => AppState.currentState,
  subscribe: (fn) => {
    const sub = AppState.addEventListener('change', fn)
    return () => sub.remove()
  }
})

// Whether this process was ever active, and a promise of its first 'active'.
export const foregroundSeen = () => gate.seen()
export const whenForeground = () => gate.wait()
// The app active right now: right before a start that may read the keychain.
export const whenActive = () => gate.waitActive()

// When the app was last opened, next to A Rua's snapshot (the app's
// document dir): { v: 1, at }. Written by every foreground start and every
// registration; the task stops for good when it is missing or too old.
const LAST_USE_FILE = 'varanda-last-open.json'

function lastUseFile () {
  return new File(Paths.document, LAST_USE_FILE)
}

// -> the recorded ms, or null. Never throws.
function readLastUse () {
  try {
    const f = lastUseFile()
    if (!f.exists) return null
    const text = f.textSync()
    if (typeof text !== 'string' || text.length > 100) return null
    const value = JSON.parse(text)
    return value !== null && typeof value === 'object' && value.v === 1 && Number.isSafeInteger(value.at) ? value.at : null
  } catch {
    return null
  }
}

// Never throws.
export function noteForegroundUse () {
  try {
    const f = lastUseFile()
    if (!f.exists) f.create()
    f.write(JSON.stringify({ v: 1, at: Date.now() }))
  } catch {}
}

function forgetLastUse () {
  try {
    const f = lastUseFile()
    if (f.exists) f.delete()
  } catch {}
}

// The run in flight: { controller, done } where done resolves once its node
// is stopped (settle included), or null.
let running = null

async function refresh () {
  // A process that was active owns its node: the run never competes with it.
  if (gate.seen()) return BackgroundTask.BackgroundTaskResult.Success
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  let resolveDone
  const done = new Promise((resolve) => { resolveDone = resolve })
  const own = { controller, done }
  running = own
  try {
    // A device no longer opened stops refreshing (and syncing) for good.
    if (!lastUseFresh(readLastUse(), Date.now())) {
      await unregisterBackgroundRefresh()
      return BackgroundTask.BackgroundTaskResult.Success
    }
    // A saved manual (core) configuration takes precedence at boot: the
    // hosted account it replaced is not refreshed.
    if ((await loadConfig()) !== null) {
      await unregisterBackgroundRefresh()
      return BackgroundTask.BackgroundTaskResult.Success
    }
    if (installationOrigin() === null) await loadInstallation()
    const config = await rememberedConfig()
    if (controller !== null && controller.signal.aborted) return BackgroundTask.BackgroundTaskResult.Success
    const origin = installationOrigin()
    const c = config && typeof config === 'object' && config.config && typeof config.config === 'object' ? config.config : config
    // Without an owner: runRefresh checks node.info against snapshot.owner.
    const snapshot = c && typeof c === 'object' ? parseSnapshot(loadSnapshotText(), { origin, association: c.association, now: Date.now() }) : null
    const lastRunMs = snapshot !== null ? snapshot.savedAt : null
    if (!shouldRun({ snapshot, config, nodeRunning: currentClient() !== null, nowMs: Date.now(), lastRunMs })) {
      return BackgroundTask.BackgroundTaskResult.Success
    }
    const result = await runRefresh({
      snapshot,
      config,
      start: (cfg, { onEvent }) => startNode(cfg, { onEvent }),
      stop: () => terminateNode(),
      saveSnapshot: saveSnapshotText,
      cacheGeneration,
      kept: {
        keptUrl: keptStore.keptUrl,
        keep: keptStore.keep,
        fetchBytes: null,
        validateAvatar: (bytes, d) => validAvatar(d) && checkAvatarBytes(bytes, d)
      },
      // The /media URL names the author, which loadKept does not hand to
      // fetchBytes: it is bound here per photo.
      loadKept: (args) => loadKept({ ...args, fetchBytes: (d) => fetchMedia(args.author, d, { subtle: nativeSubtle, persist: true, fetch: expoFetch }) }),
      signal: controller !== null ? controller.signal : null
    })
    // A start that never settled: its node is stopped once it is up, and
    // nothing may start another one before then.
    if (result.stopped === false && result.settle) await result.settle
    return result.ok ? BackgroundTask.BackgroundTaskResult.Success : BackgroundTask.BackgroundTaskResult.Failed
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed
  } finally {
    if (running === own) running = null
    resolveDone()
  }
}

TaskManager.defineTask(TASK_NAME, refresh)

// Aborts a run in flight and resolves once its node is stopped. Never
// rejects.
export async function cancelBackgroundRefresh () {
  const run = running
  if (run === null) return
  try { if (run.controller !== null) run.controller.abort() } catch {}
  await run.done
}

// Register and unregister calls are chained, so a wipe right after a
// register always ends unregistered.
let chain = Promise.resolve()
let registered = false

export function registerBackgroundRefresh () {
  noteForegroundUse()
  if (registered) return chain
  registered = true
  chain = chain.then(() => BackgroundTask.registerTaskAsync(TASK_NAME, { minimumInterval: MINIMUM_INTERVAL_MINUTES })).catch(() => {
    registered = false
  })
  return chain
}

export function unregisterBackgroundRefresh () {
  registered = false
  chain = chain.then(async () => {
    if (await TaskManager.isTaskRegisteredAsync(TASK_NAME)) await BackgroundTask.unregisterTaskAsync(TASK_NAME)
  }).catch(() => {})
  return chain
}

// Every wipe of the local caches unregisters: the snapshot it refreshes is
// gone, or belongs to an identity or installation no longer in force.
registerLocalCache({
  wipe: () => {
    forgetLastUse()
    return unregisterBackgroundRefresh()
  }
})
