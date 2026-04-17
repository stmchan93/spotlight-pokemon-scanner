import PhotosUI
import SwiftUI

// Preference key for reticle bounds
struct ReticleBoundsKey: PreferenceKey {
    nonisolated(unsafe) static var defaultValue: CGRect = .zero
    nonisolated static func reduce(value: inout CGRect, nextValue: () -> CGRect) {
        value = nextValue()
    }
}

struct ScannerView: View {
    @ObservedObject var viewModel: ScannerViewModel
    @ObservedObject var collectionStore: CollectionStore
    @ObservedObject var showsState: ShowsMockState
    let onExitScanner: (() -> Void)?
    @State private var selectedPhotoItem: PhotosPickerItem?
    @State private var isTrayExpanded = false
    @State private var reticleBounds: CGRect = .zero
    @State private var addTooltipItemID: UUID?
    @State private var seenAddTooltipItemIDs: Set<UUID> = []
    @State private var traySwipeOffsets: [UUID: CGFloat] = [:]

    private var activePendingItem: LiveScanStackItem? {
        viewModel.scannedItems.first(where: { $0.phase == .pending })
    }

    private var scanIsActive: Bool {
        viewModel.isCapturingPhoto || viewModel.isProcessing
    }

    private var batchSellDraft: ShowSellBatchDraft? {
        var groupedSources: [String: (entry: DeckCardEntry, itemIDs: [UUID], scannedCount: Int)] = [:]
        var orderedKeys: [String] = []

        for item in viewModel.visibleScannedItems {
            guard let source = batchSellSource(for: item) else { continue }

            if var existing = groupedSources[source.entry.id] {
                existing.itemIDs.append(source.itemID)
                existing.scannedCount += 1
                groupedSources[source.entry.id] = existing
            } else {
                orderedKeys.append(source.entry.id)
                groupedSources[source.entry.id] = (
                    entry: source.entry,
                    itemIDs: [source.itemID],
                    scannedCount: 1
                )
            }
        }

        let lines = orderedKeys.compactMap { key -> ShowSellBatchLineDraft? in
            guard let grouped = groupedSources[key] else { return nil }
            let quantityLimit = min(grouped.scannedCount, grouped.entry.quantity)
            guard quantityLimit > 0 else { return nil }

            return ShowSellBatchLineDraft(
                id: key,
                entry: grouped.entry,
                sourceItemIDs: grouped.itemIDs,
                scannedCount: grouped.scannedCount,
                quantityLimit: quantityLimit,
                suggestedUnitPrice: grouped.entry.primaryPrice ?? grouped.entry.card.pricing?.market ?? 0
            )
        }

        guard !lines.isEmpty else { return nil }
        return ShowSellBatchDraft(
            title: "Sell cards",
            subtitle: nil,
            lines: lines
        )
    }

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                scannerBackdrop

                VStack(spacing: 0) {
                    topBar
                        .padding(.horizontal, 16)
                        .padding(.top, max(proxy.safeAreaInsets.top, 14))

                    scannerStatusCard
                        .padding(.horizontal, 16)
                        .padding(.top, 20)

                    Spacer(minLength: 0)

                    // Chevron button to expand/collapse tray
                    if !viewModel.visibleScannedItems.isEmpty {
                        Button {
                            withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                                isTrayExpanded.toggle()
                            }
                        } label: {
                            Image(systemName: isTrayExpanded ? "chevron.down" : "chevron.up")
                                .font(.system(size: 16, weight: .bold))
                                .foregroundStyle(.white.opacity(0.9))
                                .frame(width: 40, height: 40)
                                .background(Color.black.opacity(0.5))
                                .clipShape(Circle())
                        }
                        .padding(.bottom, 8)
                    }

                    compactScanTray(screenHeight: proxy.size.height)
                }
            }
            .background(Color.black.ignoresSafeArea())
        }
        .onAppear {
            viewModel.startScannerSession()
            maybeShowAddTooltip()
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
        .onChange(of: viewModel.visibleScannedItems.map(\.id)) { _, _ in
            maybeShowAddTooltip()
        }
    }

    private var cameraIsInteractive: Bool {
        viewModel.cameraController.authorizationState == .authorized
            && viewModel.cameraController.isSessionConfigured
    }

    @ViewBuilder
    private var scannerStatusCard: some View {
        switch viewModel.cameraController.authorizationState {
        case .authorized where !cameraIsInteractive:
            EmptyView()
        case .denied, .unavailable:
            VStack(alignment: .leading, spacing: 14) {
                unavailableState
                unavailableControlBar
            }
        default:
            EmptyView()
        }
    }

    private var scanInteractionLocked: Bool {
        viewModel.isCapturingPhoto || viewModel.isProcessing
    }

    private var scannerBackdrop: some View {
        ZStack {
            // Always show camera preview - session will render when ready
            CameraPreviewView(
                session: viewModel.cameraController.session,
                onPreviewViewReady: { view in
                    viewModel.cameraController.previewView = view
                }
            )
            .ignoresSafeArea()

            GeometryReader { proxy in
                tapAnywhereCaptureLayer(containerProxy: proxy)
            }

            // Dark overlay with reticle cutout (Rare Candy style)
            darkOverlayWithCutout
                .allowsHitTesting(false)

            scanningReticle
        }
    }

    private var darkOverlayWithCutout: some View {
        GeometryReader { geo in
            let layout = ScannerReticleLayout.make(
                containerSize: geo.size,
                safeAreaTop: geo.safeAreaInsets.top,
                safeAreaBottom: geo.safeAreaInsets.bottom,
                mode: viewModel.scannerPresentationMode
            )

            ZStack {
                // Full screen dark overlay
                Color.black.opacity(0.6)
                    .ignoresSafeArea()

                // Clear rectangle for reticle area
                Rectangle()
                    .frame(width: layout.width, height: layout.height)
                    .position(
                        x: geo.size.width / 2,
                        y: layout.centerY
                    )
                    .blendMode(.destinationOut)
            }
            .compositingGroup()
        }
    }

    private var topBar: some View {
        HStack(alignment: .top, spacing: 14) {
            if let onExitScanner {
                Button(action: onExitScanner) {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 17, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 36, height: 36)
                        .background(Color.white.opacity(0.1))
                        .clipShape(Circle())
                }
                .buttonStyle(.plain)
            }

            Text("Looty")
                .font(.system(size: 30, weight: .bold, design: .rounded))
                .foregroundStyle(.white)

            Spacer()

            PhotosPicker(selection: $selectedPhotoItem, matching: .images) {
                TopBarIconButton(systemName: "photo.on.rectangle.angled")
            }
        }
    }

    private var scanningReticle: some View {
        GeometryReader { geo in
            let layout = ScannerReticleLayout.make(
                containerSize: geo.size,
                safeAreaTop: geo.safeAreaInsets.top,
                safeAreaBottom: geo.safeAreaInsets.bottom,
                mode: viewModel.scannerPresentationMode
            )

            HStack(spacing: 0) {
                Spacer()

                VStack(spacing: 0) {
                    Spacer()
                        .frame(height: layout.topSpacing)

                    RoundedRectangle(cornerRadius: 32, style: .continuous)
                        .strokeBorder(
                            scanIsActive ? Color(red: 0.72, green: 0.95, blue: 0.42) : Color.white.opacity(0.5),
                            style: StrokeStyle(lineWidth: 2, dash: [16, 8])
                        )
                        .frame(width: layout.width, height: layout.height)
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
                            slabReticleGuides(layout: layout)
                        }
                        .overlay {
                            reticleOverlayLabel
                        }
                        .contentShape(Rectangle())
                        .background(
                            GeometryReader { reticleGeo in
                                Color.clear.preference(
                                    key: ReticleBoundsKey.self,
                                    value: reticleGeo.frame(in: .global)
                                )
                            }
                        )
                        .onPreferenceChange(ReticleBoundsKey.self) { bounds in
                            reticleBounds = bounds
                        }
                        .allowsHitTesting(false)

                    cameraControls
                        .padding(.top, layout.controlsTopSpacing)

                    Spacer()
                        .frame(minHeight: layout.bottomClearance)
                }

                Spacer()
            }
        }
    }

    @ViewBuilder
    private func tapAnywhereCaptureLayer(containerProxy: GeometryProxy) -> some View {
        if cameraIsInteractive {
            let layout = ScannerReticleLayout.make(
                containerSize: containerProxy.size,
                safeAreaTop: containerProxy.safeAreaInsets.top,
                safeAreaBottom: containerProxy.safeAreaInsets.bottom,
                mode: viewModel.scannerPresentationMode
            )

            Color.clear
                .contentShape(Rectangle())
                .onTapGesture {
                    guard !scanInteractionLocked else { return }
                    let fallbackReticleRect = resolvedReticleCaptureRect(
                        preferred: reticleBounds,
                        containerFrame: containerProxy.frame(in: .global),
                        layout: layout
                    )
                    viewModel.capturePhoto(reticleRect: fallbackReticleRect)
                }
        }
    }

    private var cameraControls: some View {
        HStack(spacing: 12) {
            zoomControls

            Button {
                withAnimation(.spring(response: 0.24, dampingFraction: 0.88)) {
                    viewModel.scannerPresentationMode.toggle()
                }
            } label: {
                Text(viewModel.scannerPresentationMode.title)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .frame(height: 36)
                    .background(Color.white.opacity(0.16))
                    .clipShape(Capsule())
            }
            .buttonStyle(.plain)
        }
    }

    private var reticleCorner: some View {
        RoundedRectangle(cornerRadius: 10, style: .continuous)
            .fill(Color(red: 0.72, green: 0.95, blue: 0.42))  // Lime green
            .frame(width: 42, height: 42)
            .mask(
                VStack(spacing: 0) {
                    HStack(spacing: 0) {
                        Rectangle()
                            .frame(width: 42, height: 7)
                        Spacer(minLength: 0)
                    }
                    HStack(spacing: 0) {
                        Rectangle()
                            .frame(width: 7)
                        Spacer(minLength: 0)
                    }
                }
            )
    }

    @ViewBuilder
    private func slabReticleGuides(layout: ScannerReticleLayout) -> some View {
        if viewModel.scannerPresentationMode == .slab {
            VStack(spacing: 0) {
                Spacer()
                    .frame(height: layout.height * PSASlabGuidance.labelDividerRatio)

                Rectangle()
                    .fill(Color.white.opacity(0.38))
                    .frame(height: 1.5)
                    .padding(.horizontal, 18)

                Spacer(minLength: 0)
            }
        }
    }

    private var zoomControls: some View {
        HStack(spacing: 12) {
            ForEach([1.5], id: \.self) { zoom in
                Button {
                    viewModel.cameraController.setZoomLevel(zoom)
                } label: {
                    Text("\(zoom, specifier: "%.1f")x")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(
                            viewModel.cameraController.currentZoomLevel == zoom
                                ? Color.black
                                : Color.white.opacity(0.7)
                        )
                        .frame(width: 60, height: 36)
                        .background(
                            viewModel.cameraController.currentZoomLevel == zoom
                                ? Color.white
                                : Color.white.opacity(0.2)
                        )
                        .clipShape(Capsule())
                }
            }
        }
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

    private func compactScanTray(screenHeight: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header: "Recent scans" + CLEAR | "$X.XX total"
            HStack(alignment: .center, spacing: 8) {
                HStack(spacing: 8) {
                    Text("Recent scans")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(.white)

                    if !viewModel.visibleScannedItems.isEmpty {
                        Button("CLEAR") {
                            viewModel.clearScans()
                        }
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(.white.opacity(0.6))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(Color.white.opacity(0.15))
                        .clipShape(Capsule())
                    }
                }

                Spacer()

                HStack(spacing: 8) {
                    Text(viewModel.totalValueText)
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(Color(red: 0.35, green: 0.45, blue: 0.35))
                        .clipShape(Capsule())

                    if let batchSellDraft {
                        Button {
                            showsState.presentSellBatch(
                                lines: batchSellDraft.lines,
                                title: batchSellDraft.title,
                                subtitle: batchSellDraft.subtitle
                            )
                        } label: {
                            Image(systemName: "dollarsign")
                                .font(.system(size: 16, weight: .bold))
                                .foregroundStyle(.white)
                                .frame(width: 36, height: 36)
                                .background(Color(red: 0.23, green: 0.45, blue: 0.95))
                                .clipShape(Circle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color.black.opacity(0.9))

            // Cards list (show first when collapsed, all when expanded)
            if !viewModel.visibleScannedItems.isEmpty {
                let itemsToShow = isTrayExpanded ? viewModel.visibleScannedItems : Array(viewModel.visibleScannedItems.prefix(1))
                let maxHeight = isTrayExpanded ? screenHeight * 0.40 : 90.0

                ScrollView(showsIndicators: false) {
                    VStack(spacing: 12) {
                        ForEach(itemsToShow) { item in
                            compactCardRow(item)
                        }
                    }
                    .padding(.vertical, 8)
                }
                .frame(maxHeight: maxHeight)
                .background(Color.black.opacity(0.9))
            }
        }
        .background(Color.black.opacity(0.9))
    }

    private func compactCardRow(_ item: LiveScanStackItem) -> some View {
        let detailAction = rowAction(for: item)
        let cycleState = viewModel.candidateCycleState(for: item.id)
        let collectionState = collectionState(for: item)
        let swipeOffset = traySwipeOffsets[item.id] ?? 0

        return ZStack {
            trayActionBackground(
                revealedWidth: swipeOffset,
                onRemove: {
                    withAnimation(.spring(response: 0.24, dampingFraction: 0.9)) {
                        traySwipeOffsets[item.id] = nil
                    }
                    viewModel.removeStackItem(item.id)
                }
            )

            HStack(alignment: .center, spacing: 12) {
                StackItemThumbnail(
                    item: item,
                    cycleState: cycleState,
                    onPrimaryTap: detailAction,
                    onCycleTap: cycleState == nil ? nil : { viewModel.cycleCandidate(for: item.id) }
                )
                    .frame(width: 50, height: 70)

                HStack(alignment: .center, spacing: 12) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(primaryTitle(for: item))
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(.white)
                            .lineLimit(2)

                        if let secondaryTitle = secondaryTitle(for: item) {
                            Text(secondaryTitle)
                                .font(.system(size: 12))
                                .foregroundStyle(.white.opacity(0.7))
                                .lineLimit(2)
                        }

                        compactRowSupplementaryLine(for: item)
                    }

                    Spacer(minLength: 8)

                    if let pricing = item.pricing, let primaryPrice = pricing.primaryDisplayPrice {
                        VStack(alignment: .trailing, spacing: 2) {
                            Text(pricing.primaryLabel.uppercased())
                                .font(.system(size: 9, weight: .bold))
                                .foregroundStyle(.white.opacity(0.5))

                            Text(formattedPrice(primaryPrice, currencyCode: pricing.currencyCode))
                                .font(.system(size: 16, weight: .bold))
                                .foregroundStyle(.white)
                        }
                    } else if item.phase == .pending {
                        ProgressView()
                            .tint(.white)
                    }
                }
                .contentShape(Rectangle())
                .onTapGesture {
                    detailAction?()
                }

                if let collectionState {
                    trayCollectionAction(item: item, state: collectionState)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color.black.opacity(0.9))
            .frame(maxWidth: .infinity, alignment: .leading)
            .offset(x: swipeOffset)
        }
        .frame(maxWidth: .infinity)
        .contentShape(Rectangle())
        .clipped()
        .task(id: item.id) {
            viewModel.loadTrayVariantsIfNeeded(for: item.id)
        }
        .highPriorityGesture(
            DragGesture(minimumDistance: 16)
                .onChanged { value in
                    let translation = clampedTrayDismissOffset(value.translation.width)
                    traySwipeOffsets[item.id] = translation
                }
                .onEnded { value in
                    let translation = clampedTrayDismissOffset(value.translation.width)
                    if shouldRevealTrayItemAction(forSwipeOffset: translation) {
                        withAnimation(.spring(response: 0.24, dampingFraction: 0.9)) {
                            traySwipeOffsets[item.id] = trayActionRevealWidth(forSwipeOffset: translation)
                        }
                    } else {
                        withAnimation(.spring(response: 0.24, dampingFraction: 0.9)) {
                            traySwipeOffsets[item.id] = 0
                        }
                    }
                }
        )
    }

    @ViewBuilder
    private func compactRowSupplementaryLine(for item: LiveScanStackItem) -> some View {
        if shouldShowVariantLoadingState(for: item) {
            trayVariantChipLabel(title: "VARIANT: Loading…", showsChevron: false, isLoading: true)
        } else if shouldShowTrayVariantPicker(for: item) {
            trayVariantMenu(for: item)
        } else if let tertiaryLine = tertiaryLine(for: item) {
            Text(tertiaryLine)
                .font(.system(size: 11))
                .foregroundStyle(.white.opacity(0.6))
                .lineLimit(1)
        }
    }

    private func shouldShowVariantLoadingState(for item: LiveScanStackItem) -> Bool {
        (item.phase == .resolved || item.phase == .needsReview)
            && item.resolverMode == .rawCard
            && item.slabContext == nil
            && item.isLoadingVariants
            && item.availableVariants.isEmpty
    }

    private func shouldShowTrayVariantPicker(for item: LiveScanStackItem) -> Bool {
        (item.phase == .resolved || item.phase == .needsReview)
            && item.resolverMode == .rawCard
            && item.slabContext == nil
            && item.availableVariants.count > 1
    }

    private func trayVariantMenu(for item: LiveScanStackItem) -> some View {
        Menu {
            ForEach(item.availableVariants) { option in
                Button {
                    viewModel.selectTrayVariant(option.id, for: item.id)
                } label: {
                    HStack {
                        Text(option.label)
                        if trayVariantIsSelected(option, item: item) {
                            Spacer()
                            Image(systemName: "checkmark")
                        }
                    }
                }
            }
        } label: {
            trayVariantChipLabel(
                title: "VARIANT: \(trayVariantLabel(for: item))",
                showsChevron: true,
                isLoading: item.isLoadingVariants
            )
        }
        .buttonStyle(.plain)
    }

    private func trayVariantChipLabel(
        title: String,
        showsChevron: Bool,
        isLoading: Bool
    ) -> some View {
        HStack(spacing: 6) {
            if isLoading {
                ProgressView()
                    .scaleEffect(0.7)
                    .tint(Color(red: 0.74, green: 0.94, blue: 0.33))
            }

            Text(title)
                .font(.system(size: 10, weight: .bold))
                .lineLimit(1)

            if showsChevron {
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .bold))
            }
        }
        .foregroundStyle(Color(red: 0.74, green: 0.94, blue: 0.33))
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(Color.white.opacity(0.08))
        .clipShape(Capsule())
    }

    private func trayVariantLabel(for item: LiveScanStackItem) -> String {
        let selectedVariant = item.selectedVariant?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let selectedVariant,
           let option = item.availableVariants.first(where: { $0.id == selectedVariant || $0.label == selectedVariant }) {
            return option.label
        }
        if let selectedVariant, !selectedVariant.isEmpty {
            return selectedVariant
        }
        if let pricingVariant = item.basePricing?.variant?.trimmingCharacters(in: .whitespacesAndNewlines),
           !pricingVariant.isEmpty {
            return pricingVariant
        }
        return "Select"
    }

    private func trayVariantIsSelected(_ option: MarketHistoryOption, item: LiveScanStackItem) -> Bool {
        let selectedVariant = item.selectedVariant?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let selectedVariant, !selectedVariant.isEmpty {
            return option.id == selectedVariant || option.label == selectedVariant
        }
        if let pricingVariant = item.basePricing?.variant?.trimmingCharacters(in: .whitespacesAndNewlines),
           !pricingVariant.isEmpty {
            return option.id == pricingVariant || option.label == pricingVariant
        }
        return false
    }

    private func trayActionBackground(
        revealedWidth: CGFloat,
        onRemove: @escaping () -> Void
    ) -> some View {
        ZStack {
            HStack(spacing: 0) {
                Button(role: .destructive, action: onRemove) {
                    HStack(spacing: 10) {
                        Image(systemName: "trash.fill")
                            .font(.system(size: 17, weight: .bold))
                        Text("Remove")
                            .font(.system(size: 13, weight: .bold))
                    }
                    .foregroundStyle(.white)
                    .frame(width: 120)
                    .frame(maxHeight: .infinity)
                    .background(
                        LinearGradient(
                            colors: [
                                Color(red: 0.70, green: 0.18, blue: 0.18),
                                Color(red: 0.49, green: 0.08, blue: 0.08)
                            ],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )
                }
                .buttonStyle(.plain)
                .opacity(leadingTrayActionBackgroundOpacity(forRevealedWidth: revealedWidth))
                .allowsHitTesting(leadingTrayActionButtonsAreInteractive(forRevealedWidth: revealedWidth))

                Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func collectionState(for item: LiveScanStackItem) -> TrayCollectionState? {
        guard item.phase == .resolved || item.phase == .needsReview,
              !item.isProvisional,
              let card = item.displayCard else {
            return nil
        }

        return TrayCollectionState(
            card: card,
            slabContext: item.slabContext,
            quantity: collectionStore.quantity(card: card, slabContext: item.slabContext)
        )
    }

    private func trayCollectionAction(item: LiveScanStackItem, state: TrayCollectionState) -> some View {
        VStack(spacing: 4) {
            if state.quantity > 0 {
                Text("QTY \(state.quantity)")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Color.white.opacity(0.14))
                    .clipShape(Capsule())
            }

            Button {
                addCardToDeck(item: item, card: state.card, slabContext: state.slabContext)
            } label: {
                Image(systemName: "plus.square.fill")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(Color(red: 0.74, green: 0.94, blue: 0.33))
            }
            .buttonStyle(.plain)

            Text("ADD")
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(Color(red: 0.74, green: 0.94, blue: 0.33))
        }
        .frame(width: 58)
        .overlay(alignment: .topTrailing) {
            if addTooltipItemID == item.id {
                Text("Add to Inventory")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.black)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(Color.white)
                    .clipShape(Capsule())
                    .shadow(color: .black.opacity(0.22), radius: 12, y: 8)
                    .offset(x: -4, y: -42)
                    .transition(.opacity.combined(with: .scale(scale: 0.95)))
            }
        }
    }

    private func batchSellSource(for item: LiveScanStackItem) -> (itemID: UUID, entry: DeckCardEntry)? {
        guard let collectionState = collectionState(for: item),
              collectionState.quantity > 0 else {
            return nil
        }

        let entry = collectionStore.previewEntry(
            card: collectionState.card,
            slabContext: collectionState.slabContext,
            quantityFallback: collectionState.quantity
        )
        return (item.id, entry)
    }

    private func addCardToDeck(item: LiveScanStackItem, card: CardCandidate, slabContext: SlabContext?) {
        let appliedCondition: DeckCardCondition = .nearMint
        let quantity = collectionStore.add(card: card, slabContext: slabContext, condition: appliedCondition)
        viewModel.recordDeckAddition(itemID: item.id, card: card, slabContext: slabContext, condition: appliedCondition)
        addTooltipItemID = nil
        let message = "\(card.name) added to inventory • Qty \(quantity)"
        viewModel.showBannerMessage(message)
    }

    private func maybeShowAddTooltip() {
        guard addTooltipItemID == nil else {
            return
        }

        guard let item = viewModel.visibleScannedItems.first(where: {
            ($0.phase == .resolved || $0.phase == .needsReview)
                && collectionState(for: $0)?.quantity == 0
                && !seenAddTooltipItemIDs.contains($0.id)
        }) else {
            return
        }

        seenAddTooltipItemIDs.insert(item.id)
        addTooltipItemID = item.id

        Task { @MainActor in
            try? await Task.sleep(for: .seconds(2))
            if addTooltipItemID == item.id {
                addTooltipItemID = nil
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
        rowPrimaryButton(item)
        .background(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(rowBackgroundColor(for: item.phase))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(Color.white.opacity(0.05), lineWidth: 1)
        )
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
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
            return { viewModel.presentResultDetail(for: item.id) }
        case .needsReview:
            return { viewModel.presentResultDetail(for: item.id) }
        case .unsupported:
            return nil
        case .pending, .failed:
            return nil
        }
    }

    private func rowContent(_ item: LiveScanStackItem) -> some View {
        HStack(alignment: .top, spacing: 12) {
            StackItemThumbnail(
                item: item,
                cycleState: nil,
                onPrimaryTap: nil,
                onCycleTap: nil
            )

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

                    if item.phase == .resolved || item.phase == .needsReview {
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(Color.white.opacity(0.48))
                    } else if item.phase == .unsupported {
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
            if viewModel.hasAlternatives(for: item.id) {
                Button {
                    viewModel.showAlternatives(for: item.id)
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "square.stack.3d.up.fill")
                            .foregroundStyle(Color(red: 0.78, green: 0.92, blue: 0.47))

                        Text("\(viewModel.similarMatchCount(for: item.id)) similar cards found")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)

                        Spacer()

                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(Color.white.opacity(0.62))
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .background(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .fill(Color(red: 0.18, green: 0.22, blue: 0.10))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .stroke(Color(red: 0.52, green: 0.68, blue: 0.24), lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
            }

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

                labelRow(title: "Source", value: pricing.sourceDetailLabel)
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
            return "Scanning card"
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
            return item.statusMessage ?? "Reading card…"
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
            return viewModel.isCapturingPhoto ? "Hold steady for a moment" : nil
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
        // Check cache status first for resolved items
        if item.phase == .resolved, let cacheStatus = item.cacheStatus {
            switch cacheStatus {
            case .fresh:
                return "Fresh price"
            case .recent(let hours):
                return "Cached \(hours)h ago"
            case .outdated(let days):
                return "Outdated (\(days)d ago)"
            case .offline:
                return "Price unavailable (offline)"
            }
        }

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
        // Check cache status first for resolved items
        if item.phase == .resolved, let cacheStatus = item.cacheStatus {
            switch cacheStatus {
            case .fresh:
                return .green
            case .recent:
                return .yellow
            case .outdated:
                return .orange
            case .offline:
                return .red
            }
        }

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

    @ViewBuilder
    private var reticleOverlayLabel: some View {
        if scanIsActive {
            EmptyView()
        } else {
            Text("Tap Anywhere to Scan")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(.white)
                .shadow(color: .black.opacity(0.6), radius: 12, x: 0, y: 2)
        }
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

func clampedTrayDismissOffset(_ translationWidth: CGFloat) -> CGFloat {
    let maxLeadingReveal: CGFloat = 120
    return min(max(translationWidth, 0), maxLeadingReveal)
}

func shouldRevealTrayItemAction(forSwipeOffset offset: CGFloat) -> Bool {
    offset >= 72
}

func trayActionRevealWidth(forSwipeOffset offset: CGFloat) -> CGFloat {
    offset > 0 ? 120 : 0
}

func leadingTrayActionBackgroundOpacity(forRevealedWidth revealedWidth: CGFloat) -> Double {
    revealedWidth > 8 ? 1 : 0
}

func leadingTrayActionButtonsAreInteractive(forRevealedWidth revealedWidth: CGFloat) -> Bool {
    revealedWidth >= 44
}

private struct TrayCollectionState {
    let card: CardCandidate
    let slabContext: SlabContext?
    let quantity: Int
}

private struct StackItemThumbnail: View {
    let item: LiveScanStackItem
    let cycleState: ResultCandidateCycleState?
    let onPrimaryTap: (() -> Void)?
    let onCycleTap: (() -> Void)?

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            imageContent
                .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                .onTapGesture {
                    if let onCycleTap {
                        onCycleTap()
                    } else {
                        onPrimaryTap?()
                    }
                }

            if let cycleState, let onCycleTap {
                Button(action: onCycleTap) {
                    HStack(spacing: 4) {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 8, weight: .bold))
                        Text("\(cycleState.currentIndex)/\(cycleState.totalCount)")
                            .font(.system(size: 10, weight: .bold))
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 4)
                    .background(Color.black.opacity(0.82))
                    .clipShape(Capsule())
                }
                .buttonStyle(.plain)
                .padding(5)
            }
        }
        .frame(width: 64, height: 90)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    @ViewBuilder
    private var imageContent: some View {
        if let urlString = item.detail?.imageSmallURL
            ?? item.detail?.imageLargeURL
            ?? item.displayCard?.imageSmallURL
            ?? item.displayCard?.imageLargeURL,
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
