//
//  WebSignIn.swift
//  MoneyMaker — connexion depuis l'app (e-mail, création de compte incluse).
//
//  Session web sécurisée du système (ASWebAuthenticationSession) sur /app-login : l'utilisateur
//  s'identifie, la page crée un jeton personnel « iPhone » et le renvoie à moneymaker://auth.
//  L'app ne voit jamais le mot de passe.
//

import AuthenticationServices
import UIKit

@MainActor
final class WebSignIn: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = WebSignIn()
    private var session: ASWebAuthenticationSession?

    /// `.none` = l'utilisateur a fermé la fenêtre.
    func start(_ done: @escaping (Result<String, Error>?) -> Void) {
        let url = URL(string: "https://usemoneymaker.com/app-login")!
        let s = ASWebAuthenticationSession(url: url, callbackURLScheme: "moneymaker") { [weak self] callback, error in
            let result: Result<String, Error>?
            if let e = error as? ASWebAuthenticationSessionError, e.code == .canceledLogin { result = nil }
            else if let error { result = .failure(error) }
            else if let callback, callback.host == "auth",
                    let token = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "token" })?.value,
                    token.hasPrefix("mm_pat_") { result = .success(token) }
            else { result = .failure(APIError(message: String(localized: "Connexion interrompue, réessaie."))) }
            // Le rappel n'est pas garanti sur le fil principal : l'UI (et la session gardée) y reviennent.
            Task { @MainActor in
                self?.session = nil
                done(result)
            }
        }
        s.presentationContextProvider = self
        s.prefersEphemeralWebBrowserSession = false   // garde la session du navigateur
        session = s
        s.start()
    }

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first ?? ASPresentationAnchor()
        }
    }
}
