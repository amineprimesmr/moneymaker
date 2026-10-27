//
//  AutoTour.swift
//  MoneyMaker — visite automatique filmée pour la vidéo de démo (DEBUG uniquement, MM_AUTO_TOUR=1).
//
//  L'app s'enregistre elle-même (ReplayKit) : l'écran reste noir jusqu'au début de l'enregistrement,
//  puis l'ouverture se joue, et la visite parcourt les pages. Le film est écrit dans
//  Documents/tour.mp4, récupéré ensuite par câble (devicectl).
//

import SwiftUI

/// Vrai pendant la visite filmée : masque ce qui n'a rien à faire dans la vidéo.
enum TourFlags {
    #if DEBUG
    // Aussi pour les captures App Store (MM_SHOTS=1), sans enregistrement.
    static let isOn = ProcessInfo.processInfo.environment["MM_AUTO_TOUR"] != nil || ProcessInfo.processInfo.environment["MM_SHOTS"] != nil
    #else
    static let isOn = false
    #endif
}

#if DEBUG
import ReplayKit
import AVFoundation

@MainActor
final class AutoTour: ObservableObject {
    static let shared = AutoTour()
    static let isOn = ProcessInfo.processInfo.environment["MM_AUTO_TOUR"] != nil

    /// Faux tant que l'enregistrement n'a pas commencé : l'animation d'ouverture attend.
    @Published private(set) var ready = !AutoTour.isOn
    /// Carte de l'Accueil à ouvrir (détail avec la courbe néon).
    @Published var metric: HomeMetric?

    private let recorder = TourRecorder()
    private var started = false

    func startIfNeeded() {
        guard Self.isOn, !started else { return }
        started = true
        recorder.start { [weak self] ok in
            Task { @MainActor in
                guard let self else { return }
                self.ready = true
                if ok { await self.run() }
            }
        }
    }

    private func pause(_ s: Double) async { try? await Task.sleep(for: .seconds(s)) }
    private func go(_ d: Router.Destination) { Router.shared.pending = d }
    private func theme(_ t: AppTheme) { UserDefaults.standard.set(t.rawValue, forKey: AppTheme.storageKey) }

    private func run() async {
        theme(.dark)
        await pause(6.5)                                // ouverture, puis l'Accueil apparaît
        await scroll(by: 520); await pause(0.6)
        await scroll(to: 0); await pause(0.4)
        metric = .mrr; await pause(4.5)                 // détail : la courbe se dessine en néon
        go(.today); metric = nil; await pause(1.2)
        go(.feed); await pause(2.2)
        await scroll(by: 900); await pause(0.5)
        go(.leaderboard); await pause(2.6)
        await scroll(by: 480); await pause(0.6)
        go(.globe); await pause(4)
        go(.today); await pause(0.6)
        go(.charts(nil)); await pause(2.4)
        await scroll(by: 800); await pause(0.6)
        go(.today); await pause(0.8)
        theme(.light); await pause(2.4)                 // l'Accueil en mode clair
        await scroll(by: 520); await pause(0.4)
        await scroll(to: 0); await pause(0.4)
        metric = .revenue; await pause(4)
        go(.today); metric = nil; await pause(1)
        go(.settings); await pause(2.2)
        await scroll(by: 700); await pause(0.4)
        await scroll(to: 0); await pause(0.6)
        theme(.dark); await pause(3)                    // retour au sombre depuis les Réglages
        await recorder.stop()
    }

    /// Défile la liste visible, en douceur, comme un pouce.
    private func scroll(by dy: CGFloat? = nil, to y: CGFloat? = nil, duration: Double = 1.4) async {
        guard let sv = visibleScrollView() else { return }
        let start = sv.contentOffset.y
        let maxY = max(-sv.adjustedContentInset.top, sv.contentSize.height - sv.bounds.height + sv.adjustedContentInset.bottom)
        let end = min(maxY, max(-sv.adjustedContentInset.top, y.map { $0 - sv.adjustedContentInset.top } ?? start + (dy ?? 0)))
        let steps = Int(duration * 60)
        for i in 1...steps {
            let k = Double(i) / Double(steps)
            let e = k < 0.5 ? 4 * k * k * k : 1 - pow(-2 * k + 2, 3) / 2
            sv.contentOffset.y = start + (end - start) * e
            try? await Task.sleep(for: .milliseconds(16))
        }
    }

    private func visibleScrollView() -> UIScrollView? {
        let window = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first
        guard let window else { return nil }
        var best: (UIScrollView, CGFloat)?
        func visible(_ v: UIView) -> Bool {
            var cur: UIView? = v
            while let c = cur { if c.isHidden || c.alpha < 0.05 { return false }; cur = c.superview }
            return true
        }
        func walk(_ v: UIView) {
            if let sv = v as? UIScrollView, sv.isScrollEnabled, sv.contentSize.height > sv.bounds.height + 40, visible(sv) {
                let r = sv.convert(sv.bounds, to: window).intersection(window.bounds)
                let area = r.isNull ? 0 : r.width * r.height
                if area > (best?.1 ?? 0) { best = (sv, area) }
            }
            v.subviews.forEach(walk)
        }
        walk(window)
        return best?.0
    }
}

/// Écrit les images de ReplayKit dans un fichier H.264, sur sa propre file.
private final class TourRecorder: @unchecked Sendable {
    private let queue = DispatchQueue(label: "mm.tour.recorder")
    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private var sessionStarted = false

    func start(_ done: @escaping @Sendable (Bool) -> Void) {
        let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("tour.mp4")
        try? FileManager.default.removeItem(at: url)
        guard let w = try? AVAssetWriter(outputURL: url, fileType: .mp4) else { return done(false) }
        let size = UIScreen.main.nativeBounds.size
        let i = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: size.width, AVVideoHeightKey: size.height,
            AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 24_000_000],
        ])
        i.expectsMediaDataInRealTime = true
        w.add(i)
        writer = w; input = i
        let rec = RPScreenRecorder.shared()
        rec.isMicrophoneEnabled = false
        rec.startCapture(handler: { [weak self] buffer, type, error in
            guard type == .video, error == nil, let self else { return }
            self.queue.sync { self.append(buffer) }
        }, completionHandler: { error in done(error == nil) })
    }

    private func append(_ buffer: CMSampleBuffer) {
        guard let writer, let input else { return }
        if !sessionStarted {
            writer.startWriting()
            writer.startSession(atSourceTime: CMSampleBufferGetPresentationTimeStamp(buffer))
            sessionStarted = true
        }
        if input.isReadyForMoreMediaData { input.append(buffer) }
    }

    func stop() async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            RPScreenRecorder.shared().stopCapture { _ in c.resume() }
        }
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            queue.async {
                self.input?.markAsFinished()
                if let w = self.writer { w.finishWriting { c.resume() } } else { c.resume() }
            }
        }
    }
}
#endif
