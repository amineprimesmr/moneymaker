//
//  SyncIslandThreshold.metal
//  V2 — Accueil
//
//  Seuil alpha de la goutte de synchronisation (d'après GooeyRefreshable) :
//  les formes floutées de l'île et de la goutte fusionnent en une seule
//  silhouette aux bords nets, lissés sur une bande de 0,02 d'alpha.
//

#include <metal_stdlib>
#include <SwiftUI/SwiftUI.h>
using namespace metal;

[[stitchable]] half4 syncIslandAlphaThreshold(float2 position, SwiftUI::Layer layer) {
    half4 color = layer.sample(position);
    half threshold = 0.5h;
    half edge = 0.02h;
    half alpha = smoothstep(threshold - edge, threshold + edge, color.a);
    return half4(color.rgb / max(color.a, 0.0001h), alpha);
}
