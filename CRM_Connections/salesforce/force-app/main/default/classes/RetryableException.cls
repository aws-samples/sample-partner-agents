/**
 * Feature: partner-central-chat-agent
 *
 * Thrown by `McpClient` for transient HTTP 5xx responses. The Chat_Agent
 * interprets this as a signal to offer the user a "Retry" control; on
 * retry, the original JSON-RPC id and Session_ID are reused so the
 * MCP_Server can deduplicate the request per Req 9.4.
 *
 * See requirement 9.1.
 */
public class RetryableException extends Exception {}
