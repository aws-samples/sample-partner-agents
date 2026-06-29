// -----------------------------------------------------------------------------
// Tier 1 smoke test (GENERAL-CHAT variant) — no MCP callouts, no record.
//
// Identical intent to tier1_config_and_session.apex, but for the standalone
// (general-chat) deployment where the AWS Partner CRM Connector is NOT
// installed. It deliberately makes no reference to awsapn__ACE_Opportunity__c
// so it compiles on a connector-less org, and it exercises the record-less
// path (recordId = null) the way the LWC does on Home / the utility bar.
//
// Verifies:
//   1. ConfigProvider.isSandbox() resolves via config -> connector -> default
//      without throwing. Prints the active named credential.
//   2. detectConnectorSandbox() returns a usable value (null on this org).
//   3. Chat_Agent_Config__mdt.Default is loadable and has required fields.
//   4. ChatAgentController.getClientConfig() returns a valid ConfigDto
//      (the LWC bootstraps from this).
//   5. SessionManager.findActiveSession() is catalog-aware with a null record.
//   6. ChatAgentController.restoreTranscript(null) never returns null.
// -----------------------------------------------------------------------------

// 1 + 2 + 3: config resolution
Boolean sandbox = ConfigProvider.isSandbox();
Boolean connector = ConfigProvider.detectConnectorSandbox();
String activeCred = ConfigProvider.getActiveNamedCredentialName();
Integer timeout = ConfigProvider.getRequestTimeoutSeconds();
Integer retention = ConfigProvider.getSessionRetentionMinutes();
System.debug('config | isSandbox=' + sandbox
    + ' connectorDetect=' + connector
    + ' activeCred=' + activeCred
    + ' timeoutSec=' + timeout
    + ' retentionMin=' + retention);
System.assert(String.isNotBlank(activeCred),
    'Active named credential must be non-blank');

// 4: client DTO
ConfigDto dto = ChatAgentController.getClientConfig();
System.assertNotEquals(null, dto, 'getClientConfig returned null');
System.assertNotEquals(null, dto.allowedMimeTypes, 'allowedMimeTypes null');
System.assert(dto.allowedMimeTypes.size() > 0,
    'allowedMimeTypes should be non-empty');
System.assert(dto.maxAttachmentSizeBytes > 0,
    'maxAttachmentSizeBytes should be positive');
System.debug('ConfigDto | isSandbox=' + dto.isSandbox
    + ' maxBytes=' + dto.maxAttachmentSizeBytes
    + ' mimeCount=' + dto.allowedMimeTypes.size());

// 5: catalog-aware session lookup with NO record (general chat). A null
// recordId is exactly what the LWC passes from Home / the utility bar.
SessionManager mgr = new SessionManager();
Chat_Session__c awsSession = mgr.findActiveSession(
    UserInfo.getUserId(), null, retention, 'AWS'
);
Chat_Session__c sbSession = mgr.findActiveSession(
    UserInfo.getUserId(), null, retention, 'Sandbox'
);
System.debug('session-lookup | AWS=' + (awsSession == null ? 'none' : awsSession.Id)
    + ' Sandbox=' + (sbSession == null ? 'none' : sbSession.Id));

// 6: restoreTranscript with a null record must return a non-null DTO.
TranscriptDto t = ChatAgentController.restoreTranscript(null);
System.assertNotEquals(null, t,
    'restoreTranscript must never return null');
System.debug('transcript | entryCount='
    + (t.entries == null ? 0 : t.entries.size()));

System.debug('TIER1_OK');
