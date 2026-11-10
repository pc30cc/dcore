package app.core.feature.deck

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import app.core.LocalAppGraph
import app.core.R
import app.core.feature.card.DetailsNotice
import app.core.feature.card.DetailsSource
import app.core.feature.card.LikeTarget
import app.core.feature.card.ProfileDetailsDialog
import app.core.feature.card.rememberNumbers
import app.core.feature.card.rememberTimeOfDay
import app.core.feature.chat.ReportSheet
import app.core.feature.match.MatchMomentDialog
import app.core.feature.match.matchOpeners
import app.core.i18n.brandString
import app.core.media.CoilPhotoPreloader
import app.core.model.BoostKind
import app.core.model.BoostStarted
import app.core.model.Catalog
import app.core.model.FieldDef
import app.core.model.DeckSuggestion
import app.core.model.DiscoveryPreferences
import app.core.model.Id
import app.core.model.Me
import app.core.model.PreferencesPatch
import app.core.model.ProfileCard
import app.core.model.PublicUid
import app.core.model.ReportReason
import app.core.model.ReportRequest
import app.core.model.Settings
import app.core.model.SettingsPatch
import app.core.model.SwipeAction
import app.core.net.ServerApi
import app.core.net.internetAvailability
import app.core.sync.DeckBlock
import app.core.sync.DeckStatus
import app.core.ui.components.AppDialog
import app.core.ui.components.AppIconButton
import app.core.ui.components.AppSnackbar
import app.core.ui.components.DeckActions
import app.core.ui.components.GlassBackdrop
import app.core.ui.components.IconButtonKind
import app.core.ui.components.LocalTabBarSpace
import app.core.ui.components.LogoMark
import app.core.ui.components.SecondaryButton
import app.core.ui.components.TextAction
import app.core.ui.components.glassSource
import app.core.ui.components.rememberGlassBackdrop
import app.core.ui.components.skeleton
import app.core.ui.icons.AppIcons
import app.core.ui.theme.AppTheme
import app.core.ui.theme.DeckStyle
import app.core.ui.theme.Space
import java.time.Instant

/** Everything the deck screen can ask for. */
interface DeckActions {
    fun swiped(card: ProfileCard, action: SwipeAction)
    fun returnShown(id: String)
    fun openDetails(card: ProfileCard)
    fun closeDetails()
    fun fromDetails(action: SwipeAction)
    fun openItemLike(target: LikeTarget)
    fun sendItemLike(target: LikeTarget, comment: String)
    fun rewind()
    fun openFilters()
    fun applyFilters(patch: PreferencesPatch)
    fun widenDistance()
    fun widenAge()
    fun boost()
    fun wakeUp()
    fun retry()
    fun dismissSheet()
    fun dismissMatch()
    fun messageShown(id: Long)
    fun openChat(conversationId: Id?)
    fun openProfile()

    /** Write to [card] before matching (a message request); null-op where the screen offers none. */
    fun writeTo(card: ProfileCard) {}

    /** The like-a-photo sheet's super like: the same item and note, sent as a super like. */
    fun sendItemSuperlike(target: LikeTarget, comment: String) {}

    /** A report on [card] from their profile; [block] blocks them too. */
    fun report(card: ProfileCard, reason: ReportReason, details: String?, block: Boolean) {}

    /** Blocks [card] from their profile. */
    fun block(card: ProfileCard) {}
}

/** The real server behind the deck screen's extra calls. */
class ServerDeckServices(private val api: ServerApi) : DeckServices {
    override suspend fun me(): Me = api.me().value
    override suspend fun updatePreferences(patch: PreferencesPatch): DiscoveryPreferences = api.updatePreferences(patch)
    override suspend fun updateSettings(patch: SettingsPatch): Settings = api.updateSettings(patch)
    override suspend fun boost(): BoostStarted = api.boost(BoostKind.Boost)
    override suspend fun report(request: ReportRequest) {
        api.report(request)
    }
    override suspend fun block(target: PublicUid) = api.block(target)
}

/**
 * The Discover tab. [onOpenChat] is "send a message" after a match (the
 * chat itself is another feature); [onOpenProfile] leads to the profile when
 * it is not finished. [backdrop] is what the tab bar's glass blurs (the
 * card's photo); [onPhotoBehindBar] says whether a photo runs under the bar.
 */
@Composable
fun DeckRoute(
    onOpenChat: (Id?) -> Unit,
    onOpenProfile: () -> Unit,
    modifier: Modifier = Modifier,
    backdrop: GlassBackdrop? = null,
    onPhotoBehindBar: (Boolean) -> Unit = {},
) {
    val graph = LocalAppGraph.current
    val context = LocalContext.current
    val vm: DeckViewModel = viewModel {
        DeckViewModel(graph.deck, graph.entitlements, ServerDeckServices(graph.api), CoilPhotoPreloader(context.applicationContext), graph.paywall)
    }
    val state by vm.state.collectAsStateWithLifecycle()
    val config by graph.config.config.collectAsStateWithLifecycle()

    LifecycleStartEffect(vm) {
        vm.start()
        onStopOrDispose { vm.stop() }
    }
    LaunchedEffect(vm) {
        context.internetAvailability().collect { online -> if (online) vm.online() }
    }

    val open by rememberUpdatedState(onOpenChat)
    val profile by rememberUpdatedState(onOpenProfile)
    // Whom the request is for survives the activity being made again (the sheet keeps its own text); looked up by id.
    var writingToId by rememberSaveable { mutableStateOf<String?>(null) }
    val actions = remember(vm) {
        object : DeckActions {
            override fun swiped(card: ProfileCard, action: SwipeAction) = vm.swiped(card, action)
            override fun returnShown(id: String) = vm.returnShown(id)
            override fun openDetails(card: ProfileCard) = vm.openDetails(card)
            override fun closeDetails() = vm.closeDetails()
            override fun fromDetails(action: SwipeAction) = vm.fromDetails(action)
            override fun openItemLike(target: LikeTarget) = vm.openItemLike(target)
            override fun sendItemLike(target: LikeTarget, comment: String) = vm.sendItemLike(target, comment)
            override fun sendItemSuperlike(target: LikeTarget, comment: String) = vm.sendItemLike(target, comment, SwipeAction.Superlike)
            override fun rewind() = vm.rewind()
            override fun openFilters() = vm.openFilters()
            override fun applyFilters(patch: PreferencesPatch) = vm.applyFilters(patch)
            override fun widenDistance() = vm.widenDistance()
            override fun widenAge() = vm.widenAge()
            override fun boost() = vm.boost()
            override fun wakeUp() = vm.wakeUp()
            override fun retry() = vm.retry()
            override fun dismissSheet() = vm.dismissSheet()
            override fun dismissMatch() = vm.dismissMatch()
            override fun messageShown(id: Long) = vm.messageShown(id)
            override fun openChat(conversationId: Id?) = open(conversationId)
            override fun openProfile() = profile()
            override fun writeTo(card: ProfileCard) {
                writingToId = card.id
            }
            override fun report(card: ProfileCard, reason: ReportReason, details: String?, block: Boolean) = vm.report(card, reason, details, block)
            override fun block(card: ProfileCard) = vm.block(card)
        }
    }
    DeckScreen(
        state = state,
        catalog = config?.catalog ?: Catalog(),
        commentMax = config?.limits?.commentMax ?: DEFAULT_COMMENT_MAX,
        actions = actions,
        modifier = modifier,
        backdrop = backdrop,
        onPhotoBehindBar = onPhotoBehindBar,
    )
    val writingTo = writingToId?.let { wanted -> state.details?.takeIf { it.id == wanted } ?: state.deck.cards.firstOrNull { it.id == wanted } }
    writingTo?.let { card ->
        app.core.feature.requests.MessageRequestSheet(card, onDismiss = { writingToId = null }, onOpenChat = { id -> open(id) })
    }
}

private const val DEFAULT_COMMENT_MAX = 300

/**
 * The deck screen for a given state: what every state looks like, with no
 * server behind it. By the template's deck switch:
 * - bleed (neon): the card's photo fills the window under the status bar and
 *   the floating tab bar; the mark and the glass filters button over it; the
 *   name and «{city}، {n} کیلومتر» on the photo; the five actions 16 dp
 *   above the bar;
 * - card (white): a plain header (the mark, the filters icon), the photo
 *   inset 20 dp with `--r-photo` corners, the name in `--type-h1` and the
 *   line in `--text-2` under it, the actions on the page 16 dp above the bar.
 * Out of cards, or when the deck cannot be shown, one title and one action,
 * centred between the header and the bar.
 */
@Composable
fun DeckScreen(
    state: DeckUiState,
    catalog: Catalog,
    commentMax: Int,
    actions: DeckActions,
    modifier: Modifier = Modifier,
    backdrop: GlassBackdrop? = null,
    onPhotoBehindBar: (Boolean) -> Unit = {},
) {
    val t = AppTheme.template
    val bleed = t.switches.deck == DeckStyle.Bleed
    val controller = remember { DeckController() }
    val snackbar = remember { SnackbarHostState() }
    val number = rememberNumbers()
    val time = rememberTimeOfDay()
    val cards = state.deck.cards
    val status = state.deck.status
    val deckUp = cards.isNotEmpty() || status == DeckStatus.Loading || status == DeckStatus.Ready
    val glass = backdrop ?: rememberGlassBackdrop()

    val behind = bleed && deckUp
    val report by rememberUpdatedState(onPhotoBehindBar)
    LaunchedEffect(behind) { report(behind) }
    DisposableEffect(Unit) { onDispose { report(false) } }

    // A notice while the full profile is up is drawn over it (its window covers this screen's).
    val overDetails = state.details != null
    val notice: DetailsNotice? = state.message?.let { message ->
        val text = when (message.notice) {
            DeckNotice.LikeOffline -> brandString(R.string.deck_like_offline)
            DeckNotice.LikeFailed -> brandString(R.string.deck_like_failed)
            DeckNotice.RateLimited -> brandString(R.string.deck_rate_limited)
            DeckNotice.RewindNothing -> brandString(R.string.deck_rewind_nothing)
            DeckNotice.Offline -> brandString(R.string.error_offline)
            DeckNotice.BoostStarted -> brandString(R.string.deck_boost_started, message.at?.let(time) ?: "")
            DeckNotice.BoostNone -> brandString(R.string.deck_boost_none)
            DeckNotice.FiltersFailed -> brandString(R.string.filters_failed)
            DeckNotice.FiltersLimit -> brandString(R.string.filters_limit)
            DeckNotice.SnoozeFailed -> brandString(R.string.deck_snooze_failed)
            DeckNotice.Reported -> brandString(R.string.deck_reported)
            DeckNotice.Blocked -> brandString(R.string.deck_blocked, app.core.feature.card.isolate(message.name.orEmpty()))
            DeckNotice.SafetyFailed -> brandString(R.string.deck_safety_failed)
        }
        DetailsNotice(message.id, text)
    }
    if (notice != null && !overDetails) {
        LaunchedEffect(notice.id) {
            snackbar.showSnackbar(notice.text)
            actions.messageShown(notice.id)
        }
    }

    val statusTop = maxOf(WindowInsets.statusBars.asPaddingValues().calculateTopPadding(), DeckLayout.statusBar)
    val navigation = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    val actionsBottom = (LocalTabBarSpace.current ?: navigation) + DeckLayout.actionsGap
    val row: @Composable (Modifier) -> Unit = { m ->
        ActionRow(state, controller, number, actions, if (bleed) glass else null, m)
    }

    Box(modifier.fillMaxSize().background(t.colors.bg)) {
        if (bleed) {
            if (deckUp) {
                Box(Modifier.fillMaxSize().glassSource(glass)) {
                    if (cards.isEmpty()) {
                        CardSkeleton(Modifier.fillMaxSize())
                    } else {
                        CardStack(
                            cards = cards,
                            returning = state.deck.returning,
                            number = number,
                            controller = controller,
                            onSwiped = actions::swiped,
                            onOpenDetails = actions::openDetails,
                            onReturnShown = actions::returnShown,
                            modifier = Modifier.fillMaxSize(),
                            infoBottom = actionsBottom + DeckLayout.actionRow + DeckLayout.infoAboveActions,
                            storyTop = statusTop + DeckLayout.storyBelowStatus,
                        )
                    }
                }
                row(Modifier.align(Alignment.BottomCenter).padding(bottom = actionsBottom))
            } else {
                StatusPane(state, number, actions, Modifier.fillMaxSize().padding(top = statusTop + DeckLayout.emptyTop, bottom = LocalTabBarSpace.current ?: navigation))
            }
            DeckHeader(
                onFilters = actions::openFilters,
                glass = deckUp,
                backdrop = glass,
                modifier = Modifier.padding(top = statusTop + DeckLayout.headerTopBleed, start = DeckLayout.headerStartBleed, end = DeckLayout.headerEndBleed),
            )
        } else {
            Column(Modifier.fillMaxSize()) {
                DeckHeader(
                    onFilters = actions::openFilters,
                    glass = false,
                    backdrop = null,
                    modifier = Modifier.padding(top = statusTop + DeckLayout.headerTopCard, start = Space.gutter, end = DeckLayout.headerEndCard),
                )
                if (deckUp) {
                    Box(
                        Modifier
                            .weight(1f)
                            .fillMaxWidth()
                            .padding(start = Space.gutter, end = Space.gutter, top = DeckLayout.photoBelowHeader),
                    ) {
                        if (cards.isEmpty()) {
                            CardSkeleton(Modifier.fillMaxSize())
                        } else {
                            CardStack(
                                cards = cards,
                                returning = state.deck.returning,
                                number = number,
                                controller = controller,
                                onSwiped = actions::swiped,
                                onOpenDetails = actions::openDetails,
                                onReturnShown = actions::returnShown,
                                modifier = Modifier.fillMaxSize(),
                            )
                        }
                    }
                    Spacer(Modifier.height(DeckLayout.infoBelowPhoto))
                    val top = cards.firstOrNull()
                    // At least the design's 66 dp; larger text takes its room from the photo above, never from the line.
                    Box(Modifier.fillMaxWidth().padding(horizontal = Space.gutter).heightIn(min = DeckLayout.cardInfo)) {
                        if (top != null) {
                            CardInfo(top, number, onPhoto = false, onOpen = { actions.openDetails(top) })
                        } else {
                            InfoSkeleton()
                        }
                    }
                    Spacer(Modifier.height(DeckLayout.infoAboveActionsCard))
                    row(Modifier)
                    Spacer(Modifier.height(actionsBottom))
                } else {
                    StatusPane(state, number, actions, Modifier.weight(1f).fillMaxWidth().padding(bottom = LocalTabBarSpace.current ?: navigation))
                }
            }
        }
        SnackbarHost(
            snackbar,
            Modifier
                .align(Alignment.BottomCenter)
                .padding(start = Space.gutter, end = Space.gutter, bottom = actionsBottom + DeckLayout.actionRow + DeckLayout.snackbarGap),
        ) { data -> AppSnackbar(data.visuals.message) }
    }

    // Who is being reported or blocked survives the activity being made again; the card is looked up by id.
    var reportingId by rememberSaveable { mutableStateOf<String?>(null) }
    var blockingId by rememberSaveable { mutableStateOf<String?>(null) }
    fun known(id: String?): ProfileCard? = id?.let { wanted -> state.details?.takeIf { it.id == wanted } ?: cards.firstOrNull { it.id == wanted } }
    val reporting = known(reportingId)
    val blocking = known(blockingId)
    state.details?.let { card ->
        ProfileDetailsDialog(
            card = card,
            catalog = catalog,
            source = DetailsSource.Deck,
            onDismiss = actions::closeDetails,
            onPass = { actions.fromDetails(SwipeAction.Pass) },
            onLike = { actions.fromDetails(SwipeAction.Like) },
            onSuperlike = { actions.fromDetails(SwipeAction.Superlike) },
            onLikeItem = actions::openItemLike,
            onMessage = { actions.writeTo(card) },
            onReport = { reportingId = card.id },
            onBlock = { blockingId = card.id },
            notice = notice,
            onNoticeShown = actions::messageShown,
        )
    }
    reporting?.let { card ->
        ReportSheet(
            name = card.name,
            catalog = catalog,
            withMessage = false,
            onDismiss = { reportingId = null },
            onSend = { reason, details, block ->
                reportingId = null
                actions.report(card, reason, details, block)
            },
            // A profile report carries no messages (none were sent): the sheet says what the team looks at.
            evidenceNote = brandString(R.string.report_profile_note),
        )
    }
    blocking?.let { card ->
        AppDialog(
            title = brandString(R.string.chat_block_title, app.core.feature.card.isolate(card.name)),
            body = null,
            confirm = brandString(R.string.profile_block),
            onConfirm = {
                blockingId = null
                actions.block(card)
            },
            dismiss = brandString(R.string.action_cancel),
            onDismiss = { blockingId = null },
        )
    }

    when (val sheet = state.sheet) {
        is DeckSheet.OutOfQuota -> QuotaSheet(sheet.action, sheet.resetsAt, actions::dismissSheet)
        DeckSheet.Filters -> FiltersSheet(
            preferences = state.preferences,
            saving = state.saving,
            onApply = actions::applyFilters,
            onDismiss = actions::dismissSheet,
            advanced = state.entitlements?.features?.advancedFilters == true,
            advancedFields = advancedFilterFields(catalog),
            country = state.country,
            catalog = catalog,
        )
        is DeckSheet.LikeItem -> ItemLikeSheet(
            target = sheet.target,
            state = state.itemLike,
            commentMax = commentMax,
            onSend = { comment -> actions.sendItemLike(sheet.target, comment) },
            onDismiss = actions::dismissSheet,
            superlikesLeft = state.superlikesLeft,
            // Offered once the plan is known: an unknown quota is not "no limit".
            onSuperlike = if (state.entitlements != null) { comment -> actions.sendItemSuperlike(sheet.target, comment) } else null,
        )
        null -> Unit
    }

    state.match?.let { match ->
        MatchMomentDialog(
            their = match.card,
            myPhoto = match.myPhoto,
            onSendMessage = {
                actions.dismissMatch()
                actions.openChat(match.conversationId)
            },
            onDismiss = actions::dismissMatch,
            conversationId = match.conversationId,
            openers = matchOpeners(match.card, catalog),
        )
    }
}

/**
 * The deck's header: the mark at the start and the filters at the end
 * (glass over the photo; a plain icon on the page).
 */
@Composable
private fun DeckHeader(onFilters: () -> Unit, glass: Boolean, backdrop: GlassBackdrop?, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth().height(DeckLayout.header), verticalAlignment = Alignment.CenterVertically) {
        LogoMark(DeckLayout.mark, contentDescription = brandString(R.string.ui_logo))
        Spacer(Modifier.weight(1f))
        AppIconButton(
            icon = AppIcons.Tune,
            contentDescription = brandString(R.string.deck_filters),
            onClick = onFilters,
            kind = if (glass) IconButtonKind.Glass else IconButtonKind.Plain,
            backdrop = backdrop,
        )
    }
}

/**
 * The catalogue's paid filters, as the filters sheet lists them: the choice
 * fields (education, …) first, then the ranges (height), each in the
 * catalogue's order. A range needs its bounds.
 */
fun advancedFilterFields(catalog: Catalog): List<FieldDef> {
    val choices = catalog.fields.filter { it.filterable && it.kind in CHOICE_KINDS && it.options.isNotEmpty() }
    val ranges = catalog.fields.filter { it.filterable && it.kind == RANGE_KIND && it.min != null && it.max != null && it.min < it.max }
    return choices + ranges
}

private val CHOICE_KINDS = setOf("single", "multi")
private const val RANGE_KIND = "number"

/**
 * The five actions under the card: rewind, pass, super like, like and the
 * boost (its bolt in the accent while one runs, its minutes said, counted
 * down on the screen's own clock, with no request). Pass is always at the
 * left and like at the right, in Persian too: the buttons sit under the
 * gesture they repeat.
 */
@Composable
private fun ActionRow(
    state: DeckUiState,
    controller: DeckController,
    number: (Int) -> String,
    actions: DeckActions,
    backdrop: GlassBackdrop?,
    modifier: Modifier,
) {
    val enabled = state.deck.cards.isNotEmpty()
    val left = boostMinutesLeft(state.entitlements?.boostEndsAt)
    val superDescription = state.superlikesLeft
        ?.let { "${brandString(R.string.deck_action_superlike)}. ${brandString(R.string.deck_superlikes_left, number(it))}" }
    DeckActions(
        onRewind = actions::rewind,
        onPass = { controller.swipe(SwipeAction.Pass) },
        onSuperLike = { controller.swipe(SwipeAction.Superlike) },
        onLike = { controller.swipe(SwipeAction.Like) },
        onBoost = actions::boost,
        modifier = modifier,
        backdrop = backdrop,
        enabled = enabled,
        progress = { controller.progress },
        boostActive = left != null,
        superLikeDescription = superDescription,
        boostDescription = left?.let { brandString(R.string.deck_boost_active, number(it)) },
    )
}

private const val BOOST_TICK_MS = 15_000L

/** A card-shaped placeholder while the first page is on its way: never a bare spinner. */
@Composable
fun CardSkeleton(modifier: Modifier = Modifier) {
    val t = AppTheme.template
    val label = brandString(R.string.ui_loading)
    Box(
        modifier
            .skeleton(RoundedCornerShape(t.radii.photo))
            .semantics {
                contentDescription = label
                liveRegion = LiveRegionMode.Polite
            },
    )
}

/** Where the name and the line will be, while the first card is on its way. */
@Composable
private fun InfoSkeleton() {
    val t = AppTheme.template
    Column(verticalArrangement = Arrangement.spacedBy(DeckLayout.skeletonGap)) {
        Box(Modifier.width(DeckLayout.skeletonName).height(DeckLayout.skeletonNameHeight).skeleton(RoundedCornerShape(t.radii.xs)))
        Box(Modifier.width(DeckLayout.skeletonMeta).height(DeckLayout.skeletonMetaHeight).skeleton(RoundedCornerShape(t.radii.xs)))
    }
}

/**
 * One title, at most one short line, and one action, centred: the end of
 * the deck, offline, a failure, or why the deck is not shown.
 */
@Composable
private fun StatusPane(state: DeckUiState, number: (Int) -> String, actions: DeckActions, modifier: Modifier) {
    val status = state.deck.status
    when {
        status == DeckStatus.Exhausted -> OutOfCards(state, number, actions, modifier)
        status == DeckStatus.Offline -> Pane(brandString(R.string.error_offline), null, brandString(R.string.action_try_again), actions::retry, modifier)
        status is DeckStatus.Blocked -> when (status.reason) {
            DeckBlock.OnboardingIncomplete ->
                Pane(brandString(R.string.deck_onboarding_title), null, brandString(R.string.deck_onboarding_action), actions::openProfile, modifier)
            DeckBlock.Snoozed ->
                Pane(brandString(R.string.deck_snoozed_title), brandString(R.string.deck_snoozed_body), brandString(R.string.deck_snoozed_action), actions::wakeUp, modifier)
            DeckBlock.LocationRequired ->
                Pane(brandString(R.string.deck_location_title), brandString(R.string.deck_location_body), brandString(R.string.action_try_again), actions::retry, modifier)
        }
        else -> Pane(brandString(R.string.deck_failed), null, brandString(R.string.action_try_again), actions::retry, modifier)
    }
}

/**
 * The end of the deck: «فعلاً همه رو دیدی» and one fix, the first that
 * still widens something: the distance («تا ۱۰۰ کیلومتر بگرد», then the
 * whole country), the ages, a boost when the server suggests one, else
 * checking again. Under it, as text buttons, checking again and the boost
 * the server suggests (its minutes left while one runs) when the fix is
 * something else: the action row with the boost is not drawn here. The
 * filters themselves are the button in the corner.
 */
@Composable
private fun OutOfCards(state: DeckUiState, number: (Int) -> String, actions: DeckActions, modifier: Modifier) {
    val fix = outOfCardsFix(state)
    val prefs = state.preferences
    val boostLeft = boostMinutesLeft(state.entitlements?.boostEndsAt)
    val boostLabel = boostLeft?.let { brandString(R.string.deck_boost_active, number(it)) } ?: brandString(R.string.deck_boost)
    val (label, onClick) = when (fix) {
        OutOfCardsFix.Distance -> when {
            prefs == null -> brandString(R.string.deck_widen_distance_generic)
            Widening.widensToCountry(prefs) -> brandString(R.string.deck_widen_country)
            else -> brandString(R.string.deck_widen_distance, number(Widening.nextDistance(prefs.maxDistanceKm)))
        } to actions::widenDistance
        OutOfCardsFix.Age -> (
            prefs?.let {
                val (min, max) = Widening.nextAges(it)
                brandString(R.string.deck_widen_age, number(min), number(max))
            } ?: brandString(R.string.deck_widen_age_generic)
            ) to actions::widenAge
        OutOfCardsFix.Boost -> boostLabel to actions::boost
        OutOfCardsFix.CheckAgain -> brandString(R.string.deck_check_again) to actions::retry
    }
    val boostSuggested = DeckSuggestion.Boost in state.deck.suggestions
    Pane(brandString(R.string.deck_exhausted_title), null, label, onClick, modifier, enabled = !state.saving) {
        if (fix != OutOfCardsFix.CheckAgain) {
            TextAction(brandString(R.string.deck_check_again), actions::retry, Modifier.padding(top = DeckLayout.paneMoreGap), enabled = !state.saving)
        }
        if (boostSuggested && fix != OutOfCardsFix.Boost) TextAction(boostLabel, actions::boost)
    }
}

/** A running boost's minutes left (rounded up, at most 30), ticking; null when none runs. */
@Composable
private fun boostMinutesLeft(endsAt: Instant?): Int? {
    val now by produceState(Instant.now(), endsAt) {
        while (endsAt != null && endsAt.isAfter(value)) {
            kotlinx.coroutines.delay(BOOST_TICK_MS)
            value = Instant.now()
        }
    }
    return endsAt?.takeIf { it.isAfter(now) }?.let { java.time.Duration.between(now, it).toMinutes().plus(1).coerceAtMost(30).toInt() }
}

/** The one fix the end of the deck offers. */
enum class OutOfCardsFix { Distance, Age, Boost, CheckAgain }

/** The first of the server's suggestions (or distance, then ages) that still widens something; else checking again. */
fun outOfCardsFix(state: DeckUiState): OutOfCardsFix {
    val prefs = state.preferences
    val suggestions = state.deck.suggestions.ifEmpty { listOf(DeckSuggestion.WidenDistance, DeckSuggestion.WidenAge) }
    for (suggestion in suggestions) {
        when (suggestion) {
            DeckSuggestion.WidenDistance -> if (prefs?.wholeCountry != true) return OutOfCardsFix.Distance
            DeckSuggestion.WidenAge -> if (prefs == null || !Widening.ageIsWidest(prefs)) return OutOfCardsFix.Age
            DeckSuggestion.Boost -> return OutOfCardsFix.Boost
            DeckSuggestion.Unknown -> Unit
        }
    }
    return OutOfCardsFix.CheckAgain
}

@Composable
private fun Pane(
    title: String,
    body: String?,
    action: String,
    onAction: () -> Unit,
    modifier: Modifier,
    enabled: Boolean = true,
    more: @Composable ColumnScope.() -> Unit = {},
) {
    val t = AppTheme.template
    Box(modifier.verticalScroll(rememberScrollState()).padding(horizontal = Space.gutter), contentAlignment = Alignment.Center) {
        Column(Modifier.widthIn(max = DeckLayout.paneMax).fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(title, style = t.type.h2, color = t.colors.text, textAlign = TextAlign.Center, modifier = Modifier.semantics { heading() })
            if (body != null) {
                Text(body, style = t.type.bodySm, color = t.colors.text2, textAlign = TextAlign.Center, modifier = Modifier.padding(top = DeckLayout.paneBodyGap))
            }
            Spacer(Modifier.height(DeckLayout.paneActionGap))
            SecondaryButton(action, onAction, enabled = enabled, fullWidth = false, medium = true)
            more()
        }
    }
}

/** The deck's layout, from the design's 412 × 892 board (status bar 32 dp, the floating bar 20 + 66 dp). */
internal object DeckLayout {
    /** The name block's tap target (it opens the profile). */
    val infoTarget = 48.dp
    /** The design's status bar; a phone's own is used when it is taller. */
    val statusBar = 32.dp
    val header = 48.dp
    val mark = 34.dp
    val headerTopBleed = 18.dp
    val headerStartBleed = 16.dp
    val headerEndBleed = 14.dp
    val headerTopCard = 8.dp
    val headerEndCard = 8.dp
    val storyBelowStatus = 8.dp
    val storyInset = 12.dp
    val photoBelowHeader = 4.dp
    val infoBelowPhoto = 12.dp
    val cardInfo = 66.dp
    val infoAboveActionsCard = 16.dp
    val actionRow = 68.dp
    val actionsGap = 16.dp
    val infoAboveActions = 18.dp
    val metaGapOnPhoto = 2.dp
    val cardScrim = 84.dp
    const val CARD_SCRIM_ALPHA = 0.7f
    const val BOTTOM_SCRIM = 0.56f
    val nudge = 10.dp
    val emptyTop = 66.dp
    val paneMax = 420.dp
    val paneBodyGap = 6.dp
    val paneActionGap = 20.dp
    val paneMoreGap = 8.dp
    val snackbarGap = 12.dp
    val skeletonGap = 8.dp
    val skeletonName: Dp = 180.dp
    val skeletonNameHeight = 28.dp
    val skeletonMeta: Dp = 120.dp
    val skeletonMetaHeight = 16.dp
}
