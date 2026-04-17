import Foundation

actor RemoteImagePrefetcher {
    static let shared = RemoteImagePrefetcher()

    private let session: URLSession
    private let memoryCache = NSCache<NSURL, NSData>()
    private var inFlightURLs: Set<URL> = []
    private var inFlightTasks: [URL: Task<Data?, Never>] = [:]

    init(session: URLSession? = nil) {
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.default
            configuration.requestCachePolicy = .returnCacheDataElseLoad
            configuration.urlCache = .shared
            self.session = URLSession(configuration: configuration)
        }
    }

    func cachedData(for url: URL) -> Data? {
        if let cachedData = memoryCache.object(forKey: url as NSURL) {
            return Data(referencing: cachedData)
        }

        var request = URLRequest(url: url)
        request.cachePolicy = .returnCacheDataElseLoad
        guard let cachedResponse = URLCache.shared.cachedResponse(for: request) else {
            return nil
        }

        let data = cachedResponse.data
        memoryCache.setObject(data as NSData, forKey: url as NSURL)
        return data
    }

    func data(for url: URL) async -> Data? {
        if let cached = cachedData(for: url) {
            return cached
        }

        if let inFlightTask = inFlightTasks[url] {
            return await inFlightTask.value
        }

        let task = Task<Data?, Never> { [session] in
            var request = URLRequest(url: url)
            request.cachePolicy = .returnCacheDataElseLoad
            guard let (data, response) = try? await session.data(for: request),
                  let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                return nil
            }
            return data
        }
        inFlightTasks[url] = task

        let fetchedData = await task.value
        inFlightTasks[url] = nil
        if let fetchedData {
            memoryCache.setObject(fetchedData as NSData, forKey: url as NSURL)
        }
        return fetchedData
    }

    func prefetch(urls: [URL], limit: Int = 18) {
        guard limit > 0 else { return }

        for url in urls.prefix(limit) {
            guard inFlightURLs.insert(url).inserted else { continue }
            Task {
                _ = await data(for: url)
                await self.markFinished(url)
            }
        }
    }

    private func markFinished(_ url: URL) async {
        inFlightURLs.remove(url)
    }
}
