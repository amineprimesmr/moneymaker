//
//  Analytics.swift
//  MoneyMaker — événements produit de l'app elle-même, envoyés à PostHog (serveur EU).
//  Sans clé, tout est inactif. L'utilisateur est identifié par son appAccountToken, opaque :
//  ni e-mail ni chiffre de revenus ne part. Replay désactivé : l'app affiche des données de clients.
//

import Foundation
import PostHog

enum Analytics {
    /// Clé publique (phc_) du projet PostHog MoneyMaker, organisation dédiée (projet 334303).
    private static let apiKey = "phc_kjnwF7TNPN9QtCYGQjUAbGH7KsGGgQvLgK6o4WXZ563H"
    private static let host = "https://eu.i.posthog.com"
    private static var active: Bool { !apiKey.isEmpty }

    static func start() {
        guard active else { return }
        let config = PostHogConfig(apiKey: apiKey, host: host)
        config.captureApplicationLifecycleEvents = true
        config.captureScreenViews = false
        config.sessionReplay = false
        config.personProfiles = .identifiedOnly
        PostHogSDK.shared.setup(config)
        #if DEBUG
        PostHogSDK.shared.register(["env": "debug"])
        #endif
    }

    static func capture(_ event: String, _ properties: [String: Any] = [:]) {
        guard active else { return }
        PostHogSDK.shared.capture(event, properties: properties)
    }

    static func identify(_ id: String) {
        guard active, PostHogSDK.shared.getDistinctId() != id else { return }
        PostHogSDK.shared.identify(id)
    }

    static func reset() {
        guard active else { return }
        PostHogSDK.shared.reset()
    }
}
