import CryptoKit
import Darwin
import ExpoModulesCore
import Foundation
import onnxruntime_objc

// Dev-only measurement spike: the account service's pinned MiniLM model on
// ONNX Runtime (CPU), to measure load time, inference time and memory on a
// real iPhone. Product code never calls it. The model is read only from
// Documents/sentinel/model_quantized.onnx (a fixed path, never one from JS),
// and its sha256 is streamed and compared with the caller's pin before the
// session is created. Nothing is logged and nothing touches the network.
// Every operation runs on one serial queue, one at a time (BUSY otherwise).
// Native error text never reaches JS. A Release build answers isAvailable
// false and rejects every call UNSUPPORTED: the spike runs in debug builds
// only.
public class SentinelSpikeModule: Module {
  #if DEBUG
  static let enabled = true
  #else
  static let enabled = false
  #endif

  static let dim = 384
  // The account service's MAX_TOKENS and the pinned tokenizer's vocabulary
  // size (see modules/sentinel-spike/index.js).
  static let maxTokens = 128
  static let vocabSize = 250_002
  static let maxThreads = 4
  static let chunkBytes = 1 << 20

  private let lock = NSLock()
  private var running = false
  private let queue = DispatchQueue(label: "app.varanda.sentinelspike", qos: .userInitiated)
  // Read and written only on `queue`.
  private var runtime: SentinelSpikeRuntime?

  public func definition() -> ModuleDefinition {
    Name("SentinelSpike")

    Function("isAvailable") { () -> Bool in
      return SentinelSpikeModule.enabled
    }

    AsyncFunction("load") { (expected: String, threads: Double, promise: Promise) in
      guard SentinelSpikeModule.enabled else {
        promise.reject("UNSUPPORTED", "unsupported")
        return
      }
      guard SentinelSpikeModule.isSha256Hex(expected), threads.isFinite, threads == threads.rounded() else {
        promise.reject("INVALID", "invalid")
        return
      }
      let count = Int(min(Double(SentinelSpikeModule.maxThreads), max(1, threads)))
      guard self.begin() else {
        promise.reject("BUSY", "busy")
        return
      }
      self.queue.async {
        let start = DispatchTime.now().uptimeNanoseconds
        // The old session goes first, so the memory reading after a reload
        // is not two models.
        self.runtime = nil
        var answer: [String: Any]?
        var code = "FAILED"
        do {
          let fileBytes = try SentinelSpikeModule.checkPin(expected)
          guard let url = SentinelSpikeModule.modelURL() else { throw SentinelSpikeError.failed }
          self.runtime = try SentinelSpikeRuntime(path: url.path, threads: count)
          answer = ["loadMs": SentinelSpikeModule.msSince(start), "fileBytes": Double(fileBytes)]
        } catch SentinelSpikeError.missing {
          code = "MISSING"
        } catch SentinelSpikeError.pin {
          code = "PIN"
        } catch {
          code = "FAILED"
        }
        // Freed before answering, so a call right after the answer is not
        // refused as BUSY.
        self.end()
        if let answer = answer {
          promise.resolve(answer)
        } else {
          promise.reject(code, "failed")
        }
      }
    }

    AsyncFunction("embed") { (ids: [Double], mask: [Double], promise: Promise) in
      guard SentinelSpikeModule.enabled else {
        promise.reject("UNSUPPORTED", "unsupported")
        return
      }
      guard let tokens = SentinelSpikeTokens(ids: ids, mask: mask) else {
        promise.reject("INVALID", "invalid")
        return
      }
      guard self.begin() else {
        promise.reject("BUSY", "busy")
        return
      }
      self.queue.async {
        guard let runtime = self.runtime else {
          self.end()
          promise.reject("NOT_LOADED", "not loaded")
          return
        }
        let start = DispatchTime.now().uptimeNanoseconds
        let hidden = try? runtime.hidden(tokens)
        let inferMs = SentinelSpikeModule.msSince(start)
        let vector = hidden.flatMap { SentinelSpikeModule.poolAndNormalize($0, mask: tokens.mask) }
        self.end()
        if let vector = vector {
          promise.resolve(["vector": vector, "inferMs": inferMs])
        } else {
          promise.reject("FAILED", "failed")
        }
      }
    }

    AsyncFunction("memory") { (promise: Promise) in
      guard SentinelSpikeModule.enabled else {
        promise.reject("UNSUPPORTED", "unsupported")
        return
      }
      if let bytes = SentinelSpikeModule.footprint() {
        promise.resolve(["bytes": Double(bytes)])
      } else {
        promise.reject("FAILED", "failed")
      }
    }

    AsyncFunction("unload") { (promise: Promise) in
      guard SentinelSpikeModule.enabled else {
        promise.reject("UNSUPPORTED", "unsupported")
        return
      }
      guard self.begin() else {
        promise.reject("BUSY", "busy")
        return
      }
      self.queue.async {
        self.runtime = nil
        self.end()
        promise.resolve(nil)
      }
    }

    OnDestroy {
      self.queue.async {
        self.runtime = nil
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

  static func isSha256Hex(_ text: String) -> Bool {
    return text.utf8.count == 64 && text.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
  }

  static func msSince(_ start: UInt64) -> Double {
    return Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
  }

  static func modelURL() -> URL? {
    return FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first?
      .appendingPathComponent("sentinel", isDirectory: true)
      .appendingPathComponent("model_quantized.onnx", isDirectory: false)
  }

  // Streams the file's sha256 in 1 MiB reads and compares it with the pin.
  // A missing path, a symlink or anything but a regular file is MISSING. The
  // file is opened again by path for the session; the window between the two
  // is inside the app's own sandbox. A symlinked parent directory is the same
  // class of risk: only something already inside the sandbox could plant it.
  static func checkPin(_ expected: String) throws -> Int64 {
    guard let url = modelURL(),
          let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
          attributes[.type] as? FileAttributeType == .typeRegular,
          let handle = try? FileHandle(forReadingFrom: url) else {
      throw SentinelSpikeError.missing
    }
    defer { try? handle.close() }
    var hasher = SHA256()
    var total: Int64 = 0
    while true {
      let chunk: Data? = autoreleasepool {
        return try? handle.read(upToCount: chunkBytes) ?? Data()
      }
      guard let data = chunk else { throw SentinelSpikeError.failed }
      if data.isEmpty { break }
      hasher.update(data: data)
      total += Int64(data.count)
    }
    let hex = hasher.finalize().map { String(format: "%02x", $0) }.joined()
    guard total > 0, hex == expected else { throw SentinelSpikeError.pin }
    return total
  }

  // Attention-mask-aware mean pooling over [1, n, dim], then L2
  // normalization, as apps/cli/lib/account/ai/embed-child.js does; nil when
  // nothing is usable (no unmasked token, a non-finite value, a zero norm).
  static func poolAndNormalize(_ hidden: Data, mask: [Int64]) -> [Double]? {
    let n = mask.count
    guard hidden.count == n * dim * MemoryLayout<Float>.size else { return nil }
    var floats = [Float](repeating: 0, count: n * dim)
    _ = floats.withUnsafeMutableBytes { hidden.copyBytes(to: $0) }
    var sum = [Double](repeating: 0, count: dim)
    var used = 0
    for t in 0..<n where mask[t] != 0 {
      used += 1
      let offset = t * dim
      for d in 0..<dim {
        sum[d] += Double(floats[offset + d])
      }
    }
    guard used > 0 else { return nil }
    var norm = 0.0
    for d in 0..<dim {
      sum[d] /= Double(used)
      norm += sum[d] * sum[d]
    }
    norm = norm.squareRoot()
    guard norm.isFinite, norm > 0 else { return nil }
    var out = [Double](repeating: 0, count: dim)
    for d in 0..<dim {
      let v = sum[d] / norm
      guard v.isFinite else { return nil }
      out[d] = v
    }
    return out
  }

  // The process's physical footprint (what Xcode's memory gauge and the
  // jetsam limit count).
  static func footprint() -> UInt64? {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
    let result = withUnsafeMutablePointer(to: &info) { pointer in
      pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
        task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
      }
    }
    guard result == KERN_SUCCESS, info.phys_footprint > 0 else { return nil }
    return info.phys_footprint
  }
}

// A CPU session on the checked model. Refused unless its inputs are the
// MiniLM ones (input_ids, attention_mask, optional token_type_ids) and it
// has last_hidden_state. ONNX Runtime logs at FATAL only, so nothing reaches
// the device log. Used from the module's serial queue only.
final class SentinelSpikeRuntime {
  private static let output = "last_hidden_state"
  // One environment for the process (ONNX Runtime shares it anyway). A
  // static let is initialized once, thread safely, on first use.
  private static let env: ORTEnv? = try? ORTEnv(loggingLevel: .fatal)

  private let session: ORTSession
  private let tokenTypes: Bool

  init(path: String, threads: Int) throws {
    guard let env = SentinelSpikeRuntime.env else { throw SentinelSpikeError.failed }
    let options = try ORTSessionOptions()
    try options.setIntraOpNumThreads(Int32(threads))
    try options.setGraphOptimizationLevel(.all)
    try options.setLogSeverityLevel(.fatal)
    let session = try ORTSession(env: env, modelPath: path, sessionOptions: options)
    // The Objective-C API of 1.21 lists input names but not their element
    // types. The tensors below are int64, and ONNX Runtime refuses a run
    // whose input type differs from the model's, so a non-int64 model input
    // fails the first embed (FAILED) instead of producing a vector.
    let inputs = Set(try session.inputNames())
    let known: Set<String> = ["input_ids", "attention_mask", "token_type_ids"]
    guard inputs.isSubset(of: known), inputs.contains("input_ids"), inputs.contains("attention_mask"),
          try session.outputNames().contains(SentinelSpikeRuntime.output) else {
      throw SentinelSpikeError.failed
    }
    self.session = session
    tokenTypes = inputs.contains("token_type_ids")
  }

  // last_hidden_state for one sequence, exactly [1, n, dim] floats.
  func hidden(_ tokens: SentinelSpikeTokens) throws -> Data {
    let n = tokens.count
    let shape: [NSNumber] = [1, NSNumber(value: n)]
    func tensor(_ values: [Int64]) throws -> (NSMutableData, ORTValue) {
      let data = values.withUnsafeBytes { NSMutableData(bytes: $0.baseAddress!, length: $0.count) }
      return (data, try ORTValue(tensorData: data, elementType: .int64, shape: shape))
    }
    // The NSMutableData buffers back the tensors and stay alive until run
    // returns.
    var buffers: [NSMutableData] = []
    var inputs: [String: ORTValue] = [:]
    for (name, values) in [("input_ids", tokens.ids), ("attention_mask", tokens.mask)] {
      let (data, value) = try tensor(values)
      buffers.append(data)
      inputs[name] = value
    }
    if tokenTypes {
      let (data, value) = try tensor([Int64](repeating: 0, count: n))
      buffers.append(data)
      inputs["token_type_ids"] = value
    }
    let run = try ORTRunOptions()
    try run.setLogSeverityLevel(.fatal)
    let outputs = try session.run(withInputs: inputs, outputNames: [SentinelSpikeRuntime.output], runOptions: run)
    withExtendedLifetime(buffers) {}
    guard let value = outputs[SentinelSpikeRuntime.output] else { throw SentinelSpikeError.failed }
    let info = try value.tensorTypeAndShapeInfo()
    let dims = info.shape.map { $0.intValue }
    guard info.elementType == .float, dims == [1, n, SentinelSpikeModule.dim] else { throw SentinelSpikeError.failed }
    let data = try value.tensorData() as Data
    guard data.count == n * SentinelSpikeModule.dim * MemoryLayout<Float>.size else { throw SentinelSpikeError.failed }
    return data
  }
}

enum SentinelSpikeError: Error {
  case missing
  case pin
  case failed
}

// One tokenized text: the same non-empty length up to maxTokens, whole ids
// inside the vocabulary, a 0/1 mask with at least one 1.
struct SentinelSpikeTokens {
  let ids: [Int64]
  let mask: [Int64]
  var count: Int { return ids.count }

  init?(ids: [Double], mask: [Double]) {
    guard !ids.isEmpty, ids.count <= SentinelSpikeModule.maxTokens, ids.count == mask.count else { return nil }
    var outIds = [Int64]()
    outIds.reserveCapacity(ids.count)
    for id in ids {
      guard id.isFinite, id == id.rounded(), id >= 0, id < Double(SentinelSpikeModule.vocabSize) else { return nil }
      outIds.append(Int64(id))
    }
    var outMask = [Int64]()
    outMask.reserveCapacity(mask.count)
    for m in mask {
      guard m == 0 || m == 1 else { return nil }
      outMask.append(Int64(m))
    }
    guard outMask.contains(1) else { return nil }
    self.ids = outIds
    self.mask = outMask
  }
}
