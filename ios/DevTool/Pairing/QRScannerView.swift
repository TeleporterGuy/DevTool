@preconcurrency import AVFoundation
import SwiftUI
import UIKit

/// Camera QR scanner with permission handling. Calls `onCode` for every QR
/// payload it sees (the caller decides whether it is a pairing link).
struct QRScannerPanel: View {
    let onCode: (String) -> Void

    @State private var access: CameraAccess = .checking
    @Environment(\.openURL) private var openURL

    enum CameraAccess {
        case checking, authorized, denied, unavailable
    }

    var body: some View {
        ZStack {
            switch access {
            case .checking:
                ProgressView()
            case .authorized:
                QRScannerView(onCode: onCode)
                    .overlay {
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .strokeBorder(.white.opacity(0.85), lineWidth: 3)
                            .padding(36)
                    }
            case .denied:
                placeholder(
                    symbol: "camera.fill",
                    title: "Camera access is off",
                    message: "Allow camera access in Settings to scan the pairing code, or paste the link below."
                ) {
                    Button("Open Settings") {
                        if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                    }
                    .buttonStyle(.bordered)
                }
            case .unavailable:
                placeholder(
                    symbol: "camera.metering.unknown",
                    title: "No camera available",
                    message: "Paste the pairing link from the desktop below."
                ) { EmptyView() }
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: access == .authorized ? 300 : 190)
        .background(Color.black.opacity(access == .authorized ? 1 : 0.06))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .task { access = await Self.requestAccess() }
    }

    private func placeholder<Actions: View>(symbol: String, title: String, message: String, @ViewBuilder actions: () -> Actions) -> some View {
        VStack(spacing: 10) {
            Image(systemName: symbol)
                .font(.largeTitle)
                .foregroundStyle(.secondary)
            Text(title).font(.headline)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            actions()
        }
        .padding(24)
    }

    private static func requestAccess() async -> CameraAccess {
        guard AVCaptureDevice.default(for: .video) != nil else { return .unavailable }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            return .authorized
        case .notDetermined:
            return await AVCaptureDevice.requestAccess(for: .video) ? .authorized : .denied
        default:
            return .denied
        }
    }
}

/// `AVCaptureSession` + `AVCaptureMetadataOutput` (.qr) in a view controller.
struct QRScannerView: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerViewController {
        let controller = ScannerViewController()
        controller.onCode = onCode
        return controller
    }

    func updateUIViewController(_ controller: ScannerViewController, context: Context) {
        controller.onCode = onCode
    }

    static func dismantleUIViewController(_ controller: ScannerViewController, coordinator: ()) {
        controller.stopSession()
    }
}

final class ScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((String) -> Void)?

    private let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "sk.awantech.devtool.scanner")
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var lastCode: String?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        configureSession()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        startSession()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        stopSession()
    }

    private func configureSession() {
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input)
        else { return }
        session.beginConfiguration()
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        if session.canAddOutput(output) {
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            if output.availableMetadataObjectTypes.contains(.qr) {
                output.metadataObjectTypes = [.qr]
            }
        }
        session.commitConfiguration()

        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.addSublayer(layer)
        previewLayer = layer
    }

    func startSession() {
        let session = self.session
        sessionQueue.async {
            if !session.isRunning, !session.inputs.isEmpty { session.startRunning() }
        }
    }

    func stopSession() {
        let session = self.session
        sessionQueue.async {
            if session.isRunning { session.stopRunning() }
        }
    }

    nonisolated func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        let codes = metadataObjects
            .compactMap { ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }
        guard let code = codes.first else { return }
        // The delegate queue is `.main`.
        MainActor.assumeIsolated {
            guard code != lastCode else { return }
            lastCode = code
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            onCode?(code)
        }
    }
}
