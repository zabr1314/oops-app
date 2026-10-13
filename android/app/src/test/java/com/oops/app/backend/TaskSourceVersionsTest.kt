package com.oops.app.backend

import org.junit.Assert.*
import org.junit.Test

class TaskSourceVersionsTest {
    @Test fun appendedSpeechAndUnrelatedIdentityAnswerDoNotCancelValidDraft() {
        val versions = TaskSourceVersions()
        val request = versions.ticket(listOf("task", "context"))
        versions.invalidate(setOf("new-unrelated-speaker"))
        assertTrue(versions.current(request))
    }
    @Test fun changingEitherSelectedQuoteOrContextRejectsLateCallback() {
        val versions = TaskSourceVersions()
        val request = versions.ticket(listOf("task", "context"))
        versions.invalidate(setOf("context"))
        assertFalse(versions.current(request))
        val refreshed = versions.ticket(listOf("task", "context"))
        versions.invalidate(setOf("task"))
        assertFalse(versions.current(refreshed))
    }
    @Test fun serviceResetExpiryOrNewSessionRejectsAllPriorSourceTickets() {
        val versions = TaskSourceVersions()
        val request = versions.ticket(listOf("task"))
        versions.invalidate(null)
        assertFalse(versions.current(request))
        assertTrue(versions.current(versions.ticket(listOf("task"))))
    }
}
