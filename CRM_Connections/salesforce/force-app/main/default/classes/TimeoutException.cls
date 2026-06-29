/**
 * Feature: partner-central-chat-agent
 *
 * Thrown by `McpClient` when an MCP_Server request exceeds the configured
 * timeout (capped at 120 seconds per Req 9.3). The Chat_Agent surfaces this
 * as a timeout notice; retries on the same request reuse the original
 * JSON-RPC id and Session_ID per Req 9.4.
 */
public class TimeoutException extends Exception {}
