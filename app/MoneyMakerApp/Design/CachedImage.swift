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
            // preparingForDisplay() peut renvoyer nil (simulateur, certains PNG) : on garde alors l'image brute.
            return await Task.detached(priority: .utility) { UIImage(data: data).map { $0.preparingForDisplay() ?? $0 } }.value
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
    /// Image chargée, avec l'URL dont elle vient : quand l'URL change (vue réutilisée pour un autre
    /// business), l'ancienne image n'est plus affichée et la nouvelle se charge (avant, `image != nil`
    /// bloquait le chargement et l'ancienne icône restait).
    @State private var loaded: (url: URL, image: UIImage)?

    var body: some View {
        Group {
            if let img = current {
                Image(uiImage: img).resizable().scaledToFill()
            } else {
                placeholder()
            }
        }
        .task(id: url) {
            guard let url, loaded?.url != url, ImageStore.shared.cached(url) == nil else { return }
            guard let img = await ImageStore.shared.load(url), !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: 0.2)) { loaded = (url, img) }
        }
    }

    private var current: UIImage? {
        guard let url else { return nil }
        if let l = loaded, l.url == url { return l.image }
        return ImageStore.shared.cached(url)
    }
}
