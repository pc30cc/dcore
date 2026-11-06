plugins {
    alias(libs.plugins.android.application) apply false
    // NOT `org.jetbrains.kotlin.android`: AGP 9 compiles Kotlin itself and
    // refuses to start if that plugin is also applied. Declaring the Compose
    // compiler plugin at the catalog's Kotlin version is also what puts that
    // Kotlin Gradle plugin on the build classpath.
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.ksp) apply false
    alias(libs.plugins.androidx.room) apply false
}
