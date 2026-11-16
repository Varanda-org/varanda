// Web: no native session store. The browser node keeps its own sign-in
// (packages/web-member/lib/session-store.js) and the cold-start preview that
// reads the native one (App.js) never runs here, since previewCapable is
// false in ./feedSnapshotStore.web.js (and, for now, natively too). This twin only lets the shared App.js resolve
// './src/sessionStore' in the web bundle: it never holds a session.

export const sessionStore = {
  load: async () => null,
  hasLive: async () => false
}
