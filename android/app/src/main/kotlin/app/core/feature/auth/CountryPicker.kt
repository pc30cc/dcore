package app.core.feature.auth

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.unit.dp
import app.core.R
import app.core.i18n.AppLanguage
import app.core.i18n.Digits
import app.core.i18n.brandString
import app.core.ui.theme.Space
import java.text.Collator
import java.util.Locale

/**
 * The country list for the phone number, in a bottom sheet, searchable by
 * name (in the app's language and in English) and by calling code. The
 * country the screen started on comes first.
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
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
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
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet) {
        Column(Modifier.fillMaxWidth().imePadding()) {
            Text(
                brandString(R.string.auth_country_title),
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.padding(horizontal = Space.gutter, vertical = Space.sm),
            )
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                singleLine = true,
                leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                placeholder = { Text(brandString(R.string.auth_country_search)) },
                modifier = Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = Space.sm),
            )
            LazyColumn(Modifier.fillMaxWidth().heightIn(max = 560.dp)) {
                items(filtered, key = { it.iso }) { country ->
                    val isSelected = country == selected
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .heightIn(min = Space.minTouch + 8.dp)
                            .clickable(role = Role.RadioButton) { onPick(country) }
                            .semantics { this.selected = isSelected }
                            .padding(horizontal = Space.gutter),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(Space.md),
                    ) {
                        Text(country.flag, style = MaterialTheme.typography.titleLarge)
                        Text(
                            country.displayName(locale),
                            style = MaterialTheme.typography.bodyLarge,
                            modifier = Modifier.weight(1f),
                        )
                        Text(
                            "+${country.dialCode}",
                            style = MaterialTheme.typography.bodyMedium.copy(textDirection = TextDirection.Ltr),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        if (isSelected) Icon(Icons.Filled.Check, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                    }
                }
                if (filtered.isEmpty()) {
                    item {
                        Text(
                            brandString(R.string.auth_country_none),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(Space.gutter),
                        )
                    }
                }
            }
        }
    }
}
