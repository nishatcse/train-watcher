package com.afridi.train_watcher

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log

/**
 * Runs for as long as a seat hold is active. It (1) is a foreground service, so Android keeps the process
 * alive, (2) checks every second that MainActivity is in front and puts it back if it is not (home button,
 * another app, swiped out of recents), and (3) keeps an alarm armed so that, even if the whole process is
 * killed, the hold is brought back up by HoldGuardReceiver.
 */
class HoldGuardService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private var lastLaunch = 0L

    private val tick = object : Runnable {
        override fun run() {
            if (!HoldGuardState.isActive(this@HoldGuardService)) {
                stopSelf()
                return
            }
            if (HoldGuardState.needsFront(this@HoldGuardService)) bringToFront(this@HoldGuardService)
            scheduleWatchdog(this@HoldGuardService)
            handler.postDelayed(this, 1000)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // START_STICKY restarts arrive with a null intent: whether to carry on is decided by the saved state.
        if (!HoldGuardState.isActive(this)) {
            stopSelf()
            return START_NOT_STICKY
        }
        intent?.getStringExtra(EXTRA_STATUS)?.let { HoldGuardState.setStatusText(this, it) }
        createChannels(this)
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        handler.removeCallbacks(tick)
        handler.post(tick)
        return START_STICKY
    }

    // The task was swiped out of recents. The service keeps running (stopWithTask is false), so put the
    // screen straight back and re-arm the alarm in case this process is about to be killed.
    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
        if (HoldGuardState.isActive(this)) {
            scheduleWatchdog(this, 3_000L)
            bringToFront(this, force = true)
        }
    }

    override fun onDestroy() {
        handler.removeCallbacks(tick)
        if (!HoldGuardState.isActive(this)) cancelWatchdog(this)
        super.onDestroy()
    }

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(this, CHANNEL_HOLD)
            .setSmallIcon(R.drawable.ic_hold)
            .setContentTitle("Seat holder is running")
            .setContentText(HoldGuardState.statusText(this))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(open)
            .build()
    }

    companion object {
        const val EXTRA_STATUS = "status"
        const val CHANNEL_HOLD = "seat_holder_running"
        const val CHANNEL_ATTENTION = "seat_holder_attention"
        const val NOTIFICATION_ID = 4101
        const val ATTENTION_ID = 4102
        private var lastBringToFront = 0L

        fun createChannels(c: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val nm = c.getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_HOLD, "Seat holder running", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Shown while the seat holder is keeping seats."
                    setShowBadge(false)
                },
            )
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ATTENTION, "Seat holder needs you", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "Login expired, long internet outage, or the holder stopped."
                },
            )
        }

        /** Puts MainActivity back in front. Needs the "display over other apps" / MIUI pop-up permission. */
        fun bringToFront(c: Context, force: Boolean = false) {
            val now = System.currentTimeMillis()
            if (!force && now - lastBringToFront < 3_000) return
            lastBringToFront = now
            val intent = Intent(c, MainActivity::class.java)
                .setAction("HOLD_RESUME")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            try {
                c.startActivity(intent)
            } catch (e: Exception) {
                Log.w("HoldGuard", "could not bring the app to the front: $e")
            }
        }

        private fun watchdogIntent(c: Context): PendingIntent = PendingIntent.getBroadcast(
            c, 77, Intent(c, HoldGuardReceiver::class.java).setAction(HoldGuardReceiver.ACTION_WATCHDOG),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        /** An alarm outlives this process: if the app is killed it restarts the guard. */
        fun scheduleWatchdog(c: Context, delayMs: Long = 30_000L) {
            val am = c.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val at = System.currentTimeMillis() + delayMs
            try {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, watchdogIntent(c))
            } catch (e: SecurityException) {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, watchdogIntent(c))
            }
        }

        fun cancelWatchdog(c: Context) {
            (c.getSystemService(Context.ALARM_SERVICE) as AlarmManager).cancel(watchdogIntent(c))
        }
    }
}
