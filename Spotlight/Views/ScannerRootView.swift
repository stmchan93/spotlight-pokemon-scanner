import SwiftUI

struct ScannerRootView: View {
    @ObservedObject var viewModel: ScannerViewModel
    @ObservedObject var collectionStore: CollectionStore
    @ObservedObject var dealFlowState: ShowsMockState
    @Environment(\.lootyTheme) private var theme
    var showsInlineDetail: Bool = true
    var isVisible: Bool = true
    var keepsCameraWarmOffscreen: Bool = false
    let onExitScanner: (() -> Void)?

    private var shouldKeepCameraRunning: Bool {
        scannerCameraShouldKeepRunning(
            isVisible: isVisible,
            keepsCameraWarmOffscreen: keepsCameraWarmOffscreen,
            route: viewModel.route,
            isPresentingDealFlow: dealFlowState.presentedFlow != nil
        )
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            ScannerView(
                viewModel: viewModel,
                collectionStore: collectionStore,
                showsState: dealFlowState,
                onExitScanner: onExitScanner
            )
            .transition(.opacity)

            if showsInlineDetail && viewModel.route == .resultDetail {
                ScanResultDetailView(
                    viewModel: viewModel,
                    collectionStore: collectionStore,
                    showsState: dealFlowState
                )
                .transition(.move(edge: .trailing).combined(with: .opacity))
                .zIndex(2)
            } else if viewModel.route == .alternatives {
                AlternateMatchesView(viewModel: viewModel)
                    .transition(.move(edge: .trailing).combined(with: .opacity))
                    .zIndex(3)
            }

            if let bannerMessage = viewModel.bannerMessage {
                VStack {
                    Spacer()
                    Text(bannerMessage)
                        .font(theme.typography.headline)
                        .foregroundStyle(theme.colors.textInverse)
                        .padding(.horizontal, theme.spacing.lg)
                        .padding(.vertical, theme.spacing.sm)
                        .background(theme.colors.success)
                        .clipShape(Capsule())
                        .padding(.bottom, theme.spacing.xxl)
                }
                .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.24), value: viewModel.route)
        .animation(.easeInOut(duration: 0.2), value: viewModel.bannerMessage)
        .onAppear {
            syncScannerSession()
        }
        .onChange(of: viewModel.route) { _, _ in
            syncScannerSession()
        }
        .onChange(of: isVisible) { _, _ in
            syncScannerSession()
        }
        .onChange(of: keepsCameraWarmOffscreen) { _, _ in
            syncScannerSession()
        }
        .onChange(of: dealFlowState.presentedFlow != nil) { _, _ in
            syncScannerSession()
        }
    }

    private func syncScannerSession() {
        spotlightFlowLog("ScannerRoot syncScannerSession shouldKeepCameraRunning=\(shouldKeepCameraRunning) route=\(String(describing: viewModel.route)) dealFlowPresented=\(dealFlowState.presentedFlow != nil)")
        if shouldKeepCameraRunning {
            viewModel.startScannerSession()
        } else {
            viewModel.stopScannerSession()
        }
    }
}

func scannerCameraShouldKeepRunning(
    isVisible: Bool,
    keepsCameraWarmOffscreen: Bool,
    route: ScannerRoute,
    isPresentingDealFlow: Bool
) -> Bool {
    guard route == .scanner, !isPresentingDealFlow else { return false }
    return isVisible || keepsCameraWarmOffscreen
}

struct AppShellBottomBar: View {
    @Environment(\.lootyTheme) private var theme
    let selectedTab: AppShellTab
    let onOpenPortfolio: () -> Void
    let onOpenScanner: () -> Void
    let onOpenLedger: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: theme.spacing.lg - 2) {
            shellTabItem(
                systemName: "square.stack.fill",
                title: "Portfolio",
                isSelected: selectedTab == .portfolio,
                action: onOpenPortfolio
            )

            Button(action: onOpenScanner) {
                VStack(spacing: theme.spacing.xxs) {
                    ZStack {
                        RoundedRectangle(cornerRadius: theme.radius.md - 1, style: .continuous)
                            .fill(selectedTab == .scan ? theme.colors.brand : theme.colors.field)
                            .frame(width: 52, height: 52)

                        Image(systemName: "camera.viewfinder")
                            .font(.system(size: 20, weight: .bold))
                            .foregroundStyle(selectedTab == .scan ? theme.colors.textInverse : theme.colors.textPrimary)
                    }

                    Text("Scan")
                        .font(theme.typography.micro)
                        .foregroundStyle(selectedTab == .scan ? theme.colors.textPrimary : theme.colors.textSecondary)
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.plain)

            shellTabItem(
                systemName: "list.bullet.clipboard.fill",
                title: "Dashboard",
                isSelected: selectedTab == .ledger,
                action: onOpenLedger
            )
        }
        .padding(.horizontal, theme.spacing.xxl)
        .padding(.top, theme.spacing.xxs)
        .padding(.bottom, theme.spacing.xxxs)
        .background(
            Rectangle()
                .fill(theme.colors.canvas.opacity(0.98))
                .overlay(alignment: .top) {
                    Rectangle()
                        .fill(theme.colors.outlineSubtle)
                        .frame(height: 1)
                }
                .ignoresSafeArea(edges: .bottom)
        )
    }

    private func shellTabItem(
        systemName: String,
        title: String,
        isSelected: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(spacing: theme.spacing.xxs) {
                Image(systemName: systemName)
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(isSelected ? theme.colors.textPrimary : theme.colors.textSecondary.opacity(0.74))

                Text(title)
                    .font(theme.typography.caption)
                    .foregroundStyle(isSelected ? theme.colors.textPrimary : theme.colors.textSecondary.opacity(0.74))
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
    }
}
