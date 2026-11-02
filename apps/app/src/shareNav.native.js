import { Platform, Share } from 'react-native'
import * as Clipboard from 'expo-clipboard'

// copyText (share.js) copies only when nav.clipboard.writeText is a function,
// so without it every native copy fails. Write only: no read, no listener.
export function shareNav () {
  return {
    clipboard: {
      writeText (text) {
        return Clipboard.setStringAsync(text)
      }
    },
    share ({ title, url }) {
      // Android shares only message and iOS shares url; giving iOS both makes
      // two items and the link shows twice in Mail and similar targets.
      const content = Platform.OS === 'ios' ? { title, url } : { title, message: url }
      const pending = Share.share(content)
      return pending.then((result) => {
        if (result.action === Share.sharedAction) return
        if (result.action === Share.dismissedAction) {
          const err = new Error('dismissed')
          err.name = 'AbortError'
          throw err
        }
        throw new Error('share failed')
      })
    }
  }
}
