package com.afridi.train_watcher

import android.content.Context
import android.content.SharedPreferences

/**
 * What the seat-holder guard needs to know, kept in plain SharedPreferences so it is readable from the
 * service, the alarm receiver and the activity, and survives the app process being killed.
 */
object HoldGuardState {
    private const val PREFS = "hold_guard"

    /** Set by MainActivity: true while it is the resumed (visible, in front) activity. */
    @Volatile
    var activityResumed = false

    /** True from onStart to onStop: the activity is on screen, also as a small picture-in-picture window. */
    @Volatile
    var activityVisible = false

    const val MODE_PIP = "pip"     // Home -> small floating window, the app keeps running in it
    const val MODE_FRONT = "front" // always pulled back to full screen
    const val MODE_FREE = "free"   // left alone: runs in the background, like any app

    /** The guard gives up this long after the owner's end time, in case Dart never got to say "stop". */
    private const val GRACE_MS = 10 * 60 * 1000L

    /** With no end time the guard still lets go after a day, so a broken run can never trap the phone. */
    private const val OPEN_ENDED_MAX_MS = 24 * 60 * 60 * 1000L

    private fun prefs(c: Context): SharedPreferences = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun isActive(c: Context): Boolean {
        val p = prefs(c)
        if (!p.getBoolean("active", false)) return false
        val stopAt = p.getLong("stopAtMs", 0L)
        val now = System.currentTimeMillis()
        val expired = if (stopAt > 0) now > stopAt + GRACE_MS else now > p.getLong("startedAtMs", now) + OPEN_ENDED_MAX_MS
        if (expired) {
            setActive(c, false, 0L)
            return false
        }
        return true
    }

    fun setActive(c: Context, active: Boolean, stopAtMs: Long) {
        prefs(c).edit()
            .putBoolean("active", active)
            .putLong("stopAtMs", stopAtMs)
            .putLong("startedAtMs", System.currentTimeMillis())
            .apply()
    }

    fun mode(c: Context): String = prefs(c).getString("mode", MODE_PIP) ?: MODE_PIP

    fun setMode(c: Context, mode: String) {
        prefs(c).edit().putString("mode", mode).apply()
    }

    /** Whether the guard should bring the app back right now, given the owner's chosen mode. */
    fun needsFront(c: Context): Boolean = when (mode(c)) {
        MODE_FREE -> false
        MODE_FRONT -> !activityResumed
        else -> !activityVisible
    }

    fun statusText(c: Context): String = prefs(c).getString("status", "Holding seats") ?: "Holding seats"

    fun setStatusText(c: Context, text: String) {
        prefs(c).edit().putString("status", text).apply()
    }
}
