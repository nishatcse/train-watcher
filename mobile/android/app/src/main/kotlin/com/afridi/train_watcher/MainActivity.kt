package com.afridi.train_watcher

import android.app.KeyguardManager
import android.content.Context
import android.app.Notification
import android.app.PictureInPictureParams
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.util.Rational
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private val channelName = "train_watcher/keyguard"
    private val guardChannelName = "train_watcher/hold_guard"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        applyLockScreenMode(intent)
    }

    private var guardChannel: MethodChannel? = null

    override fun onStart() {
        super.onStart()
        HoldGuardState.activityVisible = true
    }

    override fun onStop() {
        HoldGuardState.activityVisible = false
        super.onStop()
    }

    override fun onResume() {
        super.onResume()
        HoldGuardState.activityResumed = true
    }

    // Home / recents while a hold runs: shrink into a floating window instead of leaving the screen, so the
    // page keeps running (a hidden WebView is throttled) and the owner can still use the phone.
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (HoldGuardState.isActive(this) && HoldGuardState.mode(this) == HoldGuardState.MODE_PIP) enterPip()
    }

    private fun pipParams(): PictureInPictureParams? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return null
        val b = PictureInPictureParams.Builder().setAspectRatio(Rational(3, 4))
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            b.setAutoEnterEnabled(HoldGuardState.isActive(this) && HoldGuardState.mode(this) == HoldGuardState.MODE_PIP)
        }
        return b.build()
    }

    private fun updatePipParams() {
        pipParams()?.let { try { setPictureInPictureParams(it) } catch (_: Exception) {} }
    }

    private fun enterPip() {
        if (isInPictureInPictureMode) return
        pipParams()?.let { try { enterPictureInPictureMode(it) } catch (_: Exception) {} }
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: android.content.res.Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        guardChannel?.invokeMethod("pip", isInPictureInPictureMode)
    }

    override fun onPause() {
        HoldGuardState.activityResumed = false
        super.onPause()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        applyLockScreenMode(intent)
        // The guard brought the app back (swiped away, killed): come up as the small window, not full screen.
        if (intent.action == "HOLD_RESUME" && HoldGuardState.isActive(this) && HoldGuardState.mode(this) == HoldGuardState.MODE_PIP) {
            window.decorView.postDelayed({ enterPip() }, 400)
        }
    }

    // Only an alert notification (full-screen intent / tap) may show the app over the
    // lock screen. A normal launch never does, so the logged-in railway session inside
    // the app is not reachable from a locked phone.
    private fun applyLockScreenMode(intent: Intent?) {
        val fromAlert = intent?.action == "SELECT_FOREGROUND_NOTIFICATION" || intent?.action == "SELECT_NOTIFICATION"
        if (fromAlert && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        }
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        guardChannel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, guardChannelName)
        guardChannel!!.setMethodCallHandler { call, result ->
            when (call.method) {
                "start" -> {
                    val stopAt = (call.argument<Number>("stopAtMs") ?: 0).toLong()
                    HoldGuardState.setActive(this, true, stopAt)
                    HoldGuardState.setStatusText(this, "Starting…")
                    HoldGuardService.createChannels(this)
                    startForegroundService(Intent(this, HoldGuardService::class.java))
                    HoldGuardService.scheduleWatchdog(this)
                    updatePipParams()
                    result.success(true)
                }
                "setMode" -> {
                    HoldGuardState.setMode(this, call.argument<String>("mode") ?: HoldGuardState.MODE_PIP)
                    updatePipParams()
                    result.success(true)
                }
                "mode" -> result.success(HoldGuardState.mode(this))
                "stop" -> {
                    HoldGuardState.setActive(this, false, 0L)
                    stopService(Intent(this, HoldGuardService::class.java))
                    HoldGuardService.cancelWatchdog(this)
                    updatePipParams()
                    result.success(true)
                }
                "status" -> {
                    if (HoldGuardState.isActive(this)) {
                        startService(
                            Intent(this, HoldGuardService::class.java)
                                .putExtra(HoldGuardService.EXTRA_STATUS, call.argument<String>("text") ?: ""),
                        )
                    }
                    result.success(true)
                }
                "attention" -> {
                    HoldGuardService.createChannels(this)
                    val open = PendingIntent.getActivity(
                        this, 1, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                    )
                    val n = Notification.Builder(this, HoldGuardService.CHANNEL_ATTENTION)
                        .setSmallIcon(R.drawable.ic_hold)
                        .setContentTitle(call.argument<String>("title") ?: "Seat holder")
                        .setContentText(call.argument<String>("body") ?: "")
                        .setStyle(Notification.BigTextStyle().bigText(call.argument<String>("body") ?: ""))
                        .setContentIntent(open)
                        .setAutoCancel(true)
                        .build()
                    getSystemService(NotificationManager::class.java).notify(HoldGuardService.ATTENTION_ID, n)
                    result.success(true)
                }
                "wasActive" -> result.success(HoldGuardState.isActive(this))
                "permissions" -> {
                    val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
                    result.success(
                        mapOf(
                            "battery" to pm.isIgnoringBatteryOptimizations(packageName),
                            "overlay" to Settings.canDrawOverlays(this),
                        ),
                    )
                }
                "batteryExemption" -> {
                    val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
                    if (!pm.isIgnoringBatteryOptimizations(packageName)) {
                        startActivity(
                            Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")),
                        )
                    }
                    result.success(true)
                }
                "overlayPermission" -> {
                    if (!Settings.canDrawOverlays(this)) {
                        startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
                    }
                    result.success(true)
                }
                else -> result.notImplemented()
            }
        }
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channelName).setMethodCallHandler { call, result ->
            val km = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
            when (call.method) {
                "isLocked" -> result.success(km.isKeyguardLocked)
                "dismissKeyguard" -> {
                    if (!km.isKeyguardLocked) {
                        result.success(true)
                    } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        km.requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
                            override fun onDismissSucceeded() { result.success(true) }
                            override fun onDismissCancelled() { result.success(false) }
                            override fun onDismissError() { result.success(false) }
                        })
                    } else {
                        result.success(false)
                    }
                }
                "finish" -> {
                    finishAndRemoveTask()
                    result.success(true)
                }
                else -> result.notImplemented()
            }
        }
    }
}
