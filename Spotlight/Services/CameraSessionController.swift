import AVFoundation
import UIKit
import Photos

enum CameraAuthorizationState: Equatable {
    case unknown
    case authorized
    case denied
    case unavailable
}

final class CameraSessionController: NSObject, ObservableObject, @unchecked Sendable {
    @Published private(set) var authorizationState: CameraAuthorizationState = .unknown
    @Published private(set) var isSessionConfigured = false
    @Published private(set) var isTorchEnabled = false
    @Published var lastErrorMessage: String?
    @Published var currentZoomLevel: CGFloat = 1.5  // Default 1.5x like Rare Candy

    let session = AVCaptureSession()
    var onImageCaptured: ((UIImage) -> Void)?

    // Debug photo saving is disabled to avoid Photos-side crashes during scanning.
    private let saveDebugPhotos = false

    // Preview view for coordinate conversion (contains the preview layer)
    @MainActor weak var previewView: PreviewView?

    @MainActor var previewLayer: AVCaptureVideoPreviewLayer? {
        previewView?.previewLayer
    }

    // Pending crop rect (normalized to photo output) set when user taps to scan
    private var pendingCropRectNormalized: CGRect?

    private let sessionQueue = DispatchQueue(label: "spotlight.camera.session")
    private let photoOutput = AVCapturePhotoOutput()
    private var videoDeviceInput: AVCaptureDeviceInput?

    @MainActor
    func requestAccessIfNeeded() {
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
                    } else {
                        print("❌ [CAMERA] Permission denied by user")
                    }
                }
            }
        case .denied:
            print("❌ [CAMERA] Permission DENIED - Go to Settings > Spotlight > Camera")
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
                print("⚠️ [CAMERA] Cannot start session - not configured")
                return
            }
            guard !self.session.isRunning else {
                print("📷 [CAMERA] Session already running")
                return
            }
            print("▶️ [CAMERA] Starting session...")
            self.session.startRunning()
            print("✅ [CAMERA] Session started!")
        }
    }

    func stopSession() {
        sessionQueue.async { [weak self] in
            guard let self else { return }
            guard self.session.isRunning else { return }
            self.session.stopRunning()
        }
    }

    @MainActor
    func capturePhoto(reticleRect: CGRect) {
        guard authorizationState == .authorized, isSessionConfigured else {
            lastErrorMessage = "Camera is not available. Import a photo instead."
            return
        }

        // Convert reticle from preview layer coordinates to photo output coordinates
        guard let previewView = previewView else {
            lastErrorMessage = "Preview view not available"
            return
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
        print("📐 [CROP] Metadata rect (normalized 0-1): \(metadataRect)")
        print("📐 [CROP] Photo rect (normalized 0-1): \(photoRect)")

        // metadataOutputRectConverted reports coordinates in the sensor/native orientation.
        // Our decoded UIImage is upright portrait, so swap axes into portrait photo space
        // before cropping, otherwise the crop becomes a tall narrow strip.
        pendingCropRectNormalized = photoRect

        let settings = AVCapturePhotoSettings()
        settings.flashMode = .off

        // Request MAXIMUM resolution for better OCR
        settings.photoQualityPrioritization = .quality
        settings.maxPhotoDimensions = photoOutput.maxPhotoDimensions

        photoOutput.capturePhoto(with: settings, delegate: self)
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
        guard !isSessionConfigured else {
            print("📷 [CAMERA] Session already configured")
            return
        }

        print("⚙️ [CAMERA] Configuring session...")
        sessionQueue.async { [weak self] in
            guard let self else { return }

            self.session.beginConfiguration()
            // Use .high preset (1920x1080) - good OCR quality without memory crashes
            // .photo (12MP) uses too much memory for Vision framework processing
            self.session.sessionPreset = .high

            defer {
                self.session.commitConfiguration()
            }

            do {
                guard let videoDevice = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
                    DispatchQueue.main.async {
                        self.authorizationState = .unavailable
                    }
                    return
                }

                let videoDeviceInput = try AVCaptureDeviceInput(device: videoDevice)

                if self.session.canAddInput(videoDeviceInput) {
                    self.session.addInput(videoDeviceInput)
                    self.videoDeviceInput = videoDeviceInput
                }

                if self.session.canAddOutput(self.photoOutput) {
                    self.session.addOutput(self.photoOutput)
                    // Use highest quality for better OCR on small text
                    self.photoOutput.maxPhotoQualityPrioritization = .quality
                }

                // Set initial zoom level
                let device = videoDeviceInput.device
                try? device.lockForConfiguration()
                device.videoZoomFactor = 1.5
                device.unlockForConfiguration()

                DispatchQueue.main.async {
                    print("✅ [CAMERA] Session configured successfully")
                    self.isSessionConfigured = true
                    // Start session after configuration completes
                    self.startSession()
                }
            } catch {
                DispatchQueue.main.async {
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

        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        if #available(iOS 12.0, *) {
            format.preferredRange = .standard
        }

        let renderer = UIGraphicsImageRenderer(size: image.size, format: format)
        let rendered = renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: image.size))
        }
        return rendered.cgImage
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

    /// Save image to Photos library for debugging
    private func saveToPhotos(_ image: UIImage, label: String) {
        PHPhotoLibrary.requestAuthorization { status in
            guard status == .authorized else {
                print("📸 [DEBUG] Photos permission denied")
                return
            }

            PHPhotoLibrary.shared().performChanges({
                PHAssetChangeRequest.creationRequestForAsset(from: image)
            }) { success, error in
                if success {
                    print("📸 [DEBUG] Saved \(label) image to Photos library")
                } else if let error = error {
                    print("❌ [DEBUG] Failed to save \(label) image: \(error.localizedDescription)")
                }
            }
        }
    }
}

extension CameraSessionController: AVCapturePhotoCaptureDelegate {
    nonisolated func photoOutput(
        _ output: AVCapturePhotoOutput,
        didFinishProcessingPhoto photo: AVCapturePhoto,
        error: Error?
    ) {
        if let error {
            DispatchQueue.main.async {
                self.lastErrorMessage = error.localizedDescription
            }
            return
        }

        guard let imageData = photo.fileDataRepresentation(),
              let image = UIImage(data: imageData),
              let cropRect = pendingCropRectNormalized else {
            DispatchQueue.main.async {
                self.lastErrorMessage = "Could not decode the captured photo."
            }
            return
        }

        print("📐 [CROP] Captured image size: \(image.size)")

        // Crop using the converted coordinates - what user saw in reticle!
        let croppedImage = cropImage(image, normalizedRect: cropRect)

        // Debug: Save to Photos library
        if saveDebugPhotos {
            saveToPhotos(croppedImage, label: "cropped")
        }

        DispatchQueue.main.async {
            self.onImageCaptured?(croppedImage)
        }

        // Clear pending crop
        pendingCropRectNormalized = nil
    }

}
