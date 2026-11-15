import CryptoKit
import Darwin
import ExpoModulesCore
import Foundation
import onnxruntime_objc

// Dev-only measurement spike: a pinned model on ONNX Runtime (CPU), to
// measure load time, inference time and memory on a real iPhone. Product code
// never calls it. load takes a model key from a fixed allowlist (embed: the
// account service's MiniLM embedder, nli: a zero-shot NLI classifier), and
// the model is read only from that key's fixed file in Documents/sentinel
// (never a path from JS). Its sha256 is streamed and compared with the
// caller's pin before the session is created. One model is loaded at a time.
// Nothing is logged and nothing touches the network. Every operation runs on
// one serial queue, one at a time (BUSY otherwise). Native error text never
// reaches JS. A Release build answers isAvailable false and rejects every
// call UNSUPPORTED: the spike runs in debug builds only.
public class SentinelSpikeModule: Module {
  #if DEBUG
  static let enabled = true
  #else
  static let enabled = false
  #endif

  static let dim = 384
  // The account service's MAX_TOKENS and the pinned tokenizer's vocabulary
  // size, then the NLI pair limit, the vocabulary of the on-device MiniLM NLI
  // model (multilingual-MiniLMv2-L6-mnli-xnli, 250002 entries) and the
  // accepted label counts (see modules/sentinel-spike/index.js).
  static let maxTokens = 128
  static let vocabSize = 250_002
  static let maxPairTokens = 256
  static let nliVocabSize = 250_002
  static let minLabels = 2
  static let maxLabels = 8
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

    AsyncFunction("load") { (model: String, expected: String, threads: Double, promise: Promise) in
      guard SentinelSpikeModule.enabled else {
        promise.reject("UNSUPPORTED", "unsupported")
        return
      }
      guard let kind = SentinelSpikeKind.named(model), SentinelSpikeModule.isSha256Hex(expected),
            threads.isFinite, threads == threads.rounded() else {
        promise.reject("INVALID", "invalid")
        return
      }
      let count = Int(min(Double(SentinelSpikeModule.maxThreads), max(1, threads)))
      // No Documents directory means this environment cannot host the model
      // at all (UNSUPPORTED, as on Android without filesDir); MISSING is kept
      // for a model file that is absent.
      guard let url = SentinelSpikeModule.modelURL(kind) else {
        promise.reject("UNSUPPORTED", "unsupported")
        return
      }
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
          let fileBytes = try SentinelSpikeModule.checkPin(url, expected)
          self.runtime = try SentinelSpikeRuntime(kind: kind, path: url.path, threads: count)
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
      guard let tokens = SentinelSpikeTokens(ids: ids, mask: mask, typeIds: nil,
                                             maxTokens: SentinelSpikeModule.maxTokens,
                                             vocabSize: SentinelSpikeModule.vocabSize) else {
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
        guard runtime.kind == .embed else {
          self.end()
          promise.reject("WRONG_MODEL", "wrong model")
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

    // JS always sends typeIds, null when absent.
    AsyncFunction("classify") { (ids: [Double], mask: [Double], typeIds: [Double]?, promise: Promise) in
      guard SentinelSpikeModule.enabled else {
        promise.reject("UNSUPPORTED", "unsupported")
        return
      }
      guard let tokens = SentinelSpikeTokens(ids: ids, mask: mask, typeIds: typeIds,
                                             maxTokens: SentinelSpikeModule.maxPairTokens,
                                             vocabSize: SentinelSpikeModule.nliVocabSize) else {
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
        guard runtime.kind == .nli else {
          self.end()
          promise.reject("WRONG_MODEL", "wrong model")
          return
        }
        let start = DispatchTime.now().uptimeNanoseconds
        let logits = try? runtime.logits(tokens)
        let inferMs = SentinelSpikeModule.msSince(start)
        self.end()
        if let logits = logits {
          promise.resolve(["logits": logits, "inferMs": inferMs])
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

  static func modelURL(_ kind: SentinelSpikeKind) -> URL? {
    return FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first?
      .appendingPathComponent("sentinel", isDirectory: true)
      .appendingPathComponent(kind.fileName, isDirectory: false)
  }

  // Streams the file's sha256 in 1 MiB reads and compares it with the pin.
  // A missing path, a symlink or anything but a regular file is MISSING, and
  // so is a file that vanishes before it can be opened. The file is opened
  // again by path for the session; the window between the two is inside the
  // app's own sandbox. A symlinked parent directory is the same class of
  // risk: only something already inside the sandbox could plant it.
  static func checkPin(_ url: URL, _ expected: String) throws -> Int64 {
    guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
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

// The only models load accepts. JS names a key; the file name and the output
// the session must have are fixed here.
enum SentinelSpikeKind {
  case embed
  case nli

  static func named(_ key: String) -> SentinelSpikeKind? {
    switch key {
    case "embed": return .embed
    case "nli": return .nli
    default: return nil
    }
  }

  var fileName: String {
    switch self {
    case .embed: return "model_quantized.onnx"
    case .nli: return "nli_quantized.onnx"
    }
  }

  var output: String {
    switch self {
    case .embed: return "last_hidden_state"
    case .nli: return "logits"
    }
  }
}

// A CPU session on the checked model. Refused unless its inputs are
// input_ids and attention_mask, plus optional token_type_ids, and it has its
// kind's output (last_hidden_state for embed, logits for nli). ONNX Runtime
// logs at FATAL only, so nothing reaches the device log. Used from the
// module's serial queue only.
final class SentinelSpikeRuntime {
  // One environment for the process (ONNX Runtime shares it anyway). A
  // static let is initialized once, thread safely, on first use.
  private static let env: ORTEnv? = try? ORTEnv(loggingLevel: .fatal)

  let kind: SentinelSpikeKind
  private let session: ORTSession
  private let tokenTypes: Bool

  init(kind: SentinelSpikeKind, path: String, threads: Int) throws {
    guard let env = SentinelSpikeRuntime.env else { throw SentinelSpikeError.failed }
    let options = try ORTSessionOptions()
    try options.setIntraOpNumThreads(Int32(threads))
    try options.setGraphOptimizationLevel(.all)
    try options.setLogSeverityLevel(.fatal)
    let session = try ORTSession(env: env, modelPath: path, sessionOptions: options)
    // The Objective-C API of 1.21 lists input names but not their element
    // types. The tensors below are int64, and ONNX Runtime refuses a run
    // whose input type differs from the model's, so a non-int64 model input
    // fails the first run (FAILED) instead of producing a result.
    let inputs = Set(try session.inputNames())
    let known: Set<String> = ["input_ids", "attention_mask", "token_type_ids"]
    guard inputs.isSubset(of: known), inputs.contains("input_ids"), inputs.contains("attention_mask"),
          try session.outputNames().contains(kind.output) else {
      throw SentinelSpikeError.failed
    }
    self.kind = kind
    self.session = session
    tokenTypes = inputs.contains("token_type_ids")
  }

  // last_hidden_state for one sequence, exactly [1, n, dim] floats.
  func hidden(_ tokens: SentinelSpikeTokens) throws -> Data {
    guard kind == .embed else { throw SentinelSpikeError.failed }
    let n = tokens.count
    let value = try run(tokens)
    let info = try value.tensorTypeAndShapeInfo()
    let dims = info.shape.map { $0.intValue }
    guard info.elementType == .float, dims == [1, n, SentinelSpikeModule.dim] else { throw SentinelSpikeError.failed }
    let data = try value.tensorData() as Data
    guard data.count == n * SentinelSpikeModule.dim * MemoryLayout<Float>.size else { throw SentinelSpikeError.failed }
    return data
  }

  // The raw logits of one pair: exactly [1, k] floats, minLabels <= k <=
  // maxLabels, all finite.
  func logits(_ tokens: SentinelSpikeTokens) throws -> [Double] {
    guard kind == .nli else { throw SentinelSpikeError.failed }
    let value = try run(tokens)
    let info = try value.tensorTypeAndShapeInfo()
    let dims = info.shape.map { $0.intValue }
    guard info.elementType == .float, dims.count == 2, dims[0] == 1,
          dims[1] >= SentinelSpikeModule.minLabels, dims[1] <= SentinelSpikeModule.maxLabels else {
      throw SentinelSpikeError.failed
    }
    let k = dims[1]
    let data = try value.tensorData() as Data
    guard data.count == k * MemoryLayout<Float>.size else { throw SentinelSpikeError.failed }
    var floats = [Float](repeating: 0, count: k)
    _ = floats.withUnsafeMutableBytes { data.copyBytes(to: $0) }
    var out = [Double]()
    out.reserveCapacity(k)
    for f in floats {
      guard f.isFinite else { throw SentinelSpikeError.failed }
      out.append(Double(f))
    }
    return out
  }

  // Runs one sequence and returns the kind's output. token_type_ids, when
  // the model takes them, are the caller's or zeros.
  private func run(_ tokens: SentinelSpikeTokens) throws -> ORTValue {
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
      let (data, value) = try tensor(tokens.typeIds ?? [Int64](repeating: 0, count: n))
      buffers.append(data)
      inputs["token_type_ids"] = value
    }
    let run = try ORTRunOptions()
    try run.setLogSeverityLevel(.fatal)
    let outputs = try session.run(withInputs: inputs, outputNames: [kind.output], runOptions: run)
    withExtendedLifetime(buffers) {}
    guard let value = outputs[kind.output] else { throw SentinelSpikeError.failed }
    return value
  }
}

enum SentinelSpikeError: Error {
  case missing
  case pin
  case failed
}

// One tokenized input: the same non-empty length up to maxTokens, whole ids
// below vocabSize, a 0/1 mask with at least one 1, and token type ids that
// are absent or one 0/1 per token.
struct SentinelSpikeTokens {
  let ids: [Int64]
  let mask: [Int64]
  let typeIds: [Int64]?
  var count: Int { return ids.count }

  init?(ids: [Double], mask: [Double], typeIds: [Double]?, maxTokens: Int, vocabSize: Int) {
    guard !ids.isEmpty, ids.count <= maxTokens, ids.count == mask.count else { return nil }
    var outIds = [Int64]()
    outIds.reserveCapacity(ids.count)
    for id in ids {
      guard id.isFinite, id == id.rounded(), id >= 0, id < Double(vocabSize) else { return nil }
      outIds.append(Int64(id))
    }
    guard let outMask = SentinelSpikeTokens.bits(mask), outMask.contains(1) else { return nil }
    var outTypes: [Int64]?
    if let typeIds = typeIds {
      guard typeIds.count == ids.count, let bits = SentinelSpikeTokens.bits(typeIds) else { return nil }
      outTypes = bits
    }
    self.ids = outIds
    self.mask = outMask
    self.typeIds = outTypes
  }

  private static func bits(_ values: [Double]) -> [Int64]? {
    var out = [Int64]()
    out.reserveCapacity(values.count)
    for v in values {
      guard v == 0 || v == 1 else { return nil }
      out.append(Int64(v))
    }
    return out
  }
}
