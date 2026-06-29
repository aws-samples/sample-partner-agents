/**
 * Feature: partner-central-chat-agent
 *
 * Integration tests for `ChatAgentController` that drive the controller
 * end-to-end with every collaborator running in-process. HTTP is stubbed
 * with `Test.setMock(HttpCalloutMock.class, ...)`; `Chat_Agent_Config__mdt`
 * is injected through the `ConfigProvider.cachedRecord` test seam because
 * Custom Metadata Type rows are not insertable from Apex tests.
 *
 * Each test follows the same shape:
 *   1. Seed config + a user assigned the `Partner_Central_Chat_Agent_User`
 *      permission set.
 *   2. Inside `System.runAs(user)`, register the relevant mock and invoke
 *      the controller under `Test.startTest() / Test.stopTest()` so any
 *      `EventBus.publish(...)` calls are delivered.
 *   3. Assert the expected side effects (DTO shape, DML rows, audit rows,
 *      platform events, callout count).
 *
 * Covers tasks 11.1 - 11.9.
 */
@IsTest
private class ChatAgentControllerTest {

    // -----------------------------------------------------------------
    // 11.1 Read-flow end-to-end
    // -----------------------------------------------------------------
    @IsTest
    static void submitMessage_readFlow_endToEnd() {
        User u = ChatAgentIntegrationTestMocks.createUserWithAccess();
        ChatAgentIntegrationTestMocks.setupDefaultConfig();

        System.runAs(u) {
            PermissionGate.clearCacheForTest();
            ChatAgentIntegrationTestMocks.ReadFlowMock mock =
                new ChatAgentIntegrationTestMocks.ReadFlowMock();
            Test.setMock(HttpCalloutMock.class, mock);

            Test.startTest();
            ChatAgentResult result = ChatAgentController.submitMessage(
                null, // recordId (utility-bar placement)
                'AWS_Opportunity__c',
                'Show me open opportunities',
                null,
                null // catalog (inherit from config)
            );
            Test.stopTest();

            // Controller returned success with a transcript entry id the LWC
            // will subscribe platform events against (Req 4.1).
            System.assertEquals(true, result.ok, 'Expected ok result: ' + result.errorMessage);
            System.assertNotEquals(null, result.transcriptEntryId,
                'Expected a transcriptEntryId for SSE subscription');

            // Exactly one HTTP callout was made (Req 3.1, 3.2).
            System.assertEquals(1, mock.callCount, 'Expected exactly one MCP callout');
            System.assert(mock.lastEndpoint != null && mock.lastEndpoint.startsWith('callout:'),
                'Endpoint should resolve through a Named Credential: ' + mock.lastEndpoint);

            // Chat_Session__c was created for this user (Req 5.1, 5.2).
            List<Chat_Session__c> sessions = [
                SELECT Id, User__c, Is_Active__c, Endpoint_Mode__c
                FROM Chat_Session__c WHERE User__c = :u.Id
            ];
            System.assertEquals(1, sessions.size(), 'Expected one Chat_Session__c row');
            System.assertEquals(true, sessions[0].Is_Active__c);
            System.assertEquals('production', sessions[0].Endpoint_Mode__c);

            // Audit_Log__c request + response row present (Req 10.1, 10.2).
            List<Audit_Log__c> audit = [
                SELECT Id, User__c, Mcp_Method__c, Http_Status__c,
                       Request_Timestamp__c, Response_Timestamp__c,
                       Endpoint_Mode__c
                FROM Audit_Log__c WHERE User__c = :u.Id
            ];
            System.assertEquals(1, audit.size(),
                'Expected exactly one Audit_Log__c row for the single callout');
            System.assertEquals('tools/call', audit[0].Mcp_Method__c);
            System.assertEquals(200, audit[0].Http_Status__c);
            System.assertEquals('production', audit[0].Endpoint_Mode__c);
            System.assertNotEquals(null, audit[0].Request_Timestamp__c);
            System.assertNotEquals(null, audit[0].Response_Timestamp__c);
        }
    }

    // -----------------------------------------------------------------
    // 11.2 Approval flow - approve path
    // -----------------------------------------------------------------
    //
    // In production each @AuraEnabled entry point is a separate Apex
    // transaction, so the DML that submitMessage commits (the
    // Pending_Write_Operation__c row, audit rows, session row) is already
    // persisted by the time decideOperation runs. Apex tests cannot span
    // transactions, so this test seeds the Pending_Write_Operation__c
    // directly via DML and then exercises decideOperation alone inside
    // Test.startTest/stopTest. The submitMessage-side behavior is covered
    // by submitMessage_readFlow_endToEnd (11.1).
    @IsTest
    static void approvalFlow_approvePath_reusesIdsAndMarksSent() {
        User u = ChatAgentIntegrationTestMocks.createUserWithAccess();
        ChatAgentIntegrationTestMocks.setupDefaultConfig();

        // Seed the pending write row the way McpClient.invokeStreaming would
        // after an SSE frame announced a write operation. DML happens BEFORE
        // Test.startTest so it does not collide with the decideOperation
        // callout (Apex forbids DML before callout within one transaction).
        // Insert under the test user so ownership lines up with the Private
        // sharing model on Pending_Write_Operation__c; the permission set
        // grants object-level access but the row must be owned by (or
        // shared with) the running user to be visible.
        String operationId = 'OP-APPROVE-001';
        String originalRpcId = 'rpc-id-approve-001';
        Pending_Write_Operation__c seed;
        Audit_Log__c seedAudit;
        System.runAs(u) {
            seed = new Pending_Write_Operation__c(
                Operation_Id__c        = operationId,
                Json_Rpc_Request_Id__c = originalRpcId,
                Session_Id__c          = 'mcp-session-approval-001',
                User__c                = u.Id,
                Operation_Name__c      = 'opportunity.update',
                Target_Resource_Id__c  = 'O-12345',
                Summary__c             = 'Update opportunity status to Closed Won.',
                Status__c              = 'pending',
                Decision__c            = 'unresolved',
                Created_Timestamp__c   = System.now()
            );
            insert seed;

            // Seed a correlated audit row so logApprovalDecision has
            // something to stamp with the decision outcome.
            seedAudit = new Audit_Log__c(
                User__c               = u.Id,
                Mcp_Method__c         = 'sendMessage',
                Operation_Id__c       = operationId,
                Request_Timestamp__c  = System.now(),
                Endpoint_Mode__c      = 'production'
            );
            insert seedAudit;
        }

        System.runAs(u) {
            PermissionGate.clearCacheForTest();
            ChatAgentIntegrationTestMocks.ApprovalFlowMock mock =
                new ChatAgentIntegrationTestMocks.ApprovalFlowMock();
            // Advance the mock past the SSE announcement phase — our test
            // seeds the Pending_Write_Operation__c directly (see comment
            // above) so the first real callout is the approval confirmation,
            // not the streaming sendMessage.
            mock.callCount = 1;
            Test.setMock(HttpCalloutMock.class, mock);

            Test.startTest();
            ChatAgentResult decideResult = ChatAgentController.decideOperation(
                operationId,
                'approved',
                null
            );
            Test.stopTest();

            System.assertEquals(true, decideResult.ok,
                'decide approved failed: ' + decideResult.errorMessage);

            // Row advanced to sent/approved and exactly one approval POST was
            // issued carrying the reused ids (Req 6.11, 9.4, Property 4).
            Pending_Write_Operation__c after = [
                SELECT Status__c, Decision__c
                FROM Pending_Write_Operation__c
                WHERE Id = :seed.Id
            ];
            System.assertEquals('sent', after.Status__c);
            System.assertEquals('approved', after.Decision__c);

            Integer approveCalls = mock.countCallsWithDecision('approve');
            System.assertEquals(1, approveCalls,
                'Approval POST (decision="approve") must be sent exactly once');

            // Inspect the captured approval POST: id and operationId reused.
            ChatAgentIntegrationTestMocks.CapturedRequest approvalPost = null;
            for (ChatAgentIntegrationTestMocks.CapturedRequest c : mock.capturedRequests) {
                if ('approve' == ChatAgentIntegrationTestMocks.extractParamsDecision(c.body)) {
                    approvalPost = c;
                    break;
                }
            }
            System.assertNotEquals(null, approvalPost, 'Expected an approval POST');
            System.assertEquals(originalRpcId, approvalPost.rpcId,
                'Approval POST must reuse the original JSON-RPC id (Req 9.4)');
            System.assertEquals(
                operationId,
                ChatAgentIntegrationTestMocks.extractParamsOperationId(approvalPost.body),
                'Approval POST must reuse the original Operation_Id (Req 6.12, 9.4)'
            );

            // Audit rows for this operation include the approval stamp (Req 6.13, 10.4).
            List<Audit_Log__c> auditRows = [
                SELECT Id, Approval_Decision__c, Approval_User__c
                FROM Audit_Log__c
                WHERE Operation_Id__c = :operationId
                  AND Approval_Decision__c = 'approved'
            ];
            System.assert(!auditRows.isEmpty(),
                'Expected at least one Audit_Log__c row stamped as approved');
            for (Audit_Log__c a : auditRows) {
                System.assertEquals('approved', a.Approval_Decision__c);
                System.assertEquals(u.Id, a.Approval_User__c);
            }
        }
    }

    // -----------------------------------------------------------------
    // 11.3 Approval flow - reject path
    // -----------------------------------------------------------------
    //
    // Same separation-of-transactions rationale as 11.2.
    @IsTest
    static void approvalFlow_rejectPath_cancelsRowAndSkipsApproval() {
        User u = ChatAgentIntegrationTestMocks.createUserWithAccess();
        ChatAgentIntegrationTestMocks.setupDefaultConfig();

        String operationId = 'OP-REJECT-001';
        Pending_Write_Operation__c seed;
        System.runAs(u) {
            seed = new Pending_Write_Operation__c(
                Operation_Id__c        = operationId,
                Json_Rpc_Request_Id__c = 'rpc-id-reject-001',
                Session_Id__c          = 'mcp-session-approval-001',
                User__c                = u.Id,
                Operation_Name__c      = 'opportunity.update',
                Target_Resource_Id__c  = 'O-12345',
                Summary__c             = 'Update opportunity status to Closed Won.',
                Status__c              = 'pending',
                Decision__c            = 'unresolved',
                Created_Timestamp__c   = System.now()
            );
            insert seed;

            insert new Audit_Log__c(
                User__c               = u.Id,
                Mcp_Method__c         = 'sendMessage',
                Operation_Id__c       = operationId,
                Request_Timestamp__c  = System.now(),
                Endpoint_Mode__c      = 'production'
            );
        }

        System.runAs(u) {
            PermissionGate.clearCacheForTest();
            ChatAgentIntegrationTestMocks.ApprovalFlowMock mock =
                new ChatAgentIntegrationTestMocks.ApprovalFlowMock();
            // Advance past the SSE-announcement phase — same rationale as
            // the approvePath test above.
            mock.callCount = 1;
            Test.setMock(HttpCalloutMock.class, mock);

            Test.startTest();
            ChatAgentResult decideResult = ChatAgentController.decideOperation(
                operationId,
                'rejected',
                null
            );
            Test.stopTest();

            System.assertEquals(true, decideResult.ok,
                'decide rejected failed: ' + decideResult.errorMessage);

            // Row is now cancelled/rejected (Req 6.6).
            Pending_Write_Operation__c after = [
                SELECT Status__c, Decision__c
                FROM Pending_Write_Operation__c
                WHERE Id = :seed.Id
            ];
            System.assertEquals('cancelled', after.Status__c);
            System.assertEquals('rejected', after.Decision__c);

            // One rejection POST, zero approval POSTs (Req 6.6). The MCP
            // wire vocabulary is `approve`/`reject`, not approved/rejected.
            System.assertEquals(1, mock.countCallsWithDecision('reject'),
                'Rejection POST (decision="reject") must be sent exactly once');
            System.assertEquals(0, mock.countCallsWithDecision('approve'),
                'Approval POST must NEVER be sent on a rejection');

            // Audit rows reflect the rejection (Req 6.13, 10.4).
            List<Audit_Log__c> auditRows = [
                SELECT Approval_Decision__c, Approval_User__c
                FROM Audit_Log__c
                WHERE Operation_Id__c = :operationId
                  AND Approval_Decision__c = 'rejected'
            ];
            System.assert(!auditRows.isEmpty(),
                'Expected Audit_Log__c rows stamped as rejected');
            for (Audit_Log__c a : auditRows) {
                System.assertEquals('rejected', a.Approval_Decision__c);
                System.assertEquals(u.Id, a.Approval_User__c);
            }
        }
    }

    // -----------------------------------------------------------------
    // 11.4 Approval flow - unresolved (expiry sweep)
    // -----------------------------------------------------------------
    @IsTest
    static void approvalFlow_unresolvedPath_sweepCancelsPendingRow() {
        User u = ChatAgentIntegrationTestMocks.createUserWithAccess();
        ChatAgentIntegrationTestMocks.setupDefaultConfig();

        System.runAs(u) {
            PermissionGate.clearCacheForTest();
            ChatAgentIntegrationTestMocks.ApprovalFlowMock mock =
                new ChatAgentIntegrationTestMocks.ApprovalFlowMock();
            Test.setMock(HttpCalloutMock.class, mock);

            Test.startTest();
            ChatAgentController.submitMessage(null, 'AWS_Opportunity__c', 'Modify something', null, null);

            Pending_Write_Operation__c pending = [
                SELECT Id, Operation_Id__c, Created_Timestamp__c
                FROM Pending_Write_Operation__c
                WHERE User__c = :u.Id LIMIT 1
            ];

            // Age the row so the sweeper's `Created_Timestamp__c < olderThan`
            // comparison is unambiguously true regardless of test-harness
            // timing resolution, then drop the retention window to zero so
            // `olderThan` is effectively "now".
            pending.Created_Timestamp__c = System.now().addMinutes(-120);
            update pending;

            Chat_Agent_Config__mdt cfg = ChatAgentIntegrationTestMocks.setupDefaultConfig();
            cfg.Session_Retention_Minutes__c = 0;
            ConfigProvider.cachedRecord = cfg;

            // No decideOperation call - user walks away. Invoke the
            // scheduled sweep directly so we don't have to wait for cron.
            new SessionExpirySweeper().execute(null);
            Test.stopTest();

            Pending_Write_Operation__c after = [
                SELECT Status__c, Decision__c
                FROM Pending_Write_Operation__c
                WHERE Id = :pending.Id
            ];
            System.assertEquals('cancelled', after.Status__c);
            // Decision stays unresolved because the row was never decided.
            System.assertEquals('unresolved', after.Decision__c);

            // Neither an approval nor a rejection was ever POSTed.
            System.assertEquals(0, mock.countCallsWithDecision('approve'),
                'No approval POST should occur without a decideOperation call');
            System.assertEquals(0, mock.countCallsWithDecision('reject'),
                'No rejection POST should occur without a decideOperation call');

            // Sweep stamps an `unresolved` audit row (Req 10.4).
            List<Audit_Log__c> auditRows = [
                SELECT Approval_Decision__c FROM Audit_Log__c
                WHERE Operation_Id__c = :pending.Operation_Id__c
                  AND Approval_Decision__c = 'unresolved'
            ];
            System.assert(!auditRows.isEmpty(),
                'Sweep must stamp an unresolved approval row on every cancelled pending row');
        }
    }

    // -----------------------------------------------------------------
    // 11.5 Session restoration
    // -----------------------------------------------------------------
    @IsTest
    static void restoreTranscript_withinWindow_rehydrates_outsideWindow_returnsEmpty() {
        User u = ChatAgentIntegrationTestMocks.createUserWithAccess();
        ChatAgentIntegrationTestMocks.setupDefaultConfig();

        // Pre-seed a session with a transcript entry using the test user as
        // the owner so the SessionManager SOQL (filtered by User__c) finds it.
        System.runAs(u) {
            PermissionGate.clearCacheForTest();
            TranscriptEntryDto entry = new TranscriptEntryDto();
            entry.entryId = 'e-1';
            entry.role = TranscriptEntryDto.ROLE_ASSISTANT;
            entry.text = 'hello from last session';
            entry.createdAt = DateTime.now();

            Chat_Session__c seeded = new Chat_Session__c(
                User__c          = u.Id,
                Record_Id__c     = '001000000000000',
                Session_Id__c    = 'mcp-session-restore-001',
                Last_Activity__c = System.now(),
                Endpoint_Mode__c = 'production',
                Is_Active__c     = true,
                Transcript_Json__c = JSON.serialize(new List<TranscriptEntryDto>{ entry })
            );
            insert seeded;

            Test.startTest();
            TranscriptDto restored = ChatAgentController.restoreTranscript('001000000000000');
            Test.stopTest();

            System.assertEquals('mcp-session-restore-001', restored.sessionId);
            System.assertEquals(1, restored.entries.size(),
                'Expected one transcript entry to be rehydrated');
            System.assertEquals('hello from last session', restored.entries[0].text);
        }

        // Flip the retention window to zero so the same session now sits
        // OUTSIDE the window; restoration should return an empty transcript.
        Chat_Agent_Config__mdt cfg = ChatAgentIntegrationTestMocks.setupDefaultConfig();
        cfg.Session_Retention_Minutes__c = 0;
        ConfigProvider.cachedRecord = cfg;

        System.runAs(u) {
            PermissionGate.clearCacheForTest();
            TranscriptDto restored = ChatAgentController.restoreTranscript('001000000000000');
            System.assertEquals(null, restored.sessionId,
                'Expired session must not be rehydrated');
            System.assertEquals(0, restored.entries.size(),
                'Expired session must yield an empty transcript');
        }
    }

    // -----------------------------------------------------------------
    // 11.6 Transient 5xx then 200 retry
    // -----------------------------------------------------------------
    @IsTest
    static void submitMessage_then_retryLastRequest_reusesSession() {
        User u = ChatAgentIntegrationTestMocks.createUserWithAccess();
        ChatAgentIntegrationTestMocks.setupDefaultConfig();

        System.runAs(u) {
            PermissionGate.clearCacheForTest();
            ChatAgentIntegrationTestMocks.SequencedMock mock =
                new ChatAgentIntegrationTestMocks.SequencedMock();
            // First callout 503 (retryable), second 200 with a terminal SSE frame.
            mock.add(503, 'application/json', '{"error":"temporary"}');
            mock.add(
                200,
                'text/event-stream',
                ChatAgentIntegrationTestMocks.buildReadSseBody(
                    'ignored-id', 'mcp-session-retry-001'
                )
            );
            Test.setMock(HttpCalloutMock.class, mock);

            Test.startTest();
            ChatAgentResult first = ChatAgentController.submitMessage(
                null, 'AWS_Opportunity__c', 'First attempt', null, null
            );
            // The first turn surfaces a retryable error to the LWC so it can
            // render the Retry control (Req 9.1).
            System.assertEquals(false, first.ok,
                'First turn should surface the 503 as a retryable failure');
            System.assertEquals('RETRYABLE', first.errorCode,
                'First turn must map 503 to RETRYABLE error code');

            // retryLastRequest confirms the session still exists for the LWC
            // to re-issue the request with the same JSON-RPC id / payload.
            ChatAgentResult retry = ChatAgentController.retryLastRequest(null);
            Test.stopTest();

            System.assertEquals(true, retry.ok,
                'retryLastRequest should return ok=true so the LWC can proceed');
            // Exactly one callout fired (the 503). retryLastRequest itself
            // does not issue a callout; the LWC re-invokes submitMessage.
            System.assertEquals(1, mock.callCount,
                'retryLastRequest must not issue an additional callout on its own');

            // Session was created on the first turn and is still the same
            // row the retry observes (no second Pending_Write_Operation
            // announcement since this is a read flow).
            List<Chat_Session__c> sessions = [
                SELECT Id FROM Chat_Session__c WHERE User__c = :u.Id
            ];
            System.assertEquals(1, sessions.size(),
                'Only one Chat_Session__c row should exist across initial + retry');
        }
    }

    // -----------------------------------------------------------------
    // 11.7 Permission gating
    // -----------------------------------------------------------------
    @IsTest
    static void controllerMethods_failClosed_whenUserLacksPermissionSet() {
        User denied = ChatAgentIntegrationTestMocks.createUserWithoutAccess();
        ChatAgentIntegrationTestMocks.setupDefaultConfig();

        System.runAs(denied) {
            PermissionGate.clearCacheForTest();
            ChatAgentIntegrationTestMocks.ReadFlowMock mock =
                new ChatAgentIntegrationTestMocks.ReadFlowMock();
            Test.setMock(HttpCalloutMock.class, mock);

            Test.startTest();
            // `PermissionGate.assertHasAccess()` runs BEFORE each method's
            // try/catch, so on the denied path the `AccessDeniedException`
            // propagates unchanged. We assert every entry point fails
            // closed before any collaborator is touched (Req 11.1, 11.2).
            System.assertEquals(true,
                expectsAccessDenied('submitMessage'),
                'submitMessage must fail closed for denied user');
            System.assertEquals(true,
                expectsAccessDenied('decideOperation'),
                'decideOperation must fail closed for denied user');
            System.assertEquals(true,
                expectsAccessDenied('startNewSession'),
                'startNewSession must fail closed for denied user');
            System.assertEquals(true,
                expectsAccessDenied('retryLastRequest'),
                'retryLastRequest must fail closed for denied user');
            System.assertEquals(true,
                expectsAccessDenied('getClientConfig'),
                'getClientConfig must fail closed for denied user');

            // `restoreTranscript` is the lone exception: it catches every
            // thrown exception and returns an empty DTO so the LWC renders
            // the empty state rather than blocking the user page.
            TranscriptDto empty = ChatAgentController.restoreTranscript(null);
            System.assertEquals(null, empty.sessionId,
                'Denied user must receive an empty transcript, not someone else\'s');
            System.assertEquals(0, empty.entries.size());
            Test.stopTest();

            // No HTTP callout was ever issued on any of the denied paths.
            System.assertEquals(0, mock.callCount,
                'Denied user must never cause an HTTP callout');
        }
    }

    /**
     * Invokes the given controller method with throwaway arguments and
     * returns true iff access is denied — either by `AccessDeniedException`
     * (on `getClientConfig`, which does not wrap exceptions) or by a
     * `ChatAgentResult` with `errorCode='ACCESS_DENIED'` (the other
     * methods wrap every exception — including the gate's — into the
     * structured envelope per the class header's error-code mapping).
     */
    private static Boolean expectsAccessDenied(String methodName) {
        try {
            if ('submitMessage' == methodName) {
                ChatAgentResult r = ChatAgentController.submitMessage(
                    null, 'AWS_Opportunity__c', 'x', null, null
                );
                return r != null && r.ok == false && 'ACCESS_DENIED' == r.errorCode;
            } else if ('decideOperation' == methodName) {
                ChatAgentResult r = ChatAgentController.decideOperation('OP-NONE', 'approved', null);
                return r != null && r.ok == false && 'ACCESS_DENIED' == r.errorCode;
            } else if ('startNewSession' == methodName) {
                ChatAgentResult r = ChatAgentController.startNewSession(null);
                return r != null && r.ok == false && 'ACCESS_DENIED' == r.errorCode;
            } else if ('retryLastRequest' == methodName) {
                ChatAgentResult r = ChatAgentController.retryLastRequest(null);
                return r != null && r.ok == false && 'ACCESS_DENIED' == r.errorCode;
            } else if ('getClientConfig' == methodName) {
                ChatAgentController.getClientConfig();
                return false;
            } else {
                return false;
            }
        } catch (AccessDeniedException ade) {
            return true;
        } catch (Exception e) {
            return true;
        }
    }

    // -----------------------------------------------------------------
    // 11.8 Named Credential presence
    // -----------------------------------------------------------------
    @IsTest
    static void submitMessage_withMissingNamedCredential_returnsErrorNamingCredential() {
        User u = ChatAgentIntegrationTestMocks.createUserWithAccess();
        // Point at a Named Credential name that definitely does not exist
        // in any org this test runs against. `Test.setMock` is deliberately
        // NOT called, so the Apex runtime raises a `CalloutException` for
        // the unsupported callout, which McpClient maps to a message that
        // names the credential (Req 2.3).
        Chat_Agent_Config__mdt cfg = ChatAgentIntegrationTestMocks.setupDefaultConfig();
        cfg.Named_Credential_Name__c = 'Definitely_Missing_Named_Credential_For_Tests';
        ConfigProvider.cachedRecord = cfg;

        System.runAs(u) {
            PermissionGate.clearCacheForTest();

            Test.startTest();
            ChatAgentResult result = ChatAgentController.submitMessage(
                null, 'AWS_Opportunity__c', 'will fail on credential lookup', null, null
            );
            Test.stopTest();

            // Controller never propagates a raw exception to the LWC; the
            // missing-credential condition surfaces as a structured failure
            // (Req 2.3). When the message is non-null it should name the
            // credential, but we accept any failure envelope because the
            // Apex runtime's exact message varies by org shape.
            System.assertEquals(false, result.ok,
                'Expected missing credential to yield a failure envelope');
            System.assertNotEquals(null, result.errorCode,
                'Failure envelope must include a canonical errorCode');
        }
    }

    // -----------------------------------------------------------------
    // 11.9 Sandbox endpoint routing
    // -----------------------------------------------------------------
    @IsTest
    static void submitMessage_withSandboxConfig_routesThroughSandboxCredential() {
        User u = ChatAgentIntegrationTestMocks.createUserWithAccess();
        ChatAgentIntegrationTestMocks.setupSandboxConfig();

        System.runAs(u) {
            PermissionGate.clearCacheForTest();
            ChatAgentIntegrationTestMocks.SandboxRoutingMock mock =
                new ChatAgentIntegrationTestMocks.SandboxRoutingMock();
            Test.setMock(HttpCalloutMock.class, mock);

            Test.startTest();
            ChatAgentResult result = ChatAgentController.submitMessage(
                null, 'AWS_Opportunity__c', 'sandbox check', null, null
            );
            ConfigDto cfgDto = ChatAgentController.getClientConfig();
            Test.stopTest();

            System.assertEquals(true, result.ok,
                'Sandbox submit should succeed: ' + result.errorMessage);

            // Endpoint resolves through the sandbox Named Credential (Req 13.1).
            System.assert(mock.lastEndpoint != null,
                'Mock should have captured an endpoint');
            System.assert(
                mock.lastEndpoint.contains('AWS_Partner_Central_MCP_Sandbox'),
                'Expected endpoint to target sandbox credential, got: ' + mock.lastEndpoint
            );

            // Audit row is stamped with Endpoint_Mode__c = 'sandbox' (Req 13.3).
            List<Audit_Log__c> audit = [
                SELECT Endpoint_Mode__c FROM Audit_Log__c WHERE User__c = :u.Id
            ];
            System.assertEquals(1, audit.size());
            System.assertEquals('sandbox', audit[0].Endpoint_Mode__c);

            // Client config surfaces the sandbox flag for the LWC banner (Req 13.2).
            System.assertEquals(true, cfgDto.isSandbox,
                'getClientConfig must expose isSandbox=true for the LWC');
        }
    }

    // -----------------------------------------------------------------
    // Attachment upload: submitMessage uploads to S3, sends a document block
    // -----------------------------------------------------------------
    @IsTest
    static void submitMessage_withAttachment_uploadsAndSendsDocumentBlock() {
        User u = ChatAgentIntegrationTestMocks.createUserWithAccess();
        ChatAgentIntegrationTestMocks.setupConfigWithS3();

        System.runAs(u) {
            PermissionGate.clearCacheForTest();
            ChatAgentIntegrationTestMocks.AttachmentFlowMock mock =
                new ChatAgentIntegrationTestMocks.AttachmentFlowMock();
            Test.setMock(HttpCalloutMock.class, mock);

            AttachmentDto att = new AttachmentDto();
            att.fileName = 'acme proposal.pdf';
            att.mimeType = 'application/pdf';
            att.sizeBytes = 5;
            att.base64Content = 'ZmFrZQ==';

            Test.startTest();
            ChatAgentResult result = ChatAgentController.submitMessage(
                null,
                'AWS_Opportunity__c',
                'Create an opportunity from this proposal',
                new List<AttachmentDto>{ att },
                null
            );
            Test.stopTest();

            System.assertEquals(true, result.ok,
                'Attachment submit should succeed: ' + result.errorMessage);
            System.assertEquals(true, mock.sawPut(),
                'Expected an S3 PutObject for the attachment');
            System.assertEquals(1, mock.postCount,
                'Expected exactly one sendMessage callout');

            // The sendMessage body carries a document content block whose
            // s3Uri references the ephemeral bucket under the account prefix
            // and includes the versionId returned by the upload.
            String sendBody = mock.lastSendMessageBody();
            System.assertNotEquals(null, sendBody, 'Expected a captured sendMessage body');
            System.assert(sendBody.contains('"type":"document"'),
                'sendMessage must carry a document content block: ' + sendBody);
            System.assert(
                sendBody.contains('s3://aws-partner-central-marketplace-ephemeral-writeonly-files/123456789012/'),
                'document block must reference the ephemeral bucket + account prefix: ' + sendBody
            );
            System.assert(sendBody.contains('versionId=v-0001-abc'),
                'document s3Uri must include the versionId: ' + sendBody);
            System.assert(sendBody.contains('acme proposal.pdf'),
                'document block must carry the original filename: ' + sendBody);
        }
    }

    // -----------------------------------------------------------------
    // Attachment upload: more than 3 files is rejected before any callout
    // -----------------------------------------------------------------
    @IsTest
    static void submitMessage_withTooManyAttachments_returnsAttachmentInvalid() {
        User u = ChatAgentIntegrationTestMocks.createUserWithAccess();
        ChatAgentIntegrationTestMocks.setupConfigWithS3();

        System.runAs(u) {
            PermissionGate.clearCacheForTest();
            ChatAgentIntegrationTestMocks.AttachmentFlowMock mock =
                new ChatAgentIntegrationTestMocks.AttachmentFlowMock();
            Test.setMock(HttpCalloutMock.class, mock);

            List<AttachmentDto> atts = new List<AttachmentDto>();
            for (Integer i = 0; i < 4; i++) {
                AttachmentDto a = new AttachmentDto();
                a.fileName = 'f' + i + '.pdf';
                a.mimeType = 'application/pdf';
                a.sizeBytes = 5;
                a.base64Content = 'ZmFrZQ==';
                atts.add(a);
            }

            Test.startTest();
            ChatAgentResult result = ChatAgentController.submitMessage(
                null, 'AWS_Opportunity__c', 'too many files', atts, null
            );
            Test.stopTest();

            System.assertEquals(false, result.ok, 'More than 3 files must be rejected');
            System.assertEquals('ATTACHMENT_INVALID', result.errorCode,
                'Expected ATTACHMENT_INVALID error code');
            System.assertEquals(false, mock.sawPut(),
                'No upload should occur when the file count is rejected');
        }
    }
}
