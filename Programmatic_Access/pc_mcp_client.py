import json
import uuid
import boto3
import requests
from requests_aws4auth import AWS4Auth
from sseclient import SSEClient

# ─── Configuration ───────────────────────────────────────────────────────────
MCP_ENDPOINT = "https://partnercentral-agents-mcp.us-east-1.api.aws/mcp"
REGION = "us-east-1"
SERVICE = "partnercentral-agents-mcp"


# ─── Transport Layer ─────────────────────────────────────────────────────────

def _get_auth():
    """Create SigV4 auth from current AWS credentials."""
    session = boto3.Session(region_name=REGION)
    creds = session.get_credentials().get_frozen_credentials()
    return AWS4Auth(
        creds.access_key, creds.secret_key, REGION, SERVICE,
        session_token=creds.token
    )


def _build_payload(method, params):
    """Build a JSON-RPC 2.0 request payload."""
    return {
        "jsonrpc": "2.0",
        "id": uuid.uuid4().int % 10000,
        "method": method,
        "params": params
    }


def make_request(method, params):
    """Send a JSON-RPC 2.0 request and return the parsed response."""
    response = requests.post(
        MCP_ENDPOINT,
        json=_build_payload(method, params),
        auth=_get_auth(),
        headers={"Content-Type": "application/json"}
    )
    response.raise_for_status()
    return response.json()


def make_streaming_request(method, params, quiet=False):
    """Send a JSON-RPC 2.0 request with SSE streaming. Returns text, sessionId, and approvals."""
    response = requests.post(
        MCP_ENDPOINT,
        json=_build_payload(method, params),
        auth=_get_auth(),
        headers={"Content-Type": "application/json", "Accept": "text/event-stream"},
        stream=True
    )
    response.raise_for_status()

    # If server returns JSON instead of SSE, parse it directly
    content_type = response.headers.get("Content-Type", "")
    if "text/event-stream" not in content_type:
        data = response.json()
        if "error" in data:
            err = data["error"]
            print(f"\nERROR [{err.get('code', '?')}]: {err.get('message', 'unknown')}")
        return {"text": "", "sessionId": None, "approvals": []}

    client = SSEClient(response)
    full_text = ""
    session_id = None
    approval_requests = []

    for event in client.events():
        data = json.loads(event.data) if event.data else {}

        if event.event == "stream_start":
            session_id = data.get("sessionId")
            if not quiet:
                print(f"[Stream started] Session: {session_id}")

        elif event.event == "assistant-response.delta":
            # Text is nested: data.params.contentBlock.content.text
            params = data.get("params", data)
            content_block = params.get("contentBlock", {})
            inner = content_block.get("content", {})
            chunk = inner.get("text", "") if isinstance(inner, dict) else ""
            if not chunk:
                chunk = data.get("text", "")
            if chunk:
                full_text += chunk
                print(chunk, end="", flush=True)

        elif event.event == "assistant-response.completed":
            if not quiet:
                print("\n[Stream completed]")

        elif event.event == "server-tool-use":
            if not quiet:
                print(f"\n[Agent using tool: {data.get('toolName')}]")

        elif event.event == "tool_approval_request":
            params = data.get("params", data)
            approval_requests.append(params)
            if not quiet:
                print(f"\n[Approval required] Tool: {params.get('toolName')}")
                print(f"  Parameters: {json.dumps(params.get('parameters', {}), indent=2)}")
                print(f"  Tool Use ID: {params.get('toolUseId')}")
            break  # Stop streaming — caller needs to handle the approval

        elif event.event in ("stream_end", "done"):
            break

    return {"text": full_text, "sessionId": session_id, "approvals": approval_requests}


# ─── Client Class ────────────────────────────────────────────────────────────

class PartnerCentralMCPClient:
    """High-level client for the Partner Central Agent MCP Server."""

    def __init__(self, catalog="Sandbox"):
        """
        Args:
            catalog: "Sandbox" for testing, "AWS" for production
        """
        self.catalog = catalog
        self.session_id = None

    def initialize(self):
        """Initialize the MCP protocol connection."""
        result = make_request("initialize", {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": {"name": "partner-central-workshop-client", "version": "1.0.0"}
        })
        info = result["result"]["serverInfo"]
        print(f"Connected to: {info['name']} v{info['version']}")
        return result

    def list_tools(self):
        """List available MCP tools."""
        result = make_request("tools/list", {})
        tools = result.get("result", {}).get("tools", [])
        for tool in tools:
            print(f"  - {tool['name']}: {tool.get('description', 'No description')}")
        return tools

    def send_message(self, text, stream=False, quiet_stream=False):
        """
        Send a text message to the Partner Central agent.
        Args:
            text: Your natural language message
            stream: Enable SSE streaming for real-time responses
            quiet_stream: Suppress status markers during streaming
        Returns:
            Agent response dict (includes "error" key if the request failed)
        """
        content = [{"type": "text", "text": text}]
        return self._call_send(content, stream=stream, quiet_stream=quiet_stream)

    def send_with_document(self, text, filename, s3_uri):
        """
        Send a message with a file attachment.
        Args:
            text: Your natural language message
            filename: Name of the attached file
            s3_uri: S3 URI with versionId (see file upload section)
        """
        content = [
            {"type": "text", "text": text},
            {"type": "document", "filename": filename, "s3Uri": s3_uri}
        ]
        return self._call_send(content)

    def approve_action(self, tool_use_id):
        """Approve a pending write operation."""
        return self._send_approval(tool_use_id, "approve")

    def reject_action(self, tool_use_id, reason=""):
        """Reject a pending write operation."""
        return self._send_approval(tool_use_id, "reject", reason)

    def override_action(self, tool_use_id, instructions):
        """Override a pending write operation with custom instructions."""
        return self._send_approval(tool_use_id, "override", instructions)

    def get_session(self):
        """Retrieve the current session state and conversation history."""
        if not self.session_id:
            print("No active session. Send a message first.")
            return None
        return make_request("tools/call", {
            "name": "getSession",
            "arguments": {"sessionId": self.session_id, "catalog": self.catalog}
        })

    # ─── Private Helpers ─────────────────────────────────────────────────────

    def _call_send(self, content, stream=False, quiet_stream=False):
        """Shared logic for sending messages (text, documents, or approvals)."""
        arguments = {"content": content, "catalog": self.catalog}
        if self.session_id:
            arguments["sessionId"] = self.session_id

        if stream:
            arguments["stream"] = True
            result = make_streaming_request(
                "tools/call", {"name": "sendMessage", "arguments": arguments},
                quiet=quiet_stream
            )
            if result.get("sessionId"):
                self.session_id = result["sessionId"]
            return result

        result = make_request("tools/call", {"name": "sendMessage", "arguments": arguments})
        if "error" in result:
            return result
        response = result.get("result", {})
        # Session ID may be at top level or inside nested JSON text
        if response.get("sessionId"):
            self.session_id = response["sessionId"]
        else:
            # Extract from inner JSON: content[0].text -> parsed -> sessionId
            for block in response.get("content", []):
                if block.get("type") == "text":
                    try:
                        inner = json.loads(block.get("text", ""))
                        if inner.get("sessionId"):
                            self.session_id = inner["sessionId"]
                    except (json.JSONDecodeError, TypeError):
                        pass
                    break
        return response

    def _send_approval(self, tool_use_id, decision, message=None):
        """Send an approval/rejection/override response."""
        content_block = {
            "type": "tool_approval_response",
            "toolUseId": tool_use_id,
            "decision": decision
        }
        if message:
            content_block["message"] = message

        return self._call_send([content_block])