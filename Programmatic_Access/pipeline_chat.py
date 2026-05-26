"""
Interactive Partner Central Agent Chat
All capabilities: queries, write operations with approval, session management.
"""

import sys
import json
from pc_mcp_client import PartnerCentralMCPClient

CATALOG = "Sandbox"  # Switch to "AWS" for production
WIDTH = 60


# ─── Response Parsing ────────────────────────────────────────────────────────

def extract_text(response):
    """Extract readable text and approval requests from the nested MCP response."""
    if not isinstance(response, dict):
        return None, f"Unexpected response type: {type(response)}"
    if response.get("isError") or "error" in response:
        err = response.get("error", {})
        return None, f"[{err.get('code', '?')}] {err.get('message', str(response))}"
    if response is None:
        return None, "No response received — try switching catalog (Sandbox/AWS)."

    text_parts, approvals = [], []
    for outer_block in response.get("content", []):
        outer_type = outer_block.get("type", "")
        if outer_type == "text":
            raw = outer_block.get("text", "")
            try:
                inner = json.loads(raw)
                for block in inner.get("content", []):
                    if block.get("type") == "ASSISTANT_RESPONSE":
                        t = block.get("content", {})
                        if isinstance(t, dict) and "text" in t:
                            text_parts.append(t["text"])
                    elif block.get("type") == "tool_approval_request":
                        # Approval data may be nested in content.text as JSON
                        approval_data = block
                        inner_text = block.get("content", {})
                        if isinstance(inner_text, dict) and "text" in inner_text:
                            try:
                                parsed = json.loads(inner_text["text"])
                                approval_data = {
                                    "type": "tool_approval_request",
                                    "toolUseId": parsed.get("tool_use_id"),
                                    "toolName": parsed.get("tool_name"),
                                    "parameters": parsed.get("input", {})
                                }
                            except (json.JSONDecodeError, TypeError):
                                pass
                        approvals.append(approval_data)
            except json.JSONDecodeError:
                text_parts.append(raw)
        elif outer_type == "ASSISTANT_RESPONSE":
            t = outer_block.get("content", {})
            if isinstance(t, dict) and "text" in t:
                text_parts.append(t["text"])
        elif outer_type == "tool_approval_request":
            approvals.append(outer_block)

    combined = "\n\n".join(text_parts) if text_parts else None
    return combined, approvals if approvals else None


# ─── Output ──────────────────────────────────────────────────────────────────

def print_response(response):
    text, extra = extract_text(response)
    if isinstance(extra, str) and text is None:
        print(f"\n{'─' * WIDTH}\n  ERROR: {extra}\n{'─' * WIDTH}\n")
        return None
    if text:
        print(f"\n{'─' * WIDTH}\n  Agent\n{'─' * WIDTH}")
        print(text)
        print(f"{'─' * WIDTH}")
    elif not response or not response.get("content"):
        # Empty response after approval — this is normal (success, no message)
        print(f"\n  ✓ Action completed.")
    else:
        print(f"\n  (No text content)\n  Raw: {json.dumps(response, indent=2, default=str)[:500]}\n")
    if isinstance(extra, list) and extra:
        print_approvals(extra)
    return extra


def print_approvals(approvals):
    for item in approvals:
        tid = item.get("toolUseId")
        print(f"\n{'=' * WIDTH}\n  APPROVAL REQUIRED\n{'=' * WIDTH}")
        print(f"  Tool:        {item.get('toolName', 'unknown')}")
        print(f"  Tool Use ID: {tid}")
        print(f"  Parameters:\n{json.dumps(item.get('parameters', {}), indent=4)}")
        print(f"{'=' * WIDTH}\n  [y] Approve   [n] Reject   [o] Override")


def handle_approval(client, approvals):
    if not approvals or not isinstance(approvals, list):
        return
    tool_use_id = approvals[-1].get("toolUseId")
    if not tool_use_id:
        return
    while True:
        try:
            choice = input("  Decision: ").strip().lower()
        except (KeyboardInterrupt, EOFError):
            choice = "n"
        if choice in ("y", "yes"):
            result = client.approve_action(tool_use_id)
            print_response(result.get("result", {}))
            return
        elif choice in ("n", "no"):
            reason = input("  Reason (optional): ").strip()
            result = client.reject_action(tool_use_id, reason)
            print_response(result.get("result", {}))
            return
        elif choice in ("o", "override"):
            instructions = input("  Instructions: ").strip()
            if not instructions:
                print("  Override requires instructions.")
                continue
            result = client.override_action(tool_use_id, instructions)
            print_response(result.get("result", {}))
            return
        else:
            print("  Invalid — enter y, n, or o.")


# ─── Commands ────────────────────────────────────────────────────────────────

HELP_TEXT = """
Commands:
  help                          Show this help
  stream <message>              Send with SSE streaming (read queries only)
  approve <tool_use_id>         Approve a pending write
  reject <tool_use_id> [reason] Reject a pending write
  override <tool_use_id> <msg>  Override with instructions
  session                       Show session ID
  tools                         List MCP tools
  quit / exit                   End session

Example questions:
  List all of my active opportunities
  Give me a summary of opportunity O1234567890
  Update opportunity O1234567890: set expected revenue to $300,000
"""


def handle_command(client, user_input):
    cmd = user_input.lower()
    if cmd in ("quit", "exit"):
        print("Goodbye!")
        return "quit"
    if cmd == "help":
        print(HELP_TEXT)
        return True
    if cmd == "tools":
        client.list_tools()
        return True
    if cmd == "session":
        print(f"\n  Session: {client.session_id}" if client.session_id else "No active session yet.")
        return True
    if cmd.startswith("approve "):
        result = client.approve_action(user_input.split(maxsplit=1)[1])
        print_response(result.get("result", {}))
        return True
    if cmd.startswith("reject "):
        parts = user_input.split(maxsplit=2)
        result = client.reject_action(parts[1], parts[2] if len(parts) > 2 else "")
        print_response(result.get("result", {}))
        return True
    if cmd.startswith("override "):
        parts = user_input.split(maxsplit=2)
        if len(parts) < 3:
            print("Usage: override <tool_use_id> <instructions>")
            return True
        result = client.override_action(parts[1], parts[2])
        print_response(result.get("result", {}))
        return True
    # Streaming mode (opt-in for read queries)
    if cmd.startswith("stream "):
        message = user_input.split(maxsplit=1)[1]
        print(f"\n{'─' * WIDTH}\n  Agent (streaming)\n{'─' * WIDTH}")
        result = client.send_message(message, stream=True, quiet_stream=True)
        print(f"\n{'─' * WIDTH}")
        if not result.get("text"):
            print("  (No streaming response — try without 'stream' prefix)")
        return True
    return False


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    print(f"{'=' * WIDTH}\n  AWS Partner Central Agent — Interactive Chat\n{'=' * WIDTH}")
    print(f"\nConnecting ({CATALOG} catalog)...")
    try:
        client = PartnerCentralMCPClient(catalog=CATALOG)
        client.initialize()
    except Exception as e:
        print(f"\nFailed to connect: {e}")
        sys.exit(1)

    print("Connected. Type 'help' for commands, or just ask a question.")
    print("Write operations will pause for your approval.\n")

    while True:
        try:
            user_input = input("You: ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\nGoodbye!")
            break
        if not user_input:
            continue
        try:
            result = handle_command(client, user_input)
            if result == "quit":
                break
            if result:
                print()
                continue
        except Exception as e:
            print(f"Error: {e}\n")
            continue

        # Default: non-streaming request (works reliably for both read and write)
        try:
            response = client.send_message(user_input)
            approvals = print_response(response)
            if approvals:
                handle_approval(client, approvals)
        except Exception as e:
            print(f"\nError: {e}")
        print()

if __name__ == "__main__":
    main()