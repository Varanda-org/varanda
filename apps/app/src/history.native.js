// Native counterpart of history.web.js: there is no browser history on iOS
// or Android (Android Back is handled with BackHandler in App.js), so the
// binding has the same API and does nothing.

export function bindHistory () {
  return {
    pushed () {},
    unbind () {}
  }
}
