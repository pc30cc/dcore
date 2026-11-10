package app.core.ui.theme

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.Dp

// The template contract, one class per kind of token. Every template defines
// every token (the constructors have no defaults), so a template that misses
// one does not compile. Property names are the CSS names in camel case,
// without the `--r-` (radii), `--type-` (type) and `--switch-` (switches)
// prefixes: `--surface-1` is `colors.surface1`, `--r-card` is `radii.card`,
// `--type-h1` is `type.h1`.

/** Every colour token of the template contract (`--name` → `name` in camel case). */
@Immutable
data class TemplateColors(
    /** `--bg`: page */
    val bg: Color,
    /** `--surface-1`: cards, fields, list groups */
    val surface1: Color,
    /** `--surface-2`: segmented track, pills, clear button */
    val surface2: Color,
    /** `--surface-3`: switch track off, disabled, empty avatar */
    val surface3: Color,
    /** `--surface-sheet`: bottom sheet */
    val surfaceSheet: Color,
    /** `--surface-dialog`: dialog */
    val surfaceDialog: Color,
    /** `--surface-bar`: opaque app bar on pushed screens */
    val surfaceBar: Color,
    /** `--surface-field`: text field, OTP cell */
    val surfaceField: Color,
    /** `--surface-empty`: empty photo slot */
    val surfaceEmpty: Color,
    /** `--surface-option`: choice rows at rest */
    val surfaceOption: Color,
    /** `--text` */
    val text: Color,
    /** `--text-2` */
    val text2: Color,
    /** `--text-3` */
    val text3: Color,
    /** `--line`: hairline */
    val line: Color,
    /** `--line-strong`: outlined controls */
    val lineStrong: Color,
    /** `--outline`: radio, checkbox ring at rest */
    val outline: Color,
    /** `--primary`: accent text and icons on --bg (light centre of the gradient) */
    val primary: Color,
    /** `--on-primary` */
    val onPrimary: Color,
    /** `--primary-tint`: selected fill (over --surface-1), shared interests, tint pills */
    val primaryTint: Color,
    /** `--caret` */
    val caret: Color,
    /** `--seg-thumb`: selected segment */
    val segThumb: Color,
    /** `--on-seg-thumb` */
    val onSegThumb: Color,
    /** `--on-tag` */
    val onTag: Color,
    /** `--online`: online dot: plain green */
    val online: Color,
    /** `--online-text`: the word "online" */
    val onlineText: Color,
    /** `--act-fill`: rewind, pass, super, boost */
    val actFill: Color,
    /** `--act-line` */
    val actLine: Color,
    /** `--act-icon` */
    val actIcon: Color,
    /** `--on-like` */
    val onLike: Color,
    /** `--super-icon` */
    val superIcon: Color,
    /** `--super-fill` */
    val superFill: Color,
    /** `--super-line` */
    val superLine: Color,
    /** `--boost-icon` */
    val boostIcon: Color,
    /** `--like`: heart on a prompt, new-message dot on the tab */
    val like: Color,
    /** `--on-unread` */
    val onUnread: Color,
    /** `--on-verified` */
    val onVerified: Color,
    /** `--error` */
    val error: Color,
    /** `--error-tint` */
    val errorTint: Color,
    /** `--call-end` */
    val callEnd: Color,
    /** `--on-call-end` */
    val onCallEnd: Color,
    /** `--on-call-accept` */
    val onCallAccept: Color,
    /** `--inverse`: snackbar */
    val inverse: Color,
    /** `--on-inverse` */
    val onInverse: Color,
    /** `--inverse-action` */
    val inverseAction: Color,
    /** `--scrim`: behind sheets and dialogs */
    val scrim: Color,
    /** `--call-btn-fill`: secondary call button at rest */
    val callBtnFill: Color,
    /** `--call-btn-line` */
    val callBtnLine: Color,
    /** `--on-call-btn` */
    val onCallBtn: Color,
    /** `--call-btn-on-fill`: toggled (mic off, camera off) */
    val callBtnOnFill: Color,
    /** `--on-call-btn-on` */
    val onCallBtnOn: Color,
    /** `--on-photo` */
    val onPhoto: Color,
    /** `--on-photo-2` */
    val onPhoto2: Color,
    /** `--photo-chip-fill`: 4.6:1 for white text even over a white pixel */
    val photoChipFill: Color,
    /** `--photo-chip-line` */
    val photoChipLine: Color,
    /** `--note-fill`: like note on a likes tile sits on its own chip */
    val noteFill: Color,
    /** `--story-fill` */
    val storyFill: Color,
    /** `--story-track` */
    val storyTrack: Color,
    /** `--story-edge` */
    val storyEdge: Color,
    /** `--photo-placeholder` */
    val photoPlaceholder: Color,
    /** `--glass-fill`: header buttons on photos */
    val glassFill: Color,
    /** `--glass-line` */
    val glassLine: Color,
    /** `--on-glass` */
    val onGlass: Color,
    /** `--glass-solid`: used instead when glass is off */
    val glassSolid: Color,
    /** `--tabbar-fill`: over lists */
    val tabbarFill: Color,
    /** `--tabbar-fill-photo`: over the deck photo */
    val tabbarFillPhoto: Color,
    /** `--tabbar-line` */
    val tabbarLine: Color,
    /** `--tab-color` */
    val tabColor: Color,
    /** `--tab-color-photo` */
    val tabColorPhoto: Color,
    /** `--tab-active-color` */
    val tabActiveColor: Color,
    /** `--tab-active-color-photo` */
    val tabActiveColorPhoto: Color,
    /** `--tab-active-fill` */
    val tabActiveFill: Color,
    /** `--tab-active-fill-photo` */
    val tabActiveFillPhoto: Color,
    /** `--on-badge` */
    val onBadge: Color,
    /** `--badge-ring` */
    val badgeRing: Color,
    /** `--tile-empty-line`: dashed edge of an empty photo slot */
    val tileEmptyLine: Color,
    /** `--crop-line`: crop frame edge */
    val cropLine: Color,
    /** `--switch-off` */
    val switchOff: Color,
    /** `--switch-off-ring` */
    val switchOffRing: Color,
    /** `--switch-thumb` */
    val switchThumb: Color,
    /** `--slider-track` */
    val sliderTrack: Color,
    /** `--slider-thumb` */
    val sliderThumb: Color,
    /** `--progress-track` */
    val progressTrack: Color,
    /** `--bubble-in` */
    val bubbleIn: Color,
    /** `--on-bubble-in` */
    val onBubbleIn: Color,
    /** `--on-bubble-out` */
    val onBubbleOut: Color,
    /** `--on-bubble-out-2`: time and read state over the outgoing bubble */
    val onBubbleOut2: Color,
    /** `--bubble-quote`: quoted prompt inside a bubble */
    val bubbleQuote: Color,
    /** `--wave`: voice prompt waveform on the profile */
    val wave: Color,
    /** `--mark-a1` */
    val markA1: Color,
    /** `--mark-a2` */
    val markA2: Color,
    /** `--mark-b1` */
    val markB1: Color,
    /** `--mark-b2` */
    val markB2: Color,
    /** `--mark-lens` */
    val markLens: Color,
    /** `--icon-grad-1` */
    val iconGrad1: Color,
    /** `--icon-grad-2` */
    val iconGrad2: Color,
    /** `--icon-grad-3` */
    val iconGrad3: Color,
    /** `--kb-bg` */
    val kbBg: Color,
    /** `--kb-key` */
    val kbKey: Color,
    /** `--kb-fn` */
    val kbFn: Color,
    /** `--kb-on` */
    val kbOn: Color,
    /** `--kb-act` */
    val kbAct: Color,
    /** `--kb-on-act` */
    val kbOnAct: Color,
    /** `--kb-sug` */
    val kbSug: Color,
    /** `--skeleton` */
    val skeleton: Color,
    /** `--skeleton-hi` */
    val skeletonHi: Color,
    /** `--status-color` */
    val statusColor: Color,
    /** `--gesture-bar` */
    val gestureBar: Color,
    /** `--flag-green` */
    val flagGreen: Color,
    /** `--flag-white` */
    val flagWhite: Color,
    /** `--flag-red` */
    val flagRed: Color,
)

/** Every paint, image and svgpaint token: a [SolidColor] or a gradient [Brush]. CSS angles are physical: they do not mirror in a right-to-left layout. */
@Immutable
data class TemplatePaints(
    /** `--primary-fill`: primary button, radio/checkbox on, send */
    val primaryFill: Brush,
    /** `--primary-ring`: selected ring (2px), focus border */
    val primaryRing: Brush,
    /** `--accent-text`: one highlighted word in a display title */
    val accentText: Brush,
    /** `--tag-fill` */
    val tagFill: Brush,
    /** `--like-fill` */
    val likeFill: Brush,
    /** `--unread-fill`: unread count */
    val unreadFill: Brush,
    /** `--ring-fill`: ring around a featured avatar */
    val ringFill: Brush,
    /** `--verified`: verified badge: the gradient */
    val verified: Brush,
    /** `--call-accept` */
    val callAccept: Brush,
    /** `--call-scrim-top`: 170dp under the name and timer */
    val callScrimTop: Brush,
    /** `--photo-scrim-top` */
    val photoScrimTop: Brush,
    /** `--photo-scrim-bottom` */
    val photoScrimBottom: Brush,
    /** `--tab-active-icon`: active tab icon */
    val tabActiveIcon: Brush,
    /** `--badge-fill`: tab badge */
    val badgeFill: Brush,
    /** `--hero-bg` */
    val heroBg: Brush,
    /** `--hero-bg-strong` */
    val heroBgStrong: Brush,
    /** `--seam`: match split line */
    val seam: Brush,
    /** `--match-fade`: bleed match photos into the page */
    val matchFade: Brush,
    /** `--header-fade`: bleed own-profile photo into the page */
    val headerFade: Brush,
    /** `--match-scrim-top`: 120dp: status bar over the match photos */
    val matchScrimTop: Brush,
    /** `--quote-bar`: pull-quote bar */
    val quoteBar: Brush,
    /** `--switch-on` */
    val switchOn: Brush,
    /** `--slider-fill` */
    val sliderFill: Brush,
    /** `--progress-fill` */
    val progressFill: Brush,
    /** `--bubble-out` */
    val bubbleOut: Brush,
)

/** Every shadow token as a list of layers; an empty list is "none" (`0 0 transparent`). */
@Immutable
data class TemplateShadows(
    /** `--seg-shadow`: lift of the selected segment */
    val segShadow: List<ShadowLayer>,
    /** `--act-shadow` */
    val actShadow: List<ShadowLayer>,
    /** `--photo-text-shadow`: text on live video */
    val photoTextShadow: List<ShadowLayer>,
    /** `--glass-shadow` */
    val glassShadow: List<ShadowLayer>,
    /** `--tabbar-shadow` */
    val tabbarShadow: List<ShadowLayer>,
    /** `--tab-indicator` */
    val tabIndicator: List<ShadowLayer>,
    /** `--card-shadow`: cards, groups */
    val cardShadow: List<ShadowLayer>,
    /** `--raised-shadow` */
    val raisedShadow: List<ShadowLayer>,
    /** `--sheet-shadow` */
    val sheetShadow: List<ShadowLayer>,
    /** `--float-shadow`: floating photos, toasts */
    val floatShadow: List<ShadowLayer>,
    /** `--glow-like`: the one glow: deck like button */
    val glowLike: List<ShadowLayer>,
    /** `--btn-highlight` */
    val btnHighlight: List<ShadowLayer>,
    /** `--field-line`: resting field border */
    val fieldLine: List<ShadowLayer>,
    /** `--otp-filled`: added to a filled OTP cell */
    val otpFilled: List<ShadowLayer>,
    /** `--slider-thumb-shadow` */
    val sliderThumbShadow: List<ShadowLayer>,
    /** `--kb-key-shadow` */
    val kbKeyShadow: List<ShadowLayer>,
)

/** The `--r-*` corner radii (`999` reads as a full pill). */
@Immutable
data class TemplateRadii(
    /** `--r-xs` */
    val xs: Dp,
    /** `--r-sm` */
    val sm: Dp,
    /** `--r-md` */
    val md: Dp,
    /** `--r-lg` */
    val lg: Dp,
    /** `--r-xl` */
    val xl: Dp,
    /** `--r-button` */
    val button: Dp,
    /** `--r-chip` */
    val chip: Dp,
    /** `--r-field` */
    val field: Dp,
    /** `--r-card` */
    val card: Dp,
    /** `--r-tile`: photo tiles */
    val tile: Dp,
    /** `--r-option`: choice rows, period rows */
    val option: Dp,
    /** `--r-sheet` */
    val sheet: Dp,
    /** `--r-dialog` */
    val dialog: Dp,
    /** `--r-bubble` */
    val bubble: Dp,
    /** `--r-bubble-tail` */
    val bubbleTail: Dp,
    /** `--r-photo`: deck and profile photo (card mode rounds it) */
    val photo: Dp,
    /** `--r-icon-btn` */
    val iconBtn: Dp,
    /** `--r-avatar-tile`: new-match tiles */
    val avatarTile: Dp,
    /** `--r-check`: checkbox */
    val check: Dp,
    /** `--r-key`: keyboard keys */
    val key: Dp,
    /** `--r-flag` */
    val flag: Dp,
)

/** The remaining dp tokens. */
@Immutable
data class TemplateSizes(
    /** `--call-blur`: blur behind the call buttons */
    val callBlur: Dp,
    /** `--note-pad` */
    val notePad: PaddingValues,
    /** `--note-r` */
    val noteR: Dp,
    /** `--glass-blur`: 0px when --switch-glass is off */
    val glassBlur: Dp,
    /** `--tabbar-inset`: side inset (0 when docked) */
    val tabbarInset: Dp,
    /** `--tabbar-bottom`: gap to the screen bottom (0 when docked) */
    val tabbarBottom: Dp,
    /** `--tabbar-h`: bar height without the gesture area */
    val tabbarH: Dp,
    /** `--tabbar-safe`: gesture area added inside a docked bar */
    val tabbarSafe: Dp,
    /** `--tabbar-r` */
    val tabbarR: Dp,
    /** `--tabbar-pad` */
    val tabbarPad: Dp,
    /** `--tabbar-blur` */
    val tabbarBlur: Dp,
    /** `--tab-r` */
    val tabR: Dp,
    /** `--button-h` */
    val buttonH: Dp,
)

/** The type tokens: the two families and every role as a [TextStyle] (weight, size, line height). The styles carry [fontFa]; `AppTemplate.inScript` swaps in [fontLat] for Latin screens. */
@Immutable
data class TemplateType(
    /** `--font-fa`: Persian UI */
    val fontFa: FontFamily,
    /** `--font-lat`: Latin in en/tr */
    val fontLat: FontFamily,
    /** `--type-display`: welcome and match title */
    val display: TextStyle,
    /** `--type-h1`: screen title; name under a card photo */
    val h1: TextStyle,
    /** `--type-h2`: sheet / card title */
    val h2: TextStyle,
    /** `--type-h3`: app bar title, option title, prices */
    val h3: TextStyle,
    /** `--type-name-photo`: name over a photo */
    val namePhoto: TextStyle,
    /** `--type-name-photo-age` */
    val namePhotoAge: TextStyle,
    /** `--type-quote`: prompt answer */
    val quote: TextStyle,
    /** `--type-body-lg`: about text */
    val bodyLg: TextStyle,
    /** `--type-body`: body, row title */
    val body: TextStyle,
    /** `--type-body-strong` */
    val bodyStrong: TextStyle,
    /** `--type-body-sm`: supporting line, legal */
    val bodySm: TextStyle,
    /** `--type-label`: buttons */
    val label: TextStyle,
    /** `--type-label-sm`: chips, segments */
    val labelSm: TextStyle,
    /** `--type-section`: plain section labels */
    val section: TextStyle,
    /** `--type-caption`: tab labels, meta */
    val caption: TextStyle,
    /** `--type-number`: OTP cells, pack counts */
    val number: TextStyle,
    /** `--type-field`: text field value */
    val field: TextStyle,
    /** `--type-field-placeholder` */
    val fieldPlaceholder: TextStyle,
    /** `--type-link`: text buttons */
    val link: TextStyle,
    /** `--type-chip-strong` */
    val chipStrong: TextStyle,
    /** `--type-caption-strong` */
    val captionStrong: TextStyle,
    /** `--type-legal` */
    val legal: TextStyle,
    /** `--type-legal-link` */
    val legalLink: TextStyle,
    /** `--type-key`: system keypad */
    val key: TextStyle,
    /** `--type-key-sm` */
    val keySm: TextStyle,
)

/** The photo filters (blur, saturation, brightness). */
@Immutable
data class TemplateFilters(
    /** `--photo-locked-filter`: likes you cannot see yet */
    val photoLockedFilter: PhotoFilter,
    /** `--photo-backdrop-filter`: incoming call backdrop */
    val photoBackdropFilter: PhotoFilter,
)
