import AVFoundation
import CoreMedia
import ExpoModulesCore
import UIKit

// Re-encodes one short video for a post or a momento with AVFoundation only.
// A reader and a writer rather than AVAssetExportSession: the export presets
// pick their own bitrate (a 960x540 preset overshoots the 8 MiB item on a
// 30 s clip) and fileLengthLimit would cut the video short, while the
// writer takes an explicit bitrate and writes only the tracks given to it,
// so the source's timed metadata tracks and metadata items never reach the
// output. The rotation is drawn into the pixels, so the output has an
// identity track matrix and its first frame is the upright poster.
// Native error text never reaches JS, and paths are never logged.
public class VideoPrepModule: Module {
  private let lock = NSLock()
  private var running = false

  public func definition() -> ModuleDefinition {
    Name("VideoPrep")

    Function("isAvailable") { () -> Bool in
      return true
    }

    AsyncFunction("prepare") { (uri: String, options: VideoPrepOptions, promise: Promise) in
      guard let source = URL(string: uri), source.isFileURL,
            FileManager.default.isReadableFile(atPath: source.path),
            let limits = VideoPrepLimits(options) else {
        promise.reject("INVALID", "invalid")
        return
      }
      guard self.begin() else {
        promise.reject("BUSY", "busy")
        return
      }
      Task.detached(priority: .userInitiated) { [weak self] in
        var answer: [String: Any]?
        var code = "FAILED"
        do {
          answer = try await VideoPrepRun(source: source, limits: limits).run()
        } catch VideoPrepError.tooLong {
          code = "TOO_LONG"
        } catch {
          code = "FAILED"
        }
        // Freed before answering, so a prepare() right after the answer is
        // not refused as BUSY.
        self?.end()
        if let answer = answer {
          promise.resolve(answer)
        } else {
          promise.reject(code, code == "TOO_LONG" ? "too long" : "failed")
        }
      }
    }
  }

  private func begin() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if running { return false }
    running = true
    return true
  }

  private func end() {
    lock.lock()
    running = false
    lock.unlock()
  }
}

struct VideoPrepOptions: Record {
  @Field var maxMs: Double = 0
  @Field var maxBytes: Double = 0
  @Field var maxSide: Double = 0
  @Field var maxBitrate: Double = 0
}

struct VideoPrepLimits {
  let maxMs: Int64
  let maxBytes: Int64
  let maxSide: Int
  let maxBitrate: Int

  init?(_ options: VideoPrepOptions) {
    func whole(_ n: Double, _ low: Double, _ high: Double) -> Bool {
      return n.isFinite && n == n.rounded() && n >= low && n <= high
    }
    guard whole(options.maxMs, 1, 600_000),
          whole(options.maxBytes, 65_536, 64 * 1_048_576),
          whole(options.maxSide, 64, 1920),
          whole(options.maxBitrate, 100_000, 20_000_000) else {
      return nil
    }
    maxMs = Int64(options.maxMs)
    maxBytes = Int64(options.maxBytes)
    maxSide = Int(options.maxSide)
    maxBitrate = Int(options.maxBitrate)
  }
}

enum VideoPrepError: Error {
  case tooLong
  case failed
}

final class VideoPrepRun {
  private static let maxFps = 30.0
  private static let audioBitrate = 64_000
  private static let audioRate = 44_100

  private let source: URL
  private let limits: VideoPrepLimits
  private let output: URL
  private let poster: URL

  init(source: URL, limits: VideoPrepLimits) {
    self.source = source
    self.limits = limits
    let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("video-prep", isDirectory: true)
    let name = UUID().uuidString
    output = dir.appendingPathComponent(name + ".mp4")
    poster = dir.appendingPathComponent(name + ".jpg")
  }

  func run() async throws -> [String: Any] {
    do {
      return try await prepare()
    } catch {
      try? FileManager.default.removeItem(at: output)
      try? FileManager.default.removeItem(at: poster)
      throw error
    }
  }

  private func prepare() async throws -> [String: Any] {
    // The default policy forbids only local-to-remote references, so a
    // reference movie could pull media from other local files into the output.
    let asset = AVURLAsset(url: source, options: [AVURLAssetReferenceRestrictionsKey: AVAssetReferenceRestrictions.forbidAll.rawValue])
    let duration = try await asset.load(.duration)
    guard duration.isNumeric, duration.seconds > 0 else { throw VideoPrepError.failed }
    // The same rounding as the receiver's walker (rpc video-bounds toMs).
    // Compared as a Double: a declared length past Int64.max would trap in
    // the Int64 conversion.
    if (duration.seconds * 1000).rounded() > Double(limits.maxMs) { throw VideoPrepError.tooLong }
    // One deadline from here for reading and encoding in both passes, so a
    // second pass cannot double the bound. Finishing a file and the poster
    // are not under it.
    let deadline = VideoPrepPumps.deadline(seconds: duration.seconds)

    guard let video = try await asset.loadTracks(withMediaType: .video).first else {
      throw VideoPrepError.failed
    }
    let audio = try await asset.loadTracks(withMediaType: .audio).first
    let (naturalSize, transform, nominalFps) = try await video.load(.naturalSize, .preferredTransform, .nominalFrameRate)

    let shown = CGRect(origin: .zero, size: naturalSize).applying(transform).standardized
    guard shown.width >= 2, shown.height >= 2 else { throw VideoPrepError.failed }
    let scale = min(1.0, Double(limits.maxSide) / Double(max(shown.width, shown.height)))
    let evenSide = limits.maxSide - limits.maxSide % 2
    let firstWidth = min(evenSide, max(2, Int((Double(shown.width) * scale / 2).rounded()) * 2))
    let firstHeight = min(evenSide, max(2, Int((Double(shown.height) * scale / 2).rounded()) * 2))
    let fps = nominalFps > 0 ? min(Double(nominalFps), VideoPrepRun.maxFps) : VideoPrepRun.maxFps

    let seconds = duration.seconds
    let totalBitrate = min(0.85 * Double(limits.maxBytes) * 8 / seconds, Double(limits.maxBitrate))
    let audioBitrate = audio == nil ? 0 : VideoPrepRun.audioBitrate
    let videoBitrate = Int(totalBitrate) - audioBitrate
    guard videoBitrate >= 100_000 else { throw VideoPrepError.failed }

    try FileManager.default.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
    removeLeftovers()

    // Readers and writers are single use, so each pass builds its own.
    func encode(_ width: Int, _ height: Int) async throws -> Int64 {
      let reader = try AVAssetReader(asset: asset)
      reader.timeRange = CMTimeRange(start: .zero, duration: duration)
      let writer = try AVAssetWriter(outputURL: output, fileType: .mp4)
      writer.shouldOptimizeForNetworkUse = true
      writer.metadata = []

      let videoOut = AVAssetReaderVideoCompositionOutput(
        videoTracks: [video],
        videoSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange]
      )
      videoOut.videoComposition = composition(video, transform, shown, width, height, fps, duration)
      videoOut.alwaysCopiesSampleData = false
      let settings: [String: Any] = [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: width,
        AVVideoHeightKey: height,
        AVVideoColorPropertiesKey: [
          AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
          AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
          AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2
        ],
        AVVideoCompressionPropertiesKey: [
          AVVideoAverageBitRateKey: videoBitrate,
          AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
          AVVideoH264EntropyModeKey: AVVideoH264EntropyModeCABAC,
          AVVideoExpectedSourceFrameRateKey: Int(fps.rounded()),
          AVVideoMaxKeyFrameIntervalKey: max(1, Int((fps * 2).rounded())),
          AVVideoAllowFrameReorderingKey: false
        ]
      ]
      // Settings the writer cannot apply make AVAssetWriterInput raise an
      // Objective-C exception, a crash.
      guard writer.canApply(outputSettings: settings, forMediaType: .video) else { throw VideoPrepError.failed }
      let videoIn = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
      videoIn.expectsMediaDataInRealTime = false
      videoIn.transform = .identity
      guard reader.canAdd(videoOut), writer.canAdd(videoIn) else { throw VideoPrepError.failed }
      reader.add(videoOut)
      writer.add(videoIn)
      var pumps = [(videoIn, videoOut as AVAssetReaderOutput)]

      if let audio = audio {
        let stereo = VideoPrepRun.stereoLayout()
        let audioOut = AVAssetReaderTrackOutput(track: audio, outputSettings: [
          AVFormatIDKey: kAudioFormatLinearPCM,
          AVSampleRateKey: VideoPrepRun.audioRate,
          AVNumberOfChannelsKey: 2,
          AVChannelLayoutKey: stereo,
          AVLinearPCMBitDepthKey: 16,
          AVLinearPCMIsFloatKey: false,
          AVLinearPCMIsBigEndianKey: false,
          AVLinearPCMIsNonInterleaved: false
        ])
        audioOut.alwaysCopiesSampleData = false
        // AAC LC (object type 2), the profile the receiver's walker accepts.
        let audioIn = AVAssetWriterInput(mediaType: .audio, outputSettings: [
          AVFormatIDKey: kAudioFormatMPEG4AAC,
          AVSampleRateKey: VideoPrepRun.audioRate,
          AVNumberOfChannelsKey: 2,
          AVChannelLayoutKey: stereo,
          AVEncoderBitRateKey: audioBitrate
        ])
        audioIn.expectsMediaDataInRealTime = false
        guard reader.canAdd(audioOut), writer.canAdd(audioIn) else { throw VideoPrepError.failed }
        reader.add(audioOut)
        writer.add(audioIn)
        pumps.append((audioIn, audioOut))
      }

      guard writer.startWriting() else { throw VideoPrepError.failed }
      guard reader.startReading() else {
        writer.cancelWriting()
        throw VideoPrepError.failed
      }
      writer.startSession(atSourceTime: .zero)
      await VideoPrepPumps(reader: reader, writer: writer, deadline: deadline, pairs: pumps).run()
      guard reader.status == .completed, writer.status == .writing else {
        reader.cancelReading()
        writer.cancelWriting()
        throw VideoPrepError.failed
      }
      await writer.finishWriting()
      guard writer.status == .completed else { throw VideoPrepError.failed }

      let size = try FileManager.default.attributesOfItem(atPath: output.path)[.size] as? NSNumber
      guard let bytes = size?.int64Value, bytes > 0 else { throw VideoPrepError.failed }
      return bytes
    }

    // The average bitrate is a soft target: on very detailed sources the
    // simulator's encoder stayed above it at 960 px whatever rate was asked,
    // while a smaller frame met it. So a file over the cap gets exactly one
    // more encode at a smaller size, never a third.
    var width = firstWidth
    var height = firstHeight
    var bytes = try await encode(width, height)
    if bytes > limits.maxBytes {
      // An AVAssetWriter refuses an output URL that already exists, and only
      // one output is kept at a time.
      try? FileManager.default.removeItem(at: output)
      let f = max(0.5, min(0.8, (0.85 * Double(limits.maxBytes) / Double(bytes)).squareRoot()))
      width = max(2, Int(Double(firstWidth) * f / 2) * 2)
      height = max(2, Int(Double(firstHeight) * f / 2) * 2)
      bytes = try await encode(width, height)
    }
    guard bytes > 0, bytes <= limits.maxBytes else { throw VideoPrepError.failed }

    let prepared = AVURLAsset(url: output)
    let preparedDuration = try await prepared.load(.duration)
    guard preparedDuration.isNumeric else { throw VideoPrepError.failed }
    let ms = Int64((preparedDuration.seconds * 1000).rounded())
    guard ms > 0 else { throw VideoPrepError.failed }
    try await writePoster(prepared)

    return [
      "uri": output.absoluteString,
      "posterUri": poster.absoluteString,
      "width": width,
      "height": height,
      "ms": ms,
      "bytes": bytes
    ]
  }

  // A file JS failed to delete would otherwise stay in the cache for good.
  // Only one preparation runs at a time and JS has read and discarded the
  // previous one's files by then, so nothing here is still in use.
  private func removeLeftovers() {
    let fm = FileManager.default
    let dir = output.deletingLastPathComponent()
    guard let entries = try? fm.contentsOfDirectory(
      at: dir, includingPropertiesForKeys: [.isRegularFileKey], options: []
    ) else { return }
    for entry in entries where (try? entry.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true {
      try? fm.removeItem(at: entry)
    }
  }

  // Draws the track upright at the output size: the preferred transform, moved
  // back to the origin, then scaled. At most 30 frames a second.
  private func composition(
    _ video: AVAssetTrack, _ transform: CGAffineTransform, _ shown: CGRect,
    _ width: Int, _ height: Int, _ fps: Double, _ duration: CMTime
  ) -> AVVideoComposition {
    let upright = transform
      .concatenating(CGAffineTransform(translationX: -shown.minX, y: -shown.minY))
      .concatenating(CGAffineTransform(scaleX: CGFloat(width) / shown.width, y: CGFloat(height) / shown.height))
    let layer = AVMutableVideoCompositionLayerInstruction(assetTrack: video)
    layer.setTransform(upright, at: .zero)
    let instruction = AVMutableVideoCompositionInstruction()
    instruction.timeRange = CMTimeRange(start: .zero, duration: duration)
    instruction.layerInstructions = [layer]
    let composition = AVMutableVideoComposition()
    composition.renderSize = CGSize(width: width, height: height)
    composition.frameDuration = CMTime(value: CMTimeValue((600 / fps).rounded(.up)), timescale: 600)
    // HDR (HLG or Dolby Vision from an iPhone camera) is mapped to the SDR
    // colours H.264 carries here.
    composition.colorPrimaries = AVVideoColorPrimaries_ITU_R_709_2
    composition.colorTransferFunction = AVVideoTransferFunction_ITU_R_709_2
    composition.colorYCbCrMatrix = AVVideoYCbCrMatrix_ITU_R_709_2
    composition.instructions = [instruction]
    return composition
  }

  private func writePoster(_ prepared: AVAsset) async throws {
    let generator = AVAssetImageGenerator(asset: prepared)
    generator.appliesPreferredTrackTransform = true
    generator.requestedTimeToleranceBefore = .zero
    generator.requestedTimeToleranceAfter = CMTime(value: 1, timescale: 10)
    let (image, _) = try await generator.image(at: .zero)
    // UIImage writes no EXIF or location for a CGImage it did not read.
    guard let jpeg = UIImage(cgImage: image).jpegData(compressionQuality: 0.85) else {
      throw VideoPrepError.failed
    }
    try jpeg.write(to: poster, options: .atomic)
  }

  private static func stereoLayout() -> Data {
    var layout = AudioChannelLayout()
    layout.mChannelLayoutTag = kAudioChannelLayoutTag_Stereo
    return Data(bytes: &layout, count: MemoryLayout<AudioChannelLayout>.size)
  }
}

// Moves samples from each reader output to its writer input, each pair on
// its own queue, until every output is drained or one append fails. A failed
// append means the writer failed, and then the other input may never ask for
// data again, so every pair is ended from its own queue instead of waited on.
// A writer that fails on its own while its inputs wait for readiness calls
// no block at all, so a watchdog ends the run then, or after a deadline.
// The reader is never cancelled here: cancelReading on one thread while a
// pump is inside copyNextSampleBuffer on its queue crashes in AVFoundation.
// Abort only stops the pumps; the caller cancels the reader once all ended.
final class VideoPrepPumps {
  private static let pollMs = 250
  // A 30 s clip at 960 px encodes in a few seconds on any supported iPhone.
  // The deadline is an absolute limit counted from the start of the
  // preparation, not a stall timer, and bounds reading and encoding in both
  // passes. finishWriting, the duration load and the poster run after the
  // watchdog ends and are not under it. It sits far above the slowest real
  // encode (a throttled phone, a long clip under a larger option cap).
  private static let minDeadlineSeconds = 180.0
  private static let deadlinePerSourceSecond = 4.0

  static func deadline(seconds: Double) -> DispatchTime {
    return DispatchTime.now() + max(minDeadlineSeconds, seconds * deadlinePerSourceSecond)
  }

  private let reader: AVAssetReader
  private let writer: AVAssetWriter
  private let deadline: DispatchTime
  private let pumps: [VideoPrepPump]
  private let group = DispatchGroup()
  private let watchdogQueue = DispatchQueue(label: "app.varanda.videoprep.watchdog")
  private let lock = NSLock()
  private var aborted = false

  init(reader: AVAssetReader, writer: AVAssetWriter, deadline: DispatchTime, pairs: [(AVAssetWriterInput, AVAssetReaderOutput)]) {
    self.reader = reader
    self.writer = writer
    self.deadline = deadline
    pumps = pairs.enumerated().map { index, pair in
      VideoPrepPump(input: pair.0, output: pair.1, queue: DispatchQueue(label: "app.varanda.videoprep.pump\(index)"))
    }
  }

  func run() async {
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      // Entered for every pump before any starts: a pump that fails at once
      // aborts, and abort leaves the group once for every pump.
      for _ in pumps {
        group.enter()
      }
      let watchdog = startWatchdog()
      for pump in pumps {
        pump.start(
          reader: reader, writer: writer, group: group,
          stopped: { [weak self] in self?.isAborted() ?? true },
          failed: { [weak self] in self?.abort() }
        )
      }
      group.notify(queue: .global(qos: .userInitiated)) {
        watchdog.cancel()
        continuation.resume()
      }
    }
  }

  private func startWatchdog() -> DispatchSourceTimer {
    let timer = DispatchSource.makeTimerSource(queue: watchdogQueue)
    let deadline = self.deadline
    let interval = DispatchTimeInterval.milliseconds(VideoPrepPumps.pollMs)
    timer.schedule(deadline: .now() + interval, repeating: interval)
    timer.setEventHandler { [weak self] in
      guard let self = self else { return }
      let status = self.writer.status
      if status == .failed || status == .cancelled || DispatchTime.now() >= deadline {
        timer.cancel()
        self.abort()
      }
    }
    timer.resume()
    return timer
  }

  private func isAborted() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return aborted
  }

  private func abort() {
    lock.lock()
    let first = !aborted
    aborted = true
    lock.unlock()
    guard first else { return }
    for pump in pumps {
      pump.end(group)
    }
  }
}

final class VideoPrepPump {
  private let input: AVAssetWriterInput
  private let output: AVAssetReaderOutput
  private let queue: DispatchQueue
  // Read and written on `queue` only.
  private var finished = false

  init(input: AVAssetWriterInput, output: AVAssetReaderOutput, queue: DispatchQueue) {
    self.input = input
    self.output = output
    self.queue = queue
  }

  func start(
    reader: AVAssetReader, writer: AVAssetWriter, group: DispatchGroup,
    stopped: @escaping () -> Bool, failed: @escaping () -> Void
  ) {
    input.requestMediaDataWhenReady(on: queue) { [self] in
      if finished { return }
      // After an abort the end() queued behind this block leaves the group.
      while !stopped() && input.isReadyForMoreMediaData {
        guard reader.status == .reading, let buffer = output.copyNextSampleBuffer() else {
          finished = true
          // markAsFinished on a failed or cancelled writer can raise an
          // Objective-C exception, which Swift cannot catch; the run fails
          // on the writer's status afterwards anyway.
          if writer.status == .writing {
            input.markAsFinished()
          }
          group.leave()
          return
        }
        if !input.append(buffer) {
          failed()
          return
        }
      }
    }
  }

  func end(_ group: DispatchGroup) {
    queue.async { [self] in
      if finished { return }
      finished = true
      group.leave()
    }
  }
}
