// -----------------------------------------------------------------------------
// Tier 3b — reject the operation id registered in Tier 3a.
//
// Reads the operation id directly from SOQL (the most recent pending
// row for this user). The shell could also pass it in explicitly, but
// SOQL is simpler and idempotent.
//
// Running in a fresh anon transaction means the callout is the first
// thing we do — no uncommitted-work-pending error.
// -----------------------------------------------------------------------------

List<Pending_Write_Operation__c> pending = [
    SELECT Id, Operation_Id__c, Operation_Name__c,
           Status__c, Decision__c, Session_Id__c, Record_Id__c
    FROM Pending_Write_Operation__c
    WHERE Status__c = 'pending'
      AND User__c = :UserInfo.getUserId()
    ORDER BY CreatedDate DESC
    LIMIT 1
];

if (pending.isEmpty()) {
    // Nothing to reject; Tier 3a likely printed TIER3A_NO_PENDING.
    System.debug('TIER3B_SKIPPED | no pending operation for this user');
    System.debug('TIER3B_OK');
    return;
}

Pending_Write_Operation__c p = pending[0];
String catalog = ConfigProvider.isSandbox() ? 'Sandbox' : 'AWS';

System.debug('rejecting | op=' + p.Operation_Name__c
    + ' opId=' + p.Operation_Id__c
    + ' catalog=' + catalog);

ChatAgentResult dr = ChatAgentController.decideOperation(
    p.Operation_Id__c, 'rejected', catalog
);
System.debug('decideOperation.ok=' + dr.ok
    + ' errorCode=' + dr.errorCode
    + ' errorMessage=' + dr.errorMessage);
if (dr.ok != true) {
    throw new CalloutException(
        'decideOperation failed: code=' + dr.errorCode
        + ' msg=' + dr.errorMessage
    );
}

Pending_Write_Operation__c after = [
    SELECT Status__c, Decision__c
    FROM Pending_Write_Operation__c
    WHERE Id = :p.Id
    LIMIT 1
];
System.debug('after-reject | status=' + after.Status__c
    + ' decision=' + after.Decision__c);
System.assertEquals('cancelled', after.Status__c,
    'Rejected operation should be status=cancelled');
System.assertEquals('rejected', after.Decision__c,
    'Rejected operation should be decision=rejected');

System.debug('TIER3B_OK');
