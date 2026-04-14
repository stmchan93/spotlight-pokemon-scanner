import SwiftUI

struct ScannerRootView: View {
    @ObservedObject var viewModel: ScannerViewModel

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            ScannerView(viewModel: viewModel)
                .transition(.opacity)

            if viewModel.route == .resultDetail {
                ScanResultDetailView(viewModel: viewModel)
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
