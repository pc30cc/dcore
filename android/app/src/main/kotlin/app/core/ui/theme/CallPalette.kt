package app.core.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * The call surfaces' own colours: the full call screen, the bubble over the
 * app, the picture-in-picture window and the audio-route list. Calls are
 * photographic and look the same in every template (the design's "calls"
 * group), always opaque and dark, so nothing behind a call (a chat, the lock
 * screen's wallpaper) shows through; the buttons and scrims on them are the
 * template's `--call-*` tokens.
 */
object CallPalette {
    /** The call's own near-black. */
    val stage: Color = Color(0xFF0B0A0D)

    /** The bottom of the backdrop. */
    val backdropBottom: Color = Color(0xFF050407)

    /** The card behind a picture that has not arrived (and the route list), a step up from the stage. */
    val tile: Color = Color(0xFF1E1B21)

    /** The tone the backdrop is deepened from and the glow where the face is: the brand's dark accent, the same in every template. */
    val backdropTint: Color get() = BrandColors.Build.brandDark
}
