pluginManagement {
    // 设置阶段尚无 catalog accessor，从唯一版本源读取支持当前 Kotlin 元数据的 R8。
    val r8Version = settingsDir.resolve("gradle/libs.versions.toml").readLines()
        .dropWhile { it.trim() != "[versions]" }
        .drop(1)
        .takeWhile { !it.trim().startsWith("[") }
        .mapNotNull { line ->
            Regex("""^\s*r8\s*=\s*"([^"]+)"\s*(?:#.*)?$""").matchEntire(line)?.groupValues?.get(1)
        }
        .also { require(it.size == 1) { "gradle/libs.versions.toml 必须恰好定义一次 [versions].r8" } }
        .single()

    buildscript {
        repositories {
            google()
            mavenCentral()
        }
        dependencies {
            classpath("com.android.tools:r8:$r8Version")
        }
    }
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "TokenLedgerMobile"
include(":app")
