package com.jeidorf.tokenledger.mobile

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.PowerManager
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.dp
import androidx.annotation.RequiresApi
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import kotlinx.coroutines.delay

internal const val LOW_POWER_THERMAL_MODERATE = 2

/**
 * Static ambient-display policy. Full-screen widget residency keeps the display awake while the
 * composable is attached, but never starts background refreshes or decorative motion. System
 * constraints only reduce how much secondary information is drawn.
 */
internal data class LowPowerPolicy(
    val compactDetails: Boolean,
    val visibleQuotaWindowLimit: Int,
    val allowMotion: Boolean = false,
    val allowBackgroundRefresh: Boolean = false,
    val keepScreenOn: Boolean = true,
    val hideStatusBar: Boolean = true
)

/**
 * 两条独立的轴，不得混在一起：
 *
 * - **设备约束轴**（本函数）：省电、过热、关闭动画。这些是设备真的撑不住，只能少画。
 * - **模式意图轴**（[AmbientMode]）：用户想看多少。这是偏好，不是限制。
 *
 * 主题（[LedgerAppearance]）不参与任何一轴——它只决定配色与
 * [resolveRenderProfile] 的画风。旧实现把 `appearance == EInk` 混进了约束判定，
 * 结果是在一台普通手机上仅仅选了墨水屏配色，额度窗口就被从 4 个悄悄砍到 2 个。
 */
internal fun resolveLowPowerPolicy(
    mode: AmbientMode,
    powerSaveMode: Boolean,
    thermalStatus: Int,
    systemAnimationsEnabled: Boolean
): LowPowerPolicy {
    val constrained = powerSaveMode ||
        thermalStatus >= LOW_POWER_THERMAL_MODERATE ||
        !systemAnimationsEnabled
    val quotaLimit = when {
        // 不显示额度的档不需要额度预算。
        !mode.showsQuota -> 0
        // 额度墙与墨水日报的全部意义就是"一个窗口都不藏"。设备受限时可以少画装饰，
        // 但不能反过来悄悄截断它们本该完整呈现的数据（审计 A2）。
        AmbientElement.QuotaBoard in mode.elements ||
            AmbientElement.QuotaGaugeGrid in mode.elements -> Int.MAX_VALUE
        constrained -> 2
        else -> 4
    }
    return LowPowerPolicy(
        compactDetails = constrained,
        visibleQuotaWindowLimit = quotaLimit,
        allowMotion = !constrained,
        keepScreenOn = true
    )
}

private data class LowPowerSystemState(
    val powerSaveMode: Boolean,
    val thermalStatus: Int
)

@Composable
internal fun LowPowerDisplayScreen(
    state: DashboardUiState,
    appearance: LedgerAppearance,
    tokenDisplayMode: TokenDisplayMode,
    ambientMode: AmbientMode,
    onTokenDisplayModeChange: ((TokenDisplayMode) -> Unit)? = null,
    forceEInkRefresh: Boolean = false,
    policyOverride: LowPowerPolicy? = null
) {
    val view = LocalView.current
    var redrawGeneration by remember { mutableStateOf(0) }
    var showRefreshFlash by remember(forceEInkRefresh) { mutableStateOf(forceEInkRefresh) }
    DisposableEffect(view, forceEInkRefresh) {
        val redraw = {
            view.post {
                view.requestLayout()
                view.invalidate()
            }
        }
        val showFlash = Runnable { showRefreshFlash = true }
        val finishRefresh = Runnable {
            showRefreshFlash = false
            redrawGeneration += 1
            redraw()
        }
        fun scheduleRefresh() {
            view.removeCallbacks(showFlash)
            view.removeCallbacks(finishRefresh)
            if (forceEInkRefresh) {
                view.post(showFlash)
                view.postDelayed(finishRefresh, 220L)
            } else {
                redraw()
            }
        }
        val listener = android.view.ViewTreeObserver.OnWindowFocusChangeListener { hasFocus ->
            if (hasFocus) scheduleRefresh()
        }
        view.viewTreeObserver.addOnWindowFocusChangeListener(listener)
        scheduleRefresh()
        onDispose {
            view.removeCallbacks(showFlash)
            view.removeCallbacks(finishRefresh)
            if (view.viewTreeObserver.isAlive) {
                view.viewTreeObserver.removeOnWindowFocusChangeListener(listener)
            }
        }
    }
    val policy = policyOverride ?: rememberLowPowerSystemState().let { systemState ->
        resolveLowPowerPolicy(
            mode = ambientMode,
            powerSaveMode = systemState.powerSaveMode,
            thermalStatus = systemState.thermalStatus,
            systemAnimationsEnabled = systemAnimationsEnabled()
        )
    }
    // Preview screenshot tests run every @Preview in one renderer. Keep the production
    // minute ticker out of that process so an infinite delayed effect cannot make
    // unrelated golden captures race a recomposition.
    val allowPixelShift =
        policy.allowMotion &&
            appearance != LedgerAppearance.EInk &&
            !LocalInspectionMode.current
    var pixelShiftStep by remember(allowPixelShift) { mutableStateOf(0) }
    LaunchedEffect(allowPixelShift) {
        if (!allowPixelShift) {
            pixelShiftStep = 0
            return@LaunchedEffect
        }
        while (true) {
            delay(60_000L)
            pixelShiftStep += 1
        }
    }
    val pixelShift = ambientPixelShift(pixelShiftStep)
    val pixelShiftSafePadding = if (appearance == LedgerAppearance.EInk) 0.dp else 8.dp
    DisposableEffect(view, policy.keepScreenOn) {
        val previousKeepScreenOn = view.keepScreenOn
        view.keepScreenOn = policy.keepScreenOn
        onDispose {
            view.keepScreenOn = previousKeepScreenOn
        }
    }
    DisposableEffect(view, policy.hideStatusBar) {
        val activity = view.context.findActivity()
        val controller = activity?.let { WindowCompat.getInsetsController(it.window, view) }
        val statusBarsWereVisible = ViewCompat.getRootWindowInsets(view)
            ?.isVisible(WindowInsetsCompat.Type.statusBars())
            ?: true
        if (policy.hideStatusBar) {
            controller?.systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            controller?.hide(WindowInsetsCompat.Type.statusBars())
        }
        onDispose {
            if (policy.hideStatusBar && statusBarsWereVisible) {
                controller?.show(WindowInsetsCompat.Type.statusBars())
            }
        }
    }
    Box(Modifier.fillMaxSize()) {
        key(redrawGeneration) {
            Box(
                Modifier
                    .fillMaxSize()
                    .padding(pixelShiftSafePadding)
                    .offset(pixelShift.xDp.dp, pixelShift.yDp.dp)
            ) {
                FullScreenWidgetV2(
                    state = state,
                    appearance = appearance,
                    tokenDisplayMode = tokenDisplayMode,
                    mode = ambientMode,
                    policy = policy,
                    onTokenDisplayModeChange = onTokenDisplayModeChange,
                )
            }
        }
        if (showRefreshFlash) {
            Box(
                Modifier
                    .fillMaxSize()
                    .background(if (appearance == LedgerAppearance.Dark) Color.White else Color.Black)
            )
        }
    }
}

private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}

@Composable
private fun rememberLowPowerSystemState(): LowPowerSystemState {
    val context = LocalContext.current.applicationContext
    val powerManager = remember(context) {
        context.getSystemService(Context.POWER_SERVICE) as PowerManager
    }
    fun readState(): LowPowerSystemState = LowPowerSystemState(
        powerSaveMode = powerManager.isPowerSaveMode,
        thermalStatus = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            powerManager.currentThermalStatus
        } else {
            0
        }
    )
    var state by remember(powerManager) { mutableStateOf(readState()) }

    DisposableEffect(context, powerManager) {
        val refresh = { state = readState() }
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) = refresh()
        }
        ContextCompat.registerReceiver(
            context,
            receiver,
            IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED),
            ContextCompat.RECEIVER_NOT_EXPORTED
        )
        val thermalListener: Any? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            Api29ThermalStatus.addListener(powerManager, refresh)
        } else {
            null
        }
        onDispose {
            runCatching { context.unregisterReceiver(receiver) }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                thermalListener?.let { Api29ThermalStatus.removeListener(powerManager, it) }
            }
        }
    }
    return state
}

@RequiresApi(Build.VERSION_CODES.Q)
private object Api29ThermalStatus {
    fun addListener(powerManager: PowerManager, onChange: () -> Unit): Any {
        val listener = PowerManager.OnThermalStatusChangedListener { onChange() }
        powerManager.addThermalStatusListener(listener)
        return listener
    }

    fun removeListener(powerManager: PowerManager, listener: Any) {
        powerManager.removeThermalStatusListener(
            listener as PowerManager.OnThermalStatusChangedListener
        )
    }
}
