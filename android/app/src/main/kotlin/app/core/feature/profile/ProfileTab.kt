package app.core.feature.profile

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.BiasAlignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.traversalIndex
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import app.core.LocalAppGraph
import app.core.R
import app.core.feature.auth.brandPlural
import app.core.feature.card.DetailsSource
import app.core.feature.card.ProfileDetailsDialog
import app.core.feature.onboarding.stepErrorText
import app.core.feature.paywall.LocalPaywall
import app.core.feature.paywall.PaywallEntry
import app.core.feature.paywall.planName
import app.core.i18n.Numerals
import app.core.i18n.brandString
import app.core.i18n.screenLanguage
import app.core.model.Catalog
import app.core.model.Entitlements
import app.core.model.Me
import app.core.model.PlanKey
import app.core.model.WalletItem
import app.core.ui.components.AppIconButton
import app.core.ui.components.Avatar
import app.core.ui.components.AvatarFocus
import app.core.ui.components.closerFace
import app.core.ui.components.EmptyState
import app.core.ui.components.IconButtonKind
import app.core.ui.components.NameLine
import app.core.ui.components.PhotoScrimTop
import app.core.ui.components.PrimaryButton
import app.core.ui.components.ProgressBar
import app.core.ui.components.SecondaryButton
import app.core.ui.components.SettingsGroup
import app.core.ui.components.SettingsRow
import app.core.ui.components.listBottomPadding
import app.core.ui.components.skeleton
import app.core.ui.components.tabTopInsets
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppTheme
import app.core.ui.theme.HeroStyle
import app.core.ui.theme.Space

/**
 * The Profile tab (m16): the account as its holder sees it, by the
 * template's hero switch. Bleed (neon): the main photo as a 420 dp header
 * under the status bar with the top scrim, fading into the page, the glass
 * settings button at the top end, the name in `--type-h1` at 384 dp. Framed
 * (white): «پروفایل» with the settings icon at its end, a 112 dp round
 * photo in the middle, the name and the line centred, nothing fading.
 *
 * Then «ویرایش پروفایل» (primary) and «پیش‌نمایش» (secondary) side by
 * side, and one group: completion (a thin bar and the percentage), the
 * subscription and the super likes. Nothing else: no plan pill, no task
 * list, no icons on rows. Face verification has its row once there is a
 * flow to open from it (the badge after the name shows a verified account).
 *
 * Settings stays reachable whatever `GET /v1/me` answers: while it loads and
 * when it fails, the header keeps its settings button (signing out and
 * deleting the account live there).
 */
@Composable
fun ProfileTab(onOpenSettings: () -> Unit = {}, onOpenEdit: () -> Unit = {}) {
    val graph = LocalAppGraph.current
    val paywall = LocalPaywall.current
    val model: OwnProfileModel = viewModel(factory = viewModelFactory { initializer { OwnProfileModel(graph.api) } })
    val state by model.state.collectAsStateWithLifecycle()
    val config by graph.config.config.collectAsStateWithLifecycle()
    val entitlements by graph.entitlements.entitlements.collectAsStateWithLifecycle()
    // Each time the tab comes into view (back from editing, too): the read is revalidated, so it is cheap.
    LaunchedEffect(Unit) { model.refresh() }
    LaunchedEffect(graph) { graph.entitlements.ensure() }
    var preview by rememberSaveable { mutableStateOf(false) }

    val me = state.me
    val actions = MyProfileActions(
        onSettings = onOpenSettings,
        onEdit = onOpenEdit,
        onPreview = { preview = true },
        onPlan = { paywall.plans(PaywallEntry.GENERAL) },
        onPacks = { paywall.packs(WalletItem.Superlike, PaywallEntry.GENERAL) },
    )
    Box(Modifier.fillMaxSize().background(AppTheme.template.colors.bg)) {
        when {
            me?.profile != null -> MyProfile(me, entitlements, config?.planNames.orEmpty(), actions)
            state.loading -> MyProfileSkeleton(onOpenSettings)
            else -> MyProfileFailed(stepErrorText(state.error) ?: brandString(R.string.error_generic), onRetry = model::refresh, onOpenSettings = onOpenSettings)
        }
    }

    val profile = me?.profile
    if (preview && profile != null) {
        val card = remember(profile, config) { profile.asSeenByOthers(config?.catalog ?: Catalog()) }
        ProfileDetailsDialog(
            card = card,
            catalog = config?.catalog ?: Catalog(),
            source = DetailsSource.Match,
            onDismiss = { preview = false },
            onPass = {},
            onLike = {},
            onSuperlike = null,
            onLikeItem = {},
        )
    }
}

/** What the tab's buttons and rows do. */
class MyProfileActions(
    val onSettings: () -> Unit,
    val onEdit: () -> Unit,
    val onPreview: () -> Unit,
    val onPlan: () -> Unit,
    val onPacks: () -> Unit,
)

/** The tab drawn from [me] (its profile is there), [entitlements] and the plans' names: see [ProfileTab]. */
@Composable
fun MyProfile(me: Me, entitlements: Entitlements?, planNames: Map<String, String>, actions: MyProfileActions) {
    val t = AppTheme.template
    val profile = me.profile ?: return
    val language = screenLanguage()
    val separator = brandString(R.string.profile_list_separator)
    val city = profile.city?.name ?: me.location?.city?.name
    val meta = listOfNotNull(city, profile.job?.takeIf { it.isNotBlank() }).joinToString(separator)
    val age = profile.age?.let { Numerals.format(it, language) }
    val bleed = t.switches.hero == HeroStyle.Bleed
    val statusTop = maxOf(WindowInsets.statusBars.asPaddingValues().calculateTopPadding(), MeLayout.statusBar)
    val extra = statusTop - MeLayout.statusBar

    // The glass button sits over the photo at the top end: TalkBack reaches it first, as the eye does.
    Box(Modifier.fillMaxSize().semantics { isTraversalGroup = true }) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
            if (bleed) {
                Box(Modifier.fillMaxWidth()) {
                    Box(Modifier.fillMaxWidth().height(MeLayout.headerHeight + extra)) {
                        val photo = profile.mainPhoto
                        if (photo != null) {
                            OwnPhotoImage(photo, Modifier.fillMaxSize(), alignment = MeLayout.headerFocus)
                        } else {
                            Box(Modifier.fillMaxSize().background(t.colors.photoPlaceholder))
                        }
                        PhotoScrimTop()
                        Box(
                            Modifier
                                .align(Alignment.BottomCenter)
                                .fillMaxWidth()
                                .height(MeLayout.headerFade)
                                .background(t.paints.headerFade),
                        )
                    }
                    Identity(
                        name = profile.name,
                        age = age,
                        verified = profile.verified,
                        meta = meta,
                        centred = false,
                        actions = actions,
                        modifier = Modifier.padding(top = MeLayout.nameTopBleed + extra),
                    )
                }
                Spacer(Modifier.height(MeLayout.rowsGapBleed))
            } else {
                Column(Modifier.fillMaxWidth().tabTopInsets()) {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .padding(start = Space.gutter, end = MeLayout.headerEnd, top = MeLayout.titleTop)
                            .heightIn(min = MeLayout.titleHeight),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            brandString(R.string.tab_profile),
                            style = t.type.h1,
                            color = t.colors.text,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f).semantics { heading() },
                        )
                        AppIconButton(AppIcons.Settings, brandString(R.string.settings_title), actions.onSettings)
                    }
                    Spacer(Modifier.height(MeLayout.avatarTop))
                    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                        val photo = profile.mainPhoto
                        Avatar(MeLayout.avatar, photo = photo?.let { { OwnPhotoImage(it, Modifier.fillMaxSize().closerFace(), alignment = AvatarFocus) } })
                    }
                    Identity(
                        name = profile.name,
                        age = age,
                        verified = profile.verified,
                        meta = meta,
                        centred = true,
                        actions = actions,
                        modifier = Modifier.padding(top = MeLayout.nameTopFramed),
                    )
                }
                Spacer(Modifier.height(MeLayout.rowsGapFramed))
            }
            Rows(profile.completeness, entitlements, planNames, actions)
            Spacer(Modifier.height(listBottomPadding))
        }
        if (bleed) {
            AppIconButton(
                AppIcons.Settings,
                brandString(R.string.settings_title),
                actions.onSettings,
                kind = IconButtonKind.Glass,
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(top = statusTop + MeLayout.titleTop, end = MeLayout.glassEnd)
                    .semantics { traversalIndex = -1f },
            )
        }
    }
}

/** Name, age and badge; the city and the job; the two buttons. */
@Composable
private fun Identity(
    name: String,
    age: String?,
    verified: Boolean,
    meta: String,
    centred: Boolean,
    actions: MyProfileActions,
    modifier: Modifier = Modifier,
) {
    val t = AppTheme.template
    Column(
        modifier.fillMaxWidth().padding(horizontal = Space.gutter),
        horizontalAlignment = if (centred) Alignment.CenterHorizontally else Alignment.Start,
    ) {
        NameLine(name, age, verified = verified, onPhoto = false)
        if (meta.isNotBlank()) {
            Text(
                meta,
                style = t.type.body,
                color = t.colors.text2,
                textAlign = if (centred) TextAlign.Center else TextAlign.Start,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Spacer(Modifier.height(MeLayout.buttonsTop))
        TwoButtons(
            first = { PrimaryButton(brandString(R.string.me_edit), actions.onEdit, medium = true) },
            second = { SecondaryButton(brandString(R.string.me_preview), actions.onPreview, medium = true) },
        )
    }
}

/**
 * Two buttons side by side, each half the width, while both labels fit
 * their half; one under the other when one would not (large text): a label
 * is never cut short.
 */
@Composable
private fun TwoButtons(first: @Composable () -> Unit, second: @Composable () -> Unit) {
    val gap = MeLayout.buttonGap
    Layout(content = { first(); second() }, modifier = Modifier.fillMaxWidth()) { measurables, constraints ->
        val gapPx = gap.roundToPx()
        val width = constraints.maxWidth
        val half = (width - gapPx) / 2
        val sideBySide = measurables.all { it.maxIntrinsicWidth(Constraints.Infinity) <= half }
        if (sideBySide) {
            val placed = measurables.map { it.measure(Constraints.fixedWidth(half)) }
            val height = placed.maxOf { it.height }
            layout(width, height) {
                placed[0].placeRelative(0, (height - placed[0].height) / 2)
                placed[1].placeRelative(half + gapPx, (height - placed[1].height) / 2)
            }
        } else {
            val placed = measurables.map { it.measure(Constraints.fixedWidth(width)) }
            layout(width, placed.sumOf { it.height } + gapPx) {
                placed[0].placeRelative(0, 0)
                placed[1].placeRelative(0, placed[0].height + gapPx)
            }
        }
    }
}

/**
 * Completion, the plan, the super likes. The plan and the super likes say
 * nothing until the entitlements are read (a paying account never sees
 * «رایگان» on the way).
 */
@Composable
private fun Rows(completeness: Int, entitlements: Entitlements?, planNames: Map<String, String>, actions: MyProfileActions) {
    val language = screenLanguage()
    val superlikes = entitlements?.wallet?.superlike ?: 0
    SettingsGroup(Modifier.padding(horizontal = Space.gutter)) {
        val percent = completeness.coerceIn(0, 100)
        SettingsRow(
            brandString(R.string.me_complete),
            value = Numerals.percent(percent, language),
            minHeight = MeLayout.row,
            below = {
                Spacer(Modifier.height(MeLayout.barTop))
                ProgressBar(percent / 100f)
            },
            onClick = actions.onEdit,
        )
        SettingsRow(
            brandString(R.string.me_plan),
            value = planValue(entitlements, planNames),
            divider = true,
            minHeight = MeLayout.row,
            onClick = actions.onPlan,
        )
        SettingsRow(
            brandString(R.string.me_packs),
            value = entitlements?.let { brandPlural(R.plurals.me_packs_value, superlikes, Numerals.format(superlikes, language)) },
            divider = true,
            minHeight = MeLayout.row,
            onClick = actions.onPacks,
        )
    }
}

/** The plan's name, «رایگان» on the free plan, nothing while the entitlements are not read yet. */
@Composable
internal fun planValue(entitlements: Entitlements?, planNames: Map<String, String>): String? {
    entitlements ?: return null
    val plan = entitlements.plan.takeIf(PlanKey::isPaid)
    return plan?.let { planName(it, planNames) } ?: brandString(R.string.me_free)
}

/** The header row while there is no profile to draw (loading, failed): the settings button at its end. */
@Composable
private fun SettingsHeader(onOpenSettings: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(start = Space.gutter, end = MeLayout.headerEnd, top = MeLayout.titleTop)
            .heightIn(min = MeLayout.titleHeight),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Spacer(Modifier.weight(1f))
        AppIconButton(AppIcons.Settings, brandString(R.string.settings_title), onOpenSettings)
    }
}

/** The account could not be read: why, «دوباره امتحان کن», and the settings button where it always is. */
@Composable
internal fun MyProfileFailed(text: String, onRetry: () -> Unit, onOpenSettings: () -> Unit) {
    Column(Modifier.fillMaxSize().tabTopInsets()) {
        SettingsHeader(onOpenSettings)
        Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
            EmptyState(title = text, action = brandString(R.string.action_try_again), onAction = onRetry)
        }
    }
}

/** While the first read is on its way: the frame with grey blocks where the name and the rows go. */
@Composable
private fun MyProfileSkeleton(onOpenSettings: () -> Unit) {
    val t = AppTheme.template
    Column(Modifier.fillMaxSize().tabTopInsets()) {
        SettingsHeader(onOpenSettings)
        Column(Modifier.fillMaxWidth().padding(horizontal = Space.gutter)) {
            Spacer(Modifier.height(MeLayout.avatarTop))
            Box(Modifier.align(Alignment.CenterHorizontally).size(MeLayout.avatar).clip(CircleShape).skeleton(CircleShape))
            Spacer(Modifier.height(MeLayout.nameTopFramed))
            Box(Modifier.align(Alignment.CenterHorizontally).size(MeLayout.skeletonNameWidth, MeLayout.skeletonNameHeight).skeleton(CircleShape))
            Spacer(Modifier.height(MeLayout.skeletonRowsTop))
            Box(Modifier.fillMaxWidth().height(MeLayout.row * 3).skeleton(androidx.compose.foundation.shape.RoundedCornerShape(t.radii.card)))
        }
    }
}

/** The design's own profile (dp from the screen's top on a phone with a 32 dp status bar). */
private object MeLayout {
    val statusBar: Dp = 32.dp
    val headerHeight: Dp = 420.dp
    val headerFade: Dp = 150.dp
    /** The photo's subject sits near its top (`50% 8%`). */
    val headerFocus = BiasAlignment(0f, -0.84f)
    val nameTopBleed: Dp = 384.dp
    val glassEnd: Dp = 12.dp
    val titleTop: Dp = 12.dp
    val titleHeight: Dp = 52.dp
    val headerEnd: Dp = 8.dp
    val avatarTop: Dp = 12.dp
    val avatar: Dp = 112.dp
    val nameTopFramed: Dp = 16.dp
    val buttonsTop: Dp = 18.dp
    val buttonGap: Dp = 10.dp
    val rowsGapBleed: Dp = 24.dp
    val rowsGapFramed: Dp = 22.dp
    val row: Dp = 58.dp
    val barTop: Dp = 8.dp
    val skeletonNameWidth: Dp = 140.dp
    val skeletonNameHeight: Dp = 22.dp
    /** The name line, the meta line and the buttons a skeleton stands in for. */
    val skeletonRowsTop: Dp = 82.dp
}
