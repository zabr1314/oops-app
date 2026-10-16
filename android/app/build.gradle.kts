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

// Opt-in packaging overrides keep the existing app and CI defaults intact. The unified preview
// uses a separate package so installing it cannot replace an existing Oops installation.
val oopsAppIdSuffix = providers.gradleProperty("oopsAppIdSuffix").orNull?.also {
    require(it.matches(Regex("(\\.[a-z][a-z0-9_]*)+"))) { "Invalid oopsAppIdSuffix" }
}
val oopsVersionCode = providers.gradleProperty("oopsVersionCode").orNull?.let {
    requireNotNull(it.toIntOrNull()?.takeIf { code -> code in 1..2100000000 }) {
        "oopsVersionCode must be a positive Android version code"
    }
}
val oopsVersionName = providers.gradleProperty("oopsVersionName").orNull?.also {
    require(it.isNotBlank() && it.length <= 80) { "Invalid oopsVersionName" }
}
val oopsUnifiedWeb = providers.gradleProperty("oopsUnifiedWeb").orNull?.let {
    requireNotNull(it.toBooleanStrictOrNull()) { "oopsUnifiedWeb must be true or false" }
} ?: false
val unifiedAssetsRoot = layout.buildDirectory.dir("generated/unifiedWebAssets")

if (oopsUnifiedWeb) {
    val buildNativeWeb = tasks.register<Exec>("buildNativeWeb") {
        description = "Builds the shared React interface and native tool assets for the Android WebView"
        group = "build"
        workingDir(rootProject.projectDir.parentFile)
        commandLine("node", "scripts/build-native.mjs")
        // The script owns this complete root, including preserved native-only tools and fixtures.
        outputs.dir(unifiedAssetsRoot)
        outputs.upToDateWhen { false }
    }
    tasks.matching { it.name == "preBuild" }.configureEach { dependsOn(buildNativeWeb) }
}

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
        applicationIdSuffix = oopsAppIdSuffix
        minSdk = 26
        // Deliberate Android 16 device baseline from the implementation plan.
        //noinspection OldTargetApi
        targetSdk = 36
        versionCode = oopsVersionCode ?: 1
        versionName = oopsVersionName ?: "0.1.0"
        manifestPlaceholders["oopsAppLabel"] = if (oopsAppIdSuffix == ".unified") "Oops 新版" else "Oops"
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

    if (oopsUnifiedWeb) {
        // Avoid merging two web/index.html files from the old and shared interfaces.
        sourceSets.getByName("main").assets.directories.apply {
            clear()
            add(unifiedAssetsRoot.get().asFile.absolutePath)
        }
    }
}

// The Anker 录音豆 SDK is contest material, not in git: drop module_spplink-release-*.aar into app/libs/soundcore/
// (scripts/bean_sdk_setup.sh) and the build adds SoundcoreBeanLink. Without it the app still builds; the bean
// source then offers only the simulator.
val soundcoreAar = file("libs/soundcore").listFiles { f -> f.name.endsWith(".aar") }?.maxOrNull()
if (soundcoreAar != null) {
    // AGP 9's built-in Kotlin compiler only reads custom Kotlin roots registered as Kotlin sources.
    android.sourceSets.getByName("main").kotlin.srcDir("src/soundcore/java")
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
