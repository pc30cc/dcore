pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()

        // JitPack, for Cafe Bazaar's Poolakey and nothing else.
        //
        // JitPack builds whatever a GitHub coordinate points at, on demand, so
        // an unfiltered entry would let any `com.github.*` coordinate (a typo,
        // or a name squatted next to one we use) resolve from a repository
        // nobody reviews. The filter keeps it to the one group that needs it.
        // When LiveKit is added for calls, its `com.github.davidliu` group
        // (audioswitch) goes here too.
        maven {
            url = uri("https://jitpack.io")
            content { includeGroup("com.github.cafebazaar.Poolakey") }
        }
    }
}

rootProject.name = "client-android"
include(":app")
