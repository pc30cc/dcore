# R8 rules for the Google Play build only (productFlavors.play in
# build.gradle.kts).
#
# review-ktx 2.0.2 references a Play services annotation that exists only at
# compile time (it is not in play-services-basement's runtime classes). It
# has no runtime meaning; R8 needs only to be told the class is missing on
# purpose.
-dontwarn com.google.android.gms.common.annotation.NoNullnessRewrite
