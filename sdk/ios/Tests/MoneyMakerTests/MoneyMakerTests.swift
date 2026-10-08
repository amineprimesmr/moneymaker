import XCTest
@testable import MoneyMaker

final class MoneyMakerTests: XCTestCase {
    func testCustomerInfoDecodesServerPayload() throws {
        let future = Int(Date().addingTimeInterval(86400).timeIntervalSince1970 * 1000)
        let json = """
        {"appUserId":"u1","accountToken":"x","entitlements":{"premium":{"id":"premium","active":true,"productId":"m","store":"app_store",
        "expiresAt":\(future),"willRenew":true,"isTrial":false,"billingIssue":false,"purchasedAt":1}},"activeEntitlements":["premium"],
        "purchases":[],"attributes":{},"firstSeenAt":null,"requestedAt":\(future)}
        """
        let info = try APIClient.decoder.decode(CustomerInfo.self, from: Data(json.utf8))
        XCTAssertTrue(info.isEntitled("premium"))
        XCTAssertFalse(info.isEntitled("pro"))
    }

    func testLifetimeEntitlement() throws {
        let json = #"{"appUserId":"u","accountToken":"x","entitlements":{"pro":{"id":"pro","active":true,"productId":"l","store":"stripe","expiresAt":null,"willRenew":false,"isTrial":false,"billingIssue":false,"purchasedAt":1}},"activeEntitlements":["pro"],"purchases":[],"attributes":{},"requestedAt":1}"#
        XCTAssertTrue(try APIClient.decoder.decode(CustomerInfo.self, from: Data(json.utf8)).isEntitled("pro"))
    }
}
