import Security
import UIKit
import UniformTypeIdentifiers

// The iOS share sheet entry. It copies what was shared into the app group
// inbox (Library/Caches/share-inbox/<id>/, manifest.json last) and tells the
// person to open Varanda; the app imports the inbox whenever it becomes
// active (modules/share-intake/ios/ShareIntakeModule.swift). Images are never
// decoded here, since an extension has little memory, and nothing is logged.
final class ShareViewController: UIViewController {
  private static let appGroup = "group.app.varanda"
  private static let inboxPath = "Library/Caches/share-inbox"
  private static let manifestName = "manifest.json"
  private static let manifestTmp = "manifest.json.tmp"
  private static let maxFiles = 10
  private static let maxBytes: Int64 = 50 * 1024 * 1024
  private static let maxText = 4000
  private static let gifType = "com.compuserve.gif"
  // A provider that never answers must not leave the sheet open.
  private static let watchdogSeconds: TimeInterval = 90
  // The share lifetime (SHARE_TTL_MS in src/sharedIntent.js): older entries
  // go even if the app is never opened again.
  private static let ttlMs: Int64 = 60 * 60 * 1000
  // The formats the app imports (ShareIntakeModule.allowedTypes).
  private static let allowedTypes: [UTType] = [UTType.jpeg, .png, .gif, .webP, .heic, .heif]
    + [UTType("public.avif")].compactMap { $0 }

  private static let doneMessage = "Pronto. Abra o app Varanda para publicar."
  private static let failMessage = "N\u{00e3}o deu para receber esse conte\u{00fa}do."

  private enum Kind {
    case image(index: Int)
    case url(index: Int)
    case text(index: Int)
  }

  private struct Saved {
    let index: Int
    let name: String
    let mime: String
  }

  // Filled from the providers' callbacks; guarded by `lock`.
  private let lock = NSLock()
  private var saved: [Saved] = []
  private var texts: [Int: String] = [:]
  private var urls: [Int: String] = [:]

  private var started = false
  private var finished = false
  private let spinner = UIActivityIndicatorView(style: .large)

  private var fm: FileManager { FileManager.default }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .clear
    spinner.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(spinner)
    NSLayoutConstraint.activate([
      spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor)
    ])
    spinner.startAnimating()
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    guard !started else { return }
    started = true
    receive()
  }

  // MARK: - Collect

  private func receive() {
    let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
    let providers = items.flatMap { $0.attachments ?? [] }
    // Some apps put their words on the item itself rather than in an
    // attachment. They go in as the title, which the composer uses only when
    // there is no other text.
    let title = Self.cut(items.compactMap { $0.attributedContentText?.string }
      .filter { !$0.isEmpty }
      .joined(separator: "\n"))
    var kinds: [(NSItemProvider, Kind)] = []
    var total = 0
    var images = 0
    for (index, provider) in providers.enumerated() {
      if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
        total += 1
        if images < Self.maxFiles {
          kinds.append((provider, .image(index: images)))
          images += 1
        }
      } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
        kinds.append((provider, .url(index: index)))
      } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
        kinds.append((provider, .text(index: index)))
      }
    }
    guard !kinds.isEmpty || !title.isEmpty,
          let id = Self.newId(),
          let entry = prepareEntry(id: id) else {
      finish(Self.failMessage)
      return
    }

    let group = DispatchGroup()
    for (provider, kind) in kinds {
      group.enter()
      switch kind {
      case .image(let index):
        loadImage(provider, index: index, into: entry) { group.leave() }
      case .url(let index):
        loadURL(provider, index: index) { group.leave() }
      case .text(let index):
        loadText(provider, index: index) { group.leave() }
      }
    }

    var settled = false
    let settle = { [weak self] in
      guard let self = self, !settled else { return }
      settled = true
      self.complete(id: id, entry: entry, total: total, title: title)
    }
    group.notify(queue: .main, execute: settle)
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.watchdogSeconds, execute: settle)
  }

  // Prefers the GIF representation so an animation survives, then the first
  // registered image type, then any image. The temporary file is copied
  // before the callback returns, since iOS deletes it afterwards.
  private func loadImage(_ provider: NSItemProvider, index: Int, into entry: URL, done: @escaping () -> Void) {
    let typeId = Self.imageType(provider)
    let mime = UTType(typeId)?.preferredMIMEType ?? "application/octet-stream"
    let name = String(index) + "." + Self.fileExtension(mime)
    let target = entry.appendingPathComponent(name, isDirectory: false)
    provider.loadFileRepresentation(forTypeIdentifier: typeId) { [weak self] url, _ in
      guard let self = self else { done(); return }
      if let url = url {
        // A file that is too big or cannot be copied is skipped, never read
        // whole into memory, where it could end the extension.
        if self.copyFile(url, to: target) {
          self.record(Saved(index: index, name: name, mime: mime))
        }
        done()
        return
      }
      // Some apps only offer the bytes; they arrive whole in memory.
      provider.loadDataRepresentation(forTypeIdentifier: typeId) { [weak self] data, _ in
        if let self = self, let data = data, data.count > 0, Int64(data.count) <= Self.maxBytes {
          do {
            try data.write(to: target, options: .withoutOverwriting)
            self.record(Saved(index: index, name: name, mime: mime))
          } catch {
            try? self.fm.removeItem(at: target)
          }
        }
        done()
      }
    }
  }

  private func loadURL(_ provider: NSItemProvider, index: Int, done: @escaping () -> Void) {
    provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { [weak self] item, _ in
      var found: URL?
      if let url = item as? URL {
        found = url
      } else if let data = item as? Data {
        found = URL(dataRepresentation: data, relativeTo: nil)
      } else if let string = item as? String {
        found = URL(string: string)
      }
      if let self = self, let url = found, let scheme = url.scheme?.lowercased(),
         scheme == "http" || scheme == "https" {
        self.lock.lock()
        self.urls[index] = Self.cut(url.absoluteString)
        self.lock.unlock()
      }
      done()
    }
  }

  private func loadText(_ provider: NSItemProvider, index: Int, done: @escaping () -> Void) {
    provider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { [weak self] item, _ in
      var found: String?
      if let string = item as? String {
        found = string
      } else if let attributed = item as? NSAttributedString {
        found = attributed.string
      } else if let data = item as? Data {
        found = String(data: data, encoding: .utf8)
      }
      if let self = self, let text = found, !text.isEmpty {
        self.lock.lock()
        self.texts[index] = text
        self.lock.unlock()
      }
      done()
    }
  }

  private func record(_ item: Saved) {
    lock.lock()
    saved.append(item)
    lock.unlock()
  }

  // MARK: - Write

  private func prepareEntry(id: String) -> URL? {
    guard let container = fm.containerURL(forSecurityApplicationGroupIdentifier: Self.appGroup) else { return nil }
    var inbox = container.appendingPathComponent(Self.inboxPath, isDirectory: true)
    do {
      try fm.createDirectory(at: inbox, withIntermediateDirectories: true)
    } catch {
      return nil
    }
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try? inbox.setResourceValues(values)
    // Shares past their lifetime are gone for the app anyway.
    let expired = Self.prefixMs(id) - Self.ttlMs
    for name in (try? fm.contentsOfDirectory(atPath: inbox.path)) ?? [] {
      if let at = Int64(name.prefix(13)), name.count > 13, at < expired {
        Self.drop(inbox.appendingPathComponent(name, isDirectory: true))
      }
    }
    let entry = inbox.appendingPathComponent(id, isDirectory: true)
    do {
      try fm.createDirectory(at: entry, withIntermediateDirectories: false)
    } catch {
      return nil
    }
    return entry
  }

  private func complete(id: String, entry: URL, total: Int, title: String) {
    lock.lock()
    let files = saved.sorted { $0.index < $1.index }
    let text = Self.cut(texts.keys.sorted().compactMap { texts[$0] }.joined(separator: "\n"))
    let url = urls.keys.sorted().first.flatMap { urls[$0] } ?? ""
    lock.unlock()

    if files.isEmpty && text.isEmpty && url.isEmpty && title.isEmpty {
      try? fm.removeItem(at: entry)
      finish(Self.failMessage)
      return
    }
    let manifest: [String: Any] = [
      "v": 1,
      "id": id,
      "at": Self.prefixMs(id),
      "title": title,
      "text": text,
      "url": url,
      "total": max(total, files.count),
      "files": files.map { ["name": $0.name, "mime": $0.mime] }
    ]
    do {
      let data = try JSONSerialization.data(withJSONObject: manifest)
      let tmp = entry.appendingPathComponent(Self.manifestTmp, isDirectory: false)
      try? fm.removeItem(at: tmp)
      try data.write(to: tmp)
      try fm.moveItem(at: tmp, to: entry.appendingPathComponent(Self.manifestName, isDirectory: false))
    } catch {
      try? fm.removeItem(at: entry)
      finish(Self.failMessage)
      return
    }
    dropOlder(than: id, in: entry.deletingLastPathComponent())
    finish(Self.doneMessage)
  }

  // Only the newest share is ever offered, so the older inbox entries go, but
  // only once this one is complete: a share that fails keeps the earlier one.
  // Ids start with their epoch milliseconds, so name order is time order.
  private func dropOlder(than id: String, in inbox: URL) {
    for name in (try? fm.contentsOfDirectory(atPath: inbox.path)) ?? [] where name < id {
      Self.drop(inbox.appendingPathComponent(name, isDirectory: true))
    }
  }

  // The manifest first, so an interrupted delete is never imported.
  private static func drop(_ entry: URL) {
    try? FileManager.default.removeItem(at: entry.appendingPathComponent(manifestName))
    try? FileManager.default.removeItem(at: entry)
  }

  // Copies a regular file of at most maxBytes; a partial copy is removed.
  // Only the size and the type are read, no timestamp (PrivacyInfo.xcprivacy).
  private func copyFile(_ source: URL, to target: URL) -> Bool {
    guard let values = try? source.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
          values.isRegularFile == true,
          let size = values.fileSize,
          size > 0, Int64(size) <= Self.maxBytes else { return false }
    do {
      try fm.copyItem(at: source, to: target)
      return true
    } catch {
      try? fm.removeItem(at: target)
      return false
    }
  }

  // MARK: - Finish

  // Shows the result and always completes the request, so the sheet cannot hang.
  private func finish(_ message: String) {
    DispatchQueue.main.async { [weak self] in
      guard let self = self, !self.finished else { return }
      self.finished = true
      self.spinner.stopAnimating()
      let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
      alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak self] _ in
        self?.extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
      })
      self.present(alert, animated: true)
    }
  }

  // MARK: - Helpers

  // A type the app admits comes before any other image type, so a photo
  // offered as RAW plus JPEG arrives as the JPEG.
  private static func imageType(_ provider: NSItemProvider) -> String {
    if provider.hasItemConformingToTypeIdentifier(gifType) { return gifType }
    for id in provider.registeredTypeIdentifiers {
      if let type = UTType(id), allowedTypes.contains(where: { type.conforms(to: $0) }) { return id }
    }
    for id in provider.registeredTypeIdentifiers {
      if let type = UTType(id), type.conforms(to: .image) { return id }
    }
    return UTType.image.identifier
  }

  private static func fileExtension(_ mime: String) -> String {
    switch mime.lowercased() {
    case "image/jpeg": return "jpg"
    case "image/png": return "png"
    case "image/gif": return "gif"
    case "image/webp": return "webp"
    case "image/heic", "image/heif": return "heic"
    default: return "img"
    }
  }

  // 13 digit epoch milliseconds, a dash and 32 random lowercase hex digits.
  private static func newId() -> String? {
    var bytes = [UInt8](repeating: 0, count: 16)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return nil }
    let ms = Int64(Date().timeIntervalSince1970 * 1000)
    let stamp = String(ms)
    guard stamp.count == 13 else { return nil }
    return stamp + "-" + bytes.map { String(format: "%02x", $0) }.joined()
  }

  private static func prefixMs(_ id: String) -> Int64 {
    return Int64(id.prefix(13)) ?? 0
  }

  // Cut to maxText UTF-16 units without splitting a surrogate pair.
  private static func cut(_ value: String) -> String {
    let units = Array(value.utf16)
    if units.count <= maxText { return value }
    var end = maxText
    if UTF16.isLeadSurrogate(units[end - 1]) { end -= 1 }
    return String(decoding: units[0..<end], as: UTF16.self)
  }
}
