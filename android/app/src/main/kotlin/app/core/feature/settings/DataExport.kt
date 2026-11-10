package app.core.feature.settings

import app.core.R
import app.core.common.Clock
import app.core.common.runCatchingUnlessCancelled
import app.core.model.ExportState
import app.core.net.ApiError
import app.core.net.ServerApi

/**
 * «یه نسخه از اطلاعاتم رو بگیر» (Settings, deleting the account): a ready
 * export opens its link; otherwise one is asked for (or the one being built
 * is kept) and the person is told it will be ready here. The server allows
 * one a week: a later ask says so.
 */
class DataExport(private val api: ServerApi, private val clock: Clock) {
    suspend fun run(): SettingsEvent = runCatchingUnlessCancelled {
        val status = api.exportStatus()
        val link = status.link(clock.now())
        when {
            link != null -> SettingsEvent.Open(link)
            status.status == ExportState.Pending -> SettingsEvent.Notice(R.string.settings_export_started)
            else -> {
                api.requestExport()
                SettingsEvent.Notice(R.string.settings_export_started)
            }
        }
    }.getOrElse { e ->
        SettingsEvent.Notice(
            when {
                (e as? ApiError.Http)?.status == TOO_MANY -> R.string.settings_export_weekly
                e is ApiError.Network -> R.string.error_offline
                else -> R.string.error_generic
            },
        )
    }

    private companion object {
        const val TOO_MANY = 429
    }
}
