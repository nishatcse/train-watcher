package com.afridi.train_watcher

import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private val channelName = "train_watcher/keyguard"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        applyLockScreenMode(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        applyLockScreenMode(intent)
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
