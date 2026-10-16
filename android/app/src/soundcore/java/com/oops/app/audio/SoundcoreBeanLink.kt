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
 * User-confirmed capture: init + auth → scan → connect → device info → if idle, try the public
 * resumeRecord once → wait for RECORDING → acquireRealtimeAudioData → real audio packets.
 * Hardware validation status is recorded in docs/bean-device-check-20261016.md.
 */
class SoundcoreBeanLink(private val context: Context, private val auth: BeanAuth, private val contract: BeanCaptureContract) : BeanLink {
    override val label = "录音豆"

    private val sdk = SoundcoreSDK.Companion.proxy
    private val preferences = context.getSharedPreferences("oops_settings", Context.MODE_PRIVATE)
    // Android's BLE alias can change after disconnect. Once selected, match the
    // permanent address from the SDK advertisement instead of a bootstrap alias.
    private val preferredAddress = preferences.getString("bean_device_mac", "").orEmpty().ifBlank { auth.macAddress }
    @Volatile private var sink: BeanLink.Sink? = null
    @Volatile private var device: BlueDeviceModel? = null
    @Volatile private var streaming = false
    @Volatile private var started = false
    private var used = false
    private var stoppingCommands = false
    private var disconnectAcknowledged = false
    private var receivedPacket = false
    private var authenticated = false
    private var audioRequested = false
    private var initialDeviceInfoHandled = false
    private var startCommandIssued = false
    private var connectionEpoch = 0L
    private var connectionStartedAt = 0L
    private var connectionEstablished = false
    private var connectionRecoveries = 0
    private var reconnectTask: TimerTask? = null
    private var recoveryTarget: String? = null
    private var startupDeadlineAt = 0L
    private var startupOverallDeadlineAt = 0L
    private var startupTimeoutMessage: String? = null
    override val supportsPause = true
    private var controlState = "waiting"
    private var hardwarePaused = false
    private var transferActive = false
    private var controlDeadline: TimerTask? = null
    private var lastPacketAt = 0L
    private val seenCandidates = mutableSetOf<String>()
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
            startupOverallDeadlineAt = System.nanoTime() / 1_000_000 + 60_000L
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
                expiryTimer = Timer("oops-bean-retention", true).apply {
                    scheduleAtFixedRate(object : TimerTask() {
                        override fun run() = synchronized(lifecycle) {
                            if (!accepting()) return@synchronized
                            val now = System.nanoTime() / 1_000_000
                            val timeout = startupTimeoutMessage
                            if (timeout != null && now >= startupOverallDeadlineAt) {
                                failLink(IllegalStateException("录音豆连接与启动超过60秒，已停止本次尝试，请确认设备状态后重试"))
                            } else if (timeout != null && now >= startupDeadlineAt) {
                                failLink(IllegalStateException(timeout))
                            } else if (controlState == "draining" && now - lastPacketAt >= 1_500L) {
                                pausedAfterTail(quiet = true)
                            }
                        }
                    }, 500L, 500L)
                }
                startupDeadline("录音豆鉴权超时，请检查网络或更新设备授权", 20_000L)
                sdk.initSDK(SdkLog, config, object : OnAuthResultListener {
                    override fun onAuthResult(result: AuthResult) {
                        synchronized(lifecycle) {
                            if (!accepting()) return
                            if (result.success) {
                                // The SDK can report cached-license success and then online success.
                                // Both belong to this initialization; scanning must start only once.
                                if (authenticated) return
                                authenticated = true
                                Log.i(TAG, "SDK authenticated")
                                sdk.registerBusinessCallback(callback)
                                scan()
                            } else {
                                failLink(IllegalStateException("录音豆鉴权失败（${result.error?.code ?: "未知"}），请检查网络或更新设备授权"))
                            }
                        }
                    }
                })
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
            wasStreaming = startCommandIssued || streaming || controlState in listOf("recording", "resuming", "pausing")
            startupTimeoutMessage = null
            reconnectTask?.cancel(); reconnectTask = null
            controlDeadline?.cancel(); controlDeadline = null
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

    override fun pause() = command(paused = true)
    override fun resume() = command(paused = false)
    override fun confirmAudioReady() = synchronized(lifecycle) {
        if (accepting()) startupTimeoutMessage = null
    }

    private fun startupDeadline(message: String, timeoutMs: Long) {
        startupTimeoutMessage = message
        startupDeadlineAt = System.nanoTime() / 1_000_000 + timeoutMs
    }

    private fun startFromApp(d: BlueDeviceModel) {
        // This link exists only after the user starts a cloud-confirmed meeting.
        // One attempt per link; duplicate info/auth callbacks never repeat the command.
        startCommandIssued = true
        control("resuming")
        sink?.onStatus("正在启动录音豆，等待设备确认和音频")
        startupDeadline("录音豆未确认启动或未传回音频，已结束本次连接；可按硬件录音键后重新开始", 15_000L)
        try {
            sdk.resumeRecord(d.macAddress!!, d.uuid!!)
            Log.i(TAG, "SDK initial resume requested")
        } catch (error: Throwable) {
            failLink(IllegalStateException("录音豆启动指令失败，请重新开始或使用硬件录音键", error))
        }
    }

    private fun command(paused: Boolean) = synchronized(lifecycle) {
        check(accepting()) { "录音豆连接已关闭" }
        val d = checkNotNull(device) { "录音豆尚未连接" }
        check(controlState !in listOf("pausing", "draining", "resuming")) { "正在等待设备确认，请稍候" }
        check(controlState in listOf("recording", "paused", "unknown")) { "设备尚未开始录音，暂不能暂停或继续" }
        if (paused && controlState == "paused" || !paused && controlState == "recording") return@synchronized
        val pending = if (paused) "pausing" else "resuming"
        control(pending)
        sink?.onStatus(if (paused) "正在暂停录音豆，等待尾音传完" else "正在恢复录音豆")
        controlDeadline?.cancel()
        controlDeadline = object : TimerTask() {
            override fun run() = synchronized(lifecycle) {
                if (accepting() && controlState == pending) {
                    control("unknown")
                    sink?.onControlError(if (paused) "暂停未得到设备确认，可重试或结束记录" else "继续未得到设备确认，可重试或结束记录")
                }
            }
        }.also { requireNotNull(expiryTimer).schedule(it, 12_000L) }
        try {
            if (paused) sdk.pauseRecord(d.macAddress!!, d.uuid!!) else sdk.resumeRecord(d.macAddress!!, d.uuid!!)
            Log.i(TAG, "SDK ${if (paused) "pause" else "resume"} requested")
        } catch (error: Throwable) {
            controlDeadline?.cancel(); controlDeadline = null
            control("unknown")
            sink?.onControlError("录音控制失败，请重试：${error.message}")
        }
    }

    private fun control(state: String) {
        if (controlState == state) return
        controlState = state
        if (state == "paused") { controlDeadline?.cancel(); controlDeadline = null }
        Log.i(TAG, "SDK control=$state")
        sink?.onControlState(state)
    }

    private fun pausedAfterTail(quiet: Boolean = false) {
        // Firmware reports PAUSE_RECORD but does not consistently emit transfer IDLE.
        // Keep the writer/connection lease; a quiet tail only closes the ASR segment.
        if (hardwarePaused && controlState in listOf("pausing", "draining", "paused") && (!transferActive || quiet)) {
            streaming = false
            sink?.onStatus("录音豆已暂停，蓝牙保持连接")
            control("paused")
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

    private fun recoverConnection(d: BlueDeviceModel, exception: SdkException): Boolean {
        // V1.3.02's 15 s connect timeout closes/nulls the GATT before reporting -102 without
        // a system code. Never retry an established link, an unknown command, or audio startup.
        if (exception.code != -102 || exception.systemCode != null || connectionEstablished ||
            audioRequested || startCommandIssued || connectionRecoveries != 0 ||
            System.nanoTime() / 1_000_000 - connectionStartedAt < 14_500L) return false
        connectionRecoveries++
        connectionEpoch++ // fence both onError/onDisconnected from the old connection
        recoveryTarget = d.macAddress
        device = null
        disconnectAcknowledged = true // the SDK's known pre-link timeout has closed its GATT
        sink?.onStatus("录音豆首次连接超时，正在重新寻找并连接（1/1）")
        Log.i(TAG, "SDK pre-link timeout; one fresh-scan recovery scheduled")
        startupDeadline("录音豆重新连接准备超时，请确认设备已开机后重试", 5_000L)
        reconnectTask = object : TimerTask() {
            override fun run() = synchronized(lifecycle) {
                reconnectTask = null
                if (!accepting()) return@synchronized
                try {
                    // Leave the SDK timeout callback stack first: it clears currentDevice after
                    // notifying us. No reentrant connect may be overwritten by that old cleanup.
                    sdk.stopScan()
                    // Keep the same SDK device/dispatcher. close() only deletes the registry;
                    // recreating it here does not reset the underlying transport's listeners.
                    sdk.registerBusinessCallback(callback)
                    scan()
                } catch (error: Throwable) { failLink(error) }
            }
        }.also { requireNotNull(expiryTimer).schedule(it, 800L) }
        return true
    }

    private fun scan() {
        synchronized(lifecycle) {
            if (!accepting()) return
            sink?.onStatus(if (connectionRecoveries == 0) "正在寻找录音豆，请打开录音豆并靠近手机"
                else "正在重新寻找录音豆（1/1）")
            startupDeadline("未找到已选录音豆，请确认设备已开机并靠近手机，断开其他应用的设备连接后重试",
                if (connectionRecoveries == 0) 32_000L else 12_000L)
            // Realtime capture connects over BLE. Classic discovery adds a second radio search
            // and can delay BLE discovery/connection; SPP is only needed for offline file transfer.
            Log.i(TAG, "SDK scan mode=BLE_ONLY")
            sdk.startScan(true, false, ArrayList(), object : OnReceiveScanResult {
                override fun onScanSuccess(device: BlueDeviceModel) {
                    synchronized(lifecycle) {
                        if (!accepting()) return
                        if (this@SoundcoreBeanLink.device != null || device.macAddress == null || device.uuid == null) return
                        val selected = if (recoveryTarget != null) device.macAddress.equals(recoveryTarget, ignoreCase = true) else preferredAddress.isEmpty() ||
                            device.macAddress.equals(preferredAddress, ignoreCase = true) ||
                            device.sppMacAddress.equals(preferredAddress, ignoreCase = true)
                        if (seenCandidates.add("${device.macAddress}:${device.sppMacAddress}")) {
                            Log.i(TAG, "SDK candidate selected=$selected signal=${device.rssi} device=${device.macAddress?.takeLast(5)} alias=${device.sppMacAddress?.takeLast(5)}")
                        }
                        if (!selected) return
                        this@SoundcoreBeanLink.device = device
                        Log.i(TAG, "SDK discovered recording bean")
                        try {
                            sdk.stopScan()
                            connect(device)
                        } catch (error: Throwable) { failLink(error) }
                    }
                }

                override fun onScanError(result: Int) {
                    if (!accepting()) return
                    if (result == 2 && (this@SoundcoreBeanLink.device != null || reconnectTask != null)) return // our stop
                    Log.i(TAG, "SDK scan result=$result")
                    if (result == 1) {
                        failLink(IllegalStateException("未找到已选录音豆，请确认设备已开机并靠近手机，断开其他应用的设备连接后重试"))
                        return
                    }
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
        val epoch = ++connectionEpoch
        connectionStartedAt = System.nanoTime() / 1_000_000
        connectionEstablished = false
        disconnectAcknowledged = false
        sink?.onStatus("正在连接 ${d.deviceName ?: "录音豆"}${if (connectionRecoveries > 0) "（重连1/1）" else ""}")
        startupDeadline("录音豆连接超时，请确认设备已开机、未被其他应用占用后重试", 35_000L)
        sdk.connect(d.macAddress!!, d.uuid!!, object : SoundcoreConnectionCallback {
            override fun onConnected(macAddress: String?, deviceName: String?) {
                synchronized(lifecycle) {
                    if (epoch != connectionEpoch) return
                    if (!accepting(d.macAddress, d.uuid)) {
                        // Once our disconnect was acknowledged a new capture may own this singleton SDK.
                        // A late callback from this old link must not disconnect that newer capture.
                        if (lease != null) runCatching { stop() }.onFailure { BeanSdk.reportScratchFailure(it) }
                        return
                    }
                    Log.i(TAG, "SDK device connected")
                    connectionEstablished = true
                    // Persist the selected device's permanent address, rather than an Android BLE alias.
                    preferences.edit().putString("bean_device_mac", d.macAddress).apply()
                    sink?.onStatus("录音豆已连接，正在读取设备状态")
                    startupDeadline("读取录音豆状态超时，请重新连接", 12_000L)
                    sdk.syncTime(d.macAddress!!, d.uuid!!, (System.currentTimeMillis() / 1_000).toUInt())
                    sdk.getDeviceInfo(d.macAddress!!, d.uuid!!)
                }
            }

            override fun onDisconnected(macAddress: String?, systemCode: Int?, systemMsg: String?) {
                val target = synchronized(lifecycle) {
                    if (epoch != connectionEpoch || macAddress != null && macAddress != d.macAddress) return
                    val target = sink
                    started = false
                    streaming = false
                    lease?.markStopping()
                    expiryTimer?.cancel(); expiryTimer = null
                    sink = null
                    disconnectAcknowledged = true
                    connectionEpoch++
                    target
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
                if (cleanup.isSuccess) target?.onError(IllegalStateException("录音豆连接已断开，请重新连接"))
            }

            override fun onError(macAddress: String?, exception: SdkException) {
                synchronized(lifecycle) {
                    if (epoch != connectionEpoch || !accepting()) return
                    Log.i(TAG, "SDK connection error code=${exception.code} system=${exception.systemCode} established=$connectionEstablished recovery=$connectionRecoveries")
                    if (recoverConnection(d, exception)) return
                    // A failed connection before requesting audio has no SDK file writer.
                    // The SDK closes that failed GATT link without an onDisconnected callback.
                    if (!audioRequested) disconnectAcknowledged = true
                    failLink(IllegalStateException("录音豆连接失败（${exception.code}），请确认设备已开机、未被其他应用占用后重试"))
                }
            }
        })
    }

    private fun startStreaming(d: BlueDeviceModel) {
        try {
            synchronized(lifecycle) {
                if (streaming || !accepting(d.macAddress, d.uuid)) return
                streaming = true
                audioRequested = true
                // The only SDK output directory is this capture's managed, non-archive scratch lease.
                sdk.acquireRealtimeAudioData(d.macAddress!!, d.uuid!!, requireNotNull(lease).folder.absolutePath)
                Log.i(TAG, "SDK realtime audio requested")
            }
            sink?.onStatus(null)
        } catch (error: Throwable) { failLink(error) }
    }

    private val callback = object : SoundcoreBusinessCallback {
        override fun onGetDeviceInfo(macAddress: String, uuid: String, info: DeviceInfo) {
            synchronized(lifecycle) {
                if (!accepting(macAddress, uuid) || initialDeviceInfoHandled) return
                val d = device ?: return
                initialDeviceInfoHandled = true
                Log.i(TAG, "SDK device recording=${info.recording}")
                when (info.recording) {
                    1 -> {
                        startupDeadline("录音豆正在录音但没有传回音频，请重新连接", 15_000L)
                        startStreaming(d)
                    }
                    0 -> startFromApp(d)
                    else -> failLink(IllegalStateException("无法确认录音豆当前录音状态，请重新连接"))
                }
            }
        }

        override fun onAudioRecordStatusChanged(macAddress: String, uuid: String, status: Int, recordingDuration: Int, fileID: Int) {
            synchronized(lifecycle) {
                if (!accepting(macAddress, uuid)) return
                val d = device ?: return
                Log.i(TAG, "SDK recording status=$status")
                when (status) {
                    SoundcoreBusinessCallback.RECORDING -> {
                        hardwarePaused = false
                        if (controlState !in listOf("pausing", "recording")) control("resuming")
                        startStreaming(d)
                    }
                    SoundcoreBusinessCallback.PAUSE_RECORD -> {
                        hardwarePaused = true
                        controlDeadline?.cancel(); controlDeadline = null
                        lastPacketAt = System.nanoTime() / 1_000_000
                        control("draining")
                        sink?.onStatus("录音豆已暂停，正在接收剩余音频")
                        pausedAfterTail()
                    }
                    else -> {
                        controlDeadline?.cancel(); controlDeadline = null
                        streaming = false
                        control("stopped")
                        sink?.onStatus("录音豆已停止，请按硬件录音键开始新录音")
                    }
                }
            }
        }

        override fun onReceiveAudioFragment(macAddress: String, uuid: String, fileID: Int, audioData: ByteArray,
                                            isAppendPreAudio: Boolean, sequenceNumber: Int, isMark: Boolean) {
            if (!accepting(macAddress, uuid)) return
            if (!receivedPacket) {
                receivedPacket = true
                Log.i(TAG, "SDK first audio packet bytes=${audioData.size} sequence=$sequenceNumber")
            }
            synchronized(lifecycle) {
                lastPacketAt = System.nanoTime() / 1_000_000
                if (hardwarePaused && controlState == "paused") control("draining")
                if (controlState in listOf("resuming", "waiting", "unknown")) {
                    controlDeadline?.cancel(); controlDeadline = null
                    Log.i(TAG, "SDK resumed audio packet sequence=$sequenceNumber")
                    // Remain 'resuming' in UI until the decoder delivers real PCM.
                    controlState = "recording"
                }
            }
            sink?.onPacket(audioData, sequenceNumber, isMark)
        }

        override fun onGetDeviceInfoError(macAddress: String, uuid: String, errorCode: Int) {
            if (!accepting(macAddress, uuid)) return
            failLink(IllegalStateException("读取录音豆状态失败（$errorCode），请重新连接"))
        }

        override fun onDeviceTransferStateChanged(macAddress: String, uuid: String, state: DeviceTransferState) {
            synchronized(lifecycle) {
                if (!accepting(macAddress, uuid)) return
                Log.i(TAG, "transfer state $state")
                transferActive = state == DeviceTransferState.REALTIME_TRANSFERRING
                if (state == DeviceTransferState.IDLE) pausedAfterTail()
            }
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
        // SDK debug output includes auth request bodies. Status/errors are reported through
        // typed callbacks above; never forward vendor log bodies to device-wide logcat.
        override fun v(tag: String?, message: String?) {}
        override fun d(tag: String?, message: String?) {}
        override fun i(tag: String?, message: String?) {}
        override fun w(tag: String?, message: String?) {}
        override fun e(tag: String?, message: String?) { Log.e(TAG, "SDK error; see connection status") }
    }

    private companion object {
        const val TAG = "OopsBean"
    }
}
