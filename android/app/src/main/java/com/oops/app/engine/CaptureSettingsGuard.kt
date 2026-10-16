package com.oops.app.engine

/** Preflight only: callers run this before persisting any member of a settings request. */
object CaptureSettingsGuard {
    fun verify(capturing: Boolean, paused: Boolean, finishing: Boolean, serviceChanged: Boolean, sourceChanged: Boolean) {
        check(!(capturing || paused || finishing) || !serviceChanged) {
            "请先明确结束当前记录并等待转写收尾，再修改服务地址、访问凭据或测试服务开关"
        }
        check(!paused || !sourceChanged) { "当前记录已暂停，请先恢复或结束后再切换音源" }
    }
}
