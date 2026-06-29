// -----------------------------------------------------------------------------
// Tier 2 smoke test (GENERAL-CHAT variant) — one live read-only sendMessage.
//
// Standalone (connector-less) counterpart of tier2_live_submit.apex. Sends a
// general-purpose, read-only prompt with NO record context (recordId = null),
// exactly as the LWC does from Home / the utility bar. Consumes a small amount
// of MCP quota but does not mutate Partner Central.
//
// Verifies:
//   1. submitMessage returns ok=true (no structured errorCode).
//   2. The response carries a non-empty `events` array.
//   3. (Asserted in the shell driver) an Audit_Log__c row was written.
//
// The SMOKE_MESSAGE env var is not readable from anon Apex, so the prompt is
// inlined here. Keep it read-only.
// -----------------------------------------------------------------------------

String catalog = ConfigProvider.isSandbox() ? 'Sandbox' : 'AWS';

String message =
    'List my most recent Partner Central opportunities and their stages. '
    + 'Do not create or update anything.';

ChatAgentResult r = ChatAgentController.submitMessage(
    null,            // no record context (general chat)
    null,            // no objectApiName
    message,
    null,            // no attachments
    catalog
);

System.debug('submitMessage.ok=' + r.ok
    + ' errorCode=' + r.errorCode
    + ' errorMessage=' + r.errorMessage);

if (r.ok != true) {
    throw new CalloutException(
        'submitMessage failed: code=' + r.errorCode
        + ' msg=' + r.errorMessage
    );
}

Map<String, Object> payload = (Map<String, Object>) r.payload;
System.assertNotEquals(null, payload, 'payload must be non-null on success');
List<Object> events = (List<Object>) payload.get('events');
System.assertNotEquals(null, events, 'payload.events must be present');
System.assert(events.size() > 0,
    'Server returned zero events — check audit log for 200-with-empty-body');

System.debug('events.count=' + events.size());
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
