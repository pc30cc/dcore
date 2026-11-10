package app.core.feature.onboarding

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
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
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
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
import app.core.feature.auth.authSideInsets
import app.core.feature.auth.authTopInsets
import app.core.feature.legal.PrivacyNoticeScreen
import app.core.i18n.brandString
import app.core.push.OpenTarget
import app.core.ui.components.AppDialog
import app.core.ui.components.PrimaryButton
import app.core.ui.components.StepsHeader
import app.core.ui.components.TextAction
import app.core.ui.components.TextActionKind
import app.core.ui.components.skeleton
import app.core.ui.theme.AppTheme
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
    var leaving by rememberSaveable { mutableStateOf(false) }

    // Back to the app (from the photo picker, the settings, another app): the account may have moved on.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { model.refresh(quiet = true) }
    // The store's own age signal, where it has one (Play), once per install: under 18 ends the sign-up.
    val host = androidx.activity.compose.LocalActivity.current
    androidx.compose.runtime.LaunchedEffect(host) {
        if (host != null && graph.ageCheck.minor(host)) graph.auth.ended(app.core.feature.auth.GateNotice.AccountClosed)
    }
    // Back from the first step leaves sign-up, after asking; from any other, the step before.
    val back: () -> Unit = { if (state.canGoBack) model.back() else leaving = true }
    BackHandler(enabled = state.done == null && !state.loading) { back() }

    val done = state.done
    when {
        done != null -> DoneStep(state, model, onLeave = { profile ->
            model.leave(profile) { graph.push.links.open(OpenTarget.Profile) }
        })
        state.loading || (state.finishing && state.step == null) -> OnboardingLoading()
        state.loadError != null -> OnboardingLoadFailed(state.loadError, onRetry = model::load, onSignOut = { leaving = true })
        else -> OnboardingSteps(state, model, back)
    }
    if (leaving) {
        AppDialog(
            title = brandString(R.string.dialog_sign_out_title),
            body = null,
            confirm = brandString(R.string.dialog_sign_out_confirm),
            onConfirm = {
                leaving = false
                model.signOut()
            },
            dismiss = brandString(R.string.dialog_sign_out_stay),
            onDismiss = { leaving = false },
            destructive = false,
        )
    }
}

/** Android 13+ asks for the notification permission; earlier versions have it from the install. */
internal fun notificationsAskable(context: Context): Boolean =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED

@Composable
private fun OnboardingSteps(state: OnboardingUiState, model: OnboardingViewModel, back: () -> Unit) {
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
        val chrome = StepChrome(position = state.position, count = state.count, onBack = back)
        when (current) {
            OnboardingStep.Privacy -> PrivacyNoticeScreen(onBack = back, onAccept = model::acceptPrivacy, busy = state.busy)
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

/** Where a step is in the sign-up, and its back (the step before, or leaving sign-up from the first). */
data class StepChrome(
    val position: Int,
    val count: Int,
    val onBack: () -> Unit,
)

/** While the account is read: the shape of a step (the bar, the title, two rows), not a spinner. */
@Composable
private fun OnboardingLoading() {
    val t = AppTheme.template
    val label = brandString(R.string.ui_loading)
    // One node for TalkBack («در حال بارگذاری»): the bar and shapes inside say nothing of their own.
    Box(Modifier.fillMaxSize().background(t.colors.bg).clearAndSetSemantics { contentDescription = label }) {
        Column(Modifier.fillMaxSize().authTopInsets().authSideInsets()) {
            StepsHeader(step = 0, total = 0, onBack = null)
            Column(
                Modifier.padding(horizontal = Space.gutter).padding(top = OnboardingLayout.titleTop),
                verticalArrangement = Arrangement.spacedBy(OnboardingLayout.optionGap),
            ) {
                Box(Modifier.fillMaxWidth(LOADING_TITLE).height(LoadingShapes.title).skeleton())
                Gap(OnboardingLayout.optionsTop - OnboardingLayout.optionGap)
                repeat(LOADING_ROWS) { Box(Modifier.fillMaxWidth().height(LoadingShapes.row).skeleton()) }
            }
        }
    }
}

private const val LOADING_TITLE = 0.6f
private const val LOADING_ROWS = 2

private object LoadingShapes {
    val title = 34.dp
    val row = 60.dp
}

/** The account could not be read: one line, try again, or leave sign-up. */
@Composable
private fun OnboardingLoadFailed(error: StepError?, onRetry: () -> Unit, onSignOut: () -> Unit) {
    val t = AppTheme.template
    Box(Modifier.fillMaxSize().background(t.colors.bg).authTopInsets().padding(Space.gutter), contentAlignment = Alignment.Center) {
        Column(
            Modifier.widthIn(max = FailedWidth),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(Space.lg),
        ) {
            Text(
                stepErrorText(error) ?: brandString(R.string.error_generic),
                style = t.type.h2,
                color = t.colors.text,
                textAlign = TextAlign.Center,
                modifier = Modifier.semantics { heading() },
            )
            PrimaryButton(brandString(R.string.action_try_again), onRetry)
            TextAction(brandString(R.string.dialog_sign_out_confirm), onSignOut, kind = TextActionKind.Neutral)
        }
    }
}

private val FailedWidth = 420.dp

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

/** A loading shape in the template (`--skeleton`), for the account-state screens too. */
@Composable
fun Skeleton(modifier: Modifier) {
    Box(modifier.skeleton())
}
