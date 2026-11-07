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

        // JitPack, for Cafe Bazaar's Poolakey and LiveKit's audio router
        // (audioswitch, pinned by LiveKit at a commit hash published nowhere
        // else), and nothing else.
        //
        // JitPack builds whatever a GitHub coordinate points at, on demand, so
        // an unfiltered entry would let any `com.github.*` coordinate (a typo,
        // or a name squatted next to one we use) resolve from a repository
        // nobody reviews. The filter keeps it to the two groups that need it.
        maven {
            url = uri("https://jitpack.io")
            content {
                includeGroup("com.github.cafebazaar.Poolakey")
                includeGroup("com.github.davidliu")
            }
        }
    }
}

rootProject.name = "client-android"
include(":app")
