package app.core.store

import android.app.Activity
import app.core.common.Diag
import app.core.common.runCatchingUnlessCancelled
import com.google.android.play.agesignals.AgeSignalsAccessRequest
import com.google.android.play.agesignals.AgeSignalsManagerFactory
import com.google.android.play.agesignals.AgeSignalsRequest

/**
 * Google Play's Age Signals (beta, SDK 0.0.4): the age band Play holds for
 * the person, where the law makes Play hold one.
 *
 * Two calls, as the SDK has them: access first (Play may show its own consent
 * screen over [Activity]), then the signal itself, whose `ageLower` and
 * `ageUpper` bound the age. Only "18 or over" and "under 18" come out of
 * here; nothing of the answer is kept or sent but that.
 */
internal class PlayAgeSignals(private val diag: Diag) : AgeSignals {
    override suspend fun check(activity: Activity): AgeSignal =
        runCatchingUnlessCancelled {
            val manager = AgeSignalsManagerFactory.create(activity.applicationContext)
            manager.requestAgeSignalsAccess(AgeSignalsAccessRequest.builder().setActivity(activity).build()).await()
            manager.checkAgeSignals(AgeSignalsRequest.builder().build()).await()
        }.fold(
            onSuccess = { result ->
                val lower = result.ageLower()
                val upper = result.ageUpper()
                when {
                    upper != null && upper < ADULT -> AgeSignal.Minor
                    lower != null && lower >= ADULT -> AgeSignal.Adult
                    else -> AgeSignal.Unknown
                }
            },
            onFailure = { error ->
                diag.info("AgeSignals", "not available: ${error.javaClass.simpleName}")
                AgeSignal.Failed(error.javaClass.simpleName)
            },
        )

    private companion object {
        const val ADULT = 18
    }
}
