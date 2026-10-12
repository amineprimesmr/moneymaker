// Optional module: Amazon Appstore purchases for MoneyMaker. The core `moneymaker` artifact does not depend on it
// nor on the Amazon SDK; apps that ship on the Amazon Appstore add this module (and their AppstoreAuthenticationKey.pem).
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "io.moneymaker.amazon"
    compileSdk = 36
    defaultConfig { minSdk = 23 }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
}

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

dependencies {
    api(project(":moneymaker"))
    // https://central.sonatype.com/artifact/com.amazon.device/amazon-appstore-sdk
    api("com.amazon.device:amazon-appstore-sdk:3.0.9")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
}
