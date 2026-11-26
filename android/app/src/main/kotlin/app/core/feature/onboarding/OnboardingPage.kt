package app.core.feature.onboarding

import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.exclude
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.imeAnimationTarget
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.core.R
import app.core.feature.auth.AuthInsets
import app.core.feature.auth.authDock
import app.core.feature.auth.authSideInsets
import app.core.feature.auth.authTopInsets
import app.core.i18n.brandString
import app.core.ui.components.HelperLine
import app.core.ui.components.StepsHeader
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Space

/**
 * One sign-up step: back at the start of the top row (and «رد شو» at the
 * end on an optional step), the one 4 dp progress bar, the title
 * (`--type-h1`) and at most one short line under it, the step's [content]
 * scrolling inside the 20 dp gutter, and its [actions] docked 30 dp from the
 * bottom (above the keyboard when it is up, unless that would leave the
 * content too little room: a phone on its side keeps them at the bottom,
 * under the keyboard, whose own action goes on). When the content runs under
 * the docked actions it fades into the page above them. `--hero-bg` behind
 * it where the template has a glow. Nothing else: no step count, no menu, no
 * icon tile.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun OnboardingPage(
    chrome: StepChrome,
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    onSkip: (() -> Unit)? = null,
    error: String? = null,
    scroll: ScrollState = rememberScrollState(),
    actions: @Composable ColumnScope.() -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    val t = AppTheme.template
    // Measured: the page under the status bar, its header, the actions themselves and the whole dock under them.
    var pageHeight by remember { mutableIntStateOf(0) }
    var headerHeight by remember { mutableIntStateOf(0) }
    var actionsHeight by remember { mutableIntStateOf(0) }
    var dockHeight by remember { mutableIntStateOf(0) }
    Box(modifier.fillMaxSize().background(t.colors.bg)) {
        if (t.switches.glow) Box(Modifier.fillMaxSize().background(t.paints.heroBg))
        Column(Modifier.fillMaxSize().authTopInsets().authSideInsets().onSizeChanged { pageHeight = it.height }) {
            StepsHeader(
                step = chrome.position,
                total = chrome.count,
                onBack = chrome.onBack,
                modifier = Modifier.onSizeChanged { headerHeight = it.height },
                skip = if (onSkip != null) brandString(R.string.onboarding_skip) else null,
                onSkip = onSkip,
            )
            val fades by remember(scroll) { derivedStateOf { scroll.maxValue > 0 && scroll.value < scroll.maxValue } }
            // Read through derivedStateOf: the page recomposes when the keyboard comes or goes, not on each frame of it.
            val ime = WindowInsets.ime
            val target = WindowInsets.imeAnimationTarget
            val density = LocalDensity.current
            val typing by remember(ime, density) { derivedStateOf { ime.getBottom(density) > 0 } }
            // Lifted above the keyboard, the actions would leave the content less than [OnboardingLayout.typingRoom]
            // (a phone on its side): they stay at the bottom, under the keyboard. Decided on where the keyboard is
            // going, so they never rise and drop back while it slides in.
            val docked by remember(ime, target, density) {
                derivedStateOf {
                    val keyboard = maxOf(ime.getBottom(density), target.getBottom(density))
                    if (keyboard == 0) return@derivedStateOf true
                    val lifted = actionsHeight + keyboard + with(density) { (OnboardingLayout.fadeAbove - OnboardingLayout.fadeSolid + AuthInsets.aboveKeyboard).roundToPx() }
                    pageHeight - headerHeight - lifted >= with(density) { OnboardingLayout.typingRoom.roundToPx() }
                }
            }
            // The content's viewport ends where the docked actions begin, so the keyboard (which lifts them)
            // shrinks it and the focused field is kept in view above them. With the actions left under the
            // keyboard, it ends at the keyboard instead.
            val underKeyboard = if (docked) Modifier else Modifier.windowInsetsPadding(ime.exclude(WindowInsets(bottom = with(density) { dockHeight.toDp() })))
            Box(Modifier.weight(1f).fillMaxWidth().then(underKeyboard)) {
                Column(
                    Modifier
                        .fillMaxSize()
                        .verticalScroll(scroll)
                        .padding(horizontal = Space.gutter)
                        .padding(top = OnboardingLayout.titleTop, bottom = OnboardingLayout.fadeSolid + OnboardingLayout.contentBottom),
                ) {
                    // Balanced lines (the design's `text-wrap: balance`): no word left alone on a second line.
                    Text(title, style = t.type.h1.copy(lineBreak = LineBreak.Heading), color = t.colors.text, modifier = Modifier.semantics { heading() })
                    if (subtitle != null) {
                        Spacer(Modifier.height(OnboardingLayout.subtitleTop))
                        Text(subtitle, style = t.type.bodySm, color = t.colors.text2)
                    }
                    content()
                    if (error != null) {
                        Spacer(Modifier.height(OnboardingLayout.errorTop))
                        HelperLine(error, error = true)
                    }
                }
                // What scrolls on under the actions fades into the page above them. Not while typing: the
                // field being typed in sits right above the actions then, and nothing is drawn over it.
                if (fades && !typing) {
                    Box(
                        Modifier
                            .align(Alignment.BottomCenter)
                            .fillMaxWidth()
                            .height(OnboardingLayout.fadeSolid)
                            .background(Brush.verticalGradient(listOf(Color.Transparent, t.colors.bg))),
                    )
                }
            }
            // The docked actions: solid from just above their top whatever their height (large text, two buttons).
            Column(
                Modifier
                    .fillMaxWidth()
                    .onSizeChanged { dockHeight = it.height }
                    .then(if (fades) Modifier.background(t.colors.bg) else Modifier)
                    .padding(top = OnboardingLayout.fadeAbove - OnboardingLayout.fadeSolid)
                    .padding(horizontal = Space.gutter)
                    .authDock(OnboardingLayout.dockBottom, aboveKeyboard = docked)
                    .onSizeChanged { actionsHeight = it.height },
                horizontalAlignment = Alignment.CenterHorizontally,
                content = actions,
            )
        }
    }
}

/** A 1 dp `--line` hairline along the top of what follows it, drawn inside it (it takes no room, as the design's do). */
@Composable
internal fun Modifier.topHairline(draw: Boolean = true): Modifier {
    if (!draw) return this
    val color = AppTheme.template.colors.line
    return drawBehind { drawRect(color, size = Size(size.width, OnboardingLayout.hairline.toPx())) }
}

/** A gap of [height] in a step's column. */
@Composable
internal fun Gap(height: Dp) = Spacer(Modifier.height(height))

/** The steps' layout on the design's phone (dp; the same in every template). */
internal object OnboardingLayout {
    /** Title top under the 4 dp bar (88 + 4 + 26 = 118 dp from the top). */
    val titleTop = 26.dp
    val subtitleTop = 6.dp
    val errorTop = 12.dp
    val contentBottom = 16.dp
    /**
     * The docked actions sit 30 dp from the bottom; the fade reaches 54 dp
     * above them and is solid 6 dp above their top, so nothing that scrolls
     * under them shows through the button.
     */
    val dockBottom = 30.dp
    /** The least the content keeps above actions lifted over the keyboard: a field and the gap above it. */
    val typingRoom = 96.dp
    val fadeAbove = 54.dp
    val fadeSolid = 48.dp
    /** Between the title (or its line) and the step's content. */
    val nameTop = 26.dp
    val wheelsTop = 30.dp
    val optionsTop = 28.dp
    val gridTop = 26.dp
    val cardsTop = 24.dp
    val sectionsTop = 16.dp
    val rulesTop = 18.dp
    val groupTop = 28.dp
    /** Between choice rows, photo tiles, buttons; between prompt cards. */
    val optionGap = 10.dp
    val tileGap = 10.dp
    val cardGap = 12.dp
    val buttonGap = 10.dp
    val hairline = 1.dp
}
