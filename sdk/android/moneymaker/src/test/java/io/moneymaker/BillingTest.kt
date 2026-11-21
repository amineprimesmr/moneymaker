package io.moneymaker

import com.android.billingclient.api.BillingClient
import org.junit.Assert.*
import org.junit.Test

class BillingTest {
    private val monthlyBase = OfferCandidate("monthly", null, "tok_monthly", "P1M", 4_990_000, "EUR")
    private val monthlyTrial = OfferCandidate("monthly", "trial-7d", "tok_monthly_trial", "P1M", 4_990_000, "EUR", hasFreePhase = true)
    private val yearlyIntro = OfferCandidate("yearly", "intro", "tok_yearly_intro", "P1Y", 39_990_000, "EUR")
    private val yearlyBase = OfferCandidate("yearly", null, "tok_yearly", "P1Y", 39_990_000, "EUR")
    // Play lists offers before their base plan sometimes: the selection must not depend on the order.
    private val offers = listOf(monthlyTrial, monthlyBase, yearlyIntro, yearlyBase)

    @Test fun defaultsToFirstBasePlanWithoutOffer() {
        assertEquals(monthlyBase, selectOffer(offers))
    }

    @Test fun neverPicksAnOfferImplicitly() {
        assertNull(selectOffer(offers).let { it?.offerId })
    }

    @Test fun selectsRequestedBasePlan() {
        assertEquals(yearlyBase, selectOffer(offers, basePlanId = "yearly"))
    }

    @Test fun selectsRequestedOffer() {
        assertEquals(monthlyTrial, selectOffer(offers, offerId = "trial-7d"))
        assertEquals(yearlyIntro, selectOffer(offers, basePlanId = "yearly", offerId = "intro"))
        assertNull(selectOffer(offers, basePlanId = "monthly", offerId = "intro"))
    }

    @Test fun offerTokenWins() {
        assertEquals(yearlyIntro, selectOffer(offers, offerToken = "tok_yearly_intro", basePlanId = "monthly"))
        assertNull(selectOffer(offers, offerToken = "unknown"))
    }

    @Test fun unknownBasePlanOrEmptyListIsNull() {
        assertNull(selectOffer(offers, basePlanId = "weekly"))
        assertNull(selectOffer(emptyList()))
    }

    @Test fun parsesPlayStoreIds() {
        assertEquals("premium", playProductId("premium:yearly"))
        assertEquals("yearly", playBasePlanId("premium:yearly"))
        assertEquals("premium", playProductId("premium"))
        assertNull(playBasePlanId("premium"))
    }

    @Test fun purchaseTypeHonoursConsumables() {
        val consumables = setOf("coins_100")
        assertEquals("consumable", purchaseType(false, "coins_100", consumables))
        assertEquals("non_consumable", purchaseType(false, "lifetime", consumables))
        assertEquals("subscription", purchaseType(true, "coins_100", consumables))
    }

    @Test fun purchaseBodyCarriesTypeAndPeriod() {
        val sub = googlePurchaseBody("t1", "premium", "subscription", yearlyBase)
        assertEquals("subscription", sub.getString("type"))
        assertEquals("P1Y", sub.getString("period"))
        assertEquals("yearly", sub.getString("basePlanId"))
        assertEquals(39_990_000L, sub.getLong("priceMicros"))
        assertFalse(sub.has("offerId"))

        val coins = googlePurchaseBody("t2", "coins_100", "consumable", null, 990_000, "EUR")
        assertEquals("consumable", coins.getString("type"))
        assertEquals(990_000L, coins.getLong("priceMicros"))
        assertFalse(coins.has("period"))
    }

    @Test fun billingUnavailableIsATypedError() {
        val e = billingError(BillingClient.BillingResponseCode.BILLING_UNAVAILABLE, "no play")
        assertEquals("billing_3", e.code)
        assertEquals(BillingClient.BillingResponseCode.BILLING_UNAVAILABLE, e.billingResponseCode)
        assertFalse(e.isRetryable)
    }

    @Test fun hostedHostsArePinned() {
        assertTrue(MoneyMaker.isHostedBaseUrl("https://usemoneymaker.com/v1"))
        assertTrue(MoneyMaker.isHostedBaseUrl("https://moneymaker-io.web.app/v1"))
        assertFalse(MoneyMaker.isHostedBaseUrl("https://usemoneymaker.com.evil.example/v1"))
        assertFalse(MoneyMaker.isHostedBaseUrl("https://api.example.com/v1"))
    }
}
