plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    `maven-publish`
}

android {
    namespace = "io.moneymaker"
    compileSdk = 36
    defaultConfig { minSdk = 23; consumerProguardFiles("consumer-rules.pro") }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    publishing { singleVariant("release") { withSourcesJar() } }
}

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

dependencies {
    api("com.android.billingclient:billing-ktx:7.1.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}

afterEvaluate {
    publishing {
        publications {
            create<MavenPublication>("release") {
                from(components["release"])
                groupId = "io.moneymaker"; artifactId = "moneymaker"; version = "1.0.0"
            }
        }
    }
}
