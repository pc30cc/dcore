@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package app.core.feature.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import app.core.R
import app.core.i18n.AppLanguage
import app.core.i18n.brandString
import app.core.model.NotificationPrefs
import app.core.model.Settings
import app.core.model.SettingsPatch
import app.core.ui.components.AppBottomSheet
import app.core.ui.components.RowEnd
import app.core.ui.components.SettingsRow
import app.core.ui.components.SheetBody
import app.core.ui.components.SheetChoiceRow
import app.core.ui.LocalIoDispatcher
import app.core.ui.theme.AppTheme
import kotlinx.coroutines.withContext

// The sheets Settings' rows open: a title and plain rows on the sheet, nothing to explain them.

/** «زبان»: «زبان گوشی» (follow the phone) and each language in its own name, one radio group; a pick applies at once. */
@Composable
internal fun LanguageSheet(chosen: AppLanguage?, onDismiss: () -> Unit, onChoose: (AppLanguage?) -> Unit) {
    val options: List<Pair<AppLanguage?, String>> =
        listOf<Pair<AppLanguage?, String>>(null to brandString(R.string.language_phone)) +
            AppLanguage.entries.map { it to brandString(it.nameRes()) }
    AppBottomSheet(onDismissRequest = onDismiss) {
        SheetBody(title = brandString(R.string.settings_language)) {
            Column(Modifier.fillMaxWidth().selectableGroup()) {
                options.forEachIndexed { index, (language, name) ->
                    SheetChoiceRow(name, selected = language == chosen, onClick = { onChoose(language) }, divider = index < options.lastIndex)
                }
            }
        }
    }
}

/**
 * «اعلان‌ها»: the two groups sign-up asked about, each a switch («مچ‌ها و
 * لایک‌ها»، «پیام‌ها و تماس‌ها»). Until the account's own values are read
 * ([loaded]) the switches cannot be moved.
 */
@Composable
internal fun NotificationsSheet(prefs: NotificationPrefs?, loaded: Boolean, onDismiss: () -> Unit, onChange: (matches: Boolean?, messages: Boolean?) -> Unit) {
    val p = prefs ?: NotificationPrefs()
    val matches = p.matches && p.likes
    val messages = p.messages && p.calls
    AppBottomSheet(onDismissRequest = onDismiss) {
        SheetBody(title = brandString(R.string.settings_notifications)) {
            SettingsRow(brandString(R.string.onboarding_notifications_matches), end = RowEnd.Switch(matches) { onChange(it, null) }, minHeight = SettingsLayout.row, enabled = loaded)
            SettingsRow(brandString(R.string.onboarding_notifications_messages), end = RowEnd.Switch(messages) { onChange(null, it) }, divider = true, minHeight = SettingsLayout.row, enabled = loaded)
        }
    }
}

/**
 * «حریم خصوصی و ایمنی»: incognito (a plan feature: without it the switch
 * opens the plans), then what others see, each said the same way (on means
 * shown): the age, the distance, being online. Until the account's own
 * values are read ([loaded]) the switches cannot be moved.
 */
@Composable
internal fun PrivacySheet(settings: Settings?, loaded: Boolean, incognitoIncluded: Boolean, onDismiss: () -> Unit, onChange: (SettingsPatch) -> Unit) {
    val s = settings ?: Settings()
    AppBottomSheet(onDismissRequest = onDismiss) {
        SheetBody(title = brandString(R.string.settings_privacy)) {
            SettingsRow(
                brandString(R.string.settings_incognito),
                end = RowEnd.Switch(incognitoIncluded && s.incognito) { onChange(SettingsPatch(incognito = it)) },
                minHeight = SettingsLayout.row,
                enabled = loaded,
            )
            // The server keeps "hide"; the switches say "show".
            SettingsRow(brandString(R.string.settings_show_age), end = RowEnd.Switch(!s.hideAge) { onChange(SettingsPatch(hideAge = !it)) }, divider = true, minHeight = SettingsLayout.row, enabled = loaded)
            SettingsRow(brandString(R.string.settings_show_distance), end = RowEnd.Switch(!s.hideDistance) { onChange(SettingsPatch(hideDistance = !it)) }, divider = true, minHeight = SettingsLayout.row, enabled = loaded)
            SettingsRow(brandString(R.string.settings_show_online), end = RowEnd.Switch(s.showOnline) { onChange(SettingsPatch(showOnline = it)) }, divider = true, minHeight = SettingsLayout.row, enabled = loaded)
        }
    }
}

/** «حساب»: a copy of the account's data, and signing out on every device. */
@Composable
internal fun AccountSheet(exporting: Boolean, onDismiss: () -> Unit, onExport: () -> Unit, onSignOutEverywhere: () -> Unit) {
    AppBottomSheet(onDismissRequest = onDismiss) {
        SheetBody(title = brandString(R.string.settings_account)) {
            SettingsRow(brandString(R.string.settings_export), minHeight = SettingsLayout.row, onClick = if (exporting) null else onExport)
            SettingsRow(brandString(R.string.settings_sign_out_all), end = RowEnd.None, divider = true, minHeight = SettingsLayout.row, onClick = onSignOutEverywhere)
        }
    }
}

/** «کمک و پشتیبانی»: write to us (the support address, when there is one), rate us, look for an update. */
@Composable
internal fun HelpSheet(supportEmail: String, onDismiss: () -> Unit, onEmail: (String) -> Unit, onRate: () -> Unit, onUpdates: () -> Unit) {
    AppBottomSheet(onDismissRequest = onDismiss) {
        SheetBody(title = brandString(R.string.settings_help)) {
            var first = true
            if (supportEmail.isNotBlank()) {
                SettingsRow(brandString(R.string.settings_support_email), value = "\u2066$supportEmail\u2069", minHeight = SettingsLayout.row, onClick = { onEmail(supportEmail) })
                first = false
            }
            SettingsRow(brandString(R.string.settings_rate), divider = !first, minHeight = SettingsLayout.row, onClick = onRate)
            SettingsRow(brandString(R.string.settings_updates), divider = true, minHeight = SettingsLayout.row, onClick = onUpdates)
        }
    }
}

/** «قوانین و حریم خصوصی»: the terms of use, the privacy policy, our rules (each on the website) and the open-source licences. */
@Composable
internal fun LegalSheet(
    termsUrl: String,
    privacyUrl: String,
    guidelinesUrl: String,
    onDismiss: () -> Unit,
    onOpen: (String) -> Unit,
    onLicences: () -> Unit,
) {
    val links = listOfNotNull(
        termsUrl.takeIf { it.isNotBlank() }?.let { R.string.settings_terms to it },
        privacyUrl.takeIf { it.isNotBlank() }?.let { R.string.settings_privacy_policy to it },
        guidelinesUrl.takeIf { it.isNotBlank() }?.let { R.string.onboarding_rules_title to it },
    )
    AppBottomSheet(onDismissRequest = onDismiss) {
        SheetBody(title = brandString(R.string.settings_legal)) {
            links.forEachIndexed { index, (label, url) ->
                SettingsRow(brandString(label), divider = index > 0, minHeight = SettingsLayout.row, onClick = { onOpen(url) })
            }
            SettingsRow(brandString(R.string.settings_licences), divider = links.isNotEmpty(), minHeight = SettingsLayout.row, onClick = onLicences)
        }
    }
}

/**
 * «مجوزهای متن‌باز»: each bundled font with its licence text (the brand's
 * two fonts; a commercial font's licence is empty and not listed). The
 * files are read off the main thread when the sheet opens. The licences are
 * English: laid out left to right in every language, their hard-wrapped
 * lines joined into paragraphs and their dashed rules drawn as hairlines.
 */
@Composable
internal fun LicencesSheet(onDismiss: () -> Unit) {
    val t = AppTheme.template
    val resources = LocalResources.current
    val io = LocalIoDispatcher.current
    val texts by produceState<List<Pair<String, List<LicenceBlock>>>?>(null, resources) {
        val names = listOf(
            resources.getString(R.string.licences_font, resources.getString(R.string.brand_font_fa_name)) to R.raw.license_brand_fa,
            resources.getString(R.string.licences_font, resources.getString(R.string.brand_font_latin_name)) to R.raw.license_brand_latin,
        )
        value = withContext(io) {
            names.map { (name, raw) -> name to resources.openRawResource(raw).bufferedReader().use { it.readText() } }
                .filter { (_, text) -> text.isNotBlank() }
                .map { (name, text) -> name to licenceBlocks(text) }
        }
    }
    val height = with(LocalDensity.current) { LocalWindowInfo.current.containerSize.height.toDp() }
    AppBottomSheet(onDismissRequest = onDismiss) {
        SheetBody(title = brandString(R.string.settings_licences), scrollable = false) {
            Column(Modifier.fillMaxWidth().heightIn(max = height * LICENCES_HEIGHT).verticalScroll(rememberScrollState())) {
                texts.orEmpty().forEachIndexed { index, (name, blocks) ->
                    Text(
                        name,
                        style = t.type.bodyStrong,
                        color = t.colors.text,
                        modifier = Modifier.padding(top = if (index == 0) 0.dp else LicenceLayout.fontGap).semantics { heading() },
                    )
                    blocks.forEach { block ->
                        when (block) {
                            is LicenceBlock.Paragraph -> LicenceText(block.text, Modifier.padding(top = LicenceLayout.paragraphGap))
                            LicenceBlock.Rule -> HorizontalDivider(Modifier.padding(top = LicenceLayout.paragraphGap), thickness = 1.dp, color = t.colors.line)
                        }
                    }
                }
            }
        }
    }
}

/** A piece of a licence as the sheet draws it. */
internal sealed interface LicenceBlock {
    data class Paragraph(val text: String) : LicenceBlock

    /** A line of dashes in the file: a hairline. */
    data object Rule : LicenceBlock
}

/**
 * A licence file as paragraphs: blank lines split them, the lines inside one
 * are joined with spaces (the files are wrapped for a terminal), a heading in
 * capitals keeps its own line, and a line of dashes or equals signs becomes a
 * [LicenceBlock.Rule].
 */
internal fun licenceBlocks(raw: String): List<LicenceBlock> {
    val blocks = mutableListOf<LicenceBlock>()
    val lines = mutableListOf<String>()
    fun flush() {
        if (lines.isEmpty()) return
        val text = buildString {
            lines.forEachIndexed { i, line ->
                if (i > 0) append(if (isHeading(lines[i - 1])) '\n' else ' ')
                append(line)
            }
        }
        blocks += LicenceBlock.Paragraph(text)
        lines.clear()
    }
    raw.replace("\r\n", "\n").lines().forEach { rawLine ->
        val line = rawLine.trim()
        when {
            line.isEmpty() -> flush()
            line.length >= RULE_MIN && line.all { it == '-' || it == '=' } -> {
                flush()
                if (blocks.lastOrNull() != LicenceBlock.Rule) blocks += LicenceBlock.Rule
            }
            else -> lines += line
        }
    }
    flush()
    return blocks
}

/** A short line in capitals ("PREAMBLE", "PERMISSION & CONDITIONS"): a heading over its paragraph. */
private fun isHeading(line: String): Boolean = line.any { it.isLetter() } && line.none { it.isLowerCase() } && line.length <= HEADING_MAX

/** A licence's own text: English, so in the Latin face, left to right and starting at the left whatever the screen's language. */
@Composable
internal fun LicenceText(text: String, modifier: Modifier = Modifier) {
    val t = AppTheme.template
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
        Text(
            text,
            style = t.type.bodySm.copy(textDirection = TextDirection.Ltr, fontFamily = t.type.fontLat),
            color = t.colors.text2,
            modifier = modifier.fillMaxWidth(),
        )
    }
}

private const val LICENCES_HEIGHT = 0.7f
private const val RULE_MIN = 3
private const val HEADING_MAX = 40

private object LicenceLayout {
    val fontGap = 20.dp
    val paragraphGap = 8.dp
}
