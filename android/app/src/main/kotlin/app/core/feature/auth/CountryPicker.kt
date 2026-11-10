package app.core.feature.auth

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.unit.dp
import app.core.R
import app.core.i18n.AppLanguage
import app.core.i18n.Digits
import app.core.i18n.brandString
import app.core.ui.components.AppBottomSheet
import app.core.ui.components.AppTextField
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Space
import java.text.Collator
import java.util.Locale

/**
 * The country list for the phone number, in the template's bottom sheet,
 * searchable by name (in the app's language and in English) and by calling
 * code. The country the screen started on comes first; the chosen one has a
 * check at the end.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CountryPickerSheet(
    selected: DialCountry,
    home: DialCountry,
    language: AppLanguage,
    onPick: (DialCountry) -> Unit,
    onDismiss: () -> Unit,
) {
    val t = AppTheme.template
    var query by rememberSaveable { mutableStateOf("") }
    val locale = remember(language) { Locale.forLanguageTag(language.tag) }
    val sorted = remember(locale, home) {
        val collator = Collator.getInstance(locale)
        val rest = PhoneNumbers.countries.filter { it != home }.sortedWith { a, b -> collator.compare(a.displayName(locale), b.displayName(locale)) }
        listOf(home) + rest
    }
    val filtered = remember(query, sorted) {
        val q = Digits.ascii(query).trim().removePrefix("+").lowercase(locale)
        if (q.isEmpty()) sorted else sorted.filter {
            it.displayName(locale).lowercase(locale).contains(q) ||
                it.displayName(Locale.ENGLISH).lowercase(Locale.ENGLISH).contains(q) ||
                it.dialCode.startsWith(q) || it.iso.equals(q, ignoreCase = true)
        }
    }
    AppBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().imePadding()) {
            Text(
                brandString(R.string.auth_country_title),
                style = t.type.h2,
                color = t.colors.text,
                modifier = Modifier.padding(horizontal = Space.gutter, vertical = Picker.titlePad).semantics { heading() },
            )
            AppTextField(
                value = query,
                onValueChange = { query = it },
                placeholder = brandString(R.string.auth_country_search),
                modifier = Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = Picker.searchPad),
            )
            LazyColumn(Modifier.fillMaxWidth().heightIn(max = Picker.listMax)) {
                items(filtered, key = { it.iso }) { country ->
                    val isSelected = country == selected
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .heightIn(min = Picker.row)
                            .clickable(role = Role.RadioButton) { onPick(country) }
                            .semantics { this.selected = isSelected }
                            .padding(horizontal = Space.gutter),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(Picker.gap),
                    ) {
                        CountryFlag(country)
                        Text(country.displayName(locale), style = t.type.body, color = t.colors.text, modifier = Modifier.weight(1f))
                        Text(
                            Digits.localize("+${country.dialCode}", language),
                            style = t.type.bodySm.copy(textDirection = TextDirection.Ltr),
                            color = t.colors.text3,
                        )
                        if (isSelected) Icon(AppIcons.Check, contentDescription = null, tint = t.colors.primary, modifier = Modifier.size(Picker.check))
                    }
                }
                if (filtered.isEmpty()) {
                    item {
                        Text(
                            brandString(R.string.auth_country_none),
                            style = t.type.bodySm,
                            color = t.colors.text3,
                            modifier = Modifier.padding(Space.gutter),
                        )
                    }
                }
            }
        }
    }
}

private object Picker {
    val titlePad = 8.dp
    val searchPad = 8.dp
    val listMax = 560.dp
    val row = 52.dp
    val gap = 12.dp
    val check = 20.dp
}
