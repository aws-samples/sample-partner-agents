/**
 * Feature: partner-central-chat-agent
 *
 * Shared integration-test scaffolding for ChatAgentControllerTest (task 11).
 *
 * Exposes:
 *   - `HttpCalloutMock` implementations for each flow the integration tests
 *     cover (read, approval, sequenced retry, sandbox routing). Each mock
 *     records the requests it observes so tests can inspect the captured
 *     endpoint, body, and call count without reaching into the platform
 *     request object after `Test.stopTest`.
 *   - Helpers to seed the per-transaction `ConfigProvider.cachedRecord` with
 *     a well-formed `Chat_Agent_Config__mdt` instance so tests bypass the
 *     live SOQL lookup (the `@TestVisible` cache field lets tests inject
 *     config without DML — Custom Metadata Types are not insertable in
 *     Apex tests).
 *   - A helper that creates a test user and assigns the
 *     `Partner_Central_Chat_Agent_User` Permission Set, giving the tests a
 *     `System.runAs` subject whose controller calls will pass the gate.
 *
 * These are INTEGRATION-TEST-ONLY helpers. They are packaged as an
 * `@IsTest` class so they are excluded from production code coverage and
 * from the deployed package surface.
 */
@IsTest
public class ChatAgentIntegrationTestMocks {

    // -----------------------------------------------------------------
    // Config helpers
    // -----------------------------------------------------------------

    /**
     * Builds a production-mode `Chat_Agent_Config__mdt` instance populated
     * with the default values every integration test relies on, and wires
     * it into `ConfigProvider.cachedRecord` so subsequent getters return
     * it without hitting SOQL. Returns the instance so a test can mutate
     * individual fields (e.g., flip `Is_Sandbox__c`) before re-assigning.
     */
    public static Chat_Agent_Config__mdt setupDefaultConfig() {
        Chat_Agent_Config__mdt cfg = new Chat_Agent_Config__mdt(
            DeveloperName                    = 'Default',
            Named_Credential_Name__c         = 'AWS_Partner_Central_MCP',
            Sandbox_Named_Credential_Name__c = 'AWS_Partner_Central_MCP_Sandbox',
            Is_Sandbox__c                    = false,
            Request_Timeout_Seconds__c       = 120,
            Session_Retention_Minutes__c     = 60,
            Max_Attachment_Size_Bytes__c     = 10000000,
            Allowed_Mime_Types__c            = 'application/pdf,image/png',
            Sse_Enabled__c                   = true
        );
        ConfigProvider.cachedRecord = cfg;
        return cfg;
    }

    /**
     * Sandbox-mode variant. Flips `Is_Sandbox__c` and populates the
     * sandbox credential field so `ConfigProvider.getActiveNamedCredentialName()`
     * returns the sandbox credential name.
     */
    public static Chat_Agent_Config__mdt setupSandboxConfig() {
        Chat_Agent_Config__mdt cfg = setupDefaultConfig();
        cfg.Is_Sandbox__c = true;
        ConfigProvider.cachedRecord = cfg;
        return cfg;
    }

    /**
     * Attachment-enabled variant. Populates the three S3 upload config
     * fields so `McpClient.uploadAttachmentToS3` runs instead of failing
     * closed. Returns the instance for further per-test mutation.
     */
    public static Chat_Agent_Config__mdt setupConfigWithS3() {
        Chat_Agent_Config__mdt cfg = setupDefaultConfig();
        cfg.S3_Named_Credential_Name__c = 'AWS_Partner_Central_S3';
        cfg.S3_Bucket_Name__c = 'aws-partner-central-marketplace-ephemeral-writeonly-files';
        cfg.Aws_Account_Id__c = '123456789012';
        ConfigProvider.cachedRecord = cfg;
        return cfg;
    }

    // -----------------------------------------------------------------
    // Permission/user helpers
    // -----------------------------------------------------------------

    /**
     * Creates a Standard-User test user and assigns them the
     * `Partner_Central_Chat_Agent_User` Permission Set so every controller
     * entry point passes the `PermissionGate` check. Using the Standard
     * User profile (rather than System Admin) makes sure the sharing /
     * FLS rules on the feature's custom objects are actually exercised
     * by the Permission Set grants (Req 11.2).
     */
    public static User createUserWithAccess() {
        User u = createTestUser('pcchatuser_');
        assignPermissionSet(u, 'Partner_Central_Chat_Agent_User');
        return u;
    }

    /**
     * Creates a Standard-User test user who is deliberately NOT assigned
     * the `Partner_Central_Chat_Agent_User` Permission Set so the
     * permission-gating test (11.7) can confirm every `@AuraEnabled`
     * method returns an access-denied envelope.
     */
    public static User createUserWithoutAccess() {
        return createTestUser('pcchatdenied_');
    }

    private static User createTestUser(String prefix) {
        Profile stdProfile = [
            SELECT Id FROM Profile WHERE Name = 'Standard User' LIMIT 1
        ];
        // Unique-enough handle for the username/alias so concurrent test
        // runs don't collide on the org's username uniqueness constraint.
        String unique = prefix + String.valueOf(DateTime.now().getTime())
            + String.valueOf(Math.mod(Math.abs(Crypto.getRandomInteger()), 100000));
        User u = new User(
            ProfileId         = stdProfile.Id,
            Username          = unique + '@example.com.invalid',
            Email             = unique + '@example.com',
            FirstName         = 'Chat',
            LastName          = 'Tester',
            Alias             = unique.substring(0, Math.min(8, unique.length())),
            TimeZoneSidKey    = 'America/Los_Angeles',
            LocaleSidKey      = 'en_US',
            EmailEncodingKey  = 'UTF-8',
            LanguageLocaleKey = 'en_US'
        );
        insert u;
        return u;
    }

    private static void assignPermissionSet(User u, String permissionSetName) {
        List<PermissionSet> ps = [
            SELECT Id FROM PermissionSet WHERE Name = :permissionSetName LIMIT 1
        ];
        if (ps.isEmpty()) {
            // The permission set is shipped with the feature; a missing
            // row means the integration test is running against a
            // partially-deployed org.
            return;
        }
        insert new PermissionSetAssignment(
            AssigneeId      = u.Id,
            PermissionSetId = ps[0].Id
        );
    }

    // -----------------------------------------------------------------
    // Mock builders / shared helpers
    // -----------------------------------------------------------------

    /**
     * Builds a minimal SSE body that carries a single `done` frame whose
     * `data` field is a JSON-RPC success response. Used by the read-flow
     * test to stand in for a complete streamed assistant reply.
     */
    public static String buildReadSseBody(String jsonRpcRequestId, String sessionId) {
        Map<String, Object> result = new Map<String, Object>{
            'sessionId' => sessionId,
            'message'   => new Map<String, Object>{
                'role' => 'assistant',
                'text' => 'Here is the data you asked for.'
            }
        };
        String responseJson = JSON.serialize(new Map<String, Object>{
            'jsonrpc' => '2.0',
            'id'      => jsonRpcRequestId,
            'result'  => result
        });
        return 'event: done\n'
            + 'data: ' + responseJson + '\n'
            + '\n';
    }

    /**
     * Builds an SSE body that carries a single `message` frame whose
     * `data` encodes a JSON-RPC response with a nested
     * `result.pendingOperation` map classified as `write`. `McpClient`
     * will register a Pending_Write_Operation__c row for this frame; the
     * test seeds the `operationId` it expects to see back.
     */
    public static String buildApprovalSseBody(
        String jsonRpcRequestId,
        String sessionId,
        String operationId
    ) {
        Map<String, Object> pendingOp = new Map<String, Object>{
            'classification'   => 'write',
            'operationId'      => operationId,
            'method'           => 'opportunity.update',
            'targetResourceId' => 'O-12345',
            'summary'          => 'Update opportunity status to Closed Won.',
            'params'           => new Map<String, Object>{
                'opportunityId' => 'O-12345',
                'status'        => 'Closed Won'
            },
            'fieldDiff' => new Map<String, Object>{
                'status' => new Map<String, Object>{
                    'before' => 'Committed',
                    'after'  => 'Closed Won'
                }
            }
        };
        Map<String, Object> result = new Map<String, Object>{
            'sessionId'        => sessionId,
            'pendingOperation' => pendingOp
        };
        String responseJson = JSON.serialize(new Map<String, Object>{
            'jsonrpc' => '2.0',
            'id'      => jsonRpcRequestId,
            'result'  => result
        });
        return 'event: message\n'
            + 'data: ' + responseJson + '\n'
            + '\n'
            + 'event: done\n'
            + 'data: {"jsonrpc":"2.0","id":"' + jsonRpcRequestId
            + '","result":{"sessionId":"' + sessionId + '"}}\n'
            + '\n';
    }

    /**
     * Builds a minimal JSON-RPC success body used by the approval-path
     * unary confirmation POST. Returned when the controller calls
     * `McpClient.sendExecutionConfirmation` or `sendRejection`.
     */
    public static String buildApprovalConfirmationBody(String jsonRpcRequestId, String sessionId) {
        return JSON.serialize(new Map<String, Object>{
            'jsonrpc' => '2.0',
            'id'      => jsonRpcRequestId,
            'result'  => new Map<String, Object>{
                'sessionId' => sessionId,
                'accepted'  => true
            }
        });
    }

    // -----------------------------------------------------------------
    // Mock classes
    // -----------------------------------------------------------------

    /**
     * HttpCalloutMock for the read-flow integration test: replies with a
     * 200 `text/event-stream` body carrying a single terminal `done` frame.
     *
     * Captures `callCount`, `lastEndpoint`, and `lastBody` so the test can
     * assert the callout was made exactly once at the expected endpoint.
     */
    public class ReadFlowMock implements HttpCalloutMock {
        public Integer callCount = 0;
        public String lastEndpoint;
        public String lastBody;
        public String sessionIdToReturn = 'mcp-session-read-001';

        public HttpResponse respond(HttpRequest req) {
            this.callCount++;
            this.lastEndpoint = req.getEndpoint();
            this.lastBody = req.getBody();

            // Echo back the JSON-RPC id the controller sent so the SSE
            // frame's `result.id` matches — gives the audit row a
            // consistent correlation key.
            String rpcId = extractRpcId(this.lastBody);

            HttpResponse resp = new HttpResponse();
            resp.setStatusCode(200);
            resp.setHeader('Content-Type', 'text/event-stream');
            resp.setBody(buildReadSseBody(rpcId, sessionIdToReturn));
            return resp;
        }
    }

    /**
     * HttpCalloutMock for the approval-flow test. The first callout
     * (agent.invoke) returns the pending-Write_Operation SSE announcement;
     * every subsequent callout (agent.approveOperation /
     * agent.rejectOperation) returns a unary 200 confirmation. All
     * observed requests are recorded in `capturedRequests` so tests can
     * inspect the reused JSON-RPC id / operationId / method on the
     * confirmation POST.
     */
    public class ApprovalFlowMock implements HttpCalloutMock {
        public Integer callCount = 0;
        public List<CapturedRequest> capturedRequests = new List<CapturedRequest>();
        public String sessionIdToReturn = 'mcp-session-approval-001';
        public String operationIdToReturn = 'OP-APPROVE-001';

        public HttpResponse respond(HttpRequest req) {
            this.callCount++;
            CapturedRequest cap = new CapturedRequest();
            cap.endpoint = req.getEndpoint();
            cap.body = req.getBody();
            cap.method = extractMethod(cap.body);
            cap.rpcId = extractRpcId(cap.body);
            this.capturedRequests.add(cap);

            HttpResponse resp = new HttpResponse();
            resp.setStatusCode(200);

            if (this.callCount == 1) {
                // First call: streaming agent.invoke → SSE body announcing
                // the pending write operation.
                resp.setHeader('Content-Type', 'text/event-stream');
                resp.setBody(buildApprovalSseBody(
                    cap.rpcId,
                    sessionIdToReturn,
                    operationIdToReturn
                ));
            } else {
                // Subsequent calls: unary confirmation / rejection POSTs.
                resp.setHeader('Content-Type', 'application/json');
                resp.setBody(buildApprovalConfirmationBody(
                    cap.rpcId,
                    sessionIdToReturn
                ));
            }
            return resp;
        }

        /** Returns the count of callouts matching a given JSON-RPC method. */
        public Integer countCallsWithMethod(String mcpMethod) {
            Integer n = 0;
            for (CapturedRequest c : capturedRequests) {
                if (mcpMethod == c.method) { n++; }
            }
            return n;
        }

        /**
         * Returns the count of callouts whose `params.decision` equals the
         * given value. Use this (not `countCallsWithMethod`) to distinguish
         * approval from rejection now that both share MCP's `sendMessage`.
         */
        public Integer countCallsWithDecision(String decision) {
            Integer n = 0;
            for (CapturedRequest c : capturedRequests) {
                if (decision == extractParamsDecision(c.body)) { n++; }
            }
            return n;
        }
    }

    /**
     * HttpCalloutMock that returns different responses on successive
     * invocations, configured via a list of `SequencedResponse` entries.
     * Used by the transient-5xx-then-retry test (11.6).
     */
    public class SequencedMock implements HttpCalloutMock {
        public Integer callCount = 0;
        public List<CapturedRequest> capturedRequests = new List<CapturedRequest>();
        public List<SequencedResponse> responses = new List<SequencedResponse>();

        public SequencedMock() {}

        public SequencedMock add(Integer status, String contentType, String body) {
            responses.add(new SequencedResponse(status, contentType, body));
            return this;
        }

        public HttpResponse respond(HttpRequest req) {
            this.callCount++;
            CapturedRequest cap = new CapturedRequest();
            cap.endpoint = req.getEndpoint();
            cap.body = req.getBody();
            cap.method = extractMethod(cap.body);
            cap.rpcId = extractRpcId(cap.body);
            this.capturedRequests.add(cap);

            Integer idx = Math.min(this.callCount - 1, responses.size() - 1);
            SequencedResponse seq = responses[idx];
            HttpResponse resp = new HttpResponse();
            resp.setStatusCode(seq.statusCode);
            if (seq.contentType != null) {
                resp.setHeader('Content-Type', seq.contentType);
            }
            if (seq.body != null) {
                resp.setBody(seq.body);
            }
            return resp;
        }
    }

    /**
     * HttpCalloutMock for the sandbox-routing test. Identical to
     * `ReadFlowMock` but captures the endpoint so the test can assert it
     * resolves through the sandbox Named Credential (the `callout:`
     * URL prefix names the active credential per Apex semantics).
     */
    public class SandboxRoutingMock implements HttpCalloutMock {
        public Integer callCount = 0;
        public String lastEndpoint;
        public String sessionIdToReturn = 'mcp-session-sandbox-001';

        public HttpResponse respond(HttpRequest req) {
            this.callCount++;
            this.lastEndpoint = req.getEndpoint();

            String rpcId = extractRpcId(req.getBody());

            HttpResponse resp = new HttpResponse();
            resp.setStatusCode(200);
            resp.setHeader('Content-Type', 'text/event-stream');
            resp.setBody(buildReadSseBody(rpcId, sessionIdToReturn));
            return resp;
        }
    }

    /**
     * HttpCalloutMock for the attachment-upload flow. Routes by HTTP
     * method so call ordering doesn't matter: a `PUT` is treated as the
     * S3 PutObject (returns 200 with an `x-amz-version-id` header), and a
     * `POST` is treated as the MCP `sendMessage` (returns the read SSE
     * body). Records every request so tests can assert the S3 PUT
     * happened and the sendMessage body carried the `document` block.
     */
    public class AttachmentFlowMock implements HttpCalloutMock {
        public Integer putCount = 0;
        public Integer postCount = 0;
        public List<CapturedRequest> capturedRequests = new List<CapturedRequest>();
        public String versionIdToReturn = 'v-0001-abc';
        public String sessionIdToReturn = 'mcp-session-attach-001';

        public HttpResponse respond(HttpRequest req) {
            CapturedRequest cap = new CapturedRequest();
            cap.endpoint = req.getEndpoint();
            cap.body = req.getBody();
            cap.method = extractMethod(cap.body);
            cap.rpcId = extractRpcId(cap.body);
            this.capturedRequests.add(cap);

            HttpResponse resp = new HttpResponse();
            if (req.getMethod() == 'PUT') {
                // S3 PutObject on a versioned bucket.
                this.putCount++;
                resp.setStatusCode(200);
                resp.setHeader('x-amz-version-id', versionIdToReturn);
                resp.setBody('');
                return resp;
            }
            // MCP sendMessage callout.
            this.postCount++;
            String rpcId = extractRpcId(cap.body);
            resp.setStatusCode(200);
            resp.setHeader('Content-Type', 'text/event-stream');
            resp.setBody(buildReadSseBody(rpcId, sessionIdToReturn));
            return resp;
        }

        /** True when at least one PUT carried the document bytes. */
        public Boolean sawPut() {
            return this.putCount > 0;
        }

        /** Returns the last sendMessage (POST) body, or null. */
        public String lastSendMessageBody() {
            for (Integer i = capturedRequests.size() - 1; i >= 0; i--) {
                if (capturedRequests[i].endpoint != null
                    && capturedRequests[i].endpoint.contains('AWS_Partner_Central_MCP')) {
                    return capturedRequests[i].body;
                }
            }
            return null;
        }
    }

    // -----------------------------------------------------------------
    // Capture / sequencing value types
    // -----------------------------------------------------------------

    /**
     * Value object describing a request observed by any of the mocks.
     * Captures just the fields the integration tests assert on so the
     * tests don't have to re-parse the request body themselves.
     */
    public class CapturedRequest {
        public String endpoint;
        public String body;
        public String method;  // JSON-RPC method name (e.g. agent.invoke)
        public String rpcId;   // JSON-RPC request id
    }

    /** Scripted response used by `SequencedMock`. */
    public class SequencedResponse {
        public Integer statusCode;
        public String contentType;
        public String body;

        public SequencedResponse(Integer statusCode, String contentType, String body) {
            this.statusCode = statusCode;
            this.contentType = contentType;
            this.body = body;
        }
    }

    // -----------------------------------------------------------------
    // Private body inspection helpers
    // -----------------------------------------------------------------

    /** Best-effort JSON-RPC id extractor; returns null on any parse failure. */
    public static String extractRpcId(String body) {
        return (String) extractStringField(body, 'id');
    }

    /** Best-effort JSON-RPC method extractor; returns null on any parse failure. */
    public static String extractMethod(String body) {
        return (String) extractStringField(body, 'method');
    }

    /**
     * Reads the opportunity identifier from a request body, probing all
     * historical request shapes:
     *   1. `params.operationId` (legacy flat shape)
     *   2. `params.arguments.operationId` (first tools/call refactor)
     *   3. `params.arguments.content[*].toolUseId` (current MCP shape)
     * Used by the approval-flow test to assert the confirmation POST
     * reuses the original operationId (Req 9.4).
     */
    public static String extractParamsOperationId(String body) {
        if (String.isBlank(body)) { return null; }
        try {
            Object parsed = JSON.deserializeUntyped(body);
            if (!(parsed instanceof Map<String, Object>)) { return null; }
            Object params = ((Map<String, Object>) parsed).get('params');
            if (!(params instanceof Map<String, Object>)) { return null; }
            Map<String, Object> paramsMap = (Map<String, Object>) params;
            Object opId = paramsMap.get('operationId');
            if (opId instanceof String) { return (String) opId; }
            Object args = paramsMap.get('arguments');
            if (args instanceof Map<String, Object>) {
                Map<String, Object> argMap = (Map<String, Object>) args;
                Object nested = argMap.get('operationId');
                if (nested instanceof String) { return (String) nested; }
                Object content = argMap.get('content');
                if (content instanceof List<Object>) {
                    for (Object raw : (List<Object>) content) {
                        if (!(raw instanceof Map<String, Object>)) { continue; }
                        Object toolUseId = ((Map<String, Object>) raw).get('toolUseId');
                        if (toolUseId instanceof String) {
                            return (String) toolUseId;
                        }
                    }
                }
            }
            return null;
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Reads the JSON-RPC decision field ('approved'/'rejected' for
     * legacy callers, or 'approve'/'reject' when sent as an MCP
     * `tool_approval_response` content block) from a request body.
     * Probes the following locations so the helper works for all
     * historical and current request shapes:
     *   1. `params.decision` (earliest legacy shape)
     *   2. `params.arguments.decision` (first tools/call refactor)
     *   3. `params.arguments.content[*].decision` (current MCP shape)
     * Returns the first match normalised to the original string, or
     * null when no decision field is present.
     */
    public static String extractParamsDecision(String body) {
        if (String.isBlank(body)) { return null; }
        try {
            Object parsed = JSON.deserializeUntyped(body);
            if (!(parsed instanceof Map<String, Object>)) { return null; }
            Object params = ((Map<String, Object>) parsed).get('params');
            if (!(params instanceof Map<String, Object>)) { return null; }
            Map<String, Object> paramsMap = (Map<String, Object>) params;
            Object dec = paramsMap.get('decision');
            if (dec instanceof String) { return (String) dec; }
            Object args = paramsMap.get('arguments');
            if (args instanceof Map<String, Object>) {
                Map<String, Object> argMap = (Map<String, Object>) args;
                Object nested = argMap.get('decision');
                if (nested instanceof String) { return (String) nested; }
                Object content = argMap.get('content');
                if (content instanceof List<Object>) {
                    for (Object raw : (List<Object>) content) {
                        if (!(raw instanceof Map<String, Object>)) { continue; }
                        Object blockDec = ((Map<String, Object>) raw).get('decision');
                        if (blockDec instanceof String) {
                            return (String) blockDec;
                        }
                    }
                }
            }
            return null;
        } catch (Exception e) {
            return null;
        }
    }

    /** Reads a top-level String field from a JSON body; null on failure. */
    private static Object extractStringField(String body, String fieldName) {
        if (String.isBlank(body)) { return null; }
        try {
            Object parsed = JSON.deserializeUntyped(body);
            if (!(parsed instanceof Map<String, Object>)) { return null; }
            Object v = ((Map<String, Object>) parsed).get(fieldName);
            return v instanceof String ? v : null;
        } catch (Exception e) {
            return null;
        }
    }
}
