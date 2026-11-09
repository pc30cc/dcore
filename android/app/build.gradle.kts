import groovy.json.JsonSlurper
import java.net.URI
import java.util.Base64

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    // Room's annotation processor, and the plugin that exports its schema.
    alias(libs.plugins.ksp)
    alias(libs.plugins.androidx.room)
}

/**
 * A build value from a Gradle property or the environment, property first, so
 * `-PversionCode=42` beats a stale shell export.
 */
fun buildValue(property: String, variable: String): String? =
    providers.gradleProperty(property).orNull?.takeIf { it.isNotBlank() }
        ?: providers.environmentVariable(variable).orNull?.takeIf { it.isNotBlank() }

/** A Java string literal, for `buildConfigField`. */
fun literal(value: String): String =
    "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

/** An Android string resource value: escapes what aapt2 would otherwise interpret. */
fun androidString(value: String): String =
    value.replace("\\", "\\\\").replace("'", "\\'").replace("\"", "\\\"")
        .let { if (it.startsWith("@") || it.startsWith("?")) "\\$it" else it }

// MARK: - The brand
//
// Everything a person sees as the product's identity (name, application id,
// version, colours, server, legal links) comes from brands/<id>/brand.json,
// chosen with -Pbrand=<id> (default `_template`). No brand name is written in
// this file or anywhere in the code. Read once, at configuration time, through
// a provider so the configuration cache knows the file is an input.

val brandId: String = providers.gradleProperty("brand").orNull?.takeIf { it.isNotBlank() } ?: "_template"
if (!Regex("[A-Za-z0-9_-]+").matches(brandId)) {
    throw GradleException("-Pbrand must be a folder name under brands/ (letters, digits, '_' or '-'), got '$brandId'")
}

/**
 * The folder that holds the brands: `-PbrandsDir=<path>` (absolute, or
 * relative to the Android project), else the repository's `brands/`. A brand
 * whose files may not be published (licensed fonts, say) lives outside the
 * repository and is built with `-PbrandsDir=... -Pbrand=<id>`.
 */
val brandsRoot: Directory = providers.gradleProperty("brandsDir").orNull?.takeIf { it.isNotBlank() }
    ?.let { rootProject.layout.projectDirectory.dir(it) }
    ?: rootProject.layout.projectDirectory.dir("../brands")
val brandDir: Directory = brandsRoot.dir(brandId)
val brandFile = brandDir.file("brand.json")
val brandText: String = providers.fileContents(brandFile).asText.orNull
    ?: throw GradleException("Brand '$brandId' not found: expected ${brandFile.asFile.normalize()}")

@Suppress("UNCHECKED_CAST")
val brandJson: Map<String, Any?> = JsonSlurper().parseText(brandText) as? Map<String, Any?>
    ?: throw GradleException("brands/$brandId/brand.json must be a JSON object")

/** The value at a dotted path in brand.json, or null. */
fun brand(path: String): Any? = path.split('.').fold(brandJson as Any?) { node, key ->
    (node as? Map<*, *>)?.get(key)
}

fun brandString(path: String): String? = (brand(path) as? String)?.trim()?.takeIf { it.isNotEmpty() }

fun requireBrandString(path: String): String =
    brandString(path) ?: throw GradleException("brands/$brandId/brand.json: '$path' is required")

val applicationIdPattern = Regex("[a-zA-Z][a-zA-Z0-9_]*(\\.[a-zA-Z][a-zA-Z0-9_]*)+")
val hexColourPattern = Regex("#[0-9A-Fa-f]{6}")
val hostPattern = Regex("[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]{1,5})?")

/** The store's application id: `android.applicationId.<store>`, else `android.package`. */
fun brandApplicationId(store: String): String {
    val id = brandString("android.applicationId.$store") ?: requireBrandString("android.package")
    if (!applicationIdPattern.matches(id)) {
        throw GradleException("brands/$brandId/brand.json: '$id' is not a valid Android application id")
    }
    return id
}

/** A `#RRGGBB` colour from brand.json, as the Long a Compose `Color(...)` takes (opaque). */
fun brandColour(path: String): String {
    val hex = requireBrandString(path)
    if (!hexColourPattern.matches(hex)) {
        throw GradleException("brands/$brandId/brand.json: '$path' must be #RRGGBB, got '$hex'")
    }
    return "0xFF${hex.substring(1).uppercase()}L"
}

/**
 * An optional `#RRGGBB` colour: the Long for `Color(...)`, or `0L` when
 * brand.json leaves it out (the app then uses the design's own value; an
 * opaque colour is never 0, so 0 cannot be mistaken for one).
 */
fun brandColourOrUnset(path: String): String =
    if (brandString(path) == null) "0L" else brandColour(path)

/** The design roles a brand may recolour, each `{ light, dark }` under `colors` (all optional). */
val brandColourRoles = listOf(
    "gradientStart" to "GRADIENT_START",
    "gradientMid" to "GRADIENT_MID",
    "gradientEnd" to "GRADIENT_END",
    "alive" to "ALIVE",
    "aliveText" to "ALIVE_TEXT",
)

fun brandHost(path: String): String {
    val host = requireBrandString(path).lowercase()
    if (!hostPattern.matches(host)) {
        throw GradleException("brands/$brandId/brand.json: '$path' must be a host name, got '$host'")
    }
    return host
}

/** The store's version code: `-P<store>.versionCode`, `-PversionCode`, then brand.json. */
fun versionCodeFor(store: String): Int {
    val raw = buildValue("$store.versionCode", "${store.uppercase()}_VERSION_CODE")
        ?: buildValue("versionCode", "APP_VERSION_CODE")
    val code = raw?.toIntOrNull() ?: (brand("android.versionCode") as? Number)?.toInt() ?: 1
    if (code < 1) throw GradleException("versionCode must be a positive integer, got '$raw'")
    return code
}

fun versionNameFor(store: String): String =
    buildValue("$store.versionName", "${store.uppercase()}_VERSION_NAME")
        ?: buildValue("versionName", "APP_VERSION_NAME")
        ?: brandString("android.versionName")
        ?: "0.1.0"

/**
 * The API a store's build talks to: `-P<store>.apiBaseUrl` (a staging server,
 * say), else `https://<domains.api>` from brand.json.
 */
fun apiBaseUrlFor(store: String): String =
    buildValue("$store.apiBaseUrl", "${store.uppercase()}_API_BASE_URL")?.trimEnd('/')
        ?: "https://${brandHost("domains.api")}"

/**
 * The realtime (Centrifugo) socket: `-P<store>.realtimeUrl`, else
 * `wss://<domains.realtime or domains.api>/connection/websocket`, which is
 * Centrifugo's own path.
 */
fun realtimeUrlFor(store: String): String =
    buildValue("$store.realtimeUrl", "${store.uppercase()}_REALTIME_URL")
        ?: "wss://${if (brandString("domains.realtime") != null) brandHost("domains.realtime") else brandHost("domains.api")}/connection/websocket"

/**
 * The store's Firebase client values (FCM without `google-services.json`):
 * `-P<store>.firebase.<key>` / `<STORE>_FIREBASE_<KEY>`, else
 * `android.firebase.<store>.<key>` in brand.json. Public identifiers that ship
 * in every APK made with them, not credentials (the server holds the sending
 * key). Empty ones leave push to the server's config, or off.
 */
fun firebaseValue(store: String, key: String): String =
    buildValue("$store.firebase.$key", "${store.uppercase()}_FIREBASE_${key.uppercase()}")
        ?: brandString("android.firebase.$store.$key")
        ?: ""

// MARK: - The signed origins list
//
// The app learns its hosts from a signed list (net/origins). Compiled in, the
// same for both stores: `origins.publicKeys` (at most two `{kid, key}`, raw
// Ed25519 public keys of 32 bytes in base64url: the key in use and, during a
// rotation, the next), `origins.bootstrap` (https URLs of published copies)
// and brand.json `id`, which the list must name.

val originsKidPattern = Regex("[A-Za-z0-9._-]{1,32}")
val originsKeyPattern = Regex("[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]")
val brandIdPattern = Regex("[a-z0-9_][a-z0-9_-]{0,39}")

/** brand.json `id`, which is also the folder's name (the server loads the brand by it). */
val brandJsonId: String = requireBrandString("id").also { id ->
    if (!brandIdPattern.matches(id)) {
        throw GradleException("brands/$brandId/brand.json: 'id' must be 1-40 lower-case letters, digits, '_' or '-', got '$id'")
    }
    if (id != brandId) throw GradleException("brands/$brandId/brand.json says id '$id'; it must be the folder's name, '$brandId'")
}

/** `origins.publicKeys` as `kid:key`, checked: at most two, distinct ids, 32-byte keys. */
fun brandOriginsKeys(): List<String> {
    val raw = brand("origins.publicKeys") ?: return emptyList()
    val list = raw as? List<*> ?: throw GradleException("brands/$brandId/brand.json: 'origins.publicKeys' must be a list")
    if (list.size > 2) throw GradleException("brands/$brandId/brand.json: 'origins.publicKeys' holds at most two keys (the one in use and the next)")
    val pairs = list.mapIndexed { index, entry ->
        val where = "brands/$brandId/brand.json: 'origins.publicKeys[$index]'"
        val key = entry as? Map<*, *> ?: throw GradleException("$where must be an object with 'kid' and 'key'")
        val kid = (key["kid"] as? String)?.trim().orEmpty()
        val value = (key["key"] as? String)?.trim().orEmpty()
        if (!originsKidPattern.matches(kid)) throw GradleException("$where: 'kid' must be 1-32 letters, digits, '.', '_' or '-'")
        val bytes = runCatching { Base64.getUrlDecoder().decode(value) }.getOrNull()
        if (!originsKeyPattern.matches(value) || bytes?.size != 32) {
            throw GradleException("$where: 'key' must be a raw Ed25519 public key, 32 bytes in base64url (43 characters)")
        }
        "$kid:$value"
    }
    if (pairs.map { it.substringBefore(':') }.toSet().size != pairs.size) {
        throw GradleException("brands/$brandId/brand.json: 'origins.publicKeys' ids must differ")
    }
    return pairs
}

/** `origins.bootstrap`, checked: https URLs of a file, no query, fragment or user name; at most eight. */
fun brandOriginsBootstrap(): List<String> {
    val raw = brand("origins.bootstrap") ?: return emptyList()
    val list = raw as? List<*> ?: throw GradleException("brands/$brandId/brand.json: 'origins.bootstrap' must be a list")
    if (list.size > 8) throw GradleException("brands/$brandId/brand.json: 'origins.bootstrap' holds at most eight URLs")
    val urls = list.mapIndexed { index, entry ->
        val text = (entry as? String)?.trim().orEmpty()
        val uri = runCatching { URI(text) }.getOrNull()
        val path = uri?.rawPath.orEmpty()
        val ok = uri != null && uri.scheme == "https" && !uri.host.isNullOrEmpty() && uri.rawUserInfo == null &&
            uri.rawQuery == null && uri.rawFragment == null && path.length > 1 && !path.endsWith("/") &&
            text.length <= 300 && text.none { it.isWhitespace() || it == ',' }
        if (!ok) {
            throw GradleException("brands/$brandId/brand.json: 'origins.bootstrap[$index]' must be an https URL of a file (no query, fragment or user name), got '$text'")
        }
        text
    }
    if (urls.toSet().size != urls.size) throw GradleException("brands/$brandId/brand.json: 'origins.bootstrap' lists a URL twice")
    return urls
}

val originsKeys: List<String> = brandOriginsKeys()
val originsBootstrap: List<String> = brandOriginsBootstrap()

android {
    // The code's package. Neutral and never a brand: R, BuildConfig, the R8
    // rules and the Room schema folder name classes by it. What a phone knows
    // the app by is the applicationId, which each store flavor sets from
    // brand.json.
    namespace = "app.core"
    compileSdk = 37

    defaultConfig {
        // Android 7.0: many users keep older devices far longer than Play's
        // own charts suggest.
        minSdk = 24
        // Play's requirement since 2026-08-31: new apps and updates target
        // Android 16 (API 36) or higher. Cafe Bazaar asks for less.
        targetSdk = 36

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        // The name under the icon, and the colours behind the launcher mark
        // (the "yes" gradient; the brand colour when the brand names none).
        resValue("string", "app_name", androidString(requireBrandString("appName")))
        resValue("color", "brand_primary", requireBrandString("colors.brand.light"))
        resValue("color", "brand_gradient_start", brandString("colors.gradientStart.light") ?: requireBrandString("colors.brand.light"))
        resValue("color", "brand_gradient_end", brandString("colors.gradientEnd.light") ?: requireBrandString("colors.brand.light"))

        buildConfigField("String", "BRAND_ID", literal(brandJsonId))
        // The signed origins list (net/origins): the keys it may be signed
        // with (`kid:key`, comma-separated) and its published copies
        // (space-separated). Public values, the same in both stores.
        buildConfigField("String", "ORIGINS_PUBLIC_KEYS", literal(originsKeys.joinToString(",")))
        buildConfigField("String", "ORIGINS_BOOTSTRAP", literal(originsBootstrap.joinToString(" ")))
        // The name in sentences (`{appName}` in the strings). The server's
        // GET /config may replace it at run time; this is the build's default.
        buildConfigField("String", "APP_NAME", literal(requireBrandString("appName")))
        buildConfigField("long", "BRAND_PRIMARY_LIGHT", brandColour("colors.brand.light"))
        buildConfigField("long", "BRAND_PRIMARY_DARK", brandColour("colors.brand.dark"))
        buildConfigField("long", "BRAND_ON_PRIMARY_LIGHT", brandColour("colors.onBrand.light"))
        buildConfigField("long", "BRAND_ON_PRIMARY_DARK", brandColour("colors.onBrand.dark"))
        for ((role, field) in brandColourRoles) {
            buildConfigField("long", "BRAND_${field}_LIGHT", brandColourOrUnset("colors.$role.light"))
            buildConfigField("long", "BRAND_${field}_DARK", brandColourOrUnset("colors.$role.dark"))
        }
        buildConfigField("String", "PRIVACY_URL", literal(brandString("legal.privacyUrl") ?: ""))
        buildConfigField("String", "TERMS_URL", literal(brandString("legal.termsUrl") ?: ""))
        buildConfigField("String", "GUIDELINES_URL", literal(brandString("legal.guidelinesUrl") ?: ""))
        buildConfigField("String", "DELETE_ACCOUNT_URL", literal(brandString("legal.deleteAccountUrl") ?: ""))
        buildConfigField("String", "SUPPORT_EMAIL", literal(brandString("legal.supportEmail") ?: ""))
    }

    /**
     * A store's release key, from the environment only: `<STORE>_KEYSTORE`,
     * `<STORE>_KEYSTORE_PASSWORD`, `<STORE>_KEY_ALIAS`, `<STORE>_KEY_PASSWORD`
     * (`BAZAAR_KEYSTORE`, `PLAY_KEYSTORE`, ...). Without them a release build is
     * unsigned, which is the right outcome: an unsigned APK cannot be
     * installed by accident. For Play this is the UPLOAD key (Play App Signing
     * holds the app's key); for Cafe Bazaar it is the app's own signing key.
     */
    fun releaseKey(store: String) =
        signingConfigs.create("${store}Release") {
            val env = store.uppercase()
            val path = System.getenv("${env}_KEYSTORE")
            if (path != null && file(path).exists()) {
                storeFile = file(path)
                storePassword = System.getenv("${env}_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("${env}_KEY_ALIAS")
                keyPassword = System.getenv("${env}_KEY_PASSWORD")
            }
        }.takeIf { it.storeFile != null }

    /**
     * Two apps from one source, one per store. Their settings differ
     * completely, so everything store-specific lives in these two blocks or in
     * each flavor's own source set (`src/bazaar`, `src/play`): the billing SDK,
     * updates, rating, sign-in options, the default language, the server.
     * `src/main` references neither store's SDK; `StoreModule` (one per flavor
     * source set) is how main reaches them.
     */
    flavorDimensions += "store"
    productFlavors {
        create("bazaar") {
            dimension = "store"
            applicationId = brandApplicationId("bazaar")
            versionCode = versionCodeFor("bazaar")
            versionName = versionNameFor("bazaar")
            signingConfig = releaseKey("bazaar")
            // Poolakey ships no consumer rules of its own.
            proguardFile("proguard-bazaar.pro")

            buildConfigField("String", "STORE", literal("bazaar"))
            buildConfigField("String", "API_BASE_URL", literal(apiBaseUrlFor("bazaar")))
            buildConfigField("String", "REALTIME_WS_URL", literal(realtimeUrlFor("bazaar")))
            buildConfigField("String", "FIREBASE_APP_ID", literal(firebaseValue("bazaar", "appId")))
            buildConfigField("String", "FIREBASE_API_KEY", literal(firebaseValue("bazaar", "apiKey")))
            buildConfigField("String", "FIREBASE_PROJECT_ID", literal(firebaseValue("bazaar", "projectId")))
            buildConfigField("String", "FIREBASE_SENDER_ID", literal(firebaseValue("bazaar", "projectNumber")))
            // Persian, whatever the phone's language, until the person picks
            // another in the app.
            buildConfigField("String", "DEFAULT_LOCALE", literal("fa"))
            buildConfigField("boolean", "LOCALE_FOLLOWS_DEVICE", "false")
            // Google sign-in needs Google Play services, which many of these
            // phones do not have; sign-in is by phone number.
            buildConfigField("boolean", "SUPPORTS_GOOGLE_SIGN_IN", "false")
            // The RSA public key from the Cafe Bazaar developer panel, for
            // Poolakey's local signature check. Public, not a secret, but per
            // app: supplied at build time, never committed. Empty turns the
            // local check off; the server's verification is what counts.
            buildConfigField(
                "String",
                "BAZAAR_RSA_PUBLIC_KEY",
                literal(buildValue("bazaar.rsaPublicKey", "BAZAAR_RSA_PUBLIC_KEY") ?: ""),
            )
        }
        create("play") {
            dimension = "store"
            applicationId = brandApplicationId("play")
            versionCode = versionCodeFor("play")
            versionName = versionNameFor("play")
            signingConfig = releaseKey("play")
            proguardFile("proguard-play.pro")

            buildConfigField("String", "STORE", literal("play"))
            buildConfigField("String", "API_BASE_URL", literal(apiBaseUrlFor("play")))
            buildConfigField("String", "REALTIME_WS_URL", literal(realtimeUrlFor("play")))
            buildConfigField("String", "FIREBASE_APP_ID", literal(firebaseValue("play", "appId")))
            buildConfigField("String", "FIREBASE_API_KEY", literal(firebaseValue("play", "apiKey")))
            buildConfigField("String", "FIREBASE_PROJECT_ID", literal(firebaseValue("play", "projectId")))
            buildConfigField("String", "FIREBASE_SENDER_ID", literal(firebaseValue("play", "projectNumber")))
            // The phone's language when the app has it, English otherwise.
            buildConfigField("String", "DEFAULT_LOCALE", literal("en"))
            buildConfigField("boolean", "LOCALE_FOLLOWS_DEVICE", "true")
            buildConfigField("boolean", "SUPPORTS_GOOGLE_SIGN_IN", "true")
            // The Google Cloud project number Play Integrity's standard API
            // needs (Play Console, App integrity). Not a secret; 0 means not
            // configured, and the integrity provider says so.
            buildConfigField(
                "long",
                "PLAY_CLOUD_PROJECT_NUMBER",
                "${buildValue("play.cloudProjectNumber", "PLAY_CLOUD_PROJECT_NUMBER")?.toLongOrNull() ?: 0L}L",
            )
            // The OAuth web client Google ID tokens are issued for (the
            // server verifies them against the same id). Public, not a
            // secret; empty leaves "Continue with Google" out of the build.
            buildConfigField(
                "String",
                "GOOGLE_WEB_CLIENT_ID",
                literal(buildValue("play.googleWebClientId", "PLAY_GOOGLE_WEB_CLIENT_ID") ?: ""),
            )
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            // The package carries no record of the repository it came from.
            vcsInfo.include = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // NO signingConfig here, ever: a build type's wins over a
            // flavor's, so one set here would sign both stores' apps with it.
        }
    }

    check(buildTypes.getByName("release").signingConfig == null) {
        "buildTypes.release must not set a signingConfig: each store flavor names its own release key"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        // java.time is API 26; minSdk is 24.
        isCoreLibraryDesugaringEnabled = true
    }

    androidResources {
        // The three shipped languages, and nothing a dependency brings: the
        // resource shrinker must keep exactly the translations the language
        // picker offers.
        localeFilters += setOf("en", "fa", "tr")
        // Android 13+ lists the app's languages in system settings (per-app
        // language). Generated from the res folders; the default language is
        // named in res/resources.properties.
        generateLocaleConfig = true
    }

    /**
     * One bundle carries every language. The in-app picker switches to a
     * language the phone itself may not use, and a language split Play did
     * not deliver would leave that choice showing English. Three languages
     * cost little.
     */
    bundle {
        language {
            enableSplit = false
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
        resValues = true
    }

    lint {
        lintConfig = file("lint.xml")
        abortOnError = true
        checkReleaseBuilds = true
    }

    testOptions {
        unitTests {
            // Robolectric reads the merged manifest and resources.
            isIncludeAndroidResources = true
            // Robolectric's Android 16 (API 36, the targetSdk) sandbox reaches
            // java.io.FileDescriptor through jdk.internal.access, which JDK 17+
            // keeps closed: without these every Robolectric test fails with
            // "Failed to interact with raw FileDescriptor internals". This runs
            // them on the SDK the app targets rather than pinning an older one.
            all { test ->
                test.jvmArgs(
                    "--add-exports=java.base/jdk.internal.access=ALL-UNNAMED",
                    "--add-opens=java.base/java.io=ALL-UNNAMED",
                )
                // Files the tests read from outside the module: without them as
                // inputs a changed server fixture, problem catalogue or brand
                // file leaves the test task up to date (or served from the
                // build cache) and the contract tests never see the change.
                // Where the tests read this build's brand.json (brands/ or -PbrandsDir).
                test.systemProperty("app.brandsDir", brandsRoot.asFile.absolutePath)
                test.inputs.files(
                    fileTree(rootProject.layout.projectDirectory.dir("../server/packages/shared")) {
                        include("fixtures/**", "src/problem.ts")
                    },
                    brandFile,
                    rootProject.layout.projectDirectory.file("gradle.properties"),
                ).withPathSensitivity(PathSensitivity.RELATIVE).withPropertyName("externalTestFiles")
            }
        }
    }
}

// MARK: - A signed release carries the origins keys
//
// Without `origins.publicKeys` an app accepts no origins list and keeps the
// hosts it was built with for good. A release signed with its store's key
// fails the build; an unsigned local release (no `<STORE>_KEYSTORE`) only
// warns, so the local checks keep running on the template brand.

abstract class CheckOriginsKeys : DefaultTask() {
    @get:Input abstract val keyCount: Property<Int>
    @get:Input abstract val signed: Property<Boolean>
    @get:Input abstract val brand: Property<String>

    @TaskAction
    fun check() {
        if (keyCount.get() > 0) return
        val problem = "brands/${brand.get()}/brand.json lists no origins.publicKeys: the app would accept no signed origins list and keep its compiled hosts"
        if (signed.get()) throw GradleException("$problem. Add the public key printed by origins:keygen before signing a release.")
        logger.warn("w: $problem (unsigned release build: allowed)")
    }
}

for (store in listOf("bazaar", "play")) {
    val variant = "${store.replaceFirstChar { it.uppercase() }}Release"
    val signedRelease = android.productFlavors.getByName(store).signingConfig != null
    val check = tasks.register<CheckOriginsKeys>("check${variant}OriginsKeys") {
        keyCount.set(originsKeys.size)
        signed.set(signedRelease)
        brand.set(brandId)
    }
    tasks.matching { it.name == "pre${variant}Build" }.configureEach { dependsOn(check) }
}

// MARK: - The signed-out welcome: copy, colours and pictures from brand.json
//
// `welcome` in brand.json is optional: per-locale `eyebrow`, `headline` (the
// emphasised words between asterisks) and `subtitle`, an optional `gradient`
// (`top`, `middle`, `bottom`, #RRGGBB) and optional `images` (file names in
// brands/<id>/welcome/). It is checked here and written, with the pictures it
// names, to the generated assets folder `brand/` (welcome.json and welcome/*),
// which the app reads at run time (feature/auth/welcome/BrandWelcome).

val welcomeImagePattern = Regex("[A-Za-z0-9_][A-Za-z0-9_.-]*\\.(png|jpg|jpeg|webp)")
val brandWelcomeFolder = brandDir.dir("welcome")

/** The welcome block as the app reads it, checked; `{}` when the brand has none. */
fun brandWelcomeJson(): String {
    val block = brand("welcome") ?: return "{}"
    if (block !is Map<*, *>) throw GradleException("brands/$brandId/brand.json: 'welcome' must be an object")
    val out = linkedMapOf<String, Any?>("defaultLocale" to (brandString("defaultLocale") ?: "en"))
    for (key in listOf("eyebrow", "headline", "subtitle")) {
        val texts = block[key] ?: continue
        if (texts !is Map<*, *> || texts.values.any { it !is String }) {
            throw GradleException("brands/$brandId/brand.json: 'welcome.$key' must map locales to strings")
        }
        if (key == "headline") {
            texts.forEach { (locale, text) ->
                if ((text as String).count { it == '*' } % 2 != 0) {
                    throw GradleException("brands/$brandId/brand.json: 'welcome.headline.$locale' has an unpaired '*'")
                }
            }
        }
        out[key] = texts
    }
    (block["gradient"] as? Map<*, *>)?.let { gradient ->
        val colours = listOf("top", "middle", "bottom").map { stop ->
            val hex = (gradient[stop] as? String)?.trim()
            if (hex == null || !hexColourPattern.matches(hex)) {
                throw GradleException("brands/$brandId/brand.json: 'welcome.gradient.$stop' must be #RRGGBB")
            }
            stop to hex
        }
        out["gradient"] = colours.toMap()
    }
    val images = (block["images"] as? List<*>).orEmpty().map { it as? String ?: "" }
    images.forEach { name ->
        if (!welcomeImagePattern.matches(name)) {
            throw GradleException("brands/$brandId/brand.json: welcome image '$name' must be a .png, .jpg or .webp file name")
        }
        if (!brandWelcomeFolder.file(name).asFile.isFile) {
            throw GradleException("brands/$brandId/brand.json: welcome image '$name' is not in brands/$brandId/welcome/")
        }
    }
    out["images"] = images
    return groovy.json.JsonOutput.toJson(out)
}

/** Writes `brand/welcome.json` and the pictures it names into a generated assets folder. */
abstract class BrandWelcomeAssets : DefaultTask() {
    @get:Input abstract val welcome: Property<String>

    @get:InputFiles
    @get:PathSensitive(PathSensitivity.NAME_ONLY)
    abstract val images: ConfigurableFileCollection

    @get:OutputDirectory abstract val outputDir: DirectoryProperty

    @TaskAction
    fun write() {
        val root = outputDir.get().asFile.resolve("brand")
        root.deleteRecursively()
        root.resolve("welcome").mkdirs()
        root.resolve("welcome.json").writeText(welcome.get())
        images.files.forEach { it.copyTo(root.resolve("welcome/${it.name}"), overwrite = true) }
    }
}

val welcomeJson = brandWelcomeJson()
@Suppress("UNCHECKED_CAST")
val welcomeImages = ((groovy.json.JsonSlurper().parseText(welcomeJson) as Map<String, Any?>)["images"] as? List<String>).orEmpty()
val brandWelcomeAssets = tasks.register<BrandWelcomeAssets>("brandWelcomeAssets") {
    welcome.set(welcomeJson)
    images.from(welcomeImages.map { brandWelcomeFolder.file(it) })
}

// MARK: - Fonts: the brand's own files, else the bundled open ones
//
// `fonts.persianFiles` ({ regular, medium, bold }) and `fonts.latinFiles`
// ({ regular, medium, semibold?, bold }) in brand.json name font files in the
// brand's folder (TrueType or OpenType); either may also name a `license`
// text, which the app lists under its open-source licences. A licensed font
// never enters the repository: such a brand lives outside it (`brandsDir`).
// Without files the bundled open fonts are used: Vazirmatn (Persian) and
// Be Vietnam Pro (Latin), both SIL OFL 1.1, in `src/main/bundled-fonts/`.
// Either way the files are copied under fixed resource names
// (`brand_fa_regular`, ..., `brand_latin_bold`) into a generated res folder,
// so the code names one set of fonts whatever the brand.

val fontFilePattern = Regex("(?i)[A-Za-z0-9_][A-Za-z0-9_./-]*\\.(ttf|otf)")
val licenseFilePattern = Regex("[A-Za-z0-9_][A-Za-z0-9_./-]*\\.txt")
val bundledFonts: Directory = layout.projectDirectory.dir("src/main/bundled-fonts")

/** A file named by brand.json, checked: inside the brand's folder, the right kind, and there. */
fun brandFontFile(path: String, value: Any?, pattern: Regex, what: String): File {
    val name = (value as? String)?.trim().orEmpty()
    val where = "brands/$brandId/brand.json: '$path'"
    if (!pattern.matches(name) || name.split('/').any { it == ".." || it == "." }) {
        throw GradleException("$where must be a $what in the brand's folder, got '$name'")
    }
    val file = brandDir.file(name).asFile
    if (!file.canonicalPath.startsWith(brandDir.asFile.canonicalPath + File.separator)) {
        throw GradleException("$where points outside the brand's folder")
    }
    if (!file.isFile) throw GradleException("$where: ${file.path} does not exist")
    if (pattern == fontFilePattern) {
        // TrueType (00 01 00 00, 'true') or OpenType ('OTTO'); a WOFF or WOFF2 file is not a font Android reads.
        val head = file.inputStream().use { input -> ByteArray(4).also { input.read(it) } }
        val tag = String(head, Charsets.ISO_8859_1)
        if (!(head.contentEquals(byteArrayOf(0, 1, 0, 0)) || tag == "OTTO" || tag == "true")) {
            throw GradleException("$where: ${file.name} is not a TrueType or OpenType font")
        }
    }
    return file
}

/** One script's font files by weight (`regular`, `medium`, `semibold`, `bold`), plus its licence, or null for the bundled set. */
class FontSet(val name: String, val weights: Map<String, File>, val license: File?)

fun brandFontSet(key: String, required: List<String>, optional: List<String>): FontSet? {
    val block = brand("fonts.$key") ?: return null
    if (block !is Map<*, *>) throw GradleException("brands/$brandId/brand.json: 'fonts.$key' must be an object")
    val unknown = block.keys.map { it.toString() } - (required + optional + "license").toSet()
    if (unknown.isNotEmpty()) throw GradleException("brands/$brandId/brand.json: 'fonts.$key' has unknown keys $unknown")
    val weights = linkedMapOf<String, File>()
    for (weight in required) {
        weights[weight] = brandFontFile("fonts.$key.$weight", block[weight], fontFilePattern, ".ttf or .otf file")
    }
    for (weight in optional) {
        if (block[weight] != null) weights[weight] = brandFontFile("fonts.$key.$weight", block[weight], fontFilePattern, ".ttf or .otf file")
    }
    val license = block["license"]?.let { brandFontFile("fonts.$key.license", it, licenseFilePattern, ".txt file") }
    val family = if (key == "persianFiles") brandString("fonts.persian") else brandString("fonts.latin")
    return FontSet(family ?: "", weights, license)
}

val persianFonts: FontSet = brandFontSet("persianFiles", listOf("regular", "medium", "bold"), emptyList())
    ?: FontSet(
        "Vazirmatn",
        listOf("regular", "medium", "bold").associateWith { bundledFonts.file("persian/vazirmatn_$it.ttf").asFile },
        bundledFonts.file("persian/OFL.txt").asFile,
    )
val latinFonts: FontSet = brandFontSet("latinFiles", listOf("regular", "medium", "bold"), listOf("semibold"))
    ?: FontSet(
        "Be Vietnam Pro",
        listOf("regular", "medium", "semibold", "bold").associateWith { bundledFonts.file("latin/bevietnampro_$it.ttf").asFile },
        bundledFonts.file("latin/OFL.txt").asFile,
    )

/**
 * Copies the two font sets into `font/` under fixed names, their licences
 * into `raw/` (empty when there is none to show) and their family names into
 * `values/brand_fonts.xml`. Latin `semibold` falls back to `bold`.
 */
abstract class BrandFonts : DefaultTask() {
    @get:InputFile @get:PathSensitive(PathSensitivity.NONE) abstract val faRegular: RegularFileProperty
    @get:InputFile @get:PathSensitive(PathSensitivity.NONE) abstract val faMedium: RegularFileProperty
    @get:InputFile @get:PathSensitive(PathSensitivity.NONE) abstract val faBold: RegularFileProperty
    @get:InputFile @get:PathSensitive(PathSensitivity.NONE) abstract val latinRegular: RegularFileProperty
    @get:InputFile @get:PathSensitive(PathSensitivity.NONE) abstract val latinMedium: RegularFileProperty
    @get:InputFile @get:PathSensitive(PathSensitivity.NONE) abstract val latinSemibold: RegularFileProperty
    @get:InputFile @get:PathSensitive(PathSensitivity.NONE) abstract val latinBold: RegularFileProperty
    @get:InputFile @get:Optional @get:PathSensitive(PathSensitivity.NONE) abstract val faLicense: RegularFileProperty
    @get:InputFile @get:Optional @get:PathSensitive(PathSensitivity.NONE) abstract val latinLicense: RegularFileProperty
    @get:Input abstract val faName: Property<String>
    @get:Input abstract val latinName: Property<String>
    @get:OutputDirectory abstract val outputDir: DirectoryProperty

    private fun xml(value: String): String =
        value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace("\\", "\\\\").replace("'", "\\'").replace("\"", "\\\"")
            .let { if (it.startsWith("@") || it.startsWith("?")) "\\$it" else it }

    @TaskAction
    fun write() {
        val root = outputDir.get().asFile
        root.deleteRecursively()
        val fonts = root.resolve("font").apply { mkdirs() }
        val copies = listOf(
            "brand_fa_regular" to faRegular, "brand_fa_medium" to faMedium, "brand_fa_bold" to faBold,
            "brand_latin_regular" to latinRegular, "brand_latin_medium" to latinMedium,
            "brand_latin_semibold" to latinSemibold, "brand_latin_bold" to latinBold,
        )
        for ((name, source) in copies) {
            val file = source.get().asFile
            file.copyTo(fonts.resolve("$name.${file.extension.lowercase()}"), overwrite = true)
        }
        val raw = root.resolve("raw").apply { mkdirs() }
        raw.resolve("license_brand_fa.txt").writeText(faLicense.orNull?.asFile?.readText().orEmpty())
        raw.resolve("license_brand_latin.txt").writeText(latinLicense.orNull?.asFile?.readText().orEmpty())
        root.resolve("values").apply { mkdirs() }.resolve("brand_fonts.xml").writeText(
            """
            |<?xml version="1.0" encoding="utf-8"?>
            |<resources>
            |    <string name="brand_font_fa_name" translatable="false">${xml(faName.get())}</string>
            |    <string name="brand_font_latin_name" translatable="false">${xml(latinName.get())}</string>
            |</resources>
            |""".trimMargin(),
        )
    }
}

val brandFonts = tasks.register<BrandFonts>("brandFonts") {
    faRegular.set(persianFonts.weights.getValue("regular"))
    faMedium.set(persianFonts.weights.getValue("medium"))
    faBold.set(persianFonts.weights.getValue("bold"))
    latinRegular.set(latinFonts.weights.getValue("regular"))
    latinMedium.set(latinFonts.weights.getValue("medium"))
    latinSemibold.set(latinFonts.weights["semibold"] ?: latinFonts.weights.getValue("bold"))
    latinBold.set(latinFonts.weights.getValue("bold"))
    persianFonts.license?.let { faLicense.set(it) }
    latinFonts.license?.let { latinLicense.set(it) }
    faName.set(persianFonts.name)
    latinName.set(latinFonts.name)
    outputDir.set(layout.buildDirectory.dir("generated/brandFonts"))
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(brandWelcomeAssets, BrandWelcomeAssets::outputDir)
        variant.sources.res?.addGeneratedSourceDirectory(brandFonts, BrandFonts::outputDir)
    }
}

/** The database schema, one JSON file per version, committed. */
room {
    schemaDirectory("$projectDir/schemas")
}

dependencies {
    coreLibraryDesugaring(libs.desugar.jdk.libs)

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.activity.compose)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.core)
    implementation(libs.androidx.compose.ui.tooling.preview)

    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.navigation3.runtime)
    implementation(libs.androidx.navigation3.ui)
    implementation(libs.androidx.lifecycle.viewmodel.navigation3)
    implementation(libs.androidx.datastore.preferences)

    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    ksp(libs.androidx.room.compiler)

    // Ktor without ContentNegotiation: bodies go through explicit
    // kotlinx.serialization serializers (ApiClient), never reflection.
    implementation(libs.ktor.client.core)
    implementation(libs.ktor.client.okhttp)
    // Installed only when BuildConfig.DEBUG; R8 removes it from release.
    implementation(libs.ktor.client.logging)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    // Ed25519 for the signed origins list (net/origins/Ed25519). Gson is
    // only for Tink's JSON keysets, which the app never reads: excluded, so the
    // Gson other libraries pin stays as it was.
    implementation(libs.tink.android) {
        exclude(group = "com.google.code.gson", module = "gson")
    }

    implementation(libs.androidx.profileinstaller)

    // Push (both stores) and the foreground/background signal realtime follows.
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)
    implementation(libs.play.services.basement)
    implementation(libs.androidx.work.runtime.ktx)
    implementation(libs.androidx.lifecycle.process)

    // Photos: memory and disk cache, downsampling, crossfade (media/ImageLoading).
    implementation(libs.coil.compose)
    implementation(libs.coil.network.okhttp)

    // Calls: WebRTC through LiveKit's SDK (feature/call: LiveKitRoom, VideoView
    // and CallVideoEncoding are the only files that name it).
    implementation(libs.livekit.android)

    // MARK: Store SDKs, one flavor each. `src/main` must never import them.
    "bazaarImplementation"(libs.poolakey)

    "playImplementation"(libs.play.billing.ktx)
    "playImplementation"(libs.play.review.ktx)
    "playImplementation"(libs.play.app.update.ktx)
    "playImplementation"(libs.play.integrity)
    // Play's Age Signals (beta): the age band Play holds, checked once at sign-up (store/PlayAgeSignals).
    "playImplementation"(libs.play.age.signals)
    // Sign in with Google (Credential Manager) and the SMS Retriever: Google
    // Play services APIs, so the Play build only.
    "playImplementation"(libs.androidx.credentials)
    "playImplementation"(libs.androidx.credentials.play.services.auth)
    "playImplementation"(libs.googleid)
    "playImplementation"(libs.play.services.auth.api.phone)

    // @Preview renders through this; debug-only so it never ships.
    debugImplementation(libs.androidx.compose.ui.tooling)
    debugImplementation(libs.androidx.compose.ui.test.manifest)

    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.ext.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.ktor.client.mock)
    testImplementation(libs.androidx.room.testing)
    testImplementation(platform(libs.androidx.compose.bom))
    testImplementation(libs.androidx.compose.ui.test.junit4)
}
