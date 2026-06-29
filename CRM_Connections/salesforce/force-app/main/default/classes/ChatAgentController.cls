/**
 * Feature: partner-central-chat-agent
 *
 * The single `@AuraEnabled` entry point used by the `chatAgent` LWC.
 *
 * Every method follows the same contract:
 *   1. `PermissionGate.assertHasAccess()` — fail-closed per Req 11.1 / 11.2.
 *   2. Do the real work inside a try/catch block.
 *   3. On any thrown exception, map it through `toError(...)` so the LWC
 *      receives a structured `ChatAgentResult` with a canonical `errorCode`
 *      rather than a raw platform exception. Raw exceptions would show up in
 *      the LWC as `AuraHandledException: Internal Server Error` and lose
 *      the information the UI needs for its error banner (Req 7.5).
 *
 * Collaborators (`McpClient`, `SessionManager`, `PendingWriteOperationStore`,
 * `AuditLogger`) are instantiated inline — the controller does not own any
 * state. Unit tests rely on `Test.setMock` for HTTP and on existing test
 * seams on the collaborators rather than on injection here.
 *
 * Exception -> errorCode mapping (see task brief #5):
 *   AccessDeniedException        -> ACCESS_DENIED
 *   ChatAgentConfigException     -> CONFIG_ERROR
 *   AuthenticationException      -> AUTH_ERROR
 *   ClientException              -> CLIENT_ERROR
 *   RetryableException           -> RETRYABLE
 *   TimeoutException             -> TIMEOUT
 *   OperationNotFoundException   -> OPERATION_NOT_FOUND
 *   anything else                -> UNKNOWN
 * Attachment validation failures never throw — they short-circuit with
 * errorCode='ATTACHMENT_INVALID'.
 *
 * See requirements 1.2, 1.4, 1.5, 2.1, 2.4, 3.1, 3.2, 5.1, 5.2, 5.3, 5.4,
 * 6.4, 6.5, 6.6, 6.10, 6.11, 6.13, 7.1, 7.2, 7.3, 7.4, 7.5, 8.1, 8.2, 8.3,
 * 8.4, 9.1, 9.4, 10.1, 10.4, 11.1, 11.2, 12.1, 12.3, 13.2.
 */
public with sharing class ChatAgentController {

    // Canonical error codes used by this controller (kept local so callers
    // see the exact taxonomy the task brief specifies, not the broader
    // `ChatAgentResult.ERROR_*` vocabulary).
    private static final String ERR_ACCESS_DENIED        = 'ACCESS_DENIED';
    private static final String ERR_CONFIG_ERROR         = 'CONFIG_ERROR';
    private static final String ERR_ATTACHMENT_INVALID   = 'ATTACHMENT_INVALID';
    private static final String ERR_AUTH_ERROR           = 'AUTH_ERROR';
    private static final String ERR_CLIENT_ERROR         = 'CLIENT_ERROR';
    private static final String ERR_RETRYABLE            = 'RETRYABLE';
    private static final String ERR_TIMEOUT              = 'TIMEOUT';
    private static final String ERR_OPERATION_NOT_FOUND  = 'OPERATION_NOT_FOUND';
    private static final String ERR_INVALID_DECISION     = 'INVALID_DECISION';
    private static final String ERR_UNKNOWN              = 'UNKNOWN';

    // Decision picklist values accepted by `decideOperation`.
    private static final String DECISION_APPROVED = 'approved';
    private static final String DECISION_REJECTED = 'rejected';

    // Catalog values accepted by the MCP `sendMessage` tool. Per
    // https://docs.aws.amazon.com/partner-central/latest/APIReference/mcp-configuration-reference.html
    // the valid values are `AWS` (production) and `Sandbox` (isolated
    // testing). We expose both so the LWC can let the user toggle per
    // turn; the default falls back to `Chat_Agent_Config__mdt.Is_Sandbox__c`.
    private static final String CATALOG_AWS     = 'AWS';
    private static final String CATALOG_SANDBOX = 'Sandbox';

    // Maximum attachments per message, per the MCP server's documented
    // file-upload limit (3 files/message).
    private static final Integer MAX_FILES_PER_MESSAGE = 3;

    // Known API names for AWS Partner Central Opportunity objects. We check
    // a small set of candidate field names because the AWS Partner CRM
    // Connector has shipped slightly different schemas across releases; the
    // first field we find via describe wins. Both the bare and the
    // `awsapn__` managed-package namespaced forms are recognized so the
    // feature works whether the connector is installed with or without its
    // namespace prefix active on the org.
    private static final Set<String> AWS_OPPORTUNITY_OBJECTS = new Set<String>{
        'AWS_Opportunity__c',
        'ACE_Opportunity__c',
        'awsapn__AWS_Opportunity__c',
        'awsapn__ACE_Opportunity__c'
    };
    private static final List<String> PARTNER_CENTRAL_ID_FIELD_CANDIDATES = new List<String>{
        // Canonical field on the AWS Partner CRM Connector's managed package:
        // the "APN CRM unique identifier" external id shown in Setup.
        'awsapn__APN_CRM_Id__c',
        'APN_CRM_Id__c',
        'Partner_Central_Opportunity_Id__c',
        'Partner_Central_Opportunity_ID__c',
        'PartnerCentralOpportunityId__c',
        'awsapn__Partner_Central_Opportunity_Id__c'
    };

    // -----------------------------------------------------------------
    // submitMessage
    // -----------------------------------------------------------------

    /**
     * Entry point for a new user turn. Validates attachments, loads/creates
     * the session, builds the JSON-RPC request, and invokes
     * `McpClient.invokeStreaming`. The LWC subscribes to
     * `Chat_Stream_Event__e` keyed on the returned `transcriptEntryId` to
     * render the streamed response.
     *
     * This MUST remain the only `submitMessage` signature. The Lightning
     * framework picks non-deterministically between overloaded
     * `@AuraEnabled` methods and can mismarshal complex parameters (a
     * `List<AttachmentDto>` arrives as non-null objects with null fields),
     * which surfaced as `Attachment "null" has no MIME type` from the LWC.
     * See the Salesforce LWC guide, "Call Apex Methods". Callers that don't
     * need a per-call catalog override pass `null` for `catalog`.
     *
     * `catalog` is optional and takes `"AWS"` or `"Sandbox"` per the MCP
     * tool's input schema. When null or blank, the controller falls back
     * to the `Chat_Agent_Config__mdt.Is_Sandbox__c` flag so admins can
     * keep the env flag working without a per-call override (Req 13.1).
     */
    @AuraEnabled
    public static ChatAgentResult submitMessage(
        String recordId,
        String objectApiName,
        String messageText,
        List<AttachmentDto> attachments,
        String catalog
    ) {
        try {
            PermissionGate.assertHasAccess();
            // Touch the config first so a misconfigured org fails closed with
            // CONFIG_ERROR before we emit anything to the MCP server (Req 12.3).
            List<String> allowedMimeTypes = ConfigProvider.getAllowedMimeTypes();
            Integer maxSize = (Integer) ConfigProvider.getMaxAttachmentSizeBytes();

            // Pre-validate every attachment. Any violation short-circuits with
            // ATTACHMENT_INVALID and issues zero callouts (Req 7.3).
            if (attachments != null && !attachments.isEmpty()) {
                if (attachments.size() > MAX_FILES_PER_MESSAGE) {
                    return toError(
                        ERR_ATTACHMENT_INVALID,
                        'A message may include at most ' + MAX_FILES_PER_MESSAGE
                            + ' files, but ' + attachments.size() + ' were provided.'
                    );
                }
                for (AttachmentDto att : attachments) {
                    ValidationResult vr = AttachmentValidator.validate(att, allowedMimeTypes, maxSize);
                    if (vr == null || vr.ok != true) {
                        String msg = vr == null
                            ? 'Attachment validation returned null.'
                            : vr.message;
                        return toError(ERR_ATTACHMENT_INVALID, msg);
                    }
                }
            }

            Id userId = UserInfo.getUserId();

            // Resolve the effective catalog up front so both the MCP
            // request and the session lookup use the same value. Without
            // this, a user who toggled Sandbox→AWS mid-conversation would
            // get the prior turn's Sandbox session id reused against the
            // AWS catalog and the server would answer
            // `ResourceNotFoundException: Session not found in catalog 'AWS'`.
            String effectiveCatalog = resolveCatalog(catalog);

            // Read-only lookup for an existing session so we can reuse its
            // MCP Session_ID. We cannot insert/update Chat_Session__c before
            // the callout (Apex forbids DML-before-callout). Session
            // persistence happens AFTER the callout returns in
            // McpClient.invokeStreaming's terminal-event path.
            SessionManager sessionManager = new SessionManager();
            Integer retentionMinutes = ConfigProvider.getSessionRetentionMinutes();
            Chat_Session__c existingSession =
                sessionManager.findActiveSession(
                    userId, recordId, retentionMinutes, effectiveCatalog
                );
            String existingMcpSessionId =
                (existingSession != null) ? existingSession.Session_Id__c : null;

            // Fresh ids for this turn. transcriptEntryId goes to the LWC so it
            // can subscribe to the matching stream events; jsonRpcRequestId
            // goes to the MCP server so the entire turn is correlatable end to
            // end (and is reused verbatim on a retry per Req 9.4).
            String transcriptEntryId = newId();
            String jsonRpcRequestId  = newId();

            // Record context. `recordName` is best-effort — if the running
            // user lacks FLS on Name or the object has no Name field we fall
            // back to null rather than fail the whole turn.
            String recordName = tryReadRecordName(recordId, objectApiName);
            String partnerCentralOpportunityId =
                tryReadPartnerCentralOpportunityId(recordId, objectApiName);

            // Inline the record context into the user's message text so the
            // agent knows which opportunity the question is about. The AWS
            // Partner Central MCP Server's `sendMessage` tool does not have
            // a structured context/metadata parameter — conversational
            // context flows via the natural-language content blocks. We
            // prepend a concise "Context:" preamble only when a Partner
            // Central opportunity id was resolved, so off-opportunity chats
            // (utility bar, non-APN records) remain untouched.
            String effectiveMessageText = messageText;
            if (String.isNotBlank(partnerCentralOpportunityId)) {
                effectiveMessageText =
                    'Context: Partner Central opportunity '
                        + partnerCentralOpportunityId
                        + (String.isNotBlank(recordName) ? ' (' + recordName + ')' : '')
                        + '.\n\n' + messageText;
            }

            // Build the MCP sendMessage content blocks per
            // https://docs.aws.amazon.com/partner-central/latest/APIReference/mcp-tools-reference.html.
            // `content` is an array of typed blocks: one text block plus one
            // `document` block per attachment. Each attachment is uploaded to
            // the Partner Central ephemeral S3 bucket first (a callout, no
            // DML) and referenced by its versioned `s3Uri` (Req 7.4). The
            // uploads run before the sendMessage callout and perform no DML,
            // so the no-DML-before-callout rule still holds.
            McpClient mcp = new McpClient();
            List<Object> contentBlocks = new List<Object>();
            contentBlocks.add(new Map<String, Object>{
                'type' => 'text',
                'text' => effectiveMessageText
            });
            if (attachments != null) {
                for (AttachmentDto att : attachments) {
                    String s3Uri = mcp.uploadAttachmentToS3(att);
                    contentBlocks.add(new Map<String, Object>{
                        'type'     => 'document',
                        'filename' => att.fileName,
                        's3Uri'    => s3Uri
                    });
                }
            }

            Map<String, Object> sendMessageArgs = new Map<String, Object>{
                'content' => contentBlocks,
                'catalog' => effectiveCatalog
            };
            if (String.isNotBlank(existingMcpSessionId)) {
                // AWS session ids are prefixed `session-` per the docs;
                // we persist whatever the server returned and echo it back
                // verbatim so no reformatting is needed here.
                sendMessageArgs.put('sessionId', existingMcpSessionId);
            }

            // Per the MCP protocol
            // (https://modelcontextprotocol.io/specification/2025-03-26/server/tools),
            // tools are invoked via the standard JSON-RPC method
            // `tools/call` with `params.name` set to the tool name and
            // `params.arguments` carrying the tool's input.
            Map<String, Object> toolsCallParams = new Map<String, Object>{
                'name'      => McpClient.TOOL_SEND_MESSAGE,
                'arguments' => sendMessageArgs
            };

            JsonRpcRequest req = new JsonRpcRequest(
                jsonRpcRequestId,
                McpClient.METHOD_TOOLS_CALL,
                toolsCallParams
            );

            // Hand off to the streaming transport. `operationId` is null on
            // the initial request — it is assigned when an SSE frame
            // announces a pendingOperation inside `invokeStreaming`. We
            // wrap in try/finally so a missing Chat_Session__c row gets
            // created even when the callout fails — otherwise the LWC's
            // retry path (Req 9.1) would have no session to resume from
            // when the user hits Retry.
            //
            // `invokeStreaming` publishes the events on the Platform Event
            // bus AND returns them inline. The inline list lets the LWC
            // render immediately without racing against CometD subscription
            // timing (the LWC subscribes after this method returns, which
            // would otherwise miss the already-published events).
            List<Chat_Stream_Event__e> inlineEvents = null;
            String capturedMcpSessionId = null;
            try {
                inlineEvents = mcp.invokeStreaming(
                    req,
                    transcriptEntryId,
                    userId,
                    recordId,
                    objectApiName,
                    null
                );
                // Harvest the server-returned MCP session id from the audit
                // log (McpClient stamps it there before returning) so we
                // can persist it onto the Chat_Session__c row for reuse on
                // follow-up turns. Reading from the audit row keeps the
                // session id as the single source of truth.
                capturedMcpSessionId = lookupMostRecentMcpSessionId(jsonRpcRequestId);
            } finally {
                // Post-callout DML is safe because the callout (success or
                // failure) has already occurred in this transaction.
                Chat_Session__c session = existingSession;
                try {
                    if (session == null) {
                        session = sessionManager.loadOrCreateSession(
                            userId, recordId, effectiveCatalog
                        );
                    }
                } catch (Exception ignored) {
                    // A failure to persist the session should not mask the
                    // original callout outcome — we propagate it below
                    // through the catch block in submitMessage.
                }
                // Persist the MCP session id so follow-up turns (including
                // approval POSTs) resume the same conversation per Req 5.1.
                if (session != null && session.Id != null
                    && String.isNotBlank(capturedMcpSessionId)) {
                    try {
                        sessionManager.persistSessionId(session.Id, capturedMcpSessionId);
                    } catch (Exception ignored) {
                        // Best-effort; next turn will create a new MCP
                        // session rather than reuse this one.
                    }
                }
            }

            // Success envelope. `payload` carries the ordered stream events
            // so the LWC can render the assistant response without relying
            // on a race-prone CometD subscription. The LWC still subscribes
            // to the Platform Event channel so genuine out-of-band events
            // (e.g., from a concurrent retry) are not lost, but it no
            // longer needs to for the synchronous turn's output.
            List<Map<String, Object>> serialisedEvents = new List<Map<String, Object>>();
            if (inlineEvents != null) {
                for (Chat_Stream_Event__e e : inlineEvents) {
                    serialisedEvents.add(new Map<String, Object>{
                        'transcriptEntryId' => e.Transcript_Entry_Id__c,
                        'sequence'          => e.Sequence__c,
                        'eventType'         => e.Event_Type__c,
                        'data'              => e.Data__c,
                        'isTerminal'        => e.Is_Terminal__c
                    });
                }
            }
            return ChatAgentResult.success(
                transcriptEntryId,
                new Map<String, Object>{ 'events' => serialisedEvents }
            );
        } catch (Exception e) {
            return mapException(e);
        }
    }

    // -----------------------------------------------------------------
    // decideOperation
    // -----------------------------------------------------------------

    /**
     * Applies the user's approval decision for a pending write operation.
     * Drives the `PendingWriteOperationStore` state machine, invokes the
     * matching MCP callout, stamps the approval decision onto every
     * correlated Audit_Log__c row (Req 6.13, 10.4, Invariant I5), and
     * returns the server's follow-up events inline so the LWC can render
     * the agent's response without racing against CometD subscription.
     *
     * This MUST remain the only `decideOperation` signature. Overloaded
     * `@AuraEnabled` methods are resolved non-deterministically by the
     * Lightning framework (see the LWC guide, "Call Apex Methods"), so a
     * second arity would risk the Approve/Reject card intermittently
     * binding to the wrong method. Callers that don't need a per-call
     * catalog override pass `null` for `catalog`.
     *
     * `catalog` is optional and takes `"AWS"` or `"Sandbox"` per the MCP
     * tool's input schema. Must match the catalog of the session id the
     * original turn created — crossing catalogs raises the server's
     * `ResourceNotFoundException: Session not found in catalog ...`
     * error. When null or blank, falls back to `isSandbox()` config.
     */
    @AuraEnabled
    public static ChatAgentResult decideOperation(
        String operationId,
        String decision,
        String catalog
    ) {
        try {
            PermissionGate.assertHasAccess();
            // Guard against out-of-band values at the controller boundary so
            // the store's IllegalArgumentException never reaches the LWC.
            if (decision != DECISION_APPROVED && decision != DECISION_REJECTED) {
                return toError(
                    ERR_INVALID_DECISION,
                    'decision must be "approved" or "rejected" but was ' + decision
                );
            }

            Id userId = UserInfo.getUserId();
            PendingWriteOperationStore pendingStore = new PendingWriteOperationStore();

            // Phase 1 (pre-callout): read-only validation of the transition.
            // We do NOT commit the decision here because Apex forbids DML
            // before a callout. The DML that records the decision happens
            // after sendExecutionConfirmation / sendRejection returns.
            Pending_Write_Operation__c row =
                pendingStore.prepareDecide(operationId, userId, decision);

            // Short-circuit for terminal states: the row has already been
            // committed by a prior call, so emit no callout and no new DML.
            if (row.Status__c == PendingWriteOperationStore.STATUS_SENT
                || row.Status__c == PendingWriteOperationStore.STATUS_CANCELLED) {
                return ChatAgentResult.success(null, row.Decision__c);
            }

            String effectiveCatalog = resolveCatalog(catalog);
            McpClient mcp = new McpClient();
            JsonRpcResponse mcpResp;
            if (decision == DECISION_APPROVED) {
                mcpResp = mcp.sendExecutionConfirmation(
                    row.Json_Rpc_Request_Id__c,
                    row.Operation_Id__c,
                    row.Session_Id__c,
                    userId,
                    row.Record_Id__c,
                    null,
                    effectiveCatalog
                );
            } else {
                mcpResp = mcp.sendRejection(
                    row.Json_Rpc_Request_Id__c,
                    row.Operation_Id__c,
                    row.Session_Id__c,
                    userId,
                    row.Record_Id__c,
                    null,
                    effectiveCatalog
                );
            }

            // If the MCP server returned a JSON-RPC error object (e.g.
            // Session-not-found, enum validation, etc.), surface it to
            // the LWC as a structured failure so the user sees the real
            // reason rather than a misleading "Approved and sent".
            if (mcpResp != null && mcpResp.error != null) {
                String errMsg = mcpResp.error.message != null
                    ? 'MCP error ' + mcpResp.error.code + ': ' + mcpResp.error.message
                    : 'MCP returned JSON-RPC error code ' + mcpResp.error.code;
                // Stamp the attempted decision onto the audit trail even
                // on failure so operators can see what the user tried.
                new AuditLogger().logApprovalDecision(
                    operationId, decision, userId, System.now()
                );
                return toError(ChatAgentResult.ERROR_JSON_RPC, errMsg);
            }

            // Phase 2 (post-callout): DML is now permitted. Finalize the
            // decide state transition, then for approvals advance the row
            // to `sent` via `markSent()` so Property 4 / Invariant I1
            // (at-most-once confirmation) still holds.
            pendingStore.finalizeDecide(operationId, decision);
            if (decision == DECISION_APPROVED) {
                pendingStore.markSent(operationId);
            }

            // Stamp the approval onto every correlated Audit_Log__c row in
            // the same transaction as the decide (Invariant I5, Req 10.4).
            new AuditLogger().logApprovalDecision(
                operationId,
                decision,
                userId,
                System.now()
            );

            // Harvest the assistant narrative from the follow-up MCP
            // response so the LWC can render the agent's reply inline
            // (the chat-completion text after the tool ran). We reuse
            // the same extractors the streaming path uses.
            String assistantText = mcp.extractAssistantText(mcpResp);
            List<Map<String, Object>> followupApprovals =
                mcp.extractApprovalRequests(mcpResp);

            List<Map<String, Object>> serialisedEvents = new List<Map<String, Object>>();
            if (String.isNotBlank(assistantText)) {
                serialisedEvents.add(new Map<String, Object>{
                    'eventType'  => 'message',
                    'data'       => assistantText,
                    'isTerminal' => false
                });
            }
            // Chained approvals: the agent may require a second approval
            // after the first tool runs (e.g. multi-step workflows).
            for (Map<String, Object> block : followupApprovals) {
                ApprovalPromptDto prompt = null;
                try {
                    prompt = mcp.registerMcpApprovalRequest(
                        block, row.Json_Rpc_Request_Id__c,
                        row.Session_Id__c, userId, row.Record_Id__c,
                        assistantText
                    );
                } catch (Exception ignored) {
                    // Best-effort; a malformed follow-up approval block
                    // shouldn't hide the primary approval's success.
                }
                if (prompt != null) {
                    serialisedEvents.add(new Map<String, Object>{
                        'eventType'  => 'approval_request',
                        'data'       => JSON.serialize(prompt),
                        'isTerminal' => false
                    });
                }
            }
            serialisedEvents.add(new Map<String, Object>{
                'eventType'  => 'done',
                'data'       => '',
                'isTerminal' => true
            });

            return ChatAgentResult.success(
                null,
                new Map<String, Object>{
                    'decision' => decision,
                    'events'   => serialisedEvents
                }
            );
        } catch (Exception e) {
            return mapException(e);
        }
    }

    // -----------------------------------------------------------------
    // startNewSession
    // -----------------------------------------------------------------

    /**
     * "Start new conversation" (Req 5.4). Marks any active session on the
     * given record inactive and returns an empty transcript so the LWC can
     * render a fresh conversation. Transcript and MCP Session_Id are
     * preserved on the tombstoned row for audit.
     */
    @AuraEnabled
    public static ChatAgentResult startNewSession(String recordId) {
        try {
            PermissionGate.assertHasAccess();
            SessionManager sessionManager = new SessionManager();
            Chat_Session__c existing = sessionManager.findActiveSession(
                UserInfo.getUserId(),
                recordId,
                ConfigProvider.getSessionRetentionMinutes()
            );
            if (existing != null) {
                sessionManager.tombstone(existing.Id);
            }
            TranscriptDto empty = TranscriptDto.empty(
                recordId,
                null,
                ConfigProvider.isSandbox()
            );
            return ChatAgentResult.success(null, empty);
        } catch (Exception e) {
            return mapException(e);
        }
    }

    // -----------------------------------------------------------------
    // restoreTranscript
    // -----------------------------------------------------------------

    /**
     * Rehydrates the prior transcript on record page reopen (Req 5.3).
     * Returns a `TranscriptDto` directly — not wrapped in `ChatAgentResult`
     * — because the LWC treats a missing transcript as an empty state, not
     * as an error. On any exception we return an empty transcript so the
     * LWC falls back to the empty-state view rather than blocking the user.
     */
    @AuraEnabled
    public static TranscriptDto restoreTranscript(String recordId) {
        try {
            PermissionGate.assertHasAccess();
            SessionManager sessionManager = new SessionManager();
            Chat_Session__c session = sessionManager.findActiveSession(
                UserInfo.getUserId(),
                recordId,
                ConfigProvider.getSessionRetentionMinutes()
            );
            if (session == null) {
                return new TranscriptDto();
            }
            List<TranscriptEntryDto> entries;
            if (String.isBlank(session.Transcript_Json__c)) {
                entries = new List<TranscriptEntryDto>();
            } else {
                entries = (List<TranscriptEntryDto>) JSON.deserialize(
                    session.Transcript_Json__c,
                    List<TranscriptEntryDto>.class
                );
            }
            TranscriptDto dto = new TranscriptDto();
            dto.sessionId     = session.Session_Id__c;
            dto.recordId      = session.Record_Id__c;
            dto.objectApiName = null; // Chat_Session__c does not persist objectApiName
            dto.isSandbox     = ConfigProvider.isSandbox();
            dto.entries       = entries;
            return dto;
        } catch (Exception e) {
            // Empty DTO is the safe fallback: the LWC will render the empty
            // state and let the user start a new conversation. This
            // deliberately includes AccessDeniedException so an unauthorized
            // user sees a blank chat rather than a blocking error.
            return new TranscriptDto();
        }
    }

    // -----------------------------------------------------------------
    // getClientConfig
    // -----------------------------------------------------------------

    /**
     * Returns the narrow client-safe subset of `Chat_Agent_Config__mdt`.
     * Named Credential names, timeouts, and retention settings stay on the
     * server to avoid DOM exfiltration (Req 13.2).
     */
    @AuraEnabled
    public static ConfigDto getClientConfig() {
        PermissionGate.assertHasAccess();
        ConfigDto dto = new ConfigDto();
        dto.maxAttachmentSizeBytes = (Integer) ConfigProvider.getMaxAttachmentSizeBytes();
        dto.allowedMimeTypes       = ConfigProvider.getAllowedMimeTypes();
        dto.isSandbox              = ConfigProvider.isSandbox();
        return dto;
    }

    // -----------------------------------------------------------------
    // getRecordContext
    // -----------------------------------------------------------------

    /**
     * Returns a small map the LWC uses to render the record-context
     * banner: `recordName` (best-effort via describe) and, for ACE /
     * AWS_Opportunity records, `partnerCentralOpportunityId` (the APN
     * CRM unique identifier the AWS Partner CRM Connector exposes).
     * The LWC prefers the APN CRM id when available so partner sales
     * users see the same identifier they use in Partner Central.
     *
     * Returns an empty map when access is denied or no record is
     * attached; this method is cacheable (`@AuraEnabled(cacheable=true)`)
     * so the LWC can bind it via `@wire`.
     */
    @AuraEnabled(cacheable=true)
    public static Map<String, Object> getRecordContext(String recordId, String objectApiName) {
        try {
            PermissionGate.assertHasAccess();
        } catch (Exception e) {
            return new Map<String, Object>();
        }
        Map<String, Object> result = new Map<String, Object>();
        if (String.isBlank(recordId) || String.isBlank(objectApiName)) {
            return result;
        }
        String recordName = tryReadRecordName(recordId, objectApiName);
        if (String.isNotBlank(recordName)) {
            result.put('recordName', recordName);
        }
        String partnerCentralId = tryReadPartnerCentralOpportunityId(recordId, objectApiName);
        if (String.isNotBlank(partnerCentralId)) {
            result.put('partnerCentralOpportunityId', partnerCentralId);
        }
        return result;
    }

    // -----------------------------------------------------------------
    // retryLastRequest
    // -----------------------------------------------------------------

    /**
     * Re-executes the last request for the current session. Minimal
     * server-side implementation: returns `ok=true` so the LWC knows the
     * retry is safe to resubmit via `submitMessage`. The actual retry
     * semantics — reusing the same JSON-RPC id and Operation_Id per Req 9.4
     * — are enforced by `McpClient.sendExecutionConfirmation` /
     * `sendRejection` on the approval path and by the LWC on the message
     * path (which owns the local message text that was typed).
     */
    @AuraEnabled
    public static ChatAgentResult retryLastRequest(String recordId) {
        try {
            PermissionGate.assertHasAccess();
            // Confirm the session still exists so the LWC does not retry into
            // an expired session (Req 5.3 / 5.5). Beyond that, the LWC owns
            // the retry payload.
            SessionManager sessionManager = new SessionManager();
            Chat_Session__c session = sessionManager.findActiveSession(
                UserInfo.getUserId(),
                recordId,
                ConfigProvider.getSessionRetentionMinutes()
            );
            Map<String, Object> payload = new Map<String, Object>{
                'hasActiveSession' => session != null,
                'sessionId'        => session == null ? null : session.Session_Id__c
            };
            return ChatAgentResult.success(null, payload);
        } catch (Exception e) {
            return mapException(e);
        }
    }

    // -----------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------

    /**
     * Maps a thrown exception to the matching `ChatAgentResult` failure
     * envelope. The mapping table is documented in the class header; any
     * exception not listed there collapses to `UNKNOWN` so the LWC always
     * receives a structured result.
     */
    private static ChatAgentResult mapException(Exception e) {
        if (e instanceof AccessDeniedException) {
            return toError(ERR_ACCESS_DENIED, e.getMessage());
        }
        if (e instanceof ChatAgentConfigException) {
            return toError(ERR_CONFIG_ERROR, e.getMessage());
        }
        if (e instanceof JsonRpcParseException) {
            // The MCP server returned a body that isn't JSON-RPC 2.0. Surface
            // the field/offset-level diagnostic the parser produced so the
            // admin can tell whether it's an auth challenge, a non-MCP
            // endpoint, or a genuine parse-level bug.
            return toError(ChatAgentResult.ERROR_PARSE,
                'MCP response was not valid JSON-RPC 2.0: ' + e.getMessage());
        }
        if (e instanceof JsonRpcSerializationException) {
            return toError(ChatAgentResult.ERROR_PARSE, e.getMessage());
        }
        if (e instanceof AuthenticationException) {
            return toError(ERR_AUTH_ERROR, e.getMessage());
        }
        if (e instanceof ClientException) {
            return toError(ERR_CLIENT_ERROR, e.getMessage());
        }
        if (e instanceof RetryableException) {
            return toError(ERR_RETRYABLE, e.getMessage());
        }
        if (e instanceof TimeoutException) {
            return toError(ERR_TIMEOUT, e.getMessage());
        }
        if (e instanceof OperationNotFoundException) {
            return toError(ERR_OPERATION_NOT_FOUND, e.getMessage());
        }
        return toError(ERR_UNKNOWN, e.getMessage());
    }

    /** Builds a failure `ChatAgentResult` with the given code and message. */
    private static ChatAgentResult toError(String errorCode, String errorMessage) {
        return ChatAgentResult.failure(errorCode, errorMessage);
    }

    /**
     * Reads the MCP Session_Id the `McpClient` recorded on the audit row
     * for the given JSON-RPC request id. Called from `submitMessage`'s
     * `finally` block to persist the server-returned session id onto the
     * Chat_Session__c row (Req 5.1) so subsequent turns — including
     * approval POSTs — resume the same MCP conversation. Returns null if
     * no row is found or the column is empty, which is the normal case
     * when the callout failed before the MCP server answered.
     */
    private static String lookupMostRecentMcpSessionId(String jsonRpcRequestId) {
        if (String.isBlank(jsonRpcRequestId)) { return null; }
        List<Audit_Log__c> rows = [
            SELECT Session_Id__c
            FROM Audit_Log__c
            WHERE Json_Rpc_Request_Id__c = :jsonRpcRequestId
              AND Session_Id__c != null
            WITH USER_MODE
            ORDER BY CreatedDate DESC
            LIMIT 1
        ];
        return rows.isEmpty() ? null : rows[0].Session_Id__c;
    }

    /**
     * Normalises a caller-supplied catalog value to one of the two values
     * the MCP server accepts. A blank or unrecognised value falls back to
     * the `Is_Sandbox__c` config flag, preserving Req 13.1's admin-driven
     * default while letting the LWC override per turn.
     */
    private static String resolveCatalog(String catalog) {
        if (String.isNotBlank(catalog)) {
            String normalised = catalog.trim().toLowerCase();
            if (normalised == CATALOG_SANDBOX.toLowerCase()) {
                return CATALOG_SANDBOX;
            }
            if (normalised == CATALOG_AWS.toLowerCase()) {
                return CATALOG_AWS;
            }
        }
        return ConfigProvider.isSandbox() ? CATALOG_SANDBOX : CATALOG_AWS;
    }

    /**
     * Generates a UUID-like string suitable for a transcriptEntryId or
     * JSON-RPC request id. Apex has no UUID primitive; this composes 16
     * random bytes and formats them as the canonical 8-4-4-4-12 hex.
     */
    private static String newId() {
        Blob b = Crypto.generateAesKey(128);
        String hex = EncodingUtil.convertToHex(b);
        return hex.substring(0, 8) + '-'
             + hex.substring(8, 12) + '-'
             + hex.substring(12, 16) + '-'
             + hex.substring(16, 20) + '-'
             + hex.substring(20, 32);
    }

    /**
     * Best-effort read of the record's Name field so the MCP server can
     * reference the record by its user-visible label. Returns null when
     * the object has no Name field, the running user lacks FLS, or the
     * record is not found. No exception is propagated: a missing name
     * is not a reason to fail the turn.
     */
    private static String tryReadRecordName(String recordId, String objectApiName) {
        if (String.isBlank(recordId) || String.isBlank(objectApiName)) {
            return null;
        }
        try {
            Schema.SObjectType sot = Schema.getGlobalDescribe().get(objectApiName);
            if (sot == null) {
                return null;
            }
            Map<String, Schema.SObjectField> fields = sot.getDescribe().fields.getMap();
            if (!fields.containsKey('name')) {
                return null;
            }
            String soql = 'SELECT Name FROM ' + String.escapeSingleQuotes(objectApiName)
                + ' WHERE Id = :recordId LIMIT 1';
            List<SObject> rows = Database.query(soql);
            if (rows.isEmpty()) {
                return null;
            }
            Object nameVal = rows[0].get('Name');
            return nameVal == null ? null : String.valueOf(nameVal);
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * For AWS_Opportunity__c / ACE_Opportunity__c records, attempts to read
     * the Partner Central opportunity identifier exposed by the AWS Partner
     * CRM Connector. We probe a short list of candidate field API names
     * because the connector has shipped slightly different schemas; the
     * first field that actually exists on the object's describe wins.
     * Returns null for any non-AWS_Opportunity object or when no candidate
     * field is defined.
     */
    private static String tryReadPartnerCentralOpportunityId(String recordId, String objectApiName) {
        if (String.isBlank(recordId) || String.isBlank(objectApiName)) {
            return null;
        }
        if (!AWS_OPPORTUNITY_OBJECTS.contains(objectApiName)) {
            return null;
        }
        try {
            Schema.SObjectType sot = Schema.getGlobalDescribe().get(objectApiName);
            if (sot == null) {
                return null;
            }
            Map<String, Schema.SObjectField> fields = sot.getDescribe().fields.getMap();
            String matchedField = null;
            for (String candidate : PARTNER_CENTRAL_ID_FIELD_CANDIDATES) {
                if (fields.containsKey(candidate.toLowerCase())) {
                    matchedField = candidate;
                    break;
                }
            }
            if (matchedField == null) {
                return null;
            }
            String soql = 'SELECT ' + matchedField + ' FROM '
                + String.escapeSingleQuotes(objectApiName)
                + ' WHERE Id = :recordId LIMIT 1';
            List<SObject> rows = Database.query(soql);
            if (rows.isEmpty()) {
                return null;
            }
            Object val = rows[0].get(matchedField);
            return val == null ? null : String.valueOf(val);
        } catch (Exception e) {
            return null;
        }
    }
}
