package app.varanda.videoprep

import android.content.Context
import android.graphics.Bitmap
import android.media.MediaCodecInfo.CodecProfileLevel
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import androidx.media3.common.Effect
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.FrameDropEffect
import androidx.media3.effect.Presentation
import androidx.media3.transformer.AudioEncoderSettings
import androidx.media3.transformer.Composition
import androidx.media3.transformer.DefaultEncoderFactory
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.Effects
import androidx.media3.transformer.EncoderUtil
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.InAppMp4Muxer
import androidx.media3.transformer.Transformer
import androidx.media3.transformer.VideoEncoderSettings
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

class PrepareOptions : Record {
  @Field val maxMs: Double = 0.0
  @Field val maxBytes: Double = 0.0
  @Field val maxSide: Double = 0.0
  @Field val maxBitrate: Double = 0.0
}

// Re-encodes one picked video with Media3 Transformer (the media3 version
// expo-video declares): H.264 and AAC, always transcoded so no source stream
// (an odd AAC profile, HEVC, a timed metadata track) is copied through, long
// side at most maxSide, at most 30 fps, no metadata, into a plain MP4 written
// by Media3's own muxer, so the box tree is the same on every device. A
// source longer than maxMs is refused before encoding, and nothing past the
// length the container declares is encoded. A watchdog ends a run that
// grows far past maxBytes or outlives its deadline.
// The poster is the output's first frame. Both files stay in the app cache.
// Native error text and paths never reach JS or a log.
@androidx.annotation.OptIn(UnstableApi::class)
class VideoPrepModule : Module() {
  companion object {
    private const val TARGET_FPS = 30f
    // Room for a 30 fps clip whose frame count over the stated duration
    // comes out a little above 30.
    private const val FPS_SLACK = 0.5f
    private const val AUDIO_BITRATE = 96_000
    // Keeps a long clip with a small byte cap from asking the encoder for a
    // nonsensical rate; the size check after encoding still fails closed.
    private const val MIN_VIDEO_BITRATE = 100_000
    private const val POSTER_QUALITY = 85
    private const val DIR = "video-prep"
    // Upper bounds on the options: plan.js caps are far below these.
    private const val MAX_OPTION_MS = 10 * 60 * 1000.0
    private const val MAX_OPTION_BYTES = 256.0 * 1024 * 1024
    private const val MAX_OPTION_SIDE = 1920.0
    private const val MAX_OPTION_BITRATE = 20_000_000.0
    // The iOS values: an absolute limit from the start of the run, far above
    // the slowest real encode (a throttled phone, a long clip under a larger
    // option cap), 4 ms per source ms with a floor of 180 s.
    private const val MIN_DEADLINE_MS = 180_000L
    private const val DEADLINE_PER_SOURCE_MS = 4L
    private const val WATCHDOG_INTERVAL_MS = 1000L
  }

  private val busy = AtomicBoolean(false)

  // Guards `destroyed` and the hand-over of a new job to `current`, so
  // OnDestroy either sees the job and cancels it or prepare sees `destroyed`
  // and starts nothing.
  private val lifecycle = Any()
  private var destroyed = false

  @Volatile
  private var current: Job? = null

  override fun definition() = ModuleDefinition {
    Name("VideoPrep")

    Function("isAvailable") {
      appContext.reactContext != null
    }

    AsyncFunction("prepare") { uri: String, options: PrepareOptions, promise: Promise ->
      val source = sourceUri(uri)
      val limits = Limits.from(options)
      if (source == null || limits == null) {
        promise.reject("INVALID", "invalid", null)
        return@AsyncFunction
      }
      val context = appContext.reactContext?.applicationContext
      val dir = try {
        File(appContext.cacheDirectory, DIR)
      } catch (e: Exception) {
        null
      }
      if (context == null || dir == null) {
        promise.reject("UNSUPPORTED", "unsupported", null)
        return@AsyncFunction
      }
      if (!busy.compareAndSet(false, true)) {
        promise.reject("BUSY", "busy", null)
        return@AsyncFunction
      }
      val thread = HandlerThread("VideoPrep")
      try {
        synchronized(lifecycle) {
          if (destroyed) {
            busy.set(false)
            promise.reject("FAILED", "failed", null)
            return@AsyncFunction
          }
          thread.start()
          val job = Job(context, source, limits, dir, thread, promise)
          current = job
          if (!Handler(thread.looper).post { job.start() }) job.abort()
        }
      } catch (e: Exception) {
        thread.quitSafely()
        current = null
        busy.set(false)
        promise.reject("FAILED", "failed", null)
      }
    }

    OnDestroy {
      synchronized(lifecycle) {
        destroyed = true
        current?.cancel()
      }
    }
  }

  private fun sourceUri(uri: String): Uri? {
    return try {
      val parsed = Uri.parse(uri)
      val scheme = parsed.scheme
      if ((scheme == "content" || scheme == "file") && !parsed.path.isNullOrEmpty()) parsed else null
    } catch (e: Exception) {
      null
    }
  }

  private class Limits(val maxMs: Long, val maxBytes: Long, val maxSide: Int, val maxBitrate: Int) {
    companion object {
      private fun whole(x: Double, max: Double): Boolean =
        !x.isNaN() && x >= 1 && x <= max && x == Math.floor(x)

      fun from(o: PrepareOptions): Limits? {
        if (!whole(o.maxMs, MAX_OPTION_MS) || !whole(o.maxBytes, MAX_OPTION_BYTES) ||
          !whole(o.maxSide, MAX_OPTION_SIDE) || o.maxSide < 16 ||
          !whole(o.maxBitrate, MAX_OPTION_BITRATE)
        ) {
          return null
        }
        return Limits(o.maxMs.toLong(), o.maxBytes.toLong(), o.maxSide.toInt(), o.maxBitrate.toInt())
      }
    }
  }

  // Upright (display) size, duration and, when the container states it, the
  // number of video frames.
  private class Probe(val ms: Long, val width: Int, val height: Int, val frames: Int?) {
    fun fasterThan(fps: Float): Boolean = frames == null || frames * 1000.0 / ms > fps
  }

  private fun probe(setSource: (MediaMetadataRetriever) -> Unit): Probe? {
    val r = MediaMetadataRetriever()
    try {
      setSource(r)
      if (r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_VIDEO) != "yes") return null
      val ms = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: return null
      val w = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: return null
      val h = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: return null
      val rotation = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
      val frames = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_FRAME_COUNT)
        ?.toIntOrNull()?.takeIf { it > 0 }
      if (ms <= 0 || w <= 0 || h <= 0) return null
      return if (rotation % 180 != 0) Probe(ms, h, w, frames) else Probe(ms, w, h, frames)
    } catch (e: Exception) {
      return null
    } finally {
      try {
        r.release()
      } catch (e: Exception) {
        // Nothing to report.
      }
    }
  }

  // Everything below runs on the job's own HandlerThread, which is also the
  // Transformer's looper, so the listener callbacks and cancel never race.
  private inner class Job(
    private val context: Context,
    private val source: Uri,
    private val limits: Limits,
    private val dir: File,
    private val thread: HandlerThread,
    private val promise: Promise
  ) : Transformer.Listener {
    private val handler = Handler(thread.looper)
    private val name = UUID.randomUUID().toString()
    private val out = File(dir, "$name.mp4")
    private val poster = File(dir, "$name.jpg")
    private var transformer: Transformer? = null
    private var settled = false
    // True once the files were handed to JS, which reads and deletes them.
    private var resolved = false

    fun start() {
      // A cancel that ran first already answered and quit the looper.
      if (settled) return
      try {
        val input = probe { it.setDataSource(context, source) } ?: return fail("UNSUPPORTED")
        if (input.ms > limits.maxMs) return fail("TOO_LONG")
        if (!dir.isDirectory && !dir.mkdirs()) return fail("FAILED")
        removeLeftovers()
        val t = Transformer.Builder(context)
          .setLooper(thread.looper)
          // On by default from API 35: it reports editing events to the
          // platform, and the app sends no telemetry.
          .setUsePlatformDiagnostics(false)
          .setVideoMimeType(MimeTypes.VIDEO_H264)
          .setAudioMimeType(MimeTypes.AUDIO_AAC)
          // Upright frames and no rotation in the container; 960 on the long
          // side fits every H.264 encoder in either orientation.
          .setPortraitEncodingEnabled(true)
          .setEncoderFactory(
            DefaultEncoderFactory.Builder(context)
              // Non-default settings on both tracks make Transformer re-encode
              // them even when the source already is H.264 or AAC.
              .setRequestedVideoEncoderSettings(
                VideoEncoderSettings.Builder()
                  .setBitrate(videoBitrate(input.ms))
                  .setEncodingProfileLevel(avcProfile(), CodecProfileLevel.AVCLevel41)
                  .build()
              )
              .setRequestedAudioEncoderSettings(
                AudioEncoderSettings.Builder().setBitrate(AUDIO_BITRATE).build()
              )
              .build()
          )
          // MuxerWrapper hands the source's metadata (location among it) to
          // the muxer; the provider drops all of it before the file is closed.
          .setMuxerFactory(InAppMp4Muxer.Factory { entries -> entries.clear() })
          .addListener(this)
          .build()
        transformer = t
        t.start(composition(input), out.absolutePath)
        watch(SystemClock.uptimeMillis() + maxOf(MIN_DEADLINE_MS, DEADLINE_PER_SOURCE_MS * input.ms))
      } catch (e: Exception) {
        fail("FAILED")
      }
    }

    // On a thread that could not take the start message.
    fun abort() {
      settle { promise.reject("FAILED", "failed", null) }
    }

    fun cancel() {
      handler.post { stop() }
    }

    // Settled before the cancel: Transformer.cancel blocks until its own
    // thread answers, so a stuck codec then costs a thread, not the module.
    private fun stop() {
      val t = transformer
      fail("FAILED")
      try {
        t?.cancel()
      } catch (e: Exception) {
        // Already finished.
      }
    }

    // Media3's muxer may write the moov at the end and pre-extend mdat by
    // max(500 kB, 20 % of the file) at a time, trimmed when the file is
    // finished, so a running file can be larger than its final size. The
    // ceiling leaves room for that; the finished file is still held to
    // maxBytes. Once settled, quitSafely drops the next check.
    private fun watch(deadline: Long) {
      handler.postDelayed({
        if (!settled) {
          if (out.length() > growthCeiling() || SystemClock.uptimeMillis() >= deadline) stop() else watch(deadline)
        }
      }, WATCHDOG_INTERVAL_MS)
    }

    private fun growthCeiling(): Long = limits.maxBytes + maxOf(limits.maxBytes / 4, 2_000_000L)

    // A file JS failed to delete would otherwise stay in the cache for good.
    // Only one preparation runs at a time and JS has read and discarded the
    // previous one's files by then, so nothing here is still in use.
    private fun removeLeftovers() {
      try {
        dir.listFiles()?.forEach { if (it.isFile) it.delete() }
      } catch (e: Exception) {
        // A leftover that cannot be listed or deleted does not stop this run.
      }
    }

    // Without a requested level DefaultEncoderFactory asks the encoder for
    // the highest it supports, often 5.x, which the receiver refuses (above
    // 4.2). A request is kept only when the chosen encoder supports that
    // profile at that level; otherwise the factory drops it and the encoder
    // picks its own. So the profile asked for is one every AVC encoder here
    // supports at 4.1, and the factory still raises it to High when the
    // chosen encoder has High, keeping the 4.1 level.
    private fun avcProfile(): Int {
      val encoders = try {
        EncoderUtil.getSupportedEncoders(MimeTypes.VIDEO_H264)
      } catch (e: Exception) {
        return CodecProfileLevel.AVCProfileHigh
      }
      val profiles = listOf(
        CodecProfileLevel.AVCProfileHigh,
        CodecProfileLevel.AVCProfileMain,
        CodecProfileLevel.AVCProfileBaseline
      )
      return profiles.firstOrNull { profile ->
        encoders.isNotEmpty() && encoders.all {
          EncoderUtil.findHighestSupportedEncodingLevel(it, MimeTypes.VIDEO_H264, profile) >= CodecProfileLevel.AVCLevel41
        }
      } ?: CodecProfileLevel.AVCProfileHigh
    }

    private fun videoBitrate(ms: Long): Int {
      val seconds = ms / 1000.0
      val budget = minOf(limits.maxBitrate.toDouble(), 0.85 * limits.maxBytes * 8 / seconds)
      return maxOf(MIN_VIDEO_BITRATE, (budget - AUDIO_BITRATE).toInt())
    }

    private fun composition(input: Probe): Composition {
      val effects = mutableListOf<Effect>()
      val long = maxOf(input.width, input.height)
      if (long > limits.maxSide) {
        val scale = limits.maxSide.toDouble() / long
        effects.add(
          Presentation.createForWidthAndHeight(
            even(input.width * scale),
            even(input.height * scale),
            Presentation.LAYOUT_STRETCH_TO_FIT
          )
        )
      }
      // The default frame drop holds each frame until the next one arrives
      // and releases the held one at the end of the stream, so it always
      // loses the last frame: a whole second or more in a sparse clip, which
      // then fails the duration check. It runs only on a source faster than
      // 30 fps (or of unknown rate), where that is at most 1/30 s.
      if (input.fasterThan(TARGET_FPS + FPS_SLACK)) {
        effects.add(FrameDropEffect.createDefaultFrameDropEffect(TARGET_FPS))
      }
      // The same bound iOS sets with the reader's time range: samples past
      // the length checked against maxMs are never encoded.
      val media = MediaItem.Builder()
        .setUri(source)
        .setClippingConfiguration(MediaItem.ClippingConfiguration.Builder().setEndPositionMs(input.ms).build())
        .build()
      val item = EditedMediaItem.Builder(media)
        .setEffects(Effects(emptyList(), effects))
        .build()
      // H.264 here is 8-bit SDR: an HDR source is tone mapped instead of
      // failing in the encoder.
      return Composition.Builder(EditedMediaItemSequence.Builder(item).build())
        .setHdrMode(Composition.HDR_MODE_TONE_MAP_HDR_TO_SDR_USING_OPEN_GL)
        .build()
    }

    // Rounded down, so the long side never exceeds maxSide.
    private fun even(x: Double): Int = maxOf(2, (x.toInt() / 2) * 2)

    override fun onCompleted(composition: Composition, exportResult: ExportResult) {
      // A cancel or failure that answered first leaves no file behind.
      if (settled) return discardUnlessResolved()
      try {
        // Encoder fallback may switch codecs; only H.264 and AAC are accepted.
        if (exportResult.videoMimeType != MimeTypes.VIDEO_H264) return fail("UNSUPPORTED")
        val audio = exportResult.audioMimeType
        if (audio != null && audio != MimeTypes.AUDIO_AAC) return fail("UNSUPPORTED")
        val bytes = out.length()
        if (bytes <= 0 || bytes > limits.maxBytes) return fail("FAILED")
        val output = probe { it.setDataSource(out.absolutePath) } ?: return fail("FAILED")
        if (output.ms > Int.MAX_VALUE) return fail("FAILED")
        if (!writePoster()) return fail("FAILED")
        val result = mapOf(
          "uri" to Uri.fromFile(out).toString(),
          "posterUri" to Uri.fromFile(poster).toString(),
          "width" to output.width,
          "height" to output.height,
          "ms" to output.ms.toInt(),
          "bytes" to bytes.toInt()
        )
        settle {
          resolved = true
          promise.resolve(result)
        }
      } catch (e: Exception) {
        fail("FAILED")
      }
    }

    override fun onError(composition: Composition, exportResult: ExportResult, exportException: ExportException) {
      if (settled) return discardUnlessResolved()
      fail(
        when (exportException.errorCode) {
          ExportException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED,
          ExportException.ERROR_CODE_ENCODING_FORMAT_UNSUPPORTED,
          ExportException.ERROR_CODE_DECODER_INIT_FAILED,
          ExportException.ERROR_CODE_ENCODER_INIT_FAILED -> "UNSUPPORTED"
          else -> "FAILED"
        }
      )
    }

    // The frame comes back upright: the output carries no rotation, and the
    // retriever applies one if a device's encoder path set it anyway.
    private fun writePoster(): Boolean {
      val r = MediaMetadataRetriever()
      var frame: Bitmap? = null
      try {
        r.setDataSource(out.absolutePath)
        val bitmap = r.getFrameAtTime(0, MediaMetadataRetriever.OPTION_CLOSEST_SYNC) ?: return false
        frame = bitmap
        return FileOutputStream(poster).use { bitmap.compress(Bitmap.CompressFormat.JPEG, POSTER_QUALITY, it) } &&
          poster.length() > 0
      } catch (e: Exception) {
        return false
      } finally {
        frame?.recycle()
        try {
          r.release()
        } catch (e: Exception) {
          // Nothing to report.
        }
      }
    }

    private fun fail(code: String) {
      settle {
        discard()
        promise.reject(code, code.lowercase(), null)
      }
    }

    private fun discardUnlessResolved() {
      if (!resolved) discard()
    }

    private fun discard() {
      try {
        out.delete()
        poster.delete()
      } catch (e: Exception) {
        // Best effort: the next run clears the directory.
      }
    }

    // Exactly once. The busy flag is cleared before the promise is answered,
    // so a caller that tries again at once is not refused.
    private fun settle(answer: () -> Unit) {
      if (settled) return
      settled = true
      transformer = null
      if (current === this) current = null
      busy.set(false)
      try {
        answer()
      } catch (e: Exception) {
        // The JS runtime that asked may be gone.
      }
      thread.quitSafely()
    }
  }
}
