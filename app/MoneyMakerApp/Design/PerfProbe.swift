import UIKit

/// Sonde de mesure (debug) : lancée avec `-mmPerf 1`, elle fait défiler la page la plus haute
/// de haut en bas plusieurs fois et enregistre la durée de chaque image dans
/// Documents/perf.json. `-mmPerfOff a,b` désactive des composants pour comparer.
enum PerfProbe {
    static let enabled = UserDefaults.standard.bool(forKey: "mmPerf")
    static let off = Set((UserDefaults.standard.string(forKey: "mmPerfOff") ?? "").split(separator: ",").map(String.init))
    static func isOff(_ name: String) -> Bool { off.contains(name) }

    static func start() {
        guard enabled else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) { Runner.shared.begin() }
    }

    final class Runner: NSObject {
        static let shared = Runner()
        private var link: CADisplayLink?
        private weak var scroll: UIScrollView?
        private var last: CFTimeInterval = 0
        private var t0: CFTimeInterval = 0
        private var frames: [Double] = []
        private var expected: [Double] = []
        private let duration = 3.0, passes = 4

        func begin() {
            guard let win = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.keyWindow }).first,
                  let sv = Self.biggestScroll(in: win) else { return }
            scroll = sv
            link = CADisplayLink(target: self, selector: #selector(tick(_:)))
            link?.preferredFrameRateRange = CAFrameRateRange(minimum: 80, maximum: 120, preferred: 120)
            link?.add(to: .main, forMode: .common)
        }

        @objc private func tick(_ l: CADisplayLink) {
            guard let sv = scroll else { return }
            if t0 == 0 { t0 = l.timestamp; last = l.timestamp; return }
            frames.append((l.timestamp - last) * 1000); expected.append((l.targetTimestamp - l.timestamp) * 1000)
            last = l.timestamp
            let t = l.timestamp - t0, maxY = max(sv.contentSize.height - sv.bounds.height + sv.adjustedContentInset.bottom, 0)
            let pass = Int(t / duration)
            if pass >= passes { finish(); return }
            let f = (t.truncatingRemainder(dividingBy: duration)) / duration
            let y = (pass % 2 == 0 ? f : 1 - f) * maxY - sv.adjustedContentInset.top
            sv.setContentOffset(CGPoint(x: 0, y: y), animated: false)
        }

        private func finish() {
            link?.invalidate(); link = nil
            let sorted = frames.sorted()
            let budget = expected.sorted()[expected.count / 2]
            let hitches = frames.filter { $0 > budget * 1.5 }
            let hitchMs = frames.reduce(0) { $0 + max($1 - budget, 0) }
            let total = frames.reduce(0, +)
            let r: [String: Any] = ["frames": frames.count, "budgetMs": budget, "p50": sorted[sorted.count / 2],
                                    "p95": sorted[Int(Double(sorted.count) * 0.95)], "max": sorted.last ?? 0,
                                    "hitches": hitches.count, "hitchRatioMsPerS": hitchMs / (total / 1000),
                                    "off": Array(off), "contentHeight": scroll?.contentSize.height ?? 0]
            if let d = try? JSONSerialization.data(withJSONObject: r, options: .prettyPrinted),
               let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first?.appendingPathComponent("perf.json") {
                try? d.write(to: url)
            }
        }

        private static func biggestScroll(in v: UIView) -> UIScrollView? {
            var best: UIScrollView?
            func walk(_ v: UIView) {
                if let s = v as? UIScrollView, s.contentSize.height > s.bounds.height + 100, s.window != nil,
                   s.bounds.width > 300, (best == nil || s.contentSize.height > best!.contentSize.height) { best = s }
                v.subviews.forEach(walk)
            }
            walk(v); return best
        }
    }
}
