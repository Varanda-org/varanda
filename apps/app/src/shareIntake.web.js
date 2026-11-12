// The share sheet is a native target. These no-ops keep callers free of
// platform checks, and this file reads no browser global so Node can import it.

export async function peek () {
  return null
}

export async function release () {}

export async function sweep () {}

export function listen () {
  return function () {}
}
