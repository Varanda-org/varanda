// Turning Web Push off before this device's identity is replaced (Identidade:
// "apagar e recomeçar", "criar mesmo assim"), as Ajustes does for Sair. The
// old subscription is registered to the old member: left behind it would keep
// delivering that member's notices to whoever uses the browser next. Best
// effort: a failure never blocks the switch, and nothing is retried here.
// Pure: no React and no browser.

export async function turnOffBeforeSwitch (turnOff, args) {
  if (typeof turnOff !== 'function') return
  try {
    await turnOff(args)
  } catch {}
}
