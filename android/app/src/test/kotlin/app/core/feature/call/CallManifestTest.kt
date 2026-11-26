package app.core.feature.call

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** What the merged manifest asks for calls: the microphone and the camera, and no Bluetooth runtime permission. */
@RunWith(AndroidJUnit4::class)
class CallManifestTest {

    @Test
    fun callsDeclareTheMicrophoneAndTheCameraButNotBluetoothConnect() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val requested = context.packageManager
            .getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS)
            .requestedPermissions.orEmpty().toList()
        assertTrue(Manifest.permission.RECORD_AUDIO in requested)
        assertTrue(Manifest.permission.CAMERA in requested)
        assertFalse("android.permission.BLUETOOTH_CONNECT" in requested)
    }
}
