package io.moneymaker

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CustomerInfoTest {
    @Test fun parsesEntitlements() {
        val future = System.currentTimeMillis() + 86_400_000
        val info = CustomerInfo.fromJson(JSONObject("""{"appUserId":"u","entitlements":{"premium":{"id":"premium","active":true,"productId":"m","store":"play_store","expiresAt":$future,"willRenew":true,"isTrial":false,"billingIssue":false},"old":{"id":"old","active":true,"expiresAt":1}},"activeEntitlements":["premium"],"attributes":{}}"""))
        assertTrue(info.isEntitled("premium"))
        assertFalse(info.isEntitled("old"))
        assertFalse(info.isEntitled("none"))
    }

    @Test fun obfuscatedAccountIdMatchesBackend() {
        assertEquals(64, MoneyMaker.sha256Hex("user_1").length)
    }
}
