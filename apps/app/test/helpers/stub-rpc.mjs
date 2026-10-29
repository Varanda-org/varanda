import { createRequire } from 'node:module'

// @varanda/rpc is CommonJS and Node cannot see all its named exports (Metro
// does); the real package, re-exported by name.
const rpc = createRequire(import.meta.url)('@varanda/rpc')
export const { createClient, encodeFrame, createFrameDecoder, MAX_REQUEST, MAX_MESSAGE, EVENTS } = rpc
