/**
 * Feature: partner-central-chat-agent
 *
 * Thrown by `PendingWriteOperationStore.decide()` when the supplied
 * `operationId` does not correspond to any row in `Pending_Write_Operation__c`.
 * This enforces Property 8 (Operation_Id Correlation) and Req 6.10: a decide
 * call for an unknown Operation_Id must NOT send any confirmation upstream and
 * must fail loudly so the caller can surface the mismatch.
 *
 * Kept as a top-level class rather than a nested type because Apex has known
 * quirks with inner exception visibility across package namespaces.
 *
 * See requirement 6.10.
 */
public class OperationNotFoundException extends Exception {}
