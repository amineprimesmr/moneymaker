pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement { repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS); repositories { google(); mavenCentral() } }
rootProject.name = "moneymaker-android"
include(":moneymaker")
include(":moneymaker-amazon") // optional: Amazon Appstore (adds com.amazon.device:amazon-appstore-sdk)
