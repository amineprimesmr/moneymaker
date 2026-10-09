//
//  CachedImage.swift
//  MoneyMaker — image distante avec cache mémoire.
//
//  `AsyncImage` recharge et redécode à chaque reconstruction de la vue (changement de
//  sélection, éventail, transitions). Ici : décodage une seule fois, gardé en mémoire
//  (NSCache), réponse disque via URLCache, et affichage synchrone dès que l'image est connue.
//

import SwiftUI
import UIKit

@MainActor
final class ImageStore {
    static let shared = ImageStore()
    private let memory = NSCache<NSURL, UIImage>()
    private var inflight: [URL: Task<UIImage?, Never>] = [:]
    private let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.urlCache = URLCache(memoryCapacity: 8 << 20, diskCapacity: 64 << 20)
        c.requestCachePolicy = .returnCacheDataElseLoad
        return URLSession(configuration: c)
    }()

    init() { memory.countLimit = 200 }

    func cached(_ url: URL) -> UIImage? { memory.object(forKey: url as NSURL) }

    func load(_ url: URL) async -> UIImage? {
        if let img = cached(url) { return img }
        if let t = inflight[url] { return await t.value }
        let t = Task<UIImage?, Never> {
            guard let (data, _) = try? await session.data(from: url) else { return nil }
            // Décodage + préparation hors du thread principal (pas d'à-coup au premier affichage).
            return await Task.detached(priority: .utility) { UIImage(data: data)?.preparingForDisplay() }.value
        }
        inflight[url] = t
        let img = await t.value
        inflight[url] = nil
        if let img { memory.setObject(img, forKey: url as NSURL) }
        return img
    }
}

struct CachedImage<Placeholder: View>: View {
    let url: URL?
    @ViewBuilder var placeholder: () -> Placeholder
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let img = image ?? url.flatMap({ ImageStore.shared.cached($0) }) {
                Image(uiImage: img).resizable().scaledToFill()
            } else {
                placeholder()
            }
        }
        .task(id: url) {
            guard let url, image == nil, ImageStore.shared.cached(url) == nil else { return }
            let img = await ImageStore.shared.load(url)
            withAnimation(.easeOut(duration: 0.2)) { image = img }
        }
    }
}
