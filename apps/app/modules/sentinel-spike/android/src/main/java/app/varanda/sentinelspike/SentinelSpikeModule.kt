package app.varanda.sentinelspike

import ai.onnxruntime.OnnxJavaType
import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtLoggingLevel
import ai.onnxruntime.OrtSession
import ai.onnxruntime.TensorInfo
import android.content.pm.ApplicationInfo
import android.os.Debug
import android.os.SystemClock
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileInputStream
import java.io.FileNotFoundException
import java.nio.LongBuffer
import java.nio.file.Files
import java.nio.file.LinkOption
import java.security.MessageDigest
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

// Dev-only measurement spike: a pinned model on ONNX Runtime (CPU), to
// measure load time, inference time and memory on a real phone. Product code
// never calls it. load takes a model key from a fixed allowlist (embed: the
// account service's MiniLM embedder, nli: a zero-shot NLI classifier), and
// the model is read only from that key's fixed file in <filesDir>/sentinel
// (never a path from JS). Its sha256 is streamed and compared with the
// caller's pin before the session is created. One model is loaded at a time.
// Nothing is logged (ONNX Runtime at FATAL) and nothing touches the network.
// Every operation runs on one worker thread, one at a time (BUSY otherwise).
// Native error text never reaches JS. Unless the host app is debuggable (its
// own ApplicationInfo, not this library's BuildConfig), isAvailable is false
// and every call rejects UNSUPPORTED: the spike runs in debug builds only.
class SentinelSpikeModule : Module() {
  companion object {
    private const val DIM = 384
    // The account service's MAX_TOKENS and the pinned tokenizer's vocabulary
    // size, then the NLI pair limit, the vocabulary of the on-device MiniLM
    // NLI model (multilingual-MiniLMv2-L6-mnli-xnli, 250002 entries) and the
    // accepted label counts (see modules/sentinel-spike/index.js).
    private const val MAX_TOKENS = 128
    private const val VOCAB_SIZE = 250_002
    private const val MAX_PAIR_TOKENS = 256
    private const val NLI_VOCAB_SIZE = 250_002
    private const val MIN_LABELS = 2
    private const val MAX_LABELS = 8
    private const val MAX_THREADS = 4
    private const val CHUNK_BYTES = 1 shl 20
    private const val DIR = "sentinel"

    // One environment for the process, created on first use at FATAL.
    // getEnvironment(level, name) logs a warning when the environment
    // already exists, so it is called once and the instance reused.
    private val ENV: OrtEnvironment by lazy {
      OrtEnvironment.getEnvironment(OrtLoggingLevel.ORT_LOGGING_LEVEL_FATAL, "sentinel-spike")
    }
  }

  // The only models load accepts. JS names a key; the file name and the
  // output the session must have are fixed here.
  private enum class Kind(val key: String, val fileName: String, val output: String) {
    EMBED("embed", "model_quantized.onnx", "last_hidden_state"),
    NLI("nli", "nli_quantized.onnx", "logits");

    companion object {
      fun named(key: String): Kind? = values().firstOrNull { it.key == key }
    }
  }

  private class Missing : Exception()
  private class PinMismatch : Exception()

  private class Loaded(val session: OrtSession, val tokenTypes: Boolean, val kind: Kind)

  private val busy = AtomicBoolean(false)
  private val worker: ExecutorService = Executors.newSingleThreadExecutor { task ->
    Thread(task, "SentinelSpike")
  }

  // Read and written only on `worker`.
  private var loaded: Loaded? = null

  override fun definition() = ModuleDefinition {
    Name("SentinelSpike")

    Function("isAvailable") {
      enabled()
    }

    AsyncFunction("load") { model: String, expected: String, threads: Double, promise: Promise ->
      if (!enabled()) {
        promise.reject("UNSUPPORTED", "unsupported", null)
        return@AsyncFunction
      }
      val kind = Kind.named(model)
      if (kind == null || !isSha256Hex(expected) || !threads.isFinite() || threads != Math.rint(threads)) {
        promise.reject("INVALID", "invalid", null)
        return@AsyncFunction
      }
      val count = threads.coerceIn(1.0, MAX_THREADS.toDouble()).toInt()
      // No app storage means this environment cannot host the model at all
      // (UNSUPPORTED, as on iOS without Documents); MISSING is kept for a
      // model file that is absent.
      val filesDir = appContext.reactContext?.filesDir
      if (filesDir == null) {
        promise.reject("UNSUPPORTED", "unsupported", null)
        return@AsyncFunction
      }
      val file = File(File(filesDir, DIR), kind.fileName)
      submit(promise) {
        val start = SystemClock.elapsedRealtimeNanos()
        // The old session goes first, so the memory reading after a reload
        // is not two models.
        closeLoaded()
        val bytes = try {
          checkPin(file, expected)
        } catch (e: Missing) {
          return@submit Answer.Reject("MISSING")
        } catch (e: PinMismatch) {
          return@submit Answer.Reject("PIN")
        }
        loaded = open(file, count, kind)
        Answer.Resolve(mapOf("loadMs" to msSince(start), "fileBytes" to bytes.toDouble()))
      }
    }

    AsyncFunction("embed") { ids: List<Double>, mask: List<Double>, promise: Promise ->
      if (!enabled()) {
        promise.reject("UNSUPPORTED", "unsupported", null)
        return@AsyncFunction
      }
      val tokens = tokens(ids, mask, MAX_TOKENS, VOCAB_SIZE)
      if (tokens == null) {
        promise.reject("INVALID", "invalid", null)
        return@AsyncFunction
      }
      submit(promise) {
        val current = loaded ?: return@submit Answer.Reject("NOT_LOADED")
        if (current.kind != Kind.EMBED) return@submit Answer.Reject("WRONG_MODEL")
        val start = SystemClock.elapsedRealtimeNanos()
        val hidden = hidden(current, tokens.first, tokens.second)
        val inferMs = msSince(start)
        val vector = poolAndNormalize(hidden, tokens.second) ?: return@submit Answer.Reject("FAILED")
        Answer.Resolve(mapOf("vector" to vector.toList(), "inferMs" to inferMs))
      }
    }

    // JS always sends typeIds, null when absent.
    AsyncFunction("classify") { ids: List<Double>, mask: List<Double>, typeIds: List<Double>?, promise: Promise ->
      if (!enabled()) {
        promise.reject("UNSUPPORTED", "unsupported", null)
        return@AsyncFunction
      }
      val tokens = tokens(ids, mask, MAX_PAIR_TOKENS, NLI_VOCAB_SIZE)
      val types = typeIds?.let { bits(it) }
      if (tokens == null || (typeIds != null && (types == null || types.size != ids.size))) {
        promise.reject("INVALID", "invalid", null)
        return@AsyncFunction
      }
      submit(promise) {
        val current = loaded ?: return@submit Answer.Reject("NOT_LOADED")
        if (current.kind != Kind.NLI) return@submit Answer.Reject("WRONG_MODEL")
        val start = SystemClock.elapsedRealtimeNanos()
        val logits = logits(current, tokens.first, tokens.second, types)
        val inferMs = msSince(start)
        Answer.Resolve(mapOf("logits" to logits.toList(), "inferMs" to inferMs))
      }
    }

    AsyncFunction("memory") { promise: Promise ->
      if (!enabled()) {
        promise.reject("UNSUPPORTED", "unsupported", null)
        return@AsyncFunction
      }
      val info = Debug.MemoryInfo()
      Debug.getMemoryInfo(info)
      val bytes = info.totalPss.toLong() * 1024
      if (bytes > 0) {
        promise.resolve(mapOf("bytes" to bytes.toDouble()))
      } else {
        promise.reject("FAILED", "failed", null)
      }
    }

    AsyncFunction("unload") { promise: Promise ->
      if (!enabled()) {
        promise.reject("UNSUPPORTED", "unsupported", null)
        return@AsyncFunction
      }
      submit(promise) {
        closeLoaded()
        Answer.Resolve(null)
      }
    }

    OnDestroy {
      try {
        worker.execute { closeLoaded() }
      } catch (e: Exception) {
      }
      worker.shutdown()
    }
  }

  // True only in a debuggable host app (a debug build); false without a
  // context.
  private fun enabled(): Boolean {
    val flags = appContext.reactContext?.applicationInfo?.flags ?: return false
    return (flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
  }

  private sealed class Answer {
    class Resolve(val value: Any?) : Answer()
    class Reject(val code: String) : Answer()
  }

  // Runs `work` on the worker unless another operation is running. Any
  // exception is FAILED. `busy` is freed before answering, so a call right
  // after the answer is not refused as BUSY.
  private fun submit(promise: Promise, work: () -> Answer) {
    if (!busy.compareAndSet(false, true)) {
      promise.reject("BUSY", "busy", null)
      return
    }
    try {
      worker.execute {
        val answer = try {
          work()
        } catch (e: Throwable) {
          Answer.Reject("FAILED")
        }
        busy.set(false)
        when (answer) {
          is Answer.Resolve -> promise.resolve(answer.value)
          is Answer.Reject -> promise.reject(answer.code, "failed", null)
        }
      }
    } catch (e: Exception) {
      busy.set(false)
      promise.reject("FAILED", "failed", null)
    }
  }

  private fun closeLoaded() {
    val current = loaded
    loaded = null
    try {
      current?.session?.close()
    } catch (e: Exception) {
    }
  }

  private fun isSha256Hex(text: String) =
    text.length == 64 && text.all { it in '0'..'9' || it in 'a'..'f' }

  private fun msSince(start: Long) = (SystemClock.elapsedRealtimeNanos() - start) / 1_000_000.0

  // Streams the file's sha256 in 1 MiB reads and compares it with the pin.
  // A missing path, a symlink or anything but a regular file is Missing, and
  // so is a file that vanishes before it can be opened (FileNotFoundException).
  // The file is opened again by path for the session; the window between the
  // two is inside the app's own private storage. A symlinked parent directory
  // is the same class of risk: only the app itself could plant it there.
  private fun checkPin(file: File, expected: String): Long {
    if (!Files.isRegularFile(file.toPath(), LinkOption.NOFOLLOW_LINKS)) throw Missing()
    val digest = MessageDigest.getInstance("SHA-256")
    var total = 0L
    val stream = try {
      FileInputStream(file)
    } catch (e: FileNotFoundException) {
      throw Missing()
    }
    stream.use { input ->
      val buffer = ByteArray(CHUNK_BYTES)
      while (true) {
        val read = input.read(buffer)
        if (read < 0) break
        digest.update(buffer, 0, read)
        total += read
      }
    }
    val hex = digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
    if (total <= 0 || hex != expected) throw PinMismatch()
    return total
  }

  // A CPU session, or an exception unless the inputs are int64 input_ids
  // and attention_mask, plus optional int64 token_type_ids, and it has its
  // kind's output (last_hidden_state for embed, logits for nli).
  private fun open(file: File, threads: Int, kind: Kind): Loaded {
    val session = OrtSession.SessionOptions().use { options ->
      options.setIntraOpNumThreads(threads)
      options.setInterOpNumThreads(1)
      options.setExecutionMode(OrtSession.SessionOptions.ExecutionMode.SEQUENTIAL)
      options.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
      options.setSessionLogLevel(OrtLoggingLevel.ORT_LOGGING_LEVEL_FATAL)
      ENV.createSession(file.absolutePath, options)
    }
    try {
      val inputs = session.inputInfo
      val known = setOf("input_ids", "attention_mask", "token_type_ids")
      val int64 = inputs.values.all { (it.info as? TensorInfo)?.type == OnnxJavaType.INT64 }
      if (!known.containsAll(inputs.keys) || !inputs.containsKey("input_ids") ||
        !inputs.containsKey("attention_mask") || !int64 || kind.output !in session.outputNames) {
        throw IllegalStateException()
      }
      return Loaded(session, inputs.containsKey("token_type_ids"), kind)
    } catch (e: Exception) {
      session.close()
      throw e
    }
  }

  // Runs one sequence and hands the kind's output to `read` while it is
  // still open. token_type_ids, when the model takes them, are the caller's
  // or zeros.
  private fun <T> infer(current: Loaded, ids: LongArray, mask: LongArray, types: LongArray?, read: (OnnxTensor) -> T): T {
    val shape = longArrayOf(1, ids.size.toLong())
    val tensors = mutableMapOf<String, OnnxTensor>()
    try {
      tensors["input_ids"] = OnnxTensor.createTensor(ENV, LongBuffer.wrap(ids), shape)
      tensors["attention_mask"] = OnnxTensor.createTensor(ENV, LongBuffer.wrap(mask), shape)
      if (current.tokenTypes) {
        tensors["token_type_ids"] = OnnxTensor.createTensor(ENV, LongBuffer.wrap(types ?: LongArray(ids.size)), shape)
      }
      OrtSession.RunOptions().use { run ->
        run.setLogLevel(OrtLoggingLevel.ORT_LOGGING_LEVEL_FATAL)
        current.session.run(tensors, setOf(current.kind.output), run).use { result ->
          val value = result.get(current.kind.output).orElse(null) as? OnnxTensor ?: throw IllegalStateException()
          return read(value)
        }
      }
    } finally {
      for (tensor in tensors.values) tensor.close()
    }
  }

  // last_hidden_state for one sequence, exactly [1, n, DIM] floats.
  private fun hidden(current: Loaded, ids: LongArray, mask: LongArray): FloatArray {
    if (current.kind != Kind.EMBED) throw IllegalStateException()
    return infer(current, ids, mask, null) { value ->
      val info = value.info
      val dims = info.shape
      if (info.type != OnnxJavaType.FLOAT || dims.size != 3 || dims[0] != 1L ||
        dims[1] != ids.size.toLong() || dims[2] != DIM.toLong()) {
        throw IllegalStateException()
      }
      val buffer = value.floatBuffer
      if (buffer.remaining() != ids.size * DIM) throw IllegalStateException()
      val out = FloatArray(ids.size * DIM)
      buffer.get(out)
      out
    }
  }

  // The raw logits of one pair: exactly [1, k] floats, MIN_LABELS <= k <=
  // MAX_LABELS, all finite.
  private fun logits(current: Loaded, ids: LongArray, mask: LongArray, types: LongArray?): DoubleArray {
    if (current.kind != Kind.NLI) throw IllegalStateException()
    return infer(current, ids, mask, types) { value ->
      val info = value.info
      val dims = info.shape
      if (info.type != OnnxJavaType.FLOAT || dims.size != 2 || dims[0] != 1L ||
        dims[1] < MIN_LABELS.toLong() || dims[1] > MAX_LABELS.toLong()) {
        throw IllegalStateException()
      }
      val k = dims[1].toInt()
      val buffer = value.floatBuffer
      if (buffer.remaining() != k) throw IllegalStateException()
      val floats = FloatArray(k)
      buffer.get(floats)
      DoubleArray(k) { i ->
        val v = floats[i]
        if (!v.isFinite()) throw IllegalStateException()
        v.toDouble()
      }
    }
  }

  // One tokenized input: the same non-empty length up to maxTokens, whole ids
  // below vocabSize, a 0/1 mask with at least one 1.
  private fun tokens(ids: List<Double>, mask: List<Double>, maxTokens: Int, vocabSize: Int): Pair<LongArray, LongArray>? {
    if (ids.isEmpty() || ids.size > maxTokens || ids.size != mask.size) return null
    val outIds = LongArray(ids.size)
    for ((i, id) in ids.withIndex()) {
      if (!id.isFinite() || id != Math.rint(id) || id < 0 || id >= vocabSize) return null
      outIds[i] = id.toLong()
    }
    val outMask = bits(mask) ?: return null
    if (outMask.none { it == 1L }) return null
    return Pair(outIds, outMask)
  }

  // Each value 0 or 1, else null.
  private fun bits(values: List<Double>): LongArray? {
    val out = LongArray(values.size)
    for ((i, v) in values.withIndex()) {
      if (v != 0.0 && v != 1.0) return null
      out[i] = v.toLong()
    }
    return out
  }

  // Attention-mask-aware mean pooling over [1, n, DIM], then L2
  // normalization, as apps/cli/lib/account/ai/embed-child.js does; null when
  // nothing is usable (no unmasked token, a non-finite value, a zero norm).
  private fun poolAndNormalize(hidden: FloatArray, mask: LongArray): DoubleArray? {
    if (hidden.size != mask.size * DIM) return null
    val sum = DoubleArray(DIM)
    var used = 0
    for (t in mask.indices) {
      if (mask[t] == 0L) continue
      used++
      val offset = t * DIM
      for (d in 0 until DIM) sum[d] += hidden[offset + d].toDouble()
    }
    if (used == 0) return null
    var norm = 0.0
    for (d in 0 until DIM) {
      sum[d] /= used
      norm += sum[d] * sum[d]
    }
    norm = Math.sqrt(norm)
    if (!norm.isFinite() || norm == 0.0) return null
    val out = DoubleArray(DIM)
    for (d in 0 until DIM) {
      val v = sum[d] / norm
      if (!v.isFinite()) return null
      out[d] = v
    }
    return out
  }
}
