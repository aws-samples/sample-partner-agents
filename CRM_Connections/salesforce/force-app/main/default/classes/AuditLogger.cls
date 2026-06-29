/**
 * Feature: partner-central-chat-agent
 *
 * Writes `Audit_Log__c` rows for every MCP request/response pair and for
 * every Write_Operation approval decision. Implements Req 10.1, 10.2, 10.3,
 * 10.4, 6.13, and 13.3.
 *
 * Lifecycle of a single JSON-RPC call:
 *   1. Caller invokes `logRequest(...)` immediately before the callout and
 *      receives back the `Audit_Log__c.Id`.
 *   2. When the response arrives, the caller invokes `logResponse(auditId,
 *      httpStatus, sessionId, responseTimestamp)` to fill in the outcome.
 *   3. When a Write_Operation approval decision is recorded, the caller
 *      invokes `logApprovalDecision(operationId, ...)` which updates every
 *      Audit_Log__c row tagged with that Operation_Id (there may be
 *      multiple — one per request/response pair for that operation).
 *
 * Redaction: user Attachment bytes MUST NEVER be written to the audit log
 * (Req 10.3). Callers typically pre-redact by running their params map
 * through `AuditRedactor.redactParams(...)` and passing the result as
 * `paramsRedactedJson`. The convenience overload `logRequest(... Map
 * params)` handles redaction internally for callers that prefer to pass
 * the raw map.
 *
 * Access mode: DML uses `as user`; SOQL uses `WITH USER_MODE` so FLS/CRUD
 * violations fail loudly per Req 11.2, consistent with
 * `PendingWriteOperationStore` and `SessionManager`.
 */
public with sharing class AuditLogger {

    /**
     * Inserts a new `Audit_Log__c` row capturing the outgoing request and
     * returns its Id. The caller is responsible for passing an
     * already-redacted `paramsRedactedJson` (typically produced via
     * `AuditRedactor.redactParams`) so that raw Attachment bytes never
     * reach this method (Req 10.3).
     *
     * `operationId` is nullable: only Write_Operation-bearing requests
     * correlate to a Pending_Write_Operation__c, and the approval decision
     * update in `logApprovalDecision` relies on the non-null value.
     */
    public Id logRequest(
        Id userId,
        String recordId,
        String objectApiName,
        String mcpMethod,
        String sessionId,
        String jsonRpcRequestId,
        String paramsRedactedJson,
        String operationId,
        String endpointMode
    ) {
        Audit_Log__c row = new Audit_Log__c(
            User__c                     = userId,
            Record_Id__c                = recordId,
            Object_Api_Name__c          = objectApiName,
            Mcp_Method__c               = mcpMethod,
            Session_Id__c               = sessionId,
            Json_Rpc_Request_Id__c      = jsonRpcRequestId,
            Request_Params_Redacted__c  = paramsRedactedJson,
            Operation_Id__c             = operationId,
            Endpoint_Mode__c            = endpointMode,
            Request_Timestamp__c        = System.now()
        );
        insert as user row;
        return row.Id;
    }

    /**
     * Convenience overload: accepts a raw `params` map and runs it through
     * `AuditRedactor.redactParams` before persisting. Use this when the
     * caller has the deserialized params in hand and would otherwise need
     * to invoke the redactor itself.
     */
    public Id logRequest(
        Id userId,
        String recordId,
        String objectApiName,
        String mcpMethod,
        String sessionId,
        String jsonRpcRequestId,
        Map<String, Object> params,
        String operationId,
        String endpointMode
    ) {
        String redacted = AuditRedactor.redactParams(params);
        return logRequest(
            userId,
            recordId,
            objectApiName,
            mcpMethod,
            sessionId,
            jsonRpcRequestId,
            redacted,
            operationId,
            endpointMode
        );
    }

    /**
     * Updates the request-phase audit row with response metadata (Req 10.2).
     * `sessionId` is only persisted when non-blank so a later call with a
     * null/blank value does not clobber a session id captured at request
     * time. `responseTimestamp` defaults to `System.now()` when null.
     */
    public void logResponse(
        Id auditLogId,
        Integer httpStatus,
        String sessionId,
        DateTime responseTimestamp
    ) {
        logResponse(auditLogId, httpStatus, sessionId, responseTimestamp, null);
    }

    /**
     * Overload that also persists a redacted response body on the audit
     * row. Used by the MCP_Client so operators can inspect what the MCP
     * server actually returned when diagnosing production incidents
     * (unknown method names, upstream JSON-RPC error objects, SSE shapes
     * we do not recognize). The `responseBodyRedacted` value is
     * truncated to the field length (131072) if necessary.
     */
    public void logResponse(
        Id auditLogId,
        Integer httpStatus,
        String sessionId,
        DateTime responseTimestamp,
        String responseBodyRedacted
    ) {
        Audit_Log__c row = new Audit_Log__c(
            Id                    = auditLogId,
            Http_Status__c        = httpStatus,
            Response_Timestamp__c = responseTimestamp != null ? responseTimestamp : System.now()
        );
        if (String.isNotBlank(sessionId)) {
            row.Session_Id__c = sessionId;
        }
        if (responseBodyRedacted != null) {
            row.Response_Body_Redacted__c = responseBodyRedacted.length() > 131072
                ? responseBodyRedacted.substring(0, 131072)
                : responseBodyRedacted;
        }
        update as user row;
    }

    /**
     * Stamps every Audit_Log__c row bearing the given Operation_Id with the
     * approval decision, deciding user, and decision timestamp (Req 10.4,
     * 6.13). There may be multiple matching rows — one per request/response
     * pair for that Write_Operation — and all are updated atomically.
     *
     * `approvalTimestamp` defaults to `System.now()` when null. No-op
     * (silent) when no rows match: the decision may be for an operation
     * that was never requested (e.g., a stale correlation).
     */
    public void logApprovalDecision(
        String operationId,
        String approvalDecision,
        Id approvalUserId,
        DateTime approvalTimestamp
    ) {
        List<Audit_Log__c> rows = [
            SELECT Id
            FROM Audit_Log__c
            WHERE Operation_Id__c = :operationId
            WITH USER_MODE
        ];
        if (rows.isEmpty()) {
            return;
        }
        DateTime stamp = approvalTimestamp != null ? approvalTimestamp : System.now();
        for (Audit_Log__c row : rows) {
            row.Approval_Decision__c  = approvalDecision;
            row.Approval_User__c      = approvalUserId;
            row.Approval_Timestamp__c = stamp;
        }
        update as user rows;
    }
}
