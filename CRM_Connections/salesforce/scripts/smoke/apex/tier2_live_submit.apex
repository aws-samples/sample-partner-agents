// -----------------------------------------------------------------------------
// Tier 2 smoke test — one live read-only sendMessage turn.
//
// Consumes a small amount of MCP quota but does NOT mutate Partner Central
// (the message is a read-only summary request; if the agent decides it
// needs a write, the approval stays 'pending' and we detect that in the
// shell driver's post-check).
//
// Verifies:
//   1. submitMessage returns ok=true (no structured errorCode).
//   2. The response carries a non-empty `events` array.
//   3. An Audit_Log__c row was written with a 200 Http_Status and a
//      non-null Session_Id__c (used as the assertion in the shell).
//
// Requires the sf CLI user to hold the Partner_Central_Chat_Agent_User
// permission set.
// -----------------------------------------------------------------------------

List<awsapn__ACE_Opportunity__c> recs = [
    SELECT Id, awsapn__APN_CRM_Id__c
    FROM awsapn__ACE_Opportunity__c
    WHERE awsapn__APN_CRM_Id__c != null
    ORDER BY LastModifiedDate DESC
    LIMIT 1
];
Id aceId = recs[0].Id;

// Honor the connector/config sandbox flag so we don't accidentally hit
// production when running a smoke against a sandbox-backed org.
String catalog = ConfigProvider.isSandbox() ? 'Sandbox' : 'AWS';

String message =
    'Give me a one-sentence summary of this opportunity. Do not update any fields.';

ChatAgentResult r = ChatAgentController.submitMessage(
    String.valueOf(aceId),
    'awsapn__ACE_Opportunity__c',
    message,
    null,            // no attachments
    catalog
);

System.debug('submitMessage.ok=' + r.ok
    + ' errorCode=' + r.errorCode
    + ' errorMessage=' + r.errorMessage);

if (r.ok != true) {
    // Render the structured error payload so the shell can surface it.
    throw new CalloutException(
        'submitMessage failed: code=' + r.errorCode
        + ' msg=' + r.errorMessage
    );
}

// Confirm the inline events envelope was populated. The LWC depends on
// this for non-racy rendering.
Map<String, Object> payload = (Map<String, Object>) r.payload;
System.assertNotEquals(null, payload, 'payload must be non-null on success');
List<Object> events = (List<Object>) payload.get('events');
System.assertNotEquals(null, events, 'payload.events must be present');
System.assert(events.size() > 0,
    'Server returned zero events — check audit log for 200-with-empty-body');

System.debug('events.count=' + events.size());
// Print the first textual event so the shell log has something human-readable.
for (Object ev : events) {
    Map<String, Object> m = (Map<String, Object>) ev;
    String et = (String) m.get('eventType');
    Object data = m.get('data');
    if (et == 'message' && data != null) {
        String preview = String.valueOf(data);
        if (preview.length() > 240) {
            preview = preview.substring(0, 240) + '...';
        }
        System.debug('first-message-preview | ' + preview);
        break;
    }
}

System.debug('TIER2_OK');
