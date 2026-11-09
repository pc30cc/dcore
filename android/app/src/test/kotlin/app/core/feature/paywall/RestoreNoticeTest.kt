package app.core.feature.paywall

import app.core.billing.RestoreOutcome
import app.core.store.BillingUnavailableReason
import org.junit.Assert.assertEquals
import org.junit.Test

/** The one line every Restore button shows: what was found, in one order everywhere. */
class RestoreNoticeTest {

    private fun done(granted: Set<String> = emptySet(), foreign: Int = 0, invalid: Int = 0, later: Int = 0, inactive: Int = 0) =
        RestoreOutcome.Done(granted, foreign, invalid, later, inactive)

    /** A server that does not say `fresh`: anything that gives access reads as restored, as before. */
    @Test
    fun somethingThatGivesAccessIsRestored() {
        assertEquals(RestoreNotice.RESTORED, done(granted = setOf("sub.plus"), foreign = 1, inactive = 1).notice())
    }

    @Test
    fun otherwiseAnotherAccountsThenUnconfirmedThenInactiveThenNothing() {
        assertEquals(RestoreNotice.OTHER_ACCOUNT, done(foreign = 1, later = 1, inactive = 1).notice())
        assertEquals(RestoreNotice.NOT_CONFIRMED, done(later = 1, inactive = 1).notice())
        assertEquals(RestoreNotice.NOT_ACTIVE, done(inactive = 2, invalid = 1).notice())
        assertEquals(RestoreNotice.NOTHING, done(invalid = 1).notice())
        assertEquals(RestoreNotice.NOTHING, RestoreOutcome.NothingToRestore.notice())
    }

    @Test
    fun withTheServersFreshOnlyWhatWasAddedIsRestored() {
        fun fresh(added: Set<String> = emptySet(), granted: Set<String> = added, foreign: Int = 0, later: Int = 0, inactive: Int = 0) =
            RestoreOutcome.Done(granted, foreign, 0, later, inactive, added = added, addedKnown = true)
        assertEquals(RestoreNotice.RESTORED, fresh(added = setOf("cons.superlike.5"), granted = setOf("sub.plus", "cons.superlike.5"), foreign = 1).notice())
        // Everything the store holds was on the account already.
        assertEquals(RestoreNotice.UP_TO_DATE, fresh(granted = setOf("sub.plus")).notice())
        assertEquals(RestoreNotice.UP_TO_DATE, fresh(granted = setOf("sub.plus"), inactive = 1).notice())
        // What the person may be looking for is said before "you had it already".
        assertEquals(RestoreNotice.NOT_CONFIRMED, fresh(granted = setOf("sub.plus"), later = 1).notice())
        assertEquals(RestoreNotice.OTHER_ACCOUNT, fresh(foreign = 1, later = 1).notice())
        assertEquals(RestoreNotice.NOTHING, fresh().notice())
        assertEquals(app.core.R.string.paywall_restore_up_to_date, RestoreNotice.UP_TO_DATE.message())
    }

    /**
     * A store account that holds this account's purchases and another
     * account's (a shared phone): both are said, so the person does not read
     * that their own purchases are someone else's.
     */
    @Test
    fun ownPurchasesBesideAnotherAccountsAreBothSaid() {
        fun fresh(granted: Set<String>, foreign: Int, later: Int = 0) =
            RestoreOutcome.Done(granted, foreign, 0, later, 0, added = emptySet(), addedKnown = true)
        assertEquals(RestoreNotice.UP_TO_DATE_WITH_OTHER_ACCOUNT, fresh(granted = setOf("sub.premium"), foreign = 1).notice())
        assertEquals(RestoreNotice.UP_TO_DATE_WITH_OTHER_ACCOUNT, fresh(granted = setOf("sub.premium"), foreign = 2, later = 1).notice())
        // Nothing of this account's: only the other account's purchase is said.
        assertEquals(RestoreNotice.OTHER_ACCOUNT, fresh(granted = emptySet(), foreign = 1).notice())
        assertEquals(app.core.R.string.paywall_restore_up_to_date_other_account, RestoreNotice.UP_TO_DATE_WITH_OTHER_ACCOUNT.message())
    }

    @Test
    fun theStoreAndTheNetworkAreSaid() {
        assertEquals(RestoreNotice.OFFLINE, RestoreOutcome.Offline.notice())
        assertEquals(RestoreNotice.FAILED, RestoreOutcome.Failed.notice())
        assertEquals(RestoreNotice.STORE_UNAVAILABLE, RestoreOutcome.StoreUnavailable(BillingUnavailableReason.SERVICE_UNAVAILABLE).notice())
    }

    @Test
    fun anotherAccountsPurchaseReusesThePurchaseText() {
        assertEquals(app.core.R.string.paywall_fail_other_account, RestoreNotice.OTHER_ACCOUNT.message())
    }
}
