package app.core.net

import app.core.model.Settings

/**
 * Hears the account's settings each time an answer carries them (`GET
 * /v1/me`, `PATCH /v1/me/settings`, the profile writes), so what the server
 * holds reaches whoever keeps a copy on the phone (the template choice)
 * without another request.
 *
 * [begin] is called as such a request starts and its token is handed back
 * with the answer: a listener can tell an answer that left before its own
 * latest change from one that saw it.
 */
interface SettingsTap {
    fun begin(): Long

    fun received(begun: Long, settings: Settings)

    /** Hears nothing. */
    object None : SettingsTap {
        override fun begin(): Long = 0

        override fun received(begun: Long, settings: Settings) = Unit
    }
}
