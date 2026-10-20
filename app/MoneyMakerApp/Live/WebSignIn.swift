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
        let url = URL(string: "https://moneymaker-io.web.app/app-login")!
        let s = ASWebAuthenticationSession(url: url, callbackURLScheme: "moneymaker") { callback, error in
            if let e = error as? ASWebAuthenticationSessionError, e.code == .canceledLogin { done(nil); return }
            if let error { done(.failure(error)); return }
            guard let callback, callback.host == "auth",
                  let token = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "token" })?.value,
                  token.hasPrefix("mm_pat_") else {
                done(.failure(APIError(message: "Connexion interrompue, réessaie."))); return
            }
            done(.success(token))
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
