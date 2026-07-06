/**
 * Feature: partner-central-chat-agent
 *
 * Thrown by `PermissionGate.assertHasAccess()` when the running user is not
 * assigned the `Partner_Central_Chat_Agent_User` Permission Set. Raised at
 * the top of every `@AuraEnabled` method in `ChatAgentController` so that
 * unauthorized invocations fail closed before any callout or DML.
 *
 * Kept as a top-level class rather than a nested type because Apex has known
 * quirks with inner exception visibility across package namespaces.
 *
 * See requirements 11.1, 11.2.
 */
public class AccessDeniedException extends Exception {}
