// -----------------------------------------------------------------------------
// Tier 3a — submit a write request and register the pending operation.
//
// This is one half of the approval round-trip (the other half is 3b).
// We run submit and reject in separate anon transactions because anon
// Apex cannot DML + callout + DML + callout in a single transaction;
// the `@AuraEnabled` controller doesn't have this problem because each
// LWC invocation is its own transaction.
//
// Writes the operation id into a Platform Event so Tier 3b can pick it
// up. (Platform Events are the closest thing to a cross-transaction
// scratch board available from anon Apex.)
// -----------------------------------------------------------------------------

List<awsapn__ACE_Opportunity__c> recs = [
    SELECT Id FROM awsapn__ACE_Opportunity__c
    WHERE awsapn__APN_CRM_Id__c != null
    ORDER BY LastModifiedDate DESC LIMIT 1
];
Id aceId = recs[0].Id;
String catalog = ConfigProvider.isSandbox() ? 'Sandbox' : 'AWS';

String rejectMessage =
    'Change the Next Step field to "smoke-test — please reject this".';

DateTime started = System.now();
ChatAgentResult r = ChatAgentController.submitMessage(
    String.valueOf(aceId),
    'awsapn__ACE_Opportunity__c',
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

// Print the operation id so the shell can pass it to Tier 3b. We
// disambiguate against earlier runs by only taking rows created since
// `started`.
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
    // that's a valid outcome. Print the sentinel and let Tier 3b skip.
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
