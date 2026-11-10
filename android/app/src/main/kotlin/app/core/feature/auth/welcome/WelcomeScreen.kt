package app.core.feature.auth.welcome

import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.absoluteOffset
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.AbsoluteAlignment
import androidx.compose.ui.Alignment
import androidx.compose.ui.BiasAlignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.core.R
import app.core.feature.auth.authDock
import app.core.feature.auth.authSideInsets
import app.core.feature.auth.authTopInsets
import app.core.i18n.LocalAppName
import app.core.i18n.brandString
import app.core.ui.components.LogoMark
import app.core.ui.components.PrimaryButton
import app.core.ui.components.SecondaryButton
import app.core.ui.components.filmGrain
import app.core.ui.theme.AppTheme
import app.core.ui.theme.HeroStyle
import app.core.ui.theme.LocalReducedMotion
import app.core.ui.theme.Motion
import app.core.ui.theme.Space
import app.core.ui.theme.outerShadow

/**
 * The welcome: one title, Sign up and Sign in, the terms line ([footer]).
 * The hero follows the template: the face orbit with the mark above it
 * (`hero = bleed`), or one photo on a hard rounded edge with the mark beside
 * the title (`hero = framed`). Both draw only the brand's pictures; without
 * any, the orbit keeps its rings with the mark in the middle and the frame is
 * left out.
 *
 * The hero takes the height the rest leaves and gives it up first: on a short
 * window (landscape, split screen, very large text) it shrinks, then goes,
 * and the page scrolls before the buttons or the terms are cut.
 */
@Composable
fun WelcomeScreen(
    pictures: WelcomeSources,
    onSignUp: () -> Unit,
    onSignIn: () -> Unit,
    enabled: Boolean,
    footer: @Composable ColumnScope.() -> Unit,
) {
    val t = AppTheme.template
    Box(Modifier.fillMaxSize().background(t.colors.bg).filmGrain()) {
        if (t.switches.glow) Box(Modifier.fillMaxSize().background(t.paints.heroBgStrong))
        BoxWithConstraints(Modifier.fillMaxSize()) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .heightIn(min = maxHeight)
                    .authTopInsets()
                    .authSideInsets(),
            ) {
                when (t.switches.hero) {
                    HeroStyle.Bleed -> {
                        BleedHero(pictures, Modifier.weight(1f).fillMaxWidth())
                        Title(Modifier.fillMaxWidth().padding(horizontal = Space.gutter))
                        Spacer(Modifier.height(Layout.titleToFootBleed))
                    }
                    HeroStyle.Framed -> {
                        Spacer(Modifier.height(Layout.photoTop))
                        FramedPhoto(pictures, Modifier.weight(1f).fillMaxWidth().padding(horizontal = Space.gutter))
                        Spacer(Modifier.height(Layout.photoToTitle))
                        Row(Modifier.fillMaxWidth().padding(horizontal = Space.gutter), verticalAlignment = Alignment.CenterVertically) {
                            Title(Modifier.weight(1f))
                            AppMark(Layout.markFramed)
                        }
                        Spacer(Modifier.height(Layout.titleToFootFramed))
                    }
                }
                Column(
                    Modifier.fillMaxWidth().padding(horizontal = Space.gutter).authDock(Layout.footBottom),
                    verticalArrangement = Arrangement.spacedBy(Layout.buttonGap),
                ) {
                    PrimaryButton(brandString(R.string.welcome_sign_up), onSignUp, enabled = enabled)
                    SecondaryButton(brandString(R.string.welcome_sign_in), onSignIn, enabled = enabled)
                    Column(Modifier.fillMaxWidth().padding(top = Layout.legalGap), horizontalAlignment = Alignment.CenterHorizontally, content = footer)
                }
            }
        }
    }
}

/** «سلام کن.»: `--type-display`, one colour, at the start. */
@Composable
private fun Title(modifier: Modifier) {
    val t = AppTheme.template
    Text(
        brandString(R.string.welcome_title),
        style = t.type.display,
        color = t.colors.text,
        modifier = modifier.semantics { heading() },
    )
}

/** The mark, which a screen reader reads as the app's name. */
@Composable
private fun AppMark(size: Dp, modifier: Modifier = Modifier) {
    LogoMark(size, modifier, contentDescription = LocalAppName.current.takeIf { it.isNotBlank() })
}

/** How the hero's art comes in: a short fade, none with reduced motion. */
@Composable
private fun <T> artSpec() = if (LocalReducedMotion.current) snap<T>() else tween<T>(Motion.MEDIUM_MS)

/**
 * `hero = bleed`: the mark, then the orbit on the design's 412 × 390 dp
 * board, scaled down (never up) to the height left, and left out below
 * [Orbit.minScale]. Without pictures the mark moves into the orbit's middle.
 */
@Composable
private fun BleedHero(pictures: WelcomeSources, modifier: Modifier) {
    val density = LocalDensity.current
    BoxWithConstraints(modifier.clipToBounds()) {
        val above = Layout.markTop + Layout.markBleed + Layout.orbitGap
        val scale = minOf(1f, maxWidth / Orbit.width, (maxHeight - above - Orbit.minGapBelow) / Orbit.height)
        val orbitShown = scale >= Orbit.minScale
        val art = rememberOrbitFaces(pictures, with(density) { Orbit.centre.roundToPx() })
        val markInOrbit = orbitShown && art == WelcomeArt.None
        val markShown = !markInOrbit && maxHeight >= above
        Column(Modifier.fillMaxWidth()) {
            Spacer(Modifier.height(Layout.markTop))
            Box(Modifier.fillMaxWidth().height(Layout.markBleed), contentAlignment = Alignment.Center) {
                if (markShown) AppMark(Layout.markBleed)
            }
            Spacer(Modifier.height(Layout.orbitGap))
            if (orbitShown) FaceOrbit(art, scale, label = LocalAppName.current.takeIf { markInOrbit && it.isNotBlank() })
        }
    }
}

/**
 * Two dashed rings, six faces around them and one in the middle in a
 * `--ring-fill` ring; without pictures, the rings and the middle ring with
 * the mark in it ([label], the app's name, is then read for it). The faces
 * say nothing to a screen reader. Positions are physical, the same in both
 * directions.
 */
@Composable
private fun FaceOrbit(art: WelcomeArt, scale: Float, label: String?) {
    val t = AppTheme.template
    // Physical placement: the board is the same in both directions.
    val described = Modifier.clearAndSetSemantics { if (label != null) contentDescription = label }
    BoxWithConstraints(Modifier.fillMaxWidth().height(Orbit.height * scale).then(described), contentAlignment = AbsoluteAlignment.TopLeft) {
        val left = (maxWidth - Orbit.width * scale) / 2
        val ring = t.colors.lineStrong.copy(alpha = t.colors.lineStrong.alpha * Orbit.ringAlpha)
        Canvas(Modifier.absoluteOffset(x = left).size(Orbit.width * scale, Orbit.height * scale)) {
            val dash = PathEffect.dashPathEffect(floatArrayOf(Orbit.dashOn.toPx(), Orbit.dashOff.toPx()))
            val centre = Offset(Orbit.centreX.toPx() * scale, Orbit.centreY.toPx() * scale)
            for (radius in Orbit.rings) {
                drawCircle(ring, radius = radius.toPx() * scale, center = centre, style = Stroke(width = Orbit.ringStroke.toPx(), pathEffect = dash))
            }
        }
        Crossfade(targetState = art, animationSpec = artSpec(), label = "orbit") { shown ->
            Box(Modifier.fillMaxSize(), contentAlignment = AbsoluteAlignment.TopLeft) {
                val faces = (shown as? WelcomeArt.Faces)?.faces
                faces?.drop(1)?.zip(Orbit.faces)?.forEach { (face, place) ->
                    val (x, y, d) = place
                    val edge = Orbit.faceEdge
                    Box(
                        Modifier
                            .absoluteOffset(x = left + (x - edge) * scale, y = (y - edge) * scale)
                            .size((d + edge * 2) * scale)
                            .outerShadow(CircleShape, t.shadows.floatShadow)
                            .background(t.colors.bg, CircleShape)
                            .padding(edge * scale),
                    ) {
                        Face(face)
                    }
                }
                if (shown != WelcomeArt.Loading) {
                    val c = Orbit.centre + Orbit.centreRing * 2
                    Box(
                        Modifier
                            .absoluteOffset(x = left + (Orbit.centreX - c / 2) * scale, y = (Orbit.centreY - c / 2) * scale)
                            .size(c * scale)
                            .background(t.paints.ringFill, CircleShape)
                            .padding((Orbit.centreRing - Orbit.centreGap) * scale)
                            .background(t.colors.bg, CircleShape)
                            .padding(Orbit.centreGap * scale),
                        contentAlignment = Alignment.Center,
                    ) {
                        val middle = faces?.firstOrNull()
                        if (middle != null) Face(middle) else LogoMark(Orbit.centreMark * scale)
                    }
                }
            }
        }
    }
}

@Composable
private fun Face(bitmap: ImageBitmap) {
    Image(bitmap, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize().clip(CircleShape))
}

/**
 * `hero = framed`: the brand's photo on `--r-photo`, no scrim and nothing on
 * it, faded in once it is ready. Without a photo large enough for the frame
 * the space stays the page's: the title row and the buttons below it.
 */
@Composable
private fun FramedPhoto(pictures: WelcomeSources, modifier: Modifier) {
    val t = AppTheme.template
    val shape = RoundedCornerShape(t.radii.photo)
    BoxWithConstraints(modifier.clearAndSetSemantics {}) {
        if (constraints.maxWidth <= 0 || maxHeight < Layout.photoMinHeight) return@BoxWithConstraints
        val art = rememberWelcomePhoto(pictures, constraints.maxWidth, constraints.maxHeight)
        Crossfade(targetState = art, animationSpec = artSpec(), label = "photo") { shown ->
            if (shown is WelcomeArt.Photo) {
                Image(shown.bitmap, contentDescription = null, contentScale = ContentScale.Crop, alignment = PhotoFocus, modifier = Modifier.fillMaxSize().clip(shape))
            }
        }
    }
}

/** The design's `background-position: 50% 28%`. */
private val PhotoFocus = BiasAlignment(0f, 0.28f * 2 - 1)

/** The welcome's layout on the design's 412 × 892 dp phone (status bar 32 dp, see [authTopInsets]). */
private object Layout {
    val markTop = 20.dp
    val markBleed = 40.dp
    val markFramed = 36.dp
    val orbitGap = 12.dp
    val titleToFootBleed = 46.dp
    val photoTop = 12.dp
    val photoToTitle = 26.dp
    val titleToFootFramed = 48.dp
    /** Shorter than this (landscape, split screen) the frame would be a strip: the photo is left out. */
    val photoMinHeight = 160.dp
    val buttonGap = 10.dp
    val legalGap = 6.dp
    val footBottom = 28.dp
}

/** The orbit's board: rings and faces as the design places them (dp, physical left/top). */
private object Orbit {
    val width = 412.dp
    val height = 390.dp
    val minGapBelow = 24.dp
    /** Below this the orbit is too small to read as faces: it is left out. */
    const val minScale = 0.35f
    const val ringAlpha = 0.7f
    val ringStroke = 1.dp
    val dashOn = 3.dp
    val dashOff = 2.5.dp
    val centreX = 206.dp
    val centreY = 190.dp
    val rings = listOf(120.dp, 188.dp)
    /** The page-colour edge around each face. */
    val faceEdge = 3.dp
    /** The middle face, its gradient ring and the page-colour gap inside the ring. */
    val centre = 136.dp
    val centreRing = 4.dp
    val centreGap = 2.5.dp
    /** The mark in the middle ring when there are no pictures. */
    val centreMark = 56.dp
    /** Left, top, diameter of the six faces around the middle, in the brand's picture order after the first. */
    val faces: List<Triple<Dp, Dp, Dp>> = listOf(
        Triple(40.dp, 34.dp, 76.dp),
        Triple(300.dp, 40.dp, 70.dp),
        Triple(10.dp, 236.dp, 64.dp),
        Triple(322.dp, 178.dp, 80.dp),
        Triple(96.dp, 318.dp, 62.dp),
        Triple(258.dp, 308.dp, 68.dp),
    )
}
