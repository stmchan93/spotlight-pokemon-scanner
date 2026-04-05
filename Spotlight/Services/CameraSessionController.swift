import AVFoundation
import UIKit

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

    let session = AVCaptureSession()
    var onImageCaptured: ((UIImage) -> Void)?

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

    func capturePhoto() {
        guard authorizationState == .authorized, isSessionConfigured else {
            lastErrorMessage = "Camera is not available. Import a photo instead."
            return
        }

        let settings = AVCapturePhotoSettings()
        settings.flashMode = .off
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

    private func configureSessionIfNeeded() {
        guard !isSessionConfigured else {
            print("📷 [CAMERA] Session already configured")
            return
        }

        print("⚙️ [CAMERA] Configuring session...")
        sessionQueue.async { [weak self] in
            guard let self else { return }

            self.session.beginConfiguration()
            // Use medium preset instead of photo to reduce memory usage
            self.session.sessionPreset = .medium

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
                    // Use balanced quality to reduce memory usage
                    self.photoOutput.maxPhotoQualityPrioritization = .balanced
                }

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
              let image = UIImage(data: imageData) else {
            DispatchQueue.main.async {
                self.lastErrorMessage = "Could not decode the captured photo."
            }
            return
        }

        // Crop image to match preview's visible area (resizeAspectFill behavior)
        let croppedImage = cropToPreviewAspect(image: image)

        DispatchQueue.main.async {
            self.onImageCaptured?(croppedImage)
        }
    }

    private func cropToPreviewAspect(image: UIImage) -> UIImage {
        // Preview bounds from logs: 390x844 (iPhone screen in portrait)
        // This matches resizeAspectFill behavior - crop image to fill screen aspect
        let previewAspect: CGFloat = 390.0 / 844.0  // ~0.462
        let imageSize = image.size
        let imageAspect = imageSize.width / imageSize.height

        var cropRect: CGRect

        if imageAspect > previewAspect {
            // Image is wider than preview - crop sides
            let newWidth = imageSize.height * previewAspect
            let xOffset = (imageSize.width - newWidth) / 2
            cropRect = CGRect(x: xOffset, y: 0, width: newWidth, height: imageSize.height)
        } else {
            // Image is taller than preview - crop top/bottom
            let newHeight = imageSize.width / previewAspect
            let yOffset = (imageSize.height - newHeight) / 2
            cropRect = CGRect(x: 0, y: yOffset, width: imageSize.width, height: newHeight)
        }

        guard let cgImage = image.cgImage?.cropping(to: cropRect) else {
            return image
        }

        return UIImage(cgImage: cgImage, scale: image.scale, orientation: image.imageOrientation)
    }
}
