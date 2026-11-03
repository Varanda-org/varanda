package app.varanda.faceliveness

import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

// The guest credentials and the session id live only in this process's
// memory: an Intent extra, savedInstanceState or a file could outlive the
// capture (or reach another process), so the module hands them over here
// right before it starts the Activity, which takes them exactly once.
data class CaptureInput(
  val sessionId: String,
  val region: String,
  val accessKeyId: String,
  val secretAccessKey: String,
  val sessionToken: String,
  val expiration: Long
) {
  // Keeps the secrets out of any string a crash report or a debugger prints.
  override fun toString(): String = "CaptureInput"

  companion object {
    private val slot = AtomicReference<CaptureInput?>(null)

    // The cancel signal outlives a listener that is not registered yet: a
    // cancel() between launch and the Activity's onCreate still closes it.
    private val active = AtomicBoolean(false)
    private val cancelled = AtomicBoolean(false)
    private val canceller = AtomicReference<Runnable?>(null)

    fun put(input: CaptureInput) {
      cancelled.set(false)
      active.set(true)
      slot.set(input)
    }

    fun take(): CaptureInput? = slot.getAndSet(null)

    fun clear() {
      slot.set(null)
    }

    // The capture is over (result delivered or never launched).
    fun finished() {
      active.set(false)
      cancelled.set(false)
      slot.set(null)
    }

    // Does nothing when no capture runs. The listener may run twice in a
    // race, so the Activity's finish must be idempotent.
    fun requestCancel() {
      if (!active.get()) return
      cancelled.set(true)
      canceller.get()?.run()
    }

    fun onCancel(listener: Runnable?) {
      canceller.set(listener)
      if (listener != null && cancelled.get()) listener.run()
    }
  }
}
