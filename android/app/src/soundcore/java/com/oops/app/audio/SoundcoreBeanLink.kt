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
import com.oops.app.store.BeanCaptureContract
import com.oops.app.store.BeanScratchStore
import java.io.File
import java.util.Timer
import java.util.TimerTask

/**
 * The real 录音豆 (Soundcore D3200) through the Anker SDK. Built only when the SDK sits in
 * `android/app/libs/soundcore/` (see app/build.gradle.kts); [BeanSdk] finds it by name.
 *
 * Flow per the SDK document: init + auth → scan → connect → device info → wait until the device itself
 * is recording (the SDK cannot start it) → acquireRealtimeAudioData → onReceiveAudioFragment packets.
 * Untested against hardware: no device was available when this was written (2026-10-12).
 */
class SoundcoreBeanLink(private val context: Context, private val auth: BeanAuth, private val contract: BeanCaptureContract) : BeanLink {
    override val label = "录音豆"

    private val sdk = SoundcoreSDK.Companion.proxy
    @Volatile private var sink: BeanLink.Sink? = null
    @Volatile private var device: BlueDeviceModel? = null
    @Volatile private var streaming = false
    @Volatile private var started = false
    private var used = false
    private var stoppingCommands = false
    private var disconnectAcknowledged = false
    private val lifecycle = Any()
    @Volatile private var lease: BeanScratchStore.Lease? = null
    private var expiryTimer: Timer? = null

    override fun start(sink: BeanLink.Sink) {
        synchronized(lifecycle) {
            check(!used) { "此录音豆连接已使用，请重新开始" }
            // This happens before init/auth/scan, so the SDK cannot create a daily full-session copy.
            lease = BeanScratchStore(File(context.filesDir, BeanScratchStore.DIRECTORY)).begin(contract)
            used = true
            this.sink = sink
            streaming = false
            started = true
        }
        sink.onConnected(false)
        sink.onStatus("录音豆鉴权中")
        val config = SDKInitConfig(
            context.applicationContext, auth.userId, auth.deviceId, auth.token, auth.licenseJson, auth.licenseSignature,
            if (auth.production) SDKEnvironment.PRODUCTION else SDKEnvironment.DEVELOPMENT,
            false, null, 3L, 200L, false, 100L, true,
        )
        try {
            synchronized(lifecycle) {
                if (!started) return
                sdk.initSDK(SdkLog, config, object : OnAuthResultListener {
                    override fun onAuthResult(result: AuthResult) {
                        if (!accepting()) return
                        if (result.success) scan()
                        else failLink(IllegalStateException("录音豆鉴权失败：${result.error?.message ?: "未知原因"}（${result.error?.code}）"))
                    }
                })
                if (accepting()) sdk.registerBusinessCallback(callback)
                if (started) expiryTimer = Timer("oops-bean-retention", true).apply {
                    scheduleAtFixedRate(object : TimerTask() {
                        override fun run() {
                            if (lease?.expired() == true) failLink(IllegalStateException("本场录音保留期已到，录音豆传输已停止"))
                        }
                    }, 500L, 500L)
                }
            }
        } catch (error: Throwable) {
            runCatching { stop() }.onFailure { error.addSuppressed(it) }
            throw error
        }
    }

    override fun stop() {
        val d: BlueDeviceModel?
        val wasStreaming: Boolean
        synchronized(lifecycle) {
            // A repeated stop or a late timer must never operate the singleton SDK after a new capture owns it.
            if (lease == null || stoppingCommands) return
            stoppingCommands = true
            started = false
            sink = null
            lease?.markStopping()
            expiryTimer?.cancel(); expiryTimer = null
            d = device
            wasStreaming = streaming
            streaming = false
        }
        try {
            val scanError = runCatching { sdk.stopScan() }.exceptionOrNull()
            if (d != null) {
                // Do not unlink files while the SDK may still have them open. The disconnect callback finishes cleanup.
                try {
                    if (wasStreaming) sdk.pauseRecord(d.macAddress!!, d.uuid!!)
                } finally {
                    sdk.disconnect(d.macAddress!!, d.uuid!!)
                }
            } else {
                synchronized(lifecycle) { disconnectAcknowledged = true } // no device or stream was opened
            }
            if (scanError != null) throw scanError
        } finally {
            synchronized(lifecycle) {
                stoppingCommands = false
                // A synchronous callback during pause/disconnect must not release the global lease before
                // the rest of these old SDK commands have completed.
                if (disconnectAcknowledged) finishStopped()
            }
        }
    }

    private fun accepting(mac: String? = null, uuid: String? = null): Boolean {
        if (!started || lease?.accepting != true) return false
        if (lease?.expired() == true) {
            failLink(IllegalStateException("本场录音保留期已到，录音豆传输已停止"))
            return false
        }
        val d = device
        return (mac == null || d?.macAddress == mac) && (uuid == null || d?.uuid == uuid)
    }

    private fun finishStopped() = synchronized(lifecycle) {
        lease?.finishStopped() // failure leaves the process lease blocked; a new session cannot bypass it
        lease = null
        device = null
    }

    private fun failLink(error: Throwable) {
        val target = sink ?: return
        runCatching { stop() }.onFailure { error.addSuppressed(it) }
        target.onError(error)
    }

    private fun scan() {
        synchronized(lifecycle) {
            if (!accepting()) return
            sink?.onStatus("正在寻找录音豆，请打开录音豆并靠近手机")
            sdk.startScan(true, true, ArrayList(), object : OnReceiveScanResult {
                override fun onScanSuccess(device: BlueDeviceModel) {
                    synchronized(lifecycle) {
                        if (!accepting()) return
                        if (this@SoundcoreBeanLink.device != null || device.macAddress == null || device.uuid == null) return
                        if (auth.macAddress.isNotEmpty() && !device.macAddress.equals(auth.macAddress, ignoreCase = true)) return
                        this@SoundcoreBeanLink.device = device
                        try {
                            sdk.stopScan()
                            connect(device)
                        } catch (error: Throwable) { failLink(error) }
                    }
                }

                override fun onScanError(result: Int) {
                    if (!accepting()) return
                    sink?.onStatus(when (result) {
                        1 -> "没有找到录音豆，请确认已开机并靠近手机"
                        3 -> "正在扫描中"
                        else -> "扫描中断（$result）"
                    })
                }
            })
        }
    }

    private fun connect(d: BlueDeviceModel) {
        if (!accepting(d.macAddress, d.uuid)) return
        sink?.onStatus("正在连接 ${d.deviceName ?: "录音豆"}")
        sdk.connect(d.macAddress!!, d.uuid!!, object : SoundcoreConnectionCallback {
            override fun onConnected(macAddress: String?, deviceName: String?) {
                synchronized(lifecycle) {
                    if (!accepting(d.macAddress, d.uuid)) {
                        // Once our disconnect was acknowledged a new capture may own this singleton SDK.
                        // A late callback from this old link must not disconnect that newer capture.
                        if (lease != null) runCatching { stop() }.onFailure { BeanSdk.reportScratchFailure(it) }
                        return
                    }
                    sdk.getDeviceInfo(d.macAddress!!, d.uuid!!)
                }
            }

            override fun onDisconnected(macAddress: String?, systemCode: Int?, systemMsg: String?) {
                if (macAddress != null && macAddress != d.macAddress) return
                val target = sink
                synchronized(lifecycle) {
                    started = false
                    streaming = false
                    lease?.markStopping()
                    expiryTimer?.cancel(); expiryTimer = null
                    sink = null
                    disconnectAcknowledged = true
                }
                val cleanup = runCatching { synchronized(lifecycle) { if (!stoppingCommands) finishStopped() } }
                cleanup.onFailure {
                    BeanSdk.reportScratchFailure(it)
                    target?.onError(IllegalStateException("录音豆临时副本清理失败，后续接入已阻止", it))
                }
                streaming = false
                target?.onConnected(false)
                target?.onStatus(if (cleanup.isSuccess) "录音豆已断开${systemMsg?.let { "（$it）" } ?: ""}"
                    else "录音豆临时副本清理失败，后续接入已阻止")
            }

            override fun onError(macAddress: String?, exception: SdkException) {
                if (accepting()) failLink(IllegalStateException("录音豆连接失败：${exception.message}（${exception.code}）"))
            }
        })
    }

    private fun startStreaming(d: BlueDeviceModel) {
        try {
            synchronized(lifecycle) {
                if (streaming || !accepting(d.macAddress, d.uuid)) return
                streaming = true
                // The only SDK output directory is this capture's managed, non-archive scratch lease.
                sdk.acquireRealtimeAudioData(d.macAddress!!, d.uuid!!, requireNotNull(lease).folder.absolutePath)
            }
            sink?.onStatus(null)
        } catch (error: Throwable) { failLink(error) }
    }

    private val callback = object : SoundcoreBusinessCallback {
        override fun onGetDeviceInfo(macAddress: String, uuid: String, info: DeviceInfo) {
            if (!accepting(macAddress, uuid)) return
            val d = device ?: return
            if (info.recording == 1) startStreaming(d) else sink?.onStatus("请按录音豆上的录音键开始录音")
        }

        override fun onAudioRecordStatusChanged(macAddress: String, uuid: String, status: Int, recordingDuration: Int, fileID: Int) {
            if (!accepting(macAddress, uuid)) return
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
            if (!accepting(macAddress, uuid)) return
            sink?.onPacket(audioData, sequenceNumber, isMark)
        }

        override fun onGetDeviceInfoError(macAddress: String, uuid: String, errorCode: Int) {
            if (!accepting(macAddress, uuid)) return
            sink?.onStatus("读取录音豆状态失败（$errorCode），请重新连接")
        }

        override fun onDeviceTransferStateChanged(macAddress: String, uuid: String, state: DeviceTransferState) {
            Log.i(TAG, "transfer state $state")
        }

        override fun onBatteryInfoChanged(macAddress: String, uuid: String, deviceBattery: Int, chargingBoxBattery: Int) {
            if (!accepting(macAddress, uuid)) return
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
