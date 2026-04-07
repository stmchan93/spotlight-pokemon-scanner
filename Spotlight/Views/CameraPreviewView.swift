import AVFoundation
import SwiftUI
import UIKit

struct CameraPreviewView: UIViewRepresentable {
    let session: AVCaptureSession
    let onPreviewViewReady: ((PreviewView) -> Void)?

    func makeUIView(context: Context) -> PreviewView {
        print("📸 [PREVIEW] Creating preview view")
        let view = PreviewView()
        view.previewLayer.session = session
        // Use resizeAspect to show full camera feed (matches captured photo)
        view.previewLayer.videoGravity = .resizeAspect
        view.backgroundColor = .black
        print("📸 [PREVIEW] Preview layer session: \(session), running: \(session.isRunning)")
        print("📸 [PREVIEW] Preview layer connection: \(String(describing: view.previewLayer.connection))")

        // Pass preview view to camera controller for coordinate conversion
        onPreviewViewReady?(view)

        return view
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {
        print("📸 [PREVIEW] Updating preview view, session running: \(session.isRunning)")
        if uiView.previewLayer.session !== session {
            uiView.previewLayer.session = session
        }
        // Ensure layer fills the entire view
        uiView.previewLayer.frame = uiView.bounds
    }
}

final class PreviewView: UIView {
    override class var layerClass: AnyClass {
        AVCaptureVideoPreviewLayer.self
    }

    var previewLayer: AVCaptureVideoPreviewLayer {
        guard let layer = layer as? AVCaptureVideoPreviewLayer else {
            fatalError("Expected AVCaptureVideoPreviewLayer")
        }
        return layer
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        previewLayer.frame = bounds
        print("📸 [PREVIEW] Layout updated, frame: \(bounds)")
    }
}
