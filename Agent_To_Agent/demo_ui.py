#!/usr/bin/env python
"""
Demo UI for Agent-to-Agent Workflow

A simple Flask web interface to demonstrate:
1. CRM (HubSpot/Salesforce/Pipedrive) → ACE opportunity creation
2. Opportunity next steps update via Partner Central MCP
3. Conversational Q&A about opportunities
"""

import os
import re
import json
import logging
import boto3
import requests
from pathlib import Path
from functools import wraps
from flask import Flask, render_template, request, jsonify, Response
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from orchestrator_agent import OrchestratorAgent, HubSpotClient, SalesforceClient


_OPPORTUNITY_ID_RE = re.compile(r'^O\d{5,}$')


def _validate_opportunity_id(opportunity_id: str):
    """Return an error response tuple if the opportunity_id is malformed, else None."""
    if not opportunity_id:
        return jsonify({"error": "opportunity_id is required"}), 400
    if not _OPPORTUNITY_ID_RE.match(opportunity_id):
        return jsonify({
            "error": f"Invalid opportunity_id format: '{opportunity_id}'. Expected format: O followed by digits (e.g., O15081741)."
        }), 400
    return None

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

app = Flask(__name__)

# In-memory tracker of the last chat intent per session. Lets follow-up
# questions like "how about Europe?" route to the same handler as the
# previous turn (e.g., engagement invitations) without restating the full
# question. Cleared when the session ends or the server restarts.
_last_chat_intent_by_session = {}

# --- Basic Auth (password-protect the demo for workshop use) ----------------
# Priority: env var > config.json > default (true)
def _load_auth_from_config():
    try:
        config_path = Path(__file__).parent / 'config.json'
        if config_path.exists():
            with open(config_path) as f:
                return json.load(f).get('demo_auth_enabled')
    except Exception:
        pass
    return None

AUTH_USERNAME = os.environ.get('DEMO_AUTH_USERNAME', 'pcagentday')
AUTH_PASSWORD = os.environ.get('DEMO_AUTH_PASSWORD', 'pcagentday')

_env_auth = os.environ.get('DEMO_AUTH_ENABLED')
_config_auth = _load_auth_from_config()
if _env_auth is not None:
    AUTH_ENABLED = _env_auth.lower() in ('true', '1', 'yes')
elif _config_auth is not None:
    AUTH_ENABLED = bool(_config_auth)
else:
    AUTH_ENABLED = True


def check_auth(username, password):
    """Verify username/password against configured credentials."""
    return username == AUTH_USERNAME and password == AUTH_PASSWORD


def authenticate():
    """Send a 401 response that prompts the browser's basic-auth dialog."""
    return Response(
        'Access denied. Please provide valid credentials.\n',
        401,
        {'WWW-Authenticate': 'Basic realm="Agent-to-Agent Workshop Demo"'}
    )


def requires_auth(f):
    """Decorator that enforces HTTP Basic Auth on a route."""
    @wraps(f)
    def decorated(*args, **kwargs):
        if not AUTH_ENABLED:
            return f(*args, **kwargs)
        auth = request.authorization
        if not auth or not check_auth(auth.username, auth.password):
            return authenticate()
        return f(*args, **kwargs)
    return decorated


def _load_config_flag(key, default=False):
    """Read a boolean flag from config.json, falling back to `default`."""
    try:
        config_path = Path(__file__).parent / 'config.json'
        if config_path.exists():
            with open(config_path) as f:
                val = json.load(f).get(key)
                if val is not None:
                    return bool(val)
    except Exception:
        pass
    return default


# "Process Call" is a high-impact demo flow that creates a REAL deal in the
# connected CRM. Hidden by default so partners don't accidentally write to
# their CRM. Enable via config.json ("process_call_enabled": true) or the
# PROCESS_CALL_ENABLED env var.
_env_process_call = os.environ.get('PROCESS_CALL_ENABLED')
if _env_process_call is not None:
    PROCESS_CALL_ENABLED = _env_process_call.lower() in ('true', '1', 'yes')
else:
    PROCESS_CALL_ENABLED = _load_config_flag('process_call_enabled', False)


# Store conversation sessions
conversation_sessions = {}

# In-memory cache mapping CRM deal IDs to the ACE opportunity created from
# them in the current session. Lets the demo replay "Sync from ACE" without
# requiring custom CRM fields. Format: { "{crm_type}:{record_id}": "O123..." }
crm_to_ace_mapping = {}

# Per-session policy for the create-from-notes flow. When the user opts for
# "create only" (default), we auto-reject any submit/submitter tool the agent
# tries to call after the opportunity is created. The natural-language
# directive in the prompt is sometimes ignored by the agent, so we enforce
# the boundary in code instead.
# Format: { session_id: bool }  -- True means the agent is allowed to submit.
session_allow_submit = {}


# Tool names that submit an opportunity to AWS for review. The agent uses
# different names depending on the underlying API path — keep this list in
# sync with whatever Partner Central exposes. Anything matched here will be
# auto-rejected when the user opts for create-only.
SUBMIT_TOOL_PATTERNS = (
    'submit',                            # opportunity_submitter, submit_opportunity
    'start_engagement_from_opportunity', # ACE: StartEngagementFromOpportunityTask
    'start_engagement_by_accepting',     # ACE: StartEngagementByAcceptingInvitationTask
)


def _is_submit_tool(tool_name):
    """Return True if the tool name represents an opportunity submission."""
    if not tool_name:
        return False
    n = tool_name.lower()
    # 'submission' alone is fine (e.g., GetSubmission), but 'submit' anywhere
    # else (Submit, _submit_, Submitter) means the agent is trying to ship
    # the opportunity to AWS — block when policy says create-only.
    if 'submission' in n and 'submit' not in n.replace('submission', ''):
        return False
    return any(p in n for p in SUBMIT_TOOL_PATTERNS)


# HTML/CSS/JS now live in `templates/index.html`, `static/css/app.css`,
# and `static/js/app.js`. The Flask app uses render_template() to serve
# the page so dev tools (linting, browser source maps) work properly.

@app.route('/')
@requires_auth
def index():
    # Cache-bust static assets by file mtime so browser reloads get new JS/CSS
    # without forcing the user to clear cache or hard-refresh.
    static_dir = Path(__file__).parent / 'static'
    def _mtime(rel):
        try:
            return int((static_dir / rel).stat().st_mtime)
        except Exception:
            return 0
    return render_template(
        'index.html',
        js_version=_mtime('js/app.js'),
        css_version=_mtime('css/app.css'),
        process_call_enabled=PROCESS_CALL_ENABLED,
    )


@app.before_request
def before_request_auth():
    """Enforce basic auth on all routes (except static assets if any)."""
    if not AUTH_ENABLED:
        return None
    auth = request.authorization
    if not auth or not check_auth(auth.username, auth.password):
        return authenticate()


@app.route('/api/crm/specs', methods=['GET'])
def get_crm_specs():
    """Return metadata for all registered CRM integrations.

    The frontend calls this on page load to populate the CRM dropdown, the
    token input label/placeholder, and (per-CRM) the instance URL input.
    """
    from crm.crm_registry import all_specs
    return jsonify({"crms": all_specs()})


def _get_adapter_or_error(data):
    """Helper: resolve crm_type + token + instance_url to a live adapter.

    Returns (adapter, None) on success, or (None, flask_response) on error.
    """
    from crm.crm_registry import get_adapter_class

    crm_type = data.get('crm_type', 'hubspot')
    token = data.get('token')
    instance_url = data.get('instance_url', '')

    if not token:
        return None, (jsonify({"error": "Bearer token required"}), 400)

    adapter_cls = get_adapter_class(crm_type)
    if adapter_cls is None:
        return None, (jsonify({"error": f"Unknown CRM type: {crm_type}"}), 400)

    try:
        adapter = adapter_cls(token=token, instance_url=instance_url)
    except ValueError as e:
        return None, (jsonify({"error": str(e)}), 400)

    return adapter, None


@app.route('/api/crm/records', methods=['POST'])
def get_crm_records():
    """Get list of records from the selected CRM."""
    try:
        data = request.json or {}
        adapter, err = _get_adapter_or_error(data)
        if err is not None:
            return err

        try:
            records = adapter.list_records(limit=10)
        except RuntimeError as api_err:
            return jsonify({"error": str(api_err)}), 400

        return jsonify({"records": records})

    except Exception as e:
        logger.error(f"Error fetching CRM records: {e}")
        return jsonify({"error": str(e)}), 500


@app.route('/api/crm/record-details', methods=['POST'])
def get_crm_record_details():
    """Get full details of a specific CRM record for the details popup."""
    try:
        data = request.json or {}
        record_id = data.get('record_id')
        if not record_id:
            return jsonify({"error": "record_id required"}), 400

        adapter, err = _get_adapter_or_error(data)
        if err is not None:
            return err

        try:
            details = adapter.get_record_details(record_id)
        except LookupError as not_found:
            return jsonify({"error": str(not_found)}), 404

        return jsonify({"success": True, "details": details})

    except Exception as e:
        logger.error(f"Error fetching CRM record details: {e}")
        return jsonify({"error": str(e)}), 500


@app.route('/api/crm/create-opportunity', methods=['POST'])
def create_opportunity_from_crm():
    """Create an ACE opportunity from a selected CRM record."""
    try:
        data = request.json or {}
        record_id = data.get('record_id')
        if not record_id:
            return jsonify({"error": "record_id required"}), 400

        adapter, err = _get_adapter_or_error(data)
        if err is not None:
            return err

        # Each adapter wires its credentials into the orchestrator before
        # invoking the per-CRM create flow.
        agent = OrchestratorAgent()
        result = adapter.create_ace_opportunity(agent, record_id)

        # NOTE: We don't auto-write the ACE opportunity ID back to the
        # HubSpot deal because most workshop participants don't have the
        # custom `partner_central_opportunity_id` field configured. The
        # demo focuses on bidirectional sync using only built-in fields
        # (dealstage, closedate, amount, dealname, hs_next_step).
        # Partners who want full traceability can add custom fields and
        # re-enable this block.
        
        # Cache the CRM deal -> ACE opportunity mapping in memory so the
        # "Sync from ACE" button knows which ACE opp belongs to which deal
        # without requiring custom CRM fields.
        if result.get("success"):
            crm_type = data.get("crm_type", "hubspot")
            ace_id = result.get("ace_opportunity_id")
            if ace_id:
                cache_key = f"{crm_type}:{record_id}"
                crm_to_ace_mapping[cache_key] = ace_id
                logger.info(f"Cached CRM->ACE mapping: {cache_key} -> {ace_id}")

        return jsonify(result), 200

    except Exception as e:
        logger.error(f"Error creating opportunity: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/crm/link-ace-opportunity', methods=['POST'])
def link_ace_opportunity_to_crm():
    """Cache the CRM deal -> ACE opportunity mapping in session memory.
    
    Called by the frontend after the Partner Central Agent creates an
    opportunity. We don't write the ACE ID back to the CRM deal as a custom
    field (most participants don't have one configured). Instead we cache
    the mapping in memory so "Sync from ACE" can find the right ACE opp.
    """
    try:
        data = request.json or {}
        record_id = data.get('record_id')
        opportunity_id = data.get('opportunity_id')
        crm_type = data.get('crm_type', 'hubspot')
        
        if not record_id or not opportunity_id:
            return jsonify({"error": "record_id and opportunity_id required"}), 400
        
        cache_key = f"{crm_type}:{record_id}"
        crm_to_ace_mapping[cache_key] = opportunity_id
        logger.info(f"Cached CRM->ACE mapping (via agent create): {cache_key} -> {opportunity_id}")
        
        return jsonify({
            "success": True,
            "message": f"Linked ACE {opportunity_id} to {crm_type} record {record_id} (in-session cache)"
        })
        
    except Exception as e:
        logger.error(f"Error in link endpoint: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/crm/get-ace-mapping', methods=['POST'])
def get_ace_mapping():
    """Look up the cached ACE opportunity ID for a given CRM deal."""
    try:
        data = request.json or {}
        record_id = data.get('record_id')
        crm_type = data.get('crm_type', 'hubspot')
        
        if not record_id:
            return jsonify({"error": "record_id required"}), 400
        
        cache_key = f"{crm_type}:{record_id}"
        ace_id = crm_to_ace_mapping.get(cache_key)
        
        return jsonify({
            "success": True,
            "ace_opportunity_id": ace_id,
            "found": ace_id is not None
        })
        
    except Exception as e:
        logger.error(f"Error looking up mapping: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/partnercentral/solutions', methods=['GET'])
def list_partner_solutions():
    """List the partner's registered solutions via Partner Central Selling API.
    
    Demonstrates the "API + Agent" pattern: when the Partner Central Agent
    asks "what solution are you offering?", we use the deterministic API to
    fetch the actual solution IDs registered in the partner's account so
    participants can pick a real one instead of typing free text.
    """
    try:
        agent = OrchestratorAgent()
        solutions = agent.mcp_client.list_solutions(max_results=50)
        return jsonify({
            "success": True,
            "solutions": solutions,
            "count": len(solutions)
        })
    except Exception as e:
        logger.error(f"Error listing solutions: {e}")
        return jsonify({"success": False, "error": str(e), "solutions": []}), 500


@app.route('/api/marketplace/private-offers', methods=['GET'])
def list_private_offers():
    """List private offers from AWS Marketplace Catalog so the user can pick
    one to associate with an opportunity.
    
    Same "API + Agent" pattern as solutions: when the agent asks
    "what private offer should we associate?", call ListEntities with
    Targeting=BuyerAccounts to get the partner's actual private offers
    instead of asking the user to type an offer ID from memory.
    
    Requires `aws-marketplace:ListEntities` IAM permission. Note that
    `AWSPartnerCentralSandboxFullAccess` does NOT include this — see
    CLOUD_ADMIN_SETUP.md for the supplemental policy snippet.
    """
    try:
        agent = OrchestratorAgent()
        # max_results capped at 50 by API; only include released private offers
        result = agent.marketplace_client.list_offers(
            max_results=50,
            targeting='BuyerAccounts',
            state='Released',
        )
        entities = result.get('entities') or result.get('EntitySummaryList') or []
        # Normalize to a small payload — the chip picker only needs id + label.
        offers = []
        for e in entities:
            offer_id = e.get('EntityId') or e.get('Id') or ''
            name = e.get('Name') or e.get('EntityName') or '(unnamed offer)'
            product_id = (
                e.get('OfferSummary', {}).get('ProductId')
                if isinstance(e.get('OfferSummary'), dict)
                else e.get('ProductId') or ''
            )
            if offer_id:
                offers.append({
                    'id': offer_id,
                    'name': name,
                    'product_id': product_id,
                })
        return jsonify({
            "success": True,
            "offers": offers,
            "count": len(offers),
        })
    except Exception as e:
        msg = str(e)
        # Surface the specific permission error so participants know what to fix.
        if 'AccessDenied' in msg or 'not authorized' in msg.lower():
            msg = (
                f"{msg}\n\nThe IAM user/role needs `aws-marketplace:ListEntities`. "
                f"AWSPartnerCentralSandboxFullAccess does NOT include this — "
                f"see CLOUD_ADMIN_SETUP.md for the supplemental policy."
            )
        logger.error(f"Error listing marketplace offers: {e}")
        return jsonify({"success": False, "error": msg, "offers": []}), 500


@app.route('/api/crm/sync-from-ace', methods=['POST'])
def sync_from_ace_to_crm():
    """Pull latest ACE opportunity state and sync to HubSpot deal."""
    try:
        data = request.json or {}
        record_id = data.get('record_id')
        opportunity_id = data.get('opportunity_id')
        token = data.get('token')
        crm_type = data.get('crm_type', 'hubspot')
        
        if not record_id or not opportunity_id:
            return jsonify({"error": "record_id and opportunity_id required"}), 400
        
        if crm_type != 'hubspot':
            return jsonify({"error": "Sync from ACE currently only supports HubSpot"}), 400
        
        if not token:
            return jsonify({"error": "HubSpot token required"}), 400
        
        # Use the existing sync infrastructure
        agent = OrchestratorAgent(hubspot_token=token)
        result = agent.sync_to_hubspot(opportunity_id, record_id)
        
        return jsonify(result)
        
    except Exception as e:
        logger.error(f"Error syncing from ACE: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/crm/reset-deal', methods=['POST'])
def reset_crm_deal():
    """Reset built-in fields on a HubSpot deal for demo re-runs.
    
    Clears `hs_next_step` (Pipedrive's `description` for Pipedrive) so the
    "before sync / after sync" demo can be replayed cleanly. Custom ACE
    fields are not touched because most workshop participants don't have
    them configured.
    
    Note: This only clears CRM fields. The actual ACE opportunity in
    Partner Central is NOT deleted — it still exists.
    """
    try:
        data = request.json or {}
        record_id = data.get('record_id')
        token = data.get('token')
        crm_type = data.get('crm_type', 'hubspot')
        
        if not record_id:
            return jsonify({"error": "record_id required"}), 400
        
        if crm_type != 'hubspot':
            return jsonify({"error": "Reset currently only supports HubSpot"}), 400
        
        if not token:
            return jsonify({"error": "HubSpot token required"}), 400
        
        # Only clear built-in fields so this works on any HubSpot account
        # without requiring custom field configuration.
        import requests as _requests
        response = _requests.patch(
            f"https://api.hubapi.com/crm/v3/objects/deals/{record_id}",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json"
            },
            json={
                "properties": {
                    "hs_next_step": ""
                }
            },
            timeout=15
        )
        response.raise_for_status()
        
        logger.info(f"Reset next-step field on HubSpot deal {record_id}")
        return jsonify({
            "success": True,
            "message": f"Cleared the Next Step field on HubSpot deal {record_id}. The ACE opportunity in Partner Central is unchanged."
        })
        
    except Exception as e:
        logger.error(f"Error resetting deal: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/update-next-steps', methods=['POST'])
def update_next_steps():
    """Generate next steps using AI.
    
    Accepts either JSON (notes-only flow) or multipart/form-data
    (notes + multiple file uploads). Files and inline notes are
    combined into a single context bundle for the agent.
    """
    try:
        # Detect content type — multipart for file uploads, JSON for plain notes
        is_multipart = request.content_type and request.content_type.startswith('multipart/form-data')
        
        if is_multipart:
            opportunity_id = request.form.get('opportunity_id')
            notes = request.form.get('notes', '')
            prompt = request.form.get('prompt', 'Generate next steps based on the context')
            uploaded = request.files.getlist('files')
        else:
            data = request.json or {}
            opportunity_id = data.get('opportunity_id')
            notes = data.get('notes', '')
            prompt = data.get('prompt', 'Generate next steps based on the context')
            uploaded = []
        
        id_err = _validate_opportunity_id(opportunity_id)
        if id_err:
            return id_err

        if not notes and not uploaded:
            return jsonify({"error": "Either notes or at least one file is required"}), 400
        
        # Build the temp-file list — inline notes (if present) + each uploaded file
        import tempfile
        temp_files = []
        
        try:
            if notes:
                with tempfile.NamedTemporaryFile(
                    mode='w', suffix='.txt', delete=False, prefix='inline_notes_'
                ) as f:
                    f.write(notes)
                    temp_files.append(f.name)
            
            for uploaded_file in uploaded:
                if uploaded_file and uploaded_file.filename:
                    suffix = Path(uploaded_file.filename).suffix or '.txt'
                    with tempfile.NamedTemporaryFile(
                        mode='wb', suffix=suffix, delete=False, prefix='upload_'
                    ) as f:
                        uploaded_file.save(f.name)
                        temp_files.append(f.name)
                        logger.info(f"Saved uploaded file {uploaded_file.filename} -> {f.name}")
            
            agent = OrchestratorAgent()
            
            context_sources = agent.gather_context(uploaded_files=temp_files)
            opportunity_data = agent.mcp_client.get_opportunity(opportunity_id)
            next_steps = agent.next_steps_generator.generate(
                context_sources=context_sources,
                prompt=prompt,
                opportunity_data=opportunity_data
            )
            
            response = {
                "success": True,
                "next_steps": next_steps,
                "context_source_count": len(context_sources),
                "file_count": len(uploaded),
            }
            if agent.next_steps_generator.last_warning:
                response["warning"] = agent.next_steps_generator.last_warning
            
            return jsonify(response)
            
        finally:
            for path in temp_files:
                try:
                    os.unlink(path)
                except OSError:
                    pass
            
    except Exception as e:
        logger.error(f"Error generating next steps: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/submit-next-steps', methods=['POST'])
def submit_next_steps():
    """Submit edited next steps to Partner Central via MCP"""
    try:
        data = request.json
        opportunity_id = data.get('opportunity_id')
        next_steps = data.get('next_steps')

        if not next_steps:
            return jsonify({"error": "next_steps required"}), 400
        id_err = _validate_opportunity_id(opportunity_id)
        if id_err:
            return id_err

        # Enforce 255 character limit (Partner Central API constraint)
        if len(next_steps) > 255:
            next_steps = next_steps[:252] + '...'
            logger.warning(f"Next steps truncated to 255 characters for opportunity {opportunity_id}")
        
        agent = OrchestratorAgent()
        logger.info(f"Submitting next steps for opportunity {opportunity_id}")
        logger.info(f"Using catalog: {agent.mcp_client.config.get('catalog', 'NOT SET')}")
        
        # Call MCP to update (non-interactive mode to get approval request)
        mcp_response = agent.mcp_client.update_next_steps(
            opportunity_id, 
            next_steps, 
            interactive=False
        )
        
        logger.info(f"MCP submit response: {json.dumps(mcp_response, indent=2)}")
        
        # Check if approval is required
        try:
            content = mcp_response.get('result', {}).get('content', [])
            if content and content[0].get('type') == 'text':
                inner = json.loads(content[0].get('text', '{}'))
                status = inner.get('status', '')
                session_id = inner.get('sessionId', '')
                
                logger.info(f"MCP submit status: {status}, session_id: {session_id}")
                
                if status == 'requires_approval':
                    # Find tool approval request
                    tool_use_id = None
                    tool_name = None
                    
                    for item in inner.get('content', []):
                        if item.get('type') == 'tool_approval_request':
                            tool_content = item.get('content', {})
                            try:
                                approval_data = json.loads(tool_content.get('text', '{}'))
                                tool_use_id = approval_data.get('tool_use_id')
                                tool_name = approval_data.get('tool_name')
                            except (json.JSONDecodeError, TypeError):
                                tool_use_id = tool_content.get('toolUseId')
                                tool_name = tool_content.get('name')
                            break
                    
                    logger.info(f"Approval required - tool_use_id: {tool_use_id}, tool_name: {tool_name}")
                    
                    return jsonify({
                        "requires_approval": True,
                        "session_id": session_id,
                        "tool_use_id": tool_use_id,
                        "tool_name": tool_name
                    })
                elif status == 'complete':
                    logger.info("MCP update completed without approval")
                    return jsonify({"success": True})
        except Exception as parse_err:
            logger.warning(f"Could not parse MCP response: {parse_err}")
        
        return jsonify({"success": True, "mcp_response": mcp_response})
        
    except Exception as e:
        logger.error(f"Error submitting next steps: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/send-approval', methods=['POST'])
def send_approval():
    """Send approval decision to Partner Central MCP"""
    try:
        data = request.json
        session_id = data.get('session_id')
        tool_use_id = data.get('tool_use_id')
        decision = data.get('decision')
        
        logger.info(f"Sending approval: session_id={session_id}, tool_use_id={tool_use_id}, decision={decision}")
        
        if not all([session_id, tool_use_id, decision]):
            return jsonify({"error": "session_id, tool_use_id, and decision required"}), 400
        
        agent = OrchestratorAgent()
        config = agent.mcp_client.config
        mcp_endpoint = config['endpoints']['partnercentral_mcp']
        catalog = config.get('catalog', 'Sandbox')
        
        logger.info(f"Using MCP endpoint: {mcp_endpoint}, catalog: {catalog}")
        
        approval_payload = {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {
                "name": "sendMessage",
                "arguments": {
                    "content": [{
                        "type": "tool_approval_response",
                        "toolUseId": tool_use_id,
                        "decision": decision
                    }],
                    "catalog": catalog,
                    "sessionId": session_id
                }
            }
        }

        logger.info(f"Approval payload: {json.dumps(approval_payload, indent=2)}")
        
        session = boto3.Session()
        credentials = session.get_credentials()
        service_name = 'partnercentral-agents' if 'gamma' in mcp_endpoint else 'partnercentral-agents-mcp'
        
        def _post_signed(payload):
            aws_req = AWSRequest(
                method='POST',
                url=mcp_endpoint,
                data=json.dumps(payload),
                headers={'Content-Type': 'application/json'}
            )
            SigV4Auth(credentials, service_name, config.get('region', 'us-east-1')).add_auth(aws_req)
            r = requests.post(aws_req.url, data=aws_req.body, headers=dict(aws_req.headers), timeout=120)
            r.raise_for_status()
            return r.json()
        
        result = _post_signed(approval_payload)
        logger.info(f"MCP approval response: {json.dumps(result, indent=2)}")
        
        # Self-healing retry for stale tool_use_id (see create_from_notes_approve)
        err_obj = result.get('error') or {}
        err_msg = err_obj.get('message', '') if isinstance(err_obj, dict) else ''
        if err_msg and 'does not match pending tool request' in err_msg:
            import re as _re
            m = _re.search(r"pending tool request '([^']+)'", err_msg)
            if m:
                correct_id = m.group(1)
                logger.warning(
                    f"Stale tool_use_id '{tool_use_id}' — retrying with '{correct_id}'"
                )
                approval_payload['params']['arguments']['content'][0]['toolUseId'] = correct_id
                result = _post_signed(approval_payload)
                logger.info(f"Retry approval response: {json.dumps(result, indent=2)}")
        
        try:
            content = result.get('result', {}).get('content', [])
            if content and content[0].get('type') == 'text':
                inner = json.loads(content[0].get('text', '{}'))
                status = inner.get('status', '')
                logger.info(f"MCP approval status: {status}")
                
                # Walk the response content. We need to:
                #  1. Capture the agent's narrative (ASSISTANT_RESPONSE text)
                #  2. Detect tool failures inside serverToolResult — these can
                #     happen even when status='complete' (e.g., "Failed to
                #     create benefit application: ACCESS allocation required")
                #  3. Catch a follow-up tool_approval_request if the agent
                #     retries after a recoverable failure
                agent_text_parts = []
                tool_failures = []
                follow_up_approval = None
                
                for item in inner.get('content', []):
                    item_type = item.get('type', '')
                    if item_type == 'ASSISTANT_RESPONSE':
                        c = item.get('content', {})
                        if isinstance(c, dict) and c.get('text', '').strip():
                            agent_text_parts.append(c['text'].strip())
                    elif item_type == 'serverToolResult':
                        c = item.get('content', {})
                        out = c.get('output', '')
                        # Tool errors come back as text inside the output
                        if isinstance(out, str) and (
                            'failed' in out.lower()
                            or 'validationexception' in out.lower()
                            or 'is required' in out.lower()
                            or '"errorcode"' in out.lower()
                        ):
                            tool_failures.append(out)
                    elif item_type == 'tool_approval_request':
                        try:
                            ta = json.loads(item.get('content', {}).get('text', '{}'))
                            follow_up_approval = {
                                'tool_use_id': ta.get('tool_use_id'),
                                'tool_name': ta.get('tool_name', 'Unknown'),
                            }
                        except Exception:
                            pass
                
                agent_text = '\n\n'.join(agent_text_parts)
                
                if status == 'requires_approval' and follow_up_approval:
                    return jsonify({
                        "success": False,
                        "requires_approval": True,
                        "tool_use_id": follow_up_approval['tool_use_id'],
                        "tool_name": follow_up_approval['tool_name'],
                        "message": agent_text,
                    })
                
                if tool_failures:
                    logger.warning(f"MCP tool failure detected: {tool_failures[0][:200]}")
                    return jsonify({
                        "success": False,
                        "error": tool_failures[0],
                        "message": agent_text or tool_failures[0],
                    })
                
                if status == 'complete':
                    return jsonify({
                        "success": True,
                        "message": agent_text or "Request completed.",
                    })
                
                if status in ('error', 'failed'):
                    error_msg = inner.get('error', 'Update failed')
                    logger.error(f"MCP update failed: {error_msg}")
                    return jsonify({
                        "success": False,
                        "error": error_msg,
                        "message": agent_text or error_msg,
                    })
                
                logger.warning(f"Unexpected MCP status: {status}")
        except Exception as parse_err:
            logger.warning(f"Could not parse MCP approval response: {parse_err}")
        
        # If we can't determine success from the response, check if there was an error
        if 'error' in result:
            return jsonify({"success": False, "error": result.get('error')})
        
        # Default: assume success if decision was approve and no error
        logger.info("Assuming success based on approve decision")
        return jsonify({"success": decision == 'approve', "response": result})
        
    except Exception as e:
        logger.error(f"Error sending approval: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/chat', methods=['POST'])
def chat():
    """Conversational Q&A about opportunities via Partner Central MCP"""
    try:
        data = request.json
        opportunity_id = data.get('opportunity_id')
        question = data.get('question')
        session_id = data.get('session_id')

        if not question:
            return jsonify({"error": "question required"}), 400
        # opportunity_id is optional for pipeline-level questions; only validate format if provided
        if opportunity_id:
            id_err = _validate_opportunity_id(opportunity_id)
            if id_err:
                return id_err
        
        agent = OrchestratorAgent()
        config = agent.mcp_client.config

        q_lower = question.lower()
        import re as _re

        # Intent: list engagement invitations from AWS (optionally filtered by
        # country). The Partner Central Agent has no tool for invitations; the
        # custom orchestrator chains ListEngagementInvitations (date filter)
        # + GetEngagementInvitation (per item) to read customer country, then
        # filters locally. Demonstrates another value prop of the custom
        # orchestrator vs. the off-the-shelf PC Agent.
        invitation_triggers = [
            'engagement invitation', 'engagement invitations',
            'opportunities shared by aws', 'opportunities shared from aws',
            'invitations from aws', 'aws shared opportunities',
            'opportunities aws shared', 'shared by aws',
        ]
        # Check if the previous turn in this session was an engagement-invitation
        # query. If so, treat short follow-ups like "how about Europe?" or
        # "what about LATAM last 6 months?" as continuations of that intent.
        tracker_key = session_id or '_no_mcp_session'
        prev_intent = _last_chat_intent_by_session.get(tracker_key)
        invitation_followup_phrases = (
            'how about ', 'what about ', 'and ', 'in ', 'for ', 'show me ',
            'show ', 'list ',
        )
        is_invitation_followup = (
            prev_intent == 'engagement_invitations'
            and any(p in q_lower or q_lower.startswith(p) for p in invitation_followup_phrases)
        )

        if any(t in q_lower for t in invitation_triggers) or is_invitation_followup:
            # Named-region detection. Maps a region/country phrase to either
            # a single ISO code or a list of ISO codes for regional groupings.
            # AWS standard geos: NAMER, EMEA, APAC, LATAM.
            region_map = {
                'us region': 'US', 'us country': 'US', 'united states': 'US',
                'uk region': 'GB', 'united kingdom': 'GB', 'uk country': 'GB',
                'india': 'IN', 'germany': 'DE', 'japan': 'JP', 'australia': 'AU',
                'canada': 'CA', 'france': 'FR', 'brazil': 'BR',
                'namer': ['CA', 'MX', 'US'],
                'north america': ['CA', 'MX', 'US'],
                'emea': ['AT', 'BE', 'BG', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GB', 'GR', 'HR', 'HU', 'IE', 'IS', 'IT', 'LI', 'LT', 'LU', 'LV', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'UK', 'AE', 'BH', 'EG', 'IL', 'JO', 'KW', 'LB', 'MA', 'OM', 'QA', 'SA', 'TN', 'TR', 'ZA', 'NG', 'KE', 'GH'],
                'europe region': ['AT', 'BE', 'BG', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GB', 'GR', 'HR', 'HU', 'IE', 'IS', 'IT', 'LI', 'LT', 'LU', 'LV', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'UK'],
                'europe': ['AT', 'BE', 'BG', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GB', 'GR', 'HR', 'HU', 'IE', 'IS', 'IT', 'LI', 'LT', 'LU', 'LV', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'UK'],
                'european': ['AT', 'BE', 'BG', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GB', 'GR', 'HR', 'HU', 'IE', 'IS', 'IT', 'LI', 'LT', 'LU', 'LV', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'UK'],
                'apac': ['AU', 'BD', 'CN', 'HK', 'ID', 'IN', 'JP', 'KR', 'MY', 'NZ', 'PH', 'SG', 'TH', 'TW', 'VN'],
                'asia pacific': ['AU', 'BD', 'CN', 'HK', 'ID', 'IN', 'JP', 'KR', 'MY', 'NZ', 'PH', 'SG', 'TH', 'TW', 'VN'],
                'asia': ['BD', 'CN', 'HK', 'ID', 'IN', 'JP', 'KR', 'MY', 'PH', 'SG', 'TH', 'TW', 'VN'],
                'latam': ['AR', 'BR', 'CL', 'CO', 'MX', 'PE'],
                'latin america': ['AR', 'BR', 'CL', 'CO', 'MX', 'PE'],
                'middle east': ['AE', 'BH', 'EG', 'IL', 'JO', 'KW', 'OM', 'QA', 'SA'],
                'mena': ['AE', 'BH', 'DZ', 'EG', 'IL', 'JO', 'KW', 'LB', 'MA', 'OM', 'QA', 'SA', 'TN'],
                'africa': ['EG', 'GH', 'KE', 'MA', 'NG', 'ZA'],
            }
            country_code = None
            matched_region_label = None
            for kw, code in region_map.items():
                if kw in q_lower:
                    country_code = code
                    matched_region_label = kw
                    break
            # Fallback: look for explicit ISO code patterns like "country=US",
            # "country code US", or "in US region/country" (must be preceded by
            # a word like 'region/country/customer' to avoid matching parts of
            # other English words such as 'past').
            if not country_code:
                # Two separate, unambiguous regexes (no overlapping \s* groups,
                # bounded whitespace) to avoid ReDoS while still catching
                # "country US", "country code: US", "country=US", "customer in US".
                country_match = _re.search(
                    r'\bcountry(?:\s{1,3}code)?\s{0,3}[=:]?\s{0,3}([a-z]{2})\b',
                    q_lower,
                )
                if not country_match:
                    country_match = _re.search(
                        r'\bcustomer\s{1,3}in\s{1,3}([a-z]{2})\b',
                        q_lower,
                    )
                if country_match:
                    country_code = country_match.group(1).upper()

            since_days_match = _re.search(r'(?:last|past)\s+(\d+)\s+(day|month)s?', q_lower)
            since_days = 30
            if since_days_match:
                n = int(since_days_match.group(1))
                since_days = n if since_days_match.group(2) == 'day' else n * 30
            elif 'last month' in q_lower or 'past month' in q_lower:
                since_days = 30
            elif 'last week' in q_lower or 'past week' in q_lower:
                since_days = 7
            elif 'last 6 months' in q_lower or 'last six months' in q_lower or 'past 6 months' in q_lower:
                since_days = 180
            elif 'last year' in q_lower or 'past year' in q_lower:
                since_days = 365

            try:
                invitations = agent.find_engagement_invitations_by_country(
                    country_code=country_code, since_days=since_days, limit=50
                )
                country_label = ''
                if isinstance(country_code, str) and country_code:
                    country_label = f' for {country_code}'
                elif isinstance(country_code, list) and country_code:
                    if matched_region_label:
                        country_label = f' for {matched_region_label.title()} ({len(country_code)} countries)'
                    else:
                        country_label = f' for region ({len(country_code)} countries)'
                if not invitations:
                    answer = (
                        f"No engagement invitations from AWS found{country_label} in the last {since_days} days.\n\n"
                        f"💡 Note: the Partner Central Agent has no tool for engagement invitations. "
                        f"This orchestrator chained `ListEngagementInvitations` (date-filtered) and "
                        f"`GetEngagementInvitation` (per item, to read customer country) to surface them."
                    )
                else:
                    lines = [f"### Engagement invitations from AWS{country_label} (last {since_days} days)\n"]
                    lines.append(f"Found **{len(invitations)}** invitation{'s' if len(invitations) != 1 else ''}:\n")
                    lines.append("| Invitation ID | Title | Customer | Country | Industry | Status | Invitation Date |")
                    lines.append("|---|---|---|---|---|---|---|")
                    for i in invitations[:25]:
                        inv_date = i.get('invitation_date') or ''
                        if hasattr(inv_date, 'strftime'):
                            inv_date = inv_date.strftime('%Y-%m-%d')
                        else:
                            inv_date = str(inv_date)[:10]
                        lines.append(
                            f"| `{i.get('id')}` | {i.get('engagement_title', '')[:25]} | "
                            f"{i.get('customer_company', '')[:20]} | {i.get('customer_country', '') or '—'} | "
                            f"{i.get('customer_industry', '')[:18]} | {i.get('status', '')} | "
                            f"{inv_date} |"
                        )
                    if country_code:
                        country_filter_str = (
                            country_code if isinstance(country_code, str)
                            else ', '.join(country_code)
                        )
                        lines.append(
                            f"\n💡 *The Partner Central Agent has no tool for engagement invitations. "
                            f"The orchestrator called `ListEngagementInvitations` with the date filter, then "
                            f"`GetEngagementInvitation` for each summary to read the customer's country code, "
                            f"and filtered locally to country in [`{country_filter_str}`].*"
                        )
                    else:
                        lines.append(
                            f"\n💡 *The Partner Central Agent has no tool for engagement invitations. "
                            f"The orchestrator called `ListEngagementInvitations` with the date filter, then "
                            f"`GetEngagementInvitation` for each summary to read the full payload.*"
                        )
                    answer = '\n'.join(lines)
                # Track the last intent so follow-ups like "how about Europe?"
                # route to the same handler. We use the existing session_id
                # when present, and fall back to a per-process key.
                tracker_key = session_id or '_no_mcp_session'
                _last_chat_intent_by_session[tracker_key] = 'engagement_invitations'
                return jsonify({
                    "answer": answer,
                    "session_id": session_id,
                })
            except Exception as e:
                logger.error(f"Error finding engagement invitations: {e}", exc_info=True)
                return jsonify({
                    "answer": "❌ Error finding engagement invitations. Please check the server logs for details.",
                    "session_id": session_id,
                })

        # Intent: find AWS-originated (AO) opportunities. The Partner Central
        # Agent cannot reliably filter by Origin = 'AWS Referral'; the custom
        # orchestrator chains ListOpportunities + GetAwsOpportunitySummary +
        # GetOpportunity to surface them. Demonstrates a key value prop of the
        # custom orchestrator vs. the off-the-shelf PC Agent.
        ao_triggers = [
            'aws originated opportunit', 'aws-originated opportunit',
            'ao opportunit', 'aws referral opportunit', 'opportunities from aws',
            'opportunities aws sent', 'awsoriginated', 'aws originated leads',
        ]
        if any(t in q_lower for t in ao_triggers):
            since_days_match = _re.search(r'last\s+(\d+)\s+(day|month)s?', q_lower)
            since_days = 180
            if since_days_match:
                n = int(since_days_match.group(1))
                since_days = n if since_days_match.group(2) == 'day' else n * 30
            elif 'last month' in q_lower:
                since_days = 30
            elif 'last week' in q_lower:
                since_days = 7
            elif 'last year' in q_lower:
                since_days = 365

            try:
                ao_opps = agent.find_ao_opportunities(since_days=since_days, limit=100)
                if not ao_opps:
                    answer = (
                        f"No AWS-originated opportunities found in the last {since_days} days.\n\n"
                        f"💡 Note: the Partner Central Agent's pipeline tools cannot filter "
                        f"by `Origin = 'AWS Referral'`. This orchestrator chains `ListOpportunities` "
                        f"+ `GetAwsOpportunitySummary` + `GetOpportunity` to find them — a value "
                        f"prop of building your own agent layer."
                    )
                else:
                    lines = [f"### AWS-originated opportunities (last {since_days} days)\n"]
                    lines.append(f"Found **{len(ao_opps)}** AO opportunit{'y' if len(ao_opps) == 1 else 'ies'} (Origin = 'AWS Referral'):\n")
                    lines.append("| Opportunity ID | Customer | Country | Stage | Region | Target Close | Last Modified |")
                    lines.append("|---|---|---|---|---|---|---|")
                    for o in ao_opps[:25]:
                        last_mod = o.get('last_modified_date') or ''
                        if hasattr(last_mod, 'strftime'):
                            last_mod = last_mod.strftime('%Y-%m-%d')
                        else:
                            last_mod = str(last_mod)[:10]
                        target_close = o.get('target_close_date') or ''
                        if hasattr(target_close, 'strftime'):
                            target_close = target_close.strftime('%Y-%m-%d')
                        lines.append(
                            f"| `{o.get('id')}` | {o.get('customer_name', '')[:30]} | "
                            f"{o.get('country_code', '')} | {o.get('stage', '')} | "
                            f"{o.get('region', '') or '—'} | {target_close or '—'} | "
                            f"{last_mod} |"
                        )
                    lines.append(
                        f"\n💡 *The Partner Central Agent cannot filter by Origin. The orchestrator "
                        f"called `ListOpportunities` then `GetAwsOpportunitySummary` for each, "
                        f"filtered on `Origin = 'AWS Referral'`, and used `GetOpportunity` to enrich "
                        f"with stage and region.*"
                    )
                    answer = '\n'.join(lines)
                return jsonify({
                    "answer": answer,
                    "session_id": session_id,
                })
            except Exception as e:
                logger.error(f"Error finding AO opportunities: {e}", exc_info=True)
                return jsonify({
                    "answer": "❌ Error finding AO opportunities. Please check the server logs for details.",
                    "session_id": session_id,
                })

        # Check if user wants raw opportunity data or current status - call API directly for fresh data
        status_keywords = ['json', 'payload', 'raw data', 'complete data', 'full data', 'all fields', 'all data', 'getopportunity', 'review status', 'current status', 'what is the status', 'what\'s the status']
        if opportunity_id and any(word in question.lower() for word in status_keywords):
            try:
                opp_data = agent.mcp_client.get_opportunity(opportunity_id)
                if opp_data:
                    # Check if it's a status query vs full data query
                    if any(word in question.lower() for word in ['review status', 'current status', 'what is the status', 'what\'s the status']):
                        # Extract just the review status info
                        review = opp_data.get('OpportunityTeam', [{}])
                        lifecycle = opp_data.get('LifeCycle', {})
                        review_status = lifecycle.get('ReviewStatus', 'Unknown')
                        stage = lifecycle.get('Stage', 'Unknown')
                        
                        answer = f"**Current Status for {opportunity_id}:**\n\n"
                        answer += f"• Review Status: **{review_status}**\n"
                        answer += f"• Stage: **{stage}**\n"
                        
                        if lifecycle.get('NextSteps'):
                            answer += f"• Next Steps: {lifecycle.get('NextSteps')}\n"
                        if lifecycle.get('TargetCloseDate'):
                            answer += f"• Target Close Date: {lifecycle.get('TargetCloseDate')}\n"
                        
                        return jsonify({
                            "answer": answer,
                            "session_id": None  # Don't maintain session for status queries
                        })
                    else:
                        # Full JSON response
                        formatted_json = json.dumps(opp_data, indent=2, default=str)
                        return jsonify({
                            "answer": f"**GetOpportunity Response for {opportunity_id}:**\n\n```json\n{formatted_json}\n```",
                            "session_id": session_id
                        })
                else:
                    return jsonify({
                        "answer": f"Could not retrieve opportunity {opportunity_id}. Please check the ID is correct.",
                        "session_id": session_id
                    })
            except Exception as api_err:
                return jsonify({
                    "answer": f"Error calling GetOpportunity API: {str(api_err)}",
                    "session_id": session_id
                })
        
        # Check if user wants to associate a solution - call API directly
        import re
        associate_keywords = ['associate', 'link', 'attach', 'add solution', 'connect solution']
        solution_pattern = r'[XS]\d{5,}'  # Pattern for solution IDs like X10003, S12345
        
        if any(word in question.lower() for word in associate_keywords):
            solution_match = re.search(solution_pattern, question, re.IGNORECASE)
            if solution_match:
                solution_id = solution_match.group(0).upper()
                try:
                    logger.info(f"Associating solution {solution_id} with opportunity {opportunity_id}")
                    
                    # Call the associate_opportunity API directly
                    pc_client = agent.mcp_client.pc_client
                    response = pc_client.associate_opportunity(
                        Catalog=config.get('catalog', 'Sandbox'),
                        OpportunityIdentifier=opportunity_id,
                        RelatedEntityType='Solutions',
                        RelatedEntityIdentifier=solution_id
                    )
                    
                    logger.info(f"Association response: {response}")
                    
                    return jsonify({
                        "answer": f"✅ **Solution Associated Successfully!**\n\n• Opportunity: {opportunity_id}\n• Solution: {solution_id}\n\nThe solution has been linked to this opportunity.",
                        "session_id": None
                    })
                    
                except Exception as assoc_err:
                    error_msg = str(assoc_err)
                    logger.error(f"Error associating solution: {error_msg}")
                    return jsonify({
                        "answer": f"❌ **Failed to associate solution**\n\n• Opportunity: {opportunity_id}\n• Solution: {solution_id}\n• Error: {error_msg}",
                        "session_id": session_id
                    })
        
        mcp_endpoint = config['endpoints']['partnercentral_mcp']
        
        # Build the question with opportunity context
        if opportunity_id and opportunity_id.lower() not in question.lower():
            full_question = f"For opportunity {opportunity_id}: {question}"
        else:
            full_question = question
        
        # Build MCP request
        mcp_payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "sendMessage",
                "arguments": {
                    "content": [{
                        "type": "text",
                        "text": full_question
                    }],
                    "catalog": config.get('catalog', 'Sandbox')
                }
            }
        }

        if session_id:
            mcp_payload["params"]["arguments"]["sessionId"] = session_id
        
        session = boto3.Session()
        credentials = session.get_credentials()
        
        aws_request = AWSRequest(
            method='POST',
            url=mcp_endpoint,
            data=json.dumps(mcp_payload),
            headers={'Content-Type': 'application/json'}
        )
        
        service_name = 'partnercentral-agents' if 'gamma' in mcp_endpoint else 'partnercentral-agents-mcp'
        SigV4Auth(credentials, service_name, config.get('region', 'us-east-1')).add_auth(aws_request)
        
        response = requests.post(
            aws_request.url,
            data=aws_request.body,
            headers=dict(aws_request.headers),
            timeout=120
        )
        response.raise_for_status()
        
        result = response.json()
        logger.info(f"MCP Chat Response: {json.dumps(result, indent=2)}")
        
        answer = "I couldn't get an answer. Please try again."
        new_session_id = session_id
        
        try:
            content = result.get('result', {}).get('content', [])
            if content and content[0].get('type') == 'text':
                inner_text = content[0].get('text', '{}')
                inner = json.loads(inner_text)
                
                new_session_id = inner.get('sessionId', session_id)
                status = inner.get('status', '')
                
                # Extract the assistant's response - look for ASSISTANT_RESPONSE type
                for item in reversed(inner.get('content', [])):
                    item_type = item.get('type', '')
                    if item_type == 'ASSISTANT_RESPONSE':
                        item_content = item.get('content', {})
                        if isinstance(item_content, dict) and 'text' in item_content:
                            answer = item_content['text']
                            break
                    elif item_type == 'text':
                        answer = item.get('text', answer)
                        break
                
                if status == 'requires_approval':
                    for item in inner.get('content', []):
                        if item.get('type') == 'tool_approval_request':
                            tool_content = item.get('content', {})
                            try:
                                approval_data = json.loads(tool_content.get('text', '{}'))
                                tool_name = approval_data.get('tool_name', '')
                                if 'get' in tool_name.lower() or 'list' in tool_name.lower() or 'read' in tool_name.lower():
                                    tool_use_id = approval_data.get('tool_use_id')
                                    approval_result = auto_approve_tool(
                                        mcp_endpoint, config, credentials, service_name,
                                        new_session_id, tool_use_id
                                    )
                                    if approval_result:
                                        return jsonify(approval_result)
                            except Exception:
                                pass

                    # For write operations (update, create, delete), return approval request to frontend
                    for item in inner.get('content', []):
                        if item.get('type') == 'tool_approval_request':
                            tool_content = item.get('content', {})
                            try:
                                approval_data = json.loads(tool_content.get('text', '{}'))
                                tool_name = approval_data.get('tool_name', 'Unknown')
                                tool_use_id = approval_data.get('tool_use_id')
                                tool_input = approval_data.get('input', {})
                                
                                # Return approval request for user to decide
                                return jsonify({
                                    "requires_approval": True,
                                    "session_id": new_session_id,
                                    "tool_use_id": tool_use_id,
                                    "tool_name": tool_name,
                                    "tool_input": tool_input,
                                    "answer": f"🔐 **Approval Required**\n\nThe agent wants to execute: **{tool_name}**\n\nPlease approve or reject this action."
                                })
                            except Exception as parse_approval_err:
                                logger.warning(f"Could not parse approval request: {parse_approval_err}")
                    
                    answer = "The agent needs approval but couldn't parse the request. Please try again."
                    
        except Exception as parse_err:
            logger.warning(f"Could not parse MCP chat response: {parse_err}")
            try:
                answer = str(result)[:500]
            except Exception:
                pass
        
        return jsonify({
            "answer": answer,
            "session_id": new_session_id
        })
        
    except Exception as e:
        logger.error(f"Error in chat: {e}")
        return jsonify({"error": str(e)}), 500


def auto_approve_tool(mcp_endpoint, config, credentials, service_name, session_id, tool_use_id, decision='approve'):
    """Auto-approve (or auto-reject) a tool request and return the result.
    
    The optional `decision` arg lets callers reject a tool the user has
    opted out of (e.g., submission tools when in 'create-only' mode).
    """
    try:
        approval_payload = {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {
                "name": "sendMessage",
                "arguments": {
                    "content": [{
                        "type": "tool_approval_response",
                        "toolUseId": tool_use_id,
                        "decision": decision
                    }],
                    "catalog": config.get('catalog', 'Sandbox'),
                    "sessionId": session_id
                }
            }
        }

        aws_request = AWSRequest(
            method='POST',
            url=mcp_endpoint,
            data=json.dumps(approval_payload),
            headers={'Content-Type': 'application/json'}
        )
        
        SigV4Auth(credentials, service_name, config.get('region', 'us-east-1')).add_auth(aws_request)
        
        response = requests.post(
            aws_request.url,
            data=aws_request.body,
            headers=dict(aws_request.headers),
            timeout=120
        )
        response.raise_for_status()
        
        result = response.json()
        
        answer = "Request completed."
        try:
            content = result.get('result', {}).get('content', [])
            if content and content[0].get('type') == 'text':
                inner = json.loads(content[0].get('text', '{}'))
                for item in reversed(inner.get('content', [])):
                    item_type = item.get('type', '')
                    if item_type == 'ASSISTANT_RESPONSE':
                        item_content = item.get('content', {})
                        if isinstance(item_content, dict) and 'text' in item_content:
                            answer = item_content['text']
                            break
                    elif item_type == 'text':
                        answer = item.get('text', answer)
                        break
        except Exception:
            pass

        return {
            "answer": answer,
            "session_id": session_id
        }

    except Exception as e:
        logger.error(f"Error in auto-approve: {e}")
        return None


@app.route('/api/hubspot/validate-token', methods=['POST'])
def hubspot_validate_token():
    """Quick HubSpot token check used by the Process Call tab before it does
    any writes. Returns {valid: bool, error: str|None}."""
    data = request.json or {}
    token = (data.get('token') or '').strip() or os.environ.get('HUBSPOT_BEARER_TOKEN')
    if not token:
        return jsonify({"valid": False, "error": "No token provided"}), 200
    from crm.hubspot_client import HubSpotClient
    check = HubSpotClient(token).validate_token()
    if check.get("valid"):
        return jsonify({"valid": True, "error": None}), 200
    code = check.get("status_code")
    if code in (401, 403):
        msg = "Token is invalid or lacks permissions (need deal + contact read/write)."
    else:
        msg = f"Could not reach HubSpot to validate the token: {check.get('error')}"
    return jsonify({"valid": False, "error": msg}), 200


@app.route('/api/process-call', methods=['POST'])
def process_call():
    """End-to-end "Process Call" demo: call notes -> HubSpot deal -> ACE
    opportunity -> optional co-sell submit. Gated by PROCESS_CALL_ENABLED
    because it creates a REAL deal in the connected CRM.

    Accepts JSON or multipart (notes + optional file uploads). Requires a
    HubSpot token with deal + contact write scopes.
    """
    if not PROCESS_CALL_ENABLED:
        return jsonify({"error": "Process Call is disabled. Set process_call_enabled=true in config.json to enable it."}), 403
    try:
        is_multipart = request.content_type and request.content_type.startswith('multipart/form-data')
        if is_multipart:
            notes = request.form.get('notes', '') or ''
            hubspot_token = request.form.get('hubspot_token') or None
            submit_to_aws = (request.form.get('submit_to_aws', '') or '').lower() in ('true', '1', 'yes')
            blocks = []
            if notes.strip():
                blocks.append(notes.strip())
            for f in request.files.getlist('files'):
                if not f or not f.filename:
                    continue
                try:
                    text = f.read().decode('utf-8', errors='replace').strip()
                    if text:
                        blocks.append(f"=== File: {f.filename} ===\n{text}")
                except Exception as read_err:
                    logger.warning(f"Could not read uploaded file {f.filename}: {read_err}")
            notes = '\n\n'.join(blocks)
        else:
            data = request.json or {}
            notes = data.get('notes') or ''
            hubspot_token = data.get('hubspot_token') or None
            submit_to_aws = bool(data.get('submit_to_aws', False))

        if not notes.strip():
            return jsonify({"error": "Provide call notes (text or a file)"}), 400

        hubspot_token = hubspot_token or os.environ.get('HUBSPOT_BEARER_TOKEN')
        if not hubspot_token:
            return jsonify({"error": "HubSpot token is required. Enter it on the CRM → ACE tab and click Load HubSpot Deals first."}), 400

        agent = OrchestratorAgent(hubspot_token=hubspot_token)

        # Validate the token before creating anything, so a bad token fails
        # fast with a clear message instead of a half-created state.
        token_check = agent.hubspot_client.validate_token()
        if not token_check.get("valid"):
            code = token_check.get("status_code")
            if code in (401, 403):
                return jsonify({"error": "HubSpot token is invalid or lacks permissions. "
                                         "Re-check the token on the CRM → ACE tab (Load HubSpot Deals should succeed), "
                                         "and ensure it has deal + contact read/write scopes."}), 400
            return jsonify({"error": f"Could not reach HubSpot to validate the token: {token_check.get('error')}"}), 400

        result = agent.process_call_from_notes(notes, submit_to_aws=submit_to_aws)

        if result.get("success") and result.get("ace_opportunity_id"):
            # Cache the CRM->ACE mapping so the other tabs can pick it up.
            crm_to_ace_mapping[f"hubspot:{result['deal_id']}"] = result["ace_opportunity_id"]

        status = 200 if result.get("success") else 500
        return jsonify(result), status
    except Exception as e:
        logger.error(f"Error in process-call: {e}", exc_info=True)
        return jsonify({"error": "Process call failed. Check the server logs for details."}), 500


@app.route('/api/create-from-notes', methods=['POST'])
def create_from_notes():
    """Create an opportunity via Partner Central Agent from meeting notes.
    
    Accepts either JSON (notes-only) or multipart/form-data (notes plus
    multiple file uploads). When files are uploaded, their contents are
    appended to the inline notes before being sent to the agent so the
    agent treats everything as one context bundle.
    """
    try:
        is_multipart = request.content_type and request.content_type.startswith('multipart/form-data')
        
        if is_multipart:
            notes = request.form.get('notes', '') or ''
            session_id = request.form.get('session_id') or None
            allow_submit = (request.form.get('allow_submit', '') or '').lower() in ('true', '1', 'yes')
            uploaded = request.files.getlist('files')
            
            # Concatenate inline notes + each uploaded file. Each block is
            # labelled so the agent can tell sources apart in its reasoning.
            blocks = []
            if notes.strip():
                blocks.append(f"=== Inline notes ===\n{notes.strip()}")
            for f in uploaded:
                if not f or not f.filename:
                    continue
                try:
                    raw = f.read()
                    # Decode as text — most demo notes are .txt/.md/.json/.csv
                    text = raw.decode('utf-8', errors='replace').strip()
                    if text:
                        blocks.append(f"=== File: {f.filename} ===\n{text}")
                except Exception as read_err:
                    logger.warning(f"Could not read uploaded file {f.filename}: {read_err}")
            
            if not blocks:
                return jsonify({"error": "Provide at least notes text or one file"}), 400
            
            notes = '\n\n'.join(blocks)
            logger.info(
                f"create-from-notes received {len(uploaded)} file(s) + "
                f"{'inline notes' if notes else 'no inline notes'} → "
                f"{len(notes)} chars total"
            )
        else:
            data = request.json or {}
            notes = data.get('notes')
            session_id = data.get('session_id')
            allow_submit = bool(data.get('allow_submit', False))
            
            if not notes:
                return jsonify({"error": "notes field is required"}), 400
        
        # Track the policy for this session. We can't know the session_id
        # before the first call, so on a brand-new session we'll register
        # the policy after we get the assigned id back.
        
        agent = OrchestratorAgent()
        config = agent.mcp_client.config
        mcp_endpoint = config['endpoints']['partnercentral_mcp']
        
        # Build MCP request
        mcp_payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "sendMessage",
                "arguments": {
                    "content": [{
                        "type": "text",
                        "text": notes
                    }],
                    "catalog": config.get('catalog', 'Sandbox')
                }
            }
        }

        if session_id:
            mcp_payload["params"]["arguments"]["sessionId"] = session_id
        
        session = boto3.Session()
        credentials = session.get_credentials()
        
        aws_request = AWSRequest(
            method='POST',
            url=mcp_endpoint,
            data=json.dumps(mcp_payload),
            headers={'Content-Type': 'application/json'}
        )
        
        service_name = 'partnercentral-agents' if 'gamma' in mcp_endpoint else 'partnercentral-agents-mcp'
        SigV4Auth(credentials, service_name, config.get('region', 'us-east-1')).add_auth(aws_request)
        
        response = requests.post(
            aws_request.url,
            data=aws_request.body,
            headers=dict(aws_request.headers),
            timeout=120
        )
        response.raise_for_status()
        
        result = response.json()
        logger.info(f"Create from Notes MCP Response: {json.dumps(result, indent=2)}")
        
        answer = "I couldn't process the request. Please try again."
        new_session_id = session_id
        
        try:
            content = result.get('result', {}).get('content', [])
            if content and content[0].get('type') == 'text':
                inner = json.loads(content[0].get('text', '{}'))
                new_session_id = inner.get('sessionId', session_id)
                status = inner.get('status', '')
                
                # Update the submit policy for this session. The frontend
                # passes allow_submit on each call, so flipping the checkbox
                # later (e.g., when the user clicks "Submit to AWS") takes
                # effect immediately for subsequent tool calls.
                if new_session_id:
                    session_allow_submit[new_session_id] = allow_submit
                effective_allow_submit = allow_submit
                
                # Extract assistant response
                for item in reversed(inner.get('content', [])):
                    item_type = item.get('type', '')
                    if item_type == 'ASSISTANT_RESPONSE':
                        item_content = item.get('content', {})
                        if isinstance(item_content, dict) and 'text' in item_content:
                            answer = item_content['text']
                            break
                
                # Handle approval requests
                if status == 'requires_approval':
                    # The MCP server only tracks ONE pending approval at a time.
                    # If the response contains multiple tool_approval_request blocks
                    # (e.g., from prior turns), we must use the **last** one — that's
                    # the currently pending request the server expects to receive a
                    # decision for. Using an older tool_use_id causes
                    # ResourceNotFoundException: "does not match pending tool request".
                    approval_requests = [
                        item for item in inner.get('content', [])
                        if item.get('type') == 'tool_approval_request'
                    ]
                    
                    for item in reversed(approval_requests):
                        tool_content = item.get('content', {})
                        try:
                            approval_data = json.loads(tool_content.get('text', '{}'))
                            tool_name = approval_data.get('tool_name', 'Unknown')
                            tool_use_id = approval_data.get('tool_use_id')
                            
                            # POLICY GUARD: if the user opted for "create only"
                            # but the agent is trying to submit, auto-reject.
                            if _is_submit_tool(tool_name) and not effective_allow_submit:
                                logger.warning(
                                    f"Auto-rejecting submit tool '{tool_name}' "
                                    f"(session {new_session_id} is create-only)"
                                )
                                # Reject the submit, then keep the conversation
                                # going so the agent acknowledges the rejection.
                                rejection_result = auto_approve_tool(
                                    mcp_endpoint, config, credentials, service_name,
                                    new_session_id, tool_use_id, decision='reject'
                                )
                                rejection_note = (
                                    "\n\n⚠️ **Auto-blocked**: The agent attempted to "
                                    f"submit the opportunity (`{tool_name}`), but you chose "
                                    "**create-only** mode. The submission was automatically "
                                    "rejected. Use the **📤 Submit to AWS** button when "
                                    "you're ready to submit."
                                )
                                if rejection_result:
                                    new_answer = rejection_result.get('answer', answer)
                                    return jsonify({
                                        "answer": (new_answer or '') + rejection_note,
                                        "session_id": rejection_result.get('session_id', new_session_id),
                                    })
                                # If the reject call itself failed, fall through to
                                # surface the approval to the user so they can reject manually.
                            
                            # Auto-approve read operations
                            if 'get' in tool_name.lower() or 'list' in tool_name.lower() or 'read' in tool_name.lower() or 'search' in tool_name.lower():
                                approval_result = auto_approve_tool(
                                    mcp_endpoint, config, credentials, service_name,
                                    new_session_id, tool_use_id
                                )
                                if approval_result:
                                    return jsonify({
                                        "answer": approval_result.get('answer', answer),
                                        "session_id": approval_result.get('session_id', new_session_id),
                                        "needs_more_info": True
                                    })
                            
                            # For write operations, return approval request to frontend
                            logger.info(f"Returning approval request: tool_name={tool_name}, tool_use_id={tool_use_id}")
                            return jsonify({
                                "requires_approval": True,
                                "session_id": new_session_id,
                                "tool_use_id": tool_use_id,
                                "tool_name": tool_name,
                                "answer": answer
                            })
                        except Exception as parse_err:
                            logger.warning(f"Could not parse approval: {parse_err}")
                            continue
                
                # Check if agent needs more info (no approval, but asking questions)
                if status == 'complete' and '?' in answer:
                    return jsonify({
                        "answer": answer,
                        "session_id": new_session_id,
                        "needs_more_info": True
                    })
                    
        except Exception as parse_err:
            logger.warning(f"Could not parse create-from-notes response: {parse_err}")
        
        return jsonify({
            "answer": answer,
            "session_id": new_session_id
        })
        
    except Exception as e:
        logger.error(f"Error in create-from-notes: {e}")
        return jsonify({"error": str(e)}), 500


@app.route('/api/create-from-notes-approve', methods=['POST'])
def create_from_notes_approve():
    """Send approval decision for create-from-notes flow."""
    try:
        data = request.json
        session_id = data.get('session_id')
        tool_use_id = data.get('tool_use_id')
        decision = data.get('decision', 'approve')
        # Frontend may send allow_submit to update the per-session policy
        # (e.g., user clicks "Submit to AWS" after a create-only session).
        if 'allow_submit' in data and session_id:
            session_allow_submit[session_id] = bool(data.get('allow_submit'))
        
        if not session_id or not tool_use_id:
            return jsonify({"error": "session_id and tool_use_id required"}), 400
        
        agent = OrchestratorAgent()
        config = agent.mcp_client.config
        mcp_endpoint = config['endpoints']['partnercentral_mcp']
        
        session = boto3.Session()
        credentials = session.get_credentials()
        service_name = 'partnercentral-agents' if 'gamma' in mcp_endpoint else 'partnercentral-agents-mcp'
        
        def _send_approval(tool_use_id_to_send):
            """Send a single approval request and return the parsed JSON result."""
            payload = {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {
                    "name": "sendMessage",
                    "arguments": {
                        "content": [{
                            "type": "tool_approval_response",
                            "toolUseId": tool_use_id_to_send,
                            "decision": decision
                        }],
                        "catalog": config.get('catalog', 'Sandbox'),
                        "sessionId": session_id
                    }
                }
            }
            req = AWSRequest(
                method='POST',
                url=mcp_endpoint,
                data=json.dumps(payload),
                headers={'Content-Type': 'application/json'}
            )
            SigV4Auth(credentials, service_name, config.get('region', 'us-east-1')).add_auth(req)
            resp = requests.post(req.url, data=req.body, headers=dict(req.headers), timeout=120)
            resp.raise_for_status()
            return resp.json()
        
        result = _send_approval(tool_use_id)
        logger.info(f"Create from Notes Approval Response: {json.dumps(result, indent=2)}")
        
        # Self-healing retry: if the cached tool_use_id is stale (a new
        # approval was issued in a later turn), the MCP server returns
        # "does not match pending tool request '<correct_id>'". Parse the
        # correct id from the error and retry once. This commonly happens
        # when the user replies again after seeing the approval prompt.
        err_obj = result.get('error') or {}
        err_msg = err_obj.get('message', '') if isinstance(err_obj, dict) else ''
        if err_msg and 'does not match pending tool request' in err_msg:
            import re as _re
            m = _re.search(r"pending tool request '([^']+)'", err_msg)
            if m:
                correct_id = m.group(1)
                logger.warning(
                    f"Stale tool_use_id '{tool_use_id}' — retrying with server's "
                    f"current pending id '{correct_id}'"
                )
                result = _send_approval(correct_id)
                logger.info(f"Retry approval response: {json.dumps(result, indent=2)}")
                tool_use_id = correct_id  # update for any downstream logging
        
        # If the response is still an error after the retry attempt, surface it.
        err_obj = result.get('error') or {}
        if err_obj:
            err_text = err_obj.get('message', str(err_obj)) if isinstance(err_obj, dict) else str(err_obj)
            logger.error(f"Approval failed: {err_text}")
            return jsonify({
                "error": err_text,
                "answer": (
                    f"❌ Approval failed: {err_text}\n\n"
                    f"This usually happens when a newer approval request superseded "
                    f"the one you clicked. Try clicking **Approve** again on the most "
                    f"recent prompt, or restart the conversation."
                ),
                "session_id": session_id,
            }), 200  # 200 so the frontend renders the message instead of throwing
        
        # Parse the MCP response. After approval, the agent typically returns:
        #  - Multiple ASSISTANT_RESPONSE blocks (status updates from the agent)
        #  - A serverToolResult containing the actual CreateOpportunity API response
        #    with the new opportunity Id, ReviewStatus, Stage, etc.
        # We extract both — the agent narrative and the API result — so the
        # user sees what the API actually returned, not just "Request processed."
        answer_parts = []
        opportunity_id = None
        review_status = None
        stage = None
        new_approval = None  # Captures a follow-up tool_approval_request, if any
        
        try:
            content = result.get('result', {}).get('content', [])
            if content and content[0].get('type') == 'text':
                inner = json.loads(content[0].get('text', '{}'))
                inner_status = inner.get('status', '')
                
                # Collect every assistant response in order
                for item in inner.get('content', []):
                    item_type = item.get('type', '')
                    if item_type == 'ASSISTANT_RESPONSE':
                        item_content = item.get('content', {})
                        if isinstance(item_content, dict) and 'text' in item_content:
                            text = item_content['text'].strip()
                            if text:
                                answer_parts.append(text)
                    elif item_type == 'tool_approval_request':
                        # The agent issued a follow-up tool call (e.g., a retry
                        # with corrected payload after a validation error, or
                        # a follow-up submit after a successful create).
                        try:
                            ta = json.loads(item.get('content', {}).get('text', '{}'))
                            new_approval = {
                                'tool_use_id': ta.get('tool_use_id'),
                                'tool_name': ta.get('tool_name', 'Unknown'),
                            }
                        except Exception as ta_err:
                            logger.warning(f"Could not parse follow-up approval: {ta_err}")
                    elif item_type == 'serverToolResult':
                        # Extract the actual API response — usually a JSON string
                        tool_content = item.get('content', {})
                        output = tool_content.get('output', '')
                        try:
                            tool_data = json.loads(output) if isinstance(output, str) else output
                        except (json.JSONDecodeError, TypeError):
                            tool_data = {}
                        
                        # CreateOpportunity response is nested under "CreateOpportunity"
                        # in the tool result wrapper
                        create_resp = (
                            tool_data.get('CreateOpportunity', {}).get('response', tool_data)
                            if isinstance(tool_data, dict) else {}
                        )
                        
                        if isinstance(create_resp, dict):
                            opp_id = create_resp.get('Id') or tool_data.get('Id')
                            if opp_id and isinstance(opp_id, str) and opp_id.startswith('O'):
                                opportunity_id = opp_id
                            # Some responses include lifecycle info inline
                            lifecycle = create_resp.get('LifeCycle', {})
                            if isinstance(lifecycle, dict):
                                review_status = lifecycle.get('ReviewStatus') or review_status
                                stage = lifecycle.get('Stage') or stage
        except Exception as parse_err:
            logger.warning(f"Could not fully parse approval response: {parse_err}")
        
        # If we found the opportunity ID but no agent narrative mentions it,
        # fetch fresh details so we can confirm review status to the user.
        if opportunity_id and not (review_status and stage):
            try:
                opp = agent.mcp_client.get_opportunity(opportunity_id)
                if opp:
                    lc = opp.get('LifeCycle', {})
                    review_status = review_status or lc.get('ReviewStatus')
                    stage = stage or lc.get('Stage')
            except Exception as get_err:
                logger.warning(f"Could not fetch opportunity {opportunity_id} after create: {get_err}")
        
        # Build the final response message
        if decision == 'reject':
            answer = "❌ Opportunity creation rejected."
        elif opportunity_id:
            agent_text = '\n\n'.join(answer_parts) if answer_parts else ''
            confirmation = (
                f"✅ **Opportunity created successfully!**\n\n"
                f"- **ACE Opportunity ID:** `{opportunity_id}`\n"
                f"- **Review Status:** {review_status or 'Pending Submission'}\n"
                f"- **Stage:** {stage or 'Prospect'}\n\n"
                f"You can view it in Partner Central or use the **Ask Questions** tab "
                f"to query it (the ID has been auto-filled in the other tabs)."
            )
            answer = (agent_text + '\n\n' + confirmation).strip() if agent_text else confirmation
        elif answer_parts:
            answer = '\n\n'.join(answer_parts)
        else:
            answer = (
                "Request processed, but I couldn't parse the agent's response. "
                "Check the demo UI server log for the raw MCP payload."
            )
        
        # If the agent issued a follow-up tool call (e.g., retry after a
        # validation error, OR a submit after a successful create), handle
        # it according to the per-session policy.
        if new_approval and new_approval.get('tool_use_id'):
            allow_submit = session_allow_submit.get(session_id, False)
            
            if _is_submit_tool(new_approval.get('tool_name')) and not allow_submit:
                # POLICY GUARD: user is in create-only mode; reject the submit.
                logger.warning(
                    f"Auto-rejecting follow-up submit tool '{new_approval['tool_name']}' "
                    f"in session {session_id}"
                )
                rejection_result = auto_approve_tool(
                    mcp_endpoint, config, credentials, service_name,
                    session_id, new_approval['tool_use_id'], decision='reject'
                )
                rejection_note = (
                    "\n\n⚠️ **Auto-blocked**: After creating the opportunity, the agent "
                    f"tried to submit it via `{new_approval['tool_name']}`, but you chose "
                    "**create-only** mode. The submission was automatically rejected. "
                    "Click **📤 Submit to AWS** above when you're ready."
                )
                final_answer = answer + rejection_note
                return jsonify({
                    "answer": final_answer,
                    "session_id": session_id,
                    "opportunity_id": opportunity_id,
                    "review_status": review_status or 'Pending Submission',
                    "stage": stage,
                })
            
            # Otherwise, surface the approval to the user
            return jsonify({
                "answer": answer,
                "session_id": session_id,
                "requires_approval": True,
                "tool_use_id": new_approval['tool_use_id'],
                "tool_name": new_approval['tool_name'],
            })
        
        return jsonify({
            "answer": answer,
            "session_id": session_id,
            "opportunity_id": opportunity_id,
            "review_status": review_status,
            "stage": stage,
        })
        
    except Exception as e:
        logger.error(f"Error in create-from-notes-approve: {e}")
        return jsonify({"error": str(e)}), 500


if __name__ == '__main__':
    print("\n" + "="*60)
    print("🤖 Agent-to-Agent Demo UI")
    print("="*60)
    print("Open http://localhost:8002 in your browser")
    print("="*60 + "\n")
    
    app.run(host='0.0.0.0', port=8002, debug=True)
