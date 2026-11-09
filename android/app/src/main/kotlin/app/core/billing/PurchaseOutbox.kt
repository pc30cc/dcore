package app.core.billing

import app.core.common.Diag
import app.core.model.PurchaseKind
import app.core.storage.SecretStore
import app.core.store.Store
import app.core.store.StorePurchase
import app.core.store.StorePurchaseState
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import java.security.MessageDigest

/** What is still to be done with a purchase the store reported. */
@Serializable
enum class OutboxStage {
    /** The server has not answered for it yet: send it. */
    VERIFY,

    /** The server credited a Cafe Bazaar pack: consume it in Bazaar, so it can be bought again. */
    CONSUME,
}

/**
 * A purchase the store reported and the server has not settled yet, kept on
 * the phone (sealed, the token is a credential) until it has: a crash, a
 * dead network or a closed app between the store and the server never loses
 * one. The token is the key: the same purchase is never queued twice, and
 * the server records a token once, so a resend never grants twice.
 */
@Serializable
data class QueuedPurchase(
    /** The account that bought it; it is sent only while that account is signed in. */
    val account: String,
    val store: String,
    val productId: String,
    val kind: PurchaseKind,
    val token: String,
    val originalJson: String = "",
    val signature: String? = null,
    val pending: Boolean = false,
    val stage: OutboxStage = OutboxStage.VERIFY,
    val queuedAt: Long,
    val attempts: Int = 0,
    /** Not before (epoch ms): the backoff after a failed attempt. */
    val nextAt: Long = 0,
) {
    val hash: String get() = PurchaseTokens.hash(token)

    override fun toString(): String = "QueuedPurchase(${store}/$productId, ${hash.take(8)}, $stage, attempts=$attempts)"

    companion object {
        fun of(account: String, purchase: StorePurchase, productId: String, kind: PurchaseKind, now: Long) = QueuedPurchase(
            account = account,
            store = purchase.store.id,
            productId = productId,
            kind = kind,
            token = purchase.purchaseToken,
            originalJson = purchase.originalJson,
            signature = purchase.signature,
            pending = purchase.state == StorePurchaseState.PENDING,
            queuedAt = now,
        )
    }
}

object PurchaseTokens {
    /** A purchase token's SHA-256, hex: what is kept of tokens the server settled. Never logged whole. */
    fun hash(token: String): String =
        MessageDigest.getInstance("SHA-256").digest(token.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
}

/**
 * The durable queue of [QueuedPurchase]s, one sealed value in the secure
 * store, mirrored in memory: when the phone's key store cannot seal (it
 * happens: a broken Keystore, a restored backup), the queue still holds for
 * this process and the restore at the next launch finds the purchase again.
 */
class PurchaseOutbox(private val store: SecretStore, private val diag: Diag = Diag.Silent) {
    private val lock = Mutex()
    private val codec = ListSerializer(QueuedPurchase.serializer())
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private var memory: List<QueuedPurchase>? = null

    suspend fun all(): List<QueuedPurchase> = lock.withLock { read() }

    /** Adds [entry], or keeps the one already queued for its token (its stage and attempts). */
    suspend fun add(entry: QueuedPurchase): QueuedPurchase = lock.withLock {
        val list = read()
        list.firstOrNull { it.token == entry.token }?.let { existing ->
            // A pending purchase the store now reports paid is sent again at once.
            if (existing.pending && !entry.pending) {
                val moved = existing.copy(pending = false, nextAt = 0, attempts = 0)
                write(list.map { if (it.token == entry.token) moved else it })
                return@withLock moved
            }
            return@withLock existing
        }
        write(list + entry)
        entry
    }

    suspend fun update(entry: QueuedPurchase) = lock.withLock {
        write(read().map { if (it.token == entry.token) entry else it })
    }

    suspend fun remove(token: String) = lock.withLock {
        write(read().filterNot { it.token == token })
    }

    private suspend fun read(): List<QueuedPurchase> {
        memory?.let { return it }
        val stored = store.readSecret(KEY)?.let { raw ->
            runCatching { json.decodeFromString(codec, raw) }.getOrElse {
                diag.warn(AREA, "outbox unreadable, started again")
                emptyList()
            }
        } ?: emptyList()
        memory = stored
        return stored
    }

    private suspend fun write(list: List<QueuedPurchase>) {
        memory = list
        store.writeSecret(KEY, if (list.isEmpty()) null else json.encodeToString(codec, list))
    }

    private companion object {
        /** A fixed neutral name, never the brand's. */
        const val KEY = "billing.outbox"
        const val AREA = "Billing"
    }
}

/**
 * The tokens the server has settled, by hash, with the state it answered,
 * so a restore at launch sends only what the server does not know. A plain
 * value: hashes, no token.
 */
class KnownPurchases(private val store: SecretStore, private val limit: Int = LIMIT) {
    private val lock = Mutex()
    private val codec = MapSerializer(String.serializer(), String.serializer())

    /** The state the server last gave [token], or null. */
    suspend fun state(token: String): String? = lock.withLock { read()[PurchaseTokens.hash(token)] }

    /**
     * Whether [token] still has to go to the server: unknown, a pending
     * purchase the store now reports paid, or an answer that said "ask later".
     */
    suspend fun needsSending(token: String, storeState: StorePurchaseState): Boolean {
        val known = state(token) ?: return true
        return when (known) {
            PENDING -> storeState == StorePurchaseState.PURCHASED
            UNAVAILABLE -> true
            else -> false
        }
    }

    suspend fun put(token: String, state: String) = lock.withLock {
        val map = LinkedHashMap(read())
        map.remove(PurchaseTokens.hash(token))
        map[PurchaseTokens.hash(token)] = state
        // The oldest go first: a restore of a forgotten one costs the server nothing.
        while (map.size > limit) map.remove(map.keys.first())
        store.write(KEY, Json.encodeToString(codec, map))
    }

    suspend fun clear() = lock.withLock { store.remove(KEY) }

    private suspend fun read(): Map<String, String> =
        store.read(KEY)?.let { runCatching { Json.decodeFromString(codec, it) }.getOrNull() } ?: emptyMap()

    companion object {
        const val PENDING = "pending"
        const val UNAVAILABLE = "unavailable"
        private const val KEY = "billing.known"
        private const val LIMIT = 200
    }
}

/** The store of a build, by its wire id. */
fun storeOf(id: String): Store? = Store.entries.firstOrNull { it.id == id }
