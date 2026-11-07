package app.core.feature.deck

import androidx.annotation.DrawableRes
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RangeSlider
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import app.core.R
import app.core.feature.card.LikeTarget
import app.core.feature.card.rememberNumbers
import app.core.feature.card.rememberTimeOfDay
import app.core.i18n.brandString
import app.core.media.PhotoImage
import app.core.model.DiscoveryPreferences
import app.core.model.ItemKind
import app.core.model.PreferencesPatch
import app.core.model.SwipeAction
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Radius
import app.core.ui.theme.Space
import java.time.Instant
import kotlin.math.roundToInt

/** "Plus / Premium", or null when the config has no plan names. */
fun planLine(planNames: Map<String, String>): String? =
    listOf("plus", "premium").mapNotNull { planNames[it]?.takeIf(String::isNotBlank) }
        .ifEmpty { planNames.values.filter(String::isNotBlank) }
        .takeIf { it.isNotEmpty() }
        ?.joinToString(" / ")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Sheet(onDismiss: () -> Unit, content: @Composable () -> Unit) {
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = state) {
        // Scrolls when large text makes it taller than the screen.
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .navigationBarsPadding()
                .padding(start = Space.xl, end = Space.xl, bottom = Space.xl),
            verticalArrangement = Arrangement.spacedBy(Space.md),
        ) { content() }
    }
}

@Composable
private fun SheetBadge(@DrawableRes icon: Int?, colour: Color, vector: androidx.compose.ui.graphics.vector.ImageVector? = null) {
    Box(
        Modifier
            .size(64.dp)
            .clip(CircleShape)
            .background(colour.copy(alpha = 0.14f)),
        contentAlignment = Alignment.Center,
    ) {
        when {
            icon != null -> Icon(painterResource(icon), null, tint = colour, modifier = Modifier.size(32.dp))
            vector != null -> Icon(vector, null, tint = colour, modifier = Modifier.size(32.dp))
        }
    }
}

/**
 * A feature this account's plan does not include. The paywall is not built
 * yet, so the sheet says which plans include it and, plainly, that they
 * cannot be bought in this version.
 */
@Composable
fun UpsellSheet(
    title: String,
    body: String,
    planNames: Map<String, String>,
    onDismiss: () -> Unit,
    @DrawableRes icon: Int? = null,
    vector: androidx.compose.ui.graphics.vector.ImageVector? = null,
) {
    Sheet(onDismiss) {
        SheetBadge(icon, MaterialTheme.colorScheme.primary, vector)
        Text(title, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.semantics { heading() })
        Text(body, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        val plans = planLine(planNames)
        Text(
            if (plans != null) brandString(R.string.upsell_plans, plans) else brandString(R.string.upsell_plans_generic),
            style = MaterialTheme.typography.titleSmall,
        )
        Text(brandString(R.string.upsell_not_yet), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Button(onClick = onDismiss, modifier = Modifier.fillMaxWidth().heightIn(min = Space.minTouch)) {
            Text(brandString(R.string.action_got_it))
        }
    }
}

/** Out of likes or super likes: when they come back, and what includes more. */
@Composable
fun QuotaSheet(action: SwipeAction, resetsAt: Instant?, planNames: Map<String, String>, onDismiss: () -> Unit) {
    val time = rememberTimeOfDay()
    Sheet(onDismiss) {
        val superlike = action == SwipeAction.Superlike
        SheetBadge(
            icon = null,
            colour = if (superlike) AppTheme.colors.superLike else AppTheme.colors.like,
            vector = if (superlike) Icons.Filled.Star else Icons.Filled.Favorite,
        )
        Text(
            brandString(if (superlike) R.string.deck_out_of_superlikes_title else R.string.deck_out_of_likes_title),
            style = MaterialTheme.typography.headlineSmall,
            modifier = Modifier.semantics { heading() },
        )
        Text(
            if (resetsAt != null) brandString(R.string.deck_quota_resets, time(resetsAt)) else brandString(R.string.deck_quota_resets_soon),
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        val plans = planLine(planNames)
        Text(
            if (plans != null) brandString(R.string.upsell_plans, plans) else brandString(R.string.upsell_plans_generic),
            style = MaterialTheme.typography.titleSmall,
        )
        Button(onClick = onDismiss, modifier = Modifier.fillMaxWidth().heightIn(min = Space.minTouch)) {
            Text(brandString(R.string.action_got_it))
        }
    }
}

/**
 * The like on one photo or one answer: the part itself, an optional comment
 * (the config's limit, 300 by default), and send. It stays open until the
 * server answered; a refused comment can be edited and sent again.
 */
@Composable
fun ItemLikeSheet(
    target: LikeTarget,
    state: ItemLikeState,
    commentMax: Int,
    onSend: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    var comment by rememberSaveable(target.card.id, target.item.ref) { mutableStateOf("") }
    val number = rememberNumbers()
    Sheet(onDismiss) {
        val photo = target.photoIndex?.let { target.card.photos.getOrNull(it) }
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (target.item.kind == ItemKind.Photo && photo != null) {
                PhotoImage(photo, null, Modifier.size(width = 64.dp, height = 80.dp).clip(RoundedCornerShape(Radius.md)))
                Spacer(Modifier.width(Space.md))
            }
            Text(
                brandString(if (target.item.kind == ItemKind.Photo) R.string.like_item_photo_title else R.string.like_item_prompt_title, target.card.name),
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.weight(1f).semantics { heading() },
            )
        }
        if (target.item.kind == ItemKind.Prompt) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(Radius.lg))
                    .background(MaterialTheme.colorScheme.surfaceContainerHigh)
                    .padding(Space.lg),
                verticalArrangement = Arrangement.spacedBy(Space.xs),
            ) {
                target.question?.let { Text(it, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                target.promptText?.let { Text(it, style = MaterialTheme.typography.titleMedium) }
            }
        }
        OutlinedTextField(
            value = comment,
            onValueChange = { comment = it.take(commentMax) },
            label = { Text(brandString(R.string.like_item_comment_label)) },
            placeholder = { Text(brandString(R.string.like_item_comment_hint)) },
            supportingText = {
                Text(
                    brandString(R.string.like_item_counter, number(comment.length), number(commentMax)),
                    modifier = Modifier.fillMaxWidth(),
                    textAlign = TextAlign.End,
                )
            },
            isError = state.error == ItemLikeError.Refused,
            enabled = !state.sending,
            minLines = 2,
            maxLines = 5,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
            modifier = Modifier.fillMaxWidth(),
        )
        state.error?.let { error ->
            Text(
                brandString(
                    when (error) {
                        ItemLikeError.Refused -> R.string.like_item_refused
                        ItemLikeError.Offline -> R.string.like_item_offline
                        ItemLikeError.Failed -> R.string.like_item_failed
                    },
                ),
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            )
        }
        Button(
            onClick = { onSend(comment) },
            enabled = !state.sending,
            modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
        ) {
            Text(brandString(if (state.sending) R.string.like_item_sending else R.string.like_item_send), style = MaterialTheme.typography.titleMedium)
        }
    }
}

/**
 * Who the deck shows: distance (or the whole country), ages and verified
 * only. One `PATCH /v1/me/preferences` on "Show people", never one per
 * slider move (the server limits distance changes per day).
 */
@Composable
fun FiltersSheet(
    preferences: DiscoveryPreferences?,
    saving: Boolean,
    onApply: (PreferencesPatch) -> Unit,
    onDismiss: () -> Unit,
) {
    val number = rememberNumbers()
    val start = preferences ?: DiscoveryPreferences()
    var distance by remember(preferences) { mutableFloatStateOf(start.maxDistanceKm.coerceIn(MIN_KM, Widening.MAX_DISTANCE_KM).toFloat()) }
    var wholeCountry by remember(preferences) { mutableStateOf(start.wholeCountry) }
    var ages by remember(preferences) { mutableStateOf(start.ageMin.toFloat()..start.ageMax.toFloat()) }
    var verifiedOnly by remember(preferences) { mutableStateOf(start.verifiedOnly) }

    Sheet(onDismiss) {
        Text(brandString(R.string.filters_title), style = MaterialTheme.typography.headlineSmall, modifier = Modifier.semantics { heading() })

        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(brandString(R.string.filters_distance), style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
            Text(brandString(R.string.filters_distance_value, number(distance.roundToInt())), style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary)
        }
        Slider(
            value = distance,
            onValueChange = { distance = it },
            valueRange = MIN_KM.toFloat()..Widening.MAX_DISTANCE_KM.toFloat(),
            enabled = !wholeCountry,
        )
        SwitchRow(brandString(R.string.filters_whole_country), wholeCountry) { wholeCountry = it }

        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(brandString(R.string.filters_age), style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
            Text(
                brandString(R.string.filters_age_value, number(ages.start.roundToInt()), number(ages.endInclusive.roundToInt())),
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.primary,
            )
        }
        RangeSlider(
            value = ages,
            onValueChange = { range ->
                // Keep at least a few years between the two ends.
                ages = if (range.endInclusive - range.start < MIN_AGE_GAP) ages else range
            },
            valueRange = Widening.MIN_AGE.toFloat()..Widening.MAX_AGE.toFloat(),
        )
        SwitchRow(brandString(R.string.filters_verified_only), verifiedOnly) { verifiedOnly = it }

        Button(
            onClick = {
                val km = distance.roundToInt()
                val min = ages.start.roundToInt()
                val max = ages.endInclusive.roundToInt()
                onApply(
                    PreferencesPatch(
                        maxDistanceKm = km.takeIf { it != start.maxDistanceKm },
                        wholeCountry = wholeCountry.takeIf { it != start.wholeCountry },
                        ageMin = min.takeIf { it != start.ageMin },
                        ageMax = max.takeIf { it != start.ageMax },
                        verifiedOnly = verifiedOnly.takeIf { it != start.verifiedOnly },
                    ),
                )
            },
            enabled = !saving,
            modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
        ) {
            Text(brandString(if (saving) R.string.filters_saving else R.string.filters_apply), style = MaterialTheme.typography.titleMedium)
        }
    }
}

@Composable
private fun SwitchRow(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    // The whole row is the switch, for a large target and one TalkBack stop.
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = Space.minTouch)
            .toggleable(value = checked, role = Role.Switch, onValueChange = onChange),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = null)
    }
}

private const val MIN_KM = 2
private const val MIN_AGE_GAP = 2f
