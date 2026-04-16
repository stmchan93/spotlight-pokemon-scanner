import SwiftUI

struct ScannerRootView: View {
    @ObservedObject var viewModel: ScannerViewModel
    @ObservedObject var collectionStore: CollectionStore
    @ObservedObject var dealFlowState: ShowsMockState
    let onExitScanner: (() -> Void)?

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

            if viewModel.route == .resultDetail {
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
                        .font(.headline)
                        .foregroundStyle(.black)
                        .padding(.horizontal, 18)
                        .padding(.vertical, 12)
                        .background(Color(red: 0.47, green: 0.84, blue: 0.68))
                        .clipShape(Capsule())
                        .padding(.bottom, 28)
                }
                .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.24), value: viewModel.route)
        .animation(.easeInOut(duration: 0.2), value: viewModel.bannerMessage)
    }
}

struct AppShellBottomBar: View {
    let selectedTab: AppShellTab
    let onOpenPortfolio: () -> Void
    let onOpenScanner: () -> Void
    let onOpenLedger: () -> Void

    private let inkBackground = Color(red: 0.04, green: 0.05, blue: 0.07)
    private let outline = Color.white.opacity(0.08)
    private let limeAccent = Color(red: 0.79, green: 0.92, blue: 0.36)

    var body: some View {
        HStack(alignment: .center, spacing: 18) {
            shellTabItem(
                systemName: "square.stack.fill",
                title: "Portfolio",
                isSelected: selectedTab == .portfolio,
                action: onOpenPortfolio
            )

            Button(action: onOpenScanner) {
                VStack(spacing: 6) {
                    ZStack {
                        RoundedRectangle(cornerRadius: 13, style: .continuous)
                            .fill(selectedTab == .scan ? limeAccent : Color.white.opacity(0.10))
                            .frame(width: 52, height: 52)

                        Image(systemName: "camera.viewfinder")
                            .font(.system(size: 20, weight: .bold))
                            .foregroundStyle(selectedTab == .scan ? .black : .white)
                    }

                    Text("Scan")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(selectedTab == .scan ? .white : .white.opacity(0.70))
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
        .padding(.horizontal, 28)
        .padding(.top, 6)
        .padding(.bottom, 4)
        .background(
            Rectangle()
                .fill(inkBackground.opacity(0.98))
                .overlay(alignment: .top) {
                    Rectangle()
                        .fill(outline)
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
            VStack(spacing: 6) {
                Image(systemName: systemName)
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(isSelected ? .white : .white.opacity(0.52))

                Text(title)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(isSelected ? .white : .white.opacity(0.52))
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
    }
}
