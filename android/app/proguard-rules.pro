# R8, for a release build that behaves like the debug one.
#
# Most dependencies ship their own consumer rules inside their artifacts
# (Ktor, OkHttp, Room, Compose, Play Billing, Play Core, Poolakey), so what is
# here is only what R8 cannot work out from this app's own code.

# MARK: - kotlinx.serialization
#
# The API models are decoded by NAME from JSON, through serializers the
# compiler plugin generates and the app reaches only through `serializer()`
# companions. Dropping or renaming those turns a response into a crash, or
# worse, into a model of defaults.
-keepattributes *Annotation*, InnerClasses, Signature, RuntimeVisible*Annotations
-keepclassmembers,allowobfuscation class app.core.net.** {
    *** Companion;
    kotlinx.serialization.KSerializer serializer(...);
}
-if @kotlinx.serialization.Serializable class app.core.net.**
-keepclassmembers class app.core.net.<1>$Companion {
    kotlinx.serialization.KSerializer serializer(...);
}
-keepclasseswithmembers class app.core.net.** {
    public static ** INSTANCE;
}

# Navigation 3 keys are saved and restored through their serializers when the
# process is killed in the background (rememberNavBackStack).
-if @kotlinx.serialization.Serializable class app.core.ui.nav.**
-keep class app.core.ui.nav.<1> { *; }
-keepclassmembers class app.core.ui.nav.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# MARK: - Store SDKs
#
# Each store's rules are in its flavor's own file (proguard-bazaar.pro), so
# this file, shared by both builds, names neither SDK. Play Billing and Play
# Core ship their own consumer rules.

# MARK: - The rest
#
# Compile-only annotations and optional loggers R8 sees references to and no
# class for. None of them exist at runtime.
-dontwarn org.slf4j.**
-dontwarn java.lang.management.**
