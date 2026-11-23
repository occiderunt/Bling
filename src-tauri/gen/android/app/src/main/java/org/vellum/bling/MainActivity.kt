package org.vellum.bling

import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    ensureLocalNetworkPermission()
  }

  /**
   * Android 17 (API 37) blocks all local network traffic by default. Any app that
   * talks to devices on the LAN (libp2p peers, mDNS, etc.) must hold the
   * ACCESS_LOCAL_NETWORK runtime permission, otherwise dials hang and inbound
   * connections never arrive.
   */
  private fun ensureLocalNetworkPermission() {
    if (Build.VERSION.SDK_INT < 37) return
    val granted =
      ActivityCompat.checkSelfPermission(this, LOCAL_NETWORK_PERMISSION) ==
        PackageManager.PERMISSION_GRANTED
    if (granted) return
    ActivityCompat.requestPermissions(
      this,
      arrayOf(LOCAL_NETWORK_PERMISSION),
      LOCAL_NETWORK_REQUEST_CODE,
    )
  }

  override fun onRequestPermissionsResult(
    requestCode: Int,
    permissions: Array<out String>,
    grantResults: IntArray,
  ) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode == LOCAL_NETWORK_REQUEST_CODE) {
      val granted = grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED
      if (!granted) {
        android.util.Log.w(
          "Bling",
          "ACCESS_LOCAL_NETWORK denied: local peer discovery and connections will not work",
        )
      }
    }
  }

  companion object {
    private const val LOCAL_NETWORK_PERMISSION = "android.permission.ACCESS_LOCAL_NETWORK"
    private const val LOCAL_NETWORK_REQUEST_CODE = 4101
  }
}
