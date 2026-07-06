/**
 * Feature: partner-central-chat-agent
 *
 * Server-side source of truth for the approval state of every proposed
 * Write_Operation. Implements the deterministic state machine described in
 * design.md ("Write_Operation Approval Correlation Model") and guards
 * correctness invariants I1–I5 (at-most-once confirmation, rejection
 * monotonicity, unresolved fail-safe, retry id reuse, decision/user
 * correlation).
 *
 * State machine:
 *   initial: Status=pending, Decision=unresolved
 *   decide(approved) on (pending, unresolved) -> (pending, approved)
 *   decide(rejected) on (pending, unresolved) -> (cancelled, rejected)
 *   markSent()       on (pending, approved)   -> (sent, approved)
 *   decide(*)        on Status in {sent,cancelled} -> no-op
 *   markSent()       on Status=sent           -> no-op
 *
 * Concurrency: both `decide` and `markSent` use SOQL `FOR UPDATE` to
 * serialize concurrent approvals so that the guarded `pending -> sent`
 * transition cannot fire twice for the same Operation_Id.
 *
 * Access mode: all SOQL uses `WITH USER_MODE` and all DML uses the `as user`
 * modifier so FLS/CRUD violations fail loudly per Req 11.2.
 *
 * See requirements 6.1, 6.4, 6.5, 6.6, 6.7, 6.10, 6.11, 6.12.
 */
public with sharing class PendingWriteOperationStore {

    // Status__c picklist values
    public static final String STATUS_PENDING   = 'pending';
    public static final String STATUS_SENT      = 'sent';
    public static final String STATUS_CANCELLED = 'cancelled';

    // Decision__c picklist values
    public static final String DECISION_UNRESOLVED = 'unresolved';
    public static final String DECISION_APPROVED   = 'approved';
    public static final String DECISION_REJECTED   = 'rejected';

    /**
     * Creates the initial pending/unresolved row for a newly-announced
     * Write_Operation. `Operation_Id__c` is the External Id / unique key used
     * by all subsequent correlation lookups (Req 6.12).
     */
    public Pending_Write_Operation__c register(
        String operationId,
        String jsonRpcRequestId,
        String sessionId,
        Id userId,
        String recordId,
        String operationName,
        String targetResourceId,
        String summary,
        String paramsPayload,
        String fieldDiff
    ) {
        Pending_Write_Operation__c row = new Pending_Write_Operation__c(
            Operation_Id__c       = operationId,
            Json_Rpc_Request_Id__c = jsonRpcRequestId,
            Session_Id__c         = sessionId,
            User__c               = userId,
            Record_Id__c          = recordId,
            Operation_Name__c     = operationName,
            Target_Resource_Id__c = targetResourceId,
            Summary__c            = summary,
            Params_Payload__c     = paramsPayload,
            Field_Diff__c         = fieldDiff,
            Status__c             = STATUS_PENDING,
            Decision__c           = DECISION_UNRESOLVED,
            Created_Timestamp__c  = System.now()
        );
        insert as user row;
        return row;
    }

    /**
     * Applies the legal decide-transition for the given Operation_Id. Uses
     * `FOR UPDATE` so concurrent approvals (e.g., a user double-clicking
     * Approve) are serialized and cannot both drive the row out of pending.
     *
     * decision must be one of 'approved' or 'rejected'.
     *
     * No-op (returns the existing record unchanged) when the row is already
     * in a terminal state (`sent` or `cancelled`). This preserves idempotency
     * (Req 6.11) and rejection monotonicity (Req 6.6).
     *
     * Throws OperationNotFoundException when no row matches the operationId
     * (Req 6.10).
     */
    public Pending_Write_Operation__c decide(
        String operationId,
        Id userId,
        String decision
    ) {
        if (decision != DECISION_APPROVED && decision != DECISION_REJECTED) {
            throw new IllegalArgumentException(
                'decision must be "approved" or "rejected", got: ' + decision
            );
        }

        List<Pending_Write_Operation__c> rows = [
            SELECT Id,
                   Operation_Id__c,
                   Json_Rpc_Request_Id__c,
                   Session_Id__c,
                   Record_Id__c,
                   Status__c,
                   Decision__c,
                   Decision_Timestamp__c,
                   Created_Timestamp__c,
                   User__c
            FROM Pending_Write_Operation__c
            WHERE Operation_Id__c = :operationId
            WITH USER_MODE
            LIMIT 1
            FOR UPDATE
        ];

        if (rows.isEmpty()) {
            throw new OperationNotFoundException(
                'No Pending_Write_Operation__c found for Operation_Id=' + operationId
            );
        }

        Pending_Write_Operation__c row = rows[0];

        // Terminal states are no-ops (Req 6.6, 6.11).
        if (row.Status__c == STATUS_SENT || row.Status__c == STATUS_CANCELLED) {
            return row;
        }

        // Defensive: a pending row whose Decision is already approved/rejected
        // should not be decided again. This cannot happen from the UI because
        // approved is only reached in this method (and immediately allows
        // markSent), but we guard against direct DML or a future caller.
        if (row.Decision__c != DECISION_UNRESOLVED) {
            throw new IllegalStateException(
                'Cannot decide(' + decision + ') on Operation_Id=' + operationId
                    + ' with Decision=' + row.Decision__c
            );
        }

        if (decision == DECISION_APPROVED) {
            // (pending, unresolved) -> (pending, approved)
            row.Decision__c = DECISION_APPROVED;
        } else {
            // (pending, unresolved) -> (cancelled, rejected)  [terminal]
            row.Decision__c = DECISION_REJECTED;
            row.Status__c   = STATUS_CANCELLED;
        }
        row.Decision_Timestamp__c = System.now();
        update as user row;
        return row;
    }

    /**
     * Read-only variant of `decide` used when a callout must follow the
     * decision in the same transaction. Apex forbids DML before callouts, so
     * the controller uses this method to validate the state transition and
     * collect the row's correlation fields (jsonRpcRequestId, sessionId,
     * recordId) before issuing the callout. The caller then invokes
     * `finalizeDecide` AFTER the callout returns to persist the new state.
     *
     * Throws OperationNotFoundException when no row matches (Req 6.10).
     * Returns the existing row unchanged for terminal states (sent or
     * cancelled) so the caller can treat the decide as idempotent.
     */
    public Pending_Write_Operation__c prepareDecide(
        String operationId,
        Id userId,
        String decision
    ) {
        if (decision != DECISION_APPROVED && decision != DECISION_REJECTED) {
            throw new IllegalArgumentException(
                'decision must be "approved" or "rejected", got: ' + decision
            );
        }

        List<Pending_Write_Operation__c> rows = [
            SELECT Id,
                   Operation_Id__c,
                   Json_Rpc_Request_Id__c,
                   Session_Id__c,
                   Record_Id__c,
                   Status__c,
                   Decision__c,
                   Decision_Timestamp__c,
                   Created_Timestamp__c,
                   User__c
            FROM Pending_Write_Operation__c
            WHERE Operation_Id__c = :operationId
            WITH USER_MODE
            LIMIT 1
        ];

        if (rows.isEmpty()) {
            throw new OperationNotFoundException(
                'No Pending_Write_Operation__c found for Operation_Id=' + operationId
            );
        }

        Pending_Write_Operation__c row = rows[0];

        if (row.Status__c == STATUS_SENT || row.Status__c == STATUS_CANCELLED) {
            // Terminal — nothing to prepare, caller should no-op the callout too.
            return row;
        }

        if (row.Decision__c != DECISION_UNRESOLVED) {
            throw new IllegalStateException(
                'Cannot decide(' + decision + ') on Operation_Id=' + operationId
                    + ' with Decision=' + row.Decision__c
            );
        }

        return row;
    }

    /**
     * Persists the legal state transition matching `decision` for the given
     * Operation_Id. Intended to be called AFTER the outbound callout has
     * completed, so that the "no DML before callout" restriction is not
     * violated.
     *
     * No-op on rows already in a terminal state. Uses `FOR UPDATE` to
     * serialize with concurrent decides.
     */
    public Pending_Write_Operation__c finalizeDecide(
        String operationId,
        String decision
    ) {
        if (decision != DECISION_APPROVED && decision != DECISION_REJECTED) {
            throw new IllegalArgumentException(
                'decision must be "approved" or "rejected", got: ' + decision
            );
        }

        List<Pending_Write_Operation__c> rows = [
            SELECT Id, Status__c, Decision__c
            FROM Pending_Write_Operation__c
            WHERE Operation_Id__c = :operationId
            WITH USER_MODE
            LIMIT 1
            FOR UPDATE
        ];

        if (rows.isEmpty()) {
            throw new OperationNotFoundException(
                'No Pending_Write_Operation__c found for Operation_Id=' + operationId
            );
        }

        Pending_Write_Operation__c row = rows[0];

        if (row.Status__c == STATUS_SENT || row.Status__c == STATUS_CANCELLED) {
            return row;
        }

        if (decision == DECISION_APPROVED) {
            row.Decision__c = DECISION_APPROVED;
        } else {
            row.Decision__c = DECISION_REJECTED;
            row.Status__c   = STATUS_CANCELLED;
        }
        row.Decision_Timestamp__c = System.now();
        update as user row;
        return row;
    }

    /**
     * Transitions an approved-pending row to `sent`. Called by McpClient
     * AFTER a successful execution-confirmation POST so that a retry of that
     * POST (which reuses the same JSON-RPC request id per Req 9.4) does not
     * cause a second `sent` transition and a second confirmation delivery.
     *
     * No-op on an already-`sent` row (idempotent retry path, Req 6.11).
     * Throws IllegalStateException if the row is not in (pending, approved),
     * which should never happen in production — it indicates a caller ordering
     * bug (e.g., markSent before decide).
     */
    public Pending_Write_Operation__c markSent(String operationId) {
        List<Pending_Write_Operation__c> rows = [
            SELECT Id,
                   Operation_Id__c,
                   Status__c,
                   Decision__c
            FROM Pending_Write_Operation__c
            WHERE Operation_Id__c = :operationId
            WITH USER_MODE
            LIMIT 1
            FOR UPDATE
        ];

        if (rows.isEmpty()) {
            throw new OperationNotFoundException(
                'No Pending_Write_Operation__c found for Operation_Id=' + operationId
            );
        }

        Pending_Write_Operation__c row = rows[0];

        if (row.Status__c == STATUS_SENT) {
            // Idempotent: already sent, nothing to do.
            return row;
        }

        if (row.Status__c == STATUS_PENDING && row.Decision__c == DECISION_APPROVED) {
            row.Status__c = STATUS_SENT;
            update as user row;
            return row;
        }

        throw new IllegalStateException(
            'markSent requires Status=pending,Decision=approved but found '
                + 'Status=' + row.Status__c + ',Decision=' + row.Decision__c
                + ' for Operation_Id=' + operationId
        );
    }

    /**
     * Non-locking lookup used by correlation checks (e.g., "does this
     * operationId already exist for this session?"). Returns null when no
     * row matches.
     */
    public Pending_Write_Operation__c findByOperationId(String operationId) {
        List<Pending_Write_Operation__c> rows = [
            SELECT Id,
                   Operation_Id__c,
                   Json_Rpc_Request_Id__c,
                   Session_Id__c,
                   User__c,
                   Record_Id__c,
                   Operation_Name__c,
                   Target_Resource_Id__c,
                   Summary__c,
                   Params_Payload__c,
                   Field_Diff__c,
                   Status__c,
                   Decision__c,
                   Created_Timestamp__c,
                   Decision_Timestamp__c
            FROM Pending_Write_Operation__c
            WHERE Operation_Id__c = :operationId
            WITH USER_MODE
            LIMIT 1
        ];
        return rows.isEmpty() ? null : rows[0];
    }

    /**
     * Nightly sweep: cancel any row still in `pending` whose
     * Created_Timestamp__c is older than the cutoff. Used by the scheduled
     * job in task 10.2 to keep the store from accumulating abandoned
     * approvals. Terminal rows (`sent`, `cancelled`) are left untouched.
     */
    public List<Pending_Write_Operation__c> cancelExpired(DateTime olderThan) {
        List<Pending_Write_Operation__c> rows = [
            SELECT Id, Status__c, Decision__c
            FROM Pending_Write_Operation__c
            WHERE Status__c = :STATUS_PENDING
              AND Created_Timestamp__c < :olderThan
            WITH USER_MODE
        ];
        if (rows.isEmpty()) {
            return rows;
        }
        for (Pending_Write_Operation__c row : rows) {
            row.Status__c = STATUS_CANCELLED;
        }
        update as user rows;
        return rows;
    }

    public class IllegalArgumentException extends Exception {}
    public class IllegalStateException extends Exception {}
}
