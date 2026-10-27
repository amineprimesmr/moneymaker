//
//  WidgetIcons.swift
//  MoneyMaker — logos des business dans les widgets.
//  Téléchargés une seule fois par la timeline, réduits à 64 px, gardés en PNG dans le dossier
//  Caches de l'extension (clé = URL). L'entrée de timeline ne transporte que quelques Ko.
//

import SwiftUI
import UIKit
import CryptoKit

/// Logos indexés par projectId (PNG 64 px).
typealias WIcons = [String: Data]

enum WIconCache {
    static let side: CGFloat = 64
    static let maxPerEntry = 5

    private static var dir: URL? {
        guard let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else { return nil }
        let d = base.appendingPathComponent("wicons", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    private static func file(_ url: String) -> URL? {
        let h = SHA256.hash(data: Data(url.utf8)).prefix(12).map { String(format: "%02x", $0) }.joined()
        return dir?.appendingPathComponent(h + ".png")
    }

    /// Logos des business demandés (dans l'ordre, au plus `maxPerEntry`), depuis le cache ou le réseau.
    static func load(_ projectIds: [String?], overview: Overview?) async -> WIcons {
        guard let o = overview else { return [:] }
        var ids: [String] = []
        for case let id? in projectIds where !ids.contains(id) && ids.count < maxPerEntry { ids.append(id) }
        var out: WIcons = [:]
        await withTaskGroup(of: (String, Data?).self) { g in
            for id in ids {
                guard let s = o.projects.first(where: { $0.projectId == id })?.iconUrl else { continue }
                g.addTask { (id, await icon(s)) }
            }
            for await (id, d) in g { if let d { out[id] = d } }
        }
        return out
    }

    /// Logos des business d'un aperçu (classés par revenu).
    static func load(top overview: Overview?) async -> WIcons {
        let ids = (overview?.projects ?? []).sorted { $0.netRevenueMicros > $1.netRevenueMicros }.map(\.projectId)
        return await load(ids, overview: overview)
    }

    private static func icon(_ s: String) async -> Data? {
        if let f = file(s), let d = try? Data(contentsOf: f) { return d }
        guard let url = URL(string: s) else { return nil }
        var req = URLRequest(url: url)
        req.timeoutInterval = 10
        if url.host == MM.baseURL.host, let t = MoneyMakerClient.stored.token { req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
        guard let (data, res) = try? await URLSession.shared.data(for: req),
              (res as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) ?? false,
              let img = UIImage(data: data) else { return nil }
        let fmt = UIGraphicsImageRendererFormat(); fmt.scale = 1
        let small = UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: fmt).pngData { _ in
            img.draw(in: CGRect(x: 0, y: 0, width: side, height: side))
        }
        if let f = file(s) { try? small.write(to: f, options: .atomic) }
        return small
    }
}

extension Overview {
    func projectId(named name: String?) -> String? { name.flatMap { n in projects.first { $0.name == n }?.projectId } }
}

/// Logo d'un business (coins arrondis façon icône d'app), sinon pastille avec l'initiale.
struct WBizIcon: View {
    let data: Data?
    var name: String?
    var size: CGFloat = 22

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: size * 0.24, style: .continuous)
        Group {
            if let data, let img = UIImage(data: data) {
                Image(uiImage: img).resizable().interpolation(.high).scaledToFill()
            } else {
                Text(String((name ?? "∑").prefix(1)).uppercased())
                    .font(MMFont.system(size * 0.5, .semibold)).foregroundStyle(MMColor.ink)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(WTone.violetBright.opacity(0.30))
            }
        }
        .frame(width: size, height: size)
        .clipShape(shape)
        .overlay(shape.strokeBorder(MMColor.hairline, lineWidth: 0.5))
        .accessibilityHidden(true)
    }
}

/// Entrées d'une timeline : maintenant, puis chaque début de minute jusqu'au prochain rechargement,
/// pour que les anciennetés (« 2h14 ») restent exactes. Les données ne changent pas, seule la date.
func wTimelineDates(until next: Date, now: Date = .now) -> [Date] {
    var d = [now], t = Date(timeIntervalSince1970: (now.timeIntervalSince1970 / 60).rounded(.down) * 60 + 60)
    while t < next && d.count < 31 { d.append(t); t.addTimeInterval(60) }
    return d
}
