package app.core.feature.onboarding

import androidx.activity.compose.BackHandler
import androidx.annotation.StringRes
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import app.core.R
import app.core.i18n.brandString
import app.core.ui.theme.Space

/**
 * The sign-up steps, in order. Each will hold its own form; the
 * progress lives on the server (a person can continue from any step on any
 * device), which is not built yet.
 */
enum class OnboardingStep(@StringRes val title: Int) {
    NAME(R.string.onboarding_step_name),
    BIRTHDAY(R.string.onboarding_step_birthday),
    GENDER(R.string.onboarding_step_gender),
    INTERESTED_IN(R.string.onboarding_step_interested_in),
    GOAL(R.string.onboarding_step_goal),
    PHOTOS(R.string.onboarding_step_photos),
    LOCATION(R.string.onboarding_step_location),
    NOTIFICATIONS(R.string.onboarding_step_notifications),
    RULES(R.string.onboarding_step_rules),
}

/**
 * The onboarding frame: a progress bar, the step's title, and Next. The steps'
 * contents are not built: each says so.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OnboardingRoute(onExit: () -> Unit, onFinished: () -> Unit) {
    val steps = OnboardingStep.entries
    var index by rememberSaveable { mutableIntStateOf(0) }
    val step = steps[index]
    val last = index == steps.lastIndex
    val goBack: () -> Unit = {
        if (index > 0) index -= 1 else onExit()
    }

    BackHandler(enabled = index > 0) { index -= 1 }

    Scaffold(
        topBar = {
            Column {
                TopAppBar(
                    title = { Text(brandString(R.string.onboarding_progress, index + 1, steps.size)) },
                    navigationIcon = {
                        IconButton(onClick = goBack) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = brandString(R.string.action_back))
                        }
                    },
                )
                LinearProgressIndicator(
                    progress = { (index + 1f) / steps.size },
                    modifier = Modifier.fillMaxWidth().padding(horizontal = Space.gutter),
                )
            }
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(horizontal = Space.gutter, vertical = Space.xl)
                .navigationBarsPadding(),
            verticalArrangement = Arrangement.spacedBy(Space.md),
        ) {
            Text(
                brandString(step.title),
                style = MaterialTheme.typography.headlineMedium,
                modifier = Modifier.semantics { heading() },
            )
            Text(
                brandString(R.string.onboarding_step_not_built),
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.weight(1f))
            Button(
                onClick = { if (last) onFinished() else index += 1 },
                modifier = Modifier.fillMaxWidth().heightIn(min = Space.minTouch),
            ) {
                Text(brandString(if (last) R.string.action_finish else R.string.action_next))
            }
        }
    }
}
