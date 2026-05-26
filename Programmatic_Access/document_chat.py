"""
Interactive Document Analysis Chat
Upload files and ask the Partner Central Agent to analyze them.

Usage:
    python document_chat.py
"""

import os
import sys
import json
import boto3
from pc_mcp_client import PartnerCentralMCPClient

CATALOG = "Sandbox"  # Switch to "AWS" for production
REGION = "us-east-1"
PROFILE = "aws_marketplace_account"
S3_BUCKET = "aws-partner-central-marketplace-ephemeral-writeonly-files"
WIDTH = 60

ALLOWED_EXTENSIONS = {"doc", "docx", "pdf", "png", "jpeg", "jpg", "xlsx", "csv", "txt"}
IMAGE_EXTENSIONS = {"png", "jpeg", "jpg"}
MAX_SIZE = {"image": 3.75 * 1024 * 1024, "doc": 4.5 * 1024 * 1024}


def validate_file(file_path):
    """Validate file exists, has allowed extension, and is within size limits."""
    if not os.path.isfile(file_path):
        print(f"  File not found: {file_path}")
        return False
    ext = file_path.rsplit(".", 1)[-1].lower() if "." in file_path else ""
    if ext not in ALLOWED_EXTENSIONS:
        print(f"  Unsupported type '.{ext}'. Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}")
        return False
    size = os.path.getsize(file_path)
    limit = MAX_SIZE["image"] if ext in IMAGE_EXTENSIONS else MAX_SIZE["doc"]
    if size > limit:
        print(f"  File too large ({size / (1024*1024):.1f} MB). Max: {limit / (1024*1024)} MB")
        return False
    return True


def upload_to_s3(file_path, account_id):
    """Upload file to S3. Returns (s3_uri, filename)."""
    session = boto3.Session(region_name=REGION, profile_name=PROFILE)
    s3 = session.client("s3")
    filename = os.path.basename(file_path)
    s3_key = f"{account_id}/{filename}"
    print(f"  Uploading {filename}...")
    with open(file_path, "rb") as f:
        resp = s3.put_object(Bucket=S3_BUCKET, Key=s3_key, Body=f)
    s3_uri = f"s3://{S3_BUCKET}/{s3_key}?versionId={resp['VersionId']}"
    print(f"  Done: {s3_uri}")
    return s3_uri, filename


def extract_text(response):
    """Extract readable text from the nested MCP response."""
    if not isinstance(response, dict):
        return None, f"Unexpected response type: {type(response)}"
    if response.get("isError") or "error" in response:
        err = response.get("error", {})
        return None, f"[{err.get('code', '?')}] {err.get('message', str(response))}"
    if response is None:
        return None, "No response received — try switching catalog (Sandbox/AWS)."
    text_parts = []
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
            except json.JSONDecodeError:
                text_parts.append(raw)
        elif outer_type == "ASSISTANT_RESPONSE":
            t = outer_block.get("content", {})
            if isinstance(t, dict) and "text" in t:
                text_parts.append(t["text"])
    return "\n\n".join(text_parts) if text_parts else None, None


def print_response(response):
    text, error = extract_text(response)
    if error and text is None:
        print(f"\n{'─' * WIDTH}\n  ERROR: {error}\n{'─' * WIDTH}\n")
        return
    if text:
        print(f"\n{'─' * WIDTH}\n  Agent\n{'─' * WIDTH}")
        print(text)
        print(f"{'─' * WIDTH}")
    else:
        print(f"\n  (No text content)\n")


def main():
    print(f"{'=' * WIDTH}\n  AWS Partner Central — Document Analysis Chat\n{'=' * WIDTH}")
    print(f"\nConnecting ({CATALOG} catalog)...")
    try:
        client = PartnerCentralMCPClient(catalog=CATALOG)
        client.initialize()
        session = boto3.Session(region_name=REGION, profile_name=PROFILE)
        account_id = session.client("sts").get_caller_identity()["Account"]
    except Exception as e:
        print(f"\nFailed to connect: {e}")
        sys.exit(1)

    print("Connected. Upload documents and ask the agent to analyze them.")
    print("Type 'quit' to exit.\n")

    while True:
        try:
            file_path = input("File (Enter to skip): ").strip().strip("'\"")
        except (KeyboardInterrupt, EOFError):
            print("\nGoodbye!")
            break
        if file_path.lower() in ("quit", "exit"):
            break

        s3_uri = filename = None
        if file_path:
            if not validate_file(file_path):
                continue
            try:
                s3_uri, filename = upload_to_s3(file_path, account_id)
            except Exception as e:
                print(f"  Upload failed: {e}")
                continue

        try:
            prompt = "You" + (" (re: file)" if s3_uri else "") + ": "
            message = input(prompt).strip()
        except (KeyboardInterrupt, EOFError):
            print("\nGoodbye!")
            break
        if not message:
            continue
        if message.lower() in ("quit", "exit"):
            break

        try:
            if s3_uri and filename:
                response = client.send_with_document(message, filename, s3_uri)
            else:
                response = client.send_message(message)
            print_response(response)
        except Exception as e:
            print(f"\nError: {e}")
        print()

if __name__ == "__main__":
    main()