import java.util.Properties
import java.util.Base64
import groovy.json.JsonSlurper
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.android.compose.screenshot)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

val localProperties = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.isFile) {
        file.inputStream().use(::load)
    }
}

fun readPackageVersion(): String {
    val packageJson = rootProject.file("../../package.json").readText()
    val match = Regex("\"version\"\\s*:\\s*\"([^\"]+)\"").find(packageJson)
    return match?.groupValues?.get(1)
        ?: error("Root package.json version was not found")
}

fun versionCodeFrom(version: String): Int {
    val parts = version.substringBefore("-").split(".").map { it.toIntOrNull() ?: 0 }
    val major = parts.getOrElse(0) { 0 }
    val minor = parts.getOrElse(1) { 0 }
    val patch = parts.getOrElse(2) { 0 }
    // 旧公式 major*10000 + minor*100 + patch 在 1.2.100 与 1.3.0 同为 10300，
    // 1.2.101 起会反超 1.3.0 导致无法覆盖安装（当前已到 .75）。新公式对任何
    // major >= 1 的版本都严格大于旧公式的取值，升级链单调不变。
    return major * 1_000_000 + minor * 1_000 + patch
}

fun configValue(name: String): String =
    localProperties.getProperty(name)
        ?: System.getenv(name)
        ?: ""

fun quotedBuildConfig(value: String): String =
    "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

fun configDouble(name: String, defaultValue: Double): Double =
    configValue(name).toDoubleOrNull() ?: defaultValue

val appVersion = readPackageVersion()
// QA variants and instrumentation routing are opt-in; normal CI keeps its existing variants.
val qaBuildEnabled = providers.gradleProperty("tokenledger.qa")
    .map { it.toBooleanStrict() }
    .orElse(false)
    .get()
val supabaseUrl = configValue("TOKENLEDGER_SUPABASE_URL")
val supabasePublishableKey = configValue("TOKENLEDGER_SUPABASE_PUBLISHABLE_KEY")

fun decodeCanonicalBase64UrlJson(segment: String): Map<*, *>? {
    if (!segment.matches(Regex("^[A-Za-z0-9_-]+$"))) return null
    return runCatching {
        val bytes = Base64.getUrlDecoder().decode(segment)
        if (Base64.getUrlEncoder().withoutPadding().encodeToString(bytes) != segment) return null
        JsonSlurper().parseText(bytes.toString(Charsets.UTF_8)) as? Map<*, *>
    }.getOrNull()
}

fun isAllowedSupabaseClientKey(value: String): Boolean {
    if (value.isEmpty() || value.trim() != value) return false
    if (value.matches(Regex("^sb_publishable_[A-Za-z0-9_-]+$"))) return true
    val parts = value.split(".")
    if (parts.size != 3 || parts.any { !it.matches(Regex("^[A-Za-z0-9_-]+$")) }) return false
    val header = decodeCanonicalBase64UrlJson(parts[0]) ?: return false
    val payload = decodeCanonicalBase64UrlJson(parts[1]) ?: return false
    return header["alg"] == "HS256" && payload["role"] == "anon"
}

fun hasDeployableSupabaseConfiguration(): Boolean =
    supabaseUrl.startsWith("https://") &&
        isAllowedSupabaseClientKey(supabasePublishableKey)

val releaseSigningPropertyNames = listOf(
    "TOKENLEDGER_ANDROID_KEYSTORE_PATH",
    "TOKENLEDGER_ANDROID_KEYSTORE_PASSWORD",
    "TOKENLEDGER_ANDROID_KEY_ALIAS",
    "TOKENLEDGER_ANDROID_KEY_PASSWORD"
)
val releaseSigningValues = releaseSigningPropertyNames.associateWith(::configValue)
val releaseKeystoreFile = releaseSigningValues
    .getValue("TOKENLEDGER_ANDROID_KEYSTORE_PATH")
    .takeIf(String::isNotBlank)
    ?.let(rootProject::file)
val releaseSigningReady = releaseSigningPropertyNames.all {
    releaseSigningValues.getValue(it).isNotBlank()
} && releaseKeystoreFile?.isFile == true

android {
    namespace = "com.jeidorf.tokenledger.mobile"
    compileSdk = 36
    experimentalProperties["android.experimental.enableScreenshotTest"] = true

    defaultConfig {
        applicationId = "com.jeidorf.tokenledger.mobile"
        minSdk = 26
        targetSdk = 36
        versionCode = versionCodeFrom(appVersion)
        versionName = appVersion
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        buildConfigField(
            "String",
            "TOKENLEDGER_SUPABASE_URL",
            quotedBuildConfig(supabaseUrl)
        )
        buildConfigField(
            "String",
            "TOKENLEDGER_SUPABASE_PUBLISHABLE_KEY",
            quotedBuildConfig(supabasePublishableKey)
        )
        buildConfigField(
            "String",
            "TOKENLEDGER_APP_VERSION",
            quotedBuildConfig(appVersion)
        )
        buildConfigField(
            "double",
            "TOKENLEDGER_CNY_EXCHANGE_RATE",
            configDouble("TOKENLEDGER_CNY_EXCHANGE_RATE", 7.2).toString()
        )
    }

    buildFeatures {
        buildConfig = true
        compose = true
    }

    sourceSets.getByName("test").resources.srcDir(rootProject.file("../../fixtures"))

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    signingConfigs {
        if (releaseSigningReady) {
            create("tokenLedgerRelease") {
                storeFile = releaseKeystoreFile
                storePassword = releaseSigningValues.getValue("TOKENLEDGER_ANDROID_KEYSTORE_PASSWORD")
                keyAlias = releaseSigningValues.getValue("TOKENLEDGER_ANDROID_KEY_ALIAS")
                keyPassword = releaseSigningValues.getValue("TOKENLEDGER_ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        getByName("debug") {
            // Keep developer/test installs side-by-side with the production
            // package. Existing pre-RC debug users must clean-install once.
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        if (qaBuildEnabled) {
            create("qa") {
                initWith(getByName("debug"))
                applicationIdSuffix = ".qa"
                versionNameSuffix = "-qa"
                matchingFallbacks += listOf("debug")
            }
        }
        val release = getByName("release") {
            isMinifyEnabled = true
            isShrinkResources = true
            signingConfig = null
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
        create("signedRelease") {
            initWith(release)
            matchingFallbacks += listOf("release")
            if (releaseSigningReady) {
                signingConfig = signingConfigs.getByName("tokenLedgerRelease")
            }
        }
    }

    if (qaBuildEnabled) {
        testBuildType = "qa"
        defaultConfig.testApplicationId = "com.jeidorf.tokenledger.mobile.qa.test"
        defaultConfig.testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        sourceSets.getByName("qa") {
            java.srcDir("src/debug/java")
            res.srcDir("src/debug/res")
        }
    }
}

if (qaBuildEnabled) {
    // initWith copies build-type options, but does not inherit debug-only dependencies.
    configurations.named("qaImplementation") {
        extendsFrom(configurations.getByName("debugImplementation"))
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

// 仅固定 Compose Preview 截图验证的时区：golden 在 +08:00 机器生成，截图中的
// 本地化时间必须保持确定。普通 JVM 单测继续继承宿主时区，避免掩盖跨时区回归。
// screenshot 验证 task 不在 android.testOptions.unitTests 域内，因此按 task 名筛选。
tasks.withType<Test>().matching { task ->
    task.name.contains("screenshot", ignoreCase = true)
}.configureEach {
    systemProperty("user.timezone", "Asia/Shanghai")
    // 截图测试已超过 300 张，默认 512 MiB 的测试 JVM 在截图主机上会内存不足。
    maxHeapSize = "2g"
}

dependencies {
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.ktx)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.extended)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.kotlinx.coroutines.android)

    // 桌面小组件（T8.2）：Jetpack Glance + WorkManager 周期刷新。
    // 版本对齐 Compose BOM 2024.09（Compose 1.7.x）与 compileSdk 36；
    // glance-appwidget 传递依赖 work-runtime-ktx，此处显式钉住兜底刷新所用版本。
    implementation(libs.androidx.glance.appwidget)
    implementation(libs.androidx.glance.material3)
    implementation(libs.androidx.work.runtime.ktx)

    debugImplementation(libs.androidx.compose.ui.tooling)
    // T10.118q：仅 Debug 提供 Compose 测试宿主，生产入口保持不变。
    debugImplementation(libs.androidx.compose.ui.test.manifest)

    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.ext.junit)

    screenshotTestImplementation(libs.screenshot.validation.api)
    screenshotTestImplementation(libs.androidx.compose.ui.tooling)

    testImplementation(libs.junit)
    testImplementation(libs.org.json)
    testImplementation(libs.kotlinx.coroutines.test)
}

val testSupabaseClientKeyPolicy = tasks.register("testSupabaseClientKeyPolicy") {
    group = "verification"
    description = "Checks the Android release key policy against the shared fail-closed fixture."
    val fixture = rootProject.file("../../scripts/fixtures/supabase-client-key-cases.txt")
    inputs.file(fixture)
    doLast {
        var acceptedCases = 0
        var rejectedCases = 0
        fixture.readLines()
            .filter { it.isNotBlank() && !it.startsWith("#") }
            .forEach { line ->
                val fields = line.split("|", limit = 3)
                check(fields.size == 3) { "Invalid Supabase client-key fixture row" }
                val expected = fields[1].toBooleanStrict()
                val actual = isAllowedSupabaseClientKey(fields[2])
                check(actual == expected) { "Supabase client-key policy mismatch: ${fields[0]}" }
                if (expected) acceptedCases += 1 else rejectedCases += 1
            }
        check(acceptedCases > 0 && rejectedCases > 0) {
            "Supabase client-key fixture must contain accepted and rejected cases"
        }
    }
}

val verifyConfiguredDebug = tasks.register("verifyConfiguredDebug") {
    group = "verification"
    description = "Fails unless a cloud-enabled debug APK has deployable public Supabase configuration."
    dependsOn(testSupabaseClientKeyPolicy)
    doLast {
        check(hasDeployableSupabaseConfiguration()) {
            "Configured debug packaging requires TOKENLEDGER_SUPABASE_URL (https) and a public " +
                "TOKENLEDGER_SUPABASE_PUBLISHABLE_KEY from environment variables or local.properties; " +
                "secret keys are forbidden."
        }
    }
}

val copyVersionedDebugApk = tasks.register<Copy>("copyVersionedDebugApk") {
    dependsOn("assembleDebug", verifyConfiguredDebug)
    from(layout.buildDirectory.file("outputs/apk/debug/app-debug.apk"))
    into(rootProject.file("../../release"))
    rename { "TokenLedger_Android_${appVersion}_debug.apk" }
}

tasks.register("packageConfiguredDebug") {
    group = "build"
    description = "Builds and copies a versioned, cloud-enabled debug APK after public-config checks."
    dependsOn(copyVersionedDebugApk)
}

val verifyReleaseSigning = tasks.register("verifyReleaseSigning") {
    group = "verification"
    description = "Fails unless a complete, readable non-debug release signing configuration is available."
    doLast {
        val missing = releaseSigningPropertyNames.filter {
            releaseSigningValues.getValue(it).isBlank()
        }
        check(missing.isEmpty()) {
            "Release signing is incomplete. Configure only through environment variables or " +
                "apps/android/local.properties. Missing: ${missing.joinToString()}."
        }
        check(releaseKeystoreFile?.isFile == true) {
            "TOKENLEDGER_ANDROID_KEYSTORE_PATH must point to a readable release keystore."
        }
    }
}

val verifyReleaseConfiguration = tasks.register("verifyReleaseConfiguration") {
    group = "verification"
    description = "Fails unless a release build has deployable Supabase public configuration."
    dependsOn(testSupabaseClientKeyPolicy)
    mustRunAfter(verifyReleaseSigning)
    doLast {
        check(hasDeployableSupabaseConfiguration()) {
            "Release builds require TOKENLEDGER_SUPABASE_URL (https) and " +
                "a public TOKENLEDGER_SUPABASE_PUBLISHABLE_KEY from environment variables or " +
                "local.properties; secret keys are forbidden."
        }
    }
}

tasks.matching { it.name == "preReleaseBuild" }.configureEach {
    dependsOn(verifyReleaseConfiguration)
    doFirst {
        logger.lifecycle(
            "Building the configured unsigned release variant for R8/resource-shrink verification only; " +
                "use assembleSignedRelease for a distributable APK."
        )
    }
}

tasks.matching { it.name == "preSignedReleaseBuild" }.configureEach {
    dependsOn(verifyReleaseSigning, verifyReleaseConfiguration)
}
