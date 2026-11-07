package app.core.feature.match

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import app.core.R
import app.core.i18n.brandString
import app.core.media.PhotoImage
import app.core.model.Photo
import app.core.model.ProfileCard
import app.core.ui.theme.AppTheme
import app.core.ui.theme.LocalReducedMotion
import app.core.ui.theme.Space
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin
import kotlin.random.Random

/** The match moment, above everything (the bottom bar included). */
@Composable
fun MatchMomentDialog(their: ProfileCard, myPhoto: Photo?, onSendMessage: () -> Unit, onDismiss: () -> Unit) {
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        MatchMoment(their, myPhoto, onSendMessage, onDismiss)
    }
}

/**
 * "It's a match": both faces fly in and meet, a heart pops between them,
 * hearts burst out behind, and the phone gives two short beats. With less
 * motion asked for, everything is simply there, and still.
 */
@Composable
fun MatchMoment(their: ProfileCard, myPhoto: Photo?, onSendMessage: () -> Unit, onDismiss: () -> Unit, modifier: Modifier = Modifier) {
    val reduced = LocalReducedMotion.current
    val haptics = LocalHapticFeedback.current
    val arrive = remember { Animatable(if (reduced) 1f else 0f) }
    val pop = remember { Animatable(if (reduced) 1f else 0f) }
    val text = remember { Animatable(if (reduced) 1f else 0f) }
    val burst = remember { Animatable(0f) }
    val particles = remember { Particles.make(Random(their.id.hashCode())) }

    LaunchedEffect(Unit) {
        haptics.performHapticFeedback(HapticFeedbackType.Confirm)
        if (reduced) return@LaunchedEffect
        launch { arrive.animateTo(1f, spring(dampingRatio = 0.62f, stiffness = 260f)) }
        delay(220)
        haptics.performHapticFeedback(HapticFeedbackType.Confirm)
        launch { pop.animateTo(1f, spring(dampingRatio = 0.38f, stiffness = 420f)) }
        launch { burst.animateTo(1f, tween(1_900, easing = LinearOutSlowInEasing)) }
        delay(120)
        text.animateTo(1f, spring(dampingRatio = 0.8f, stiffness = 300f))
    }

    val brand = MaterialTheme.colorScheme.primary
    val announcement = brandString(R.string.match_announcement, their.name)
    val glow = lerp(brand, Color.Black, 0.25f)
    val colors = listOf(brand, AppTheme.colors.like, AppTheme.colors.superLike, Color.White)

    Box(
        modifier
            .fillMaxSize()
            .background(Color(0xFF0E0B0F))
            .background(Brush.radialGradient(listOf(glow.copy(alpha = 0.85f), Color.Transparent), radius = 1_400f))
            .semantics { paneTitle = announcement },
    ) {
        if (!reduced) {
            Canvas(Modifier.fillMaxSize()) {
                val t = burst.value
                if (t <= 0f || t >= 1f) return@Canvas
                val origin = Offset(size.width / 2f, size.height * 0.36f)
                particles.forEach { p -> drawHeart(p, t, origin, colors[p.colour % colors.size]) }
            }
        }

        Column(
            Modifier
                .fillMaxSize()
                .statusBarsPadding()
                .navigationBarsPadding()
                .padding(horizontal = Space.xl, vertical = Space.xxl),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Faces(myPhoto, their.photos.firstOrNull(), arrive.value, pop.value)
            Spacer(Modifier.height(Space.xxl))
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(Space.sm),
                modifier = Modifier.graphicsLayer {
                    alpha = text.value.coerceIn(0f, 1f)
                    val s = 0.9f + 0.1f * text.value
                    scaleX = s
                    scaleY = s
                },
            ) {
                Text(
                    brandString(R.string.match_title),
                    style = MaterialTheme.typography.displayMedium.copy(fontWeight = FontWeight.Black),
                    color = Color.White,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.semantics {
                        heading()
                        liveRegion = LiveRegionMode.Assertive
                    },
                )
                Text(
                    brandString(R.string.match_body, their.name),
                    style = MaterialTheme.typography.titleMedium,
                    color = Color.White.copy(alpha = 0.88f),
                    textAlign = TextAlign.Center,
                )
            }
            Spacer(Modifier.height(Space.xxxl))
            Column(
                Modifier
                    .widthIn(max = 420.dp)
                    .fillMaxWidth()
                    .graphicsLayer { alpha = text.value.coerceIn(0f, 1f) },
                verticalArrangement = Arrangement.spacedBy(Space.sm),
            ) {
                Button(
                    onClick = onSendMessage,
                    colors = ButtonDefaults.buttonColors(containerColor = Color.White, contentColor = Color(0xFF1D1517)),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
                ) {
                    Icon(painterResource(R.drawable.ic_deck_chat), null, modifier = Modifier.size(20.dp))
                    Spacer(Modifier.size(Space.sm))
                    Text(brandString(R.string.match_send_message), style = MaterialTheme.typography.titleMedium)
                }
                TextButton(
                    onClick = onDismiss,
                    colors = ButtonDefaults.textButtonColors(contentColor = Color.White),
                    modifier = Modifier.fillMaxWidth().heightIn(min = Space.minTouch),
                ) {
                    Text(brandString(R.string.match_keep_swiping), style = MaterialTheme.typography.titleSmall)
                }
            }
        }
    }
}

/** The two faces meeting in the middle, mine from the start side, theirs from the end. */
@Composable
private fun Faces(mine: Photo?, theirs: Photo?, arrive: Float, pop: Float) {
    val size = 132.dp
    val travel = with(LocalDensity.current) { 260.dp.toPx() }
    val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
    val startSign = if (rtl) 1f else -1f
    Box(contentAlignment = Alignment.Center, modifier = Modifier.height(size + 24.dp).fillMaxWidth()) {
        // offset() follows the reading direction; the flight (translationX) is in screen pixels.
        Face(mine, size, Modifier.offset(x = -size * 0.38f).graphicsLayer {
            translationX = startSign * travel * (1f - arrive)
            rotationZ = 8f * startSign
            alpha = arrive.coerceIn(0f, 1f)
        })
        Face(theirs, size, Modifier.offset(x = size * 0.38f).graphicsLayer {
            translationX = -startSign * travel * (1f - arrive)
            rotationZ = -8f * startSign
            alpha = arrive.coerceIn(0f, 1f)
        })
        Box(
            Modifier
                .size(52.dp)
                .graphicsLayer {
                    scaleX = pop
                    scaleY = pop
                }
                .clip(CircleShape)
                .background(Color.White),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Filled.Favorite, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(28.dp))
        }
    }
}

@Composable
private fun Face(photo: Photo?, size: Dp, modifier: Modifier) {
    PhotoImage(
        photo = photo,
        contentDescription = null,
        modifier = modifier
            .size(size)
            .border(4.dp, Color.White, CircleShape)
            .padding(4.dp)
            .clip(CircleShape),
    )
}

private class Particle(val angle: Float, val speed: Float, val size: Float, val spin: Float, val colour: Int, val delay: Float)

private object Particles {
    fun make(random: Random): List<Particle> = List(30) {
        Particle(
            angle = (random.nextFloat() * 2f * PI).toFloat(),
            speed = 0.35f + random.nextFloat() * 0.65f,
            size = 10f + random.nextFloat() * 18f,
            spin = (random.nextFloat() - 0.5f) * 240f,
            colour = random.nextInt(4),
            delay = random.nextFloat() * 0.15f,
        )
    }
}

private fun DrawScope.drawHeart(p: Particle, t: Float, origin: Offset, colour: Color) {
    val local = ((t - p.delay) / (1f - p.delay)).coerceIn(0f, 1f)
    if (local <= 0f) return
    val reach = size.minDimension * 0.62f * p.speed
    val x = origin.x + cos(p.angle) * reach * local
    // Up and out, then falling a little.
    val y = origin.y + sin(p.angle) * reach * local + size.height * 0.22f * local * local
    val alpha = (1f - local) * 0.95f
    val s = p.size * density * (0.6f + 0.4f * (1f - local))
    translate(x, y) {
        rotate(p.spin * local, pivot = Offset.Zero) {
            drawPath(heartPath(s), colour.copy(alpha = alpha))
        }
    }
}

private fun heartPath(size: Float): Path = Path().apply {
    val w = size
    val h = size * 0.9f
    moveTo(0f, h * 0.35f)
    cubicTo(-w * 0.5f, -h * 0.15f, -w * 0.05f, -h * 0.55f, 0f, -h * 0.15f)
    cubicTo(w * 0.05f, -h * 0.55f, w * 0.5f, -h * 0.15f, 0f, h * 0.35f)
    close()
}
