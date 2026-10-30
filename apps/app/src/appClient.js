// Whether this bundle is the native app talking to an installation over the
// network rather than the hosted page on its own origin. The account and
// report clients read it, so no screen has to pass it along. No imports:
// Metro bundles the file and the tests load it with import().

let app = false

export function setAppClient (on) {
  app = on === true
}

export function isAppClient () {
  return app
}
