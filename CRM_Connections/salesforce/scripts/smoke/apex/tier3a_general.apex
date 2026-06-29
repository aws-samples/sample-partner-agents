// -----------------------------------------------------------------------------
// Tier 3a (GENERAL-CHAT variant) — attempt a write request with no record.
//
// Standalone counterpart of tier3a_submit_write.apex. Sends a write-style
// prompt with NO record context. Tier 3b (shared) rejects whatever pending
// operation this registers.
//
// IMPORTANT: on the general-chat path there is no anchored opportunity, so
// unless the prompt names a specific opportunity the agent will usually ask a
// clarifying question instead of emitting a tool_approval_request. That is a
// valid outcome: the script prints TIER3A_NO_PENDING and Tier 3b skips. To
// exercise a real approval round-trip on the general-chat path, name an
// opportunity in the prompt below (for example "opportunity O18657618").
// -----------------------------------------------------------------------------

String catalog = ConfigProvider.isSandbox() ? 'Sandbox' : 'AWS';

String rejectMessage =
    'Change the Next Step field on my most recent opportunity to '
    + '"smoke-test — please reject this".';

DateTime started = System.now();
ChatAgentResult r = ChatAgentController.submitMessage(
    null,            // no record context (general chat)
    null,            // no objectApiName
    rejectMessage,
    null,
    catalog
);

System.debug('submitMessage.ok=' + r.ok + ' errorCode=' + r.errorCode);
if (r.ok != true) {
    throw new CalloutException(
        'submitMessage failed: code=' + r.errorCode
        + ' msg=' + r.errorMessage
    );
}

List<Pending_Write_Operation__c> pending = [
    SELECT Operation_Id__c, Operation_Name__c, Status__c, Decision__c
    FROM Pending_Write_Operation__c
    WHERE CreatedDate >= :started
      AND User__c = :UserInfo.getUserId()
    ORDER BY CreatedDate DESC
    LIMIT 1
];

if (pending.isEmpty()) {
    // Agent answered conversationally instead of requesting a write;
    // expected on general chat unless the prompt names an opportunity.
    System.debug('TIER3A_NO_PENDING');
    System.debug('TIER3A_OK');
    return;
}

Pending_Write_Operation__c p = pending[0];
System.assertEquals('pending', p.Status__c,
    'Newly registered operation should be status=pending');
System.assertEquals('unresolved', p.Decision__c,
    'Newly registered operation should be decision=unresolved');

System.debug('TIER3A_PENDING_OPERATION_ID=' + p.Operation_Id__c);
System.debug('TIER3A_OPERATION_NAME=' + p.Operation_Name__c);
System.debug('TIER3A_CATALOG=' + catalog);
System.debug('TIER3A_OK');
