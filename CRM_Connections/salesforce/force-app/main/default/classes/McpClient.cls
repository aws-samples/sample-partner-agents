/**
 * Feature: partner-central-chat-agent
 *
 * HTTP client for the MCP_Server. Issues JSON-RPC 2.0 callouts through the
 * `AWS_Partner_Central_MCP` Named Credential (or its sandbox counterpart,
 * per Req 13.1), maps HTTP outcomes to the structured exception hierarchy
 * consumed by `ChatAgentController`, and writes an audit trail via
 * `AuditLogger` for every request/response pair (Req 10.1, 10.2).
 *
 * Instance-based with constructor injection so tests can substitute a
 * fake `AuditLogger`; the production path wires up the real logger via
 * the default constructor. HTTP itself is covered by `Test.setMock` in
 * the test layer, so no seam is needed for the `Http` instance.
 *
 * Exception mapping (Req 9.1 - 9.3, 2.3 - 2.4):
 *   HTTP 200       -> JsonRpcResponse (parsed + returned)
 *   HTTP 401 / 403 -> AuthenticationException (Req 2.4)
 *   HTTP 4xx other -> ClientException          (Req 9.2)
 *   HTTP 5xx       -> RetryableException       (Req 9.1)
 *   CalloutException / timeout -> TimeoutException (Req 9.3)
 *   Missing/misconfigured Named Credential -> CalloutException with a
 *       rethrown message that names the credential (Req 2.3)
 *
 * See requirements 2.1, 2.2, 2.3, 2.4, 3.2, 9.1, 9.2, 9.3, 11.3.
 */
public with sharing class McpClient {

    /**
     * JSON-RPC method names and MCP tool names per the AWS Partner Central
     * agents MCP Server documentation
     * (https://docs.aws.amazon.com/partner-central/latest/APIReference/mcp-configuration-reference.html)
     * and the MCP protocol spec
     * (https://modelcontextprotocol.io/specification/2025-03-26/server/tools).
     *
     * MCP tools are invoked via the standard JSON-RPC method `tools/call`
     * with `params.name` set to the tool name. AWS documents the agent
     * interaction tool as `sendMessage` (a tool name, NOT a JSON-RPC
     * method). Approvals and rejections are modeled as follow-up
     * `sendMessage` calls with a `decision` argument rather than as
     * separate tools.
     */
    public static final String METHOD_TOOLS_CALL = 'tools/call';
    public static final String TOOL_SEND_MESSAGE = 'sendMessage';

    // Retained for backward compatibility with older tests that reference
    // these constants. Both now resolve to the MCP tool name so the shape
    // of the actual wire payload is identical regardless of which caller
    // builds the request.
    public static final String METHOD_SEND_MESSAGE      = 'sendMessage';
    public static final String METHOD_APPROVE_OPERATION = 'sendMessage';
    public static final String METHOD_REJECT_OPERATION  = 'sendMessage';

    /** Hard upper bound on the HTTP timeout per Req 9.3 (120 seconds). */
    private static final Integer MAX_TIMEOUT_MS = 120000;

    /** The audit logger used for every request/response pair. */
    private final AuditLogger logger;

    /**
     * Server-side approval store used by `invokeStreaming` to register a new
     * Pending_Write_Operation__c row whenever an SSE frame announces a write
     * operation. Injected via constructor so the streaming path can be unit
     * tested without touching Pending_Write_Operation__c DML.
     */
    private final PendingWriteOperationStore pendingStore;

    /** Production constructor: wires up the concrete dependencies. */
    public McpClient() {
        this(new AuditLogger(), new PendingWriteOperationStore());
    }

    /**
     * Test seam: allows unit tests to inject a stub logger that captures
     * calls without writing to Audit_Log__c. Also makes the dependency
     * explicit for readers. A default `PendingWriteOperationStore` is wired
     * up because the unary path does not use it.
     */
    @TestVisible
    McpClient(AuditLogger logger) {
        this(logger, new PendingWriteOperationStore());
    }

    /**
     * Test seam: allows unit tests to inject both dependencies. Used by the
     * streaming path's tests to assert that `register` is called exactly once
     * per write-classified `pendingOperation` (Req 6.1, Property 4 / 7).
     */
    @TestVisible
    McpClient(AuditLogger logger, PendingWriteOperationStore pendingStore) {
        this.logger = logger;
        this.pendingStore = pendingStore;
    }

    /**
     * Uploads a single attachment to the Partner Central ephemeral,
     * write-only S3 bucket and returns the `s3Uri` (including the required
     * `versionId`) that the caller embeds in a `document` content block on
     * the next `sendMessage` call.
     *
     * Per the AWS Partner Central MCP docs
     * (https://docs.aws.amazon.com/partner-central/latest/APIReference/mcp-configuration-reference.html),
     * the client uploads directly to `s3://{bucket}/{aws-account-id}/...`
     * via a SigV4-signed PutObject, then references the object by its
     * version. The bucket is AWS-managed and write-only; this method only
     * ever issues `PutObject` (least privilege) and never reads, lists, or
     * changes bucket configuration.
     *
     * Security / correctness notes:
     *  - No DML is performed here, so the caller can safely sequence one or
     *    more uploads BEFORE the `sendMessage` callout without tripping
     *    Apex's "no DML before callout" rule.
     *  - The object key is `{aws-account-id}/{uuid}/{sanitized-filename}`.
     *    The filename is sanitized to `[A-Za-z0-9._-]` so the request path
     *    and the SigV4 canonical request agree without percent-encoding
     *    ambiguity, and a per-upload UUID prevents collisions.
     *  - Fails closed: if the S3 credential, bucket, or account id is not
     *    configured, throws `ChatAgentConfigException` (mapped to
     *    CONFIG_ERROR) before any callout.
     *
     * @throws ChatAgentConfigException when S3 config is incomplete
     * @throws AuthenticationException on HTTP 401/403 (missing s3:PutObject)
     * @throws ClientException on other non-2xx or a missing versionId
     * @throws TimeoutException on callout timeout
     */
    public String uploadAttachmentToS3(AttachmentDto att) {
        if (att == null || String.isBlank(att.base64Content)) {
            throw new ClientException('Attachment is empty; nothing to upload.');
        }

        String s3Cred   = ConfigProvider.getS3NamedCredentialName();
        String bucket    = ConfigProvider.getS3BucketName();
        String accountId = ConfigProvider.getAwsAccountId();
        if (String.isBlank(s3Cred) || String.isBlank(bucket) || String.isBlank(accountId)) {
            throw new ChatAgentConfigException(
                'File attachments require Chat_Agent_Config__mdt.Default to set '
                    + 'S3_Named_Credential_Name__c, S3_Bucket_Name__c, and '
                    + 'Aws_Account_Id__c. Configure these (and grant the S3 '
                    + 'credential identity s3:PutObject on the ephemeral bucket) '
                    + 'to enable document analysis.'
            );
        }

        String safeName = String.isBlank(att.fileName)
            ? 'attachment'
            : att.fileName.replaceAll('[^A-Za-z0-9._-]', '_');
        String uuid = EncodingUtil.convertToHex(Crypto.generateAesKey(128));
        String key = accountId + '/' + uuid + '/' + safeName;

        Integer timeoutMs = Math.min(
            MAX_TIMEOUT_MS,
            ConfigProvider.getRequestTimeoutSeconds() * 1000
        );

        HttpRequest httpReq = new HttpRequest();
        httpReq.setEndpoint('callout:' + s3Cred + '/' + bucket + '/' + key);
        httpReq.setMethod('PUT');
        httpReq.setHeader('Content-Type',
            String.isBlank(att.mimeType) ? 'application/octet-stream' : att.mimeType);
        httpReq.setBodyAsBlob(EncodingUtil.base64Decode(att.base64Content));
        httpReq.setTimeout(timeoutMs);

        HttpResponse resp;
        try {
            resp = new Http().send(httpReq);
        } catch (System.CalloutException ce) {
            String msg = ce.getMessage() == null ? '' : ce.getMessage();
            if (msg.contains('Unauthorized endpoint') || msg.contains('callout:')) {
                throw new CalloutException(
                    'S3 Named Credential "' + s3Cred
                        + '" is missing or misconfigured: ' + msg
                );
            }
            if (msg.contains('Read timed out')
                || msg.contains('timeout')
                || msg.contains('Unable to')) {
                throw new TimeoutException(
                    'S3 upload timed out after ' + timeoutMs + 'ms: ' + msg
                );
            }
            throw ce;
        }

        Integer status = resp.getStatusCode();
        if (status == 401 || status == 403) {
            throw new AuthenticationException(
                'S3 PutObject denied (HTTP ' + status + '). The S3 Named Credential '
                    + 'identity needs s3:PutObject on '
                    + bucket + '/' + accountId + '/*. Body: ' + resp.getBody()
            );
        }
        if (status < 200 || status >= 300) {
            throw new ClientException(
                'S3 upload failed: HTTP ' + status + ': ' + resp.getBody()
            );
        }

        // S3 PutObject on a versioned bucket returns the version in the
        // `x-amz-version-id` response header. The MCP document block
        // requires it, so a blank value is a hard error (most often it
        // means bucket versioning is not enabled).
        String versionId = resp.getHeader('x-amz-version-id');
        if (String.isBlank(versionId)) {
            versionId = resp.getHeader('x-amz-version-Id');
        }
        if (String.isBlank(versionId)) {
            throw new ClientException(
                'S3 upload succeeded (HTTP ' + status + ') but no x-amz-version-id '
                    + 'was returned; the document content block requires a versionId. '
                    + 'Confirm bucket versioning is enabled on ' + bucket + '.'
            );
        }

        return 's3://' + bucket + '/' + key
            + '?versionId=' + EncodingUtil.urlEncode(versionId, 'UTF-8');
    }

    /**
     * Sends a JSON-RPC 2.0 request to the MCP_Server over the active Named
     * Credential and returns the parsed response. Every invocation is
     * bracketed by an Audit_Log__c insert (request) and update (response)
     * so the trace survives even when the callout fails.
     *
     * The extra `userId` / `recordId` / `objectApiName` / `operationId`
     * arguments are required by the audit contract (Req 10.1, 10.4) and
     * are not propagated to the MCP_Server; they describe the caller's
     * Salesforce context.
     *
     * @throws AuthenticationException on HTTP 401/403 (Req 2.4)
     * @throws ClientException on other HTTP 4xx (Req 9.2)
     * @throws RetryableException on HTTP 5xx (Req 9.1)
     * @throws TimeoutException on callout timeout (Req 9.3)
     * @throws CalloutException when the Named Credential is missing or
     *         misconfigured; the rethrown message names the credential
     *         (Req 2.3)
     */
    public JsonRpcResponse invokeUnary(
        JsonRpcRequest req,
        String userId,
        String recordId,
        String objectApiName,
        String operationId
    ) {
        String credentialName = ConfigProvider.getActiveNamedCredentialName();
        String endpointMode = ConfigProvider.isSandbox() ? 'sandbox' : 'production';

        String body = JsonRpcSerializer.serialize(req);

        Integer timeoutMs = Math.min(
            MAX_TIMEOUT_MS,
            ConfigProvider.getRequestTimeoutSeconds() * 1000
        );

        HttpRequest httpReq = new HttpRequest();
        httpReq.setEndpoint('callout:' + credentialName);
        httpReq.setMethod('POST');
        httpReq.setHeader('Accept', 'application/json');
        httpReq.setHeader('Content-Type', 'application/json');
        httpReq.setBody(body);
        httpReq.setTimeout(timeoutMs);

        // Apex disallows DML BEFORE a callout ("uncommitted work pending"),
        // so we defer the audit row INSERT until after the callout resolves.
        // We capture the would-be request row in memory; the trail is
        // preserved because the same transaction finishes by either writing
        // the paired request+response row, or writing a request-only row
        // after a callout failure (see the CalloutException branch below).
        String requestSessionId = null;
        if (req.params != null && req.params.containsKey('sessionId')) {
            Object sid = req.params.get('sessionId');
            if (sid instanceof String) {
                requestSessionId = (String) sid;
            }
        }
        String redactedParams = AuditRedactor.redactParams(req.params);
        DateTime requestTs = System.now();

        HttpResponse resp;
        try {
            resp = new Http().send(httpReq);
        } catch (System.CalloutException ce) {
            // Now that the callout is done, the "no DML before callout"
            // restriction is lifted. Persist a request-only audit row so
            // the failure is still traceable.
            logger.logRequest(
                (Id) userId,
                recordId,
                objectApiName,
                req.method,
                requestSessionId,
                req.id,
                redactedParams,
                operationId,
                endpointMode
            );

            String msg = ce.getMessage() == null ? '' : ce.getMessage();
            if (msg.contains('Unauthorized endpoint') || msg.contains('callout:')) {
                throw new CalloutException(
                    'Named Credential "' + credentialName
                        + '" is missing or misconfigured: ' + msg
                );
            }
            if (msg.contains('Read timed out')
                || msg.contains('timeout')
                || msg.contains('Unable to')) {
                throw new TimeoutException(
                    'MCP_Server request timed out after '
                        + timeoutMs + 'ms: ' + msg
                );
            }
            throw ce;
        }

        Integer status = resp.getStatusCode();

        // Paired request+response audit row, written AFTER the callout so
        // the "no DML before callout" restriction is satisfied.
        Id auditId = logger.logRequest(
            (Id) userId,
            recordId,
            objectApiName,
            req.method,
            requestSessionId,
            req.id,
            redactedParams,
            operationId,
            endpointMode
        );

        if (status == 200) {
            String rawBody = resp.getBody();
            JsonRpcResponse parsed = JsonRpcParser.parseResponse(rawBody);
            String sessionId = extractSessionId(parsed);
            logger.logResponse(auditId, status, sessionId, System.now(), rawBody);
            return parsed;
        }

        if (status == 401 || status == 403) {
            logger.logResponse(auditId, status, null, System.now(), resp.getBody());
            throw new AuthenticationException(
                'HTTP ' + status + ' from Named Credential ' + credentialName
            );
        }

        if (status >= 400 && status < 500) {
            logger.logResponse(auditId, status, null, System.now(), resp.getBody());
            throw new ClientException('HTTP ' + status + ': ' + resp.getBody());
        }

        if (status >= 500) {
            logger.logResponse(auditId, status, null, System.now(), resp.getBody());
            throw new RetryableException('HTTP ' + status + ' - retryable');
        }

        // Any other 2xx/3xx that is not 200: treat as a non-retryable
        // protocol violation. JSON-RPC-over-HTTP always responds 200 on
        // success, so a 2xx-other-than-200 is unexpected and should fail
        // loudly rather than be silently parsed.
        logger.logResponse(auditId, status, null, System.now(), resp.getBody());
        throw new ClientException(
            'Unexpected HTTP ' + status + ' from MCP_Server: ' + resp.getBody()
        );
    }

    /**
     * Streaming variant of `invokeUnary`. Executes a buffered SSE callout,
     * parses the response body with `SseFrameParser`, and publishes one
     * `Chat_Stream_Event__e` per frame so the LWC can render incrementally
     * via `lightning/empApi` (Req 4.1, 4.2).
     *
     * Fall-back paths (all still produce a single terminal event so the LWC
     * sees a well-formed stream close):
     *   - `Sse_Enabled__c = false` → delegate to `invokeUnary` and publish
     *     one terminal event carrying the full JSON-RPC response body.
     *   - HTTP 200 with a Content-Type other than `text/event-stream` →
     *     parse the body as a unary JSON-RPC response and publish one
     *     terminal event (Req 3.2 best-effort unary fallback).
     *   - Non-2xx / callout exception → publish one terminal `error` event
     *     with the exception message as `Data__c`, then rethrow using the
     *     same mapping as `invokeUnary` so callers see a structured
     *     exception AND the LWC sees a stream close.
     *   - Stream truncated (last frame not terminal) → publish an extra
     *     terminal `connection_interrupted` event preserving partial
     *     content (Req 4.5).
     *
     * For every SSE frame whose payload announces a `pendingOperation`
     * classified as `write`, a row is inserted into
     * `Pending_Write_Operation__c` via `PendingWriteOperationStore.register`
     * and the emitted event's `Data__c` is an `ApprovalPromptDto` JSON
     * instead of the raw frame data so the LWC can render the approval UI
     * directly (Req 6.1, 6.8, 6.9).
     *
     * Events are published as a batch via `EventBus.publish(List)` so the
     * LWC sees them in a single bus delivery when possible (best-effort;
     * the platform event bus is ultimately async).
     *
     * @throws AuthenticationException on HTTP 401/403 (Req 2.4)
     * @throws ClientException on other HTTP 4xx (Req 9.2)
     * @throws RetryableException on HTTP 5xx (Req 9.1)
     * @throws TimeoutException on callout timeout (Req 9.3)
     * @throws CalloutException when the Named Credential is missing or
     *         misconfigured; the rethrown message names the credential
     *         (Req 2.3)
     */
    public List<Chat_Stream_Event__e> invokeStreaming(
        JsonRpcRequest req,
        String transcriptEntryId,
        Id userId,
        String recordId,
        String objectApiName,
        String operationId
    ) {
        // Accumulator used by every path below so every branch (unary
        // fallback, callout failure, truncation, normal SSE) can append to
        // the same ordered sequence before a single `EventBus.publish`.
        List<Chat_Stream_Event__e> events = new List<Chat_Stream_Event__e>();
        Integer sequence = 0;

        // -- Fallback path: SSE disabled by config ----------------------------
        if (!ConfigProvider.isSseEnabled()) {
            JsonRpcResponse unary = invokeUnary(
                req,
                userId == null ? null : String.valueOf(userId),
                recordId,
                objectApiName,
                operationId
            );
            // Serialize the full response so the LWC receives the same payload
            // it would have gotten from the final SSE frame of a streaming run.
            String payload = JsonRpcSerializer.serialize(unary);
            publishEvent(events, transcriptEntryId, userId, sequence, 'done', payload, true);
            EventBus.publish(events);
            return events;
        }

        String credentialName = ConfigProvider.getActiveNamedCredentialName();
        String endpointMode = ConfigProvider.isSandbox() ? 'sandbox' : 'production';

        String body = JsonRpcSerializer.serialize(req);

        Integer timeoutMs = Math.min(
            MAX_TIMEOUT_MS,
            ConfigProvider.getRequestTimeoutSeconds() * 1000
        );

        HttpRequest httpReq = new HttpRequest();
        httpReq.setEndpoint('callout:' + credentialName);
        httpReq.setMethod('POST');
        httpReq.setHeader('Accept', 'text/event-stream');
        httpReq.setHeader('Content-Type', 'application/json');
        httpReq.setBody(body);
        httpReq.setTimeout(timeoutMs);

        // Apex disallows DML BEFORE a callout ("uncommitted work pending"),
        // so we defer the audit row INSERT until after the callout resolves.
        // We capture the would-be request row in memory; the audit row is
        // inserted immediately after the callout returns (or after a
        // CalloutException is mapped), symmetric with `invokeUnary`.
        String requestSessionId = null;
        if (req.params != null && req.params.containsKey('sessionId')) {
            Object sid = req.params.get('sessionId');
            if (sid instanceof String) {
                requestSessionId = (String) sid;
            }
        }
        String redactedParams = AuditRedactor.redactParams(req.params);

        HttpResponse resp;
        try {
            resp = new Http().send(httpReq);
        } catch (System.CalloutException ce) {
            String msg = ce.getMessage() == null ? '' : ce.getMessage();
            // Publish a terminal error event so the LWC's subscriber sees the
            // stream close even though the callout never produced a response.
            // Then map to the same exception taxonomy `invokeUnary` uses so
            // the caller gets a structured failure (Req 2.3, 9.3).
            publishEvent(events, transcriptEntryId, userId, sequence, 'error', msg, true);
            EventBus.publish(events);

            // DML now permitted (post-callout). Write a request-only audit
            // row so the failure remains traceable.
            logger.logRequest(
                userId,
                recordId,
                objectApiName,
                req.method,
                requestSessionId,
                req.id,
                redactedParams,
                operationId,
                endpointMode
            );

            if (msg.contains('Unauthorized endpoint') || msg.contains('callout:')) {
                throw new CalloutException(
                    'Named Credential "' + credentialName
                        + '" is missing or misconfigured: ' + msg
                );
            }
            if (msg.contains('Read timed out')
                || msg.contains('timeout')
                || msg.contains('Unable to')) {
                throw new TimeoutException(
                    'MCP_Server request timed out after '
                        + timeoutMs + 'ms: ' + msg
                );
            }
            throw ce;
        }

        Integer status = resp.getStatusCode();

        // Paired request+response audit row, written AFTER the callout so
        // the "no DML before callout" restriction is satisfied.
        Id auditId = logger.logRequest(
            userId,
            recordId,
            objectApiName,
            req.method,
            requestSessionId,
            req.id,
            redactedParams,
            operationId,
            endpointMode
        );

        // -- Non-200 status: map to an exception AND publish a terminal event -
        if (status != 200) {
            String rawBody = resp.getBody();
            String errMsg = 'HTTP ' + status + ': ' + rawBody;
            publishEvent(events, transcriptEntryId, userId, sequence, 'error', errMsg, true);
            EventBus.publish(events);
            logger.logResponse(auditId, status, null, System.now(), rawBody);

            if (status == 401 || status == 403) {
                throw new AuthenticationException(
                    'HTTP ' + status + ' from Named Credential ' + credentialName
                );
            }
            if (status >= 400 && status < 500) {
                throw new ClientException(errMsg);
            }
            if (status >= 500) {
                throw new RetryableException('HTTP ' + status + ' - retryable');
            }
            // 2xx-other-than-200 / 3xx: non-retryable protocol violation.
            throw new ClientException('Unexpected HTTP ' + status + ' from MCP_Server: ' + rawBody);
        }

        // -- Content-Type not text/event-stream: unary fallback ---------------
        String contentType = resp.getHeader('Content-Type');
        if (contentType == null) {
            contentType = resp.getHeader('content-type');
        }
        Boolean isSse = contentType != null
            && contentType.toLowerCase().startsWith('text/event-stream');

        if (!isSse) {
            // MCP_Server decided to reply as unary JSON-RPC. Parse the body
            // so we can extract the sessionId for the audit row, then publish
            // a single terminal event carrying the full response.
            String rawBody = resp.getBody();
            JsonRpcResponse parsed = JsonRpcParser.parseResponse(rawBody);

            // If the MCP server returned a JSON-RPC error object inside a
            // 200 (e.g. "No handler registered for method: X"), surface it
            // to the LWC as an `error` event so the user sees the actual
            // message rather than raw JSON in the assistant bubble (Req
            // 3.6). The full response is still recorded as the audit
            // body so operators can see the code and data fields.
            if (parsed != null && parsed.error != null) {
                String errMsg = parsed.error.message != null
                    ? 'MCP error ' + parsed.error.code + ': ' + parsed.error.message
                    : 'MCP returned JSON-RPC error code ' + parsed.error.code;
                publishEvent(events, transcriptEntryId, userId, sequence, 'error', errMsg, true);
                EventBus.publish(events);
                logger.logResponse(auditId, status, null, System.now(), rawBody);
                return events;
            }

            String payload = JsonRpcSerializer.serialize(parsed);
            // Prefer clean assistant-text + approval-card events for the
            // LWC when we can extract them from the MCP-shaped response.
            // Fall back to the raw serialized envelope when the shape
            // diverges from the documented contract so operators still
            // see something.
            String assistantText = extractAssistantText(parsed);
            List<Map<String, Object>> approvalReqs = extractApprovalRequests(parsed);
            String mcpSessionId = extractSessionId(parsed);

            if (String.isNotBlank(assistantText) || !approvalReqs.isEmpty()) {
                if (String.isNotBlank(assistantText)) {
                    publishEvent(events, transcriptEntryId, userId, sequence,
                        'message', assistantText, false);
                    sequence++;
                }
                // Every tool_approval_request block is persisted as a
                // Pending_Write_Operation__c row AND surfaced to the LWC
                // as an inline approval card (Req 6.1, 6.8, 6.9, Property 4).
                for (Map<String, Object> block : approvalReqs) {
                    ApprovalPromptDto prompt = registerMcpApprovalRequest(
                        block,
                        req.id,
                        mcpSessionId,
                        userId,
                        recordId,
                        assistantText
                    );
                    if (prompt == null) { continue; }
                    publishEvent(events, transcriptEntryId, userId, sequence,
                        'approval_request', JSON.serialize(prompt), false);
                    sequence++;
                }
                publishEvent(events, transcriptEntryId, userId, sequence,
                    'done', '', true);
            } else {
                publishEvent(events, transcriptEntryId, userId, sequence,
                    'done', payload, true);
            }
            EventBus.publish(events);
            logger.logResponse(auditId, status, mcpSessionId, System.now(), rawBody);
            return events;
        }

        // -- Normal SSE path --------------------------------------------------
        String rawBody = resp.getBody();
        List<SseFrame> frames = SseFrameParser.parse(rawBody);
        String sessionIdForAudit = null;
        SseFrame lastFrame = null;

        for (SseFrame frame : frames) {
            lastFrame = frame;
            // Default the event name to `message` per the SSE spec default
            // (a frame without an explicit `event:` field is a `message`).
            String eventType = frame.event != null ? frame.event : 'message';
            String data = frame.data;
            Boolean isTerminal = frame.isTerminal();

            // Inspect the frame's data for a pendingOperation; on a write
            // classification, register a Pending_Write_Operation__c row and
            // swap the event payload for an ApprovalPromptDto so the LWC can
            // render the approval UI directly (Req 6.1, 6.8).
            Map<String, Object> pendingOp = extractPendingOperation(data);
            if (pendingOp != null) {
                if (sessionIdForAudit == null) {
                    sessionIdForAudit = extractSessionIdFromFrameData(data);
                }
                String classification = OperationClassifier.classifyOperation(pendingOp);
                if (OperationClassifier.WRITE.equals(classification)) {
                    ApprovalPromptDto prompt = registerPendingOperation(
                        pendingOp,
                        req.id,
                        sessionIdForAudit,
                        userId,
                        recordId
                    );
                    // Replace raw frame data with the prompt payload the LWC
                    // is ready to render inline in the transcript.
                    data = JSON.serialize(prompt);
                }
            } else if (sessionIdForAudit == null) {
                // Harvest the session id opportunistically from any frame
                // that carries a JSON-RPC result so the audit row can be
                // closed with the correct Session_Id__c even when no
                // pendingOperation was ever announced.
                sessionIdForAudit = extractSessionIdFromFrameData(data);
            }

            publishEvent(events, transcriptEntryId, userId, sequence, eventType, data, isTerminal);
            sequence++;
        }

        // -- Truncation detection: append a `connection_interrupted` terminal -
        // Per Req 4.5, the client must surface a partial-content marker when
        // the stream ended without a terminal frame so the user can see the
        // work-in-progress text but know it is incomplete.
        if (lastFrame == null || !lastFrame.isTerminal()) {
            publishEvent(
                events,
                transcriptEntryId,
                userId,
                sequence,
                'connection_interrupted',
                'Stream ended without a terminal event; partial content preserved.',
                true
            );
        }

        EventBus.publish(events);
        logger.logResponse(auditId, status, sessionIdForAudit, System.now(), rawBody);
        return events;
    }

    /**
     * Convenience helper that appends a configured `Chat_Stream_Event__e` to
     * the outgoing batch. Centralizing the field wiring keeps every branch
     * of `invokeStreaming` (unary fallback, callout error, SSE frame,
     * truncation terminal) consistent.
     */
    private void publishEvent(
        List<Chat_Stream_Event__e> events,
        String transcriptEntryId,
        Id userId,
        Integer sequence,
        String eventType,
        String data,
        Boolean isTerminal
    ) {
        events.add(new Chat_Stream_Event__e(
            Transcript_Entry_Id__c = transcriptEntryId,
            User__c                = userId == null ? null : String.valueOf(userId),
            Sequence__c            = sequence,
            Event_Type__c          = eventType,
            Data__c                = data,
            Is_Terminal__c         = isTerminal
        ));
    }

    /**
     * Inspects a frame's `data` field for a `pendingOperation` object nested
     * under `result`. Returns the Map when present, else null. Parsing
     * failures (non-JSON data, missing keys, wrong types) all return null
     * so the caller can safely treat the frame as a plain message.
     */
    private Map<String, Object> extractPendingOperation(String data) {
        if (String.isBlank(data)) {
            return null;
        }
        Object parsed;
        try {
            parsed = JSON.deserializeUntyped(data);
        } catch (System.JSONException je) {
            return null;
        }
        if (!(parsed instanceof Map<String, Object>)) {
            return null;
        }
        Map<String, Object> root = (Map<String, Object>) parsed;
        Object result = root.get('result');
        if (!(result instanceof Map<String, Object>)) {
            return null;
        }
        Object pendingOp = ((Map<String, Object>) result).get('pendingOperation');
        if (pendingOp instanceof Map<String, Object>) {
            return (Map<String, Object>) pendingOp;
        }
        return null;
    }

    /**
     * Extracts the `sessionId` from a frame's `data` field (expected to be a
     * JSON-RPC response envelope with `result.sessionId`). Null-safe; returns
     * null for any parse failure or missing field.
     */
    private String extractSessionIdFromFrameData(String data) {
        if (String.isBlank(data)) {
            return null;
        }
        Object parsed;
        try {
            parsed = JSON.deserializeUntyped(data);
        } catch (System.JSONException je) {
            return null;
        }
        if (!(parsed instanceof Map<String, Object>)) {
            return null;
        }
        Object result = ((Map<String, Object>) parsed).get('result');
        if (!(result instanceof Map<String, Object>)) {
            return null;
        }
        Object sid = ((Map<String, Object>) result).get('sessionId');
        return sid instanceof String ? (String) sid : null;
    }

    /**
     * Registers a Pending_Write_Operation__c row for the given pendingOperation
     * Map and builds the matching `ApprovalPromptDto` for the LWC. The
     * operation id, method name, summary, targetResourceId, params and
     * fieldDiff are read out of the Map defensively — any missing field is
     * represented as null / serialized empty structure.
     */
    private ApprovalPromptDto registerPendingOperation(
        Map<String, Object> pendingOp,
        String jsonRpcRequestId,
        String sessionId,
        Id userId,
        String recordId
    ) {
        String opId = stringField(pendingOp, 'operationId');
        String opName = stringField(pendingOp, 'method');
        String targetResourceId = stringField(pendingOp, 'targetResourceId');
        String summary = stringField(pendingOp, 'summary');

        Object params = pendingOp.get('params');
        Object fieldDiff = pendingOp.get('fieldDiff');
        String paramsPayload = params == null ? null : JSON.serialize(params);
        String fieldDiffJson = fieldDiff == null ? null : JSON.serialize(fieldDiff);

        pendingStore.register(
            opId,
            jsonRpcRequestId,
            sessionId,
            userId,
            recordId,
            opName,
            targetResourceId,
            summary,
            paramsPayload,
            fieldDiffJson
        );

        // Also create a correlating Audit_Log__c row tagged with the
        // Operation_Id so that any later approval decision (approved,
        // rejected, or unresolved via the expiry sweep) can stamp it via
        // `AuditLogger.logApprovalDecision` (Req 6.13, 10.4).
        String endpointMode = ConfigProvider.isSandbox() ? 'sandbox' : 'production';
        logger.logRequest(
            userId,
            recordId,
            null, /* objectApiName */
            opName,
            sessionId,
            jsonRpcRequestId,
            paramsPayload,
            opId,
            endpointMode
        );

        ApprovalPromptDto prompt = new ApprovalPromptDto();
        prompt.operationId = opId;
        prompt.operationName = opName;
        prompt.targetResourceId = targetResourceId;
        prompt.summary = summary;
        prompt.fieldDiffMarkdown = fieldDiffJson;
        prompt.paramsPayloadJson = paramsPayload;
        prompt.status = ApprovalPromptDto.STATUS_PENDING;
        prompt.decision = ApprovalPromptDto.DECISION_UNRESOLVED;
        return prompt;
    }

    /** Null-safe String field accessor; returns null for missing or non-String values. */
    private String stringField(Map<String, Object> m, String key) {
        Object v = m.get(key);
        return v instanceof String ? (String) v : null;
    }

    /**
     * Sends the approval confirmation for a user-approved Write_Operation.
     * Reuses the ORIGINAL JSON-RPC request id and the Operation_Id that were
     * issued when the MCP_Server first announced the `pendingOperation`, so
     * that a user-initiated retry after a transient failure (Req 9.4) is
     * idempotent on the server: the MCP_Server de-duplicates by (id,
     * operationId).
     *
     * On a 2xx response (invokeUnary returns without throwing), calls
     * `PendingWriteOperationStore.markSent(operationId)` to drive the store
     * row from (pending, approved) to (sent, approved). `markSent` is
     * idempotent, so even if this method is re-entered on a subsequent retry
     * that happens to succeed twice, Property 4 (At most one confirmation)
     * still holds.
     *
     * Transient failures (HTTP 5xx → `RetryableException`, timeouts →
     * `TimeoutException`, network errors, etc.) are propagated unchanged by
     * `invokeUnary`; `markSent` is deliberately NOT called on those paths
     * so a subsequent user retry reuses the same ids AND still transitions
     * the row exactly once on eventual success (Req 6.12, 9.4).
     *
     * @throws AuthenticationException on HTTP 401/403 (Req 2.4)
     * @throws ClientException on other HTTP 4xx (Req 9.2)
     * @throws RetryableException on HTTP 5xx (Req 9.1)
     * @throws TimeoutException on callout timeout (Req 9.3)
     */
    public JsonRpcResponse sendExecutionConfirmation(
        String originalJsonRpcRequestId,
        String operationId,
        String sessionId,
        Id userId,
        String recordId,
        String objectApiName
    ) {
        return sendExecutionConfirmation(
            originalJsonRpcRequestId, operationId, sessionId,
            userId, recordId, objectApiName, null
        );
    }

    /**
     * Overload that accepts an explicit catalog (`"AWS"` or `"Sandbox"`).
     * Must match the catalog of the session the original turn created —
     * crossing catalogs produces the server's
     * `ResourceNotFoundException: Session not found in catalog ...`.
     * Falls back to `ConfigProvider.isSandbox()` when catalog is blank.
     */
    public JsonRpcResponse sendExecutionConfirmation(
        String originalJsonRpcRequestId,
        String operationId,
        String sessionId,
        Id userId,
        String recordId,
        String objectApiName,
        String catalog
    ) {
        JsonRpcRequest req = buildApprovalRequest(
            originalJsonRpcRequestId,
            METHOD_APPROVE_OPERATION,
            operationId,
            sessionId,
            'approved',
            catalog
        );
        JsonRpcResponse resp = invokeUnary(
            req,
            userId == null ? null : String.valueOf(userId),
            recordId,
            objectApiName,
            operationId
        );
        // 2xx only reaches this line: invokeUnary throws on every non-2xx
        // status and every network failure. The caller (controller) is
        // responsible for advancing the pending row from (pending,
        // unresolved) → (pending, approved) → (sent, approved) via
        // `finalizeDecide(approved)` + `markSent()` AFTER this method
        // returns, so Property 4 / Invariant I1 still holds: at most one
        // confirmation is POSTed per Operation_Id, and the `sent`
        // transition only happens after the POST has been accepted.
        return resp;
    }

    /**
     * Sends the rejection for a user-rejected Write_Operation. Mirrors
     * `sendExecutionConfirmation` but with `method = agent.rejectOperation`
     * and `decision = rejected`. The matching `Pending_Write_Operation__c`
     * row is already in its terminal (cancelled, rejected) state by the
     * time this is called (set by `PendingWriteOperationStore.decide`),
     * so there is no `markSent` side-effect to apply here.
     *
     * The same id-reuse rule as the approval path holds (Req 9.4): a retry
     * after a transient failure must carry the same JSON-RPC id and
     * Operation_Id so the MCP_Server can de-duplicate.
     *
     * @throws AuthenticationException on HTTP 401/403 (Req 2.4)
     * @throws ClientException on other HTTP 4xx (Req 9.2)
     * @throws RetryableException on HTTP 5xx (Req 9.1)
     * @throws TimeoutException on callout timeout (Req 9.3)
     */
    public JsonRpcResponse sendRejection(
        String originalJsonRpcRequestId,
        String operationId,
        String sessionId,
        Id userId,
        String recordId,
        String objectApiName
    ) {
        return sendRejection(
            originalJsonRpcRequestId, operationId, sessionId,
            userId, recordId, objectApiName, null
        );
    }

    /** Catalog-aware overload; see `sendExecutionConfirmation` for rationale. */
    public JsonRpcResponse sendRejection(
        String originalJsonRpcRequestId,
        String operationId,
        String sessionId,
        Id userId,
        String recordId,
        String objectApiName,
        String catalog
    ) {
        JsonRpcRequest req = buildApprovalRequest(
            originalJsonRpcRequestId,
            METHOD_REJECT_OPERATION,
            operationId,
            sessionId,
            'rejected',
            catalog
        );
        return invokeUnary(
            req,
            userId == null ? null : String.valueOf(userId),
            recordId,
            objectApiName,
            operationId
        );
    }

    /**
     * Centralizes the JSON-RPC envelope construction used by both the
     * approval and rejection paths so the shape stays in lock-step with
     * the schema documented in design.md. The `id` is always the ORIGINAL
     * JSON-RPC request id so a retry reuses it verbatim (Req 9.4).
     *
     * The payload matches the documented AWS Partner Central
     * `sendMessage` tool contract: a `tools/call` JSON-RPC envelope
     * carrying a single `tool_approval_response` content block with
     * `toolUseId` (from the original `tool_approval_request`), `decision`
     * (`approve` | `reject`), and the session id so the agent can resume
     * the same conversation.
     */
    private JsonRpcRequest buildApprovalRequest(
        String originalJsonRpcRequestId,
        String method,
        String operationId,
        String sessionId,
        String decision,
        String catalog
    ) {
        // MCP approval vocabulary differs from our internal approved/rejected
        // decision picklist: the wire format uses `approve` and `reject`.
        String mcpDecision = 'approved' == decision ? 'approve'
            : 'rejected' == decision ? 'reject'
            : decision; // pass-through for already-MCP-shaped callers

        // The catalog MUST match the session's catalog or the server
        // returns a `Session not found in catalog '...'` error. Fall
        // back to the config's sandbox flag when the caller did not
        // specify.
        String effectiveCatalog;
        if (String.isNotBlank(catalog)) {
            String normalised = catalog.trim().toLowerCase();
            effectiveCatalog = 'sandbox' == normalised ? 'Sandbox'
                : 'aws' == normalised ? 'AWS'
                : catalog;
        } else {
            effectiveCatalog = ConfigProvider.isSandbox() ? 'Sandbox' : 'AWS';
        }

        Map<String, Object> toolApprovalResponse = new Map<String, Object>{
            'type'       => 'tool_approval_response',
            'toolUseId'  => operationId,
            'decision'   => mcpDecision
        };
        Map<String, Object> sendMessageArgs = new Map<String, Object>{
            'content' => new List<Object>{ toolApprovalResponse },
            'catalog' => effectiveCatalog
        };
        if (String.isNotBlank(sessionId)) {
            sendMessageArgs.put('sessionId', sessionId);
        }
        Map<String, Object> toolsCallParams = new Map<String, Object>{
            'name'      => TOOL_SEND_MESSAGE,
            'arguments' => sendMessageArgs
        };
        // Ignore the legacy `method` argument and always emit the canonical
        // MCP `tools/call` JSON-RPC method.
        return new JsonRpcRequest(
            originalJsonRpcRequestId,
            METHOD_TOOLS_CALL,
            toolsCallParams
        );
    }

    /**
     * Pulls the MCP-returned Session_ID out of a successful response.
     *
     * The AWS Partner Central agents MCP Server wraps the conversational
     * payload as `result.content[0].text = "<json string>"`, where the
     * inner JSON carries `sessionId`, `content[]`, and `status`. Callers
     * want the Session_ID to echo back on follow-ups, so we check:
     *   1. `result.sessionId` (legacy flat shape)
     *   2. `result.content[0].text` parsed as JSON → `sessionId` (current shape)
     * Returns null when neither shape matches or the response is an error.
     */
    private String extractSessionId(JsonRpcResponse resp) {
        if (resp == null || resp.result == null) {
            return null;
        }
        if (!(resp.result instanceof Map<String, Object>)) {
            return null;
        }
        Map<String, Object> resultMap = (Map<String, Object>) resp.result;

        // Shape 1: result.sessionId directly on the JSON-RPC result.
        Object sid = resultMap.get('sessionId');
        if (sid instanceof String) {
            return (String) sid;
        }

        // Shape 2: result.content[0].text = JSON string carrying sessionId.
        Map<String, Object> mcpResult = unwrapMcpTextResult(resultMap);
        if (mcpResult != null) {
            Object innerSid = mcpResult.get('sessionId');
            if (innerSid instanceof String) {
                return (String) innerSid;
            }
        }
        return null;
    }

    /**
     * Reshapes a raw MCP `sendMessage` JSON-RPC result into a flat text
     * transcript the LWC can render as an assistant bubble.
     *
     * The MCP server returns `result.content[0].text` containing a JSON
     * string with its own `content[]` array of typed blocks
     * (`ASSISTANT_RESPONSE`, `serverToolUse`, `serverToolResult`,
     * `tool_approval_request`, ...). We concatenate every
     * `ASSISTANT_RESPONSE.content.text` entry, joined with blank lines,
     * so the user sees only the agent's narrative and not the internal
     * tool trace. When no ASSISTANT_RESPONSE blocks are present (e.g.
     * pure tool use), we fall back to null so callers can decide what
     * to show.
     */
    @TestVisible
    public String extractAssistantText(JsonRpcResponse resp) {
        if (resp == null || resp.result == null
            || !(resp.result instanceof Map<String, Object>)) {
            return null;
        }
        Map<String, Object> mcpResult = unwrapMcpTextResult(
            (Map<String, Object>) resp.result
        );
        if (mcpResult == null) {
            return null;
        }
        Object contentObj = mcpResult.get('content');
        if (!(contentObj instanceof List<Object>)) {
            return null;
        }
        List<String> parts = new List<String>();
        for (Object raw : (List<Object>) contentObj) {
            if (!(raw instanceof Map<String, Object>)) { continue; }
            Map<String, Object> block = (Map<String, Object>) raw;
            String type = block.get('type') instanceof String
                ? (String) block.get('type') : null;
            if (type != 'ASSISTANT_RESPONSE') { continue; }
            Object innerBlock = block.get('content');
            if (innerBlock instanceof Map<String, Object>) {
                Object text = ((Map<String, Object>) innerBlock).get('text');
                if (text instanceof String && !String.isBlank((String) text)) {
                    parts.add((String) text);
                }
            }
        }
        if (parts.isEmpty()) {
            return null;
        }
        return String.join(parts, '\n\n');
    }

    /**
     * Returns every `tool_approval_request` block in the MCP result as a
     * list of raw Map payloads. Each entry carries `toolUseId`,
     * `toolName`, and `parameters` per the AWS Partner Central MCP
     * `sendMessage` tool docs. Empty list when the response has no
     * approval request (the common read-only case).
     */
    @TestVisible
    public List<Map<String, Object>> extractApprovalRequests(JsonRpcResponse resp) {
        List<Map<String, Object>> out = new List<Map<String, Object>>();
        if (resp == null || resp.result == null
            || !(resp.result instanceof Map<String, Object>)) {
            return out;
        }
        Map<String, Object> mcpResult = unwrapMcpTextResult(
            (Map<String, Object>) resp.result
        );
        if (mcpResult == null) { return out; }
        Object contentObj = mcpResult.get('content');
        if (!(contentObj instanceof List<Object>)) { return out; }
        for (Object raw : (List<Object>) contentObj) {
            if (!(raw instanceof Map<String, Object>)) { continue; }
            Map<String, Object> block = (Map<String, Object>) raw;
            String type = block.get('type') instanceof String
                ? (String) block.get('type') : null;
            if (type != 'tool_approval_request') { continue; }
            out.add(block);
        }
        return out;
    }

    /**
     * Registers a Pending_Write_Operation__c row for a documented MCP
     * `tool_approval_request` block and returns the matching
     * `ApprovalPromptDto` the LWC can render inline.
     *
     * Handles both shapes the server may emit:
     *   1. Documented shape (`toolUseId`, `toolName`, `parameters`
     *      at block top level) — per the AWS `sendMessage` tool docs.
     *   2. Observed production shape (`content.text` carries a JSON
     *      string with `tool_use_id`, `tool_name`, `input`, and
     *      `tool_description`). This is what the sandbox MCP server
     *      actually returns as of April 2026; we prefer this shape
     *      when the top-level fields are missing.
     *
     * Maps the MCP fields onto the `Pending_Write_Operation__c` schema:
     *   tool_use_id / toolUseId   -> Operation_Id__c
     *   tool_name   / toolName    -> Operation_Name__c
     *   input       / parameters  -> Params_Payload__c (serialized JSON)
     *   input       / parameters  -> Field_Diff__c     (same; we do not
     *                                                   yet compute a
     *                                                   before/after diff)
     *   server-side session id    -> Session_Id__c
     *
     * Leaves `Target_Resource_Id__c` blank — the MCP server does not
     * return a stable target id on the approval request, so we rely on
     * the LWC's record context + the summary to let the user recognise
     * what they are approving.
     */
    @TestVisible
    public ApprovalPromptDto registerMcpApprovalRequest(
        Map<String, Object> block,
        String jsonRpcRequestId,
        String sessionId,
        Id userId,
        String recordId,
        String agentSummary
    ) {
        Map<String, Object> normalised = normaliseApprovalRequestBlock(block);
        if (normalised == null) {
            return null;
        }
        String toolUseId = stringField(normalised, 'toolUseId');
        String toolName  = stringField(normalised, 'toolName');
        Object params    = normalised.get('parameters');
        String paramsPayload = params == null ? null : JSON.serialize(params);
        String toolDescription = stringField(normalised, 'toolDescription');

        if (String.isBlank(toolUseId)) {
            return null;
        }

        // Use the server-supplied tool_description as the approval summary
        // when the agent did not include a narrative text block. This
        // keeps the approval card meaningful even for tool-only turns
        // where `agentSummary` is null.
        String summary = String.isNotBlank(agentSummary)
            ? agentSummary
            : (String.isNotBlank(toolDescription)
                ? toolDescription
                : 'The agent is requesting approval to run ' + toolName + '.');

        pendingStore.register(
            toolUseId,
            jsonRpcRequestId,
            sessionId,
            userId,
            recordId,
            toolName,
            null, /* targetResourceId — MCP does not supply one */
            summary,
            paramsPayload,
            paramsPayload
        );

        String endpointMode = ConfigProvider.isSandbox() ? 'sandbox' : 'production';
        logger.logRequest(
            userId,
            recordId,
            null, /* objectApiName */
            toolName,
            sessionId,
            jsonRpcRequestId,
            paramsPayload,
            toolUseId,
            endpointMode
        );

        ApprovalPromptDto prompt = new ApprovalPromptDto();
        prompt.operationId = toolUseId;
        prompt.operationName = toolName;
        prompt.targetResourceId = null;
        prompt.summary = summary;
        prompt.fieldDiffMarkdown = paramsPayload;
        prompt.paramsPayloadJson = paramsPayload;
        prompt.status = ApprovalPromptDto.STATUS_PENDING;
        prompt.decision = ApprovalPromptDto.DECISION_UNRESOLVED;
        return prompt;
    }

    /**
     * Normalises the two on-the-wire shapes of a `tool_approval_request`
     * content block into a flat map with the keys `toolUseId`,
     * `toolName`, `parameters`, and (optionally) `toolDescription`.
     * Returns null when neither shape matches so `registerMcpApprovalRequest`
     * can bail gracefully.
     */
    private Map<String, Object> normaliseApprovalRequestBlock(Map<String, Object> block) {
        if (block == null) { return null; }

        // Documented shape: fields sit at the top level of the block.
        if (block.get('toolUseId') instanceof String) {
            Map<String, Object> out = new Map<String, Object>{
                'toolUseId' => block.get('toolUseId'),
                'toolName'  => block.get('toolName'),
                'parameters' => block.get('parameters')
            };
            if (block.get('toolDescription') instanceof String) {
                out.put('toolDescription', block.get('toolDescription'));
            }
            return out;
        }

        // Observed production shape: content.text carries a JSON string
        // with snake_case keys `tool_use_id`, `tool_name`, `input`,
        // `tool_description`.
        Object contentObj = block.get('content');
        if (!(contentObj instanceof Map<String, Object>)) { return null; }
        Object textObj = ((Map<String, Object>) contentObj).get('text');
        if (!(textObj instanceof String) || String.isBlank((String) textObj)) {
            return null;
        }
        try {
            Object parsedText = JSON.deserializeUntyped((String) textObj);
            if (!(parsedText instanceof Map<String, Object>)) { return null; }
            Map<String, Object> body = (Map<String, Object>) parsedText;
            Map<String, Object> out = new Map<String, Object>{
                'toolUseId' => body.get('tool_use_id'),
                'toolName'  => body.get('tool_name'),
                'parameters' => body.get('input')
            };
            if (body.get('tool_description') instanceof String) {
                out.put('toolDescription', body.get('tool_description'));
            }
            return out;
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Helper: if `resultMap` has the MCP `content[0].text` shape, parse
     * that text as JSON and return the inner map. Returns null when the
     * shape doesn't match or the embedded text isn't valid JSON.
     */
    private Map<String, Object> unwrapMcpTextResult(Map<String, Object> resultMap) {
        if (resultMap == null) { return null; }
        Object contentObj = resultMap.get('content');
        if (!(contentObj instanceof List<Object>) || ((List<Object>) contentObj).isEmpty()) {
            return null;
        }
        Object first = ((List<Object>) contentObj)[0];
        if (!(first instanceof Map<String, Object>)) {
            return null;
        }
        Object text = ((Map<String, Object>) first).get('text');
        if (!(text instanceof String) || String.isBlank((String) text)) {
            return null;
        }
        try {
            Object parsedInner = JSON.deserializeUntyped((String) text);
            return parsedInner instanceof Map<String, Object>
                ? (Map<String, Object>) parsedInner
                : null;
        } catch (Exception e) {
            return null;
        }
    }
}
