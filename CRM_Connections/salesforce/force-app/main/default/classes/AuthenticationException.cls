/**
 * Feature: partner-central-chat-agent
 *
 * Thrown by `McpClient` when the MCP_Server returns HTTP 401 or HTTP 403,
 * indicating the `AWS_Partner_Central_MCP` Named Credential is missing a
 * valid identity or lacks the IAM policy to invoke the target API.
 * Chat_Agent surfaces the Named Credential name and status code so an
 * admin can correct the credential without guessing.
 *
 * See requirement 2.4.
 */
public class AuthenticationException extends Exception {}
