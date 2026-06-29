/**
 * Feature: partner-central-chat-agent
 *
 * Gates access to every `@AuraEnabled` method in `ChatAgentController` by
 * asserting that the running user is assigned the
 * `Partner_Central_Chat_Agent_User` Permission Set (Req 11.1, 11.2). The
 * check fails closed: when the assignment is missing, `AccessDeniedException`
 * is thrown before any callout, DML, or other side-effecting work can run.
 *
 * The grant decision is memoized per transaction via a static cache so that
 * a single chat turn — which typically touches several AuraEnabled entry
 * points (submitMessage, decideOperation, etc.) — issues the
 * `PermissionSetAssignment` SOQL at most once. `clearCacheForTest` lets
 * test code flip the granted state between `System.runAs` blocks.
 *
 * See requirements 11.1, 11.2.
 */
public with sharing class PermissionGate {

    @TestVisible
    private static final String PERMISSION_SET_NAME = 'Partner_Central_Chat_Agent_User';

    private static Boolean cachedGranted;

    /**
     * Asserts that the running user holds the `Partner_Central_Chat_Agent_User`
     * Permission Set. Throws `AccessDeniedException` otherwise.
     */
    public static void assertHasAccess() {
        if (cachedGranted == null) {
            cachedGranted = hasAssignment();
        }
        if (!cachedGranted) {
            throw new AccessDeniedException(
                'Access denied: the running user is not assigned the ' +
                PERMISSION_SET_NAME + ' permission set.'
            );
        }
    }

    private static Boolean hasAssignment() {
        List<PermissionSetAssignment> rows = [
            SELECT Id
            FROM PermissionSetAssignment
            WHERE AssigneeId = :UserInfo.getUserId()
              AND PermissionSet.Name = :PERMISSION_SET_NAME
            LIMIT 1
        ];
        return !rows.isEmpty();
    }

    /**
     * Test-only hook to reset the per-transaction cache between `System.runAs`
     * blocks so tests can exercise both the granted and denied branches.
     */
    @TestVisible
    private static void clearCacheForTest() {
        cachedGranted = null;
    }
}
