package com.oops.app.backend

/** Dependency-specific requests survive unrelated appended speech and identity answers. */
class TaskSourceVersions {
    data class Ticket(val reset: Long, val sources: Map<String, Long>)
    private var reset = 0L
    private val versions = mutableMapOf<String, Long>()
    @Synchronized fun ticket(ids: Collection<String>) = Ticket(reset, ids.associateWith { versions[it] ?: 0L })
    @Synchronized fun current(ticket: Ticket) = ticket.reset == reset &&
        ticket.sources.all { (id, version) -> (versions[id] ?: 0L) == version }
    @Synchronized fun invalidate(ids: Set<String>?) {
        if (ids == null) { reset++; versions.clear() }
        else ids.forEach { versions[it] = (versions[it] ?: 0L) + 1L }
    }
}
