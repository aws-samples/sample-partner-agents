#!/usr/bin/env python
"""
Setup Verification Script

Run this script to verify all prerequisites are correctly configured:
1. AWS credentials
2. Bedrock model access
3. Partner Central API access
4. Partner Central MCP server access

Usage:
    python verify_setup.py
    python verify_setup.py --catalog Sandbox
    python verify_setup.py --catalog AWS
"""

import os
import json
import sys
import argparse
from pathlib import Path


def print_status(name: str, success: bool, message: str = ""):
    """Print a status line with emoji indicator"""
    icon = "✅" if success else "❌"
    status = "PASS" if success else "FAIL"
    print(f"{icon} [{status}] {name}")
    if message:
        print(f"   └─ {message}")


def print_section(title: str):
    """Print a section header"""
    print(f"\n{'='*60}")
    print(f"  {title}")
    print(f"{'='*60}\n")


def check_aws_credentials():
    """Verify AWS credentials are configured"""
    print_section("1. AWS Credentials")
    
    try:
        import boto3
        sts = boto3.client('sts')
        identity = sts.get_caller_identity()
        
        print_status("AWS credentials configured", True)
        print(f"   └─ Account: {identity['Account']}")
        print(f"   └─ ARN: {identity['Arn']}")
        return True
        
    except Exception as e:
        print_status("AWS credentials configured", False, str(e))
        print("\n   Fix: Run 'aws configure' or set AWS_PROFILE environment variable")
        return False


def check_bedrock_model_access(model_override: str = None):
    """Verify Bedrock model access via the Strands-backed generator.

    Drives orchestrator_agent.NextStepsGenerator (now built on the Strands
    Agents SDK) with a tiny prompt. The generator walks its candidate model
    list and caches the first model that responds, so a success here confirms
    the same model the orchestrator will use at runtime.

    An explicit --model override or BEDROCK_MODEL_ID pins a single model and
    skips the candidate walk.
    """
    print_section("2. Amazon Bedrock Model Access")

    try:
        import boto3  # noqa: F401  -- imported for side-effect / availability check
    except ImportError as e:
        print_status("Bedrock model access", False, f"boto3 not installed: {e}")
        return False

    try:
        from orchestrator_agent import NextStepsGenerator
    except Exception as e:
        print_status("Bedrock model access", False, f"Could not import orchestrator: {e}")
        return False

    region = os.environ.get('AWS_REGION') or os.environ.get('AWS_DEFAULT_REGION') or 'us-east-1'
    gen = NextStepsGenerator(use_bedrock=True)

    # Honor --model: pin the override so the candidate walk short-circuits.
    if model_override:
        gen._pinned_bedrock_model_id = model_override

    try:
        # _invoke runs the prompt through Strands, trying candidate models in
        # order and caching the first that works.
        response = gen._invoke("Say 'Bedrock access verified' in exactly those words.")
        resolved = gen.bedrock_model_id
        print_status(f"Bedrock model access ({resolved})", True)
        print(f"   └─ Region: {region}")
        print(f"   └─ Response: {response[:50]}...")
        print(f"   └─ orchestrator_agent.py picks this model at runtime via the "
              f"Strands Agents SDK — no BEDROCK_MODEL_ID required.")
        return True
    except Exception as e:
        print_status("Bedrock model access", False, str(e)[:200])
        print(
            "\n   The legacy 'Model access' console page has been retired. "
            "Anthropic models are auto-enabled when you first invoke them in a "
            "commercial region — but first-time Anthropic users may need to "
            "submit use-case details one time before access is granted."
        )
        print("   Steps to follow:")
        print("   1. Go to the Bedrock console → Model catalog (region above)")
        print("   2. Open an Anthropic Claude model → 'Open in playground' OR run InvokeModel/Converse once")
        print("   3. If prompted, fill out the one-time use-case form")
        print("   4. Re-run this script")
        print("   IAM controls access too — confirm bedrock:InvokeModel + InvokeModelWithResponseStream "
              "are allowed for the Claude ARNs (foundation-model/* and inference-profile/*).")
        print("\n   Tip: pass --model <id> or set BEDROCK_MODEL_ID to pin a specific model.")
        return False


def check_partner_central_api(catalog: str):
    """Verify Partner Central Selling API access"""
    print_section("3. Partner Central Selling API")

    try:
        import boto3

        pc_client = boto3.client(
            'partnercentral-selling',
            region_name='us-east-1',
            endpoint_url='https://partnercentral-selling.us-east-1.api.aws'
        )

        response = pc_client.list_opportunities(
            Catalog=catalog,
            MaxResults=1
        )

        count = len(response.get('OpportunitySummaries', []))
        print_status(f"Partner Central API ({catalog} catalog)", True)
        print(f"   └─ Found {count} opportunity(ies) in response")
        return True

    except Exception as e:
        error_msg = str(e)
        print_status(f"Partner Central API ({catalog} catalog)", False, error_msg[:200])

        if "AccessDeniedException" in error_msg:
            print("\n   Fix: Attach 'AWSPartnerCentralSandboxFullAccess' managed policy")
        elif "not registered" in error_msg.lower() or "partner" in error_msg.lower():
            print(f"\n   Fix: Register as a partner in the {catalog} catalog first")
            print("   See README.md for CreatePartner API instructions")
        elif "Unknown service" in error_msg:
            print("\n   Fix: Upgrade boto3: pip install --upgrade boto3 botocore (need 1.35.0+)")
        return False


def check_partner_central_mcp(catalog: str):
    """Verify Partner Central MCP server access"""
    print_section("4. Partner Central MCP Server")
    
    try:
        import boto3
        import requests
        from botocore.auth import SigV4Auth
        from botocore.awsrequest import AWSRequest
        
        mcp_endpoint = "https://partnercentral-agents.us-east-1.api.aws/mcp"
        
        # Simple test: send a hello message
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "sendMessage",
                "arguments": {
                    "content": [{
                        "type": "text",
                        "text": "Hello, what can you help me with?"
                    }],
                    "catalog": catalog
                }
            }
        }
        
        # Sign request with SigV4
        session = boto3.Session()
        credentials = session.get_credentials()
        
        request = AWSRequest(
            method='POST',
            url=mcp_endpoint,
            data=json.dumps(payload),
            headers={'Content-Type': 'application/json'}
        )
        
        SigV4Auth(credentials, 'partnercentral-agents-mcp', 'us-east-1').add_auth(request)
        
        response = requests.post(
            request.url,
            data=request.body,
            headers=dict(request.headers),
            timeout=60
        )
        
        if response.status_code == 200:
            result = response.json()
            
            # Check for error in response
            if 'error' in result:
                error = result['error']
                print_status("Partner Central MCP", False, f"Error: {error.get('message', error)}")
                return False
            
            # Parse the response to show agent capabilities
            try:
                content = result.get('result', {}).get('content', [])
                if content and content[0].get('type') == 'text':
                    inner = json.loads(content[0].get('text', '{}'))
                    status = inner.get('status', 'unknown')
                    
                    # Extract assistant response
                    for item in inner.get('content', []):
                        if item.get('type') == 'ASSISTANT_RESPONSE':
                            text = item.get('content', {}).get('text', '')
                            print_status("Partner Central MCP", True)
                            print(f"   └─ Status: {status}")
                            print(f"   └─ Agent: {text[:80]}...")
                            return True
                    
                    print_status("Partner Central MCP", True, f"Status: {status}")
                    return True
            except:
                pass
            
            print_status("Partner Central MCP", True, "Connected successfully")
            return True
        else:
            print_status("Partner Central MCP", False, f"HTTP {response.status_code}")
            return False
            
    except requests.exceptions.Timeout:
        print_status("Partner Central MCP", False, "Request timed out (60s)")
        print("\n   Note: First request may take longer. Try again.")
        return False
        
    except Exception as e:
        error_msg = str(e)
        print_status("Partner Central MCP", False, error_msg[:200])
        
        if "AccessDeniedException" in error_msg or "403" in error_msg:
            print("\n   Fix: Ensure IAM policy includes partnercentral:UseSession")
        return False


def check_config_file():
    """Check if config.json exists and is valid"""
    print_section("5. Configuration File")
    
    config_path = Path(__file__).parent / 'config.json'
    
    if not config_path.exists():
        print_status("config.json exists", False, "File not found")
        print("\n   Fix: Create config.json with catalog and endpoint settings")
        return False, None
    
    try:
        with open(config_path) as f:
            config = json.load(f)
        
        required_keys = ['catalog', 'region', 'endpoints']
        missing = [k for k in required_keys if k not in config]
        
        if missing:
            print_status("config.json valid", False, f"Missing keys: {missing}")
            return False, None
        
        print_status("config.json exists and valid", True)
        print(f"   └─ Catalog: {config.get('catalog')}")
        print(f"   └─ Region: {config.get('region')}")
        return True, config
        
    except json.JSONDecodeError as e:
        print_status("config.json valid", False, f"Invalid JSON: {e}")
        return False, None


def main():
    parser = argparse.ArgumentParser(description='Verify Agent-to-Agent setup')
    parser.add_argument('--catalog', '-c', default=None, 
                        help='Catalog to test (Sandbox or AWS). Defaults to config.json value.')
    parser.add_argument('--model', '-m', default=None,
                        help='Bedrock model/inference-profile ID to test. '
                             'Overrides BEDROCK_MODEL_ID env var. If neither is set, '
                             'a list of common Claude profiles is tried in order.')
    args = parser.parse_args()
    
    print("\n" + "="*60)
    print("  Agent-to-Agent Setup Verification")
    print("="*60)
    
    results = []
    
    # Check config file first
    config_ok, config = check_config_file()
    results.append(config_ok)
    
    # Determine catalog to use
    catalog = args.catalog
    if not catalog:
        catalog = config.get('catalog', 'Sandbox') if config else 'Sandbox'
    
    print(f"\n   Using catalog: {catalog}")
    
    # Run all checks
    results.append(check_aws_credentials())
    results.append(check_bedrock_model_access(args.model))
    results.append(check_partner_central_api(catalog))
    results.append(check_partner_central_mcp(catalog))
    
    # Summary
    print_section("Summary")
    
    passed = sum(results)
    total = len(results)
    
    if all(results):
        print("🎉 All checks passed! Your setup is ready.")
        print("\nNext steps:")
        print("  1. Run the demo: python server.py")
        print("  2. Or use CLI: python orchestrator_agent.py --help")
        return 0
    else:
        print(f"⚠️  {passed}/{total} checks passed. Please fix the issues above.")
        return 1


if __name__ == "__main__":
    sys.exit(main())
