package app.core.ui.icons

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/**
 * The app's one drawn icon set: 24 dp, 1.8 dp line, round caps and joins,
 * with filled variants for the active tabs and the like heart. Drawn here,
 * not taken from an icon font, and never an emoji. Icons that point along
 * the reading direction (back, forward, chevrons) mirror in right-to-left
 * layouts; the rewind arrow (↶) never does.
 *
 * Paths are plain SVG path data on a 24 × 24 grid.
 */
object AppIcons {

    private class Spec(val d: String, val fill: Boolean)

    private fun line(d: String) = Spec(d, fill = false)
    private fun solid(d: String) = Spec(d, fill = true)

    /** A circle as path data. */
    private fun circle(cx: Float, cy: Float, r: Float): String =
        "M${cx - r},${cy}a$r,$r 0 1,0 ${2 * r},0a$r,$r 0 1,0 ${-2 * r},0z"

    private fun mirrored(name: String, vararg parts: Spec): ImageVector = build(name, true, parts)

    private fun icon(name: String, vararg parts: Spec): ImageVector = build(name, false, parts)

    private fun build(name: String, mirror: Boolean, parts: Array<out Spec>): ImageVector {
        val builder = ImageVector.Builder(
            name = name,
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f,
            autoMirror = mirror,
        )
        for (part in parts) {
            if (part.fill) {
                builder.addPath(pathData = addPathNodes(part.d), fill = SolidColor(Color.Black))
            } else {
                builder.addPath(
                    pathData = addPathNodes(part.d),
                    stroke = SolidColor(Color.Black),
                    strokeLineWidth = 1.8f,
                    strokeLineCap = StrokeCap.Round,
                    strokeLineJoin = StrokeJoin.Round,
                )
            }
        }
        return builder.build()
    }

    private const val HEART =
        "M12,20.2c0,0 -7.6,-4.4 -9.3,-9.3C1.5,7.4 3.8,4.3 7.2,4.3c2,0 3.5,1.1 4.8,2.9c1.3,-1.8 2.8,-2.9 4.8,-2.9c3.4,0 5.7,3.1 4.5,6.6c-1.7,4.9 -9.3,9.3 -9.3,9.3z"
    private const val STAR =
        "M12,2.9l2.8,5.7l6.3,0.9l-4.6,4.4l1.1,6.3L12,17.2l-5.6,3l1.1,-6.3L2.9,9.5l6.3,-0.9z"
    private const val SHIELD = "M12,3l7,2.8v5.4c0,4.4 -2.9,7.9 -7,9.8c-4.1,-1.9 -7,-5.4 -7,-9.8V5.8z"

    // Direction.
    val Back: ImageVector by lazy { mirrored("back", line("M19,12H5"), line("M11,6l-6,6l6,6")) }
    val Forward: ImageVector by lazy { mirrored("forward", line("M5,12h14"), line("M13,6l6,6l-6,6")) }
    val ChevronEnd: ImageVector by lazy { mirrored("chevronEnd", line("M9.5,6l6,6l-6,6")) }
    val ChevronDown: ImageVector by lazy { icon("chevronDown", line("M6,9.5l6,6l6,-6")) }
    val ChevronUp: ImageVector by lazy { icon("chevronUp", line("M6,14.5l6,-6l6,6")) }

    /** ↶, the same glyph everywhere (deck, paywall, sheets), never mirrored. */
    val Rewind: ImageVector by lazy {
        icon("rewind", line("M9,14.5L4,9.5l5,-5"), line("M4,9.5h10.5a5.5,5.5 0 0,1 0,11H11"))
    }

    // Actions.
    val Close: ImageVector by lazy { icon("close", line("M6,6l12,12"), line("M18,6L6,18")) }
    val Check: ImageVector by lazy { icon("check", line("M5,12.5l4.5,4.5L19,7.5")) }
    val Plus: ImageVector by lazy { icon("plus", line("M12,5v14"), line("M5,12h14")) }
    val Search: ImageVector by lazy { icon("search", line(circle(11f, 11f, 7f)), line("M20,20l-3.8,-3.8")) }
    val Pencil: ImageVector by lazy { icon("pencil", line("M14.5,5.5l4,4L8,20H4v-4z"), line("M12.5,7.5l4,4")) }
    val Send: ImageVector by lazy { mirrored("send", line("M4.5,12L20,4.5L15.5,20l-3,-6.5z"), line("M12.5,13.5L20,4.5")) }

    /** Three solid dots. */
    val More: ImageVector by lazy {
        icon("more", solid(circle(5f, 12f, 2f)), solid(circle(12f, 12f, 2f)), solid(circle(19f, 12f, 2f)))
    }
    val Tune: ImageVector by lazy {
        icon("tune", line("M4,7h9"), line("M19,7h1"), line(circle(16f, 7f, 2.5f)), line("M4,17h1"), line("M11,17h9"), line(circle(8f, 17f, 2.5f)))
    }

    // Swipe.
    val Heart: ImageVector by lazy { icon("heart", solid(HEART)) }
    val HeartLine: ImageVector by lazy { icon("heartLine", line(HEART)) }
    val Star: ImageVector by lazy { icon("star", solid(STAR)) }
    val StarLine: ImageVector by lazy { icon("starLine", line(STAR)) }
    val Bolt: ImageVector by lazy { icon("bolt", solid("M13.5,2.5L5,13.5h6.5l-1,8L19,10.5h-6.5z")) }

    // Tabs: line when idle, solid when selected.
    val Discover: ImageVector by lazy {
        icon("discover", line("M7,6h9a2,2 0 0,1 2,2v11a2,2 0 0,1 -2,2H7a2,2 0 0,1 -2,-2V8a2,2 0 0,1 2,-2z"), line("M9,3h8.5a2.5,2.5 0 0,1 2.5,2.5V16"))
    }
    val DiscoverSolid: ImageVector by lazy {
        icon("discoverSolid", solid("M7,6h9a2,2 0 0,1 2,2v11a2,2 0 0,1 -2,2H7a2,2 0 0,1 -2,-2V8a2,2 0 0,1 2,-2z"), line("M9,3h8.5a2.5,2.5 0 0,1 2.5,2.5V16"))
    }
    val Chat: ImageVector by lazy {
        mirrored("chat", line("M4,6.5a2.5,2.5 0 0,1 2.5,-2.5h11a2.5,2.5 0 0,1 2.5,2.5v8a2.5,2.5 0 0,1 -2.5,2.5H10l-4.5,3.5V17A2.5,2.5 0 0,1 4,14.5z"))
    }
    val ChatSolid: ImageVector by lazy {
        mirrored("chatSolid", solid("M4,6.5a2.5,2.5 0 0,1 2.5,-2.5h11a2.5,2.5 0 0,1 2.5,2.5v8a2.5,2.5 0 0,1 -2.5,2.5H10l-4.5,3.5V17A2.5,2.5 0 0,1 4,14.5z"))
    }
    val Profile: ImageVector by lazy { icon("profile", line(circle(12f, 8f, 4f)), line("M4.5,20.5c0.8,-3.8 3.9,-6 7.5,-6s6.7,2.2 7.5,6")) }
    val ProfileSolid: ImageVector by lazy { icon("profileSolid", solid(circle(12f, 8f, 4.6f)), solid("M3.8,21c0.6,-4.4 4,-7.2 8.2,-7.2s7.6,2.8 8.2,7.2z")) }

    /** The person silhouette that stands in for a missing photo (never initials). */
    val Person: ImageVector by lazy { icon("person", solid(circle(12f, 8.6f, 4.3f)), solid("M3.5,21c0.5,-4.5 4.1,-7.6 8.5,-7.6s8,3.1 8.5,7.6z")) }

    // Media and calls.
    val Camera: ImageVector by lazy { icon("camera", line("M4.5,8h3l2,-3h5l2,3h3a1.5,1.5 0 0,1 1.5,1.5v9a1.5,1.5 0 0,1 -1.5,1.5h-15A1.5,1.5 0 0,1 3,18.5v-9A1.5,1.5 0 0,1 4.5,8z"), line(circle(12f, 13.5f, 3.5f))) }
    val Phone: ImageVector by lazy { icon("phone", line("M5,4h3.5l1.5,4l-2,1.5a12,12 0 0,0 6.5,6.5l1.5,-2l4,1.5V19a2,2 0 0,1 -2,2A16,16 0 0,1 3,6a2,2 0 0,1 2,-2z")) }
    val Video: ImageVector by lazy { icon("video", line("M5,6.5h8a2,2 0 0,1 2,2v7a2,2 0 0,1 -2,2H5a2,2 0 0,1 -2,-2v-7a2,2 0 0,1 2,-2z"), line("M15,10.5l6,-3.5v10l-6,-3.5")) }

    // Safety and trust.
    val Shield: ImageVector by lazy { icon("shield", line(SHIELD), line("M9,12l2,2l4,-4")) }
    val ShieldAlert: ImageVector by lazy { icon("shieldAlert", line(SHIELD), line("M12,8v4.5"), line("M12,16v0.01")) }
    val Lock: ImageVector by lazy { icon("lock", line("M7,10.5h10a1.5,1.5 0 0,1 1.5,1.5v7a1.5,1.5 0 0,1 -1.5,1.5H7A1.5,1.5 0 0,1 5.5,19v-7A1.5,1.5 0 0,1 7,10.5z"), line("M8.5,10.5V8a3.5,3.5 0 0,1 7,0v2.5")) }
    val Eye: ImageVector by lazy { icon("eye", line("M2.5,12c0,0 3.5,-6.5 9.5,-6.5s9.5,6.5 9.5,6.5s-3.5,6.5 -9.5,6.5S2.5,12 2.5,12z"), line(circle(12f, 12f, 3f))) }
    val Mail: ImageVector by lazy { icon("mail", line("M5,6h14a1.5,1.5 0 0,1 1.5,1.5v9A1.5,1.5 0 0,1 19,18H5a1.5,1.5 0 0,1 -1.5,-1.5v-9A1.5,1.5 0 0,1 5,6z"), line("M4,7.5l8,5.5l8,-5.5")) }
    val Clock: ImageVector by lazy { icon("clock", line(circle(12f, 12f, 8.5f)), line("M12,7.5V12l3,2")) }
    val Globe: ImageVector by lazy { icon("globe", line(circle(12f, 12f, 8.5f)), line("M3.5,12h17"), line("M12,3.5c2.3,2.4 3.5,5.2 3.5,8.5s-1.2,6.1 -3.5,8.5c-2.3,-2.4 -3.5,-5.2 -3.5,-8.5S9.7,5.9 12,3.5z")) }
    val Bell: ImageVector by lazy { icon("bell", line("M6,16.5V11a6,6 0 0,1 12,0v5.5l1.5,1.5h-15z"), line("M10,20.5a2,2 0 0,0 4,0")) }
    val WifiOff: ImageVector by lazy { icon("wifiOff", line("M5,12.5a10,10 0 0,1 4,-2.3"), line("M14.5,10.2a10,10 0 0,1 4.5,2.3"), line("M8.5,16a5,5 0 0,1 7,0"), line("M12,19.5v0.01"), line("M4,4l16,16")) }
    val Pin: ImageVector by lazy { icon("pin", line("M12,21c0,0 -6.5,-5.6 -6.5,-11a6.5,6.5 0 0,1 13,0c0,5.4 -6.5,11 -6.5,11z"), line(circle(12f, 10f, 2.3f))) }

    // Facts and interests.
    val Height: ImageVector by lazy { icon("height", line("M12,3.5v17"), line("M8.5,7l3.5,-3.5L15.5,7"), line("M8.5,17l3.5,3.5l3.5,-3.5")) }
    val Education: ImageVector by lazy { icon("education", line("M2.5,9.5L12,5l9.5,4.5L12,14z"), line("M6.5,11.5v4c1.5,1.4 3.5,2.2 5.5,2.2s4,-0.8 5.5,-2.2v-4"), line("M21.5,9.5v5")) }
    val Libra: ImageVector by lazy { icon("libra", line("M4,19h16"), line("M4,15h4.3a3.7,3.7 0 1,1 7.4,0H20")) }
    val Paw: ImageVector by lazy {
        icon(
            "paw",
            line("M12,12.5c-2.7,0 -5,2.3 -5,4.4c0,1.4 1.1,2.3 2.5,2.3c1,0 1.6,-0.5 2.5,-0.5s1.5,0.5 2.5,0.5c1.4,0 2.5,-0.9 2.5,-2.3c0,-2.1 -2.3,-4.4 -5,-4.4z"),
            line(circle(6.5f, 10f, 1.6f)), line(circle(9.7f, 6.3f, 1.7f)), line(circle(14.3f, 6.3f, 1.7f)), line(circle(17.5f, 10f, 1.6f)),
        )
    }
    val NoSmoking: ImageVector by lazy { icon("noSmoking", line("M3.5,14h11v3.5h-11z"), line("M17.5,14v3.5"), line("M20.5,14v3.5"), line("M4,5l16,15")) }
    val Book: ImageVector by lazy { icon("book", line("M12,6.5C10.5,5 8,4.5 4,4.5v14c4,0 6.5,0.5 8,2c1.5,-1.5 4,-2 8,-2v-14c-4,0 -6.5,0.5 -8,2z"), line("M12,6.5v14")) }
    val Film: ImageVector by lazy { icon("film", line("M5,4h14a1,1 0 0,1 1,1v14a1,1 0 0,1 -1,1H5a1,1 0 0,1 -1,-1V5a1,1 0 0,1 1,-1z"), line("M8,4v16"), line("M16,4v16"), line("M4,9h4"), line("M4,15h4"), line("M16,9h4"), line("M16,15h4")) }
    val Compass: ImageVector by lazy { icon("compass", line(circle(12f, 12f, 8.5f)), line("M15.5,8.5l-2,5l-5,2l2,-5z")) }
    val Crown: ImageVector by lazy { icon("crown", line("M4,8l4,4l4,-6l4,6l4,-4l-1.5,10h-13z")) }
    val Quote: ImageVector by lazy {
        icon(
            "quote",
            solid("M4,17.5v-5c0,-3.4 1.8,-5.8 4.9,-6.8l0.7,1.6C7.7,8.2 6.9,9.6 6.8,11.2H9.5v6.3z"),
            solid("M13.5,17.5v-5c0,-3.4 1.8,-5.8 4.9,-6.8l0.7,1.6c-1.9,0.9 -2.7,2.3 -2.8,3.9H19v6.3z"),
        )
    }

    /** Four-point sparkle: shared interests, and any benefit the app has no icon for. */
    val Sparkle: ImageVector by lazy {
        icon("sparkle", line("M11,3.5l1.7,4.8l4.8,1.7l-4.8,1.7L11,16.5l-1.7,-4.8L4.5,10l4.8,-1.7z"), line("M18.5,14.5l0.8,2.2l2.2,0.8l-2.2,0.8l-0.8,2.2l-0.8,-2.2l-2.2,-0.8l2.2,-0.8z"))
    }
}
