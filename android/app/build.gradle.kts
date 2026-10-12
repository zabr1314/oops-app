import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
}

// Volc ASR credentials and the backend URL come from android/local.properties (gitignored)
// or environment variables, and are baked into BuildConfig.
val localProps = Properties().apply {
    rootProject.file("local.properties").takeIf { it.exists() }?.inputStream()?.use { load(it) }
}

fun configValue(name: String, default: String = ""): String =
    (localProps.getProperty(name) ?: System.getenv(name) ?: default)
        .replace("\\", "\\\\").replace("\"", "\\\"")

android {
    namespace = "com.oops.app"
    // Current androidx.core / OkHttp require compiling against 37; runtime behaviour stays at targetSdk 36.
    compileSdk {
        version = release(37) {
            minorApiLevel = 2
        }
    }

    defaultConfig {
        applicationId = "com.oops.app"
        minSdk = 26
        // Deliberate Android 16 device baseline from the implementation plan.
        //noinspection OldTargetApi
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "com.oops.app.RemoteBackendSmoke"

        buildConfigField("String", "VOLC_API_KEY", "\"${configValue("VOLC_API_KEY")}\"")
        buildConfigField("String", "VOLC_APP_ID", "\"${configValue("VOLC_APP_ID")}\"")
        buildConfigField("String", "VOLC_ACCESS_TOKEN", "\"${configValue("VOLC_ACCESS_TOKEN")}\"")
        buildConfigField(
            "String", "VOLC_RESOURCE_ID",
            "\"${configValue("VOLC_RESOURCE_ID", "volc.seedasr.sauc.duration")}\"",
        )
        buildConfigField("String", "BACKEND_BASE_URL", "\"${configValue("OOPS_BACKEND_URL")}\"")
        // 录音豆 SDK auth until the backend fetches it from Anker; see BeanAuth.
        for (name in listOf("BEAN_USER_ID", "BEAN_DEVICE_ID", "BEAN_TOKEN", "BEAN_LICENSE_JSON", "BEAN_LICENSE_SIGNATURE", "BEAN_MAC")) {
            buildConfigField("String", name, "\"${configValue(name)}\"")
        }
        buildConfigField("boolean", "BEAN_PRODUCTION", configValue("BEAN_PRODUCTION", "false"))
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

// The Anker 录音豆 SDK is contest material, not in git: drop module_spplink-release-*.aar into app/libs/soundcore/
// (scripts/bean_sdk_setup.sh) and the build adds SoundcoreBeanLink. Without it the app still builds; the bean
// source then offers only the simulator.
val soundcoreAar = file("libs/soundcore").listFiles { f -> f.name.endsWith(".aar") }?.maxOrNull()
if (soundcoreAar != null) {
    android.sourceSets.getByName("main").java.srcDir("src/soundcore/java")
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.ktx)
    implementation(libs.androidx.webkit)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.okhttp)

    if (soundcoreAar != null) {
        implementation(files(soundcoreAar))
        // What the SDK's classes reference (v1.3.02 release note: Kotlin 2.2.21, coroutines 1.11.0, okhttp 5, ktor 2.3.13).
        implementation("io.ktor:ktor-client-core:2.3.13")
        implementation("io.ktor:ktor-client-okhttp:2.3.13")
        implementation("io.ktor:ktor-client-websockets:2.3.13")
        implementation("io.ktor:ktor-client-logging:2.3.13")
        implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
        implementation("org.jetbrains.kotlinx:atomicfu:0.23.2")
        implementation("com.madgag.spongycastle:core:1.58.0.0")
        implementation("com.madgag.spongycastle:prov:1.58.0.0")
    }

    testImplementation(libs.junit)
    testImplementation(libs.org.json)
    testImplementation(libs.kotlinx.coroutines.test)
}
