import AVFoundation
import CoreImage
import UIKit
import Photos

enum CameraAuthorizationState: Equatable {
    case unknown
    case authorized
    case denied
    case unavailable
}

/// Preferred multi-scan callback payload for a successful capture.
/// Callers should key their job state by `scanID` and use the embedded
/// `captureInput` to continue OCR / matching work for that specific scan.
struct CameraCaptureResult: Sendable {
    let scanID: UUID
    let captureInput: ScanCaptureInput
}

/// Preferred multi-scan callback payload for a capture failure.
/// Callers should mark only the job with this `scanID` as failed.
struct CameraCaptureFailure: Sendable {
    let scanID: UUID
    let message: String
}

/// Preferred multi-scan callback payload for photo-library save feedback.
/// This is request-specific so callers can attach the result to the same job row.
struct CameraPhotoLibrarySaveResult: Sendable {
    let scanID: UUID
    let success: Bool
    let message: String?
}

final class CameraSessionController: NSObject, ObservableObject, @unchecked Sendable {
    @Published private(set) var authorizationState: CameraAuthorizationState = .unknown
    @Published private(set) var isSessionConfigured = false
    @Published private(set) var isTorchEnabled = false
    @Published var lastErrorMessage: String?
    @Published var currentZoomLevel: CGFloat = 1.5  // Default 1.5x like Rare Candy

    let session = AVCaptureSession()
    /// Preferred multi-scan hooks:
    /// - `onImageCapturedForRequest`: use the scanID to resolve the matching job.
    /// - `onCaptureFailedForRequest`: use the scanID to mark only that job failed.
    /// - `onCaptureSavedToPhotoLibraryForRequest`: optional per-job photo-save feedback.
    /// The legacy callbacks remain for single-flight compatibility.
    var onImageCapturedForRequest: ((CameraCaptureResult) -> Void)?
    var onCaptureFailedForRequest: ((CameraCaptureFailure) -> Void)?
    var onCaptureSavedToPhotoLibraryForRequest: ((CameraPhotoLibrarySaveResult) -> Void)?
    var onImageCaptured: ((ScanCaptureInput) -> Void)?
    var onCaptureFailed: ((String) -> Void)?
    var onCaptureSavedToPhotoLibrary: ((Bool, String?) -> Void)?

    private let saveCapturedScansToPhotoLibrary = true

    // Preview view for coordinate conversion (contains the preview layer)
    @MainActor weak var previewView: PreviewView?

    @MainActor var previewLayer: AVCaptureVideoPreviewLayer? {
        previewView?.previewLayer
    }

    private struct PendingCaptureRequest {
        let scanID: UUID
        let exactCropRectNormalized: CGRect
        let searchCropRectNormalized: CGRect
    }

    private struct CapturedPreviewFrame: @unchecked Sendable {
        let pixelBuffer: CVPixelBuffer
    }

    private let pendingRequestLock = NSLock()
    private var pendingCaptureRequestsByScanID: [UUID: PendingCaptureRequest] = [:]
    private var pendingScanIDsByPhotoUniqueID: [Int64: UUID] = [:]

    private let sessionQueue = DispatchQueue(label: "spotlight.camera.session")
    private let photoOutput = AVCapturePhotoOutput()
    private let videoOutput = AVCaptureVideoDataOutput()
    private let frameQueue = DispatchQueue(label: "spotlight.camera.frames")
    private let captureQueue = DispatchQueue(label: "spotlight.camera.capture")
    private let ciContext = CIContext()
    private let latestFrameLock = NSLock()
    private var videoDeviceInput: AVCaptureDeviceInput?
    private var latestPreviewPixelBuffer: CVPixelBuffer?
    private var isConfiguringSession = false
    private var pendingSessionStart = false

    @MainActor
    func requestAccessIfNeeded() {
        if isSessionConfigured || isConfiguringSession {
            return
        }

        print("📷 [CAMERA] Checking camera availability...")

        guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
            print("❌ [CAMERA] Camera hardware not available")
            authorizationState = .unavailable
            return
        }

        let status = AVCaptureDevice.authorizationStatus(for: .video)
        print("📷 [CAMERA] Authorization status: \(status.rawValue)")

        switch status {
        case .authorized:
            print("✅ [CAMERA] Already authorized, configuring session...")
            authorizationState = .authorized
            configureSessionIfNeeded()
        case .notDetermined:
            print("🔐 [CAMERA] Permission not determined, requesting access...")
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    guard let self else { return }
                    print("📷 [CAMERA] Permission granted: \(granted)")
                    self.authorizationState = granted ? .authorized : .denied
                    if granted {
                        self.configureSessionIfNeeded()
                        self.startSession()
                    } else {
                        print("❌ [CAMERA] Permission denied by user")
                    }
                }
            }
        case .denied:
            print("❌ [CAMERA] Permission DENIED - Go to Settings > Looty > Camera")
            authorizationState = .denied
        case .restricted:
            print("❌ [CAMERA] Camera access RESTRICTED")
            authorizationState = .denied
        @unknown default:
            print("❌ [CAMERA] Unknown authorization status")
            authorizationState = .denied
        }
    }

    func startSession() {
        guard authorizationState == .authorized else {
            print("⚠️ [CAMERA] Cannot start session - not authorized")
            return
        }

        sessionQueue.async { [weak self] in
            guard let self else { return }
            guard self.isSessionConfigured else {
                self.pendingSessionStart = true
                return
            }
            guard !self.session.isRunning else {
                print("📷 [CAMERA] Session already running")
                return
            }
            self.pendingSessionStart = false
            print("▶️ [CAMERA] Starting session...")
            self.session.startRunning()
            print("✅ [CAMERA] Session started!")
        }
    }

    func stopSession() {
        spotlightFlowLog("Camera stopSession requested authorized=\(authorizationState == .authorized) configured=\(isSessionConfigured)")
        sessionQueue.async { [weak self] in
            guard let self else { return }
            guard self.session.isRunning else {
                spotlightFlowLog("Camera stopSession skipped; session not running")
                return
            }
            let startedAt = ProcessInfo.processInfo.systemUptime
            spotlightFlowLog("Camera session stop begin")
            self.session.stopRunning()
            let elapsed = ProcessInfo.processInfo.systemUptime - startedAt
            spotlightFlowLog("Camera session stop end elapsed=\(String(format: "%.3f", elapsed))s")
        }
    }

    @MainActor
    func capturePhoto(scanID: UUID, reticleRect: CGRect, preferStillPhoto: Bool = false) -> Bool {
        guard authorizationState == .authorized, isSessionConfigured else {
            lastErrorMessage = "Camera is not available. Import a photo instead."
            return false
        }

        // Convert reticle from preview layer coordinates to photo output coordinates
        guard let previewView = previewView else {
            lastErrorMessage = "Preview view not available"
            return false
        }

        let previewLayer = previewView.previewLayer

        // Step 0: Convert from GLOBAL (screen) coordinates to preview view's LOCAL coordinates
        // This is critical - metadataOutputRectConverted expects layer-local coordinates
        let localRect = previewView.convert(reticleRect, from: nil)
        print("📐 [CROP] Reticle in global: \(reticleRect)")
        print("📐 [CROP] Reticle in local: \(localRect)")
        print("📐 [CROP] Preview view bounds: \(previewView.bounds)")

        // Step 1: Preview layer rect → Metadata rect (normalized 0-1)
        // This gives us coordinates normalized to the video feed's coordinate space
        let metadataRect = previewLayer.metadataOutputRectConverted(fromLayerRect: localRect)
        let photoRect = normalizedPhotoRect(fromMetadataRect: metadataRect)
        let searchRect = expandedSearchRect(from: photoRect)
        print("📐 [CROP] Metadata rect (normalized 0-1): \(metadataRect)")
        print("📐 [CROP] Exact photo rect (normalized 0-1): \(photoRect)")
        print("📐 [CROP] Expanded search rect (normalized 0-1): \(searchRect)")

        // metadataOutputRectConverted reports coordinates in the sensor/native orientation.
        // Our decoded UIImage is upright portrait, so swap axes into portrait photo space
        // before cropping, otherwise the crop becomes a tall narrow strip.
        let request = PendingCaptureRequest(
            scanID: scanID,
            exactCropRectNormalized: photoRect,
            searchCropRectNormalized: searchRect
        )
        registerPendingCaptureRequest(request)

        if !preferStillPhoto, captureLatestPreviewFrame(for: request) {
            print("📸 [CAPTURE] Using latest preview pixel buffer")
            return true
        }

        let settings = AVCapturePhotoSettings()
        settings.flashMode = .off

        // Use the quality-focused still-photo path when explicitly requested.
        settings.photoQualityPrioritization = preferStillPhoto ? .quality : .balanced
        if preferStillPhoto {
            print("📸 [CAPTURE] Capturing high-resolution still photo for OCR")
        } else {
            print("📸 [CAPTURE] Falling back to still photo capture")
        }

        registerPendingStillPhotoRequest(request, uniqueID: settings.uniqueID)
        photoOutput.capturePhoto(with: settings, delegate: self)
        return true
    }

    func toggleTorch() {
        sessionQueue.async { [weak self] in
            guard let self, let device = self.videoDeviceInput?.device, device.hasTorch else { return }

            do {
                try device.lockForConfiguration()
                device.torchMode = self.isTorchEnabled ? .off : .on
                device.unlockForConfiguration()

                DispatchQueue.main.async {
                    self.isTorchEnabled.toggle()
                }
            } catch {
                DispatchQueue.main.async {
                    self.lastErrorMessage = "Unable to change the torch setting."
                }
            }
        }
    }

    @MainActor
    func setZoomLevel(_ zoomLevel: CGFloat) {
        currentZoomLevel = zoomLevel
        sessionQueue.async { [weak self] in
            guard let self, let device = self.videoDeviceInput?.device else { return }

            do {
                try device.lockForConfiguration()
                // Clamp zoom to device's max optical zoom factor
                let maxZoom = min(zoomLevel, device.maxAvailableVideoZoomFactor)
                device.videoZoomFactor = maxZoom
                device.unlockForConfiguration()
                print("📷 [CAMERA] Set zoom to \(maxZoom)x")
            } catch {
                DispatchQueue.main.async {
                    self.lastErrorMessage = "Unable to change zoom level."
                }
            }
        }
    }

    private func configureSessionIfNeeded() {
        guard !isSessionConfigured, !isConfiguringSession else {
            print("📷 [CAMERA] Session already configured")
            return
        }

        isConfiguringSession = true
        print("⚙️ [CAMERA] Configuring session...")
        sessionQueue.async { [weak self] in
            guard let self else { return }

            self.session.beginConfiguration()
            // Favor the live preview path for tap-to-scan. `.high` keeps preview
            // capture responsive while still allowing explicit still-photo fallback.
            if self.session.canSetSessionPreset(.high) {
                self.session.sessionPreset = .high
            } else {
                self.session.sessionPreset = .photo
            }

            defer {
                self.session.commitConfiguration()
            }

            do {
                guard let videoDevice = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
                    DispatchQueue.main.async {
                        self.isConfiguringSession = false
                        self.authorizationState = .unavailable
                    }
                    return
                }

                let videoDeviceInput = try AVCaptureDeviceInput(device: videoDevice)

                if self.session.canAddInput(videoDeviceInput) {
                    self.session.addInput(videoDeviceInput)
                    self.videoDeviceInput = videoDeviceInput
                }

                self.videoOutput.alwaysDiscardsLateVideoFrames = true
                self.videoOutput.videoSettings = [
                    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
                ]
                self.videoOutput.setSampleBufferDelegate(self, queue: self.frameQueue)

                if self.session.canAddOutput(self.videoOutput) {
                    self.session.addOutput(self.videoOutput)
                    if let connection = self.videoOutput.connection(with: .video),
                       connection.isVideoRotationAngleSupported(90) {
                        connection.videoRotationAngle = 90
                    }
                }

                if self.session.canAddOutput(self.photoOutput) {
                    self.session.addOutput(self.photoOutput)
                    self.photoOutput.maxPhotoQualityPrioritization = .quality
                }

                // Set initial zoom level
                let device = videoDeviceInput.device
                try? device.lockForConfiguration()
                device.videoZoomFactor = 1.5
                device.unlockForConfiguration()

                DispatchQueue.main.async {
                    print("✅ [CAMERA] Session configured successfully")
                    self.isConfiguringSession = false
                    self.isSessionConfigured = true
                    if self.pendingSessionStart {
                        self.startSession()
                    }
                }
            } catch {
                DispatchQueue.main.async {
                    self.isConfiguringSession = false
                    self.lastErrorMessage = "Unable to configure the camera session."
                }
            }
        }
    }

    /// Normalize image orientation (critical - many "shift" bugs are orientation bugs)
    private func normalizedCGImage(from image: UIImage) -> CGImage? {
        if image.imageOrientation == .up, let cg = image.cgImage {
            return cg
        }

        let isSideways = image.imageOrientation == .left
            || image.imageOrientation == .leftMirrored
            || image.imageOrientation == .right
            || image.imageOrientation == .rightMirrored
        let renderSize = isSideways
            ? CGSize(width: image.size.height, height: image.size.width)
            : image.size

        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        if #available(iOS 12.0, *) {
            format.preferredRange = .standard
        }

        let renderer = UIGraphicsImageRenderer(size: renderSize, format: format)
        let rendered = renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: renderSize))
        }
        return rendered.cgImage
    }

    private func captureLatestPreviewFrame(for request: PendingCaptureRequest) -> Bool {
        latestFrameLock.lock()
        let pixelBuffer = latestPreviewPixelBuffer
        latestFrameLock.unlock()

        guard let pixelBuffer else {
            return false
        }

        let capturedFrame = CapturedPreviewFrame(pixelBuffer: pixelBuffer)
        captureQueue.async { [weak self] in
            guard let self else { return }
            guard self.isPendingCaptureRequestActive(scanID: request.scanID) else {
                return
            }
            guard let image = self.previewImage(from: capturedFrame.pixelBuffer) else {
                DispatchQueue.main.async {
                    self.reportCaptureFailure(
                        scanID: request.scanID,
                        message: "Could not capture the current camera frame."
                    )
                }
                return
            }

            let captureInput = self.makeCaptureInput(
                from: image,
                request: request,
                source: .livePreviewFrame
            )
            DispatchQueue.main.async {
                guard self.isPendingCaptureRequestActive(scanID: request.scanID) else {
                    return
                }
                guard let captureInput else {
                    self.reportCaptureFailure(
                        scanID: request.scanID,
                        message: "Could not prepare the captured frame."
                    )
                    return
                }
                self.finishCapturedScan(captureInput, request: request)
            }
        }

        return true
    }

    private func previewImage(from pixelBuffer: CVPixelBuffer) -> UIImage? {
        let rawWidth = CVPixelBufferGetWidth(pixelBuffer)
        let rawHeight = CVPixelBufferGetHeight(pixelBuffer)
        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        let imageRect = ciImage.extent.integral

        print("📸 [CAPTURE] Preview buffer dimensions: \(rawWidth)x\(rawHeight)")
        print("📸 [CAPTURE] Preview image dimensions: \(Int(imageRect.width))x\(Int(imageRect.height))")

        guard let cgImage = ciContext.createCGImage(ciImage, from: imageRect) else {
            return nil
        }

        return UIImage(cgImage: cgImage)
    }

    /// Crop image using normalized rect (0-1 coordinates from AVFoundation conversion)
    private func cropImage(_ image: UIImage, normalizedRect: CGRect) -> UIImage {
        guard let cgImage = normalizedCGImage(from: image) else { return image }

        let width = CGFloat(cgImage.width)
        let height = CGFloat(cgImage.height)

        print("📐 [CROP] Input normalized rect: \(normalizedRect)")
        print("📐 [CROP] Image dimensions after normalization: \(Int(width))x\(Int(height))")

        // Validate normalized rect is in 0-1 range
        guard normalizedRect.origin.x >= 0, normalizedRect.origin.x <= 1,
              normalizedRect.origin.y >= 0, normalizedRect.origin.y <= 1,
              normalizedRect.size.width > 0, normalizedRect.size.width <= 1,
              normalizedRect.size.height > 0, normalizedRect.size.height <= 1 else {
            print("❌ [CROP] Normalized rect values out of 0-1 range!")
            return image
        }

        let cropRect = CGRect(
            x: normalizedRect.origin.x * width,
            y: normalizedRect.origin.y * height,
            width: normalizedRect.size.width * width,
            height: normalizedRect.size.height * height
        ).integral

        // Clamp to image bounds
        let clampedRect = cropRect.intersection(CGRect(x: 0, y: 0, width: width, height: height))

        print("📐 [CROP] Crop rect in pixels: \(cropRect)")
        print("📐 [CROP] Clamped to bounds: \(clampedRect)")

        guard !clampedRect.isEmpty, let croppedCG = cgImage.cropping(to: clampedRect) else {
            print("❌ [CROP] Cropping failed - rect may be outside image bounds")
            return image
        }

        print("✅ [CROP] Cropped dimensions: \(croppedCG.width)x\(croppedCG.height)")

        return UIImage(cgImage: croppedCG)
    }

    private func makeCaptureInput(
        from image: UIImage,
        request: PendingCaptureRequest,
        source: ScanCaptureSource
    ) -> ScanCaptureInput? {
        let normalizedImage = image.normalizedOrientation()
        let searchImage = cropImage(normalizedImage, normalizedRect: request.searchCropRectNormalized)
        let fallbackImage = cropImage(normalizedImage, normalizedRect: request.exactCropRectNormalized)

        ScanStageArtifactWriter.recordCaptureArtifacts(
            scanID: request.scanID,
            source: source,
            originalImage: normalizedImage,
            searchImage: searchImage,
            fallbackImage: fallbackImage,
            exactCropRectNormalized: request.exactCropRectNormalized,
            searchCropRectNormalized: request.searchCropRectNormalized
        )

        return ScanCaptureInput(
            originalImage: normalizedImage,
            searchImage: searchImage,
            fallbackImage: fallbackImage,
            captureSource: source
        )
    }

    /// Convert AVFoundation metadata coordinates into normalized upright photo coordinates.
    /// The preview layer conversion returns values in the camera sensor's orientation, which
    /// is rotated relative to the portrait JPEG we crop for OCR.
    private func normalizedPhotoRect(fromMetadataRect metadataRect: CGRect) -> CGRect {
        let unitRect = CGRect(x: 0, y: 0, width: 1, height: 1)
        let portraitRect = CGRect(
            x: metadataRect.minY,
            y: metadataRect.minX,
            width: metadataRect.height,
            height: metadataRect.width
        ).standardized

        return portraitRect.intersection(unitRect)
    }

    private func expandedSearchRect(from exactRect: CGRect, expansionFactor: CGFloat = 1.45) -> CGRect {
        let unitRect = CGRect(x: 0, y: 0, width: 1, height: 1)
        guard !exactRect.isEmpty else { return unitRect }

        let expandedWidth = min(1, exactRect.width * expansionFactor)
        let expandedHeight = min(1, exactRect.height * expansionFactor)
        let centerX = exactRect.midX
        let centerY = exactRect.midY

        var expandedRect = CGRect(
            x: centerX - (expandedWidth / 2),
            y: centerY - (expandedHeight / 2),
            width: expandedWidth,
            height: expandedHeight
        )

        if expandedRect.minX < 0 {
            expandedRect.origin.x = 0
        }
        if expandedRect.minY < 0 {
            expandedRect.origin.y = 0
        }
        if expandedRect.maxX > 1 {
            expandedRect.origin.x = 1 - expandedRect.width
        }
        if expandedRect.maxY > 1 {
            expandedRect.origin.y = 1 - expandedRect.height
        }

        return expandedRect.intersection(unitRect)
    }

    private func persistCapturedScan(_ image: UIImage, request: PendingCaptureRequest) {
        guard saveCapturedScansToPhotoLibrary else { return }

        requestPhotoLibraryAddAuthorizationIfNeeded { [weak self] granted in
            guard let self else { return }
            guard granted else {
                DispatchQueue.main.async {
                    let message = "Photo library access is required to save captured scans."
                    print("⚠️ [CAPTURE] \(message)")
                    self.onCaptureSavedToPhotoLibraryForRequest?(
                        CameraPhotoLibrarySaveResult(
                            scanID: request.scanID,
                            success: false,
                            message: message
                        )
                    )
                    self.onCaptureSavedToPhotoLibrary?(false, message)
                }
                return
            }

            PHPhotoLibrary.shared().performChanges({
                PHAssetChangeRequest.creationRequestForAsset(from: image)
            }) { success, error in
                DispatchQueue.main.async {
                    if success {
                        self.onCaptureSavedToPhotoLibraryForRequest?(
                            CameraPhotoLibrarySaveResult(
                                scanID: request.scanID,
                                success: true,
                                message: nil
                            )
                        )
                        return
                    } else {
                        let message = error?.localizedDescription ?? "Could not save captured scan to Photos."
                        print("❌ [CAPTURE] Failed to save captured scan: \(message)")
                        self.onCaptureSavedToPhotoLibraryForRequest?(
                            CameraPhotoLibrarySaveResult(
                                scanID: request.scanID,
                                success: false,
                                message: message
                            )
                        )
                        self.onCaptureSavedToPhotoLibrary?(false, message)
                    }
                }
            }
        }
    }

    private func requestPhotoLibraryAddAuthorizationIfNeeded(
        completion: @escaping @Sendable (Bool) -> Void
    ) {
        if #available(iOS 14, *) {
            let status = PHPhotoLibrary.authorizationStatus(for: .addOnly)
            switch status {
            case .authorized, .limited:
                completion(true)
            case .notDetermined:
                PHPhotoLibrary.requestAuthorization(for: .addOnly) { requestedStatus in
                    completion(requestedStatus == .authorized || requestedStatus == .limited)
                }
            case .denied, .restricted:
                completion(false)
            @unknown default:
                completion(false)
            }
            return
        }

        let status = PHPhotoLibrary.authorizationStatus()
        switch status {
        case .authorized:
            completion(true)
        case .notDetermined:
            PHPhotoLibrary.requestAuthorization { requestedStatus in
                completion(requestedStatus == .authorized)
            }
        case .denied, .restricted, .limited:
            completion(false)
        @unknown default:
            completion(false)
        }
    }
}

extension CameraSessionController: AVCapturePhotoCaptureDelegate {
    nonisolated func photoOutput(
        _ output: AVCapturePhotoOutput,
        didFinishProcessingPhoto photo: AVCapturePhoto,
        error: Error?
    ) {
        let uniqueID = photo.resolvedSettings.uniqueID
        if let error {
            DispatchQueue.main.async {
                self.reportCaptureFailure(
                    uniqueID: uniqueID,
                    message: error.localizedDescription
                )
            }
            return
        }

        guard let imageData = photo.fileDataRepresentation(),
              let image = UIImage(data: imageData) else {
            DispatchQueue.main.async {
                self.reportCaptureFailure(
                    uniqueID: uniqueID,
                    message: "Could not decode the captured photo."
                )
            }
            return
        }

        guard let request = pendingCaptureRequest(forPhotoUniqueID: uniqueID) else {
            DispatchQueue.main.async {
                self.reportCaptureFailure(
                    uniqueID: uniqueID,
                    message: "Could not find the pending scan for the captured photo."
                )
            }
            return
        }

        print("📐 [CROP] Captured image size: \(image.size)")

        let captureInput = makeCaptureInput(
            from: image,
            request: request,
            source: .liveStillPhoto
        )

        DispatchQueue.main.async {
            guard let captureInput else {
                self.reportCaptureFailure(
                    scanID: request.scanID,
                    message: "Could not prepare the captured photo."
                )
                return
            }
            self.finishCapturedScan(captureInput, request: request)
        }

    }

}

extension CameraSessionController: AVCaptureVideoDataOutputSampleBufferDelegate {
    nonisolated func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        guard output === videoOutput,
              let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
            return
        }

        latestFrameLock.lock()
        latestPreviewPixelBuffer = pixelBuffer
        latestFrameLock.unlock()
    }
}

private extension CameraSessionController {
    private func registerPendingCaptureRequest(_ request: PendingCaptureRequest) {
        pendingRequestLock.lock()
        pendingCaptureRequestsByScanID[request.scanID] = request
        pendingRequestLock.unlock()
    }

    private func registerPendingStillPhotoRequest(_ request: PendingCaptureRequest, uniqueID: Int64) {
        pendingRequestLock.lock()
        pendingCaptureRequestsByScanID[request.scanID] = request
        pendingScanIDsByPhotoUniqueID[uniqueID] = request.scanID
        pendingRequestLock.unlock()
    }

    private func pendingCaptureRequest(forPhotoUniqueID uniqueID: Int64) -> PendingCaptureRequest? {
        pendingRequestLock.lock()
        defer { pendingRequestLock.unlock() }
        guard let scanID = pendingScanIDsByPhotoUniqueID[uniqueID] else {
            return nil
        }
        return pendingCaptureRequestsByScanID[scanID]
    }

    private func isPendingCaptureRequestActive(scanID: UUID) -> Bool {
        pendingRequestLock.lock()
        defer { pendingRequestLock.unlock() }
        return pendingCaptureRequestsByScanID[scanID] != nil
    }

    private func discardPendingCaptureRequest(scanID: UUID) {
        pendingRequestLock.lock()
        pendingCaptureRequestsByScanID.removeValue(forKey: scanID)
        pendingScanIDsByPhotoUniqueID = Dictionary(
            uniqueKeysWithValues: pendingScanIDsByPhotoUniqueID.filter { $0.value != scanID }
        )
        pendingRequestLock.unlock()
    }

    private func discardPendingCaptureRequest(uniqueID: Int64) -> UUID? {
        pendingRequestLock.lock()
        defer { pendingRequestLock.unlock() }
        guard let scanID = pendingScanIDsByPhotoUniqueID.removeValue(forKey: uniqueID) else {
            return nil
        }
        pendingCaptureRequestsByScanID.removeValue(forKey: scanID)
        return scanID
    }

    private func finishCapturedScan(_ captureInput: ScanCaptureInput, request: PendingCaptureRequest) {
        discardPendingCaptureRequest(scanID: request.scanID)
        persistCapturedScan(captureInput.fallbackImage ?? captureInput.searchImage, request: request)

        let result = CameraCaptureResult(scanID: request.scanID, captureInput: captureInput)
        onImageCapturedForRequest?(result)
        onImageCaptured?(captureInput)
    }

    private func reportCaptureFailure(scanID: UUID, message: String) {
        lastErrorMessage = message
        discardPendingCaptureRequest(scanID: scanID)
        onCaptureFailedForRequest?(CameraCaptureFailure(scanID: scanID, message: message))
        onCaptureFailed?(message)
    }

    private func reportCaptureFailure(uniqueID: Int64, message: String) {
        lastErrorMessage = message
        let scanID = discardPendingCaptureRequest(uniqueID: uniqueID)
        if let scanID {
            onCaptureFailedForRequest?(CameraCaptureFailure(scanID: scanID, message: message))
        }
        onCaptureFailed?(message)
    }
}
