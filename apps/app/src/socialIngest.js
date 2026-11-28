export async function firstReads ({ together, engagement, resolve }) {
  if (together !== true) {
    await engagement()
    await resolve()
    return
  }
  let failed = false
  let firstError
  await Promise.all([engagement, resolve].map(async (read) => {
    try {
      await read()
    } catch (err) {
      if (!failed) {
        failed = true
        firstError = err
      }
    }
  }))
  if (failed) throw firstError
}
