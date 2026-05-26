"""
Explore Partner Central Agent Capabilities
Demonstrates all core capabilities in a single session.
"""

import json
from pc_mcp_client import PartnerCentralMCPClient

OPP_ID = "REPLACE_WITH_YOUR_OPPORTUNITY_ID" # From setup step above
CATALOG = "Sandbox"  # Switch to "AWS" for production
WIDTH = 80


def extract_assistant_text(response):
    """
    Extract only the assistant's text responses from the full response.
    The response structure is:
    {
        "content": [{"type": "text", "text": "<JSON string>"}],
        "isError": false
    }
    Where the JSON string contains:
    {
        "content": [
            {"type": "ASSISTANT_RESPONSE", "content": {"text": "..."}, ...},
            {"type": "serverToolUse", ...},
            ...
        ],
        "sessionId": "...",
        ...
    }
    """
    if not isinstance(response, dict):
        return f"ERROR: Unexpected response type: {type(response)}"
    
    if response.get("isError"):
        return "ERROR: Request failed"
    
    if "error" in response:
        err = response["error"]
        return f"ERROR [{err.get('code', '?')}]: {err.get('message', 'unknown')}"
    
    if response is None:
        return "ERROR: No response received — try switching catalog (Sandbox/AWS)."
    
    # Get the outer content array
    outer_content = response.get("content", [])
    
    text_parts = []
    
    for outer_block in outer_content:
        outer_type = outer_block.get("type", "")
        
        if outer_type == "text":
            # The text field contains a JSON string - parse it
            raw_text = outer_block.get("text", "")
            
            try:
                inner_response = json.loads(raw_text)
                inner_content = inner_response.get("content", [])
                
                for block in inner_content:
                    block_type = block.get("type", "")
                    
                    # Extract text from ASSISTANT_RESPONSE blocks
                    if block_type == "ASSISTANT_RESPONSE":
                        inner_text = block.get("content", {})
                        if isinstance(inner_text, dict) and "text" in inner_text:
                            text_parts.append(inner_text["text"])
                            
            except json.JSONDecodeError:
                # If it's not JSON, use the raw text
                text_parts.append(raw_text)
        
        # Handle direct ASSISTANT_RESPONSE (in case structure varies)
        elif outer_type == "ASSISTANT_RESPONSE":
            inner_content = outer_block.get("content", {})
            if isinstance(inner_content, dict) and "text" in inner_content:
                text_parts.append(inner_content["text"])
    
    return "\n\n".join(text_parts) if text_parts else "(No text content in response)"


def print_response(response, label="Agent"):
    """Pretty-print the agent's response with clean formatting."""
    print(f"\n{'═' * WIDTH}")
    print(f"  📋 {label}")
    print(f"{'═' * WIDTH}\n")
    
    text = extract_assistant_text(response)
    print(text)
    
    print(f"\n{'─' * WIDTH}\n")


# ─── Run All Capabilities ────────────────────────────────────────────────────
if __name__ == "__main__":
    client = PartnerCentralMCPClient(catalog=CATALOG)
    client.initialize()

    queries = [
        ("Which opportunities need my attention this week?", "Pipeline — Needs Attention"),
        ("How many opportunities are closing next month?", "Pipeline — Closing Next Month"),
        (f"Give me a summary of opportunity {OPP_ID}", "Opportunity Summary"),
        (f"Generate a sales play for opportunity {OPP_ID}", "Sales Play"),
        (f"Create a customer profile for the customer on opportunity {OPP_ID}", "Customer Profile"),
        (f"Am I eligible for any funding programs on opportunity {OPP_ID}?", "Funding Eligibility"),
        (f"Estimate the funding amount for a POC on opportunity {OPP_ID}", "Funding Estimate"),
        (f"What do I need to do next to advance opportunity {OPP_ID}?", "Next Steps"),
        (f"Which of our solutions best match opportunity {OPP_ID}?", "Solution Recommendations"),
    ]

    for query, label in queries:
        print(f"\n🔍 Query: {query}")
        try:
            response = client.send_message(query)
            print_response(response, label)
        except Exception as e:
            print(f"\n{'═' * WIDTH}")
            print(f"  ❌ {label}")
            print(f"{'═' * WIDTH}\n")
            print(f"ERROR: {type(e).__name__}: {e}")
            print(f"\n{'─' * WIDTH}\n")

    print("\n✅ Done! All capabilities demonstrated.")