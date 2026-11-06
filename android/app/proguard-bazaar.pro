# R8 rules for the Cafe Bazaar build only (productFlavors.bazaar in
# build.gradle.kts).
#
# Poolakey 2.3.0's AAR ships an empty consumer rules file. It binds Bazaar's
# billing service through an AIDL interface (com.android.vending.billing.
# IInAppBillingService, the classic name Bazaar kept), talks to Bazaar by
# broadcast through its manifest receiver as a fallback, and exchanges Bundles
# by key with the Bazaar app, which is the other side of the contract and is
# not built with our R8. Kept whole: it is small, and a renamed class here
# fails only on a real device with Bazaar installed.
-keep class ir.cafebazaar.poolakey.** { *; }
-keep interface com.android.vending.billing.** { *; }
-keep class com.android.vending.billing.** { *; }
