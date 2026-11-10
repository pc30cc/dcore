package app.core.feature.auth

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.add
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.core.R
import app.core.ui.components.AppIconButton
import app.core.ui.components.AppSnackbar
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Space

/**
 * Where sign-in's pages meet the system bars. The design draws a 32 dp status
 * bar: the pages keep at least that much at the top whatever the phone
 * reports. A docked action ([authDock]) sits its minimum distance above the
 * screen's bottom edge, 8 dp above the navigation bar, or 18 dp above the
 * keyboard, whichever is highest.
 */
@Composable
fun Modifier.authTopInsets(): Modifier = windowInsetsPadding(WindowInsets.statusBars.union(WindowInsets(top = AuthInsets.statusBar)))

/** The sides a page's content keeps clear: a display cutout or a navigation bar at the side (landscape). */
@Composable
fun Modifier.authSideInsets(): Modifier = windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal))

/** Above the keyboard and the navigation bar: the bottom of a page's content when nothing is docked under it. */
@Composable
fun Modifier.authBottomInsets(): Modifier = windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars).only(WindowInsetsSides.Bottom))

/** See [authTopInsets]: a docked action's distance from the bottom edge, the navigation bar or the keyboard. */
@Composable
fun Modifier.authDock(min: Dp): Modifier = windowInsetsPadding(
    WindowInsets.navigationBars.add(WindowInsets(bottom = AuthInsets.aboveNavigation))
        .union(WindowInsets.ime.add(WindowInsets(bottom = AuthInsets.aboveKeyboard)))
        .union(WindowInsets(bottom = min)),
)

private object AuthInsets {
    val statusBar = 32.dp
    val aboveNavigation = 8.dp
    val aboveKeyboard = 18.dp
}

/**
 * One sign-in page (privacy, phone, code): the back button at the start of a
 * 56 dp row, the title (`--type-h1`), the page's [content] scrolling under
 * it inside the 20 dp gutter, and its [actions] docked at the bottom, above
 * the keyboard when it is up. [hero] draws `--hero-bg` behind it (neon's
 * light; nothing where the template has no glow). Nothing else: no icon
 * tile, no help button, no step count. Without [actions] the content ends
 * above the keyboard itself, so whatever is under the field can be scrolled
 * into sight while typing. A [snackbar] shows its notices just above the
 * docked actions (or the page's bottom), wherever they end up.
 */
@Composable
internal fun AuthPage(
    title: String,
    onBack: (() -> Unit)?,
    modifier: Modifier = Modifier,
    hero: Boolean = true,
    titleTop: Dp = PageLayout.titleTop,
    actions: (@Composable ColumnScope.() -> Unit)? = null,
    snackbar: SnackbarHostState? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val t = AppTheme.template
    val scroll = rememberScrollState()
    Box(modifier.fillMaxSize().background(t.colors.bg)) {
        if (hero && t.switches.glow) Box(Modifier.fillMaxSize().background(t.paints.heroBg))
        Column(Modifier.fillMaxSize().authTopInsets().authSideInsets()) {
            Row(Modifier.fillMaxWidth().height(PageLayout.topRow).padding(start = PageLayout.backInset), verticalAlignment = Alignment.CenterVertically) {
                if (onBack != null) AppIconButton(AppIcons.Back, stringResource(R.string.ui_back), onBack)
            }
            Box(
                Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .then(if (actions == null) Modifier.authBottomInsets() else Modifier),
            ) {
                Column(
                    Modifier
                        .fillMaxSize()
                        .verticalScroll(scroll)
                        .padding(horizontal = Space.gutter)
                        .padding(top = titleTop, bottom = PageLayout.contentBottom),
                ) {
                    Text(title, style = t.type.h1, color = t.colors.text, modifier = Modifier.semantics { heading() })
                    content()
                }
                // Content cut by the docked actions fades into the page above them, so the cut reads as "more below".
                if (actions != null && scroll.canScrollForward) {
                    Box(
                        Modifier
                            .align(Alignment.BottomCenter)
                            .fillMaxWidth()
                            .height(PageLayout.fadeBand)
                            .background(Brush.verticalGradient(listOf(Color.Transparent, t.colors.bg))),
                    )
                }
                if (snackbar != null) {
                    SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).padding(horizontal = Space.gutter)) { data -> AppSnackbar(data.visuals.message) }
                }
            }
            if (actions != null) {
                Column(
                    Modifier.fillMaxWidth().padding(horizontal = Space.gutter).authDock(PageLayout.dockBottom),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    content = actions,
                )
            }
        }
    }
}

/** A gap of [height] in a page's column. */
@Composable
internal fun Gap(height: Dp) = Spacer(Modifier.height(height))

/** The pages' layout on the design's phone (dp below the 56 dp top row). */
internal object PageLayout {
    val topRow = 56.dp
    /** The back button 8 dp from the edge: its 24 dp glyph lines up with the gutter. */
    val backInset = 8.dp
    /** Title top under the row: 16 dp on phone and code, 8 dp on the privacy summary. */
    val titleTop = 16.dp
    val titleTopTight = 8.dp
    val contentBottom = 16.dp
    val dockBottom = 30.dp
    /** The fade over content that runs on under the docked actions. */
    val fadeBand = 24.dp
}
