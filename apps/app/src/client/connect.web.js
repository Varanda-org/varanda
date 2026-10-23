// Web: connectNode runs the node in this page (./browser), or talks to
// varanda-serve (./web) when the page was opened at its address (./mode).

import { webMode } from './mode'
import { connectBrowserNode } from './browser'
import { connectNode as connectServe } from './web'

export function connectNode (config, options) {
  return webMode === 'serve' ? connectServe(config, options) : connectBrowserNode(config, options)
}
