package app.core.feature.onboarding

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.net.Uri
import androidx.activity.compose.LocalActivityResultRegistryOwner
import androidx.activity.result.ActivityResultRegistry
import androidx.activity.result.ActivityResultRegistryOwner
import androidx.activity.result.contract.ActivityResultContract
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.core.app.ActivityOptionsCompat
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.core.common.Clock
import app.core.common.Diag
import app.core.feature.auth.AuthGate
import app.core.feature.legal.LegalAcceptance
import app.core.media.LocalPhotoCache
import app.core.media.PhotoUploader
import app.core.model.DeviceInfo
import app.core.model.LegalVersions
import app.core.model.OtpStartRequest
import app.core.net.SampleApi
import app.core.net.SampleData
import app.core.storage.MemorySecretStore
import app.core.store.ExternalSignIn
import app.core.store.SmsCodeReceiver
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Templates
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * Framing picked photos on the photos step, with the system picker answered
 * in place: closing the frame drops that picture only, and a quarter turn is
 * still there when the screen is made again (a rotation, a language change).
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w411dp-h891dp")
class PhotoCropFlowTest {

    @get:Rule val compose = createComposeRule()
    @get:Rule val folder = TemporaryFolder()

    private fun model(): OnboardingViewModel {
        val api = SampleApi(clock = Clock.System, signedIn = false)
        val legal = LegalAcceptance(MemorySecretStore(), Clock.System)
        runBlocking {
            legal.accept(LegalVersions())
            val challenge = api.startOtp(OtpStartRequest("+989127654321", "en"))
            api.verifyOtp(challenge.challengeId, SampleData.CODE, DeviceInfo("Test", "16", "1.0", "en"))
        }
        val gate = AuthGate(api, ExternalSignIn.None, SmsCodeReceiver.None, CoroutineScope(SupervisorJob() + Dispatchers.Main), Diag.Silent)
        return OnboardingViewModel(
            api = api, gate = gate, legal = legal, clock = Clock.System, diag = Diag.Silent,
            saved = SavedStateHandle(),
            config = { SampleData.config("bazaar", "en", 1) },
            uploader = PhotoUploader(api, api, Clock.System, Diag.Silent),
            photoCache = LocalPhotoCache(folder.newFolder()),
            notificationsAskable = { false },
        )
    }

    private val chrome = StepChrome(position = 1, count = 10, onBack = {})

    /** The system photo picker, answering every launch with [pictures] at once. */
    private class Picker(val pictures: () -> List<Uri>) : ActivityResultRegistry(), ActivityResultRegistryOwner {
        override val activityResultRegistry: ActivityResultRegistry get() = this

        override fun <I, O> onLaunch(requestCode: Int, contract: ActivityResultContract<I, O>, input: I, options: ActivityOptionsCompat?) {
            val all = pictures()
            // Many at once (a list) or one (the first).
            @Suppress("UNCHECKED_CAST")
            val result = (if (contract is androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia) all.firstOrNull() else all) as O
            dispatchResult(requestCode, result)
        }
    }

    @Composable
    private fun Step(model: OnboardingViewModel, picker: Picker) {
        CompositionLocalProvider(LocalActivityResultRegistryOwner provides picker) {
            AppTheme(template = Templates.of(Templates.NEON)) {
                val state by model.state.collectAsStateWithLifecycle()
                PhotosStep(state, model, chrome)
            }
        }
    }

    /** A picture as a gallery file: [top] over its upper third, [rest] below, [width] × [height]. */
    private fun picture(name: String, width: Int, height: Int, top: Int, rest: Int): Uri {
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.drawColor(rest)
        canvas.drawRect(0f, 0f, width.toFloat(), height / 3f, Paint().apply { color = top })
        val file = File(folder.root, name)
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 95, it) }
        return Uri.fromFile(file)
    }

    private fun openPicker() {
        compose.waitUntil(5_000) { compose.onAllNodes(hasContentDescription("Add a photo") and hasClickAction()).fetchSemanticsNodes().isNotEmpty() }
        compose.onAllNodes(hasContentDescription("Add a photo") and hasClickAction())[0].performClick()
    }

    @Test
    fun closingTheFrameDropsThatPictureOnly() {
        val model = model()
        val pictures = List(3) { picture("IMG_$it.jpg", 900, 1200, RED, BLUE) }
        compose.setContent { Step(model, Picker { pictures }) }
        openPicker()
        compose.waitUntil(10_000) { compose.onAllNodes(hasText("1 of 3")).fetchSemanticsNodes().isNotEmpty() }
        // Close (back does the same): the next picture comes up, nothing is uploaded, nothing else is lost.
        compose.onNodeWithContentDescription("Close").performClick()
        compose.waitUntil(10_000) { compose.onAllNodes(hasText("2 of 3")).fetchSemanticsNodes().isNotEmpty() }
        assertTrue(model.photos.state.value.tiles.isEmpty())
        compose.onNodeWithText("Use").performClick()
        compose.waitUntil(10_000) { compose.onAllNodes(hasText("3 of 3")).fetchSemanticsNodes().isNotEmpty() }
        assertEquals(1, model.photos.state.value.tiles.size)
    }

    @Test
    fun aQuarterTurnIsStillThereWhenTheScreenIsMadeAgain() {
        val model = model()
        // Landscape, red over its upper third: turned a quarter to the left, the red is the left third.
        val pictures = listOf(picture("IMG_wide.jpg", 1600, 1200, RED, BLUE))
        val restore = StateRestorationTester(compose)
        restore.setContent { Step(model, Picker { pictures }) }
        openPicker()
        val area = hasContentDescription("Photo frame. Drag to move, pinch to zoom.")
        fun leftIsRed(): Boolean {
            if (compose.onAllNodes(area, useUnmergedTree = true).fetchSemanticsNodes().isEmpty()) return false
            val image = compose.onNode(area, useUnmergedTree = true).captureToImage().asAndroidBitmap()
            val pixel = image.getPixel(image.width / 12, image.height / 2)
            return android.graphics.Color.red(pixel) > android.graphics.Color.blue(pixel)
        }
        compose.waitUntil(10_000) { compose.onAllNodes(area, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        compose.waitForIdle()
        assertTrue("not turned yet: blue at the left middle", !leftIsRed())
        compose.onNodeWithContentDescription("Rotate").performClick()
        compose.waitUntil(10_000) { leftIsRed() }
        restore.emulateSavedInstanceStateRestore()
        compose.waitUntil(10_000) { compose.onAllNodes(area, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        compose.waitForIdle()
        assertTrue("the turn is kept", leftIsRed())
    }

    private companion object {
        const val RED = 0xFFDC1E1E.toInt()
        const val BLUE = 0xFF1E1EDC.toInt()
    }
}
