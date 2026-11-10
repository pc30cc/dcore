package app.core.feature.call

import android.app.Application
import android.app.KeyguardManager
import androidx.activity.ComponentActivity
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.common.Clock
import app.core.common.Diag
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowKeyguardManager

/** Leaving the call screen for the rest of the app waits for the phone to be unlocked. */
@RunWith(AndroidJUnit4::class)
class CallLockScreenTest {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
    private lateinit var activity: ComponentActivity
    private lateinit var hooks: CallActivityHooks
    private lateinit var keyguard: ShadowKeyguardManager

    @Before
    fun setUp() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
        val graph = CallGraph(app, apiOf = { error("no server in this test") }, scope = scope, clock = Clock { 0L }, diag = Diag.Silent)
        hooks = CallActivityHooks(activity, graph) { error("no realtime in this test") }
        keyguard = shadowOf(app.getSystemService(KeyguardManager::class.java))
    }

    @After
    fun tearDown() {
        keyguard.setKeyguardLocked(false)
        ShadowKeyguardManager.reset()
    }

    @Test
    fun unlockedTheActionRunsAtOnce() {
        var ran = 0
        hooks.unlockThen { ran++ }
        assertEquals(1, ran)
    }

    @Test
    fun lockedNothingRunsUntilThePhoneIsUnlockedAndTheCallStaysOverTheLockScreen() {
        hooks.showOverLockScreen(true)
        keyguard.setKeyguardLocked(true)
        var ran = 0
        hooks.unlockThen { ran++ }
        assertEquals("the app is not opened over a locked phone", 0, ran)
        assertTrue("the call screen stays over the lock screen", shadowOf(activity).showWhenLocked)

        keyguard.setKeyguardLocked(false)
        assertEquals("unlocked: the action runs once", 1, ran)
    }

    @Test
    fun aCancelledUnlockRunsNothing() {
        hooks.showOverLockScreen(true)
        keyguard.setKeyguardLocked(true)
        var ran = 0
        hooks.unlockThen { ran++ }
        // The bouncer dismissed without unlocking: the shadow reports a cancel.
        keyguard.setKeyguardLocked(true)
        assertEquals(0, ran)
        assertTrue(shadowOf(activity).showWhenLocked)
    }

    @Test
    fun offTheLockScreenClearsBothFlags() {
        hooks.showOverLockScreen(true)
        assertTrue(shadowOf(activity).showWhenLocked)
        assertTrue(shadowOf(activity).turnScreenOn)
        hooks.showOverLockScreen(false)
        assertFalse(shadowOf(activity).showWhenLocked)
        assertFalse(shadowOf(activity).turnScreenOn)
    }
}
