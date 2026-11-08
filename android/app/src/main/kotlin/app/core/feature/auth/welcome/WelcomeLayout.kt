package app.core.feature.auth.welcome

import android.os.Build
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.BlurEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.toSize
import app.core.ui.theme.Radius
import java.util.Locale
import kotlin.math.roundToInt

/** What the welcome says, already in the screen's language with `{appName}` filled in. */
class WelcomeTexts(
    val eyebrow: String,
    val headline: String,
    val subtitle: String,
    val signIn: String,
    val signUp: String,
)

/**
 * The welcome: the brand's gradient with the bubbles floating in it, the
 * eyebrow, headline and subtitle at the top, and Sign in and Sign up at the
 * bottom over a line of terms ([terms]).
 *
 * With [intro], the first moment is out of focus and sharpens (a blur from
 * Android 12, a fade before it) while the opening bubble bursts. With
 * [reduced] motion there is no opening and the bubbles rest where they are.
 */
@Composable
fun WelcomeLayout(
    colors: WelcomeColors,
    texts: WelcomeTexts,
    persian: Boolean,
    language: String,
    field: BubbleField,
    art: BubbleArt,
    sceneRunning: Boolean,
    intro: Boolean,
    reduced: Boolean,
    onSignIn: () -> Unit,
    onSignUp: () -> Unit,
    enabled: Boolean,
    below: @Composable () -> Unit,
) {
    val geometry = remember { SceneGeometry() }
    val playIntro = intro && !reduced
    val focus = remember { Animatable(if (playIntro) 0f else 1f) }
    LaunchedEffect(Unit) {
        if (focus.value < 1f) focus.animateTo(1f, tween(FOCUS_MS, easing = LinearEasing))
    }
    val density = LocalDensity.current
    val blurs = remember(density) {
        Array(BLUR_LEVELS) { level ->
            if (level == 0) null else (MAX_BLUR_DP * density.density * level / (BLUR_LEVELS - 1)).let { BlurEffect(it, it, TileMode.Clamp) }
        }
    }
    val pop = rememberPopFeedback()
    val coords = remember { Coordinates() }

    Box(
        Modifier
            .fillMaxSize()
            .onGloballyPositioned {
                coords.root = it
                geometry.update(size = it.size.toSize())
                coords.refresh(geometry)
            }
            .bubbleTouch(field, geometry, enabled = sceneRunning && !reduced, onPop = pop)
            .graphicsLayer {
                val p = focus.value
                if (p >= 1f) {
                    renderEffect = null
                    alpha = 1f
                } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    val blur = 1f - smooth(p / FOCUSED_AT)
                    renderEffect = blurs[(blur * (BLUR_LEVELS - 1)).roundToInt().coerceIn(0, BLUR_LEVELS - 1)]
                } else {
                    alpha = smooth(p / 0.55f)
                }
            },
    ) {
        WelcomeScene(
            colors = colors,
            field = field,
            art = art,
            geometry = geometry,
            running = sceneRunning && !reduced,
            intro = playIntro,
            headlineInk = WelcomePalette.headlineInk(persian),
            modifier = Modifier.fillMaxSize(),
        )
        BoxWithConstraints(Modifier.fillMaxSize().safeDrawingPadding()) {
            val viewport = maxHeight
            Column(
                Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .heightIn(min = viewport)
                    .padding(horizontal = 24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Spacer(Modifier.height(28.dp))
                Column(
                    Modifier
                        .onGloballyPositioned {
                            coords.text = it
                            coords.refresh(geometry)
                        }
                        // Fades in; never moves, so what the bubbles keep clear of stays put.
                        .graphicsLayer {
                            if (!playIntro) return@graphicsLayer
                            alpha = 0.35f + 0.65f * smooth((focus.value - 0.05f) / 0.55f)
                        },
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Eyebrow(texts.eyebrow, persian, language, WelcomePalette.scrim(colors).copy(alpha = remember(colors) { WelcomePalette.eyebrowPill(colors) }))
                    Spacer(Modifier.height(14.dp))
                    HeadlineText(
                        texts.headline,
                        persian,
                        Modifier.onGloballyPositioned {
                            coords.headline = it
                            coords.refresh(geometry)
                        },
                    )
                    Spacer(Modifier.height(12.dp))
                    Text(
                        texts.subtitle,
                        style = TextStyle(
                            fontFamily = if (persian) app.core.ui.theme.Vazirmatn else null,
                            fontSize = if (persian) 14.sp else 15.sp,
                            lineHeight = if (persian) 1.75.em else 1.42.em,
                            color = WelcomePalette.Subtitle,
                            textAlign = TextAlign.Center,
                            shadow = Glow,
                        ),
                        modifier = Modifier
                            .widthIn(max = 330.dp)
                            .onGloballyPositioned {
                                coords.subtitle = it
                                coords.refresh(geometry)
                            },
                    )
                }
                // The bubbles' band.
                Spacer(Modifier.weight(1f).heightIn(min = 120.dp))
                Column(
                    Modifier
                        .fillMaxWidth()
                        .widthIn(max = 520.dp)
                        .onGloballyPositioned {
                            coords.controls = it
                            coords.refresh(geometry)
                        }
                        .padding(bottom = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    ScenePill(texts.signIn, WelcomePalette.LightPill, WelcomePalette.OnLightPill, null, enabled, onSignIn)
                    ScenePill(texts.signUp, WelcomePalette.DarkPill, WelcomePalette.OnDarkPill, BorderStroke(1.dp, Color.White.copy(alpha = 0.16f)), enabled, onSignUp)
                    below()
                }
            }
        }
    }
}

/** The text block's and the buttons' places, turned into the scene's rectangles whenever one moves. */
private class Coordinates {
    var root: LayoutCoordinates? = null
    var text: LayoutCoordinates? = null
    var controls: LayoutCoordinates? = null
    var headline: LayoutCoordinates? = null
    var subtitle: LayoutCoordinates? = null

    fun refresh(geometry: SceneGeometry) {
        val root = root?.takeIf { it.isAttached } ?: return
        fun rect(of: LayoutCoordinates?): Rect? = of?.takeIf { it.isAttached }?.let { root.localBoundingBoxOf(it, clipBounds = false) }
        geometry.update(
            text = rect(text) ?: Rect.Zero,
            controls = rect(controls),
            headline = rect(headline) ?: Rect.Zero,
            subtitle = rect(subtitle) ?: Rect.Zero,
        )
    }
}

/** The small line above the headline, letter-spaced capitals (not in Persian), on a pill of dark glass that keeps it readable on the sky. */
@Composable
private fun Eyebrow(text: String, persian: Boolean, language: String, glass: Color) {
    val pill = RoundedCornerShape(Radius.pill)
    Text(
        if (persian) text else text.uppercase(Locale.forLanguageTag(language)),
        style = TextStyle(
            fontFamily = if (persian) app.core.ui.theme.Vazirmatn else null,
            fontSize = if (persian) 13.sp else 11.sp,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = if (persian) 0.em else 0.24.em,
            color = WelcomePalette.Eyebrow,
            textAlign = TextAlign.Center,
        ),
        modifier = Modifier
            .clip(pill)
            .background(glass)
            .border(1.dp, Color.White.copy(alpha = 0.16f), pill)
            .padding(horizontal = 14.dp, vertical = 5.dp),
    )
}

/** A soft dark glow under white text on the scene. */
private val Glow = Shadow(color = Color(0x592B0A0E), offset = Offset(0f, 2f), blurRadius = 18f)

@Composable
private fun HeadlineText(source: String, persian: Boolean, modifier: Modifier) {
    val size = if (persian) 28.sp else 32.sp
    val text = remember(source, persian) {
        WelcomeType.headline(source, WelcomeType.emphasis(persian, if (persian) 33.sp else 39.sp))
    }
    Text(
        text,
        style = TextStyle(
            fontFamily = if (persian) app.core.ui.theme.Vazirmatn else null,
            fontSize = size,
            fontWeight = if (persian) FontWeight.Bold else FontWeight.SemiBold,
            lineHeight = if (persian) 1.5.em else 1.14.em,
            letterSpacing = if (persian) 0.em else (-0.01).em,
            color = WelcomePalette.Headline,
            textAlign = TextAlign.Center,
            lineBreak = LineBreak.Heading,
            shadow = Glow,
        ),
        modifier = modifier.widthIn(max = 380.dp).semantics { heading() },
    )
}

/** A full-width pill on the scene: light for Sign in, dark for Sign up. */
@Composable
private fun ScenePill(text: String, container: Color, content: Color, border: BorderStroke?, enabled: Boolean, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(Radius.pill),
        border = border,
        colors = ButtonDefaults.buttonColors(
            containerColor = container,
            contentColor = content,
            disabledContainerColor = container.copy(alpha = 0.6f),
            disabledContentColor = content.copy(alpha = 0.6f),
        ),
        contentPadding = PaddingValues(horizontal = 24.dp, vertical = 14.dp),
        modifier = Modifier.fillMaxWidth().heightIn(min = 54.dp),
    ) {
        Text(text, style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center))
    }
}

private fun smooth(x: Float): Float {
    val t = x.coerceIn(0f, 1f)
    return t * t * (3f - 2f * t)
}

/** How long the first moment takes to come into focus, and where in it the blur is gone. */
private const val FOCUS_MS = 1_100
private const val FOCUSED_AT = 0.86f
private const val MAX_BLUR_DP = 22f
private const val BLUR_LEVELS = 14
