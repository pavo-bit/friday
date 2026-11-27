package com.friday.friday_companion

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Build
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    companion object {
        private const val CHANNEL = "com.friday.companion/media_projection"
        private const val REQ_MEDIA_PROJECTION = 4401
    }

    private var pendingResult: MethodChannel.Result? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, CHANNEL)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "startScreenShare" -> {
                        if (pendingResult != null) {
                            result.error("IN_PROGRESS", "Screen share consent already pending", null)
                            return@setMethodCallHandler
                        }
                        pendingResult = result
                        val mgr = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
                        @Suppress("DEPRECATION")
                        startActivityForResult(mgr.createScreenCaptureIntent(), REQ_MEDIA_PROJECTION)
                    }
                    "stopScreenShare" -> {
                        val stopIntent = Intent(this, ScreenShareForegroundService::class.java).apply {
                            action = ScreenShareForegroundService.ACTION_STOP
                        }
                        startService(stopIntent)
                        result.success(true)
                    }
                    "isScreenShareActive" -> {
                        result.success(ScreenShareForegroundService.isRunning)
                    }
                    else -> result.notImplemented()
                }
            }
    }

    @Suppress("DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_MEDIA_PROJECTION) {
            val res = pendingResult
            pendingResult = null
            if (resultCode == Activity.RESULT_OK && data != null) {
                val svcIntent = Intent(this, ScreenShareForegroundService::class.java).apply {
                    action = ScreenShareForegroundService.ACTION_START
                    putExtra(ScreenShareForegroundService.EXTRA_RESULT_CODE, resultCode)
                    putExtra(ScreenShareForegroundService.EXTRA_DATA_INTENT, data)
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    startForegroundService(svcIntent)
                } else {
                    startService(svcIntent)
                }
                res?.success(true)
            } else {
                res?.error("CONSENT_DENIED", "User denied MediaProjection consent", null)
            }
        }
    }

    override fun onDestroy() {
        pendingResult = null
        super.onDestroy()
    }
}
