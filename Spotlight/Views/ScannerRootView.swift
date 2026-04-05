import SwiftUI

struct ScannerRootView: View {
    @ObservedObject var viewModel: ScannerViewModel

    private var alternativesPresented: Binding<Bool> {
        Binding(
            get: { viewModel.route == .alternatives },
            set: { isPresented in
                guard !isPresented, viewModel.route == .alternatives else { return }
                viewModel.dismissAlternatives()
            }
        )
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            ScannerView(viewModel: viewModel)
                .transition(.opacity)

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
        .sheet(isPresented: alternativesPresented) {
            AlternateMatchesView(viewModel: viewModel)
                .presentationDetents([.fraction(0.58), .large])
                .presentationDragIndicator(.visible)
                .presentationBackground(Color(red: 0.04, green: 0.05, blue: 0.07))
        }
        .animation(.easeInOut(duration: 0.2), value: viewModel.bannerMessage)
    }
}
