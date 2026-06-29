/**
 * Feature: partner-central-chat-agent
 *
 * Thrown by `JsonRpcSerializer` when an input object violates the JSON-RPC 2.0
 * structural contract that can be detected at serialization time (for example,
 * a response that sets both `result` and `error`, or sets neither, or a
 * request that declares a non-"2.0" `jsonrpc` field).
 *
 * Kept as a top-level class rather than a nested type because Apex has known
 * quirks with inner exception visibility across package namespaces.
 *
 * See requirements 3.1, 3.4, 3.5.
 */
public class JsonRpcSerializationException extends Exception {}
