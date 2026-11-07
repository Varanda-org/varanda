// Web: connectNode runs the node in this page (./browser), or talks to
// varanda-serve (./web) when the page was opened at its address (./mode).
/* global __DEV__ */

import { webMode } from './mode'
import { connectBrowserNode, preloadNode } from './browser'
import { connectNode as connectServe } from './web'
import { vitrineEnabled } from '../vitrine/enabled'

// Ask for the node script before /varanda.json answers. varanda-serve, the
// Vitrine and a render without document never run this node. The literal
// member access is what Expo inlines.
const VITRINE = vitrineEnabled({ EXPO_PUBLIC_VARANDA_VITRINE: process.env.EXPO_PUBLIC_VARANDA_VITRINE }, typeof __DEV__ !== 'undefined' && __DEV__)
if (webMode !== 'serve' && typeof document !== 'undefined' && !VITRINE) preloadNode()

export function connectNode (config, options) {
  return webMode === 'serve' ? connectServe(config, options) : connectBrowserNode(config, options)
}
