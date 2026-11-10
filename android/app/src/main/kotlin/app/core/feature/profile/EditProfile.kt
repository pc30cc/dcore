package app.core.feature.profile

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import app.core.LocalAppGraph
import app.core.R
import app.core.feature.card.DetailsSource
import app.core.feature.card.ProfileDetailsDialog
import app.core.feature.onboarding.PhotoGridView
import app.core.feature.onboarding.PhotoPicking
import app.core.feature.onboarding.photosErrorText
import app.core.feature.onboarding.stepErrorText
import app.core.i18n.Numerals
import app.core.i18n.brandString
import app.core.i18n.screenLanguage
import app.core.model.Catalog
import app.core.model.FieldDef
import app.core.model.OwnProfile
import app.core.ui.components.AppBarTitle
import app.core.ui.components.EmptyState
import app.core.ui.components.HelperLine
import app.core.ui.components.PushedAppBar
import app.core.ui.components.SectionLabel
import app.core.ui.components.SettingsGroup
import app.core.ui.components.SettingsRow
import app.core.ui.components.TextAction
import app.core.ui.components.skeleton
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppTheme
import app.core.ui.theme.Space

/** The sheet open over the editor (by what it edits), kept across a configuration change. */
internal sealed interface EditSheet : java.io.Serializable {
    /** Another question: the catalogue to pick from. */
    data object Pick : EditSheet

    /** Writing [promptId]'s answer, in place of the one at [position] (null: a new one). */
    data class Answer(val promptId: Int, val position: Int?) : EditSheet

    /** A different question in place of the one at [position]. */
    data class Change(val position: Int) : EditSheet

    data class Field(val fieldId: Int) : EditSheet

    data object Job : EditSheet

    data object About : EditSheet
}

/**
 * The profile editor (m17), over the tabs: the app bar with «پیش‌نمایش» at
 * its end, then three sections, each a plain label with a count at its end:
 * «عکس‌ها» (the three-column grid: remove, «اصلی», «در حال بررسی»; hold and
 * drag to reorder; the empty slots add), «سؤال‌ها» (each answer as a row
 * under its question, «یه سؤال دیگه» while there is room) and «درباره‌ی من»
 * (the catalogue's fields and the job, each with its value, then the about
 * text itself, under the section's own label). Every row opens a sheet that
 * saves it on its own; the bottom of the page fades out under the edge. The
 * grid shows every slot the account may fill, as its count says.
 */
@Composable
fun EditProfileRoute(onBack: () -> Unit) {
    val graph = LocalAppGraph.current
    val model: EditProfileModel = viewModel(
        factory = viewModelFactory {
            initializer { EditProfileModel(graph.api, graph.ownPhotos, graph.clock) { graph.config.config.value } }
        },
    )
    val state by model.state.collectAsStateWithLifecycle()
    val config by graph.config.config.collectAsStateWithLifecycle()
    var sheet by rememberSaveable { mutableStateOf<EditSheet?>(null) }
    var preview by rememberSaveable { mutableStateOf(false) }
    val t = AppTheme.template
    val profile = state.profile
    val catalog = config?.catalog ?: Catalog()

    Box(Modifier.fillMaxSize().background(t.colors.bg)) {
        Column(Modifier.fillMaxSize()) {
            PushedAppBar(
                onBack,
                actions = { if (profile != null) TextAction(brandString(R.string.me_preview), { preview = true }) },
            ) { AppBarTitle(brandString(R.string.me_edit)) }
            when {
                profile != null -> EditorBody(model, profile, catalog, onOpen = { sheet = it })
                state.loading -> EditorSkeleton()
                else -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    EmptyState(
                        title = stepErrorText(state.loadError) ?: brandString(R.string.error_generic),
                        action = brandString(R.string.action_try_again),
                        onAction = model::load,
                    )
                }
            }
        }
    }

    if (profile != null) {
        EditSheets(sheet, model, profile, catalog, saving = state.saving, onSheet = { sheet = it })
        if (preview) {
            val card = remember(profile, catalog) { profile.asSeenByOthers(catalog) }
            ProfileDetailsDialog(
                card = card,
                catalog = catalog,
                source = DetailsSource.Match,
                onDismiss = { preview = false },
                onPass = {},
                onLike = {},
                onSuperlike = null,
                onLikeItem = {},
            )
        }
    }
}

@Composable
private fun EditorBody(model: EditProfileModel, profile: OwnProfile, catalog: Catalog, onOpen: (EditSheet) -> Unit) {
    val t = AppTheme.template
    val language = screenLanguage()
    val photos by model.photos.state.collectAsStateWithLifecycle()
    var failedToOpen by remember { mutableStateOf(false) }
    val navigation = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    val prompts = model.prompts()
    val answered = model.answered().size
    val max = model.promptsMax()

    Box(Modifier.fillMaxSize()) {
        PhotoPicking(model.photos, onOpenFailed = { failedToOpen = it }, add = model::addPhoto) { pick ->
            Column(
                Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(start = Space.gutter, end = Space.gutter, top = EditLayout.top, bottom = EditLayout.fade + navigation),
            ) {
                val count = photos.uploaded.size
                SectionLabel(
                    brandString(R.string.edit_photos),
                    Modifier.padding(bottom = EditLayout.labelBottom),
                    end = brandString(R.string.edit_count, Numerals.format(count, language), Numerals.format(photos.max, language)),
                )
                PhotoGridView(
                    photos = photos,
                    onAdd = pick,
                    onRetry = model.photos::retry,
                    onMove = model.photos::move,
                    onRemove = model.photos::remove,
                )
                val photoError = if (failedToOpen) brandString(R.string.onboarding_photos_open_failed) else photosErrorText(photos)
                if (photoError != null) HelperLine(photoError, Modifier.padding(top = EditLayout.errorTop), error = true)

                SectionLabel(
                    brandString(R.string.edit_prompts),
                    Modifier.padding(top = EditLayout.sectionTop, bottom = EditLayout.labelBottom),
                    end = brandString(R.string.edit_count, Numerals.format(answered, language), Numerals.format(max, language)),
                )
                SettingsGroup {
                    prompts.forEachIndexed { index, prompt ->
                        val question = catalog.prompts.firstOrNull { it.id == prompt.promptId }?.text.orEmpty()
                        SettingsRow(
                            prompt.answer.orEmpty(),
                            overline = question,
                            titleLines = 2,
                            divider = index > 0,
                            minHeight = EditLayout.row,
                            ownWords = true,
                            onClick = { onOpen(EditSheet.Answer(prompt.promptId, prompt.position)) },
                        )
                    }
                    val left = catalog.prompts.any { c -> c.category != VOICE && model.answered().none { it.promptId == c.id } }
                    if (answered < max && left) AddRow(brandString(R.string.onboarding_prompts_add), divider = prompts.isNotEmpty()) { onOpen(EditSheet.Pick) }
                }

                SectionLabel(brandString(R.string.edit_about), Modifier.padding(top = EditLayout.sectionTop, bottom = EditLayout.labelBottom))
                SettingsGroup {
                    val separator = brandString(R.string.profile_list_separator)
                    val notSet = brandString(R.string.onboarding_fields_not_set)
                    val fields = model.fields()
                    val values = profile.fields.associateBy { it.fieldId }
                    // The job sits after the first field (height), as the design lists them.
                    val rows = buildList<@Composable (Boolean) -> Unit> {
                        fields.forEach { field ->
                            add { divider ->
                                SettingsRow(
                                    field.label,
                                    value = fieldValueText(field, values[field.id], language, separator) ?: notSet,
                                    divider = divider,
                                    minHeight = EditLayout.row,
                                    onClick = { onOpen(EditSheet.Field(field.id)) },
                                )
                            }
                        }
                        add(minOf(1, size)) { divider ->
                            SettingsRow(
                                brandString(R.string.edit_work),
                                value = profile.job?.takeIf { it.isNotBlank() } ?: notSet,
                                divider = divider,
                                minHeight = EditLayout.row,
                                ownWords = true,
                                onClick = { onOpen(EditSheet.Job) },
                            )
                        }
                        // The bio is a row like the others: its label, then the text on one line (ellipsized), or «انتخاب نشده».
                        add { divider ->
                            SettingsRow(
                                brandString(R.string.edit_bio),
                                value = profile.about?.takeIf { it.isNotBlank() }?.replace(LINE_BREAKS, " ") ?: notSet,
                                divider = divider,
                                minHeight = EditLayout.row,
                                ownWords = true,
                                onClick = { onOpen(EditSheet.About) },
                            )
                        }
                    }
                    rows.forEachIndexed { index, row -> row(index > 0) }
                }
            }
        }
        // The page fades out under the bottom edge (`--bg` from 70 %).
        Box(
            Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .height(EditLayout.fade + navigation)
                .background(Brush.verticalGradient(0f to Color.Transparent, 0.7f to t.colors.bg)),
        )
    }
}

/** «یه سؤال دیگه»: the add mark and the label in `--primary`. */
@Composable
private fun AddRow(label: String, divider: Boolean, onClick: () -> Unit) {
    val t = AppTheme.template
    Column(Modifier.fillMaxWidth()) {
        if (divider) HorizontalDivider(thickness = 1.dp, color = t.colors.line)
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = EditLayout.row)
                .clickable(role = Role.Button, onClick = onClick)
                .padding(vertical = EditLayout.rowPad),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(EditLayout.rowGap),
        ) {
            Icon(AppIcons.Plus, contentDescription = null, tint = t.colors.primary, modifier = Modifier.size(EditLayout.addIcon))
            Text(label, style = t.type.bodyStrong, color = t.colors.primary, modifier = Modifier.weight(1f))
        }
    }
}

@Composable
private fun EditorSkeleton() {
    val t = AppTheme.template
    Column(Modifier.fillMaxSize().padding(start = Space.gutter, end = Space.gutter, top = EditLayout.top + EditLayout.skeletonLabel)) {
        Row(horizontalArrangement = Arrangement.spacedBy(EditLayout.tileGap)) {
            repeat(3) {
                Box(Modifier.weight(1f).aspectRatio(EditLayout.tileAspect).skeleton(androidx.compose.foundation.shape.RoundedCornerShape(t.radii.tile)))
            }
        }
        Spacer(Modifier.height(EditLayout.sectionTop + EditLayout.skeletonLabel))
        Box(Modifier.fillMaxWidth().height(EditLayout.row * 3).skeleton(androidx.compose.foundation.shape.RoundedCornerShape(t.radii.card)))
    }
}

private const val VOICE = "voice"

/** The editor on the design's phone (dp). */
internal object EditLayout {
    val top: Dp = 18.dp
    val labelBottom: Dp = 10.dp
    val sectionTop: Dp = 22.dp
    val row: Dp = 60.dp
    val rowPad: Dp = 8.dp
    val rowGap: Dp = 12.dp
    val addIcon: Dp = 20.dp
    val errorTop: Dp = 10.dp
    val fade: Dp = 110.dp
    val tileGap: Dp = 10.dp
    /** A section label's line: what a skeleton leaves for it. */
    val skeletonLabel: Dp = 30.dp
    const val tileAspect: Float = 3f / 4f
}

/** Whether [field] is a height in centimetres (shown «۱۷۸ سانت», as on the profile). */
internal fun FieldDef.isCentimetres(): Boolean =
    kind == "number" && (unit.equals("cm", ignoreCase = true) || (unit.isNullOrEmpty() && key == "height"))

private val LINE_BREAKS = Regex("\\s*\\n\\s*")
