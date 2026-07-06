/**
 * Feature: partner-central-chat-agent
 *
 * Thrown by `ConfigProvider` when a required field on the `Chat_Agent_Config__mdt`
 * `Default` record is missing (fail-closed per Req 12.3). The message always
 * identifies the offending field so the UI can surface a configuration-error
 * notice that tells the administrator exactly what to fix.
 *
 * Kept as a top-level class rather than a nested type because Apex has known
 * quirks with inner exception visibility across package namespaces.
 *
 * See requirement 12.3.
 */
public class ChatAgentConfigException extends Exception {}
