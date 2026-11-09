package app.core.feature.deck

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.Button
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import app.core.LocalAppGraph
import app.core.R
import app.core.feature.card.DetailsSource
import app.core.feature.card.LikeTarget
import app.core.feature.card.ProfileDetailsDialog
import app.core.feature.card.RoundAction
import app.core.feature.card.rememberNumbers
import app.core.feature.card.rememberTimeOfDay
import app.core.feature.card.shimmer
import app.core.feature.match.MatchMomentDialog
import app.core.i18n.brandString
import app.core.media.CoilPhotoPreloader
import app.core.model.BoostKind
import app.core.feature.paywall.PaywallEntry
import androidx.compose.runtime.produceState
import java.time.Instant
import app.core.model.BoostStarted
import app.core.model.Catalog
import app.core.model.DeckSuggestion
import app.core.model.DiscoveryPreferences
import app.core.model.Id
import app.core.model.Me
import app.core.model.PreferencesPatch
import app.core.model.ProfileCard
import app.core.model.Settings
import app.core.model.SettingsPatch
import app.core.model.SwipeAction
import app.core.net.ServerApi
import app.core.net.internetAvailability
import app.core.sync.DeckBlock
import app.core.sync.DeckStatus
import app.core.ui.components.EmptyState
import app.core.ui.theme.AppTheme
import app.core.ui.theme.LocalReducedMotion
import app.core.ui.theme.Radius
import app.core.ui.theme.Space

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
}

/** The real server behind the deck screen's extra calls. */
class ServerDeckServices(private val api: ServerApi) : DeckServices {
    override suspend fun me(): Me = api.me().value
    override suspend fun updatePreferences(patch: PreferencesPatch): DiscoveryPreferences = api.updatePreferences(patch)
    override suspend fun updateSettings(patch: SettingsPatch): Settings = api.updateSettings(patch)
    override suspend fun boost(): BoostStarted = api.boost(BoostKind.Boost)
}

/**
 * The Discover tab. [onOpenChat] is "send a message" after a match (the
 * chat itself is another feature); [onOpenProfile] leads to the profile when
 * it is not finished.
 */
@Composable
fun DeckRoute(onOpenChat: (Id?) -> Unit, onOpenProfile: () -> Unit, modifier: Modifier = Modifier) {
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

    val open by androidx.compose.runtime.rememberUpdatedState(onOpenChat)
    val profile by androidx.compose.runtime.rememberUpdatedState(onOpenProfile)
    var writingTo by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf<ProfileCard?>(null) }
    val actions = remember(vm) {
        object : DeckActions {
            override fun swiped(card: ProfileCard, action: SwipeAction) = vm.swiped(card, action)
            override fun returnShown(id: String) = vm.returnShown(id)
            override fun openDetails(card: ProfileCard) = vm.openDetails(card)
            override fun closeDetails() = vm.closeDetails()
            override fun fromDetails(action: SwipeAction) = vm.fromDetails(action)
            override fun openItemLike(target: LikeTarget) = vm.openItemLike(target)
            override fun sendItemLike(target: LikeTarget, comment: String) = vm.sendItemLike(target, comment)
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
                writingTo = card
            }
        }
    }
    DeckScreen(
        state = state,
        catalog = config?.catalog ?: Catalog(),
        planNames = config?.planNames.orEmpty(),
        commentMax = config?.limits?.commentMax ?: DEFAULT_COMMENT_MAX,
        actions = actions,
        modifier = modifier,
    )
    writingTo?.let { card ->
        app.core.feature.requests.MessageRequestSheet(card, onDismiss = { writingTo = null }, onOpenChat = { id -> open(id) })
    }
}

private const val DEFAULT_COMMENT_MAX = 300

/** The deck screen for a given state: what every state looks like, with no server behind it. */
@Composable
fun DeckScreen(
    state: DeckUiState,
    catalog: Catalog,
    planNames: Map<String, String>,
    commentMax: Int,
    actions: DeckActions,
    modifier: Modifier = Modifier,
) {
    val controller = remember { DeckController() }
    val snackbar = remember { SnackbarHostState() }
    val number = rememberNumbers()
    val time = rememberTimeOfDay()
    val cards = state.deck.cards

    state.message?.let { message ->
        val text = when (message.notice) {
            DeckNotice.LikeOffline -> brandString(R.string.deck_like_offline)
            DeckNotice.LikeFailed -> brandString(R.string.deck_like_failed)
            DeckNotice.RateLimited -> brandString(R.string.deck_rate_limited)
            DeckNotice.RewindNothing -> brandString(R.string.deck_rewind_nothing)
            DeckNotice.Offline -> brandString(R.string.feed_offline_title)
            DeckNotice.BoostStarted -> brandString(R.string.deck_boost_started, message.at?.let(time) ?: "")
            DeckNotice.BoostNone -> brandString(R.string.deck_boost_none)
            DeckNotice.FiltersFailed -> brandString(R.string.filters_failed)
            DeckNotice.FiltersLimit -> brandString(R.string.filters_limit)
            DeckNotice.SnoozeFailed -> brandString(R.string.deck_snooze_failed)
        }
        LaunchedEffect(message.id) {
            snackbar.showSnackbar(text)
            actions.messageShown(message.id)
        }
    }

    Box(modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            DeckTopBar(onFilters = actions::openFilters, boostEndsAt = state.entitlements?.boostEndsAt, onBoost = actions::boost)
            Box(
                Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .padding(horizontal = Space.md),
            ) {
                when {
                    cards.isNotEmpty() -> CardStack(
                        cards = cards,
                        returning = state.deck.returning,
                        catalog = catalog,
                        number = number,
                        controller = controller,
                        onSwiped = actions::swiped,
                        onOpenDetails = actions::openDetails,
                        onReturnShown = actions::returnShown,
                        modifier = Modifier.fillMaxSize(),
                    )
                    state.deck.status == DeckStatus.Exhausted -> OutOfCards(state, number, actions)
                    state.deck.status == DeckStatus.Offline -> StatusPane(
                        icon = R.drawable.ic_tab_discover,
                        title = brandString(R.string.feed_offline_title),
                        body = brandString(R.string.feed_offline_body),
                        action = brandString(R.string.feed_retry),
                        onAction = actions::retry,
                    )
                    state.deck.status == DeckStatus.Failed -> StatusPane(
                        icon = R.drawable.ic_tab_discover,
                        title = brandString(R.string.feed_error_title),
                        body = brandString(R.string.feed_error_body),
                        action = brandString(R.string.feed_retry),
                        onAction = actions::retry,
                    )
                    state.deck.status is DeckStatus.Blocked -> BlockedPane((state.deck.status as DeckStatus.Blocked).reason, actions)
                    else -> CardSkeleton(Modifier.fillMaxSize())
                }
            }
            val showActions = cards.isNotEmpty() || state.deck.status == DeckStatus.Loading || state.deck.status == DeckStatus.Ready
            if (showActions) {
                ActionRow(
                    controller = controller,
                    enabled = cards.isNotEmpty(),
                    superlikesLeft = state.superlikesLeft,
                    number = number,
                    onRewind = actions::rewind,
                )
            } else {
                Spacer(Modifier.height(Space.lg))
            }
        }
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).padding(bottom = 96.dp))
    }

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
        )
    }

    when (val sheet = state.sheet) {
        is DeckSheet.OutOfQuota -> QuotaSheet(sheet.action, sheet.resetsAt, planNames, actions::dismissSheet)
        DeckSheet.RewindUpsell -> UpsellSheet(
            title = brandString(R.string.deck_rewind_title),
            body = brandString(R.string.deck_rewind_body),
            planNames = planNames,
            onDismiss = actions::dismissSheet,
            icon = R.drawable.ic_deck_rewind,
            entry = PaywallEntry.REWIND,
        )
        DeckSheet.Filters -> FiltersSheet(
            preferences = state.preferences,
            saving = state.saving,
            onApply = actions::applyFilters,
            onDismiss = actions::dismissSheet,
            advanced = state.entitlements?.features?.advancedFilters == true,
            advancedFields = catalog.fields.filter { it.filterable && it.kind in ADVANCED_KINDS && it.options.isNotEmpty() },
        )
        is DeckSheet.LikeItem -> ItemLikeSheet(
            target = sheet.target,
            state = state.itemLike,
            commentMax = commentMax,
            onSend = { comment -> actions.sendItemLike(sheet.target, comment) },
            onDismiss = actions::dismissSheet,
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
        )
    }
}

@Composable
private fun DeckTopBar(onFilters: () -> Unit, boostEndsAt: Instant? = null, onBoost: () -> Unit = {}) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .padding(start = Space.xl, end = Space.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            brandString(R.string.tab_discover),
            style = MaterialTheme.typography.headlineSmall,
            modifier = Modifier.weight(1f).semantics { heading() },
        )
        BoostButton(boostEndsAt, onBoost)
        IconButton(onClick = onFilters) {
            Icon(painterResource(R.drawable.ic_deck_tune), contentDescription = brandString(R.string.deck_filters))
        }
    }
}

/** Kinds of config field the advanced filters can offer: choices. */
private val ADVANCED_KINDS = setOf("single", "multi")

/**
 * The boost: a bolt that starts one, or while one runs its minutes left,
 * counted down on the screen's own clock (no request).
 */
@Composable
private fun BoostButton(endsAt: Instant?, onBoost: () -> Unit) {
    val now by produceState(Instant.now(), endsAt) {
        while (endsAt != null && endsAt.isAfter(value)) {
            kotlinx.coroutines.delay(BOOST_TICK_MS)
            value = Instant.now()
        }
    }
    val left = endsAt?.takeIf { it.isAfter(now) }?.let { java.time.Duration.between(now, it).toMinutes().plus(1).coerceAtMost(30) }
    val number = rememberNumbers()
    if (left == null) {
        IconButton(onClick = onBoost) {
            Icon(painterResource(R.drawable.ic_deck_bolt), contentDescription = brandString(R.string.boost_action), tint = AppTheme.colors.superLike)
        }
    } else {
        val minutes = number(left.toInt())
        val spoken = brandString(R.string.boost_active_a11y, minutes)
        androidx.compose.material3.AssistChip(
            onClick = onBoost,
            label = { Text(brandString(R.string.boost_active, minutes)) },
            leadingIcon = { Icon(painterResource(R.drawable.ic_deck_bolt), contentDescription = null, tint = AppTheme.colors.superLike, modifier = Modifier.size(18.dp)) },
            modifier = Modifier.heightIn(min = Space.minTouch).semantics { contentDescription = spoken },
        )
    }
}

private const val BOOST_TICK_MS = 15_000L

/**
 * Rewind, pass, super like and like. Pass is always at the left and like at
 * the right, in Persian too: the buttons sit under the gesture they repeat
 * (right is like everywhere).
 */
@Composable
private fun ActionRow(
    controller: DeckController,
    enabled: Boolean,
    superlikesLeft: Int?,
    number: (Int) -> String,
    onRewind: () -> Unit,
) {
    val progress = controller.progress
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(vertical = Space.md),
            horizontalArrangement = Arrangement.spacedBy(Space.lg, Alignment.CenterHorizontally),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            RoundAction(
                painter = painterResource(R.drawable.ic_deck_rewind),
                description = brandString(R.string.deck_action_rewind),
                color = MaterialTheme.colorScheme.secondary,
                size = 48.dp,
                onClick = onRewind,
                enabled = enabled,
            )
            RoundAction(
                painter = rememberVectorPainter(Icons.Filled.Close),
                description = brandString(R.string.deck_action_pass),
                color = AppTheme.colors.pass,
                size = 64.dp,
                onClick = { controller.swipe(SwipeAction.Pass) },
                highlight = (-progress).coerceAtLeast(0f),
                enabled = enabled,
            )
            RoundAction(
                painter = rememberVectorPainter(Icons.Filled.Star),
                description = superlikesLeft?.let { brandString(R.string.deck_superlikes_left, number(it)) }
                    ?.let { "${brandString(R.string.deck_action_superlike)}. $it" } ?: brandString(R.string.deck_action_superlike),
                color = AppTheme.colors.superLike,
                size = 52.dp,
                onClick = { controller.swipe(SwipeAction.Superlike) },
                enabled = enabled,
                badge = superlikesLeft?.takeIf { it in 1..99 }?.let(number),
            )
            RoundAction(
                painter = rememberVectorPainter(Icons.Filled.Favorite),
                description = brandString(R.string.deck_action_like),
                color = AppTheme.colors.like,
                size = 64.dp,
                onClick = { controller.swipe(SwipeAction.Like) },
                highlight = progress.coerceAtLeast(0f),
                enabled = enabled,
            )
        }
    }
}

/** A card-shaped placeholder while the first page is on its way: never a bare spinner. */
@Composable
fun CardSkeleton(modifier: Modifier = Modifier) {
    val label = brandString(R.string.deck_loading)
    Box(
        modifier
            .clip(RoundedCornerShape(Radius.card))
            .shimmer()
            .semantics {
                contentDescription = label
                liveRegion = LiveRegionMode.Polite
            },
    ) {
        Column(
            Modifier
                .align(Alignment.BottomStart)
                .padding(Space.xl),
            verticalArrangement = Arrangement.spacedBy(Space.sm),
        ) {
            Box(Modifier.width(180.dp).height(28.dp).clip(RoundedCornerShape(Radius.sm)).shimmer())
            Box(Modifier.width(120.dp).height(16.dp).clip(RoundedCornerShape(Radius.sm)).shimmer())
            Box(Modifier.width(150.dp).height(16.dp).clip(RoundedCornerShape(Radius.sm)).shimmer())
        }
    }
}

@Composable
private fun StatusPane(icon: Int, title: String, body: String, action: String?, onAction: () -> Unit) {
    Box(Modifier.fillMaxSize().verticalScroll(rememberScrollState()), contentAlignment = Alignment.Center) {
        EmptyState(
            icon = icon,
            title = title,
            body = body,
            action = action?.let {
                { Button(onClick = onAction, modifier = Modifier.heightIn(min = Space.minTouch)) { Text(it) } }
            },
        )
    }
}

@Composable
private fun BlockedPane(reason: DeckBlock, actions: DeckActions) {
    when (reason) {
        DeckBlock.OnboardingIncomplete -> StatusPane(
            icon = R.drawable.ic_tab_profile,
            title = brandString(R.string.deck_onboarding_title),
            body = brandString(R.string.deck_onboarding_body),
            action = brandString(R.string.deck_onboarding_action),
            onAction = actions::openProfile,
        )
        DeckBlock.Snoozed -> StatusPane(
            icon = R.drawable.ic_tab_discover,
            title = brandString(R.string.deck_snoozed_title),
            body = brandString(R.string.deck_snoozed_body),
            action = brandString(R.string.deck_snoozed_action),
            onAction = actions::wakeUp,
        )
        DeckBlock.LocationRequired -> StatusPane(
            icon = R.drawable.ic_tab_discover,
            title = brandString(R.string.deck_location_title),
            body = brandString(R.string.deck_location_body),
            action = brandString(R.string.feed_retry),
            onAction = actions::retry,
        )
    }
}

/**
 * The end of the deck: never a blank screen. The server's suggestions, made
 * concrete with the account's own filters ("Search up to 100 km"), a boost,
 * the filters themselves, and checking again.
 */
@Composable
private fun OutOfCards(state: DeckUiState, number: (Int) -> String, actions: DeckActions) {
    val prefs = state.preferences
    val suggestions = state.deck.suggestions.ifEmpty { listOf(DeckSuggestion.WidenDistance, DeckSuggestion.WidenAge) }
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = Space.lg, vertical = Space.xl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Space.md, Alignment.CenterVertically),
    ) {
        Radar(Modifier.size(132.dp))
        Text(
            brandString(R.string.deck_exhausted_title),
            style = MaterialTheme.typography.headlineSmall,
            textAlign = TextAlign.Center,
            modifier = Modifier.semantics { heading() },
        )
        Text(
            brandString(R.string.deck_exhausted_body),
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(Space.sm))
        Column(Modifier.widthIn(max = 420.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
            suggestions.forEach { suggestion ->
                when (suggestion) {
                    DeckSuggestion.WidenDistance -> if (prefs?.wholeCountry != true) {
                        val label = when {
                            prefs == null -> brandString(R.string.deck_widen_distance_generic)
                            Widening.widensToCountry(prefs) -> brandString(R.string.deck_widen_country)
                            else -> brandString(R.string.deck_widen_distance, number(Widening.nextDistance(prefs.maxDistanceKm)))
                        }
                        FilledTonalButton(onClick = actions::widenDistance, enabled = !state.saving, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) {
                            Text(label)
                        }
                    }
                    DeckSuggestion.WidenAge -> if (prefs == null || !Widening.ageIsWidest(prefs)) {
                        val label = prefs?.let {
                            val (min, max) = Widening.nextAges(it)
                            brandString(R.string.deck_widen_age, number(min), number(max))
                        } ?: brandString(R.string.deck_widen_age_generic)
                        FilledTonalButton(onClick = actions::widenAge, enabled = !state.saving, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) {
                            Text(label)
                        }
                    }
                    DeckSuggestion.Boost -> OutlinedButton(onClick = actions::boost, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) {
                        Icon(painterResource(R.drawable.ic_deck_bolt), null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(Space.sm))
                        Text(brandString(R.string.deck_boost))
                    }
                    DeckSuggestion.Unknown -> Unit
                }
            }
            OutlinedButton(onClick = actions::openFilters, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) {
                Icon(painterResource(R.drawable.ic_deck_tune), null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(Space.sm))
                Text(brandString(R.string.deck_change_filters))
            }
            TextButton(onClick = actions::retry, modifier = Modifier.fillMaxWidth().heightIn(min = Space.minTouch)) {
                Text(brandString(R.string.deck_check_again))
            }
            if (state.saving) {
                LinearProgressIndicator(Modifier.fillMaxWidth())
                Text(
                    brandString(R.string.deck_widening),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite },
                    textAlign = TextAlign.Center,
                )
            }
        }
    }
}

/** Rings widening out from the middle: "looking around". Still with less motion. */
@Composable
private fun Radar(modifier: Modifier) {
    val reduced = LocalReducedMotion.current
    val colour = MaterialTheme.colorScheme.primary
    val phase = if (reduced) {
        0.5f
    } else {
        val transition = rememberInfiniteTransition(label = "radar")
        transition.animateFloat(0f, 1f, infiniteRepeatable(tween(2_400, easing = LinearEasing), RepeatMode.Restart), label = "radar-phase").value
    }
    Box(modifier, contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val max = size.minDimension / 2f
            val centre = Offset(size.width / 2f, size.height / 2f)
            for (i in 0 until 3) {
                val t = (phase + i / 3f) % 1f
                drawCircle(colour.copy(alpha = (1f - t) * 0.45f), radius = max * (0.25f + 0.75f * t), center = centre, style = Stroke(width = 3.dp.toPx()))
            }
            drawCircle(colour.copy(alpha = 0.16f), radius = max * 0.3f, center = centre)
        }
        Icon(painterResource(R.drawable.ic_tab_discover), null, tint = colour, modifier = Modifier.size(36.dp))
    }
}
