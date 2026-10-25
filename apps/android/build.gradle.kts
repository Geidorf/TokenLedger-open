buildscript {
    // 插件解析早于 catalog accessor 生成，修复版本仍从唯一版本源读取。
    val catalogVersionLines = project.file("gradle/libs.versions.toml").readLines()
        .dropWhile { it.trim() != "[versions]" }
        .drop(1)
        .takeWhile { !it.trim().startsWith("[") }
    fun catalogVersion(key: String): String {
        val matches = catalogVersionLines.mapNotNull { line ->
            Regex("""^\s*$key\s*=\s*"([^"]+)"\s*(?:#.*)?$""")
                .matchEntire(line)?.groupValues?.get(1)
        }
        require(matches.size == 1) { "gradle/libs.versions.toml 必须恰好定义一次 [versions].$key" }
        return matches.single()
    }

    // 约束只提升已有工具依赖的下限，后续插件可以选用更高的兼容版本。
    dependencies {
        constraints {
            add("classpath", "org.jdom:jdom2:${catalogVersion("jdom2")}")
            add("classpath", "org.bitbucket.b_c:jose4j:${catalogVersion("jose4j")}")
            add("classpath", "org.apache.commons:commons-compress:${catalogVersion("commonsCompress")}")
        }
    }
}

plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.android.compose.screenshot) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
}
