package com.oops.app.engine

import com.oops.app.store.RecordingPolicy

/** A pause carries the existing recording contract; it cannot authorize a new session or service. */
data class CapturePauseGuard(val sessionId: String, val serviceEpoch: Long, val source: String,
                             val policy: RecordingPolicy, val ticket: Long) {
    init { require(sessionId.isNotBlank() && supported(source)) { "这个音源尚不支持暂停，请结束本次记录" } }

    fun verifyResume(session: String, epoch: Long, currentPolicy: RecordingPolicy, draining: Boolean) {
        check(!draining) { "正在处理暂停前的最后转写，请稍候再恢复" }
        check(session == sessionId && epoch == serviceEpoch && policy == currentPolicy) { "记录来源或保存方式已变化，请结束本次记录" }
    }

    companion object {
        // File/replay inputs restart from zero; the bean SDK needs a separate verified pause contract.
        fun supported(source: String): Boolean = source == "mic"
    }
}
