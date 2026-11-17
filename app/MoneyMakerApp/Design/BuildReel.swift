//
//  BuildReel.swift
//  MoneyMaker — animation « l'app se construit en direct » (13 s, en boucle).
//
//  Reprise du minutage du post X de @tobiadonadon_ (relevé image par image, pas de 0,25 s) :
//  0,5 s curseur · 0,75 s pastille « Ground » · 0,75–1,25 s révélation circulaire du fond ·
//  1,25 s en-tête + avatar · 1,75 s arc · 2,0/2,25 s chiffre tapé · 2,5 s unité + astre ·
//  2,75–4 s sous-titre tapé · 4–6 s trois lignes · 6–6,5 s tab bar + bouton 62 × 62 ·
//  7–8 s étiquettes d'inspection · 8–13 s écran fini, curseurs au repos.
//
//  Lancement : argument `-mmBuildReel YES` (voir MoneyMakerApp).
//

import SwiftUI

struct BuildReelView: View {
    @State private var start = Date()
    static let duration: Double = 13

    var body: some View {
        TimelineView(.animation) { ctx in
            let t = ctx.date.timeIntervalSince(start).truncatingRemainder(dividingBy: Self.duration)
            GeometryReader { geo in
                let s = geo.size.width / 440
                BuildReelCanvas(t: t)
                    .frame(width: 440, height: 956)
                    .scaleEffect(s, anchor: .topLeading)
                    .frame(width: geo.size.width, height: geo.size.height, alignment: .topLeading)
            }
        }
        .ignoresSafeArea()
        .statusBarHidden(false)
        .preferredColorScheme(.dark)
        .onTapGesture { start = Date() }
    }
}

// MARK: - Courbes

private func clamp(_ x: Double) -> Double { min(1, max(0, x)) }
/// Progression 0→1 entre a et b, courbe « ease out » (cubic) comme les apparitions de la référence.
private func p(_ t: Double, _ a: Double, _ b: Double) -> Double {
    let x = clamp((t - a) / (b - a)); return 1 - pow(1 - x, 3)
}
private func pIO(_ t: Double, _ a: Double, _ b: Double) -> Double {
    let x = clamp((t - a) / (b - a)); return x < 0.5 ? 4 * x * x * x : 1 - pow(-2 * x + 2, 3) / 2
}
/// Texte tapé : caractères révélés entre a et b.
private func typed(_ s: String, _ t: Double, _ a: Double, _ b: Double) -> String {
    String(s.prefix(Int((clamp((t - a) / (b - a)) * Double(s.count)).rounded(.down))))
}

private enum C {
    static let ground = MMColor.hex(0x0B0C0D)
    static let ink = Color.white
    static let ink2 = Color.white.opacity(0.62)
    static let select = MMColor.hex(0x2E9BFF)
    static let guide = MMColor.hex(0xFF3B30)
    static let claude = MMColor.hex(0xD97757)
}

// MARK: - Canevas 440 × 956 pt

private struct BuildReelCanvas: View {
    let t: Double

    // Repères (pt) relevés sur la référence, ramenés à 440 pt de large.
    let arcCenter = CGPoint(x: 220, y: 514)
    let arcR: CGFloat = 186
    let orb = CGPoint(x: 160, y: 337)

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.black
            ground
            guides
            header
            arc
            hero
            subtitle
            rows
            tabBar
            inspector
            cursors
            statusBar
        }
        .frame(width: 440, height: 956)
        .clipped()
    }

    // 0,75–1,25 s : la couleur part du curseur et remplit l'écran en cercle.
    var ground: some View {
        let r = p(t, 0.85, 1.35) * 1150
        return ZStack {
            C.ground
            RadialGradient(colors: [MMColor.accent.opacity(0.30), MMColor.accent.opacity(0.06), .clear],
                           center: UnitPoint(x: orb.x / 440, y: orb.y / 956), startRadius: 10, endRadius: 330)
                .opacity(p(t, 1.1, 1.8))
        }
        .mask(Circle().frame(width: r * 2, height: r * 2).position(x: 150, y: 210))
        .overlay {
            // Pastille d'échantillon + étiquette « Ground » (0,75–1,5 s).
            let a = p(t, 0.7, 0.8) * (1 - p(t, 1.45, 1.6))
            HStack(spacing: 5) {
                RoundedRectangle(cornerRadius: 2).fill(C.ground).overlay(RoundedRectangle(cornerRadius: 2).stroke(.white.opacity(0.4), lineWidth: 0.5)).frame(width: 9, height: 9)
                Text("Ground · #0B0C0D").font(.system(size: 9, weight: .medium)).foregroundStyle(.white)
            }
            .padding(.horizontal, 6).padding(.vertical, 4)
            .background(RoundedRectangle(cornerRadius: 4).fill(Color.black.opacity(0.85)))
            .position(x: 205, y: 232).opacity(a)
        }
    }

    // Guides rouges (alignement) pendant la construction.
    var guides: some View {
        let a = p(t, 1.5, 1.7) * (1 - p(t, 7.6, 8.2))
        return ZStack(alignment: .topLeading) {
            Rectangle().fill(C.guide.opacity(0.7)).frame(width: 0.6, height: 956).offset(x: 24)
            Rectangle().fill(C.guide.opacity(0.7)).frame(width: 440, height: 0.6).offset(y: 314)
        }
        .opacity(a)
    }

    var statusBar: some View {
        HStack {
            Text("13:20").font(.system(size: 17, weight: .semibold))
            Spacer()
            Image(systemName: "cellularbars"); Image(systemName: "wifi"); Image(systemName: "battery.100")
        }
        .font(.system(size: 14, weight: .semibold))
        .foregroundStyle(.white)
        .padding(.horizontal, 44).frame(width: 440).offset(y: 30)
        .opacity(p(t, 0.9, 1.1))
    }

    var header: some View {
        ZStack(alignment: .topLeading) {
            (Text("Wednesday").font(.system(size: 15, weight: .semibold)) + Text(" 18 Nov").font(.system(size: 15)))
                .foregroundStyle(C.ink)
                .mask(alignment: .leading) { Rectangle().frame(width: 200 * p(t, 1.25, 1.6)) }
                .offset(x: 24, y: 84)
            ZStack {
                Circle().fill(LinearGradient(colors: [MMColor.accent, MMColor.blue], startPoint: .topLeading, endPoint: .bottomTrailing))
                Text("A").font(.system(size: 16, weight: .bold)).foregroundStyle(.black)
            }
            .frame(width: 38, height: 38)
            .overlay(Circle().stroke(.white.opacity(0.8), lineWidth: 1.5))
            .scaleEffect(0.6 + 0.4 * p(t, 1.35, 1.6))
            .opacity(p(t, 1.35, 1.5))
            .position(x: 396, y: 93)
            selection(CGRect(x: 375, y: 72, width: 42, height: 42), from: 1.35, to: 1.9, label: "38 × 38")
        }
    }

    // 1,75 s : l'arc de la journée se trace, puis les marqueurs.
    var arc: some View {
        let draw = pIO(t, 1.75, 2.35)
        let orbAngle = Angle.degrees(180 + 72) // position de l'astre sur l'arc
        return ZStack(alignment: .topLeading) {
            Path { $0.addArc(center: arcCenter, radius: arcR, startAngle: .degrees(180), endAngle: orbAngle, clockwise: false) }
                .trim(from: 0, to: draw)
                .stroke(C.ink, style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
            Path { $0.addArc(center: arcCenter, radius: arcR, startAngle: orbAngle, endAngle: .degrees(360), clockwise: false) }
                .trim(from: 0, to: pIO(t, 2.1, 2.6))
                .stroke(C.ink.opacity(0.7), style: StrokeStyle(lineWidth: 1.2, dash: [2.5, 4]))
            Path { $0.move(to: CGPoint(x: 34, y: 514)); $0.addLine(to: CGPoint(x: 406, y: 514)) }
                .trim(from: 0, to: pIO(t, 1.8, 2.3))
                .stroke(C.ink.opacity(0.25), lineWidth: 0.6)
            Group {
                Circle().fill(C.ink).frame(width: 9, height: 9).position(x: 34, y: 514)
                Circle().fill(C.ink).frame(width: 9, height: 9).position(x: 406, y: 514).opacity(p(t, 2.5, 2.6))
                marker(at: 270, title: "15:00", sub: "peak", from: 2.4)
                marker(at: 316, title: "19:00", sub: "payout", from: 2.55)
            }
            Text("00:00").font(.system(size: 12, weight: .semibold)).foregroundStyle(C.ink).position(x: 44, y: 532).opacity(p(t, 2.3, 2.45))
            Text("23:59").font(.system(size: 12, weight: .semibold)).foregroundStyle(C.ink).position(x: 395, y: 532).opacity(p(t, 2.5, 2.65))
            // L'astre (orbe accent) apparaît avec l'unité.
            ZStack {
                Circle().fill(MMColor.accent.opacity(0.18)).frame(width: 126, height: 126)
                Circle().fill(MMColor.accent.opacity(0.25)).frame(width: 96, height: 96)
                Circle().fill(RadialGradient(colors: [.white, MMColor.hex(0xC8FFE9)], center: .center, startRadius: 2, endRadius: 40)).frame(width: 72, height: 72)
            }
            .scaleEffect(0.3 + 0.7 * p(t, 2.45, 2.9))
            .opacity(p(t, 2.45, 2.6))
            .position(orb)
            selection(CGRect(x: 124, y: 301, width: 72, height: 72), from: 2.5, to: 3.0, label: "72 × 72")
        }
    }

    func marker(at deg: Double, title: String, sub: String, from a: Double) -> some View {
        let r = deg * .pi / 180
        let pt = CGPoint(x: arcCenter.x + arcR * cos(r), y: arcCenter.y + arcR * sin(r))
        return ZStack(alignment: .topLeading) {
            Circle().stroke(C.ink, lineWidth: 1.4).frame(width: 11, height: 11).position(pt)
            VStack(alignment: .leading, spacing: 0) {
                Text(title).font(.system(size: 12, weight: .semibold))
                Text(sub).font(.system(size: 12))
            }
            .foregroundStyle(C.ink)
            .fixedSize()
            .position(x: pt.x + 30, y: pt.y - 24)
        }
        .opacity(p(t, a, a + 0.15))
    }

    // 2,0 s « $1 » · 2,25 s « $1.8 » · 2,5 s unité « k ».
    var hero: some View {
        let digits = t < 2.0 ? "" : (t < 2.25 ? "$1" : "$1.8")
        return HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text(digits).font(.custom("HelveticaNeue-Medium", size: 136)).tracking(-5)
            Text("k").font(.custom("HelveticaNeue-Medium", size: 44)).opacity(p(t, 2.5, 2.6))
        }
        .foregroundStyle(C.ink)
        .fixedSize()
        .frame(width: 440)
        .position(x: 226, y: 445)
        .overlay { selection(CGRect(x: 90, y: 392, width: 270, height: 110), from: 2.0, to: 2.9, label: "Hero · 136 / Medium") }
    }

    var subtitle: some View {
        let full = "Strong. Sales run 18% above Tuesday, and the best window is still ahead."
        let shown = typed(full, t, 2.75, 4.0)
        let bold = String(shown.prefix(7)), rest = String(shown.dropFirst(7))
        return ZStack(alignment: .topLeading) {
            (Text(bold).font(.system(size: 21, weight: .bold)) + Text(rest).font(.system(size: 21)))
                .foregroundStyle(C.ink.opacity(0.92))
                .lineSpacing(2)
                .frame(width: 392, alignment: .leading)
                .offset(x: 24, y: 562)
            selection(CGRect(x: 22, y: 559, width: 396, height: 62), from: 2.7, to: 4.2, label: nil)
        }
    }

    // 4–6 s : cadre vide puis trois lignes tapées l'une après l'autre.
    var rows: some View {
        let data: [(String, String, String, String, Double)] = [
            ("circle", "Goal $2,500 by midnight", "72% there, on pace since 11:00", "$700", 4.4),
            ("circle.lefthalf.filled", "Trials 31 of 50", "MoneyMaker Pro, 9 converted", "19", 4.95),
            ("circle", "Payout 19:00", "Stripe batch scheduled", "$1,240", 5.5),
        ]
        return ZStack(alignment: .topLeading) {
            Rectangle().fill(C.ink.opacity(0.2)).frame(width: 392 * p(t, 4.2, 4.5), height: 0.6).offset(x: 24, y: 640)
            ForEach(0..<3, id: \.self) { i in
                let r = data[i], y = 652 + CGFloat(i) * 73
                HStack(alignment: .center, spacing: 14) {
                    Image(systemName: r.0).font(.system(size: 22, weight: .light)).opacity(p(t, r.4, r.4 + 0.1))
                    VStack(alignment: .leading, spacing: 3) {
                        Text(typed(r.1, t, r.4, r.4 + 0.3)).font(.system(size: 18, weight: .semibold))
                        Text(typed(r.2, t, r.4 + 0.15, r.4 + 0.45)).font(.system(size: 13)).foregroundStyle(C.ink2)
                    }
                    Spacer()
                    Text(r.3).font(.system(size: 17, weight: .semibold)).opacity(p(t, r.4 + 0.35, r.4 + 0.45))
                }
                .foregroundStyle(C.ink)
                .frame(width: 392, height: 72)
                .offset(x: 24, y: y)
                if i < 2 {
                    Rectangle().fill(C.ink.opacity(0.2)).frame(width: 392 * p(t, r.4 + 0.3, r.4 + 0.5), height: 0.6).offset(x: 24, y: y + 73)
                }
                selection(CGRect(x: 22, y: y + 2, width: 396, height: 68), from: r.4 - 0.05, to: r.4 + 0.55, label: nil)
            }
            selection(CGRect(x: 22, y: 646, width: 396, height: 222), from: 4.0, to: 4.45, label: nil)
        }
    }

    // 6–6,5 s : la tab bar puis le bouton rond, cotes 286 × 66 et 62 × 62.
    var tabBar: some View {
        let items = [("sun.max", "Today"), ("square.grid.2x2", "Apps"), ("chart.bar", "Ranks"), ("person", "You")]
        return ZStack(alignment: .topLeading) {
            HStack(spacing: 0) {
                ForEach(0..<4, id: \.self) { i in
                    VStack(spacing: 3) {
                        Image(systemName: items[i].0).font(.system(size: 17))
                        Text(items[i].1).font(.system(size: 11, weight: .semibold))
                    }
                    .foregroundStyle(i == 0 ? Color.black : C.ink)
                    .frame(width: 72, height: 56)
                    .background { if i == 0 { Capsule().fill(MMColor.accent) } }
                    .opacity(p(t, 6.1 + Double(i) * 0.06, 6.2 + Double(i) * 0.06))
                }
            }
            .padding(5)
            .background(Capsule().fill(Color.white.opacity(0.10)).overlay(Capsule().stroke(.white.opacity(0.12), lineWidth: 0.6)))
            .frame(width: 312, height: 66)
            .scaleEffect(x: 0.6 + 0.4 * p(t, 6.0, 6.25), y: 1, anchor: .leading)
            .opacity(p(t, 6.0, 6.1))
            .offset(x: 24, y: 860)
            ZStack {
                Circle().fill(Color.white.opacity(0.12)).overlay(Circle().stroke(.white.opacity(0.14), lineWidth: 0.6))
                Image(systemName: "plus").font(.system(size: 20, weight: .medium)).foregroundStyle(C.ink)
            }
            .frame(width: 62, height: 62)
            .scaleEffect(0.4 + 0.6 * p(t, 6.4, 6.65))
            .opacity(p(t, 6.4, 6.5))
            .position(x: 382, y: 893)
            selection(CGRect(x: 24, y: 860, width: 312, height: 66), from: 6.0, to: 6.9, label: "312 × 66")
            selection(CGRect(x: 351, y: 862, width: 62, height: 62), from: 6.4, to: 7.4, label: "62 × 62", handles: true)
        }
    }

    // 7–8 s : étiquettes d'inspection sur l'astre, le chiffre et la tab bar.
    var inspector: some View {
        ZStack(alignment: .topLeading) {
            tag("Orb · accent #00F19F", at: CGPoint(x: 160, y: 386), from: 7.0, to: 7.9)
            tag("Hero · Helvetica Neue 136", at: CGPoint(x: 226, y: 512), from: 7.15, to: 8.0)
            tag("4 items · 72 pt each", at: CGPoint(x: 180, y: 845), from: 7.3, to: 8.1)
        }
    }

    func tag(_ s: String, at c: CGPoint, from a: Double, to b: Double) -> some View {
        Text(s).font(.system(size: 9, weight: .semibold)).foregroundStyle(.white)
            .padding(.horizontal, 5).padding(.vertical, 2.5)
            .background(RoundedRectangle(cornerRadius: 3).fill(C.select))
            .fixedSize()
            .position(c)
            .opacity(p(t, a, a + 0.08) * (1 - p(t, b - 0.1, b)))
    }

    /// Cadre de sélection bleu (avec cote facultative) visible entre a et b.
    func selection(_ r: CGRect, from a: Double, to b: Double, label: String?, handles: Bool = false) -> some View {
        let o = p(t, a, a + 0.06) * (1 - p(t, b - 0.08, b))
        return ZStack(alignment: .topLeading) {
            Rectangle().stroke(C.select, lineWidth: 1.2).frame(width: r.width, height: r.height).offset(x: r.minX, y: r.minY)
            if handles {
                ForEach(0..<4, id: \.self) { i in
                    Rectangle().fill(.white).overlay(Rectangle().stroke(C.select, lineWidth: 1))
                        .frame(width: 7, height: 7)
                        .position(x: i % 2 == 0 ? r.minX : r.maxX, y: i < 2 ? r.minY : r.maxY)
                }
            }
            if let label {
                Text(label).font(.system(size: 9, weight: .semibold)).foregroundStyle(.white)
                    .padding(.horizontal, 5).padding(.vertical, 2.5)
                    .background(RoundedRectangle(cornerRadius: 3).fill(C.select))
                    .fixedSize()
                    .position(x: r.midX, y: r.maxY + 12)
            }
        }
        .opacity(o)
    }

    // MARK: Curseurs multijoueurs

    struct Key { let t: Double; let x: CGFloat; let y: CGFloat }

    func pos(_ keys: [Key]) -> CGPoint {
        guard let first = keys.first else { return .zero }
        if t <= first.t { return CGPoint(x: first.x, y: first.y) }
        for i in 1..<keys.count where t <= keys[i].t {
            let a = keys[i - 1], b = keys[i]
            let k = pIO(t, a.t, b.t)
            return CGPoint(x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k)
        }
        let l = keys.last!; return CGPoint(x: l.x, y: l.y)
    }

    var cursors: some View {
        // Amine : celui qui pose la couleur, l'arc, le chiffre, la tab bar.
        let amine = pos([Key(t: 0, x: 60, y: 300), Key(t: 0.5, x: 140, y: 205), Key(t: 1.2, x: 150, y: 210),
                         Key(t: 1.7, x: 40, y: 500), Key(t: 2.0, x: 120, y: 440), Key(t: 2.6, x: 330, y: 440),
                         Key(t: 3.2, x: 300, y: 600), Key(t: 4.0, x: 40, y: 740), Key(t: 4.6, x: 60, y: 690),
                         Key(t: 5.6, x: 40, y: 840), Key(t: 6.1, x: 300, y: 880), Key(t: 6.8, x: 230, y: 890),
                         Key(t: 7.6, x: 190, y: 470), Key(t: 9.5, x: 175, y: 455), Key(t: 13, x: 168, y: 462)])
        // Claude : tape les textes.
        let claude = pos([Key(t: 0, x: 470, y: 120), Key(t: 1.2, x: 470, y: 120), Key(t: 1.5, x: 210, y: 92),
                          Key(t: 2.7, x: 30, y: 575), Key(t: 4.0, x: 330, y: 605), Key(t: 4.4, x: 210, y: 670),
                          Key(t: 5.0, x: 240, y: 745), Key(t: 5.6, x: 220, y: 815), Key(t: 6.3, x: 400, y: 900),
                          Key(t: 7.2, x: 330, y: 650), Key(t: 13, x: 320, y: 640)])
        let green = pos([Key(t: 0, x: 470, y: 60), Key(t: 1.3, x: 395, y: 92), Key(t: 2.4, x: 168, y: 345),
                         Key(t: 3.5, x: 172, y: 350), Key(t: 6.4, x: 400, y: 920), Key(t: 7.0, x: 165, y: 350), Key(t: 13, x: 160, y: 352)])
        let purple = pos([Key(t: 0, x: -30, y: 900), Key(t: 2.0, x: -30, y: 900), Key(t: 2.9, x: 220, y: 600),
                          Key(t: 4.2, x: 380, y: 760), Key(t: 6.2, x: 250, y: 925), Key(t: 13, x: 270, y: 930)])
        let yellow = pos([Key(t: 0, x: 470, y: 520), Key(t: 4.2, x: 470, y: 520), Key(t: 5.0, x: 395, y: 740),
                          Key(t: 6.0, x: 395, y: 820), Key(t: 13, x: 405, y: 770)])
        return ZStack(alignment: .topLeading) {
            cursor(MMColor.hex(0x2E9BFF), label: "Amine").position(amine).opacity(p(t, 0.4, 0.5))
            cursor(C.claude, label: "Claude").position(claude)
            cursor(MMColor.hex(0x34D058), label: nil).position(green)
            cursor(MMColor.hex(0xA259FF), label: nil).position(purple)
            cursor(MMColor.hex(0xFFD43B), label: nil).position(yellow)
        }
    }

    func cursor(_ color: Color, label: String?) -> some View {
        ZStack(alignment: .topLeading) {
            CursorShape().fill(color).overlay(CursorShape().stroke(.white, lineWidth: 1.2)).frame(width: 16, height: 21)
            if let label {
                Text(label).font(.system(size: 11, weight: .semibold)).foregroundStyle(.white)
                    .padding(.horizontal, 7).padding(.vertical, 3.5)
                    .background(RoundedRectangle(cornerRadius: 5).fill(color))
                    .fixedSize()
                    .offset(x: 12, y: 24)
            }
        }
        .frame(width: 16, height: 21, alignment: .topLeading)
        .offset(x: 8, y: 10) // la pointe sur la position
    }
}

private struct CursorShape: Shape {
    func path(in r: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: r.minX, y: r.minY))
        p.addLine(to: CGPoint(x: r.minX, y: r.maxY * 0.86))
        p.addLine(to: CGPoint(x: r.width * 0.30, y: r.height * 0.66))
        p.addLine(to: CGPoint(x: r.width * 0.50, y: r.maxY))
        p.addLine(to: CGPoint(x: r.width * 0.66, y: r.height * 0.93))
        p.addLine(to: CGPoint(x: r.width * 0.47, y: r.height * 0.62))
        p.addLine(to: CGPoint(x: r.maxX, y: r.height * 0.62))
        p.closeSubpath()
        return p
    }
}
