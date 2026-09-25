import Foundation
import UserNotifications
import os.log

/// Attaches the push's image (Expo push `richContent.image`) to the notification.
///
/// Expo's push service delivers `richContent` to iOS as
/// `userInfo["body"]["_richContent"]["image"]` (see expo/expo#36202). The APNs
/// payload must carry `mutable-content: 1` (Expo `mutableContent: true`) or iOS
/// never launches this extension. Any failure delivers the push unmodified.
class NotificationService: UNNotificationServiceExtension {
  private static let log = OSLog(subsystem: "com.ekalight.notification-service", category: "rich-image")

  // iOS gives the extension ~30s; stay well under it so a slow CDN still
  // yields a (text-only) banner from our own handler rather than the timeout path.
  private static let downloadTimeout: TimeInterval = 10

  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var bestAttemptContent: UNMutableNotificationContent?
  private var downloadTask: URLSessionDownloadTask?
  private let lock = NSLock()

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    self.contentHandler = contentHandler
    guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
      contentHandler(request.content)
      return
    }
    bestAttemptContent = content

    guard let imageURL = Self.imageURL(from: request.content.userInfo) else {
      deliver(content)
      return
    }

    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = Self.downloadTimeout
    configuration.timeoutIntervalForResource = Self.downloadTimeout
    let session = URLSession(configuration: configuration)

    let task = session.downloadTask(with: imageURL) { [weak self] location, response, error in
      defer { session.finishTasksAndInvalidate() }
      guard let self = self else { return }
      if let error = error {
        os_log("image download failed: %{public}@", log: Self.log, type: .error, error.localizedDescription)
        self.deliver(content)
        return
      }
      if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
        os_log("image download HTTP %d", log: Self.log, type: .error, http.statusCode)
        self.deliver(content)
        return
      }
      guard let location = location,
        let attachment = Self.makeAttachment(from: location, response: response, sourceURL: imageURL)
      else {
        self.deliver(content)
        return
      }
      content.attachments = [attachment]
      self.deliver(content)
    }
    downloadTask = task
    task.resume()
  }

  override func serviceExtensionTimeWillExpire() {
    downloadTask?.cancel()
    // Deliver the text-only content; the attachment never finished.
    if let content = bestAttemptContent {
      deliver(content)
    }
  }

  /// Calls the content handler at most once (download callback and the
  /// expiry path can race).
  private func deliver(_ content: UNNotificationContent) {
    lock.lock()
    let handler = contentHandler
    contentHandler = nil
    lock.unlock()
    handler?(content)
  }

  // MARK: - Payload

  private static func imageURL(from userInfo: [AnyHashable: Any]) -> URL? {
    // Documented Expo shape first, then defensive fallbacks.
    let candidates: [Any?] = [
      richImage(in: dictionary(userInfo["body"])?["_richContent"]),
      richImage(in: userInfo["_richContent"]),
      richImage(in: userInfo["richContent"]),
      richImage(in: dictionary(userInfo["body"])?["richContent"]),
    ]
    for case let raw as String in candidates {
      let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
      if let url = URL(string: trimmed), let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" {
        return url
      }
      os_log("ignoring unusable image url", log: log, type: .error)
    }
    return nil
  }

  private static func richImage(in value: Any?) -> String? {
    dictionary(value)?["image"] as? String
  }

  /// Accepts a dictionary, or a JSON-encoded string of one.
  private static func dictionary(_ value: Any?) -> [String: Any]? {
    if let dict = value as? [String: Any] { return dict }
    if let dict = value as? [AnyHashable: Any] {
      var result: [String: Any] = [:]
      for (key, element) in dict { if let key = key as? String { result[key] = element } }
      return result
    }
    if let string = value as? String, let data = string.data(using: .utf8) {
      return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }
    return nil
  }

  // MARK: - Attachment

  private static func makeAttachment(from location: URL, response: URLResponse?, sourceURL: URL) -> UNNotificationAttachment? {
    // UNNotificationAttachment infers the type from the file extension, and the
    // download's temp file has none.
    let ext = fileExtension(mimeType: response?.mimeType) ?? fileExtension(pathExtension: sourceURL.pathExtension) ?? "jpg"
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    let fileURL = directory.appendingPathComponent("image.\(ext)")
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      try FileManager.default.moveItem(at: location, to: fileURL)
      // The system moves the file into its own store on success.
      return try UNNotificationAttachment(identifier: "image", url: fileURL, options: nil)
    } catch {
      os_log("attachment failed: %{public}@", log: log, type: .error, error.localizedDescription)
      return nil
    }
  }

  private static func fileExtension(mimeType: String?) -> String? {
    switch mimeType?.lowercased() {
    case "image/jpeg", "image/jpg", "image/pjpeg": return "jpg"
    case "image/png": return "png"
    case "image/gif": return "gif"
    case "image/heic": return "heic"
    case "image/webp": return "webp"
    default: return nil
    }
  }

  private static func fileExtension(pathExtension: String) -> String? {
    switch pathExtension.lowercased() {
    case "jpg", "jpeg": return "jpg"
    case "png": return "png"
    case "gif": return "gif"
    case "heic": return "heic"
    case "webp": return "webp"
    default: return nil
    }
  }
}
