package com.jeidorf.tokenledger.mobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ActivityInfo
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.v2Palette
import com.jeidorf.tokenledger.mobile.ui.onboarding.V2LoginIntro
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerMaterialTheme
import com.jeidorf.tokenledger.mobile.widget.WidgetRefresher
import com.jeidorf.tokenledger.mobile.widget.WidgetScheduler
import com.jeidorf.tokenledger.mobile.widget.WidgetConfigStore
import com.jeidorf.tokenledger.mobile.widget.shouldCancelWidgetRefresh

class MainActivity : ComponentActivity() {
    private val dashboardViewModel: DashboardViewModel by lazy {
        ViewModelProvider(
            this,
            DashboardViewModel.factory(applicationContext)
        )[DashboardViewModel::class.java]
    }

    private var clockReceiverRegistered = false
    private val clockChangeReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            dashboardViewModel.onClockChanged()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            val eInkDisplay = remember {
                isLikelyEInkDisplay(readAndroidDisplayIdentity(applicationContext))
            }
            var appearance by remember {
                mutableStateOf(
                    LedgerAppearance.fromStored(
                        getSharedPreferences(APPEARANCE_PREFS, Context.MODE_PRIVATE)
                            .getString(APPEARANCE_KEY, null),
                        fallback = if (eInkDisplay) LedgerAppearance.EInk else LedgerAppearance.Dark
                    )
                )
            }
            var forceLandscape by remember {
                mutableStateOf(
                    getSharedPreferences(DISPLAY_PREFS, Context.MODE_PRIVATE)
                        .getBoolean(FORCE_LANDSCAPE_KEY, false)
                )
            }
            var tokenDisplayMode by remember {
                mutableStateOf(
                    TokenDisplayMode.fromStored(
                        getSharedPreferences(DISPLAY_PREFS, Context.MODE_PRIVATE)
                            .getString(TOKEN_DISPLAY_MODE_KEY, null)
                    )
                )
            }
            // 键名仍是 `widget_presentation`：改键名会让升级用户的选择静默丢失，
            // 而旧取值 polished/eink 由 AmbientMode.fromStored 的兼容层解析。
            var ambientMode by remember {
                mutableStateOf(
                    AmbientMode.fromStored(
                        getSharedPreferences(DISPLAY_PREFS, Context.MODE_PRIVATE)
                            .getString(WIDGET_PRESENTATION_KEY, null),
                        fallback = defaultAmbientMode(eInkDisplay)
                    )
                )
            }
            val configurationOrientation = LocalConfiguration.current.orientation
            val multiWindowMode = isInMultiWindowMode
            val view = LocalView.current
            SideEffect {
                val lightBars = appearance != LedgerAppearance.Dark
                WindowCompat.getInsetsController(window, view).apply {
                    isAppearanceLightStatusBars = lightBars
                    isAppearanceLightNavigationBars = lightBars
                }
            }
            LaunchedEffect(forceLandscape, configurationOrientation, multiWindowMode) {
                val targetOrientation = if (shouldLockSensorLandscape(forceLandscape, multiWindowMode)) {
                    ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                } else {
                    ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
                }
                if (requestedOrientation != targetOrientation) {
                    requestedOrientation = targetOrientation
                }
            }
            TokenLedgerTheme(appearance) {
                ProvideLedgerPalette(appearance) {
                    Scaffold(
                        modifier = Modifier.fillMaxSize(),
                        containerColor = MaterialTheme.colorScheme.background,
                        contentWindowInsets = WindowInsets.safeDrawing
                    ) { safeDrawingPadding ->
                        Surface(
                            modifier = Modifier
                                .fillMaxSize()
                                .padding(safeDrawingPadding)
                                .consumeWindowInsets(safeDrawingPadding),
                            color = MaterialTheme.colorScheme.background
                        ) {
                            TokenLedgerApp(
                                viewModel = dashboardViewModel,
                                appearance = appearance,
                                eInkDisplay = eInkDisplay,
                                forceLandscape = forceLandscape,
                                tokenDisplayMode = tokenDisplayMode,
                                ambientMode = ambientMode,
                                onForceLandscapeChange = { enabled ->
                                    forceLandscape = enabled
                                    getSharedPreferences(DISPLAY_PREFS, Context.MODE_PRIVATE)
                                        .edit()
                                        .putBoolean(FORCE_LANDSCAPE_KEY, enabled)
                                        .apply()
                                },
                                onTokenDisplayModeChange = { selected ->
                                    tokenDisplayMode = selected
                                    getSharedPreferences(DISPLAY_PREFS, Context.MODE_PRIVATE)
                                        .edit()
                                        .putString(TOKEN_DISPLAY_MODE_KEY, selected.storedValue)
                                        .apply()
                                },
                                onAmbientModeChange = { selected ->
                                    ambientMode = selected
                                    getSharedPreferences(DISPLAY_PREFS, Context.MODE_PRIVATE)
                                        .edit()
                                        .putString(WIDGET_PRESENTATION_KEY, selected.storedValue)
                                        .apply()
                                },
                                onAppearanceChange = { selected ->
                                    appearance = selected
                                    getSharedPreferences(APPEARANCE_PREFS, Context.MODE_PRIVATE)
                                        .edit()
                                        .putString(APPEARANCE_KEY, selected.storedValue)
                                        .apply()
                                }
                            )
                        }
                    }
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        dashboardViewModel.onForeground()
        if (!clockReceiverRegistered) {
            val filter = IntentFilter().apply {
                addAction(Intent.ACTION_DATE_CHANGED)
                addAction(Intent.ACTION_TIME_CHANGED)
                addAction(Intent.ACTION_TIMEZONE_CHANGED)
            }
            ContextCompat.registerReceiver(
                this,
                clockChangeReceiver,
                filter,
                ContextCompat.RECEIVER_NOT_EXPORTED
            )
            clockReceiverRegistered = true
        }
    }

    override fun onStop() {
        if (!isChangingConfigurations) {
            dashboardViewModel.onBackground()
        }
        if (clockReceiverRegistered) {
            unregisterReceiver(clockChangeReceiver)
            clockReceiverRegistered = false
        }
        super.onStop()
    }

    private companion object {
        const val APPEARANCE_PREFS = "tokenledger_appearance"
        const val APPEARANCE_KEY = "ledger_appearance"
        const val DISPLAY_PREFS = "tokenledger_display"
        const val FORCE_LANDSCAPE_KEY = "force_landscape"
        const val TOKEN_DISPLAY_MODE_KEY = "token_display_mode"
        const val WIDGET_PRESENTATION_KEY = "widget_presentation"
    }
}

/**
 * 应用主题入口。颜色、形状与字阶已移到 `ui/foundation/LedgerMaterialTheme.kt`（T10.173 §3.2，
 * T10.177）；这里只保留原名，供 Activity、预览与夹具继续调用。
 */
@Composable
internal fun TokenLedgerTheme(
    appearance: LedgerAppearance,
    content: @Composable () -> Unit
) {
    LedgerMaterialTheme(appearance, content)
}

@Composable
private fun TokenLedgerApp(
    viewModel: DashboardViewModel,
    appearance: LedgerAppearance,
    eInkDisplay: Boolean,
    forceLandscape: Boolean,
    tokenDisplayMode: TokenDisplayMode,
    ambientMode: AmbientMode,
    onForceLandscapeChange: (Boolean) -> Unit,
    onTokenDisplayModeChange: (TokenDisplayMode) -> Unit,
    onAmbientModeChange: (AmbientMode) -> Unit,
    onAppearanceChange: (LedgerAppearance) -> Unit
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    // 全屏摆件会暂时替换看板组合树。保留看板的 saveable 状态，系统返回后才能回到
    // 原一级目的地、复盘页签和对应的 LazyList 滚动位置。
    val dashboardStateHolder = rememberSaveableStateHolder()

    // 小组件联动（T8.3）：登录后确保周期刷新已入队，并在应用完成额度/统计刷新（数据时间戳
    // 或额度修订变化）后把 last-known-good 主动推送到桌面小组件；登出则停止周期任务。
    val widgetContext = LocalContext.current.applicationContext
    LaunchedEffect(
        state.session?.userId,
        state.lastUpdatedEpochMillis,
        state.quotaSnapshot?.epoch,
        state.quotaSnapshot?.revision
    ) {
        if (state.session != null) {
            WidgetScheduler.ensurePeriodicRefresh(widgetContext)
            WidgetRefresher.notifyDataChanged(widgetContext)
        } else if (
            shouldCancelWidgetRefresh(WidgetConfigStore.backgroundConsumerCount(widgetContext))
        ) {
            WidgetScheduler.cancelPeriodicRefresh(widgetContext)
        }
    }

    when {
        !state.configured -> ConfigMissingScreen()
        state.sessionState == DashboardSessionState.Restoring -> CenterLoading()
        state.session == null -> Box(
            modifier = Modifier
                .fillMaxSize()
                .imePadding()
        ) {
            LoginScreen(
                palette = v2Palette(appearance),
                loading = state.loginLoading,
                error = state.userVisibleError,
                onLogin = viewModel::signIn
            )
        }
        state.lowPowerDisplayVisible -> {
            BackHandler(onBack = viewModel::closeLowPowerDisplay)
            LowPowerDisplayScreen(
                state = state,
                appearance = appearance,
                tokenDisplayMode = tokenDisplayMode,
                ambientMode = ambientMode,
                onTokenDisplayModeChange = onTokenDisplayModeChange,
                forceEInkRefresh = eInkDisplay
            )
        }
        else -> {
            // Root destinations leave Back to the Activity. Modal children are composed after this
            // handler, so their own BackHandler remains the first opportunity to dismiss a sheet.
            BackHandler(enabled = shouldConsumeDashboardBack(state)) {
                viewModel.navigateBack()
            }
            dashboardStateHolder.SaveableStateProvider("dashboard") {
                LedgerDashboardV2Screen(
                    state = state,
                    appearance = appearance,
                    forceLandscape = forceLandscape,
                    tokenDisplayMode = tokenDisplayMode,
                    ambientMode = ambientMode,
                    onForceLandscapeChange = onForceLandscapeChange,
                    onTokenDisplayModeChange = onTokenDisplayModeChange,
                    onAmbientModeChange = onAmbientModeChange,
                    onRangeChange = viewModel::selectRange,
                    onCustomRangeChange = viewModel::selectCustomRange,
                    onOpenDay = viewModel::openDayDetails,
                    onOpenTrendBucket = viewModel::openTrendBucket,
                    onReturnFromDay = viewModel::returnFromDayDetails,
                    onMachineChange = { machine ->
                        if (machine == DashboardQuery.ALL_MACHINES) viewModel.selectMachine(machine)
                        else viewModel.toggleMachine(machine)
                    },
                    onToolChange = { tool ->
                        if (tool == null) viewModel.selectTool(null) else viewModel.toggleTool(tool)
                    },
                    onModelChange = { model ->
                        if (model == null) viewModel.selectModel(null) else viewModel.toggleModel(model)
                    },
                    onSearchChange = viewModel::setSearch,
                    onClearFilters = viewModel::clearFilters,
                    onSectionChange = viewModel::selectSection,
                    onContributionModeChange = viewModel::selectContributionMode,
                    onOpenTool = viewModel::openTool,
                    onOpenModel = viewModel::openModel,
                    onBack = viewModel::navigateBack,
                    onLoadMore = viewModel::loadMoreDetails,
                    onAppearanceChange = onAppearanceChange,
                    onOpenLowPowerDisplay = viewModel::openLowPowerDisplay,
                    onRefresh = viewModel::refresh,
                    onSignOut = viewModel::signOut
                )
            }
        }
    }
}

@Composable
private fun CenterLoading() {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(color = MaterialTheme.colorScheme.primary)
    }
}

@Composable
private fun ConfigMissingScreen() {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .verticalScroll(rememberScrollState()),
        contentAlignment = Alignment.Center
    ) {
        Column(
            modifier = Modifier
                .widthIn(max = 520.dp)
                .padding(28.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            Text(stringResource(R.string.app_name), style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.Bold)
            Text("v${BuildConfig.TOKENLEDGER_APP_VERSION}", color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(
                stringResource(R.string.config_missing_message),
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

@Composable
private fun LoginScreen(
    palette: MobileV2Palette,
    loading: Boolean,
    error: String?,
    onLogin: (String, String) -> Unit
) {
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var passwordVisible by remember { mutableStateOf(false) }
    val passwordFocusRequester = remember { FocusRequester() }
    val focusManager = LocalFocusManager.current
    val submit = {
        if (!loading && email.isNotBlank() && password.isNotBlank()) {
            focusManager.clearFocus()
            onLogin(email, password)
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .verticalScroll(rememberScrollState()),
        contentAlignment = Alignment.Center
    ) {
        Card(
            modifier = Modifier
                .widthIn(max = 440.dp)
                .padding(24.dp),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
            shape = RoundedCornerShape(8.dp)
        ) {
            Column(
                modifier = Modifier.padding(22.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp)
            ) {
                Column {
                    Text(stringResource(R.string.app_name), style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.Bold)
                    Text(
                        stringResource(R.string.login_subtitle, BuildConfig.TOKENLEDGER_APP_VERSION),
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                OutlinedTextField(
                    value = email,
                    onValueChange = { email = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text(stringResource(R.string.email_label)) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.Email,
                        imeAction = ImeAction.Next
                    ),
                    keyboardActions = KeyboardActions(
                        onNext = { passwordFocusRequester.requestFocus() }
                    )
                )
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it },
                    modifier = Modifier
                        .fillMaxWidth()
                        .focusRequester(passwordFocusRequester),
                    label = { Text(stringResource(R.string.password_label)) },
                    singleLine = true,
                    visualTransformation = if (passwordVisible) {
                        VisualTransformation.None
                    } else {
                        PasswordVisualTransformation()
                    },
                    trailingIcon = {
                        IconButton(
                            onClick = { passwordVisible = !passwordVisible },
                            modifier = Modifier.size(48.dp)
                        ) {
                            Icon(
                                imageVector = if (passwordVisible) {
                                    Icons.Default.VisibilityOff
                                } else {
                                    Icons.Default.Visibility
                                },
                                contentDescription = if (passwordVisible) "隐藏密码" else "显示密码"
                            )
                        }
                    },
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.Password,
                        imeAction = ImeAction.Done
                    ),
                    keyboardActions = KeyboardActions(onDone = { submit() })
                )
                Button(
                    onClick = submit,
                    enabled = !loading && email.isNotBlank() && password.isNotBlank(),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                    shape = RoundedCornerShape(8.dp)
                ) {
                    Text(if (loading) stringResource(R.string.login_loading) else stringResource(R.string.login_action))
                }
                ErrorText(error)
                V2LoginIntro(palette)
            }
        }
    }
}

@Composable
private fun ErrorText(error: String?) {
    if (error != null) {
        Card(
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.error),
            shape = RoundedCornerShape(8.dp),
            modifier = Modifier
                .fillMaxWidth()
                .semantics { liveRegion = LiveRegionMode.Assertive }
        ) {
            // 文字坐在 errorContainer 上，就必须用 onErrorContainer。
            // 此前用的是 error（#FF6B7A，本意是画在 surface 上的强调色），
            // 落在默认的 errorContainer #8C1D18 上实测只有 3.31:1——
            // 会话过期这一屏上，唯一说明出了什么事的那行字最不可读。
            Text(error, modifier = Modifier.padding(12.dp), color = MaterialTheme.colorScheme.onErrorContainer)
        }
    }
}
