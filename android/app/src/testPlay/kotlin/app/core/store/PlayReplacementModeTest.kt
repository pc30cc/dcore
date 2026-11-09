package app.core.store

import com.android.billingclient.api.BillingFlowParams.SubscriptionUpdateParams.ReplacementMode
import org.junit.Assert.assertEquals
import org.junit.Test

/** Each plan change goes to Play with the mode it is named after, and only that one. */
class PlayReplacementModeTest {

    @Test
    fun eachKindMapsToItsPlayMode() {
        assertEquals(ReplacementMode.CHARGE_PRORATED_PRICE, playReplacementMode(PlanChangeKind.CHARGE_DIFFERENCE))
        assertEquals(ReplacementMode.WITH_TIME_PRORATION, playReplacementMode(PlanChangeKind.CREDIT_TIME))
        assertEquals(ReplacementMode.DEFERRED, playReplacementMode(PlanChangeKind.AT_RENEWAL))
        // Between base plans of one subscription Play takes only CHARGE_FULL_PRICE or WITHOUT_PRORATION.
        assertEquals(ReplacementMode.CHARGE_FULL_PRICE, playReplacementMode(PlanChangeKind.CHARGE_FULL))
    }
}
