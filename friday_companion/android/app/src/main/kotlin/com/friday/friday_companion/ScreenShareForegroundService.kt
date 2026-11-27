package com.friday.friday_companion

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.IBinder

/**
 * Explicit-session foreground service for Android MediaProjection.
 * Shows a persistent user-visible notification with a Stop action and
 * never starts or restarts capture silently.
 */
class ScreenShareForegroundService : Service() {
    companion object {
        const val CHANNEL_ID = "friday_screen_share"
        const val NOTIFICATION_ID = 9042
        const val ACTION_START = "com.friday.companion.ACTION_START_SHARE"
        const val ACTION_STOP = "com.friday.companion.ACTION_STOP_SHARE"
        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_DATA_INTENT = "dataIntent"

        @Volatile
        var isRunning: Boolean = false
            private set
    }

    private var mediaProjection: MediaProjection? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopProjectionAndSelf()
                return START_NOT_STICKY
            }
            ACTION_START -> {
                createNotificationChannel()
                val notification = buildPersistentNotification()
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    startForeground(
                        NOTIFICATION_ID,
                        notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
                    )
                } else {
                    startForeground(NOTIFICATION_ID, notification)
                }

                val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0)
                @Suppress("DEPRECATION")
                val dataIntent: Intent? = intent.getParcelableExtra(EXTRA_DATA_INTENT)
                if (dataIntent != null) {
                    val mgr = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
                    mediaProjection = mgr.getMediaProjection(resultCode, dataIntent)?.apply {
                        registerCallback(object : MediaProjection.Callback() {
                            override fun onStop() {
                                stopProjectionAndSelf()
                            }
                        }, null)
                    }
                    isRunning = mediaProjection != null
                } else {
                    stopProjectionAndSelf()
                }
            }
        }
        return START_NOT_STICKY
    }

    private fun stopProjectionAndSelf() {
        isRunning = false
        try {
            mediaProjection?.stop()
        } catch (_: Exception) {
        }
        mediaProjection = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        isRunning = false
        try {
            mediaProjection?.stop()
        } catch (_: Exception) {
        }
        mediaProjection = null
        super.onDestroy()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "FRIDAY Screen Sharing",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Visible while an explicit FRIDAY screen-sharing session is active."
            }
            val nm = getSystemService(NotificationManager::class.java)
            nm?.createNotificationChannel(channel)
        }
    }

    private fun buildPersistentNotification(): Notification {
        val stopIntent = Intent(this, ScreenShareForegroundService::class.java).apply {
            action = ACTION_STOP
        }
        val stopPending = PendingIntent.getService(
            this,
            1,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }

        return builder
            .setContentTitle("FRIDAY Screen Sharing Active")
            .setContentText("Explicit session in progress. Tap Stop to end capture.")
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setOngoing(true)
            .addAction(
                Notification.Action.Builder(
                    null,
                    "Stop Sharing",
                    stopPending
                ).build()
            )
            .build()
    }
}
