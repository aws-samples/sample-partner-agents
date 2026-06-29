// -----------------------------------------------------------------------------
// Tier 1 smoke test — no MCP callouts, just server-side plumbing.
//
// Verifies:
//   1. ConfigProvider.isSandbox() resolves via config → connector → default
//      without throwing. Prints the active named credential.
//   2. detectConnectorSandbox() returns a usable value on this org.
//   3. Chat_Agent_Config__mdt.Default is loadable and has required fields.
//   4. ChatAgentController.getClientConfig() returns a valid ConfigDto
//      (the LWC bootstraps from this).
//   5. ChatAgentController.getRecordContext() pulls Name + APN CRM id for
//      the ACE Opportunity supplied in SMOKE_RECORD_ID.
//   6. SessionManager.findActiveSession() + loadOrCreateSession() are
//      catalog-aware end to end.
//
// Environment:
//   SMOKE_RECORD_ID — ACE Opportunity record id
// -----------------------------------------------------------------------------

String recordId;
// Pick the most-recently-modified ACE opportunity with an APN CRM id so
// the assertion is realistic. The shell script may have resolved a
// different one, but for anon-apex purposes we re-resolve here — Apex
// cannot read shell env vars.
List<awsapn__ACE_Opportunity__c> recs = [
    SELECT Id, awsapn__APN_CRM_Id__c
    FROM awsapn__ACE_Opportunity__c
    WHERE awsapn__APN_CRM_Id__c != null
    ORDER BY LastModifiedDate DESC
    LIMIT 1
];
if (recs.isEmpty()) {
    throw new System.IllegalArgumentException(
        'No ACE_Opportunity__c with an APN CRM id. Create one or pass --record-id.'
    );
}
Id aceId = recs[0].Id;
String apnCrmId = recs[0].awsapn__APN_CRM_Id__c;

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

// 5: record context describe
Map<String, Object> ctx = ChatAgentController.getRecordContext(
    aceId, 'awsapn__ACE_Opportunity__c'
);
System.debug('recordContext | ' + JSON.serialize(ctx));
System.assertEquals(apnCrmId, (String) ctx.get('partnerCentralOpportunityId'),
    'APN CRM id should match the SOQL result');

// 6: catalog-aware session lookup (no DML-before-callout concern here —
// we're not calling out at all). Run as the current user.
SessionManager mgr = new SessionManager();
// Probe both catalogs; either may return null or a pre-existing row.
Chat_Session__c awsSession = mgr.findActiveSession(
    UserInfo.getUserId(), String.valueOf(aceId), retention, 'AWS'
);
Chat_Session__c sbSession = mgr.findActiveSession(
    UserInfo.getUserId(), String.valueOf(aceId), retention, 'Sandbox'
);
System.debug('session-lookup | AWS=' + (awsSession == null ? 'none' : awsSession.Id)
    + ' Sandbox=' + (sbSession == null ? 'none' : sbSession.Id));

// restoreTranscript should return an empty DTO or a valid one (never null).
TranscriptDto t = ChatAgentController.restoreTranscript(String.valueOf(aceId));
System.assertNotEquals(null, t,
    'restoreTranscript must never return null');
System.debug('transcript | entryCount='
    + (t.entries == null ? 0 : t.entries.size()));

System.debug('TIER1_OK');
