//
//  NativeSignIn.swift
//  MoneyMaker — connexion et création de compte dans l'app : Apple, Google, e-mail.
//
//  Chaque méthode donne un jeton Firebase (API REST Identity Toolkit, sans SDK), échangé contre
//  un jeton personnel « iPhone » via /tokens : le même résultat que l'ancienne page /app-login.
//

import AuthenticationServices
import CryptoKit
import SwiftUI
import UIKit

enum NativeSignIn {
    private static let apiKey = "AIzaSyC4SeMPtjh8lRyHhJA9-UsrnrHzHlgCu58"
    private static let googleClientID = "26053873543-3f36uvc1icqf98s8bd96u5rkjrn3fdem.apps.googleusercontent.com"
    private static let googleScheme = "com.googleusercontent.apps.26053873543-3f36uvc1icqf98s8bd96u5rkjrn3fdem"

    private struct FirebaseSession: Decodable { let idToken: String?; let needConfirmation: Bool? }
    private struct FirebaseFailure: Decodable { struct E: Decodable { let message: String }; let error: E }

    static func randomString() -> String {
        (0..<4).map { _ in UUID().uuidString.replacingOccurrences(of: "-", with: "") }.joined()
    }
    static func sha256(_ s: String) -> String {
        SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    // MARK: E-mail

    static func email(_ email: String, password: String, create: Bool) async throws -> String {
        let s = try await firebase(create ? "accounts:signUp" : "accounts:signInWithPassword",
                                   ["email": email, "password": password, "returnSecureToken": true])
        return try await personalToken(s)
    }

    static func sendPasswordReset(_ email: String) async throws {
        _ = try await firebase("accounts:sendOobCode", ["requestType": "PASSWORD_RESET", "email": email])
    }

    // MARK: Apple

    static func apple(_ credential: ASAuthorizationAppleIDCredential, nonce: String) async throws -> String {
        guard let data = credential.identityToken, let idToken = String(data: data, encoding: .utf8) else {
            throw APIError(message: String(localized: "Connexion interrompue, réessaie."))
        }
        return try await idp("apple.com", idToken: idToken, nonce: nonce)
    }

    // MARK: Google (autorisation PKCE dans la feuille sécurisée du système, seule voie admise par Google)

    /// `nil` = l'utilisateur a fermé la feuille.
    @MainActor static func google() async throws -> String? {
        let verifier = randomString(), state = randomString(), nonce = randomString()
        let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        let redirect = "\(googleScheme):/oauth2redirect"
        var c = URLComponents(string: "https://accounts.google.com/o/oauth2/v2/auth")!
        c.queryItems = [
            .init(name: "client_id", value: googleClientID), .init(name: "redirect_uri", value: redirect),
            .init(name: "response_type", value: "code"), .init(name: "scope", value: "openid email profile"),
            .init(name: "code_challenge", value: challenge), .init(name: "code_challenge_method", value: "S256"),
            .init(name: "state", value: state), .init(name: "nonce", value: sha256(nonce)), .init(name: "prompt", value: "select_account"),
        ]
        guard let callback = try await GoogleSheet.shared.open(c.url!, scheme: googleScheme) else { return nil }
        let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard items.first(where: { $0.name == "state" })?.value == state,
              let code = items.first(where: { $0.name == "code" })?.value else {
            throw APIError(message: String(localized: "Connexion interrompue, réessaie."))
        }
        var req = URLRequest(url: URL(string: "https://oauth2.googleapis.com/token")!)
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        var form = URLComponents()
        form.queryItems = [.init(name: "code", value: code), .init(name: "client_id", value: googleClientID),
                           .init(name: "redirect_uri", value: redirect), .init(name: "grant_type", value: "authorization_code"),
                           .init(name: "code_verifier", value: verifier)]
        req.httpBody = form.percentEncodedQuery?.data(using: .utf8)
        struct R: Decodable { let id_token: String? }
        let (data, _) = try await URLSession.shared.data(for: req)
        guard let idToken = try JSONDecoder().decode(R.self, from: data).id_token else {
            throw APIError(message: String(localized: "Connexion interrompue, réessaie."))
        }
        return try await idp("google.com", idToken: idToken, nonce: sha256(nonce))
    }

    // MARK: Firebase

    private static func idp(_ provider: String, idToken: String, nonce: String) async throws -> String {
        var c = URLComponents()
        c.queryItems = [.init(name: "id_token", value: idToken), .init(name: "providerId", value: provider), .init(name: "nonce", value: nonce)]
        let s = try await firebase("accounts:signInWithIdp", ["postBody": c.percentEncodedQuery ?? "", "requestUri": "https://usemoneymaker.com",
                                                              "returnSecureToken": true, "returnIdpCredential": true])
        return try await personalToken(s)
    }

    private static func firebase(_ method: String, _ body: [String: Any]) async throws -> FirebaseSession {
        var req = URLRequest(url: URL(string: "https://identitytoolkit.googleapis.com/v1/\(method)?key=\(apiKey)")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(Bundle.main.bundleIdentifier, forHTTPHeaderField: "X-Ios-Bundle-Identifier")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, res) = try await URLSession.shared.data(for: req)
        if (res as? HTTPURLResponse)?.statusCode != 200 {
            throw APIError(message: message(for: (try? JSONDecoder().decode(FirebaseFailure.self, from: data))?.error.message ?? ""))
        }
        return try JSONDecoder().decode(FirebaseSession.self, from: data)
    }

    private static func message(for code: String) -> String {
        switch code.components(separatedBy: " ").first ?? code {
        case "INVALID_LOGIN_CREDENTIALS", "INVALID_PASSWORD", "EMAIL_NOT_FOUND": String(localized: "E-mail ou mot de passe incorrect.")
        case "EMAIL_EXISTS": String(localized: "Un compte existe déjà avec cet e-mail : connecte-toi.")
        case "WEAK_PASSWORD": String(localized: "Mot de passe trop court (8 caractères minimum).")
        case "INVALID_EMAIL": String(localized: "Cette adresse e-mail n'est pas valide.")
        case "TOO_MANY_ATTEMPTS_TRY_LATER": String(localized: "Trop d'essais, réessaie dans un instant.")
        default: String(localized: "Connexion impossible, réessaie.")
        }
    }

    /// Même e-mail déjà inscrit par une autre méthode : Firebase ne connecte pas, il demande une confirmation.
    private static func personalToken(_ session: FirebaseSession) async throws -> String {
        guard session.needConfirmation != true, let idToken = session.idToken else {
            throw APIError(message: String(localized: "Un compte existe déjà avec cet e-mail : connecte-toi avec ta méthode habituelle."))
        }
        var req = URLRequest(url: MM.baseURL.appendingPathComponent("tokens"))
        req.httpMethod = "POST"
        req.setValue("Bearer \(idToken)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["label": "iPhone"])
        struct R: Decodable { let token: String? }
        let (data, _) = try await URLSession.shared.data(for: req)
        guard let token = (try? JSONDecoder().decode(R.self, from: data))?.token, token.hasPrefix("mm_pat_") else {
            throw APIError(message: String(localized: "Connexion impossible, réessaie."))
        }
        return token
    }
}

@MainActor
private final class GoogleSheet: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = GoogleSheet()
    private var session: ASWebAuthenticationSession?

    func open(_ url: URL, scheme: String) async throws -> URL? {
        try await withCheckedThrowingContinuation { cont in
            let s = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme) { callback, error in
                if let e = error as? ASWebAuthenticationSessionError, e.code == .canceledLogin { cont.resume(returning: nil) }
                else if let error { cont.resume(throwing: error) }
                else { cont.resume(returning: callback) }
            }
            s.presentationContextProvider = self
            session = s
            s.start()
        }
    }

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first ?? ASPresentationAnchor()
        }
    }
}

// MARK: - Boutons

struct NativeSignInButtons: View {
    @EnvironmentObject var store: Store
    @Binding var error: String?
    @Binding var emailMode: Bool
    @State private var appleNonce = ""
    @State private var busy = false

    var body: some View {
        if emailMode {
            EmailSignInForm { token in Task { await store.signIn(token) } }
                .transition(.opacity.combined(with: .offset(y: 16)))
        } else {
            buttons.transition(.opacity.combined(with: .offset(y: -16)))
        }
    }

    private var buttons: some View {
        VStack(spacing: 12) {
            HStack(spacing: 12) {
                // Le bouton natif reçoit le toucher ; son texte, de taille imposée, est recouvert pour égaler Google.
                ZStack {
                    SignInWithAppleButton(.continue) { req in
                        appleNonce = NativeSignIn.randomString()
                        req.requestedScopes = [.email, .fullName]
                        req.nonce = NativeSignIn.sha256(appleNonce)
                    } onCompletion: { result in
                        switch result {
                        case .success(let auth):
                            guard let c = auth.credential as? ASAuthorizationAppleIDCredential else { return }
                            run { try await NativeSignIn.apple(c, nonce: appleNonce) }
                        case .failure(let e):
                            if (e as? ASAuthorizationError)?.code != .canceled { error = e.localizedDescription }
                        }
                    }
                    .signInWithAppleButtonStyle(.white)
                    providerLabel("Apple") {
                        Image(systemName: "apple.logo").font(.system(size: 18, weight: .medium))
                    }
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
                }
                .frame(height: 52).clipShape(Capsule())

                Button { run { try await NativeSignIn.google() } } label: {
                    providerLabel("Google") {
                        Image("GoogleG").resizable().scaledToFit().frame(width: 18, height: 18)
                    }
                }
                .buttonStyle(MMPressStyle())
            }

            Button { emailMode = true } label: {
                Label("Continuer avec un e-mail", systemImage: "envelope.fill")
                    .font(MMFont.system(16, .semibold)).foregroundStyle(MMColor.ink)
                    .frame(maxWidth: .infinity).frame(height: 52).mmGlass(in: Capsule())
            }
            .buttonStyle(MMPressStyle())
        }
        .disabled(busy || store.loading)
        .opacity(busy ? 0.6 : 1)
    }

    private func providerLabel<Icon: View>(_ title: LocalizedStringKey, @ViewBuilder icon: () -> Icon) -> some View {
        HStack(spacing: 8) {
            icon()
            Text(title).font(MMFont.system(16, .semibold)).lineLimit(1)
        }
        .foregroundStyle(.black).frame(maxWidth: .infinity).frame(height: 52)
        .background(.white, in: Capsule())
    }

    private func run(_ work: @escaping () async throws -> String?) {
        busy = true; error = nil
        Task {
            defer { busy = false }
            do { if let token = try await work() { await store.signIn(token) } }
            catch { self.error = error.localizedDescription }
        }
    }
}

private struct EmailSignInForm: View {
    let done: (String) -> Void
    @State private var email = ""
    @State private var password = ""
    @State private var busy = false
    @State private var message: String?
    @FocusState private var focus: Field?
    private enum Field { case email, password }

    var body: some View {
        VStack(spacing: 12) {
            field {
                TextField("", text: $email, prompt: Text("E-mail").foregroundStyle(MMColor.ink3))
                    .textContentType(.emailAddress).keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .focused($focus, equals: .email).submitLabel(.next).onSubmit { focus = .password }
            }
            field {
                SecureField("", text: $password, prompt: Text("Mot de passe").foregroundStyle(MMColor.ink3))
                    .textContentType(.password)
                    .focused($focus, equals: .password).submitLabel(.go).onSubmit(submit)
            }
            if let message {
                Text(message).font(MMFont.system(13)).foregroundStyle(MMColor.ink2).multilineTextAlignment(.center)
            }
            MMPrimaryButton(title: String(localized: "Se connecter"), loading: busy, white: true, action: submit)
                .disabled(busy || email.isEmpty || password.isEmpty)
            Button("Mot de passe oublié ?", action: reset)
                .font(MMFont.system(13, .medium)).foregroundStyle(MMColor.ink3)
        }
        .task {
            // Le clavier arrive une fois la transition finie, pour qu'elle reste fluide.
            try? await Task.sleep(for: .milliseconds(350))
            focus = .email
        }
    }

    private func field<C: View>(@ViewBuilder _ content: () -> C) -> some View {
        content().font(MMFont.system(16)).padding(.horizontal, 20).padding(.vertical, 15).mmGlass(in: Capsule())
    }

    private var trimmed: String { email.trimmingCharacters(in: .whitespacesAndNewlines) }

    private func submit() {
        guard !busy, !email.isEmpty, !password.isEmpty else { return }
        busy = true; message = nil
        Task {
            defer { busy = false }
            do { done(try await NativeSignIn.email(trimmed, password: password, create: false)) }
            catch { message = error.localizedDescription }
        }
    }

    private func reset() {
        guard !trimmed.isEmpty else { message = String(localized: "Entre ton e-mail d'abord."); focus = .email; return }
        Task {
            do { try await NativeSignIn.sendPasswordReset(trimmed); message = String(localized: "E-mail de réinitialisation envoyé.") }
            catch { message = error.localizedDescription }
        }
    }
}
