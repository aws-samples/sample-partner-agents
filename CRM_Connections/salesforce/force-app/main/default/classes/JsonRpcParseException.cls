/**
 * Feature: partner-central-chat-agent
 *
 * Thrown by `JsonRpcParser` when an input payload violates the JSON-RPC 2.0
 * structural contract at parse time (for example, malformed JSON, a missing
 * `jsonrpc` field, an `id` whose type is not String / Integer / null, or a
 * response that sets both `result` and `error`).
 *
 * Kept as a top-level class rather than a nested type because Apex has known
 * quirks with inner exception visibility across package namespaces. Each
 * thrown instance names the offending field concretely so the chat UI can
 * surface the message directly to the user (Req 3.7).
 *
 * See requirements 3.3, 3.5, 3.7.
 */
public class JsonRpcParseException extends Exception {}
