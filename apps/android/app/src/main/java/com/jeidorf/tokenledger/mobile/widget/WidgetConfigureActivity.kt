package com.jeidorf.tokenledger.mobile.widget

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.BarChart
import androidx.compose.material.icons.filled.DataUsage
import androidx.compose.material.icons.filled.Speed
import androidx.compose.material.icons.filled.Widgets
import androidx.compose.foundation.shape.RoundedCornerShape
import com.jeidorf.tokenledger.mobile.R
import com.jeidorf.tokenledger.mobile.LedgerAppearance
import com.jeidorf.tokenledger.mobile.QuotaCache
import com.jeidorf.tokenledger.mobile.QuotaCacheKey
import com.jeidorf.tokenledger.mobile.SessionStore
import com.jeidorf.tokenledger.mobile.TokenLedgerTheme
import com.jeidorf.tokenledger.mobile.localizedDisplayName
import com.jeidorf.tokenledger.mobile.orderedQuotaProvidersForDisplay
import androidx.core.view.WindowCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerRadius

/**
 * 小组件配置 Activity（T8.5a）。桌面添加实例时由系统 AppWidgetHost 拉起：用户选初始模式、
 * 额度 provider、统计范围 → 写 [WidgetConfigStore] → setResult(RESULT_OK) 并首次渲染。
 * 实时路由实例只提供逐实例主题选择，并在保存后主动刷新当前 Glance 实例。
 * 视觉沿用应用 [TokenLedgerTheme]，深浅色跟随应用外观设置。中途退出（返回键）保持初始
 * setResult(RESULT_CANCELED)，系统不落地实例。
 */
internal class WidgetConfigureActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val appWidgetId = intent?.extras?.getInt(
            AppWidgetManager.EXTRA_APPWIDGET_ID,
            AppWidgetManager.INVALID_APPWIDGET_ID
        ) ?: AppWidgetManager.INVALID_APPWIDGET_ID

        // 默认取消：只有用户点「保存卡片」才改写为 RESULT_OK。
        setResult(Activity.RESULT_CANCELED, resultIntent(appWidgetId))
        if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
            finish()
            return
        }

        enableEdgeToEdge()
        val appearance = LedgerAppearance.fromStored(
            getSharedPreferences(APPEARANCE_PREFS, Context.MODE_PRIVATE).getString(APPEARANCE_KEY, null),
            fallback = LedgerAppearance.Dark
        )
        val provider = AppWidgetManager.getInstance(applicationContext)
            .getAppWidgetInfo(appWidgetId)
            ?.provider
        val routingWidget =
            provider == ComponentName(applicationContext, RoutingLiveWidgetReceiver::class.java)
        val lockedMode = providerLockedWidgetMode(provider?.className)
        val initialConfig = WidgetConfigStore
            .load(applicationContext, appWidgetId, defaultMode = lockedMode ?: WidgetMode.BarUsage)
            .let { stored -> lockedMode?.let { stored.copy(mode = it) } ?: stored }

        setContent {
            val view = LocalView.current
            SideEffect {
                val lightBars = appearance != LedgerAppearance.Dark
                WindowCompat.getInsetsController(window, view).apply {
                    isAppearanceLightStatusBars = lightBars
                    isAppearanceLightNavigationBars = lightBars
                }
            }
            TokenLedgerTheme(appearance) {
                Scaffold(
                    modifier = Modifier.fillMaxSize(),
                    containerColor = MaterialTheme.colorScheme.background,
                    contentWindowInsets = WindowInsets.safeDrawing
                ) { insets ->
                    Surface(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(insets)
                            .consumeWindowInsets(insets),
                        color = MaterialTheme.colorScheme.background
                    ) {
                        if (routingWidget) {
                            RoutingWidgetConfigureScreen(
                                initialTheme = initialConfig.theme,
                                onConfirm = { theme ->
                                    confirm(
                                        appWidgetId = appWidgetId,
                                        config = initialConfig.copy(theme = theme),
                                        routingWidget = true
                                    )
                                },
                                onCancel = { finish() }
                            )
                        } else {
                            WidgetConfigureScreen(
                                initialConfig = initialConfig,
                                lockedMode = lockedMode,
                                onConfirm = { config -> confirm(appWidgetId, config) },
                                onCancel = { finish() }
                            )
                        }
                    }
                }
            }
        }
    }

    private fun confirm(appWidgetId: Int, config: WidgetConfig, routingWidget: Boolean = false) {
        if (routingWidget && AppWidgetManager.getInstance(applicationContext)
                .getAppWidgetInfo(appWidgetId)?.provider !=
            ComponentName(applicationContext, RoutingLiveWidgetReceiver::class.java)
        ) {
            finish()
            return
        }
        WidgetConfigStore.save(applicationContext, appWidgetId, config)
        runCatching { WidgetScheduler.ensurePeriodicRefresh(applicationContext) }
        if (routingWidget) {
            // 刷新交给当前实例的广播，保存结果不等待可被 Activity 销毁取消的协程。
            requestRoutingWidgetUpdate(appWidgetId)
            return
        }
        runCatching { WidgetScheduler.enqueueOneTimeRefresh(applicationContext) }
        finishConfirmed(appWidgetId)
    }

    private fun requestRoutingWidgetUpdate(appWidgetId: Int) {
        sendBroadcast(
            Intent(AppWidgetManager.ACTION_APPWIDGET_UPDATE)
                .setComponent(ComponentName(applicationContext, RoutingLiveWidgetReceiver::class.java))
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, intArrayOf(appWidgetId))
        )
        finishConfirmed(appWidgetId)
    }

    private fun finishConfirmed(appWidgetId: Int) {
        setResult(Activity.RESULT_OK, resultIntent(appWidgetId))
        finish()
    }

    private fun resultIntent(appWidgetId: Int): Intent =
        Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)

    private companion object {
        // 与 MainActivity 同源（其常量为 private），此处复用同一 prefs 读取应用外观。
        const val APPEARANCE_PREFS = "tokenledger_appearance"
        const val APPEARANCE_KEY = "ledger_appearance"
    }
}

@Composable
internal fun RoutingWidgetConfigureScreen(
    initialTheme: WidgetThemeMode,
    onConfirm: (WidgetThemeMode) -> Unit,
    onCancel: () -> Unit
) {
    var themeValue by rememberSaveable { mutableStateOf(initialTheme.storageValue) }
    val theme = WidgetThemeMode.fromStorage(themeValue)

    Column(modifier = Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp, vertical = 20.dp)
        ) {
            Text(
                stringResource(R.string.routing_widget_config_title),
                style = MaterialTheme.typography.headlineLarge,
                color = MaterialTheme.colorScheme.onBackground
            )
            Spacer(Modifier.height(4.dp))
            Text(
                stringResource(R.string.routing_widget_config_subtitle),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )

            SectionLabel(stringResource(R.string.routing_widget_config_theme_section))
            Column(modifier = Modifier.selectableGroup()) {
                WidgetThemeMode.entries.forEach { option ->
                    val label = stringResource(
                        when (option) {
                            WidgetThemeMode.System -> R.string.routing_widget_config_theme_system
                            WidgetThemeMode.Light -> R.string.routing_widget_config_theme_light
                            WidgetThemeMode.Dark -> R.string.routing_widget_config_theme_dark
                        }
                    )
                    val description = stringResource(
                        when (option) {
                            WidgetThemeMode.System -> R.string.routing_widget_config_theme_system_description
                            WidgetThemeMode.Light -> R.string.routing_widget_config_theme_light_description
                            WidgetThemeMode.Dark -> R.string.routing_widget_config_theme_dark_description
                        }
                    )
                    OptionRow(
                        label = label,
                        description = description,
                        selected = theme == option,
                        onClick = { themeValue = option.storageValue }
                    )
                }
            }
        }

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 12.dp)
                .imePadding(),
            horizontalArrangement = Arrangement.End,
            verticalAlignment = Alignment.CenterVertically
        ) {
            OutlinedButton(
                onClick = onCancel,
                modifier = Modifier.heightIn(min = 48.dp)
            ) { Text(stringResource(R.string.routing_widget_config_cancel)) }
            Spacer(Modifier.width(12.dp))
            Button(
                onClick = { onConfirm(theme) },
                modifier = Modifier.heightIn(min = 48.dp)
            ) { Text(stringResource(R.string.routing_widget_config_save)) }
        }
    }
}

private data class ProviderOption(val id: String?, val name: String)

/** 从加密 last-known-good 缓存枚举可选 provider；无会话/无缓存则空表（仅剩「跟随首个」）。 */
private suspend fun loadProviderOptions(context: Context): List<ProviderOption> =
    withContext(Dispatchers.IO) {
        val session = runCatching { SessionStore(context).load() }.getOrNull()
            ?: return@withContext emptyList()
        val decoded = runCatching {
            QuotaCache(context).load(QuotaCacheKey(session.userId), System.currentTimeMillis())
        }.getOrNull() ?: return@withContext emptyList()
        decoded.snapshot.snapshot.providers
            .orderedQuotaProvidersForDisplay()
            .map { ProviderOption(it.providerId, it.localizedDisplayName()) }
    }

@Composable
private fun WidgetConfigureScreen(
    initialConfig: WidgetConfig,
    lockedMode: WidgetMode?,
    onConfirm: (WidgetConfig) -> Unit,
    onCancel: () -> Unit
) {
    val context = LocalContext.current
    var mode by remember { mutableStateOf(initialConfig.mode) }
    var range by remember { mutableStateOf(initialConfig.range) }
    var providerId by remember { mutableStateOf(initialConfig.providerId) }
    var theme by remember { mutableStateOf(initialConfig.theme) }
    var showRouting by remember { mutableStateOf(initialConfig.showRouting) }

    val providers by produceState(initialValue = emptyList<ProviderOption>()) {
        value = loadProviderOptions(context.applicationContext)
    }

    Column(
        modifier = Modifier.fillMaxSize()
    ) {
        Column(
            modifier = Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp, vertical = 20.dp)
        ) {
            Text(
                "配置桌面卡片",
                style = MaterialTheme.typography.headlineLarge,
                color = MaterialTheme.colorScheme.onBackground
            )
            Spacer(Modifier.height(4.dp))
            Text(
                if (lockedMode == null) {
                    "这是升级前的兼容卡片，可保留原样或改为一种公开样式。"
                } else {
                    "当前卡片固定为「${lockedMode.label}」。"
                },
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )

            if (lockedMode == null) {
                SectionLabel("卡片样式")
                Column(modifier = Modifier.selectableGroup()) {
                    configurableWidgetModes(initialConfig.mode).forEach { option ->
                        ModeOptionRow(
                            option = option,
                            selected = mode == option,
                            onClick = { mode = option }
                        )
                        Spacer(Modifier.height(8.dp))
                    }
                }
            }

            SectionLabel("显示来源", "选择全部可用来源，或固定一个来源。")
            Column(modifier = Modifier.selectableGroup()) {
                OptionRow(
                    label = "全部可用来源（推荐）",
                    selected = providerId == null,
                    onClick = { providerId = null }
                )
                providers.forEach { option ->
                    OptionRow(
                        label = option.name,
                        selected = providerId == option.id,
                        onClick = { providerId = option.id }
                    )
                }
            }

            SectionLabel("统计范围", "影响有效 Token 与预估费用。")
            Column(modifier = Modifier.selectableGroup()) {
                WidgetRange.entries.forEach { option ->
                    OptionRow(
                        label = option.label,
                        selected = range == option,
                        onClick = { range = option }
                    )
                }
            }

            if ((lockedMode ?: mode) == WidgetMode.QuotaBars) {
                SectionLabel("实时路由", "数据来自电脑端发布到云端的路由快照，随卡片刷新更新，不是实时画面。")
                ToggleRow(
                    label = "底部显示最近一次网关调用",
                    description = "需要电脑端在「桌面挂件 › 手机动态壁纸」打开同步。",
                    checked = showRouting,
                    onCheckedChange = { showRouting = it }
                )
            }

            SectionLabel("组件主题")
            Column(modifier = Modifier.selectableGroup()) {
                WidgetThemeMode.entries.forEach { option ->
                    OptionRow(
                        label = option.label,
                        description = option.description,
                        selected = theme == option,
                        onClick = { theme = option }
                    )
                }
            }
        }

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 12.dp)
                .imePadding(),
            horizontalArrangement = Arrangement.End,
            verticalAlignment = Alignment.CenterVertically
        ) {
            OutlinedButton(
                onClick = onCancel,
                modifier = Modifier.heightIn(min = 48.dp)
            ) { Text("取消") }
            Spacer(Modifier.width(12.dp))
            Button(
                onClick = {
                    onConfirm(
                        WidgetConfig(
                            mode = lockedMode ?: mode,
                            providerId = providerId,
                            range = range,
                            theme = theme,
                            showRouting = showRouting
                        )
                    )
                },
                modifier = Modifier.heightIn(min = 48.dp)
            ) { Text("保存卡片") }
        }
    }
}

@Composable
private fun ModeOptionRow(
    option: WidgetMode,
    selected: Boolean,
    onClick: () -> Unit
) {
    val icon: ImageVector = when (option) {
        WidgetMode.MultiRing -> Icons.Default.DataUsage
        WidgetMode.SingleUsage, WidgetMode.MultiBar -> Icons.Default.BarChart
        WidgetMode.BarUsage -> Icons.Default.Widgets
        WidgetMode.QuotaBars -> Icons.Default.Speed
    }
    val colors = MaterialTheme.colorScheme
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .selectable(selected = selected, role = Role.RadioButton, onClick = onClick),
        shape = RoundedCornerShape(16.dp),
        color = if (selected) colors.primaryContainer.copy(alpha = 0.32f) else colors.surfaceVariant.copy(alpha = 0.28f),
        border = BorderStroke(1.dp, if (selected) colors.primary else colors.outlineVariant)
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 13.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Surface(
                shape = RoundedCornerShape(LedgerRadius.md),
                color = if (selected) colors.primary.copy(alpha = 0.14f) else colors.surfaceVariant
            ) {
                Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) {
                    Icon(icon, contentDescription = null, tint = if (selected) colors.primary else colors.onSurfaceVariant)
                }
            }
            Spacer(Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    option.label,
                    style = MaterialTheme.typography.titleMedium,
                    color = colors.onSurface,
                    fontWeight = FontWeight.SemiBold
                )
                Text(
                    option.description,
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.onSurfaceVariant
                )
            }
            Spacer(Modifier.width(8.dp))
            RadioButton(selected = selected, onClick = null)
        }
    }
}

@Composable
private fun SectionLabel(text: String, description: String? = null) {
    Spacer(Modifier.height(20.dp))
    Text(
        text,
        style = MaterialTheme.typography.titleLarge,
        color = MaterialTheme.colorScheme.onBackground,
        fontWeight = FontWeight.SemiBold
    )
    if (description != null) {
        Spacer(Modifier.height(2.dp))
        Text(
            description,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
    Spacer(Modifier.height(4.dp))
}

@Composable
private fun OptionRow(
    label: String,
    description: String? = null,
    selected: Boolean,
    onClick: () -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .selectable(selected = selected, role = Role.RadioButton, onClick = onClick)
            .padding(vertical = 12.dp, horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        // onClick=null：由整行 selectable 处理点击并合并无障碍语义。
        RadioButton(selected = selected, onClick = null)
        Spacer(Modifier.width(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                label,
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurface
            )
            if (description != null) {
                Text(
                    description,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

@Composable
private fun ToggleRow(
    label: String,
    description: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .toggleable(value = checked, role = Role.Switch, onValueChange = onCheckedChange)
            .padding(vertical = 12.dp, horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                label,
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurface
            )
            Text(
                description,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        Spacer(Modifier.width(12.dp))
        // onCheckedChange=null：由整行 toggleable 处理点击并合并无障碍语义。
        Switch(checked = checked, onCheckedChange = null)
    }
}
