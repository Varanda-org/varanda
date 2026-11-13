import ExpoModulesCore
import Foundation
import ImageIO
import UniformTypeIdentifiers

// The JS side of the iOS share target. The share extension writes each share
// into the app group container (Library/Caches/share-inbox/<id>/, manifest.json
// last); peek imports the newest one into the app's own cache and hands it
// over as local file uris, release drops it once the composer took it, sweep
// clears old leftovers. onPending is never sent on iOS: the app reads again
// when it becomes active. Native errors never reach JS (null or a no-op), and
// paths, uris and shared text are never logged.
public class ShareIntakeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ShareIntake")

    Events("onPending")

    AsyncFunction("peek") { () -> [String: Any]? in
      return ShareStore.peek()
    }

    AsyncFunction("release") { (id: String) in
      ShareStore.release(id)
    }

    AsyncFunction("sweep") { (maxAgeMs: Double) in
      ShareStore.sweep(maxAgeMs)
    }
  }
}

enum ShareStore {
  static let appGroup = "group.app.varanda"

  static let maxFiles = 10
  static let maxBytes: Int64 = 50 * 1024 * 1024
  static let maxText = 4000
  // A manifest holds at most three 4000 unit texts and ten short entries.
  static let maxManifestBytes: Int64 = 1024 * 1024

  private static let inboxPath = "Library/Caches/share-inbox"
  private static let dirName = "varanda-share"
  private static let manifestName = "manifest.json"
  private static let manifestTmp = "manifest.json.tmp"
  private static let tmpSuffix = ".tmp"
  // A released share is renamed to this before it is deleted, so a delete
  // that stops halfway can never be offered again.
  private static let goneSuffix = ".gone"

  private static let idPattern = try! NSRegularExpression(pattern: "^[0-9]{13}-[0-9a-f]{32}$")
  // What the extension may name a file: digits, a dot and a short extension.
  private static let inboxNamePattern = try! NSRegularExpression(pattern: "^[0-9]{1,3}\\.[A-Za-z0-9]{1,5}$")
  // What a stored share may name a file; the JS side checks the same shape.
  private static let fileNamePattern = try! NSRegularExpression(pattern: "^[0-9]{1,2}\\.(jpg|png|gif|webp|heic|img)$")

  // peek, release and sweep never overlap: an import in progress owns its
  // <id>.tmp directory until the rename.
  private static let lock = NSLock()

  private static var fm: FileManager { FileManager.default }

  struct StoredFile {
    let name: String
    let mime: String
    let width: Int
    let height: Int
  }

  struct Share {
    let id: String
    let at: Int64
    let title: String
    let text: String
    let url: String
    let total: Int
    let files: [StoredFile]
  }

  // MARK: - Entry points

  static func peek() -> [String: Any]? {
    lock.lock()
    defer { lock.unlock() }
    guard let root = appRoot() else { return nil }
    if let inbox = inboxRoot() {
      importNewest(inbox: inbox, root: root)
    }
    guard let share = newest(root: root) else { return nil }
    let dir = root.appendingPathComponent(share.id, isDirectory: true)
    return [
      "id": share.id,
      "at": Double(share.at),
      "title": share.title,
      "text": share.text,
      "url": share.url,
      "total": share.total,
      "files": share.files.map { file -> [String: Any] in
        let fileURL = dir.appendingPathComponent(file.name, isDirectory: false)
        return [
          "uri": "file://" + fileURL.path,
          "mimeType": file.mime,
          "width": file.width,
          "height": file.height
        ]
      }
    ]
  }

  static func release(_ id: String) {
    guard isId(id) else { return }
    lock.lock()
    defer { lock.unlock() }
    guard let root = appRoot() else { return }
    drop(root.appendingPathComponent(id, isDirectory: true))
  }

  // There is no file timestamp to trust here: the age is the id's 13 digit
  // epoch prefix.
  static func sweep(_ maxAgeMs: Double) {
    // NaN or a negative age from JS would otherwise wipe shares in progress.
    guard maxAgeMs.isFinite, maxAgeMs >= 0 else { return }
    lock.lock()
    defer { lock.unlock() }
    let now = Int64(Date().timeIntervalSince1970 * 1000)
    let oldest = now - Int64(min(maxAgeMs, 1e15))
    if let root = appRoot() {
      for name in children(root) {
        let url = root.appendingPathComponent(name)
        // Tombstones, interrupted imports (<id>.tmp) and stray names go
        // whatever their age: no import runs while the lock is held.
        if !isId(name) {
          remove(url)
        } else if let at = prefixMs(name), at < oldest {
          drop(url)
        }
      }
    }
    if let inbox = inboxRoot() {
      // The extension may be writing a recent entry, so only age decides here.
      for name in children(inbox) {
        if let at = prefixMs(name), at < oldest {
          dropInbox(inbox.appendingPathComponent(name, isDirectory: true))
        }
      }
    }
  }

  // MARK: - Step 1: import from the app group inbox

  // The newest inbox entry with a valid id and a manifest that parses is
  // imported; the other entries that have a manifest go. One without a
  // manifest is still being written by the extension and is left alone.
  private static func importNewest(inbox: URL, root: URL) {
    let complete = children(inbox)
      .filter { isId($0) && isFile(inbox.appendingPathComponent($0).appendingPathComponent(manifestName)) }
      .sorted(by: >)
    var chosen = false
    for name in complete {
      let entry = inbox.appendingPathComponent(name, isDirectory: true)
      if !chosen {
        if let manifest = readInboxManifest(entry, id: name) {
          chosen = true
          importEntry(entry, manifest: manifest, root: root)
          continue
        }
        // A manifest that could not be read is not a bad one: everything
        // stays for the next peek, and sweep ends a share that never reads.
        if readFailed(entry.appendingPathComponent(manifestName)) { return }
      }
      dropInbox(entry)
    }
  }

  // True when reading the file failed, as opposed to its content being wrong;
  // one over the size limit is never read.
  private static func readFailed(_ url: URL) -> Bool {
    guard let attrs = try? fm.attributesOfItem(atPath: url.path) else { return true }
    if let size = (attrs[.size] as? NSNumber)?.int64Value, size > maxManifestBytes { return false }
    return (try? Data(contentsOf: url)) == nil
  }

  // Transactional: the admitted files are copied (never moved) into <id>.tmp,
  // its manifest is written there last, the directory is renamed to <id>, and
  // only then is the inbox entry deleted. A crash leaves either the untouched
  // inbox entry, imported again next time, or a .tmp directory that sweep and
  // the next import delete.
  private static func importEntry(_ entry: URL, manifest: InboxManifest, root: URL) {
    let id = manifest.id
    let target = root.appendingPathComponent(id, isDirectory: true)
    if isFile(target.appendingPathComponent(manifestName)) {
      // A previous import finished; only its inbox entry was left.
      dropInbox(entry)
      return
    }
    let tmp = root.appendingPathComponent(id + tmpSuffix, isDirectory: true)
    remove(tmp)
    do {
      try fm.createDirectory(at: tmp, withIntermediateDirectories: false)
      var stored: [StoredFile] = []
      for name in manifest.files.prefix(maxFiles) {
        if let file = try admit(entry.appendingPathComponent(name, isDirectory: false), into: tmp, index: stored.count) {
          stored.append(file)
        }
      }
      let total = max(manifest.total, manifest.files.count, stored.count)
      if manifest.title.isEmpty && manifest.text.isEmpty && manifest.url.isEmpty && stored.isEmpty {
        // Nothing the composer could show.
        remove(tmp)
        dropInbox(entry)
        return
      }
      let share = Share(
        id: id,
        at: manifest.at,
        title: manifest.title,
        text: manifest.text,
        url: manifest.url,
        total: total,
        files: stored
      )
      try writeManifest(share, in: tmp)
      remove(target)
      try fm.moveItem(at: tmp, to: target)
    } catch {
      // The inbox entry stays for the next peek; sweep ends a share that
      // never imports.
      remove(tmp)
      return
    }
    dropInbox(entry)
  }

  // Copies one inbox file into the import directory when it is a regular file
  // of at most maxBytes that ImageIO reads as an image with positive sizes.
  // Its name is its place among the stored files plus an extension from its
  // mime type, so the stored names are 0 to 9. A refused file returns nil; a
  // failed copy or rename (a full disk, say) throws, so importEntry keeps the
  // inbox entry for the next peek instead of importing the share without it.
  private static func admit(_ source: URL, into dir: URL, index: Int) throws -> StoredFile? {
    guard let attrs = try? fm.attributesOfItem(atPath: source.path),
          attrs[.type] as? FileAttributeType == .typeRegular,
          let size = (attrs[.size] as? NSNumber)?.int64Value,
          size > 0, size <= maxBytes else { return nil }
    let part = dir.appendingPathComponent(String(index) + ".part", isDirectory: false)
    do {
      try fm.copyItem(at: source, to: part)
    } catch {
      remove(part)
      throw error
    }
    // The copy is what the composer reads, so the copy is what is checked: a
    // regular file again, since copyItem copies a link as a link.
    guard let copiedAttrs = try? fm.attributesOfItem(atPath: part.path),
          copiedAttrs[.type] as? FileAttributeType == .typeRegular,
          let copied = copiedAttrs[.size] as? NSNumber,
          copied.int64Value > 0, copied.int64Value <= maxBytes,
          let image = probe(part) else {
      remove(part)
      return nil
    }
    let name = String(index) + "." + fileExtension(image.mime)
    let target = dir.appendingPathComponent(name, isDirectory: false)
    do {
      try fm.moveItem(at: part, to: target)
    } catch {
      remove(part)
      throw error
    }
    return StoredFile(name: name, mime: image.mime, width: image.width, height: image.height)
  }

  private struct Probe {
    let mime: String
    let width: Int
    let height: Int
  }

  // The formats Android's decoder takes. RAW, PSD, TIFF and the other formats
  // ImageIO reads are refused on the sniffed type, before any reader parses
  // the container, so the composer never hands them to a full decoder in the
  // process that holds the account.
  static let allowedTypes: [UTType] = [UTType.jpeg, .png, .gif, .webP, .heic, .heif]
    + [UTType("public.avif")].compactMap { $0 }

  // The composer refuses sides over 16384 (MAX_MEDIA_DIMENSION in
  // src/media/plan.js) and decodes the whole image before it resizes. A shared
  // file also has to fit a pixel budget a phone can decode, since a share that
  // kills the app is offered again on every reopen until it expires. 100
  // megapixels keeps 48 MP photos and panoramas.
  static let maxSide = 16384
  static let maxPixels = 100_000_000

  // Header properties only, no full decode, read for the primary image (the
  // one a decoder shows); the sides are swapped for EXIF orientations 5 to 8,
  // since the composer resizes with both given.
  private static func probe(_ url: URL) -> Probe? {
    let options = [kCGImageSourceShouldCache: false] as CFDictionary
    guard let source = CGImageSourceCreateWithURL(url as CFURL, options),
          let typeId = CGImageSourceGetType(source),
          let type = UTType(typeId as String),
          allowedTypes.contains(where: { type.conforms(to: $0) }),
          CGImageSourceGetCount(source) > 0,
          let mime = type.preferredMIMEType,
          mime.hasPrefix("image/"),
          let props = CGImageSourceCopyPropertiesAtIndex(source, CGImageSourceGetPrimaryImageIndex(source), options) as? [CFString: Any],
          let width = positive(props[kCGImagePropertyPixelWidth]),
          let height = positive(props[kCGImagePropertyPixelHeight]),
          width <= maxSide, height <= maxSide, width * height <= maxPixels else { return nil }
    let orientation = (props[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
    if orientation >= 5 && orientation <= 8 {
      return Probe(mime: mime, width: height, height: width)
    }
    return Probe(mime: mime, width: width, height: height)
  }

  private static func positive(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber else { return nil }
    let n = number.intValue
    return n > 0 ? n : nil
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

  // MARK: - Step 2: read the stored share

  // The newest stored share whose manifest parses and whose files exist. Only
  // one share is ever pending, so the older stored ones go.
  private static func newest(root: URL) -> Share? {
    let complete = children(root)
      .filter { isId($0) && isFile(root.appendingPathComponent($0).appendingPathComponent(manifestName)) }
      .sorted(by: >)
    var found: Share?
    for name in complete {
      let dir = root.appendingPathComponent(name, isDirectory: true)
      if found == nil {
        found = readStored(dir, id: name)
        if found != nil { continue }
      }
      drop(dir)
    }
    return found
  }

  private static func readStored(_ dir: URL, id: String) -> Share? {
    guard let json = readJSON(dir.appendingPathComponent(manifestName)),
          int(json["v"]) == 1,
          json["id"] as? String == id,
          let at = prefixMs(id),
          int(json["at"]).map(Int64.init) == at,
          let total = int(json["total"]), total >= 0,
          let list = json["files"] as? [Any], list.count <= maxFiles else { return nil }
    var files: [StoredFile] = []
    for item in list {
      guard let entry = item as? [String: Any],
            let name = entry["name"] as? String, matches(fileNamePattern, name),
            let mime = entry["mime"] as? String, mime.hasPrefix("image/"),
            let width = int(entry["width"]), width > 0,
            let height = int(entry["height"]), height > 0,
            isFile(dir.appendingPathComponent(name, isDirectory: false)) else { return nil }
      files.append(StoredFile(name: name, mime: mime, width: width, height: height))
    }
    return Share(
      id: id,
      at: at,
      title: cut(json["title"] as? String ?? ""),
      text: cut(json["text"] as? String ?? ""),
      url: cut(json["url"] as? String ?? ""),
      total: max(total, files.count),
      files: files
    )
  }

  // MARK: - Manifests

  struct InboxManifest {
    let id: String
    let at: Int64
    let title: String
    let text: String
    let url: String
    let total: Int
    let files: [String]
  }

  private static func readInboxManifest(_ entry: URL, id: String) -> InboxManifest? {
    guard let json = readJSON(entry.appendingPathComponent(manifestName)),
          int(json["v"]) == 1,
          json["id"] as? String == id,
          let at = prefixMs(id),
          let list = json["files"] as? [Any] else { return nil }
    var names: [String] = []
    for item in list {
      guard let file = item as? [String: Any],
            let name = file["name"] as? String,
            matches(inboxNamePattern, name),
            !name.contains("/"), !name.contains("..") else { return nil }
      names.append(name)
    }
    let total = int(json["total"]).map { max($0, 0) } ?? names.count
    return InboxManifest(
      id: id,
      at: at,
      title: cut(json["title"] as? String ?? ""),
      text: cut(json["text"] as? String ?? ""),
      url: cut(json["url"] as? String ?? ""),
      total: total,
      files: names
    )
  }

  // Written through a temporary file and a rename, last in its directory.
  private static func writeManifest(_ share: Share, in dir: URL) throws {
    let json: [String: Any] = [
      "v": 1,
      "id": share.id,
      "at": share.at,
      "title": share.title,
      "text": share.text,
      "url": share.url,
      "total": share.total,
      "files": share.files.map { file -> [String: Any] in
        ["name": file.name, "mime": file.mime, "width": file.width, "height": file.height]
      }
    ]
    let data = try JSONSerialization.data(withJSONObject: json)
    let tmp = dir.appendingPathComponent(manifestTmp, isDirectory: false)
    try data.write(to: tmp)
    try fm.moveItem(at: tmp, to: dir.appendingPathComponent(manifestName, isDirectory: false))
  }

  private static func readJSON(_ url: URL) -> [String: Any]? {
    guard let attrs = try? fm.attributesOfItem(atPath: url.path),
          attrs[.type] as? FileAttributeType == .typeRegular,
          let size = (attrs[.size] as? NSNumber)?.int64Value,
          size <= maxManifestBytes,
          let data = try? Data(contentsOf: url) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
  }

  // A JSON number that holds an integer; true and false are not numbers here.
  private static func int(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber,
          CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    let double = number.doubleValue
    guard double.isFinite, double == double.rounded(), abs(double) < 9e15 else { return nil }
    return Int(double)
  }

  // MARK: - Places and helpers

  private static func appRoot() -> URL? {
    guard let caches = fm.urls(for: .cachesDirectory, in: .userDomainMask).first else { return nil }
    var root = caches.appendingPathComponent(dirName, isDirectory: true)
    do {
      try fm.createDirectory(at: root, withIntermediateDirectories: true)
    } catch {
      return nil
    }
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try? root.setResourceValues(values)
    return root
  }

  // nil without the app group entitlement (an unsigned or older build).
  private static func inboxRoot() -> URL? {
    guard let container = fm.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else { return nil }
    let inbox = container.appendingPathComponent(inboxPath, isDirectory: true)
    return isDirectory(inbox) ? inbox : nil
  }

  static func isId(_ id: String) -> Bool {
    return matches(idPattern, id)
  }

  private static func matches(_ pattern: NSRegularExpression, _ value: String) -> Bool {
    let range = NSRange(value.startIndex..., in: value)
    return pattern.firstMatch(in: value, options: [], range: range) != nil
  }

  private static func prefixMs(_ name: String) -> Int64? {
    let digits = name.utf8.prefix(13)
    guard digits.count == 13, digits.allSatisfy({ $0 >= 48 && $0 <= 57 }) else { return nil }
    return Int64(String(decoding: digits, as: UTF8.self))
  }

  // Cut to maxText UTF-16 units without splitting a surrogate pair.
  static func cut(_ value: String) -> String {
    let units = Array(value.utf16)
    if units.count <= maxText { return value }
    var end = maxText
    if UTF16.isLeadSurrogate(units[end - 1]) { end -= 1 }
    return String(decoding: units[0..<end], as: UTF16.self)
  }

  private static func children(_ dir: URL) -> [String] {
    return (try? fm.contentsOfDirectory(atPath: dir.path)) ?? []
  }

  private static func isFile(_ url: URL) -> Bool {
    guard let attrs = try? fm.attributesOfItem(atPath: url.path) else { return false }
    return attrs[.type] as? FileAttributeType == .typeRegular
  }

  private static func isDirectory(_ url: URL) -> Bool {
    var dir: ObjCBool = false
    return fm.fileExists(atPath: url.path, isDirectory: &dir) && dir.boolValue
  }

  private static func remove(_ url: URL) {
    try? fm.removeItem(at: url)
  }

  // A recursive delete can stop halfway and leave the manifest, so the share
  // is first moved out of newest()'s reach. If even the rename fails, the
  // manifest goes first for the same reason.
  private static func drop(_ dir: URL) {
    guard fm.fileExists(atPath: dir.path) else { return }
    let tomb = dir.deletingLastPathComponent().appendingPathComponent(dir.lastPathComponent + goneSuffix, isDirectory: true)
    remove(tomb)
    do {
      try fm.moveItem(at: dir, to: tomb)
      remove(tomb)
    } catch {
      remove(dir.appendingPathComponent(manifestName))
      remove(dir)
    }
  }

  // The inbox belongs to the extension too, so no tombstone name is added
  // there: the manifest goes first, which makes the entry no longer complete,
  // and an interrupted delete is never imported again.
  private static func dropInbox(_ entry: URL) {
    remove(entry.appendingPathComponent(manifestName))
    remove(entry)
  }
}
