package app.core.feature.legal

import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Face
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.core.LocalAppGraph
import app.core.R
import app.core.brand.AppBrand
import app.core.feature.auth.FlowScaffold
import app.core.feature.auth.NoteCard
import app.core.feature.auth.PrimaryButton
import app.core.i18n.brandString
import app.core.model.LegalVersions
import app.core.ui.theme.Space

/**
 * The privacy notice, inside the app, at the very first step: what is kept,
 * why, who sees what, for how long, and what the person can do about it,
 * with the full policy and terms one tap away. Accepting it is what the
 * basics later send as the accepted versions.
 */
@Composable
fun PrivacyNoticeScreen(
    versions: LegalVersions,
    onBack: (() -> Unit)?,
    onAccept: () -> Unit,
    busy: Boolean = false,
) {
    FlowScaffold(
        title = brandString(R.string.privacy_title),
        subtitle = brandString(R.string.privacy_intro),
        onBack = onBack,
        actions = {
            PrimaryButton(brandString(R.string.privacy_accept), onClick = onAccept, busy = busy)
            PrivacyAcceptNote(versions)
        },
    ) {
        PrivacyNoticeBody()
    }
}

/** "By continuing you accept the terms (version n) and the privacy policy (version m)", under the accept button. */
@Composable
fun PrivacyAcceptNote(versions: LegalVersions) {
    Text(
        brandString(R.string.privacy_accept_note, versions.terms, versions.privacy),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        textAlign = TextAlign.Center,
    )
}

/**
 * The notice itself (what is kept and why, who sees what, for how long, the
 * person's choices, the age line and the links to the full texts), in the
 * current Material colours: the onboarding step and the sign-in sheet frame
 * it each their own way.
 */
@Composable
fun PrivacyNoticeBody() {
    val graph = LocalAppGraph.current
    val config by graph.config.config.collectAsStateWithLifecycle()
    val uri = LocalUriHandler.current
    val privacyUrl = config?.legal?.privacyUrl?.takeIf { it.isNotBlank() } ?: AppBrand.Legal.privacyUrl
    val termsUrl = config?.legal?.termsUrl?.takeIf { it.isNotBlank() } ?: AppBrand.Legal.termsUrl
    Section(Icons.Filled.Info, R.string.privacy_collect_title, R.string.privacy_collect_body)
    Section(Icons.Filled.LocationOn, R.string.privacy_location_title, R.string.privacy_location_body)
    Section(Icons.Filled.Face, R.string.privacy_photos_title, R.string.privacy_photos_body)
    Section(Icons.Filled.Lock, R.string.privacy_visible_title, R.string.privacy_visible_body)
    Section(Icons.Filled.DateRange, R.string.privacy_keep_title, R.string.privacy_keep_body)
    Section(Icons.Filled.Delete, R.string.privacy_choices_title, R.string.privacy_choices_body)
    NoteCard {
        Text(brandString(R.string.privacy_adults), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurface)
    }
    Column {
        if (privacyUrl.isNotBlank()) {
            TextButton(onClick = { uri.openUri(privacyUrl) }) { Text(brandString(R.string.privacy_read_full)) }
        }
        if (termsUrl.isNotBlank()) {
            TextButton(onClick = { uri.openUri(termsUrl) }) { Text(brandString(R.string.terms_read_full)) }
        }
    }
}

@Composable
private fun Section(icon: ImageVector, @StringRes title: Int, @StringRes body: Int) {
    Row(Modifier.fillMaxWidth().padding(vertical = Space.xs), horizontalArrangement = Arrangement.spacedBy(Space.md)) {
        Box(
            Modifier
                .size(40.dp)
                .clip(CircleShape)
                .background(MaterialTheme.colorScheme.primaryContainer),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onPrimaryContainer, modifier = Modifier.size(22.dp))
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Space.xxs)) {
            Text(
                brandString(title),
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.semantics { heading() },
            )
            Text(brandString(body), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
