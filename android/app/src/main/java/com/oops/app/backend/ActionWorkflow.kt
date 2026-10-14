package com.oops.app.backend

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay

/** Submission and reconciliation share the same immutable request and operation id. */
object ActionWorkflow {
    /** Only a definite failure allows an explicit re-submit; unknown outcomes must be queried. */
    fun shouldSubmit(previous: ActionResult?) = previous == null || previous.status == ActionResult.FAILED &&
        !previous.sourceInvalidated && !previous.sourceBlocked && previous.errorCode != "SOURCE_CHANGED"

    fun restoredPending(result: ActionResult) = result.copy(polling = false, message = if (result.sourceBlocked)
        result.message ?: "来源已暂停写入，上次操作结果待核实；只能查询原操作" else "上次操作结果尚未确认，请继续查询")

    suspend fun execute(
        api: OopsApi,
        request: ConfirmRequest,
        submit: Boolean,
        maxPolls: Int = 10,
    ): ActionResult {
        fun checked(r: ActionResult): ActionResult {
            require(r.opId == request.opId) { "后端返回的操作编号不一致" }
            require(r.status in setOf(ActionResult.PENDING, ActionResult.CREATED, ActionResult.FAILED)) {
                "后端返回了未知状态"
            }
            if (r.status == ActionResult.CREATED) require(!r.taskGuid.isNullOrBlank()) { "后端缺少任务编号" }
            return r
        }
        var confirming = submit
        var lastKnown: ActionResult? = null
        return try {
            var result = checked(if (submit) api.confirmAction(request) else api.getAction(request.opId)).also { lastKnown = it }
            confirming = false
            if (result.status == ActionResult.PENDING && result.sourceBlocked) return result.copy(polling = false)
            repeat(maxPolls) {
                if (result.status == ActionResult.PENDING) {
                    delay(1_000)
                    result = checked(api.getAction(request.opId)).also { lastKnown = it }
                    if (result.status == ActionResult.PENDING && result.sourceBlocked) return result.copy(polling = false)
                }
            }
            if (result.status == ActionResult.CREATED) {
                val readBack = try {
                    checked(api.getAction(request.opId)).takeIf {
                        it.status == ActionResult.CREATED && it.taskGuid == result.taskGuid
                    }
                } catch (e: CancellationException) { throw e } catch (_: Exception) { null }
                (readBack ?: result).copy(readBackConfirmed = readBack != null, polling = false)
            } else if (result.status == ActionResult.PENDING) {
                result.copy(message = result.message?.takeIf { it.isNotBlank() }
                    ?: "后端仍在处理，请继续查询结果；不会重复提交", polling = false)
            } else result.copy(polling = false)
        } catch (e: CancellationException) {
            throw e
        } catch (e: ActionSourceRejected) {
            if (confirming) ActionResult(request.opId, ActionResult.FAILED,
                message = "原话来源已失效，本次没有创建飞书任务。请重新核对原话并起草；不要重试旧依据。",
                sourceInvalidated = true, errorCode = "SOURCE_CHANGED")
            else lastKnown?.takeIf { it.status == ActionResult.PENDING }?.copy(polling = false)
                ?: ActionResult(request.opId, ActionResult.PENDING, message = "原操作结果尚未核实，请继续查询原操作", polling = false)
        } catch (e: Exception) {
            // A lost HTTP response does not prove that the write failed.
            lastKnown?.takeIf { it.status == ActionResult.PENDING && !it.message.isNullOrBlank() }?.let {
                return it.copy(polling = false)
            }
            ActionResult(request.opId, ActionResult.PENDING,
                message = "结果尚未确认：${e.message ?: e.javaClass.simpleName}。请查询结果", polling = false)
        }
    }
}
