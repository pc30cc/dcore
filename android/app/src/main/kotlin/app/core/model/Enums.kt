package app.core.model

import kotlinx.serialization.Serializable

// Every enumeration the API sends, as lowercase strings. Each carries an
// `Unknown` member that anything this build does not know decodes to
// (WireEnumSerializer), so a value added on the server degrades one field
// instead of failing a whole response.

@Serializable(with = Gender.Serializer::class)
enum class Gender(override val wire: String) : WireEnum {
    Woman("woman"), Man("man"), Nonbinary("nonbinary"), Unknown("");

    internal object Serializer : WireEnumSerializer<Gender>("Gender", Gender.entries.toTypedArray(), Gender.Unknown)
}

@Serializable(with = Intention.Serializer::class)
enum class Intention(override val wire: String) : WireEnum {
    Serious("serious"), Marriage("marriage"), Friendship("friendship"), NotSure("not_sure"), Unknown("");

    internal object Serializer : WireEnumSerializer<Intention>("Intention", Intention.entries.toTypedArray(), Intention.Unknown)
}

/** What an account may do; `Deleted` is the 30-day grace before the purge. */
@Serializable(with = AccountStatus.Serializer::class)
enum class AccountStatus(override val wire: String) : WireEnum {
    Onboarding("onboarding"),
    PendingReview("pending_review"),
    Active("active"),
    Snoozed("snoozed"),
    Suspended("suspended"),
    Banned("banned"),
    Deleted("deleted"),
    Unknown(""),
    ;

    /** A session in this state only reaches the restricted routes (me, appeals, support, deletion, logout). */
    val isRestricted: Boolean get() = this == Suspended || this == Banned

    internal object Serializer : WireEnumSerializer<AccountStatus>("AccountStatus", AccountStatus.entries.toTypedArray(), AccountStatus.Unknown)
}

/** The store a session or a purchase belongs to. */
@Serializable(with = StoreName.Serializer::class)
enum class StoreName(override val wire: String) : WireEnum {
    Bazaar("bazaar"), Play("play"), Unknown("");

    internal object Serializer : WireEnumSerializer<StoreName>("StoreName", StoreName.entries.toTypedArray(), StoreName.Unknown)

    companion object {
        fun fromWire(value: String): StoreName = entries.firstOrNull { it != Unknown && it.wire == value } ?: Unknown
    }
}

/** Where a plan came from: a store purchase, or a grant from the admin panel. */
@Serializable(with = EntitlementSource.Serializer::class)
enum class EntitlementSource(override val wire: String) : WireEnum {
    Bazaar("bazaar"), Play("play"), Grant("grant"), Unknown("");

    internal object Serializer : WireEnumSerializer<EntitlementSource>("EntitlementSource", EntitlementSource.entries.toTypedArray(), EntitlementSource.Unknown)
}

@Serializable(with = AuthMethod.Serializer::class)
enum class AuthMethod(override val wire: String) : WireEnum {
    Phone("phone"), Google("google"), Unknown("");

    internal object Serializer : WireEnumSerializer<AuthMethod>("AuthMethod", AuthMethod.entries.toTypedArray(), AuthMethod.Unknown)
}

@Serializable(with = OtpChannel.Serializer::class)
enum class OtpChannel(override val wire: String) : WireEnum {
    Sms("sms"), Call("call"), Unknown("");

    internal object Serializer : WireEnumSerializer<OtpChannel>("OtpChannel", OtpChannel.entries.toTypedArray(), OtpChannel.Unknown)
}

@Serializable(with = PhotoStatus.Serializer::class)
enum class PhotoStatus(override val wire: String) : WireEnum {
    Processing("processing"), Review("review"), Approved("approved"), Rejected("rejected"), Unknown("");

    internal object Serializer : WireEnumSerializer<PhotoStatus>("PhotoStatus", PhotoStatus.entries.toTypedArray(), PhotoStatus.Unknown)
}

/** Moderation state of the profile's texts (about, job, prompt answers). */
@Serializable(with = TextState.Serializer::class)
enum class TextState(override val wire: String) : WireEnum {
    Checking("checking"), Approved("approved"), Rejected("rejected"), Unknown("");

    internal object Serializer : WireEnumSerializer<TextState>("TextState", TextState.entries.toTypedArray(), TextState.Unknown)
}

@Serializable(with = MessageKind.Serializer::class)
enum class MessageKind(override val wire: String) : WireEnum {
    Text("text"),
    Image("image"),
    Voice("voice"),
    Gif("gif"),
    Call("call"),
    LikeNote("like_note"),
    Reaction("reaction"),
    Unsend("unsend"),
    Unknown(""),
    ;

    internal object Serializer : WireEnumSerializer<MessageKind>("MessageKind", MessageKind.entries.toTypedArray(), MessageKind.Unknown)
}

@Serializable(with = CallKind.Serializer::class)
enum class CallKind(override val wire: String) : WireEnum {
    Audio("audio"), Video("video"), Unknown("");

    internal object Serializer : WireEnumSerializer<CallKind>("CallKind", CallKind.entries.toTypedArray(), CallKind.Unknown)
}

@Serializable(with = CallOutcome.Serializer::class)
enum class CallOutcome(override val wire: String) : WireEnum {
    Completed("completed"), Declined("declined"), Cancelled("cancelled"), Missed("missed"), Failed("failed"), Unknown("");

    internal object Serializer : WireEnumSerializer<CallOutcome>("CallOutcome", CallOutcome.entries.toTypedArray(), CallOutcome.Unknown)
}

@Serializable(with = CallRole.Serializer::class)
enum class CallRole(override val wire: String) : WireEnum {
    Caller("caller"), Callee("callee"), Unknown("");

    internal object Serializer : WireEnumSerializer<CallRole>("CallRole", CallRole.entries.toTypedArray(), CallRole.Unknown)
}

@Serializable(with = CallState.Serializer::class)
enum class CallState(override val wire: String) : WireEnum {
    Ringing("ringing"),
    Connecting("connecting"),
    Active("active"),
    Ended("ended"),
    Missed("missed"),
    Cancelled("cancelled"),
    Unknown(""),
    ;

    /** Ringing, connecting or active: the call still holds both people. */
    val isLive: Boolean get() = this == Ringing || this == Connecting || this == Active

    internal object Serializer : WireEnumSerializer<CallState>("CallState", CallState.entries.toTypedArray(), CallState.Unknown)
}

@Serializable(with = IcePolicy.Serializer::class)
enum class IcePolicy(override val wire: String) : WireEnum {
    All("all"), Relay("relay"), Unknown("");

    internal object Serializer : WireEnumSerializer<IcePolicy>("IcePolicy", IcePolicy.entries.toTypedArray(), IcePolicy.Unknown)
}

@Serializable(with = ConversationState.Serializer::class)
enum class ConversationState(override val wire: String) : WireEnum {
    Active("active"), Ended("ended"), Unknown("");

    internal object Serializer : WireEnumSerializer<ConversationState>("ConversationState", ConversationState.entries.toTypedArray(), ConversationState.Unknown)
}

/** How the pair came to talk: mutual like, super like, an accepted request, a like on a photo or prompt. */
@Serializable(with = ConversationSource.Serializer::class)
enum class ConversationSource(override val wire: String) : WireEnum {
    Like("like"), SuperLike("super_like"), Request("request"), ItemLike("item_like"), Unknown("");

    internal object Serializer : WireEnumSerializer<ConversationSource>("ConversationSource", ConversationSource.entries.toTypedArray(), ConversationSource.Unknown)
}

@Serializable(with = Plan.Serializer::class)
enum class Plan(override val wire: String) : WireEnum {
    Free("free"), Plus("plus"), Premium("premium"), Unknown("");

    internal object Serializer : WireEnumSerializer<Plan>("Plan", Plan.entries.toTypedArray(), Plan.Unknown)
}

/** The kind of a moderation action the user sees (a shadow restriction is never sent). */
@Serializable(with = ModerationKind.Serializer::class)
enum class ModerationKind(override val wire: String) : WireEnum {
    Warning("warning"), Suspension("suspension"), Ban("ban"), Unknown("");

    internal object Serializer : WireEnumSerializer<ModerationKind>("ModerationKind", ModerationKind.entries.toTypedArray(), ModerationKind.Unknown)
}

@Serializable(with = AppealStatus.Serializer::class)
enum class AppealStatus(override val wire: String) : WireEnum {
    Open("open"), Upheld("upheld"), Overturned("overturned"), Unknown("");

    internal object Serializer : WireEnumSerializer<AppealStatus>("AppealStatus", AppealStatus.entries.toTypedArray(), AppealStatus.Unknown)
}

@Serializable(with = SwipeAction.Serializer::class)
enum class SwipeAction(override val wire: String) : WireEnum {
    Like("like"), Pass("pass"), Superlike("superlike"), Unknown("");

    internal object Serializer : WireEnumSerializer<SwipeAction>("SwipeAction", SwipeAction.entries.toTypedArray(), SwipeAction.Unknown)
}

@Serializable(with = SwipeOutcome.Serializer::class)
enum class SwipeOutcome(override val wire: String) : WireEnum {
    Liked("liked"),
    Matched("matched"),
    Passed("passed"),
    Duplicate("duplicate"),
    Skipped("skipped"),
    Quota("quota"),
    Unknown(""),
    ;

    internal object Serializer : WireEnumSerializer<SwipeOutcome>("SwipeOutcome", SwipeOutcome.entries.toTypedArray(), SwipeOutcome.Unknown)
}

/** A part of a profile a like can point at. */
@Serializable(with = ItemKind.Serializer::class)
enum class ItemKind(override val wire: String) : WireEnum {
    Photo("photo"), Prompt("prompt"), Unknown("");

    internal object Serializer : WireEnumSerializer<ItemKind>("ItemKind", ItemKind.entries.toTypedArray(), ItemKind.Unknown)
}

@Serializable(with = DeckSuggestion.Serializer::class)
enum class DeckSuggestion(override val wire: String) : WireEnum {
    WidenDistance("widen_distance"), WidenAge("widen_age"), Boost("boost"), Unknown("");

    internal object Serializer : WireEnumSerializer<DeckSuggestion>("DeckSuggestion", DeckSuggestion.entries.toTypedArray(), DeckSuggestion.Unknown)
}

@Serializable(with = LikeKind.Serializer::class)
enum class LikeKind(override val wire: String) : WireEnum {
    Like("like"), Superlike("superlike"), Unknown("");

    internal object Serializer : WireEnumSerializer<LikeKind>("LikeKind", LikeKind.entries.toTypedArray(), LikeKind.Unknown)
}

/**
 * A message request's state. A sender never sees [Declined]: the server
 * shows a declined request as [Pending], then as [Expired] once an unanswered
 * one would have expired.
 */
@Serializable(with = RequestStatus.Serializer::class)
enum class RequestStatus(override val wire: String) : WireEnum {
    Pending("pending"), Accepted("accepted"), Declined("declined"), Expired("expired"), Withdrawn("withdrawn"), Unknown("");

    internal object Serializer : WireEnumSerializer<RequestStatus>("RequestStatus", RequestStatus.entries.toTypedArray(), RequestStatus.Unknown)
}

/** Which side of the message requests to list (a query parameter). */
enum class RequestBox(val wire: String) { Inbox("inbox"), Sent("sent") }

@Serializable(with = ReportContext.Serializer::class)
enum class ReportContext(override val wire: String) : WireEnum {
    Profile("profile"), Chat("chat"), Photo("photo"), Call("call"), Unknown("");

    internal object Serializer : WireEnumSerializer<ReportContext>("ReportContext", ReportContext.entries.toTypedArray(), ReportContext.Unknown)
}

@Serializable(with = ReportReason.Serializer::class)
enum class ReportReason(override val wire: String) : WireEnum {
    Fake("fake"),
    Harassment("harassment"),
    Inappropriate("inappropriate"),
    Scam("scam"),
    Under18("under_18"),
    Threat("threat"),
    Spam("spam"),
    ChildSafety("child_safety"),
    Other("other"),
    Unknown(""),
    ;

    internal object Serializer : WireEnumSerializer<ReportReason>("ReportReason", ReportReason.entries.toTypedArray(), ReportReason.Unknown)
}

@Serializable(with = LocationSource.Serializer::class)
enum class LocationSource(override val wire: String) : WireEnum {
    Gps("gps"), City("city"), Network("network"), Unknown("");

    internal object Serializer : WireEnumSerializer<LocationSource>("LocationSource", LocationSource.entries.toTypedArray(), LocationSource.Unknown)
}

@Serializable(with = PhotoMime.Serializer::class)
enum class PhotoMime(override val wire: String) : WireEnum {
    Jpeg("image/jpeg"), Webp("image/webp"), Heic("image/heic"), Unknown("");

    internal object Serializer : WireEnumSerializer<PhotoMime>("PhotoMime", PhotoMime.entries.toTypedArray(), PhotoMime.Unknown)
}

/** A subscription's billing period, as ISO 8601 durations. */
@Serializable(with = BillingPeriod.Serializer::class)
enum class BillingPeriod(override val wire: String) : WireEnum {
    Week("P1W"), Month("P1M"), ThreeMonths("P3M"), SixMonths("P6M"), Year("P12M"), Unknown("");

    internal object Serializer : WireEnumSerializer<BillingPeriod>("BillingPeriod", BillingPeriod.entries.toTypedArray(), BillingPeriod.Unknown)
}

/** What a consumable buys, and what a wallet holds. */
@Serializable(with = WalletItem.Serializer::class)
enum class WalletItem(override val wire: String) : WireEnum {
    Superlike("superlike"), Boost("boost"), Spotlight("spotlight"), Dm("dm"), Unknown("");

    internal object Serializer : WireEnumSerializer<WalletItem>("WalletItem", WalletItem.entries.toTypedArray(), WalletItem.Unknown)
}

@Serializable(with = PurchaseKind.Serializer::class)
enum class PurchaseKind(override val wire: String) : WireEnum {
    Subscription("subscription"), Consumable("consumable"), Unknown("");

    internal object Serializer : WireEnumSerializer<PurchaseKind>("PurchaseKind", PurchaseKind.entries.toTypedArray(), PurchaseKind.Unknown)
}

@Serializable(with = BoostKind.Serializer::class)
enum class BoostKind(override val wire: String) : WireEnum {
    Boost("boost"), Spotlight("spotlight"), Unknown("");

    internal object Serializer : WireEnumSerializer<BoostKind>("BoostKind", BoostKind.entries.toTypedArray(), BoostKind.Unknown)
}

/** Face verification, behind a provider the server picks. */
@Serializable(with = VerificationStatus.Serializer::class)
enum class VerificationStatus(override val wire: String) : WireEnum {
    None("none"), Pending("pending"), Approved("approved"), Rejected("rejected"), Unknown("");

    internal object Serializer : WireEnumSerializer<VerificationStatus>("VerificationStatus", VerificationStatus.entries.toTypedArray(), VerificationStatus.Unknown)
}

@Serializable(with = TicketStatus.Serializer::class)
enum class TicketStatus(override val wire: String) : WireEnum {
    Open("open"), Answered("answered"), Closed("closed"), Unknown("");

    internal object Serializer : WireEnumSerializer<TicketStatus>("TicketStatus", TicketStatus.entries.toTypedArray(), TicketStatus.Unknown)
}

@Serializable(with = TicketAuthor.Serializer::class)
enum class TicketAuthor(override val wire: String) : WireEnum {
    User("user"), Staff("staff"), Unknown("");

    internal object Serializer : WireEnumSerializer<TicketAuthor>("TicketAuthor", TicketAuthor.entries.toTypedArray(), TicketAuthor.Unknown)
}
