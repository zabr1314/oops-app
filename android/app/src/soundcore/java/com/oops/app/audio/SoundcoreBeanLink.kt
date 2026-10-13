package com.oops.app.audio

import android.content.Context
import android.util.Log
import com.oceanwing.soundcore.spplink.SoundcoreSDK
import com.oceanwing.soundcore.spplink.listener.DeviceTransferState
import com.oceanwing.soundcore.spplink.listener.FileTransferError
import com.oceanwing.soundcore.spplink.listener.SoundcoreBusinessCallback
import com.oceanwing.soundcore.spplink.listener.SoundcoreConnectionCallback
import com.oceanwing.soundcore.spplink.log.LogInterface
import com.oceanwing.soundcore.spplink.model.BlueDeviceModel
import com.oceanwing.soundcore.spplink.model.SDKInitConfig
import com.oceanwing.soundcore.spplink.model.SdkException
import com.oceanwing.soundcore.spplink.service.audio.model.OfflineFileData
import com.oceanwing.soundcore.spplink.service.auth.AuthResult
import com.oceanwing.soundcore.spplink.service.auth.OnAuthResultListener
import com.oceanwing.soundcore.spplink.service.auth.SDKEnvironment
import com.oceanwing.soundcore.spplink.service.deviceinfo.DeviceInfo
import com.oceanwing.soundcore.spplink.service.devicelog.DeviceLogFileInfo
import com.oceanwing.soundcore.spplink.service.search.OnReceiveScanResult
import com.oceanwing.soundcore.spplink.service.wifi.WifiState
import java.io.File

/**
 * The real 录音豆 (Soundcore D3200) through the Anker SDK. Built only when the SDK sits in
 * `android/app/libs/soundcore/` (see app/build.gradle.kts); [BeanSdk] finds it by name.
 *
 * Flow per the SDK document: init + auth → scan → connect → device info → wait until the device itself
 * is recording (the SDK cannot start it) → acquireRealtimeAudioData → onReceiveAudioFragment packets.
 * Untested against hardware: no device was available when this was written (2026-10-12).
 */
class SoundcoreBeanLink(private val context: Context, private val auth: BeanAuth) : BeanLink {
    override val label = "录音豆"

    private val sdk = SoundcoreSDK.Companion.proxy
    @Volatile private var sink: BeanLink.Sink? = null
    @Volatile private var device: BlueDeviceModel? = null
    @Volatile private var streaming = false

    override fun start(sink: BeanLink.Sink) {
        this.sink = sink
        streaming = false
        sink.onConnected(false)
        sink.onStatus("录音豆鉴权中")
        val config = SDKInitConfig(
            context.applicationContext, auth.userId, auth.deviceId, auth.token, auth.licenseJson, auth.licenseSignature,
            if (auth.production) SDKEnvironment.PRODUCTION else SDKEnvironment.DEVELOPMENT,
            false, null, 3L, 200L, false, 100L, true,
        )
        sdk.initSDK(SdkLog, config, object : OnAuthResultListener {
            override fun onAuthResult(result: AuthResult) {
                if (result.success) scan()
                else sink.onError(IllegalStateException("录音豆鉴权失败：${result.error?.message ?: "未知原因"}（${result.error?.code}）"))
            }
        })
        sdk.registerBusinessCallback(callback)
    }

    override fun stop() {
        val d = device
        sink = null
        runCatching { sdk.stopScan() }
        if (d != null) {
            if (streaming) runCatching { sdk.pauseRecord(d.macAddress!!, d.uuid!!) } // ends the realtime transfer
            runCatching { sdk.disconnect(d.macAddress!!, d.uuid!!) }
        }
        streaming = false
        device = null
    }

    private fun scan() {
        sink?.onStatus("正在寻找录音豆，请打开录音豆并靠近手机")
        sdk.startScan(true, true, ArrayList(), object : OnReceiveScanResult {
            override fun onScanSuccess(device: BlueDeviceModel) {
                if (this@SoundcoreBeanLink.device != null || device.macAddress == null || device.uuid == null) return
                if (auth.macAddress.isNotEmpty() && !device.macAddress.equals(auth.macAddress, ignoreCase = true)) return
                this@SoundcoreBeanLink.device = device
                sdk.stopScan()
                connect(device)
            }

            override fun onScanError(result: Int) {
                sink?.onStatus(when (result) {
                    1 -> "没有找到录音豆，请确认已开机并靠近手机"
                    3 -> "正在扫描中"
                    else -> "扫描中断（$result）"
                })
            }
        })
    }

    private fun connect(d: BlueDeviceModel) {
        sink?.onStatus("正在连接 ${d.deviceName ?: "录音豆"}")
        sdk.connect(d.macAddress!!, d.uuid!!, object : SoundcoreConnectionCallback {
            override fun onConnected(macAddress: String?, deviceName: String?) {
                sdk.getDeviceInfo(d.macAddress!!, d.uuid!!)
            }

            override fun onDisconnected(macAddress: String?, systemCode: Int?, systemMsg: String?) {
                streaming = false
                sink?.onConnected(false)
                sink?.onStatus("录音豆已断开${systemMsg?.let { "（$it）" } ?: ""}")
            }

            override fun onError(macAddress: String?, exception: SdkException) {
                sink?.onError(IllegalStateException("录音豆连接失败：${exception.message}（${exception.code}）"))
            }
        })
    }

    private fun startStreaming(d: BlueDeviceModel) {
        if (streaming) return
        streaming = true
        val folder = File(context.filesDir, "bean").apply { mkdirs() } // the SDK also saves what it streams
        sdk.acquireRealtimeAudioData(d.macAddress!!, d.uuid!!, folder.absolutePath)
        sink?.onStatus(null)
    }

    private val callback = object : SoundcoreBusinessCallback {
        override fun onGetDeviceInfo(macAddress: String, uuid: String, info: DeviceInfo) {
            val d = device ?: return
            if (info.recording == 1) startStreaming(d) else sink?.onStatus("请按录音豆上的录音键开始录音")
        }

        override fun onAudioRecordStatusChanged(macAddress: String, uuid: String, status: Int, recordingDuration: Int, fileID: Int) {
            val d = device ?: return
            when (status) {
                SoundcoreBusinessCallback.RECORDING -> startStreaming(d)
                else -> {
                    streaming = false
                    sink?.onConnected(false)
                    sink?.onStatus(if (status == SoundcoreBusinessCallback.PAUSE_RECORD) "录音豆已暂停录音" else "录音豆已停止录音")
                }
            }
        }

        override fun onReceiveAudioFragment(macAddress: String, uuid: String, fileID: Int, audioData: ByteArray,
                                            isAppendPreAudio: Boolean, sequenceNumber: Int, isMark: Boolean) {
            sink?.onPacket(audioData, sequenceNumber, isMark)
        }

        override fun onGetDeviceInfoError(macAddress: String, uuid: String, errorCode: Int) {
            sink?.onStatus("读取录音豆状态失败（$errorCode），请重新连接")
        }

        override fun onDeviceTransferStateChanged(macAddress: String, uuid: String, state: DeviceTransferState) {
            Log.i(TAG, "transfer state $state")
        }

        override fun onBatteryInfoChanged(macAddress: String, uuid: String, deviceBattery: Int, chargingBoxBattery: Int) {
            if (deviceBattery in 0..1) sink?.onStatus("录音豆电量低（${deviceBattery * 10}%）")
        }

        // Not used by live capture.
        override fun onReceiveOfflineFile(macAddress: String, uuid: String, offlineFileData: OfflineFileData, isAllAudioFiles: Boolean) {}
        override fun onReceiveOfflineFileError(macAddress: String, uuid: String, errorCode: Int) {}
        override fun onAudioRecordDuration(macAddress: String, uuid: String, durationMs: Long) {}
        override fun onTransferFileStatusChanged(macAddress: String, uuid: String, fileID: Int, status: Int, markTimeStampList: ArrayList<Int>) {}
        override fun onDecodeFileCompleted(macAddress: String, uuid: String, fileID: Int, filePath: String) {}
        override fun onDecodeFileMarkers(macAddress: String, uuid: String, fileID: Int, markerTimes: IntArray) {}
        override fun onTransferFileError(macAddress: String, uuid: String, fileID: Int, errorType: FileTransferError) {}
        override fun onOtaError(macAddress: String, uuid: String, errorCode: Int) {}
        override fun onTransferFileSupplementProgress(macAddress: String, uuid: String, fileID: Int, total: Int, current: Int) {}
        override fun onTransferFileProgress(macAddress: String, uuid: String, fileID: Int, total: Int, current: Int, sequenceNumber: Int, isMark: Boolean) {}
        override fun onDeleteFileResult(macAddress: String, uuid: String, fileID: Int, isSuccess: Boolean) {}
        override fun onSendBindingDeviceCMDSuccess(macAddress: String, uuid: String) {}
        override fun onSendUnbindingDeviceCMDSuccess(macAddress: String, uuid: String) {}
        override fun onDeviceBindConfirm(macAddress: String, uuid: String) {}
        override fun onDeviceLogEnableCollectionResult(macAddress: String, uuid: String, success: Boolean) {}
        override fun onDeviceLogRequestListResult(macAddress: String, uuid: String, success: Boolean, code: Int, list: List<DeviceLogFileInfo>, more: Boolean) {}
        override fun onDeviceLogTransferResult(macAddress: String, uuid: String, success: Boolean, code: Int) {}
        override fun onDeviceLogDeleteResult(macAddress: String, uuid: String, success: Boolean) {}
        override fun onDeviceLogDumping(macAddress: String, uuid: String, done: Boolean, a: Int, b: Int, c: Int, d: Int, data: ByteArray) {}
        override fun onBindingDeviceError(macAddress: String, uuid: String, errorCode: Int) {}
        override fun onSyncTimeResult(macAddress: String, uuid: String, result: Boolean) {}
        override fun onDeviceChargingStatusChanged(macAddress: String, uuid: String, deviceChargingStatus: Int, chargingBoxChargingStatus: Int) {}
        override fun onResetDeviceResult(macAddress: String, uuid: String, result: Boolean) {}
        override fun onFindMyEnableResult(macAddress: String, uuid: String, success: Boolean) {}
        override fun onReceiveWaitingDeviceOpenWIFI(macAddress: String, uuid: String) {}
        override fun onWifiScanned(macAddress: String, uuid: String) {}
        override fun onConnectWIFIError(macAddress: String, uuid: String, errorCode: Int) {}
        override fun onConnectWIFIStatusChanged(macAddress: String, uuid: String, status: WifiState) {}
        override fun onCloseSyncFileByWIFI(macAddress: String, uuid: String) {}
        override fun onRealtimeTransferSwitch(macAddress: String, uuid: String, fileID: Int, filePath: String?) {}
        override fun onTransferFileTransmitting(macAddress: String, uuid: String, fileID: Int) {}
        override fun onConnectSPPLinkStatusChanged(macAddress: String, uuid: String, isConnect: Boolean) {}
    }

    private object SdkLog : LogInterface {
        override fun v(tag: String?, message: String?) { Log.v(tag ?: TAG, message.orEmpty()) }
        override fun d(tag: String?, message: String?) { Log.d(tag ?: TAG, message.orEmpty()) }
        override fun i(tag: String?, message: String?) { Log.i(tag ?: TAG, message.orEmpty()) }
        override fun w(tag: String?, message: String?) { Log.w(tag ?: TAG, message.orEmpty()) }
        override fun e(tag: String?, message: String?) { Log.e(tag ?: TAG, message.orEmpty()) }
    }

    private companion object {
        const val TAG = "OopsBean"
    }
}
