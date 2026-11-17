import CoreGraphics
import ExpoModulesCore
import Foundation
import ImageIO

// Encodes one photo to AVIF with the system ImageIO encoder only. The photo
// is redrawn into a fresh opaque sRGB bitmap and that bitmap is what gets
// encoded, with no properties from the source, so no EXIF, GPS, TIFF or
// alpha item can reach the output. Native error text never reaches JS, and
// paths are never logged.
public class ImagePrepModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ImagePrep")

    // On the private queue too: the first call's trial encode would
    // otherwise hold Expo's shared AsyncFunction queue.
    AsyncFunction("canEncodeAvif") { () -> Bool in
      return ImagePrepAvif.supported
    }.runOnQueue(ImagePrepAvif.queue)

    AsyncFunction("encodeAvif") { (uri: String, maxSide: Double, quality: Double) -> [String: Any]? in
      return autoreleasepool {
        return ImagePrepAvif.encode(uri: uri, maxSide: maxSide, quality: quality)
      }
    }.runOnQueue(ImagePrepAvif.queue)
  }
}

enum ImagePrepAvif {
  // Serial: one decoded photo and one encoder in memory at a time.
  static let queue = DispatchQueue(label: "app.varanda.image-prep", qos: .userInitiated, autoreleaseFrequency: .workItem)

  private static let avifType = "public.avif" as CFString
  private static let maxSourcePixels = 100_000_000.0
  // ImageIO writes 512 px grid tiles, and the receiving parser allows at most
  // 64 tiles and MAX_MEDIA_PIXELS, which 4096 x 4096 meets exactly.
  private static let maxOutputSide = 4096
  private static let minSide = 16
  private static let staleAge: TimeInterval = 10 * 60

  // A static let is initialised once, lazily and thread safely. The type
  // list alone is not enough: a device can list public.avif and still fail
  // to encode, so a small image is encoded once as well. 16 x 16 is the
  // smallest size the format probe recorded.
  static let supported: Bool = probe()

  private static func probe() -> Bool {
    guard let types = CGImageDestinationCopyTypeIdentifiers() as? [String],
          types.contains(avifType as String),
          let context = opaqueContext(width: minSide, height: minSide) else {
      return false
    }
    context.setFillColor(red: 0.5, green: 0.5, blue: 0.5, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: minSide, height: minSide))
    guard let image = context.makeImage(), let data = avifData(image, quality: 0.5) else {
      return false
    }
    return data.count > 0
  }

  static func encode(uri: String, maxSide: Double, quality: Double) -> [String: Any]? {
    guard supported,
          maxSide.isFinite, maxSide == maxSide.rounded(),
          maxSide >= Double(minSide), maxSide <= Double(maxOutputSide),
          quality > 0, quality <= 1,
          let url = URL(string: uri), url.isFileURL else {
      return nil
    }
    let side = Int(maxSide)
    guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
          CGImageSourceGetCount(source) > 0 else {
      return nil
    }
    let index = CGImageSourceGetPrimaryImageIndex(source)
    guard let properties = CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [CFString: Any],
          let sourceWidth = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue,
          let sourceHeight = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue,
          sourceWidth > 0, sourceHeight > 0,
          // Checked before decoding: a huge source would be decoded in full
          // memory before the thumbnail is scaled down.
          sourceWidth * sourceHeight <= maxSourcePixels else {
      return nil
    }
    let thumbnailOptions: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: side,
      kCGImageSourceShouldCacheImmediately: true
    ]
    guard let decoded = CGImageSourceCreateThumbnailAtIndex(source, index, thumbnailOptions as CFDictionary) else {
      return nil
    }
    // Odd sides make ImageIO add a clean aperture (clap) box, which the
    // receiving profile refuses, so both sides are rounded down to even and
    // the extra top row or right column is cut off rather than stretched.
    let width = decoded.width / 2 * 2
    let height = decoded.height / 2 * 2
    guard width >= minSide, height >= minSide, width <= side, height <= side,
          let context = opaqueContext(width: width, height: height) else {
      return nil
    }
    // A transparent source would otherwise turn black where it was clear.
    context.setFillColor(red: 1, green: 1, blue: 1, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    // Drawn at its own size from the bottom left corner, so the extra top row
    // and right column fall outside the bitmap.
    context.draw(decoded, in: CGRect(x: 0, y: 0, width: decoded.width, height: decoded.height))
    // At 1.0 this encoder wrote no data in a macOS probe, so the top stays
    // a step below it; under 0.1 a photo collapses into a few hundred bytes
    // of blocks.
    guard let flat = context.makeImage(),
          let data = avifData(flat, quality: min(0.98, max(0.1, quality))),
          data.count > 0 else {
      return nil
    }

    let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("image-prep", isDirectory: true)
    removeStale(in: dir)
    let output = dir.appendingPathComponent(UUID().uuidString + ".avif")
    do {
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      try data.write(to: output, options: .atomic)
    } catch {
      try? FileManager.default.removeItem(at: output)
      return nil
    }
    return ["uri": output.absoluteString, "width": width, "height": height]
  }

  // The caller deletes what it reads, but an app killed in between, or an
  // answer JS refused, leaves a photo behind. Ten minutes is far longer than
  // any caller holds a file, and the queue is serial, so no encode of ours is
  // mid write.
  private static func removeStale(in dir: URL) {
    let keys: [URLResourceKey] = [.isRegularFileKey, .contentModificationDateKey]
    guard let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles]) else {
      return
    }
    let cutoff = Date().addingTimeInterval(-staleAge)
    for file in files {
      guard let values = try? file.resourceValues(forKeys: Set(keys)),
            values.isRegularFile == true,
            let modified = values.contentModificationDate, modified < cutoff else {
        continue
      }
      try? FileManager.default.removeItem(at: file)
    }
  }

  // Opaque on purpose: with no alpha channel the encoder writes no alpha
  // auxiliary item.
  private static func opaqueContext(width: Int, height: Int) -> CGContext? {
    guard let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
    return CGContext(
      data: nil,
      width: width,
      height: height,
      bitsPerComponent: 8,
      bytesPerRow: 0,
      space: space,
      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
    )
  }

  // Only the quality goes in the properties: nothing from the source does.
  private static func avifData(_ image: CGImage, quality: Double) -> Data? {
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data as CFMutableData, avifType, 1, nil) else {
      return nil
    }
    let properties = [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary
    CGImageDestinationAddImage(destination, image, properties)
    guard CGImageDestinationFinalize(destination) else { return nil }
    return data as Data
  }
}
