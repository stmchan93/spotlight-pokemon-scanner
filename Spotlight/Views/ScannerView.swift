import PhotosUI
import SwiftUI

struct ScannerView: View {
    @ObservedObject var viewModel: ScannerViewModel
    @State private var selectedPhotoItem: PhotosPickerItem?

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                scannerBackdrop

                if cameraIsInteractive {
                    Color.clear
                        .contentShape(Rectangle())
                        .onTapGesture {
                            // Only capture if camera is ready and not already processing
                            guard !viewModel.isProcessing else { return }
                            viewModel.capturePhoto()
                        }
                }

                VStack(spacing: 0) {
                    topBar
                        .padding(.horizontal, 16)
                        .padding(.top, max(proxy.safeAreaInsets.top, 14))

                    Spacer(minLength: 0)

                    scanTray(maxHeight: min(max(proxy.size.height * 0.44, 250), 410))
                        .padding(.horizontal, 12)
                        .padding(.bottom, max(proxy.safeAreaInsets.bottom, 12))
                }
            }
            .background(Color(red: 0.04, green: 0.05, blue: 0.07).ignoresSafeArea())
        }
        .onAppear {
            viewModel.startScannerSession()
        }
        .onDisappear {
            viewModel.stopScannerSession()
        }
        .onChange(of: selectedPhotoItem) { _, newItem in
            guard let newItem else { return }
            Task {
                guard let data = try? await newItem.loadTransferable(type: Data.self),
                      let image = UIImage(data: data) else {
                    await MainActor.run {
                        selectedPhotoItem = nil
                    }
                    return
                }

                await MainActor.run {
                    viewModel.processImportedPhoto(image)
                    selectedPhotoItem = nil
                }
            }
        }
    }

    private var cameraIsInteractive: Bool {
        viewModel.cameraController.authorizationState == .authorized
            && viewModel.cameraController.isSessionConfigured
    }

    private var scannerBackdrop: some View {
        ZStack {
            // Always show camera preview - session will render when ready
            CameraPreviewView(session: viewModel.cameraController.session)
                .ignoresSafeArea()

            LinearGradient(
                colors: [
                    Color.black.opacity(0.45),
                    Color.black.opacity(0.08),
                    Color.black.opacity(0.0),
                    Color.black.opacity(0.56),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea()

            scanningReticle
        }
    }

    private var topBar: some View {
        HStack(alignment: .top, spacing: 14) {
            Text("Spotlight")
                .font(.system(size: 30, weight: .bold, design: .rounded))
                .foregroundStyle(.white)

            Spacer()

            PhotosPicker(selection: $selectedPhotoItem, matching: .images) {
                TopBarIconButton(systemName: "photo.on.rectangle.angled")
            }
        }
    }

    private var backendStatusChip: some View {
        let isFallback = viewModel.usingLocalFallback
        let title = isFallback ? "Fallback" : "Live"
        let tone = isFallback
            ? Color(red: 0.96, green: 0.82, blue: 0.45)
            : Color(red: 0.47, green: 0.84, blue: 0.68)

        return HStack(spacing: 6) {
            Circle()
                .fill(tone)
                .frame(width: 8, height: 8)

            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.white)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(Color.white.opacity(0.08))
        .clipShape(Capsule())
    }

    private var scanningReticle: some View {
        VStack {
            Spacer()

            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .strokeBorder(
                    Color.white.opacity(0.82),
                    style: StrokeStyle(lineWidth: 2, dash: [12])
                )
                .frame(width: 280, height: 392)
                .overlay(alignment: .topLeading) {
                    reticleCorner
                        .rotationEffect(.degrees(0))
                        .offset(x: -1, y: -1)
                }
                .overlay(alignment: .topTrailing) {
                    reticleCorner
                        .rotationEffect(.degrees(90))
                        .offset(x: 1, y: -1)
                }
                .overlay(alignment: .bottomTrailing) {
                    reticleCorner
                        .rotationEffect(.degrees(180))
                        .offset(x: 1, y: 1)
                }
                .overlay(alignment: .bottomLeading) {
                    reticleCorner
                        .rotationEffect(.degrees(270))
                        .offset(x: -1, y: 1)
                }
                .overlay {
                    Text("Tap to scan")
                        .font(.headline.weight(.semibold))
                        .foregroundStyle(.white)
                        .shadow(color: .black.opacity(0.5), radius: 8, x: 0, y: 2)
                }

            Spacer()
        }
        .padding(.bottom, 210)
        .allowsHitTesting(false)
    }

    private var reticleCorner: some View {
        RoundedRectangle(cornerRadius: 8, style: .continuous)
            .fill(Color(red: 0.47, green: 0.84, blue: 0.68))
            .frame(width: 34, height: 34)
            .mask(
                VStack(spacing: 0) {
                    HStack(spacing: 0) {
                        Rectangle()
                            .frame(width: 34, height: 6)
                        Spacer(minLength: 0)
                    }
                    HStack(spacing: 0) {
                        Rectangle()
                            .frame(width: 6)
                        Spacer(minLength: 0)
                    }
                }
            )
    }

    private var unavailableState: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Camera unavailable")
                .font(.title2.weight(.bold))
                .foregroundStyle(.white)

            Text("You can still import photos and validate the tray-first scan flow. This is expected on Simulator when camera access is unavailable.")
                .font(.subheadline)
                .foregroundStyle(Color.white.opacity(0.72))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(24)
        .background(
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .fill(Color.white.opacity(0.06))
        )
    }

    private var unavailableControlBar: some View {
        HStack(spacing: 14) {
            PhotosPicker(selection: $selectedPhotoItem, matching: .images) {
                CompactActionChip(title: "Import Photo", icon: "photo")
            }

            Spacer(minLength: 0)
        }
    }

    private var scanPrompt: some View {
        VStack(spacing: 8) {
            Text(cameraIsInteractive ? "Tap anywhere to scan" : "Import a photo to scan")
                .font(.headline.weight(.semibold))
                .foregroundStyle(.white)

            Text(scanPromptSubtitle)
                .font(.caption)
                .foregroundStyle(Color.white.opacity(0.72))
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
        .background(Color.black.opacity(0.38))
        .clipShape(Capsule())
    }

    private var scanPromptSubtitle: String {
        if viewModel.isProcessing {
            return "Pending scans resolve directly inside the tray."
        }
        return "One card centered • show the bottom strip • avoid glare"
    }

    private var bottomControlBar: some View {
        HStack(spacing: 14) {
            PhotosPicker(selection: $selectedPhotoItem, matching: .images) {
                CompactActionChip(title: "Import", icon: "photo")
            }

            Spacer()

            Button {
                viewModel.toggleTorch()
            } label: {
                CompactActionChip(
                    title: viewModel.cameraController.isTorchEnabled ? "Torch On" : "Torch",
                    icon: viewModel.cameraController.isTorchEnabled ? "flashlight.on.fill" : "flashlight.off.fill"
                )
            }
            .disabled(!cameraIsInteractive)
        }
    }

    private func scanTray(maxHeight: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            trayHeader

            if let errorMessage = viewModel.errorMessage ?? viewModel.cameraController.lastErrorMessage {
                warningCard(title: "Scanner issue", message: errorMessage)
            }

            // Local fallback logging happens internally - no UI warning

            if viewModel.scannedItems.isEmpty {
                emptyTrayState
            } else {
                ScrollView(showsIndicators: false) {
                    VStack(spacing: 12) {
                        ForEach(viewModel.scannedItems) { item in
                            stackItemRow(item)
                        }
                    }
                    .padding(.bottom, 4)
                }
                .frame(maxHeight: maxHeight)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .background(
            RoundedRectangle(cornerRadius: 30, style: .continuous)
                .fill(Color(red: 0.07, green: 0.09, blue: 0.12).opacity(0.97))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 30, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
    }

    private var trayHeader: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Scan Tray")
                    .font(.headline)
                    .foregroundStyle(.white)

                HStack(spacing: 8) {
                    Text(viewModel.stackCountText)
                    if viewModel.trayMetrics.pendingCount > 0 {
                        Text("• \(viewModel.trayMetrics.pendingCount) pending")
                    }
                }
                .font(.footnote)
                .foregroundStyle(Color.white.opacity(0.62))
            }

            Spacer(minLength: 12)

            VStack(alignment: .trailing, spacing: 6) {
                Text("Running Total")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(Color.white.opacity(0.56))

                Text(viewModel.totalValueText)
                    .font(.system(size: 24, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
            }

            if !viewModel.scannedItems.isEmpty {
                Button("Clear") {
                    viewModel.clearScans()
                }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.white.opacity(0.76))
            }
        }
    }

    private var emptyTrayState: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("No cards scanned yet")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white)

            Text("Successful scans drop here immediately with a compact price row so you can keep scanning without leaving the camera.")
                .font(.footnote)
                .foregroundStyle(Color.white.opacity(0.64))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Color.white.opacity(0.04))
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private func stackItemRow(_ item: LiveScanStackItem) -> some View {
        VStack(spacing: 0) {
            rowPrimaryButton(item)

            if item.isExpanded, item.phase == .resolved {
                Divider()
                    .overlay(Color.white.opacity(0.08))
                    .padding(.horizontal, 14)

                expandedPricing(item)
                    .padding(14)
            }
        }
        .background(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(rowBackgroundColor(for: item.phase))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(Color.white.opacity(0.05), lineWidth: 1)
        )
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            Button(role: .destructive) {
                viewModel.removeStackItem(item.id)
            } label: {
                Label("Remove", systemImage: "trash")
            }
        }
    }

    @ViewBuilder
    private func rowPrimaryButton(_ item: LiveScanStackItem) -> some View {
        let action = rowAction(for: item)

        if let action {
            Button(action: action) {
                rowContent(item)
            }
            .buttonStyle(.plain)
        } else {
            rowContent(item)
        }
    }

    private func rowAction(for item: LiveScanStackItem) -> (() -> Void)? {
        switch item.phase {
        case .resolved:
            return { viewModel.toggleExpansion(for: item.id) }
        case .needsReview:
            return { viewModel.showAlternatives() }
        case .unsupported:
            return { viewModel.showAlternatives() }
        case .pending, .failed:
            return nil
        }
    }

    private func rowContent(_ item: LiveScanStackItem) -> some View {
        HStack(alignment: .top, spacing: 12) {
            StackItemThumbnail(item: item)

            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .top, spacing: 10) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(primaryTitle(for: item))
                            .font(.headline)
                            .foregroundStyle(.white)
                            .lineLimit(2)

                        if let secondaryTitle = secondaryTitle(for: item) {
                            Text(secondaryTitle)
                                .font(.subheadline)
                                .foregroundStyle(Color.white.opacity(0.76))
                                .lineLimit(2)
                        }
                    }

                    Spacer(minLength: 8)

                    trailingValue(item)
                }

                if let tertiaryLine = tertiaryLine(for: item) {
                    Text(tertiaryLine)
                        .font(.footnote)
                        .foregroundStyle(Color.white.opacity(0.58))
                        .lineLimit(2)
                }

                HStack(spacing: 8) {
                    Circle()
                        .fill(statusColor(for: item))
                        .frame(width: 8, height: 8)

                    Text(statusText(for: item))
                        .font(.caption)
                        .foregroundStyle(Color.white.opacity(0.7))
                        .lineLimit(1)

                    if let pricing = item.pricing, item.phase == .resolved {
                        statusCapsule(pricing.sourceLabel)
                        statusCapsule(pricing.freshnessBadgeLabel)
                    }

                    Spacer(minLength: 8)

                    if item.phase == .resolved {
                        Image(systemName: item.isExpanded ? "chevron.up" : "chevron.down")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(Color.white.opacity(0.48))
                    } else if item.phase == .needsReview || item.phase == .unsupported {
                        Text(item.phase == .unsupported ? "Unsupported" : "Fix")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(Color(red: 0.96, green: 0.82, blue: 0.45))
                    }
                }
            }
        }
        .padding(14)
    }

    @ViewBuilder
    private func trailingValue(_ item: LiveScanStackItem) -> some View {
        switch item.phase {
        case .pending:
            ProgressView()
                .tint(.white)
        case .failed:
            Text("Retry")
                .font(.caption.weight(.bold))
                .foregroundStyle(Color(red: 0.93, green: 0.53, blue: 0.53))
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(Color.white.opacity(0.06))
                .clipShape(Capsule())
        case .unsupported:
            Text("Review")
                .font(.caption.weight(.bold))
                .foregroundStyle(Color(red: 0.96, green: 0.82, blue: 0.45))
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(Color.white.opacity(0.06))
                .clipShape(Capsule())
        default:
            VStack(alignment: .trailing, spacing: 4) {
                if let pricing = item.pricing,
                   let primaryPrice = pricing.primaryDisplayPrice {
                    Text(pricing.primaryLabel.uppercased())
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(Color.white.opacity(0.5))

                    Text(formattedPrice(primaryPrice, currencyCode: pricing.currencyCode))
                        .font(.title3.weight(.bold))
                        .foregroundStyle(.white)
                } else {
                    Text(item.phase == .needsReview ? "REVIEW" : "PRICE")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(Color.white.opacity(0.5))

                    Text(item.phase == .needsReview ? "Check" : "N/A")
                        .font(.title3.weight(.bold))
                        .foregroundStyle(Color.white.opacity(0.56))
                }
            }
        }
    }

    private func expandedPricing(_ item: LiveScanStackItem) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            if let pricing = item.pricing {
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                    priceMetric(title: "Market", value: pricing.market, currencyCode: pricing.currencyCode)
                    priceMetric(title: "Low", value: pricing.low, currencyCode: pricing.currencyCode)
                    priceMetric(title: "Mid", value: pricing.mid, currencyCode: pricing.currencyCode)
                    priceMetric(title: "High", value: pricing.high, currencyCode: pricing.currencyCode)
                }

                if let spreadText = pricing.spreadText {
                    labelRow(title: "Range", value: spreadText)
                }

                labelRow(title: "Source", value: pricing.sourceLabel)
                if let grader = item.slabContext?.grader, let grade = item.slabContext?.grade {
                    labelRow(title: "Slab", value: "\(grader) \(grade)")
                }
                if let certNumber = item.slabContext?.certNumber {
                    labelRow(title: "Cert", value: certNumber)
                }
                if let pricingTierLabel = pricing.pricingTierLabel {
                    labelRow(title: "Model", value: pricingTierLabel)
                }
                labelRow(title: "Freshness", value: pricing.freshnessBadgeLabel)
                // Confidence label hidden - always accept best match
                if let compCount = pricing.compCount {
                    labelRow(title: "Comps", value: "\(compCount)")
                }
                if let lastSoldPrice = pricing.lastSoldPrice {
                    labelRow(title: "Last Sale", value: formattedPrice(lastSoldPrice, currencyCode: pricing.currencyCode))
                }
                if let pricingContextNote = item.pricingContextNote {
                    labelRow(title: "Pricing", value: pricingContextNote)
                }
                if let methodologySummary = pricing.methodologySummary {
                    labelRow(title: "Method", value: methodologySummary)
                }
                if let performance = item.performance {
                    labelRow(title: "Latency", value: performance.summaryLabel)
                }

                if let sourceUpdatedLabel = pricing.sourceUpdatedLabel {
                    labelRow(
                        title: "Provider",
                        value: sourceUpdatedLabel.replacingOccurrences(of: "Provider updated ", with: "")
                    )
                }
            } else {
                Text("Pricing unavailable for this card yet.")
                    .font(.footnote)
                    .foregroundStyle(Color.white.opacity(0.64))
                if let performance = item.performance {
                    labelRow(title: "Latency", value: performance.summaryLabel)
                }
            }

            HStack(spacing: 10) {
                Button {
                    viewModel.refreshPricing(for: item.id)
                } label: {
                    HStack(spacing: 8) {
                        if item.isRefreshingPrice {
                            ProgressView()
                                .tint(.black)
                        }
                        Text(item.isRefreshingPrice ? "Refreshing" : "Refresh")
                            .font(.subheadline.weight(.semibold))
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Color(red: 0.47, green: 0.84, blue: 0.68))
                    .foregroundStyle(.black)
                    .clipShape(Capsule())
                }
                .disabled(item.isRefreshingPrice)

                Button(role: .destructive) {
                    viewModel.removeStackItem(item.id)
                } label: {
                    Text("Remove")
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(Color.white.opacity(0.06))
                        .foregroundStyle(Color.white.opacity(0.78))
                        .clipShape(Capsule())
                }
            }
        }
    }

    private func primaryTitle(for item: LiveScanStackItem) -> String {
        switch item.phase {
        case .pending:
            return "Identifying card"
        case .failed:
            return "Could not identify card"
        case .unsupported:
            return "Likely unsupported card"
        case .needsReview, .resolved:
            return item.displayCard?.name ?? "Review match"
        }
    }

    private func secondaryTitle(for item: LiveScanStackItem) -> String? {
        switch item.phase {
        case .pending:
            return nil
        case .failed:
            return "Try a cleaner angle or show more of the card"
        case .unsupported:
            return item.reviewReason ?? "Could not confidently map this card to the supported catalog"
        case .needsReview, .resolved:
            if item.resolverMode == .psaSlab,
               let grader = item.slabContext?.grader,
               let grade = item.slabContext?.grade,
               let subtitle = item.displayCard?.subtitle {
                return "\(grader) \(grade) • \(subtitle)"
            }
            return item.displayCard?.subtitle ?? "Unknown card"
        }
    }

    private func tertiaryLine(for item: LiveScanStackItem) -> String? {
        switch item.phase {
        case .pending:
            return "Pending scan row"
        case .failed:
            return nil
        case .unsupported:
            return "Search manually or keep it marked unsupported"
        case .needsReview, .resolved:
            if let pricingLine = item.displayCard?.pricingLine {
                return pricingLine
            }
            if let displayCard = item.displayCard {
                return displayCard.detailLine
            }
            return nil
        }
    }

    private func statusText(for item: LiveScanStackItem) -> String {
        switch item.phase {
        case .pending:
            return item.statusMessage ?? "Identifying card…"
        case .failed:
            return item.statusMessage ?? "Scan failed"
        case .needsReview:
            return item.statusMessage ?? "Needs review"
        case .unsupported:
            return item.statusMessage ?? item.reviewReason ?? "Likely unsupported or custom card"
        case .resolved:
            return item.pricingContextNote ?? item.statusMessage ?? item.pricing?.freshnessLabel ?? "Pricing unavailable"
        }
    }

    private func statusColor(for item: LiveScanStackItem) -> Color {
        switch item.phase {
        case .pending:
            return Color(red: 0.96, green: 0.82, blue: 0.45)
        case .failed:
            return Color(red: 0.93, green: 0.53, blue: 0.53)
        case .needsReview:
            return Color(red: 0.96, green: 0.82, blue: 0.45)
        case .unsupported:
            return Color(red: 0.98, green: 0.63, blue: 0.39)
        case .resolved:
            return confidenceColor(item.confidence)
        }
    }

    private func rowBackgroundColor(for phase: LiveScanStackItemPhase) -> Color {
        switch phase {
        case .pending:
            return Color.white.opacity(0.045)
        case .needsReview:
            return Color(red: 0.24, green: 0.18, blue: 0.08).opacity(0.82)
        case .unsupported:
            return Color(red: 0.24, green: 0.12, blue: 0.07).opacity(0.84)
        case .resolved:
            return Color.white.opacity(0.05)
        case .failed:
            return Color(red: 0.19, green: 0.08, blue: 0.08).opacity(0.82)
        }
    }

    private func priceMetric(title: String, value: Double?, currencyCode: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption.weight(.bold))
                .foregroundStyle(Color.white.opacity(0.56))
            Text(value.map { formattedPrice($0, currencyCode: currencyCode) } ?? "—")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color.white.opacity(0.04))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func labelRow(title: String, value: String) -> some View {
        HStack {
            Text(title)
                .foregroundStyle(Color.white.opacity(0.62))
            Spacer()
            Text(value)
                .foregroundStyle(.white)
                .multilineTextAlignment(.trailing)
        }
        .font(.footnote)
    }

    private func statusCapsule(_ label: String) -> some View {
        Text(label)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(Color.white.opacity(0.82))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Color.white.opacity(0.08))
            .clipShape(Capsule())
    }

    private func warningCard(title: String, message: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.headline)
                .foregroundStyle(Color(red: 0.96, green: 0.82, blue: 0.45))

            Text(message)
                .foregroundStyle(Color.white.opacity(0.76))
                .font(.subheadline)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(Color(red: 0.21, green: 0.16, blue: 0.06))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(Color(red: 0.45, green: 0.34, blue: 0.12), lineWidth: 1)
        )
    }

    private func formattedPrice(_ value: Double, currencyCode: String) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = currencyCode
        formatter.maximumFractionDigits = 2
        formatter.minimumFractionDigits = 2
        return formatter.string(from: NSNumber(value: value)) ?? "\(currencyCode) \(value)"
    }

    private func confidenceColor(_ confidence: MatchConfidence) -> Color {
        switch confidence {
        case .high:
            return Color(red: 0.46, green: 0.85, blue: 0.68)
        case .medium:
            return Color(red: 0.96, green: 0.82, blue: 0.45)
        case .low:
            return Color(red: 0.93, green: 0.53, blue: 0.53)
        }
    }
}

private struct CompactActionChip: View {
    let title: String
    let icon: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
            Text(title)
                .font(.subheadline.weight(.semibold))
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(Color.black.opacity(0.44))
        .foregroundStyle(.white)
        .clipShape(Capsule())
    }
}

private struct TopBarIconButton: View {
    let systemName: String

    var body: some View {
        Image(systemName: systemName)
            .font(.headline.weight(.semibold))
            .foregroundStyle(.white)
            .frame(width: 44, height: 44)
            .background(Color.black.opacity(0.4))
            .clipShape(Circle())
    }
}

private struct StackItemThumbnail: View {
    let item: LiveScanStackItem

    var body: some View {
        Group {
            if let urlString = item.detail?.imageSmallURL ?? item.detail?.imageLargeURL,
               let url = URL(string: urlString) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image
                            .resizable()
                            .scaledToFill()
                    case .failure(_):
                        fallback
                    case .empty:
                        // Keep showing preview image while loading, no spinner
                        fallback
                    @unknown default:
                        fallback
                    }
                }
            } else {
                fallback
            }
        }
        .frame(width: 64, height: 90)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    @ViewBuilder
    private var fallback: some View {
        if let previewImage = item.previewImage {
            Image(uiImage: previewImage)
                .resizable()
                .scaledToFill()
        } else {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color.white.opacity(0.08))
                .overlay(
                    Text(placeholderGlyph)
                        .font(.headline.weight(.bold))
                        .foregroundStyle(.white.opacity(0.72))
                )
        }
    }

    private var placeholderGlyph: String {
        if let name = item.displayCard?.name, let first = name.first {
            return String(first)
        }

        switch item.phase {
        case .pending:
            return "…"
        case .failed:
            return "!"
        case .needsReview:
            return "?"
        case .unsupported:
            return "×"
        case .resolved:
            return "#"
        }
    }
}
