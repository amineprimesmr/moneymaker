import XCTest
import CryptoKit
@testable import MoneyMaker

/// Serves canned API responses to `URLSession.shared` (registered for the logIn test only).
final class MockAPI: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) -> (Int, String))?
    nonisolated(unsafe) static var paths: [String] = []

    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "mock.moneymaker.test" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let path = request.url?.path ?? ""
        Self.paths.append(path)
        let (status, body) = Self.handler?(request) ?? (404, #"{"error":"not_found"}"#)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class SDK12Tests: XCTestCase {
    static func customerJSON(_ id: String, entitled: Bool = false) -> String {
        let ents = entitled ? #"{"premium":{"id":"premium","active":true,"productId":"m","store":"app_store","expiresAt":null,"willRenew":true,"isTrial":false,"billingIssue":false,"purchasedAt":1}}"# : "{}"
        return #"{"appUserId":"\#(id)","accountToken":"x","entitlements":\#(ents),"activeEntitlements":\#(entitled ? #"["premium"]"# : "[]"),"purchases":[],"attributes":{},"requestedAt":1}"#
    }

    // MARK: logIn rollback

    @MainActor
    func testLogInKeepsPreviousIdOnFailureThenSwitchesOnSuccess() async throws {
        URLProtocol.registerClass(MockAPI.self)
        defer { URLProtocol.unregisterClass(MockAPI.self) }
        MockAPI.handler = { req in
            let path = req.url!.path
            if path.hasSuffix("/alias") {
                let body = req.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
                    ?? req.httpBodyStream.flatMap { s -> [String: Any]? in
                        s.open(); defer { s.close() }
                        var d = Data(); var buf = [UInt8](repeating: 0, count: 4096)
                        while s.hasBytesAvailable { let n = s.read(&buf, maxLength: buf.count); if n <= 0 { break }; d.append(buf, count: n) }
                        return try? JSONSerialization.jsonObject(with: d) as? [String: Any]
                    }
                let to = body?["newAppUserId"] as? String ?? ""
                if to == "rejected" { return (400, #"{"error":"invalid_app_user_id","message":"nope"}"#) }
                return (200, Self.customerJSON(to, entitled: true))
            }
            if path.contains("/customers/") { return (200, Self.customerJSON(String(path.split(separator: "/").last!).removingPercentEncoding ?? "")) }
            return (404, #"{"error":"not_found"}"#)
        }
        // Test Store key: no StoreKit involved. Host is not the hosted API: no pinned key, signing-key → 404 → unverified.
        let mm = MoneyMaker.configure(apiKey: "mm_test_logintest", baseURL: URL(string: "https://mock.moneymaker.test/v1")!)
        mm.logOut()
        let anon = mm.appUserID
        XCTAssertTrue(mm.isAnonymous)

        do {
            _ = try await mm.logIn("rejected")
            XCTFail("logIn should throw on a 4xx")
        } catch let MoneyMakerError.server(status, code, _) {
            XCTAssertEqual(status, 400)
            XCTAssertEqual(code, "invalid_app_user_id")
        }
        XCTAssertEqual(mm.appUserID, anon, "appUserID must not change when logIn fails")
        XCTAssertTrue(mm.isAnonymous)

        let info = try await mm.logIn("user_42")
        XCTAssertEqual(mm.appUserID, "user_42")
        XCTAssertEqual(info.appUserId, "user_42")
        XCTAssertTrue(mm.isEntitled("premium"))
        XCTAssertTrue(MockAPI.paths.contains { $0.hasSuffix("/alias") })
    }

    // MARK: Decoding

    func testOfferingsDecodeWithMixedMetadataAndNullPlacements() throws {
        let json = #"""
        {"current":"default","offerings":{"default":{"description":"Main","packages":[
          {"id":"monthly","productIds":{"app_store":"pro.monthly","play_store":"pro:monthly"},"metadata":{"badge":"Best","rank":2,"highlight":true,"ratio":0.5,"none":null}}
        ],"paywall":{"template":"cards","title":"Go Pro","localizations":{"fr":{"title":"Passez Pro"}}}}},
         "placements":{"onboarding":"default","settings":null},
         "experiments":[{"experimentId":"e1","variant":"b","placement":"default","offeringId":"default"}],
         "entitlements":{"premium":["pro.monthly"]}}
        """#
        let dto = try APIClient.decoder.decode(OfferingsDTO.self, from: Data(json.utf8))
        XCTAssertEqual(dto.current, "default")
        let pkg = try XCTUnwrap(dto.offerings["default"]?.packages.first)
        let meta = (pkg.metadata ?? [:]).mapValues(\.stringValue)
        XCTAssertEqual(meta["badge"], "Best")
        XCTAssertEqual(meta["rank"], "2")
        XCTAssertEqual(meta["highlight"], "true")
        XCTAssertEqual(meta["ratio"], "0.5")
        XCTAssertEqual(meta["none"], "")
        XCTAssertEqual(dto.placements?.compactMapValues { $0 }, ["onboarding": "default"])
        XCTAssertEqual(dto.experiments?.first?.variant, "b")
        XCTAssertEqual(dto.entitlements?["premium"], ["pro.monthly"])
        XCTAssertEqual(dto.offerings["default"]?.paywall?.texts(for: "fr-FR").title, "Passez Pro")
        XCTAssertEqual(dto.offerings["default"]?.paywall?.texts(for: "de").title, "Go Pro")
    }

    func testCustomerInfoIgnoresUnknownFieldsAndRoundTripsThroughCache() throws {
        let json = #"{"appUserId":"u","accountToken":"t","entitlements":{},"activeEntitlements":[],"purchases":[{"id":"p","store":"play_store","productId":"coins","type":"consumable","status":"active","active":true,"purchasedAt":5,"expiresAt":null,"willRenew":false,"isTrial":false,"isSandbox":true,"billingIssue":false,"extra":1}],"attributes":{"a":"b"},"requestedAt":10,"newField":{"x":1}}"#
        let info = try APIClient.decoder.decode(CustomerInfo.self, from: Data(json.utf8))
        XCTAssertEqual(info.purchases.first?.type, "consumable")
        XCTAssertEqual(info.activeProductIds, ["coins"])
        XCTAssertEqual(info.requestedAt, Date(timeIntervalSince1970: 0.01))
        let enc = JSONEncoder(); enc.dateEncodingStrategy = .millisecondsSince1970
        XCTAssertEqual(try APIClient.decoder.decode(CustomerInfo.self, from: enc.encode(info)), info)
    }

    func testMissingRequiredFieldFailsDecoding() {
        XCTAssertThrowsError(try APIClient.decoder.decode(CustomerInfo.self, from: Data(#"{"appUserId":"u"}"#.utf8)))
    }

    // MARK: Signatures

    func testSignatureVerification() {
        let key = Curve25519.Signing.PrivateKey()
        let body = Data(Self.customerJSON("u").utf8)
        let sig = try! key.signature(for: SignatureVerifier.message(nonce: "n1", requestTime: "123", body: body))
        let header = "v1=" + sig.base64EncodedString()
        XCTAssertTrue(SignatureVerifier.verify(key: key.publicKey, header: header, nonce: "n1", requestTime: "123", body: body))
        XCTAssertFalse(SignatureVerifier.verify(key: key.publicKey, header: header, nonce: "n2", requestTime: "123", body: body))
        XCTAssertFalse(SignatureVerifier.verify(key: key.publicKey, header: header, nonce: "n1", requestTime: "123", body: body + Data([0x20])))
        XCTAssertFalse(SignatureVerifier.verify(key: key.publicKey, header: nil, nonce: "n1", requestTime: "123", body: body))
        XCTAssertNotNil(SignatureVerifier.decode(MoneyMaker.hostedSigningPublicKey))
    }

    func testHostedHostsArePinned() {
        XCTAssertTrue(MoneyMaker.isHosted(MoneyMaker.defaultBaseURL))
        XCTAssertTrue(MoneyMaker.isHosted(URL(string: "https://moneymaker-io.web.app/v1")!))
        XCTAssertFalse(MoneyMaker.isHosted(URL(string: "https://usemoneymaker.com.evil.example/v1")!))
        XCTAssertEqual(MoneyMaker.defaultBaseURL.absoluteString, "https://usemoneymaker.com/v1")
    }

    // MARK: Promotional offers

    func testInvalidPromotionalOfferSignatureIsNotProductNotFound() {
        XCTAssertThrowsError(try MoneyMaker.promotionalOfferSignature(keyIdentifier: "K", nonce: "not-a-uuid", signature: "c2ln", timestamp: 1)) { error in
            guard case let MoneyMakerError.server(_, code, _) = error else { return XCTFail("unexpected \(error)") }
            XCTAssertEqual(code, "invalid_offer_signature")
        }
        XCTAssertThrowsError(try MoneyMaker.promotionalOfferSignature(keyIdentifier: "K", nonce: UUID().uuidString, signature: "%%%", timestamp: 1))
        let ok = try? MoneyMaker.promotionalOfferSignature(keyIdentifier: "K", nonce: UUID().uuidString.lowercased(), signature: "c2ln", timestamp: 7)
        XCTAssertEqual(ok?.timestamp, 7)
        XCTAssertEqual(ok?.signature, Data("sig".utf8))
    }

    // MARK: Errors

    func testRetryableErrors() {
        XCTAssertTrue(MoneyMakerError.network("offline").isRetryable)
        XCTAssertTrue(MoneyMakerError.server(status: 502, code: "google_api_error", message: "").isRetryable)
        XCTAssertTrue(MoneyMakerError.server(status: 429, code: "rate_limited", message: "").isRetryable)
        XCTAssertFalse(MoneyMakerError.server(status: 401, code: "invalid_api_key", message: "").isRetryable)
        XCTAssertFalse(MoneyMakerError.productNotFound("x").isRetryable)
    }
}
