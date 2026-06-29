/**
 * Feature: partner-central-chat-agent
 *
 * Thrown by `McpClient` for non-retryable HTTP 4xx responses (other than
 * 401 / 403, which map to `AuthenticationException`). Surfaces the status
 * code and the response body so the Chat_Agent can display a deterministic
 * non-retryable error notice per Req 9.2.
 */
public class ClientException extends Exception {}
