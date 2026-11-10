package app.core.ui.components

import android.graphics.Bitmap
import android.graphics.BitmapShader
import android.graphics.Matrix
import android.graphics.Shader
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.ShaderBrush
import androidx.compose.ui.platform.LocalDensity
import app.core.ui.theme.AppTheme
import kotlin.random.Random

/**
 * Film grain over what is drawn (`--grain-opacity`: neon's welcome and done
 * screens; nothing where the template's opacity is 0): white specks of
 * random strength, one per dp, tiled every [GRAIN_TILE] dp and laid over
 * the content with the overlay blend.
 */
@Composable
fun Modifier.filmGrain(): Modifier {
    val opacity = AppTheme.template.grainOpacity
    if (opacity <= 0f) return this
    val density = LocalDensity.current.density
    return drawWithCache {
        val shader = BitmapShader(GrainTile.bitmap, Shader.TileMode.REPEAT, Shader.TileMode.REPEAT).apply {
            setLocalMatrix(Matrix().apply { setScale(density, density) })
        }
        val brush = ShaderBrush(shader)
        onDrawWithContent {
            drawContent()
            drawRect(brush, alpha = opacity, blendMode = BlendMode.Overlay)
        }
    }
}

/** The tile's side in dp (and in pixels before scaling: one speck per dp). */
private const val GRAIN_TILE = 180

/** The strongest speck's alpha, as the design's noise filter has it. */
private const val GRAIN_MAX_ALPHA = 0.6f

private object GrainTile {
    /** Made once per process: a fixed seed, so every screen shows the same grain. */
    val bitmap: Bitmap by lazy {
        val random = Random(GRAIN_SEED)
        val pixels = IntArray(GRAIN_TILE * GRAIN_TILE) {
            val alpha = (random.nextFloat() * GRAIN_MAX_ALPHA * 255).toInt()
            (alpha shl 24) or 0x00FFFFFF
        }
        Bitmap.createBitmap(pixels, GRAIN_TILE, GRAIN_TILE, Bitmap.Config.ARGB_8888)
    }

    private const val GRAIN_SEED = 0x6A1F
}
