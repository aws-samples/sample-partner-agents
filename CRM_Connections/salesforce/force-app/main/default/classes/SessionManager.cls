/**
 * Feature: partner-central-chat-agent
 *
 * Owns the lifecycle of `Chat_Session__c` rows: load/create, persist the
 * MCP-returned Session_ID, append transcript entries, tombstone on
 * "Start new conversation", and discard on MCP session-expired errors.
 *
 * A session is scoped to a (User, Record_Id) tuple and is considered
 * "active" while `Is_Active__c = true` and `Last_Activity__c` falls inside
 * the configured retention window (Req 5.3). Only the most recent active
 * row is restored; older rows are left in place for audit but will not be
 * resurfaced.
 *
 * Access mode: all SOQL uses `WITH USER_MODE` and all DML uses the
 * `as user` modifier so FLS/CRUD violations fail loudly per Req 11.2,
 * consistent with `PendingWriteOperationStore`.
 *
 * See requirements 5.1, 5.2, 5.3, 5.4, 5.5.
 */
public with sharing class SessionManager {

    private static final String ENDPOINT_MODE_SANDBOX    = 'sandbox';
    private static final String ENDPOINT_MODE_PRODUCTION = 'production';

    // Catalog values used by the MCP server; kept in lockstep with
    // `ChatAgentController.CATALOG_AWS` / `CATALOG_SANDBOX`. The
    // server partitions session ids by catalog, so reusing an
    // `AWS`-catalog session id on a `Sandbox` turn (or vice versa)
    // raises `ResourceNotFoundException: Session not found in
    // catalog '...'`. `findActiveSession` accepts an optional
    // catalog to guarantee the returned row matches the intended
    // environment.
    private static final String CATALOG_AWS     = 'AWS';
    private static final String CATALOG_SANDBOX = 'Sandbox';

    /**
     * Returns the most recent active session for (userId, recordId) that
     * falls inside the configured retention window, or creates a new one
     * when no such session exists.
     */
    public Chat_Session__c loadOrCreateSession(Id userId, String recordId) {
        return loadOrCreateSession(userId, recordId, null);
    }

    /**
     * Catalog-aware overload. When `catalog` is provided, a session is
     * reused only if its `Endpoint_Mode__c` matches the catalog; a
     * mismatch forces a fresh row so the next turn gets a brand-new MCP
     * session id in the correct catalog. See class header for the
     * cross-catalog pitfall this guards against.
     */
    public Chat_Session__c loadOrCreateSession(Id userId, String recordId, String catalog) {
        Integer retentionMinutes = ConfigProvider.getSessionRetentionMinutes();
        Chat_Session__c existing = findActiveSession(
            userId, recordId, retentionMinutes, catalog
        );
        if (existing != null) {
            return existing;
        }
        Chat_Session__c row = new Chat_Session__c(
            User__c          = userId,
            Record_Id__c     = recordId,
            Last_Activity__c = System.now(),
            Endpoint_Mode__c = endpointModeFor(catalog),
            Is_Active__c     = true
        );
        insert as user row;
        return row;
    }

    /**
     * Translates an MCP catalog value (`AWS` / `Sandbox`) to the
     * `Chat_Session__c.Endpoint_Mode__c` picklist. Falls back to the
     * config-driven default when the caller did not pin the catalog,
     * preserving prior behavior.
     */
    @TestVisible
    private static String endpointModeFor(String catalog) {
        if (String.isNotBlank(catalog)) {
            if (catalog == CATALOG_SANDBOX) {
                return ENDPOINT_MODE_SANDBOX;
            }
            if (catalog == CATALOG_AWS) {
                return ENDPOINT_MODE_PRODUCTION;
            }
        }
        return ConfigProvider.isSandbox()
            ? ENDPOINT_MODE_SANDBOX
            : ENDPOINT_MODE_PRODUCTION;
    }

    /**
     * Finds the most recent active `Chat_Session__c` for the given
     * (userId, recordId) whose `Last_Activity__c` is within the retention
     * window. Returns null when no such row exists. Used both internally by
     * `loadOrCreateSession` and by the controller to restore a prior
     * transcript on record page reopen (Req 5.3).
     */
    public Chat_Session__c findActiveSession(
        Id userId,
        String recordId,
        Integer retentionWindowMinutes
    ) {
        return findActiveSession(userId, recordId, retentionWindowMinutes, null);
    }

    /**
     * Catalog-aware overload. When `catalog` is provided, only sessions
     * whose `Endpoint_Mode__c` matches the intended catalog are
     * returned. A mismatched-but-still-fresh session is ignored (not
     * tombstoned — we leave the audit trail intact; the next turn just
     * creates a new row). This prevents the server-side
     * `ResourceNotFoundException: Session not found in catalog '...'`
     * that occurs when an `AWS` session id is replayed into a
     * `Sandbox` turn (or vice versa).
     */
    public Chat_Session__c findActiveSession(
        Id userId,
        String recordId,
        Integer retentionWindowMinutes,
        String catalog
    ) {
        // A non-positive retention window means "no sessions are active"; this
        // is both a safety default and a fast path for an admin who wants to
        // disable session restoration entirely.
        if (retentionWindowMinutes == null || retentionWindowMinutes <= 0) {
            return null;
        }
        DateTime cutoff = System.now().addMinutes(-retentionWindowMinutes);
        List<Chat_Session__c> rows = [
            SELECT Id,
                   User__c,
                   Record_Id__c,
                   Session_Id__c,
                   Last_Activity__c,
                   Endpoint_Mode__c,
                   Transcript_Json__c,
                   Is_Active__c
            FROM Chat_Session__c
            WHERE User__c = :userId
              AND Record_Id__c = :recordId
              AND Is_Active__c = true
              AND Last_Activity__c >= :cutoff
            WITH USER_MODE
            ORDER BY Last_Activity__c DESC
            LIMIT 1
        ];
        if (rows.isEmpty()) {
            return null;
        }
        Chat_Session__c row = rows[0];
        if (String.isNotBlank(catalog)) {
            String expected = endpointModeFor(catalog);
            if (row.Endpoint_Mode__c != expected) {
                // Catalog mismatch: the stored session id belongs to a
                // different MCP catalog and cannot be replayed. Return
                // null so the caller creates a fresh row.
                return null;
            }
        }
        return row;
    }

    /**
     * Stores the MCP-returned Session_ID on the Chat_Session__c row so
     * subsequent turns in the same conversation carry it (Req 5.1, 5.2).
     * Also bumps `Last_Activity__c` so the session remains within the
     * retention window.
     */
    public void persistSessionId(Id chatSessionId, String mcpSessionId) {
        Chat_Session__c row = new Chat_Session__c(
            Id               = chatSessionId,
            Session_Id__c    = mcpSessionId,
            Last_Activity__c = System.now()
        );
        update as user row;
    }

    /**
     * Appends a TranscriptEntryDto to the session's `Transcript_Json__c`.
     * The field is a Long Text Area holding a serialized
     * `List<TranscriptEntryDto>`; the list is empty when the field is
     * null/blank (first turn). `Last_Activity__c` is bumped so the session
     * stays active across multi-turn exchanges.
     */
    public void appendTranscript(Id chatSessionId, TranscriptEntryDto entry) {
        List<Chat_Session__c> rows = [
            SELECT Id, Transcript_Json__c
            FROM Chat_Session__c
            WHERE Id = :chatSessionId
            WITH USER_MODE
            LIMIT 1
        ];
        if (rows.isEmpty()) {
            return;
        }
        Chat_Session__c row = rows[0];
        List<TranscriptEntryDto> entries;
        if (String.isBlank(row.Transcript_Json__c)) {
            entries = new List<TranscriptEntryDto>();
        } else {
            entries = (List<TranscriptEntryDto>) JSON.deserialize(
                row.Transcript_Json__c,
                List<TranscriptEntryDto>.class
            );
        }
        entries.add(entry);
        row.Transcript_Json__c = JSON.serialize(entries);
        row.Last_Activity__c = System.now();
        update as user row;
    }

    /**
     * "Start new conversation" path (Req 5.4): marks the session inactive
     * so it will not be restored on the next record-page open. The
     * transcript and Session_ID are preserved for audit; a fresh
     * Chat_Session__c will be created on the next user turn.
     */
    public void tombstone(Id chatSessionId) {
        Chat_Session__c row = new Chat_Session__c(
            Id           = chatSessionId,
            Is_Active__c = false
        );
        update as user row;
    }

    /**
     * MCP session-expired path (Req 5.5): marks the session inactive AND
     * clears `Session_Id__c` so the next user turn starts a fresh MCP
     * session rather than replaying the expired one. Transcript is
     * preserved so the user can see their prior conversation.
     */
    public void discardOnExpiry(Id chatSessionId) {
        Chat_Session__c row = new Chat_Session__c(
            Id            = chatSessionId,
            Is_Active__c  = false,
            Session_Id__c = null
        );
        update as user row;
    }
}
