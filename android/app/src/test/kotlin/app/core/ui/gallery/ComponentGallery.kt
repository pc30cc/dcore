package app.core.ui.gallery

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import app.core.feature.auth.welcome.GeneratedFaces
import app.core.i18n.AppLanguage
import app.core.i18n.Numerals
import app.core.ui.components.AddPhotoTile
import app.core.ui.components.AppCheckbox
import app.core.ui.components.AppIconButton
import app.core.ui.components.AppRadio
import app.core.ui.components.AppRangeSlider
import app.core.ui.components.AppSlider
import app.core.ui.components.AppSnackbar
import app.core.ui.components.AppSwitch
import app.core.ui.components.AppTabBar
import app.core.ui.components.AppTextField
import app.core.ui.components.Avatar
import app.core.ui.components.BandFlag
import app.core.ui.components.BenefitList
import app.core.ui.components.CallButton
import app.core.ui.components.CallButtonKind
import app.core.ui.components.ChatBubble
import app.core.ui.components.ChatSystemLine
import app.core.ui.components.ChipRow
import app.core.ui.components.ChoiceChip
import app.core.ui.components.ConversationRow
import app.core.ui.components.DeckActions
import app.core.ui.components.DialogCard
import app.core.ui.components.Fact
import app.core.ui.components.FactRow
import app.core.ui.components.GlassBackdrop
import app.core.ui.components.IconButtonKind
import app.core.ui.components.InterestChip
import app.core.ui.components.LogoMark
import app.core.ui.components.NameLine
import app.core.ui.components.OptionRow
import app.core.ui.components.MatchTile
import app.core.ui.components.OtpCells
import app.core.ui.components.OtpState
import app.core.ui.components.PeriodOption
import app.core.ui.components.PeriodRow
import app.core.ui.components.PersonSilhouette
import app.core.ui.components.PhoneField
import app.core.ui.components.PhotoTile
import app.core.ui.components.PhotoToast
import app.core.ui.components.Pill
import app.core.ui.components.PillKind
import app.core.ui.components.PlanCard
import app.core.ui.components.PlanOption
import app.core.ui.components.PrimaryButton
import app.core.ui.components.ProgressBar
import app.core.ui.components.PromptQuote
import app.core.ui.components.RowEnd
import app.core.ui.components.SecondaryButton
import app.core.ui.components.SectionLabel
import app.core.ui.components.SegmentedControl
import app.core.ui.components.SettingsGroup
import app.core.ui.components.SettingsRow
import app.core.ui.components.SheetBody
import app.core.ui.components.SheetGrabber
import app.core.ui.components.sheetSurface
import app.core.ui.components.StoryProgress
import app.core.ui.components.TabBadge
import app.core.ui.components.TabItem
import app.core.ui.components.TemplatePicker
import app.core.ui.components.TextAction
import app.core.ui.components.TextActionKind
import app.core.ui.components.UnreadCount
import app.core.ui.components.VerifiedBadge
import app.core.ui.components.glassSource
import app.core.ui.components.rememberGlassBackdrop
import app.core.ui.components.templateCard
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppTheme
import app.core.ui.theme.LatinFamily
import app.core.ui.theme.insetShadow
import java.io.File

/**
 * The component library on one sheet laid out like the template design's
 * component sheet (three columns, 1240 dp): every component reads the
 * template it is drawn in. Photos come from `GALLERY_PHOTOS` (a folder
 * with `photos/` and `faces/` images, outside the repository) when set,
 * else from generated faces.
 */
object ComponentGallery {

    /** The sheet's width in dp. */
    const val WIDTH = 1240

    private val photosDir: File? = System.getenv("GALLERY_PHOTOS")?.takeIf { it.isNotBlank() }?.let(::File)?.takeIf { it.isDirectory }

    private val cache = HashMap<String, ImageBitmap>()

    private fun load(folder: String, index: Int, size: Int): ImageBitmap = cache.getOrPut("$folder/$index") {
        val files = photosDir?.resolve(folder)?.listFiles { f -> f.extension.lowercase() in setOf("jpg", "jpeg", "png") }?.sortedBy { it.name }
        val file = files?.takeIf { it.isNotEmpty() }?.let { it[index % it.size] }
        val bitmap = file?.let { f ->
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(f.path, bounds)
            val sample = maxOf(1, minOf(bounds.outWidth, bounds.outHeight) / size)
            BitmapFactory.decodeFile(f.path, BitmapFactory.Options().apply { inSampleSize = sample })
        } ?: GeneratedFaces.paint(index, size)
        bitmap.asImageBitmap()
    }

    fun photo(index: Int): ImageBitmap = load("photos", index, 900)

    fun face(index: Int): ImageBitmap = load("faces", index, 200)

    /** The whole sheet in [language], in the template the theme provides. */
    @Composable
    fun Sheet(language: AppLanguage) {
        val t = AppTheme.template
        val x = Texts(language)
        Column(Modifier.width(WIDTH.dp).background(t.colors.bg).padding(start = 32.dp, end = 32.dp, top = 36.dp, bottom = 40.dp)) {
            CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
                Column(Modifier.fillMaxWidth()) {
                    Text("Components (v2)", style = TextStyle(fontFamily = LatinFamily, fontWeight = FontWeight.SemiBold, fontSize = 24.sp, lineHeight = 32.sp), color = t.colors.text)
                    Text(
                        "Every value comes from the template file. One selected treatment (ring, tint, checked radio at the start), one primary button.",
                        style = TextStyle(fontFamily = LatinFamily, fontSize = 14.sp, lineHeight = 22.sp),
                        color = t.colors.text3,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                }
            }
            Spacer(Modifier.height(26.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(22.dp)) {
                Column(Modifier.weight(1f)) {
                    Colours(x)
                    Type(x)
                    Buttons(x)
                    Deck(x)
                    Chips(x)
                }
                Column(Modifier.weight(1f)) {
                    Fields(x)
                    Selection(x)
                    Lists(x)
                    Profile(x)
                    TabBars(x)
                }
                Column(Modifier.weight(1f)) {
                    Overlays(x)
                    Paywall(x)
                    Chat(x)
                    Avatars(x)
                    Extras(x)
                }
            }
        }
    }

    @Composable
    private fun Card(title: String, content: @Composable ColumnScope.() -> Unit) {
        val t = AppTheme.template
        val shape = RoundedCornerShape(t.radii.card)
        Column(
            Modifier
                .fillMaxWidth()
                .insetShadow(shape, listOf(app.core.ui.theme.ShadowLayer(0.dp, 0.dp, 0.dp, 1.dp, t.colors.line, inset = true)))
                .padding(start = 18.dp, end = 18.dp, top = 18.dp, bottom = 20.dp),
        ) {
            CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
                Text(
                    title.uppercase(),
                    style = TextStyle(fontFamily = LatinFamily, fontWeight = FontWeight.SemiBold, fontSize = 12.sp, lineHeight = 16.sp, letterSpacing = 0.06.em),
                    color = t.colors.text3,
                    modifier = Modifier.fillMaxWidth().padding(bottom = 14.dp),
                )
            }
            Column(verticalArrangement = Arrangement.spacedBy(10.dp), content = content)
        }
        Spacer(Modifier.height(22.dp))
    }

    @Composable
    private fun Caption(text: String) {
        CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
            Text(text, style = TextStyle(fontFamily = LatinFamily, fontWeight = FontWeight.Medium, fontSize = 11.sp, lineHeight = 14.sp), color = AppTheme.template.colors.text3, modifier = Modifier.fillMaxWidth())
        }
    }

    @Composable
    private fun PhotoBox(index: Int, height: Int, backdrop: GlassBackdrop?, content: @Composable BoxScope.() -> Unit) {
        Box(Modifier.fillMaxWidth().height(height.dp).clip(RoundedCornerShape(AppTheme.template.radii.md))) {
            Image(
                photo(index),
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize().then(if (backdrop != null) Modifier.glassSource(backdrop) else Modifier),
            )
            content()
        }
    }

    private fun facePhoto(index: Int): @Composable BoxScope.() -> Unit = {
        Image(face(index), contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
    }

    private fun tilePhoto(index: Int): @Composable BoxScope.() -> Unit = {
        Image(photo(index), contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
    }

    // Column 1

    @Composable
    private fun Colours(x: Texts) {
        val t = AppTheme.template
        val c = t.colors
        val p = t.paints
        Card("Theme colours") {
            val swatches = listOf(
                "--bg" to androidx.compose.ui.graphics.SolidColor(c.bg), "--surface-1" to androidx.compose.ui.graphics.SolidColor(c.surface1),
                "--surface-2" to androidx.compose.ui.graphics.SolidColor(c.surface2), "--surface-3" to androidx.compose.ui.graphics.SolidColor(c.surface3),
                "--text" to androidx.compose.ui.graphics.SolidColor(c.text), "--text-2" to androidx.compose.ui.graphics.SolidColor(c.text2),
                "--text-3" to androidx.compose.ui.graphics.SolidColor(c.text3), "--line-strong" to androidx.compose.ui.graphics.SolidColor(c.lineStrong),
                "--primary" to androidx.compose.ui.graphics.SolidColor(c.primary), "--primary-fill" to p.primaryFill,
                "--primary-tint" to androidx.compose.ui.graphics.SolidColor(c.primaryTint), "--tag-fill" to p.tagFill,
                "--online" to androidx.compose.ui.graphics.SolidColor(c.online), "--like" to androidx.compose.ui.graphics.SolidColor(c.like),
                "--error" to androidx.compose.ui.graphics.SolidColor(c.error), "--call-end" to androidx.compose.ui.graphics.SolidColor(c.callEnd),
            )
            swatches.chunked(4).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    row.forEach { (name, fill) ->
                        Column(Modifier.weight(1f)) {
                            val shape = RoundedCornerShape(t.radii.sm)
                            Box(Modifier.fillMaxWidth().height(52.dp).clip(shape).background(fill, shape).insetShadow(shape, listOf(app.core.ui.theme.ShadowLayer(0.dp, 0.dp, 0.dp, 1.dp, c.line, inset = true))))
                            Caption(name)
                        }
                    }
                }
            }
        }
    }

    @Composable
    private fun Type(x: Texts) {
        val t = AppTheme.template
        Card("Type") {
            Column(verticalArrangement = Arrangement.spacedBy(0.dp)) {
                Text(x.sayHi, style = t.type.display, color = t.colors.text)
                Text(x.screenTitle, style = t.type.h1, color = t.colors.text)
                Text(x.cardTitle, style = t.type.h2, color = t.colors.text)
                Text(x.rowTitle, style = t.type.h3, color = t.colors.text)
                Text(x.aboutLarge, style = t.type.bodyLg, color = t.colors.text)
                Text(x.body, style = t.type.body, color = t.colors.text)
                Text(x.helper, style = t.type.bodySm, color = t.colors.text2)
                Text(x.small, style = t.type.caption, color = t.colors.text3)
            }
        }
    }

    @OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
    @Composable
    private fun Buttons(x: Texts) {
        Card("Buttons") {
            PrimaryButton(x.continueLabel, {})
            SecondaryButton(x.signIn, {})
            SecondaryButton(x.deleteAccount, {}, destructive = true)
            PrimaryButton(x.continueLabel, {}, enabled = false)
            androidx.compose.foundation.layout.FlowRow(verticalArrangement = Arrangement.spacedBy(10.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                PrimaryButton(x.editProfile, {}, small = true)
                SecondaryButton(x.preview, {}, small = true)
                TextAction(x.later, {})
                TextAction(x.block, {}, kind = TextActionKind.Destructive)
            }
        }
    }

    @Composable
    private fun Deck(x: Texts) {
        Card("Deck actions and photo chips") {
            val backdrop = rememberGlassBackdrop()
            PhotoBox(0, 150, backdrop) {
                Box(Modifier.fillMaxSize().background(AppTheme.template.paints.photoScrimBottom))
                Box(Modifier.align(Alignment.BottomCenter).padding(bottom = 14.dp)) {
                    DeckActions({}, {}, {}, {}, {}, backdrop = backdrop, modifier = Modifier.padding(horizontal = 0.dp))
                }
            }
            Caption("Physical LTR row: rewind, pass, super like, like, boost.")
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                AppIconButton(AppIcons.Tune, x.filters, {}, kind = IconButtonKind.Glass)
                AppIconButton(AppIcons.Search, x.search, {}, kind = IconButtonKind.Tonal)
                AppIconButton(AppIcons.More, x.more, {}, kind = IconButtonKind.Line)
                AppIconButton(AppIcons.Back, x.back, {})
                AppIconButton(AppIcons.Close, x.close, {})
            }
        }
    }

    @Composable
    private fun Chips(x: Texts) {
        Card("Chips and pills") {
            ChipRow {
                ChoiceChip(x.bachelor, selected = false, onClick = {})
                ChoiceChip(x.master, selected = true, onClick = {})
            }
            ChipRow {
                ChoiceChip(x.all, selected = true, onClick = {}, count = x.n(12))
                ChoiceChip(x.superLike, selected = false, onClick = {}, count = x.n(2))
            }
            ChipRow {
                InterestChip(x.hiking, shared = true)
                InterestChip(x.cinema)
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Pill(x.subscription, kind = PillKind.Tint)
                Pill(x.superLike)
                UnreadCount(x.n(2))
            }
        }
    }

    // Column 2

    @Composable
    private fun Fields(x: Texts) {
        Card("Fields") {
            AppTextField("", {}, placeholder = x.yourName)
            val focused = androidx.compose.runtime.remember { androidx.compose.foundation.interaction.MutableInteractionSource() }
            AppTextField(x.arash, {}, interactionSource = focused)
            // Drawn focused: the field's own collector starts first, then the focus arrives.
            androidx.compose.runtime.LaunchedEffect(Unit) {
                kotlinx.coroutines.yield()
                focused.emit(androidx.compose.foundation.interaction.FocusInteraction.Focus())
            }
            AppTextField(
                x.partialPhone,
                {},
                error = x.wrongNumber,
                keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Phone),
            )
            PhoneField(
                value = x.phoneShown,
                onValueChange = {},
                dialCode = x.dial,
                onCountryClick = {},
                contentDescription = x.phone,
                flag = { BandFlag(AppTheme.template.colors.flagGreen, AppTheme.template.colors.flagWhite, AppTheme.template.colors.flagRed) },
            )
            Box(Modifier.width(290.dp)) { OtpCells("48", 6) }
            Box(Modifier.width(290.dp)) { OtpCells("482710", 6, state = OtpState.Error) }
        }
    }

    @Composable
    private fun Selection(x: Texts) {
        Card("Selection controls") {
            SegmentedControl(listOf(x.superLike, x.boost), 0, {})
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                AppSwitch(false, null)
                AppSwitch(true, null)
                AppRadio(false)
                AppRadio(true)
                AppCheckbox(false)
                AppCheckbox(true)
            }
            AppSlider(0.4f, {})
            AppRangeSlider(0.12f..0.45f, {})
            ProgressBar(0.45f)
            OptionRow(x.serious, selected = true, onClick = {})
            OptionRow(x.friendship, selected = false, onClick = {})
        }
    }

    @Composable
    private fun Lists(x: Texts) {
        Card("Lists") {
            SectionLabel(x.account)
            SettingsGroup {
                SettingsRow(x.languageRow, value = x.persian, onClick = {})
                SettingsRow(x.incognito, end = RowEnd.Switch(true) {}, divider = true)
                SettingsRow(x.deleteRow, end = RowEnd.None, danger = true, divider = true, onClick = {})
            }
            ConversationRow(
                name = x.mahsa,
                preview = x.typing,
                time = x.now,
                onClick = {},
                verified = true,
                newMatch = true,
                typing = true,
                unread = 2,
                photo = facePhoto(1),
            )
        }
    }

    @Composable
    private fun Profile(x: Texts) {
        val t = AppTheme.template
        Card("Profile pieces") {
            Box(Modifier.fillMaxWidth().height(92.dp).clip(RoundedCornerShape(t.radii.md))) {
                Image(photo(1), contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                Box(Modifier.fillMaxSize().background(t.paints.photoScrimBottom))
                StoryProgress(4, 0, Modifier.padding(top = 12.dp))
                Text(x.nazanin24, style = t.type.h2, color = t.colors.onPhoto, modifier = Modifier.align(Alignment.BottomStart).padding(start = 16.dp, bottom = 10.dp))
            }
            FactRow(listOf(Fact(x.height, x.heightValue), Fact(x.education, x.bachelor), Fact(x.lookingFor, x.serious)))
            PromptQuote(x.perfectDay, x.perfectDayAnswer, onLike = {})
        }
    }

    @Composable
    private fun TabBars(x: Texts) {
        val t = AppTheme.template
        Card("Tab bar (floating or docked by the theme)") {
            val tabs = listOf(
                TabItem(x.discover, AppIcons.Discover, AppIcons.DiscoverSolid),
                TabItem(x.likes, AppIcons.HeartLine, AppIcons.Heart, TabBadge.Count(x.n(12), x.newLikes)),
                TabItem(x.chats, AppIcons.Chat, AppIcons.ChatSolid, TabBadge.Dot(x.unreadChats)),
                TabItem(x.profile, AppIcons.Profile, AppIcons.ProfileSolid),
            )
            Box(Modifier.fillMaxWidth().height(88.dp).clip(RoundedCornerShape(t.radii.md)).background(t.colors.bg), contentAlignment = Alignment.BottomCenter) {
                AppTabBar(tabs, 0, {}, safeArea = t.sizes.tabbarSafe, modifier = Modifier.padding(bottom = 0.dp))
            }
            val backdrop = rememberGlassBackdrop()
            Box(Modifier.fillMaxWidth().height(96.dp).clip(RoundedCornerShape(t.radii.md)), contentAlignment = Alignment.BottomCenter) {
                Image(photo(0), contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize().glassSource(backdrop))
                AppTabBar(tabs, 1, {}, overPhoto = true, backdrop = backdrop, safeArea = t.sizes.tabbarSafe)
            }
        }
    }

    // Column 3

    @Composable
    private fun Overlays(x: Texts) {
        val t = AppTheme.template
        Card("Sheet, dialog, snackbar, toast") {
            Box(Modifier.fillMaxWidth().height(250.dp).clip(RoundedCornerShape(t.radii.md)).background(t.colors.surface2)) {
                Box(Modifier.fillMaxSize().background(t.colors.scrim))
                Column(
                    Modifier
                        .align(Alignment.BottomCenter)
                        .fillMaxWidth()
                        .sheetSurface(),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    SheetGrabber(Modifier.padding(top = 0.dp))
                    SheetBody(x.filters, body = x.sheetLine, action = x.showMe, onAction = {}, modifier = Modifier.padding(bottom = 0.dp))
                }
            }
            DialogCard(x.unmatchTitle, x.unmatchBody, x.unmatch, {}, x.keep, {})
            AppSnackbar(x.passed, action = x.undo, onAction = {})
            Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(t.radii.md)).background(t.colors.photoPlaceholder).padding(12.dp)) {
                PhotoToast(x.superSent)
            }
        }
    }

    @Composable
    private fun Paywall(x: Texts) {
        Card("Paywall") {
            SegmentedControl(listOf(x.plus, x.premium, x.platinum), 1, {})
            Caption("2 or 3 plans: segmented. 4 or more: the rail below (runs off the screen edge).")
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PlanCard(PlanOption("plus", x.plus), selected = false, onClick = {}, modifier = Modifier.width(132.dp))
                PlanCard(PlanOption("gold", x.summerGold), selected = true, onClick = {}, modifier = Modifier.width(132.dp))
            }
            BenefitList(listOf(x.seeWhoLiked, x.unlimitedLikes))
            PeriodRow(PeriodOption("1m", x.oneMonth, x.price1, x.toman), selected = false, onClick = {})
            PeriodRow(PeriodOption("12m", x.twelveMonths, x.price12, x.toman, saving = x.saving), selected = true, onClick = {})
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally)) {
                TextAction(x.restore, {}, kind = TextActionKind.Neutral)
                TextAction(x.terms, {}, kind = TextActionKind.Neutral)
                TextAction(x.privacy, {}, kind = TextActionKind.Neutral)
            }
        }
    }

    @Composable
    private fun Chat(x: Texts) {
        Card("Chat") {
            ChatSystemLine(x.matched3Days)
            ChatBubble(x.theirMessage, null, mine = false)
            ChatBubble(x.myMessage, x.myMeta, mine = true)
        }
    }

    @Composable
    private fun Avatars(x: Texts) {
        Card("Avatars, badge, mark, tiles") {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Avatar(56.dp, photo = facePhoto(0))
                Avatar(48.dp, newMatch = true, photo = facePhoto(2))
                Avatar(48.dp)
                VerifiedBadge(24.dp)
                LogoMark(40.dp)
            }
            // The strip of new matches: a fresh one ringed outside its photo, 4 dp of room for the ring.
            Row(Modifier.padding(4.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                MatchTile(isNew = true, photo = tilePhoto(0))
                MatchTile(photo = tilePhoto(1))
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                PhotoTile(Modifier.width(96.dp), mainTag = x.mainTag, onRemove = {}, photo = tilePhoto(2))
                PhotoTile(Modifier.width(96.dp), status = x.inReview, photo = tilePhoto(3))
                AddPhotoTile({}, x.addPhoto, Modifier.width(96.dp))
            }
        }
    }

    /** What the design sheet leaves to the screens: the template picker, call buttons, the name line. */
    @Composable
    private fun Extras(x: Texts) {
        val t = AppTheme.template
        Card("Template picker, calls, name line") {
            TemplatePicker(choice = "default", offered = listOf("neon", "white"), onChoose = {})
            Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(t.radii.md)).background(androidx.compose.ui.graphics.Color(0xFF2A2A30)).padding(12.dp)) {
                CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                        CallButton(AppIcons.Close, x.decline, {}, kind = CallButtonKind.End)
                        CallButton(AppIcons.Phone, x.audioOnly, {}, kind = CallButtonKind.Secondary)
                        CallButton(AppIcons.Video, x.mute, {}, kind = CallButtonKind.Toggled, size = 56.dp)
                        CallButton(AppIcons.Video, x.answer, {}, kind = CallButtonKind.Accept)
                    }
                }
            }
            Column(Modifier.fillMaxWidth().templateCard(RoundedCornerShape(t.radii.md)).padding(12.dp)) {
                NameLine(x.nazanin, x.n(24), verified = true, online = true, onPhoto = false)
                Text(x.cityDistance, style = t.type.body, color = t.colors.text2)
            }
            Box(Modifier.fillMaxWidth().height(110.dp).clip(RoundedCornerShape(t.radii.md))) {
                Image(photo(1), contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                Box(Modifier.fillMaxSize().background(t.paints.photoScrimBottom))
                NameLine(x.nazanin, x.n(24), Modifier.align(Alignment.BottomStart).padding(12.dp), verified = true, online = true)
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) { PersonSilhouette(48.dp) }
            }
        }
    }

    /** The sheet's sample texts (the design's own), Persian or English. */
    class Texts(private val language: AppLanguage) {
        private val fa = language == AppLanguage.FA
        private fun p(persian: String, english: String) = if (fa) persian else english
        fun n(value: Int) = Numerals.format(value, language)

        val sayHi = p("سلام کن.", "Say hi.")
        val screenTitle = p("عنوان صفحه", "Screen title")
        val cardTitle = p("عنوان کارت", "Card title")
        val rowTitle = p("عنوان ردیف", "Row title")
        val aboutLarge = p("متن درباره‌ی من، بزرگ", "About me, large")
        val body = p("متن معمولی", "Body text")
        val helper = p("خط کوتاه کمکی", "A short helper line")
        val small = p("برچسب کوچک", "Small label")
        val continueLabel = p("ادامه", "Continue")
        val signIn = p("ورود", "Sign in")
        val deleteAccount = p("حسابم رو پاک کن", "Delete my account")
        val deleteRow = p("حذف حساب", "Delete account")
        val editProfile = p("ویرایش پروفایل", "Edit profile")
        val preview = p("پیش‌نمایش", "Preview")
        val later = p("بعداً", "Later")
        val block = p("مسدودش کن", "Block")
        val filters = p("فیلترها", "Filters")
        val search = p("جستجو", "Search")
        val more = p("بیشتر", "More")
        val back = p("برگشت", "Back")
        val close = p("بستن", "Close")
        val bachelor = p("کارشناسی", "Bachelor’s")
        val master = p("کارشناسی ارشد", "Master’s")
        val all = p("همه", "All")
        val superLike = p("سوپرلایک", "Super like")
        val boost = p("بوست", "Boost")
        val hiking = p("کوه‌نوردی", "Hiking")
        val cinema = p("فیلم کلاسیک", "Classic films")
        val subscription = p("اشتراک", "Subscription")
        val yourName = p("اسمت", "Your name")
        val arash = p("آرش", "Arash")
        val partialPhone = p("۰۹۱۲ ۳۴۵", "0912 345")
        val wrongNumber = p("این شماره درست نیست.", "That number isn’t right.")
        val dial = p("+۹۸", "+98")
        val phone = p("شماره موبایل", "Phone number")
        val phoneShown = p("۹۱۲ ۳۴۵ ۶۷۸۹", "912 345 6789")
        val serious = p("رابطه‌ی جدی", "Something serious")
        val friendship = p("دوستی", "Friendship")
        val account = p("حساب", "Account")
        val languageRow = p("زبان", "Language")
        val persian = p("فارسی", "Persian")
        val incognito = p("حالت ناشناس", "Incognito")
        val mahsa = p("مهسا", "Mahsa")
        val typing = p("داره می‌نویسه…", "typing…")
        val now = p("الان", "now")
        val nazanin = p("نازنین", "Nazanin")
        val nazanin24 = p("نازنین، ۲۴", "Nazanin, 24")
        val height = p("قد", "Height")
        val heightValue = p("۱۶۸ سانت", "168 cm")
        val education = p("تحصیلات", "Education")
        val lookingFor = p("دنبال", "Looking for")
        val perfectDay = p("یه روز عالی یعنی…", "A perfect day is…")
        val perfectDayAnswer = p("صبحونه تو دربند، شب یه چای داغ.", "Breakfast in the hills, a hot tea at night.")
        val discover = p("کشف", "Discover")
        val likes = p("لایک‌ها", "Likes")
        val chats = p("گفتگوها", "Chats")
        val profile = p("پروفایل", "Profile")
        val newLikes = p("۱۲ لایک تازه", "12 new likes")
        val unreadChats = p("پیام تازه", "New messages")
        val sheetLine = p("یه خط کوتاه، فقط وقتی لازمه.", "One short line, only when needed.")
        val showMe = p("نشونم بده", "Show me")
        val unmatchTitle = p("مچ رو برمی‌داری؟", "Unmatch?")
        val unmatchBody = p("گفتگوتون پاک می‌شه و دیگه همدیگه رو نمی‌بینین.", "Your chat is deleted and you won’t see each other again.")
        val unmatch = p("برش دار", "Unmatch")
        val keep = p("نه، بمونه", "Keep")
        val passed = p("نازنین رو رد کردی.", "You passed on Nazanin.")
        val undo = p("برگردون", "Undo")
        val superSent = p("سوپرلایکت رفت", "Super like sent")
        val plus = p("پلاس", "Plus")
        val premium = p("پریمیوم", "Premium")
        val platinum = p("پلاتینیوم", "Platinum")
        val summerGold = p("طلایی ویژه‌ی تابستون", "Summer gold special")
        val seeWhoLiked = p("ببین کی لایکت کرده", "See who liked you")
        val unlimitedLikes = p("لایک نامحدود", "Unlimited likes")
        val oneMonth = p("۱ ماهه", "1 month")
        val twelveMonths = p("۱۲ ماهه", "12 months")
        val price1 = p("۱۸۰٬۰۰۰", "180,000")
        val price12 = p("۱٬۲۰۰٬۰۰۰", "1,200,000")
        val toman = p("تومان", "Toman")
        val saving = p("۴۴٪ کمتر", "44% less")
        val restore = p("بازیابی خرید", "Restore")
        val terms = p("قوانین", "Terms")
        val privacy = p("حریم خصوصی", "Privacy")
        val matched3Days = p("۳ روز پیش مچ شدین", "You matched 3 days ago")
        val theirMessage = p("دارآباد! مسیرش قشنگ‌تره. تو چی؟", "Darabad! The trail is prettier. You?")
        val myMessage = p("پس جمعه ساعت ۷؟", "Friday at 7, then?")
        val myMeta = p("۱۸:۲۵، دیده شد", "18:25, seen")
        val mainTag = p("اصلی", "Main")
        val inReview = p("در حال بررسی", "In review")
        val addPhoto = p("عکس اصلی", "Main photo")
        val decline = p("رد", "Decline")
        val audioOnly = p("فقط صدا", "Audio only")
        val mute = p("دوربین خاموش", "Camera off")
        val answer = p("تصویری", "Video")
        val cityDistance = p("تهران، ۳ کیلومتر", "Tehran, 3 km")
    }
}
