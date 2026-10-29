package com.afridi.train_watcher

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/** Revives the hold after the process was killed, the phone rebooted, or the app was updated. */
class HoldGuardReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (!HoldGuardState.isActive(context)) {
            HoldGuardService.cancelWatchdog(context)
            return
        }
        Log.i("HoldGuard", "revive on ${intent.action}")
        try {
            context.startForegroundService(Intent(context, HoldGuardService::class.java))
        } catch (e: Exception) {
            Log.w("HoldGuard", "could not start the service: $e")
        }
        if (HoldGuardState.needsFront(context)) HoldGuardService.bringToFront(context, force = true)
        HoldGuardService.scheduleWatchdog(context)
    }

    companion object {
        const val ACTION_WATCHDOG = "com.afridi.train_watcher.HOLD_WATCHDOG"
    }
}
