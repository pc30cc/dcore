package app.core.feature.auth

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonColors
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.core.R
import app.core.i18n.brandString
import app.core.ui.theme.AppTheme
import app.core.ui.theme.LocalReducedMotion
import app.core.ui.theme.Radius
import app.core.ui.theme.Space

/**
 * The frame every sign-in and sign-up step shares: a back arrow, an optional
 * bar above the content (onboarding's progress), a title and a line under it,
 * the step's content (scrolling with large text), and the step's actions at
 * the bottom, lifted above the keyboard.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FlowScaffold(
    title: String,
    onBack: (() -> Unit)?,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    topBarExtra: (@Composable () -> Unit)? = null,
    actions: (@Composable ColumnScope.() -> Unit)? = null,
    trailingTopBar: (@Composable () -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    Scaffold(
        modifier = modifier,
        topBar = {
            Column {
                TopAppBar(
                    title = {},
                    navigationIcon = {
                        if (onBack != null) {
                            IconButton(onClick = onBack) {
                                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = brandString(R.string.action_back))
                            }
                        }
                    },
                    actions = { trailingTopBar?.invoke() },
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
                )
                topBarExtra?.invoke()
            }
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                // What the bars already took is not added again by the keyboard's padding below.
                .consumeWindowInsets(padding)
                .imePadding(),
        ) {
            Column(
                Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = Space.gutter)
                    .padding(top = Space.sm, bottom = Space.lg),
                verticalArrangement = Arrangement.spacedBy(Space.md),
            ) {
                Text(
                    title,
                    style = MaterialTheme.typography.headlineMedium,
                    color = MaterialTheme.colorScheme.onBackground,
                    modifier = Modifier.semantics { heading() },
                )
                if (subtitle != null) {
                    Text(
                        subtitle,
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Spacer(Modifier.size(Space.xs))
                content()
            }
            if (actions != null) {
                Column(
                    Modifier
                        .fillMaxWidth()
                        .background(MaterialTheme.colorScheme.background)
                        .navigationBarsPadding()
                        .padding(horizontal = Space.gutter, vertical = Space.md),
                    verticalArrangement = Arrangement.spacedBy(Space.sm),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    content = actions,
                )
            }
        }
    }
}

/**
 * The main button of a step: full width, at least the touch size, and while
 * [busy] a spinner in place of its label (the button keeps its size, so
 * nothing below it jumps).
 */
@Composable
fun PrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    busy: Boolean = false,
    busyLabel: String? = null,
    colors: ButtonColors = ButtonDefaults.buttonColors(),
) {
    val label = if (busy) busyLabel ?: text else text
    Button(
        onClick = { if (!busy) onClick() },
        enabled = enabled || busy,
        colors = colors,
        modifier = modifier
            .fillMaxWidth()
            .widthIn(max = 560.dp)
            .heightIn(min = 56.dp)
            .semantics { if (busy) liveRegion = LiveRegionMode.Polite },
        shape = RoundedCornerShape(Radius.pill),
    ) {
        AnimatedContent(targetState = busy, transitionSpec = { fadeIn(tween(120)) togetherWith fadeOut(tween(120)) }, label = "busy") { isBusy ->
            if (isBusy) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                    CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = LocalContentColor.current)
                    if (busyLabel != null) Text(label, style = MaterialTheme.typography.labelLarge)
                }
            } else {
                Text(label, style = MaterialTheme.typography.labelLarge)
            }
        }
    }
}

/**
 * A message under a field or above the actions: red with an icon for
 * errors, announced by TalkBack when it appears. [shakeKey] changing makes
 * it shake once (not with reduced motion).
 */
@Composable
fun InlineMessage(text: String?, modifier: Modifier = Modifier, error: Boolean = true, shakeKey: Any? = null) {
    val offset = remember { Animatable(0f) }
    val reduced = LocalReducedMotion.current
    LaunchedEffect(shakeKey) {
        if (shakeKey != null && !reduced) {
            for (x in listOf(10f, -8f, 6f, -4f, 0f)) offset.animateTo(x, tween(45))
        }
    }
    AnimatedVisibility(
        visible = text != null,
        enter = fadeIn() + expandVertically(),
        exit = fadeOut() + shrinkVertically(),
        modifier = modifier,
    ) {
        val color = if (error) AppTheme.colors.danger else MaterialTheme.colorScheme.onSurfaceVariant
        Row(
            Modifier
                .fillMaxWidth()
                .graphicsLayer { translationX = offset.value * density }
                .semantics { liveRegion = LiveRegionMode.Polite },
            verticalAlignment = Alignment.Top,
            horizontalArrangement = Arrangement.spacedBy(Space.sm),
        ) {
            if (error) Icon(Icons.Filled.Warning, contentDescription = null, tint = color, modifier = Modifier.size(18.dp).padding(top = 2.dp))
            Text(text.orEmpty(), style = MaterialTheme.typography.bodyMedium, color = color)
        }
    }
}

/** A quiet panel for an explanation (why a permission is asked, what is kept). */
@Composable
fun NoteCard(
    modifier: Modifier = Modifier,
    icon: (@Composable () -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(Radius.lg),
        color = MaterialTheme.colorScheme.surfaceContainer,
    ) {
        Row(Modifier.padding(Space.lg), horizontalArrangement = Arrangement.spacedBy(Space.md)) {
            if (icon != null) Box(Modifier.padding(top = 2.dp)) { icon() }
            Column(verticalArrangement = Arrangement.spacedBy(Space.xs), content = content)
        }
    }
}

/**
 * The language the screen is drawn in (the configuration's locale, which the
 * app sets from the person's choice): what digits, calendars and number
 * formats follow.
 */
@Composable
@androidx.compose.runtime.ReadOnlyComposable
fun screenLanguage(): app.core.i18n.AppLanguage =
    app.core.i18n.AppLanguage.fromTag(androidx.compose.ui.platform.LocalConfiguration.current.locales[0]?.toLanguageTag()) ?: app.core.i18n.AppLanguage.EN

/** A plural resource with `{appName}` filled in, like `brandString`. */
@Composable
fun brandPlural(@androidx.annotation.PluralsRes id: Int, count: Int, vararg formatArgs: Any): String =
    app.core.i18n.brandText(androidx.compose.ui.res.pluralStringResource(id, count, *formatArgs), app.core.i18n.LocalAppName.current)
