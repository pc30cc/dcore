package app.core.ui.gallery

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.foundation.interaction.FocusInteraction
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.core.feature.auth.welcome.GeneratedFaces
import app.core.i18n.AppLanguage
import app.core.i18n.Numerals
import app.core.ui.components.AlivePill
import app.core.ui.components.AppIconButton
import app.core.ui.components.AppSnackbar
import app.core.ui.components.AppTextField
import app.core.ui.components.Avatar
import app.core.ui.components.BandFlag
import app.core.ui.components.Benefit
import app.core.ui.components.BenefitGrid
import app.core.ui.components.ChatBubble
import app.core.ui.components.ChatInfoChip
import app.core.ui.components.ChipRow
import app.core.ui.components.ChoiceChip
import app.core.ui.components.ConversationRow
import app.core.ui.components.DeckActions
import app.core.ui.components.DialogCard
import app.core.ui.components.EmptyState
import app.core.ui.components.Fact
import app.core.ui.components.FactChip
import app.core.ui.components.FactRow
import app.core.ui.components.FilterChoiceChip
import app.core.ui.components.FloatingTabBar
import app.core.ui.components.GlassBackdrop
import app.core.ui.components.GradientButton
import app.core.ui.components.GradientRangeSlider
import app.core.ui.components.GradientSlider
import app.core.ui.components.GradientSwitch
import app.core.ui.components.IconButtonKind
import app.core.ui.components.IconLine
import app.core.ui.components.InterestChip
import app.core.ui.components.InverseButton
import app.core.ui.components.LikesTeaserTile
import app.core.ui.components.LogoMark
import app.core.ui.components.MatchTile
import app.core.ui.components.OtpCells
import app.core.ui.components.OtpState
import app.core.ui.components.OutlineButton
import app.core.ui.components.PeriodOption
import app.core.ui.components.PeriodRow
import app.core.ui.components.PhoneField
import app.core.ui.components.PhotoChip
import app.core.ui.components.PhotoChipMark
import app.core.ui.components.PhotoNameLine
import app.core.ui.components.PhotoPullQuote
import app.core.ui.components.PhotoScrimBottom
import app.core.ui.components.PhotoScrimTop
import app.core.ui.components.PhotoToast
import app.core.ui.components.PlanBadge
import app.core.ui.components.PlanOption
import app.core.ui.components.PlanSelector
import app.core.ui.components.PromptCard
import app.core.ui.components.RowEnd
import app.core.ui.components.SafetyCard
import app.core.ui.components.SectionKicker
import app.core.ui.components.SegmentedControl
import app.core.ui.components.SettingsRow
import app.core.ui.components.SheetBody
import app.core.ui.components.SheetChoiceRow
import app.core.ui.components.SheetGrabber
import app.core.ui.components.SkeletonCard
import app.core.ui.components.SkeletonRow
import app.core.ui.components.SliderLabel
import app.core.ui.components.SmsCodeChip
import app.core.ui.components.SnackbarKind
import app.core.ui.components.StepsHeader
import app.core.ui.components.StoryProgress
import app.core.ui.components.TabBadge
import app.core.ui.components.TabItem
import app.core.ui.components.TextAction
import app.core.ui.components.TextActionKind
import app.core.ui.components.TonalButton
import app.core.ui.components.VerifiedBadge
import app.core.ui.components.glassSource
import app.core.ui.components.rememberGlassBackdrop
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Radius
import java.io.File

/**
 * Every component of the design system on a few pages, like the design's
 * own sheet (components.md, png/components.png): numbered sections, each a
 * card with its title, in the screen's language and theme. Photos come
 * from `GALLERY_PHOTOS` (a folder with `photos/` and `faces/` JPEGs, outside
 * the repository) when set, else from generated faces.
 */
object ComponentGallery {

    const val PAGES = 9

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

    @Composable
    fun Page(page: Int, language: AppLanguage) {
        val t = GalleryText(language)
        Column(
            Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).padding(horizontal = 16.dp, vertical = 20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            when (page) {
                1 -> { Colours(t); Typography(t) }
                2 -> { Buttons(t); IconButtons(t); DeckRow(t) }
                3 -> { Chips(t); TextFields(t); Phone(t) }
                4 -> { Otp(t); Segments(t); Switches(t) }
                5 -> { Rows(t); Kickers(t); Facts(t); Prompts(t) }
                6 -> { Story(t); TabBars(t); Sheet(t) }
                7 -> { Dialog(t); Snackbars(t); Avatars(t); Verified(t) }
                8 -> { Empty(t); Skeletons(t); Steps(t); Plans(t) }
                9 -> { Paywall(t); Chat(t); Logo(t) }
            }
        }
    }

    @Composable
    private fun Section(number: Int, title: String, english: String, content: @Composable ColumnScope.() -> Unit) {
        val scheme = MaterialTheme.colorScheme
        val language = app.core.i18n.screenLanguage()
        Column(
            Modifier
                .fillMaxWidth()
                .background(scheme.surfaceContainerLow, RoundedCornerShape(28.dp))
                .border(1.dp, scheme.outlineVariant, RoundedCornerShape(28.dp))
                .padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            // The sheet's own header (as in the design's sheet): the number, a rule, a title-sized name.
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(Numerals.twoDigits(number, language), style = AppTheme.type.kicker, color = scheme.primary)
                Box(Modifier.width(24.dp).height(1.dp).background(scheme.onSurfaceVariant.copy(alpha = 0.7f)))
                Text(title, style = MaterialTheme.typography.titleMedium, color = scheme.onSurface, modifier = Modifier.weight(1f))
                Text(english, style = MaterialTheme.typography.labelSmall, color = AppTheme.colors.textTertiary)
            }
            content()
        }
    }

    @Composable
    private fun Caption(text: String) {
        Text(text, style = MaterialTheme.typography.bodySmall, color = AppTheme.colors.textTertiary)
    }

    @Composable
    private fun PhotoStrip(index: Int, height: Int, backdrop: GlassBackdrop?, content: @Composable BoxScope.() -> Unit) {
        Box(Modifier.fillMaxWidth().height(height.dp).clip(RoundedCornerShape(22.dp))) {
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

    // Page 1

    @Composable
    private fun Colours(t: GalleryText) {
        val s = MaterialTheme.colorScheme
        val a = AppTheme.colors
        Section(0, t.colours, "Colour roles") {
            val swatches = listOf(
                Triple("gradient", null, a.gradientStops.start),
                Triple("primary", s.primary, s.onPrimary),
                Triple("alive", a.alive, a.onAlive),
                Triple("verified", a.verified, a.onVerified),
                Triple("error", s.error, s.onError),
                Triple("background", s.background, s.onBackground),
                Triple("container high", s.surfaceContainerHigh, s.onSurface),
                Triple("onSurface", s.onSurface, s.surface),
            )
            swatches.chunked(4).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    row.forEach { (name, fill, ink) ->
                        Box(
                            Modifier
                                .weight(1f)
                                .height(64.dp)
                                .clip(RoundedCornerShape(14.dp))
                                .then(if (fill == null) Modifier.background(a.gradient) else Modifier.background(fill))
                                .border(1.dp, a.hairlineStrong, RoundedCornerShape(14.dp))
                                .padding(8.dp),
                            contentAlignment = Alignment.BottomStart,
                        ) {
                            Text(name, style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Bold), color = if (fill == null) Color.White else ink, maxLines = 1)
                        }
                    }
                }
            }
        }
    }

    @Composable
    private fun Typography(t: GalleryText) {
        val ty = MaterialTheme.typography
        Section(0, t.typography, "Type") {
            listOf(
                ty.displayLarge to t.match,
                ty.displayMedium to t.sayHi,
                ty.displaySmall to t.nameAge,
                ty.headlineLarge to t.whatsYourName,
                ty.headlineMedium to t.likedYou,
                ty.headlineSmall to t.chats,
                ty.titleLarge to t.answer,
                ty.titleMedium to t.filters,
                ty.titleSmall to t.privacy,
                ty.bodyLarge to t.about,
                ty.bodyMedium to t.codeSent,
                ty.bodySmall to t.meta,
                ty.labelLarge to t.continueLabel,
                ty.labelMedium to t.hiking,
                ty.labelSmall to t.likes,
            ).forEach { (style, text) ->
                Text(text, style = style, color = MaterialTheme.colorScheme.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Text("It’s a match! · Eşleştiniz! ğ ş ı İ", style = ty.titleLarge, color = MaterialTheme.colorScheme.onSurface)
        }
    }

    // Page 2

    @Composable
    private fun Buttons(t: GalleryText) {
        Section(1, t.buttons, "Buttons") {
            GradientButton(t.continueLabel, {}, forward = true)
            GradientButton(t.continueLabel, {}, loading = true)
            GradientButton(t.continueLabel, {}, enabled = false)
            OutlineButton(t.haveAccount, {})
            TonalButton(t.fromGallery, {}, icon = AppIcons.Camera)
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                TextAction(t.later, {})
                InverseButton(t.edit, {}, icon = AppIcons.Pencil)
                TextAction(t.removePhoto, {}, kind = TextActionKind.Destructive)
            }
        }
    }

    @Composable
    private fun IconButtons(t: GalleryText) {
        Section(2, t.iconButtons, "Icon buttons") {
            val backdrop = rememberGlassBackdrop()
            PhotoStrip(0, 110, backdrop) {
                Row(Modifier.fillMaxSize().padding(horizontal = 12.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    AppIconButton(AppIcons.ChevronDown, t.close, {}, kind = IconButtonKind.Glass, size = 44.dp, backdrop = backdrop)
                    AppIconButton(AppIcons.More, t.more, {}, kind = IconButtonKind.Glass, size = 44.dp, backdrop = backdrop)
                    AppIconButton(AppIcons.Tune, t.filters, {}, kind = IconButtonKind.Glass, size = 44.dp, backdrop = backdrop)
                    AppIconButton(AppIcons.ChevronUp, t.close, {}, kind = IconButtonKind.Glass, size = 44.dp, backdrop = backdrop)
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                AppIconButton(AppIcons.Back, t.back, {})
                AppIconButton(AppIcons.Search, t.search, {}, kind = IconButtonKind.Tonal)
                AppIconButton(AppIcons.Phone, t.call, {}, kind = IconButtonKind.Line)
                AppIconButton(AppIcons.Video, t.video, {}, kind = IconButtonKind.Tonal)
                AppIconButton(AppIcons.Close, t.close, {})
            }
        }
    }

    @Composable
    private fun DeckRow(t: GalleryText) {
        Section(3, t.deckActions, "Deck actions") {
            val backdrop = rememberGlassBackdrop()
            PhotoStrip(1, 150, backdrop) {
                DeckActions({}, {}, {}, {}, {}, Modifier.align(Alignment.Center), backdrop = backdrop)
            }
            Caption(t.deckCaption)
        }
    }

    // Page 3

    @Composable
    private fun Chips(t: GalleryText) {
        Section(4, t.chips, "Chips") {
            ChipRow {
                ChoiceChip(t.serious, selected = true, onClick = {})
                ChoiceChip(t.marriage, selected = false, onClick = {})
                ChoiceChip(t.friendship, selected = false, onClick = {})
            }
            ChipRow {
                FilterChoiceChip(t.verifiedOnly, selected = true, onClick = {})
                FilterChoiceChip(t.online, selected = false, onClick = {})
                FilterChoiceChip(t.more, selected = false, onClick = {}, icon = AppIcons.Tune)
            }
            ChipRow {
                InterestChip(t.books, icon = AppIcons.Book)
                InterestChip(t.cinema, icon = AppIcons.Film)
                InterestChip(t.hiking, shared = true)
            }
            ChipRow {
                FactChip(t.libra, AppIcons.Libra)
                FactChip(t.cat, AppIcons.Paw)
                FactChip(t.noSmoking, AppIcons.NoSmoking)
            }
            val backdrop = rememberGlassBackdrop()
            PhotoStrip(2, 80, backdrop) {
                Row(Modifier.align(Alignment.Center), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PhotoChip(t.onlineNow, mark = PhotoChipMark.Online, backdrop = backdrop)
                    PhotoChip(t.sharedInterests, mark = PhotoChipMark.Shared, backdrop = backdrop)
                }
            }
        }
    }

    @Composable
    private fun TextFields(t: GalleryText) {
        Section(5, t.textField, "Text field") {
            AppTextField("", {}, label = t.nickname, placeholder = t.example)
            AppTextField(t.arash, {}, label = t.focusedCounter, maxLength = 20, helper = t.nameHelper, interactionSource = rememberFocused())
            AppTextField(t.arash + "123", {}, label = t.errorLabel, error = t.nameError)
        }
    }

    @Composable
    private fun Phone(t: GalleryText) {
        Section(6, t.phone, "Phone field") {
            PhoneField(
                value = t.phoneDigits,
                onValueChange = {},
                dialCode = t.dialCode,
                onCountryClick = {},
                contentDescription = t.phone,
                flag = { BandFlag(Color(0xFF239F40), Color.White, Color(0xFFDA0000)) },
                trustLine = t.phoneTrust,
                visualTransformation = app.core.feature.auth.PhoneVisualTransformation(app.core.feature.auth.PhoneNumbers.country("IR")!!, t.language),
                interactionSource = rememberFocused(),
            )
        }
    }

    // Page 4

    @Composable
    private fun Otp(t: GalleryText) {
        Section(7, t.otp, "OTP") {
            OtpCells("482", 6, Modifier.align(Alignment.CenterHorizontally))
            SmsCodeChip(t.fromSms, {}, Modifier.align(Alignment.CenterHorizontally))
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                IconLine(AppIcons.Clock, t.resend, Modifier.weight(1f))
                TextAction(t.changeNumber, {})
            }
            SafetyCard(t.dontShare, t.neverAsk)
            Caption(t.wrongCode)
            OtpCells("482710", 6, Modifier.align(Alignment.CenterHorizontally), state = OtpState.Error)
        }
    }

    @Composable
    private fun Segments(t: GalleryText) {
        Section(8, t.segmented, "Segmented control") {
            SegmentedControl(listOf(t.plus, t.premium), 1, {}, icons = listOf(null, AppIcons.Crown))
            SegmentedControl(listOf(t.all, t.online, t.newest), 0, {})
        }
    }

    @Composable
    private fun Switches(t: GalleryText) {
        Section(9, t.switches, "Switch, slider") {
            SettingsRow(t.incognito, subtitle = t.incognitoBody, end = RowEnd.Switch(true) {}, divider = true)
            SettingsRow(t.showDistance, subtitle = t.showDistanceBody, end = RowEnd.Switch(false) {}, divider = false)
            SliderLabel(t.maxDistance, t.km25)
            GradientSlider(0.4f, {})
            SliderLabel(t.ageRange, t.ages)
            GradientRangeSlider(0.25f..0.55f, {})
        }
    }

    // Page 5

    @Composable
    private fun Rows(t: GalleryText) {
        Section(10, t.listRows, "List rows") {
            Column {
                SettingsRow(t.privacy, icon = AppIcons.Shield, onClick = {})
                SettingsRow(t.languageRow, icon = AppIcons.Globe, value = t.persian, onClick = {})
                SettingsRow(t.notifications, icon = AppIcons.Bell, subtitle = t.notificationsBody, end = RowEnd.Switch(true) {}, divider = false)
            }
            Caption(t.conversation)
            Column {
                ConversationRow(t.nazanin, t.typing, t.now, {}, verified = true, newMatch = true, typing = true, unread = 2, photo = facePhoto(12))
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                ConversationRow(t.saman, t.teaOrCoffee, t.yesterday, {}, online = true, yourTurn = t.yourTurn, photo = facePhoto(0))
            }
        }
    }

    @Composable
    private fun Kickers(t: GalleryText) {
        Section(11, t.kicker, "Section kicker") {
            SectionKicker(1, t.aboutMe)
            SectionKicker(2, t.interests)
            PhotoStrip(3, 64, null) {
                PhotoScrimTop(Modifier.fillMaxSize())
                SectionKicker(1, t.photoOf, Modifier.align(Alignment.CenterStart).padding(horizontal = 16.dp), onPhoto = true)
            }
        }
    }

    @Composable
    private fun Facts(t: GalleryText) {
        Section(12, t.factRow, "Fact row") {
            FactRow(listOf(Fact(AppIcons.Height, t.height, t.cm178), Fact(AppIcons.Education, t.education, t.architecture), Fact(AppIcons.HeartLine, t.lookingFor, t.marriage)))
            ChipRow {
                FactChip(t.libra, AppIcons.Libra)
                FactChip(t.cat, AppIcons.Paw)
                FactChip(t.noSmoking, AppIcons.NoSmoking)
            }
        }
    }

    @Composable
    private fun Prompts(t: GalleryText) {
        Section(13, t.prompt, "Pull-quote prompt") {
            PromptCard(t.weirdThing, t.answer, onLike = {})
            PhotoStrip(4, 150, null) {
                PhotoScrimBottom(Modifier.fillMaxSize())
                PhotoPullQuote(t.darband, t.flask, Modifier.align(Alignment.BottomStart).padding(18.dp))
            }
            PhotoStrip(5, 120, null) {
                PhotoScrimBottom(Modifier.fillMaxSize())
                PhotoNameLine(t.taraneh, Numerals.format(22, t.language), Modifier.align(Alignment.BottomStart).padding(18.dp), verified = true)
            }
        }
    }

    // Page 6

    @Composable
    private fun Story(t: GalleryText) {
        Section(14, t.story, "Story progress") {
            PhotoStrip(5, 170, null) {
                PhotoScrimTop(Modifier.fillMaxWidth())
                Column(Modifier.padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    StoryProgress(4, 3)
                    StoryProgress(4, 1, progress = 0.5f)
                    StoryProgress(6, 6)
                }
            }
        }
    }

    @Composable
    private fun TabBars(t: GalleryText) {
        val tabs = listOf(
            TabItem(t.discover, AppIcons.Discover, AppIcons.DiscoverSolid),
            TabItem(t.likes, AppIcons.HeartLine, AppIcons.Heart, TabBadge.Count(Numerals.format(12, t.language), t.newLikes)),
            TabItem(t.chats, AppIcons.Chat, AppIcons.ChatSolid, TabBadge.Dot(t.unreadDot)),
            TabItem(t.profile, AppIcons.Profile, AppIcons.ProfileSolid),
        )
        Section(15, t.tabBar, "Floating glass tab bar") {
            val backdrop = rememberGlassBackdrop()
            PhotoStrip(1, 120, backdrop) {
                FloatingTabBar(tabs, 0, {}, Modifier.align(Alignment.Center), overPhoto = true, backdrop = backdrop)
            }
            Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(22.dp)).background(MaterialTheme.colorScheme.background).padding(vertical = 18.dp)) {
                Column(Modifier.padding(horizontal = 30.dp).fillMaxWidth()) {
                    SkeletonRow()
                }
                FloatingTabBar(tabs, 2, {}, Modifier.align(Alignment.BottomCenter))
            }
            Caption(t.tabCaption)
        }
    }

    @Composable
    private fun Sheet(t: GalleryText) {
        Section(16, t.sheet, "Bottom sheet") {
            Column(
                Modifier
                    .fillMaxWidth()
                    .background(MaterialTheme.colorScheme.surfaceContainerLow, RoundedCornerShape(topStart = Radius.sheet, topEnd = Radius.sheet))
                    .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(topStart = Radius.sheet, topEnd = Radius.sheet)),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                SheetGrabber()
                SheetBody(t.reportTitle, body = t.reportBody, action = t.sendReport, onAction = {}) {
                    SheetChoiceRow(t.fakeProfile, true, {})
                    SheetChoiceRow(t.badMessage, false, {})
                    SheetChoiceRow(t.money, false, {}, divider = false)
                }
            }
        }
    }

    // Page 7

    @Composable
    private fun Dialog(t: GalleryText) {
        Section(17, t.dialog, "Dialog") {
            Box(Modifier.fillMaxWidth().background(Color.Black.copy(alpha = 0.56f), RoundedCornerShape(22.dp)).padding(20.dp)) {
                DialogCard(t.unmatchTitle, t.unmatchBody, t.unmatch, {}, t.keep, {})
            }
        }
    }

    @Composable
    private fun Snackbars(t: GalleryText) {
        Section(18, t.snackbar, "Snackbar, toast") {
            AppSnackbar(t.passed, action = t.undo, onAction = {})
            AppSnackbar(t.photoAdded, kind = SnackbarKind.Success)
            AppSnackbar(t.likeFailed, kind = SnackbarKind.Error)
            val backdrop = rememberGlassBackdrop()
            PhotoStrip(0, 90, backdrop) {
                PhotoToast(t.superLikeSent, Modifier.align(Alignment.Center), backdrop = backdrop)
            }
        }
    }

    @Composable
    private fun Avatars(t: GalleryText) {
        Section(19, t.avatars, "Avatars, match tiles") {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Avatar(48.dp)
                Avatar(36.dp, photo = facePhoto(2))
                Avatar(48.dp, photo = facePhoto(3))
                Avatar(56.dp, online = true, photo = facePhoto(4))
                Avatar(64.dp, newMatch = true, photo = facePhoto(5))
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                MatchTile(photo = facePhoto(6))
                MatchTile(isNew = true, photo = facePhoto(7))
                MatchTile(isNew = true, photo = facePhoto(8))
                LikesTeaserTile(t.plus12, photo = facePhoto(9))
            }
            Caption(t.avatarCaption)
        }
    }

    @Composable
    private fun Verified(t: GalleryText) {
        Section(20, t.verifiedBadge, "Verified badge") {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(18.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.width(110.dp).height(56.dp).clip(RoundedCornerShape(18.dp))) {
                    Image(photo(2), null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                    VerifiedBadge(28.dp, Modifier.align(Alignment.Center), onPhoto = true)
                }
                VerifiedBadge(28.dp)
                VerifiedBadge(24.dp)
                VerifiedBadge(20.dp)
                VerifiedBadge(16.dp)
            }
        }
    }

    // Page 8

    @Composable
    private fun Empty(t: GalleryText) {
        Section(21, t.emptyState, "Empty state") {
            EmptyState(AppIcons.Compass, t.seenEveryone, t.newPeople, action = t.widen, onAction = {}, secondary = t.changeFilters, onSecondary = {})
        }
    }

    @Composable
    private fun Skeletons(t: GalleryText) {
        Section(22, t.skeleton, "Skeleton loading") {
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Column(Modifier.weight(1f)) {
                    SkeletonRow()
                    SkeletonRow()
                }
                SkeletonCard(Modifier.size(110.dp, 150.dp))
            }
        }
    }

    @Composable
    private fun Steps(t: GalleryText) {
        Section(23, t.steps, "Numbered steps") {
            StepsHeader(3, 8, onBack = {})
            SectionKicker(3, t.aboutYou)
            Text(t.birthday, style = MaterialTheme.typography.headlineLarge, color = MaterialTheme.colorScheme.onSurface)
            Text(t.birthdayHelper, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }

    @Composable
    private fun Plans(t: GalleryText) {
        val l = t.language
        fun plan(id: String, name: String, price: Int, badge: PlanBadge? = null) =
            PlanOption(id, name, t.monthlyFrom, Numerals.format(price, l), t.toman, badge)
        val three = listOf(
            plan("plus", t.plus, 100_000),
            plan("premium", t.premium, 180_000, PlanBadge(t.popular, alive = false)),
            plan("gold", t.gold, 260_000, PlanBadge(t.newBadge, alive = true)),
        )
        Section(24, t.planSelector, "Plan selector") {
            Caption(t.twoPlans)
            PlanSelector(three.take(2), "premium", {})
            Caption(t.threePlans)
            PlanSelector(three, "premium", {})
            Caption(t.manyPlans)
            PlanSelector(
                three + plan("vip", t.longPlanName, 420_000, PlanBadge(t.bestValue, alive = true)) + plan("week", t.week, 40_000),
                "vip",
                {},
            )
        }
    }

    // Page 9

    @Composable
    private fun Paywall(t: GalleryText) {
        val l = t.language
        Section(24, t.periods, "Periods, benefits") {
            SectionKicker(1, t.whatPremiumGives)
            BenefitGrid(
                listOf(
                    Benefit(t.seeLikes, AppIcons.Heart),
                    Benefit(t.unlimitedLikes, AppIcons.HeartLine),
                    Benefit(t.superLikes, AppIcons.Star),
                    Benefit(t.rewind, AppIcons.Rewind),
                    Benefit(t.boost, AppIcons.Bolt),
                    Benefit(t.incognito),
                    Benefit(t.filters, AppIcons.Tune),
                ),
                more = { t.moreBenefits(it) },
            )
            SectionKicker(2, t.chooseLength)
            PeriodRow(PeriodOption("12", t.months12, t.perMonth(100_000), Numerals.format(1_200_000, l), t.toman, Numerals.percent(44, l) + " " + t.less, PlanBadge(t.bestValue, alive = true)), true, {})
            PeriodRow(PeriodOption("3", t.months3, t.perMonth(150_000), Numerals.format(450_000, l), t.toman, Numerals.percent(17, l) + " " + t.less), false, {})
            PeriodRow(PeriodOption("1", t.months1, null, Numerals.format(180_000, l), t.toman), false, {})
            GradientButton(t.continueWith(Numerals.format(1_200_000, l)), {})
            AlivePill(t.yourTurn)
        }
    }

    @Composable
    private fun Chat(t: GalleryText) {
        Section(25, t.chat, "Chat bits") {
            ChatInfoChip(t.matchedAgo)
            ChatBubble(t.hello, t.time1, mine = false)
            ChatBubble(t.flask, t.time2Seen, mine = true)
        }
    }

    @Composable
    private fun Logo(t: GalleryText) {
        Section(26, t.logo, "Logo mark, no name") {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(88.dp).clip(RoundedCornerShape(26.dp)).background(AppTheme.colors.gradient), contentAlignment = Alignment.Center) {
                    LogoMark(56.dp, mono = true)
                }
                Box(Modifier.size(88.dp).clip(RoundedCornerShape(26.dp)).background(MaterialTheme.colorScheme.surfaceContainerHigh), contentAlignment = Alignment.Center) {
                    LogoMark(56.dp)
                }
                LogoMark(44.dp)
                LogoMark(24.dp)
            }
            Spacer(Modifier.height(4.dp))
        }
    }
}

/** An interaction source that says "focused" from the start, to draw a field focused without a keyboard. */
private class FocusedSource : MutableInteractionSource {
    override val interactions = kotlinx.coroutines.flow.flowOf<androidx.compose.foundation.interaction.Interaction>(FocusInteraction.Focus())
    override suspend fun emit(interaction: androidx.compose.foundation.interaction.Interaction) = Unit
    override fun tryEmit(interaction: androidx.compose.foundation.interaction.Interaction): Boolean = true
}

@Composable
private fun rememberFocused(): MutableInteractionSource = remember { FocusedSource() }
