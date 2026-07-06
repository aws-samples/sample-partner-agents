/**
 * Feature: partner-central-chat-agent
 *
 * Schedulable nightly sweep that cancels `Pending_Write_Operation__c` rows
 * still in `pending` whose `Created_Timestamp__c` is older than the
 * configured retention window, and writes a final `Audit_Log__c` entry
 * with `Approval_Decision__c = unresolved` for each cancelled row so the
 * abandoned approval is visible in the audit trail (Req 10.4).
 *
 * See requirements 5.3, 6.7, 10.4.
 */
public with sharing class SessionExpirySweeper implements Schedulable {

    private static final String DECISION_UNRESOLVED = 'unresolved';

    public void execute(SchedulableContext sc) {
        Integer retentionMinutes = ConfigProvider.getSessionRetentionMinutes();
        DateTime olderThan = System.now().addMinutes(-retentionMinutes);

        PendingWriteOperationStore store = new PendingWriteOperationStore();
        List<Pending_Write_Operation__c> cancelled = store.cancelExpired(olderThan);
        if (cancelled.isEmpty()) {
            return;
        }

        // cancelExpired returns rows without Operation_Id__c selected; re-query
        // to obtain the external id used by Audit_Log__c correlation (Req 10.4).
        Set<Id> cancelledIds = new Set<Id>();
        for (Pending_Write_Operation__c row : cancelled) {
            cancelledIds.add(row.Id);
        }
        List<Pending_Write_Operation__c> withOpIds = [
            SELECT Operation_Id__c
            FROM Pending_Write_Operation__c
            WHERE Id IN :cancelledIds
            WITH USER_MODE
        ];

        AuditLogger auditLogger = new AuditLogger();
        DateTime stamp = System.now();
        for (Pending_Write_Operation__c row : withOpIds) {
            auditLogger.logApprovalDecision(
                row.Operation_Id__c,
                DECISION_UNRESOLVED,
                null,
                stamp
            );
        }
    }
}
