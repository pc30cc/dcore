package app.core.feature.onboarding

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import app.core.LocalAppGraph
import app.core.R
import app.core.feature.auth.InlineMessage
import app.core.feature.auth.PrimaryButton
import app.core.feature.legal.PrivacyNoticeScreen
import app.core.i18n.brandString
import app.core.ui.components.BrandMark
import app.core.ui.theme.LocalReducedMotion
import app.core.ui.theme.Motion
import app.core.ui.theme.Space

/**
 * Sign-up. The step comes from the server's account ([OnboardingPlan]), so
 * a person who stopped on another phone carries on where they were.
 */
@Composable
fun OnboardingRoute() {
    val graph = LocalAppGraph.current
    val context = LocalContext.current
    val model: OnboardingViewModel = viewModel(
        factory = viewModelFactory {
            initializer {
                val app = context.applicationContext
                OnboardingViewModel(
                    api = graph.api,
                    gate = graph.auth,
                    legal = graph.legal,
                    clock = graph.clock,
                    diag = graph.diag,
                    saved = createSavedStateHandle(),
                    config = { graph.config.config.value },
                    uploader = graph.photoUploader,
                    photoCache = graph.photoCache,
                    notificationsAskable = { notificationsAskable(app) },
                )
            }
        },
    )
    val state by model.state.collectAsStateWithLifecycle()

    // Back to the app (from the photo picker, the settings, another app): the account may have moved on.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { model.refresh(quiet = true) }
    // The store's own age signal, where it has one (Play), once per install: under 18 ends the sign-up.
    val host = androidx.activity.compose.LocalActivity.current
    androidx.compose.runtime.LaunchedEffect(host) {
        if (host != null && graph.ageCheck.minor(host)) graph.auth.ended(app.core.feature.auth.GateNotice.AccountClosed)
    }
    BackHandler(enabled = state.canGoBack) { model.back() }

    when {
        state.loading -> OnboardingLoading()
        state.loadError != null -> OnboardingLoadFailed(state.loadError, onRetry = model::load, onSignOut = model::signOut)
        state.finishing && state.error == null -> OnboardingFinishing()
        else -> OnboardingSteps(state, model)
    }
}

/** Android 13+ asks for the notification permission; earlier versions have it from the install. */
internal fun notificationsAskable(context: Context): Boolean =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED

@Composable
private fun OnboardingSteps(state: OnboardingUiState, model: OnboardingViewModel) {
    val step = state.step ?: return
    val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
    val reduced = LocalReducedMotion.current
    AnimatedContent(
        targetState = step,
        transitionSpec = {
            if (reduced) {
                fadeIn(tween(Motion.SHORT_MS)) togetherWith fadeOut(tween(Motion.SHORT_MS))
            } else {
                val forward = targetState.ordinal > initialState.ordinal
                val sign = (if (rtl) -1 else 1) * (if (forward) 1 else -1)
                (slideInHorizontally(Motion.screen) { it * sign / 3 } + fadeIn(tween(Motion.MEDIUM_MS))) togetherWith
                    (slideOutHorizontally(Motion.screen) { -it * sign / 3 } + fadeOut(tween(Motion.SHORT_MS)))
            }
        },
        label = "onboardingStep",
    ) { current ->
        val chrome = StepChrome(
            position = state.position,
            count = state.count,
            onBack = if (state.canGoBack) ({ model.back() }) else null,
            onSignOut = model::signOut,
        )
        when (current) {
            OnboardingStep.Privacy -> PrivacyNoticeScreen(state.legalVersions, onBack = null, onAccept = model::acceptPrivacy, busy = state.busy)
            OnboardingStep.Name -> NameStep(state, model, chrome)
            OnboardingStep.BirthDate -> BirthDateStep(state, model, chrome)
            OnboardingStep.Gender -> GenderStep(state, model, chrome)
            OnboardingStep.InterestedIn -> InterestedInStep(state, model, chrome)
            OnboardingStep.Intention -> IntentionStep(state, model, chrome)
            OnboardingStep.Photos -> PhotosStep(state, model, chrome)
            OnboardingStep.Prompts -> PromptsStep(state, model, chrome)
            OnboardingStep.Fields -> FieldsStep(state, model, chrome)
            OnboardingStep.Location -> LocationStep(state, model, chrome)
            OnboardingStep.Notifications -> NotificationsStep(state, model, chrome)
            OnboardingStep.Guidelines -> GuidelinesStep(state, model, chrome)
        }
    }
}

/** What every step's frame needs: where it is in the sign-up, back, and the menu. */
data class StepChrome(
    val position: Int,
    val count: Int,
    val onBack: (() -> Unit)?,
    val onSignOut: () -> Unit,
)

/** The progress bar under the top bar, moving with a spring as steps pass. */
@Composable
fun StepProgress(chrome: StepChrome) {
    val target = if (chrome.count == 0) 0f else chrome.position.toFloat() / chrome.count
    val reduced = LocalReducedMotion.current
    val progress by animateFloatAsState(target, if (reduced) tween(0) else spring(stiffness = 200f), label = "progress")
    val label = brandString(R.string.onboarding_progress, chrome.position, chrome.count)
    LinearProgressIndicator(
        progress = { progress },
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = Space.gutter)
            .height(6.dp)
            .clip(RoundedCornerShape(3.dp))
            .semantics { contentDescription = label },
        drawStopIndicator = {},
        gapSize = 0.dp,
    )
}

/** The top bar's menu: signing out is always possible, sign-up or not. */
@Composable
fun StepMenu(chrome: StepChrome) {
    var open by rememberSaveable { mutableStateOf(false) }
    var confirm by rememberSaveable { mutableStateOf(false) }
    Box {
        IconButton(onClick = { open = true }) {
            Icon(Icons.Filled.MoreVert, contentDescription = brandString(R.string.action_more))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(text = { Text(brandString(R.string.action_sign_out)) }, onClick = {
                open = false
                confirm = true
            })
        }
    }
    if (confirm) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text(brandString(R.string.onboarding_sign_out_title)) },
            text = { Text(brandString(R.string.onboarding_sign_out_body)) },
            confirmButton = {
                TextButton(onClick = {
                    confirm = false
                    chrome.onSignOut()
                }) { Text(brandString(R.string.action_sign_out)) }
            },
            dismissButton = { TextButton(onClick = { confirm = false }) { Text(brandString(R.string.action_cancel)) } },
        )
    }
}

/** While the account is read: the shape of a step, not a spinner. */
@Composable
private fun OnboardingLoading() {
    val label = brandString(R.string.onboarding_loading)
    Column(
        Modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .padding(horizontal = Space.gutter, vertical = Space.xxl)
            .semantics { contentDescription = label },
        verticalArrangement = Arrangement.spacedBy(Space.lg),
    ) {
        Skeleton(Modifier.fillMaxWidth().height(6.dp))
        Spacer(Modifier.height(Space.xl))
        Skeleton(Modifier.fillMaxWidth(0.7f).height(32.dp))
        Skeleton(Modifier.fillMaxWidth(0.9f).height(18.dp))
        Spacer(Modifier.height(Space.lg))
        Skeleton(Modifier.fillMaxWidth().height(56.dp))
    }
}

@Composable
fun Skeleton(modifier: Modifier) {
    Box(modifier.clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.surfaceContainerHigh))
}

@Composable
private fun OnboardingLoadFailed(error: StepError?, onRetry: () -> Unit, onSignOut: () -> Unit) {
    Box(Modifier.fillMaxSize().safeDrawingPadding().padding(Space.xl), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.lg)) {
            BrandMark(size = 64.dp)
            Text(
                brandString(if (error == StepError.Offline) R.string.error_offline_title else R.string.error_generic_title),
                style = MaterialTheme.typography.titleLarge,
            )
            InlineMessage(stepErrorText(error), error = false)
            PrimaryButton(brandString(R.string.action_try_again), onClick = onRetry)
            TextButton(onClick = onSignOut) { Text(brandString(R.string.action_sign_out)) }
        }
    }
}

@Composable
private fun OnboardingFinishing() {
    Box(Modifier.fillMaxSize().safeDrawingPadding(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.lg)) {
            BrandMark(size = 80.dp)
            Text(brandString(R.string.onboarding_finishing), style = MaterialTheme.typography.titleLarge)
            androidx.compose.material3.CircularProgressIndicator()
        }
    }
}

/** The sentence for a step's error, or null. */
@Composable
fun stepErrorText(error: StepError?): String? = when (error) {
    null -> null
    StepError.Offline -> brandString(R.string.error_offline)
    StepError.TextRefused -> brandString(R.string.onboarding_error_text_refused)
    StepError.Invalid -> brandString(R.string.onboarding_error_invalid)
    is StepError.RateLimited -> {
        val s = error.seconds
        if (s != null && s > 0) brandString(R.string.auth_error_rate_limited_wait, (s / 60).toInt(), (s % 60).toInt()) else brandString(R.string.auth_error_rate_limited)
    }
    StepError.Incomplete -> brandString(R.string.onboarding_error_incomplete)
    StepError.Failed -> brandString(R.string.error_generic)
}
