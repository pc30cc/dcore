import groovy.json.JsonSlurper

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
val brandFile = rootProject.layout.projectDirectory.file("../brands/$brandId/brand.json")
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

        // The name under the icon, and the colour behind the launcher mark.
        resValue("string", "app_name", androidString(requireBrandString("appName")))
        resValue("color", "brand_primary", requireBrandString("colors.brand.light"))

        buildConfigField("String", "BRAND_ID", literal(brandId))
        // The name in sentences (`{appName}` in the strings). The server's
        // GET /config may replace it at run time; this is the build's default.
        buildConfigField("String", "APP_NAME", literal(requireBrandString("appName")))
        buildConfigField("long", "BRAND_PRIMARY_LIGHT", brandColour("colors.brand.light"))
        buildConfigField("long", "BRAND_PRIMARY_DARK", brandColour("colors.brand.dark"))
        buildConfigField("long", "BRAND_ON_PRIMARY_LIGHT", brandColour("colors.onBrand.light"))
        buildConfigField("long", "BRAND_ON_PRIMARY_DARK", brandColour("colors.onBrand.dark"))
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
            }
        }
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

    // MARK: Store SDKs, one flavor each. `src/main` must never import them.
    "bazaarImplementation"(libs.poolakey)

    "playImplementation"(libs.play.billing.ktx)
    "playImplementation"(libs.play.review.ktx)
    "playImplementation"(libs.play.app.update.ktx)
    "playImplementation"(libs.play.integrity)
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
