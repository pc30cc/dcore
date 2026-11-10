package app.core.feature.onboarding

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.core.R
import app.core.feature.auth.Root
import app.core.feature.auth.authDock
import app.core.feature.auth.authSideInsets
import app.core.feature.auth.authTopInsets
import app.core.i18n.Numerals
import app.core.i18n.brandString
import app.core.i18n.screenLanguage
import app.core.media.PhotoImage
import app.core.model.Photo
import app.core.ui.components.PhotoScrimBottom
import app.core.ui.components.PrimaryButton
import app.core.ui.components.StoryProgress
import app.core.ui.components.TextAction
import app.core.ui.components.filmGrain
import app.core.ui.components.raised
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Space
import kotlin.math.roundToInt

/**
 * Sign-up done: the person's own card (the main photo, the story bars, name
 * and age, the city, on a bottom scrim; `--raised-shadow`), «آماده‌ای،
 * آرش!» (the name in `--accent-text`), «بریم» into the app and «پروفایلم رو
 * ببینم» (the Profile tab; not while the profile waits for a review).
 * `--hero-bg-strong` and grain behind it where the template has a glow.
 */
@Composable
internal fun DoneStep(state: OnboardingUiState, model: OnboardingViewModel, onLeave: (profile: Boolean) -> Unit) {
    val t = AppTheme.template
    val language = screenLanguage()
    val photos by model.photos.state.collectAsStateWithLifecycle()
    val main = photos.uploaded.firstOrNull()
    val preview = photos.tiles.filterIsInstance<PhotoTile.Uploaded>().firstOrNull()?.preview
    val name = state.name.trim()
    val age = state.age(model.today())
    val city = (state.location as? LocationPhase.Set)?.city?.name
    val user = state.done
    Box(Modifier.fillMaxSize().background(t.colors.bg)) {
        if (t.switches.glow) Box(Modifier.fillMaxSize().background(t.paints.heroBgStrong).filmGrain())
        Column(Modifier.fillMaxSize().authTopInsets().authSideInsets()) {
            BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
                val viewport = maxHeight
                val title = brandString(R.string.onboarding_done_title, name)
                val at = title.lastIndexOf(name).takeIf { name.isNotEmpty() && it >= 0 }
                // The title is measured first and keeps its whole height; the card (280 × 400 on the design's
                // phone) takes what is left, down to its minimum, and past that the page scrolls.
                Layout(
                    contents = listOf(
                        {
                            OwnCard(
                                preview = preview,
                                main = main,
                                count = photos.uploaded.size,
                                who = if (age != null) brandString(R.string.onboarding_done_name, name, Numerals.format(age, language)) else name,
                                city = city,
                            )
                        },
                        {
                            Text(
                                buildAnnotatedString {
                                    if (at == null) {
                                        append(title)
                                    } else {
                                        append(title.substring(0, at))
                                        withStyle(SpanStyle(brush = t.paints.accentText)) { append(title.substring(at)) }
                                    }
                                },
                                style = t.type.display.copy(lineBreak = LineBreak.Heading),
                                color = t.colors.text,
                                textAlign = TextAlign.Center,
                                modifier = Modifier.semantics { heading() },
                            )
                        },
                    ),
                    modifier = Modifier.fillMaxWidth().verticalScroll(rememberScrollState()),
                ) { (cardPart, titlePart), constraints ->
                    val width = constraints.maxWidth
                    val gutter = Space.gutter.roundToPx()
                    val inner = (width - gutter * 2).coerceAtLeast(0)
                    val heading = titlePart.first().measure(Constraints.fixedWidth(inner))
                    val top = DoneLayout.cardTop.roundToPx()
                    val gap = DoneLayout.titleTop.roundToPx()
                    val room = viewport.roundToPx() - top - gap - heading.height - DoneLayout.titleAir.roundToPx()
                    val cardHeight = minOf(DoneLayout.cardHeight.roundToPx(), room).coerceAtLeast(DoneLayout.cardMin.roundToPx())
                    val cardWidth = minOf((cardHeight * DoneLayout.CARD_ASPECT).roundToInt(), inner)
                    val card = cardPart.first().measure(Constraints.fixed(cardWidth, cardHeight))
                    layout(width, top + cardHeight + gap + heading.height) {
                        card.placeRelative((width - cardWidth) / 2, top)
                        heading.placeRelative(gutter, top + cardHeight + gap)
                    }
                }
            }
            Column(
                Modifier.fillMaxWidth().padding(horizontal = Space.gutter).authDock(DoneLayout.dockBottom),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                PrimaryButton(brandString(R.string.onboarding_done_go), { onLeave(false) })
                if (user != null && Root.of(user) == Root.Main) {
                    Gap(DoneLayout.profileTop)
                    TextAction(brandString(R.string.onboarding_done_profile), { onLeave(true) })
                }
            }
        }
    }
}

/** The person's own card: the main photo, the story bars, «آرش، ۲۸» and the city on the bottom scrim. */
@Composable
private fun OwnCard(preview: java.io.File?, main: app.core.model.OwnPhoto?, count: Int, who: String, city: String?) {
    val t = AppTheme.template
    val shape = RoundedCornerShape(t.radii.card)
    Box(Modifier.fillMaxSize().raised(shape).clip(shape).background(t.colors.photoPlaceholder)) {
        when {
            preview != null -> LocalPreview(preview, Modifier.fillMaxSize())
            main?.url != null -> PhotoImage(
                photo = Photo(main.id, main.w, main.h, main.blurhash, main.url.orEmpty()),
                contentDescription = null,
                modifier = Modifier.fillMaxSize(),
            )
        }
        PhotoScrimBottom(Modifier.align(Alignment.BottomCenter).fillMaxHeight(DoneLayout.SCRIM))
        if (count > 1) {
            StoryProgress(count, current = 0, modifier = Modifier.padding(top = DoneLayout.storyTop))
        }
        Column(Modifier.align(Alignment.BottomStart).padding(horizontal = DoneLayout.whoX, vertical = DoneLayout.whoBottom)) {
            Text(who, style = t.type.h2, color = t.colors.onPhoto, maxLines = 1)
            if (city != null) Text(city, style = t.type.bodySm, color = t.colors.onPhoto2, maxLines = 1)
        }
    }
}

private object DoneLayout {
    /** Under the 32 dp status bar: the card at 92 dp from the top. */
    val cardTop = 60.dp
    val cardHeight = 400.dp
    val cardMin = 200.dp
    const val CARD_ASPECT = 0.7f
    const val SCRIM = 0.5f
    val storyTop = 12.dp
    val whoX = 18.dp
    val whoBottom = 16.dp
    val titleTop = 38.dp
    /** Air between the title's last line and the buttons, when the card has to give way. */
    val titleAir = 24.dp
    val profileTop = 8.dp
    val dockBottom = 30.dp
}
