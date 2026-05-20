"""Verify MCP connection, tools, and agent communication."""

import sys
import json
from pc_mcp_client import PartnerCentralMCPClient

client = PartnerCentralMCPClient(catalog="Sandbox")
errors = []


def run_check(label, fn):
    """Run a check, catch errors, and track failures."""
    print(f"=== {label} ===")
    try:
        result = fn()
        if isinstance(result, dict) and "error" in result:
            err = result["error"]
            print(f"  ERROR [{err.get('code', '?')}]: {err.get('message', 'unknown')}")
            errors.append(label)
            return None
        return result
    except Exception as e:
        print(f"  FAILED: {e}")
        errors.append(label)
        return None
    finally:
        print()


# 1. Initialize
run_check("Initialize MCP", client.initialize)

# 2. List tools
tools = run_check("List Tools", client.list_tools)
if tools is not None and not tools:
    print("  WARNING: No tools returned.")
    errors.append("list_tools (empty)")

# 3. Send test message
def test_message():
    response = client.send_message("Hello, what can you help me with?")
    if not isinstance(response, dict) or "error" in response:
        return response
    # Print agent reply
    replied = False
    for block in response.get("content", []):
        if block.get("type") == "text":
            print(f"  Agent: {block['text'][:500]}")
            replied = True
    if not replied:
        print(f"  WARNING: No text content. Raw: {json.dumps(response, indent=2, default=str)}")
        errors.append("send_message (no content)")
    if client.session_id:
        print(f"  Session: {client.session_id}")
    return response

run_check("Send Test Message", test_message)

# Summary
if errors:
    print(f"Issues ({len(errors)}): {', '.join(errors)}")
    print("See troubleshooting table below.")
    sys.exit(1)
else:
    print("Setup verified successfully!")