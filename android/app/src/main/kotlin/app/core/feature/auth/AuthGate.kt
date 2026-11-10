package app.core.feature.auth

import app.core.common.Diag
import app.core.common.runCatchingUnlessCancelled
import app.core.model.AccountStatus
import app.core.model.AuthUser
import app.core.model.Problem
import app.core.model.ProblemCodes
import app.core.net.ApiEvent
import app.core.net.ServerApi
import app.core.store.ExternalSignIn
import app.core.store.SmsCodeReceiver
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicBoolean

/** The places the app's root can be, by the session and the account's state. */
enum class Root {
    /** Reading the session (a few milliseconds). */
    Splash,

    /** No session: the welcome, the privacy notice, the phone and code steps. */
    SignIn,

    /** Signed up, sign-up not finished. */
    Onboarding,

    /** Sign-up finished; the profile waits for a review. */
    Review,

    /** Suspended or banned: the reason and the appeal, nothing else. */
    Restricted,

    /** Deleted, inside the grace period: restore or sign out. */
    Restore,

    /** Everything else. */
    Main,
    ;

    companion object {
        /**
         * Where an account in [status] belongs. A status this build does not
         * know goes to the main screens, where the server says what it may do.
         */
        fun of(user: AuthUser?): Root = when (user?.status) {
            null -> SignIn
            AccountStatus.Onboarding -> Onboarding
            AccountStatus.PendingReview -> Review
            AccountStatus.Suspended, AccountStatus.Banned -> Restricted
            AccountStatus.Deleted -> Restore
            AccountStatus.Active, AccountStatus.Snoozed, AccountStatus.Unknown -> Main
        }
    }
}

/** Something to tell the person once the root changed under them. */
enum class GateNotice {
    /** The session ended on the server (revoked, expired elsewhere). */
    SessionEnded,

    /** Sign-up refused for age: the account is closed. */
    AccountClosed,
}

/**
 * Decides where the app's root is, for the whole process: signed out,
 * signing up, waiting for a review, restricted, deleting, or in.
 *
 * It reads only the session stored on the phone (no request at a cold
 * start), and moves when something says the account changed: a sign-in, a
 * finished sign-up, a fresh `GET /v1/me`, a 403 `account_*` from any request,
 * the session lost on a refresh. The navigation host follows [root].
 */
class AuthGate(
    private val api: ServerApi,
    /** The store build's own: Google in the Play build, none in the Bazaar build. */
    storeSignIn: ExternalSignIn,
    storeSmsCodes: SmsCodeReceiver,
    private val scope: CoroutineScope,
    private val diag: Diag,
) {
    private val _root = MutableStateFlow(Root.Splash)
    val root: StateFlow<Root> = _root.asStateFlow()

    private val _notice = MutableStateFlow<GateNotice?>(null)
    val notice: StateFlow<GateNotice?> = _notice.asStateFlow()

    /** Set by a 426: the minimum version code, when the server named one (0 otherwise). */
    private val _upgrade = MutableStateFlow<Int?>(null)
    val upgrade: StateFlow<Int?> = _upgrade.asStateFlow()

    /** Set by a 503 `maintenance`: the server's message (may be empty). */
    private val _maintenance = MutableStateFlow<String?>(null)
    val maintenance: StateFlow<String?> = _maintenance.asStateFlow()

    /** The last `account_*` refusal, for the restricted and restore screens to show at once. */
    private val _accountProblem = MutableStateFlow<Problem?>(null)
    val accountProblem: StateFlow<Problem?> = _accountProblem.asStateFlow()

    /**
     * Sign-in with an account on the phone. A debug build on the in-memory
     * sample backend gets the sample's own (the sample answers for Google too).
     */
    val externalSignIn: ExternalSignIn = (api as? ExternalSignIn) ?: storeSignIn

    /** Codes read from the text message; the sample stands in for the retriever only where the build has one. */
    val smsCodes: SmsCodeReceiver =
        if (storeSmsCodes !== SmsCodeReceiver.None && api is SmsCodeReceiver) api else storeSmsCodes

    private val started = AtomicBoolean(false)

    private class SignOutHook(val before: suspend () -> Unit, val after: suspend () -> Unit)

    private val signOutHooks = java.util.concurrent.CopyOnWriteArrayList<SignOutHook>()

    /**
     * Work a sign-out owes: [before] runs while the session still exists
     * (clearing the push token on the server), [after] once it is gone
     * (deleting the token, clearing caches and notifications). Both are best
     * effort and never stop the sign-out. A session lost on the server runs
     * [after] only.
     */
    fun onSignOut(before: suspend () -> Unit = {}, after: suspend () -> Unit = {}) {
        signOutHooks += SignOutHook(before, after)
    }

    private suspend fun runHooks(which: (SignOutHook) -> (suspend () -> Unit)) {
        signOutHooks.forEach { hook -> runCatchingUnlessCancelled { which(hook)() } }
    }

    fun start() {
        if (!started.compareAndSet(false, true)) return
        scope.launch {
            val user = runCatchingUnlessCancelled { if (api.hasSession()) api.sessionUser() else null }.getOrNull()
            // A session without its account record (an old install) is treated as signed in;
            // the first answer from the server corrects it.
            _root.value = if (user == null && runCatchingUnlessCancelled { api.hasSession() }.getOrDefault(false)) Root.Main else Root.of(user)
        }
        scope.launch {
            api.events.collect { event ->
                when (event) {
                    ApiEvent.SessionLost -> ended(GateNotice.SessionEnded)
                    is ApiEvent.UpgradeRequired -> _upgrade.value = event.minVersionCode ?: 0
                    is ApiEvent.Maintenance -> _maintenance.value = event.message.orEmpty()
                    is ApiEvent.AccountState -> accountRefused(event.problem)
                }
            }
        }
    }

    /** A sign-in or sign-up answered: go where the account belongs. */
    fun signedIn(user: AuthUser) {
        _notice.value = null
        _accountProblem.value = null
        _root.value = Root.of(user)
    }

    /** A fresh answer about the account (`GET /v1/me`, a restore): move if its state changed. */
    fun accountChanged(user: AuthUser) {
        val next = Root.of(user)
        if (_root.value != next && _root.value != Root.Splash && _root.value != Root.SignIn) {
            diag.info(AREA, "account state moved the root: ${_root.value} -> $next")
            _root.value = next
        }
        if (next != Root.Restricted && next != Root.Restore) _accountProblem.value = null
    }

    private fun accountRefused(problem: Problem) {
        _accountProblem.value = problem
        val next = when (problem.code) {
            ProblemCodes.ACCOUNT_DELETED -> Root.Restore
            else -> Root.Restricted
        }
        if (_root.value != Root.SignIn && _root.value != next) _root.value = next
    }

    /** The session is over without the person asking (or the account was closed): back to the welcome. */
    fun ended(notice: GateNotice?) {
        scope.launch {
            runCatchingUnlessCancelled { api.discardSession() }
            runCatchingUnlessCancelled { externalSignIn.signOut() }
            runHooks { it.after }
            _accountProblem.value = null
            _notice.value = notice
            _root.value = Root.SignIn
        }
    }

    /**
     * Signs out here: the server is told when it can be reached; when it
     * cannot, the session is forgotten on the phone anyway (its refresh
     * token goes with it, so nobody can use it again from here).
     *
     * [allSessions] ends every session, which only the server can do: when
     * it cannot be told, the failure is thrown and this phone stays signed
     * in (forgetting only this session would look the same as success
     * while the other devices stay signed in).
     */
    suspend fun signOut(allSessions: Boolean = false) {
        runHooks { it.before }
        runCatchingUnlessCancelled { api.logout(allSessions) }
            .onFailure {
                if (allSessions) {
                    diag.info(AREA, "sign-out everywhere could not reach the server (${it.javaClass.simpleName}); still signed in")
                    throw it
                }
                diag.info(AREA, "sign-out could not reach the server (${it.javaClass.simpleName}); forgotten here")
                runCatchingUnlessCancelled { api.discardSession() }
            }
        runCatchingUnlessCancelled { externalSignIn.signOut() }
        runHooks { it.after }
        _accountProblem.value = null
        _notice.value = null
        _root.value = Root.SignIn
    }

    fun clearNotice() {
        _notice.value = null
    }

    /** The maintenance screen's "try again" got an answer. */
    fun maintenanceOver() {
        _maintenance.value = null
    }

    private companion object {
        const val AREA = "AuthGate"
    }
}
