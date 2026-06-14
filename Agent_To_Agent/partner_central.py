"""Partner Central clients: MCP agent (sendMessage) + Selling/Marketplace APIs."""

import json
import logging
from pathlib import Path
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)


class PartnerCentralMCPClient:
    """Client for Partner Central MCP to update opportunities"""
    
    def __init__(self, config_path: str = None):
        self.config = self._load_config(config_path)
        self._pc_client = None
    
    def _load_config(self, config_path: str = None) -> Dict:
        """Load configuration"""
        if config_path and Path(config_path).exists():
            with open(config_path) as f:
                return json.load(f)
        
        # Try same directory config first
        local_config = Path(__file__).parent / 'config.json'
        if local_config.exists():
            with open(local_config) as f:
                return json.load(f)
        
        # Try parent directory config
        parent_config = Path(__file__).parent.parent / 'config.json'
        if parent_config.exists():
            with open(parent_config) as f:
                return json.load(f)
        
        return {
            "catalog": "AWS",
            "region": "us-east-1",
            "endpoints": {
                "partnercentral_selling": "https://partnercentral-selling.us-east-1.api.aws",
                "partnercentral_mcp": "https://partnercentral-agents.us-east-1.api.aws/mcp"
            }
        }
    
    @property
    def pc_client(self):
        """Get Partner Central selling client"""
        if self._pc_client is None:
            import boto3
            self._pc_client = boto3.client(
                'partnercentral-selling',
                region_name=self.config.get('region', 'us-east-1'),
                endpoint_url=self.config['endpoints']['partnercentral_selling']
            )
        return self._pc_client
    
    def get_opportunity(self, opportunity_id: str) -> Dict:
        """Fetch opportunity data"""
        try:
            response = self.pc_client.get_opportunity(
                Catalog=self.config.get('catalog', 'AWS'),
                Identifier=opportunity_id
            )
            return response
        except Exception as e:
            logger.error(f"Error fetching opportunity {opportunity_id}: {e}")
            return {}
    
    def list_solutions(self, max_results: int = 50) -> List[Dict]:
        """List the partner's registered solutions via Partner Central Selling API.
        
        This is a complement to the Partner Central Agent flow: when the agent
        asks "what solution are you offering?", the orchestrator can call this
        method to fetch real solution IDs that the partner has registered, then
        present them as picker options instead of asking the user to type free text.
        
        Demonstrates the "API + Agent" pattern — API for deterministic data lookups,
        Agent for natural-language guidance.
        """
        try:
            response = self.pc_client.list_solutions(
                Catalog=self.config.get('catalog', 'AWS'),
                MaxResults=min(max_results, 100)
            )
            solutions = []
            for s in response.get('SolutionSummaries', []):
                solutions.append({
                    'id': s.get('Id', ''),
                    'name': s.get('Name', 'Untitled'),
                    'category': s.get('Category', ''),
                    'status': s.get('Status', ''),
                    'arn': s.get('Arn', ''),
                })
            logger.info(f"ListSolutions returned {len(solutions)} solutions from {self.config.get('catalog')} catalog")
            return solutions
        except Exception as e:
            logger.error(f"Error listing solutions: {e}")
            return []

    def list_opportunities(self, max_results: int = 50, since_days: int = None) -> List[Dict]:
        """List opportunities for the current partner via Partner Central Selling API.

        Args:
            max_results: Max opportunities to return per page (default 50, max 100).
            since_days: If set, only include opportunities last modified in this
                many days. Helpful for the AO opportunity finder.
        """
        try:
            params = {
                'Catalog': self.config.get('catalog', 'AWS'),
                'MaxResults': min(max_results, 100),
            }
            if since_days:
                from datetime import datetime, timedelta, timezone
                since = datetime.now(timezone.utc) - timedelta(days=since_days)
                params['LastModifiedDate'] = {
                    'AfterLastModifiedDate': since.isoformat(),
                }
            opportunities = []
            next_token = None
            while True:
                if next_token:
                    params['NextToken'] = next_token
                response = self.pc_client.list_opportunities(**params)
                opportunities.extend(response.get('OpportunitySummaries', []))
                next_token = response.get('NextToken')
                if not next_token:
                    break
                if len(opportunities) >= 500:
                    logger.warning('Stopping ListOpportunities pagination at 500 results')
                    break
            logger.info(f'ListOpportunities returned {len(opportunities)} opportunity summaries')
            return opportunities
        except Exception as e:
            logger.error(f'Error listing opportunities: {e}')
            return []

    def get_aws_opportunity_summary(self, opportunity_id: str) -> Dict:
        """Fetch the AWS-side summary of an opportunity (returns Origin, InvolvementType, etc.)."""
        try:
            response = self.pc_client.get_aws_opportunity_summary(
                Catalog=self.config.get('catalog', 'AWS'),
                RelatedOpportunityIdentifier=opportunity_id,
            )
            return response
        except Exception as e:
            logger.warning(f'Error fetching AwsOpportunitySummary for {opportunity_id}: {e}')
            return {}

    def find_ao_opportunities(self, since_days: int = 180, limit: int = 100) -> List[Dict]:
        """Find AWS-originated (Origin = 'AWS Referral') opportunities.

        The Partner Central Agent's pipeline tools cannot reliably filter by
        Origin = 'AWS Referral'. This orchestrator method chains multiple PC
        Selling APIs to do it ourselves: ListOpportunities -> GetAwsOpportunitySummary
        for each -> filter on Origin -> GetOpportunity for region details.

        Args:
            since_days: Look back this many days (default 180).
            limit: Max opportunities to scan (default 100, hard cap to keep
                latency reasonable in the chat UI).

        Returns:
            List of dicts with keys: id, customer_name, stage, target_close_date,
            origin, involvement_type, region, country_code, last_modified_date.
        """
        from concurrent.futures import ThreadPoolExecutor
        summaries = self.list_opportunities(max_results=100, since_days=since_days)
        if not summaries:
            return []
        if len(summaries) > limit:
            logger.info(f'Truncating scan from {len(summaries)} to {limit} opportunities')
            summaries = summaries[:limit]

        def _check_one(opp_summary):
            opp_id = opp_summary.get('Id')
            if not opp_id:
                return None
            aws_summary = self.get_aws_opportunity_summary(opp_id)
            if (aws_summary.get('Origin') or '').strip().lower() != 'aws referral':
                return None
            full = self.get_opportunity(opp_id) or {}
            project = full.get('Project', {}) or {}
            customer = full.get('Customer', {}) or {}
            account = customer.get('Account', {}) or {}
            return {
                'id': opp_id,
                'customer_name': account.get('CompanyName', 'Unknown'),
                'country_code': account.get('Address', {}).get('CountryCode', ''),
                'stage': (full.get('LifeCycle', {}) or {}).get('Stage', ''),
                'target_close_date': (full.get('LifeCycle', {}) or {}).get('TargetCloseDate', ''),
                'origin': aws_summary.get('Origin'),
                'involvement_type': aws_summary.get('InvolvementType'),
                'region': (
                    aws_summary.get('Region')
                    or project.get('Region')
                    or account.get('Address', {}).get('CountryCode', '')
                    or ''
                ),
                'last_modified_date': opp_summary.get('LastModifiedDate', ''),
            }

        with ThreadPoolExecutor(max_workers=8) as ex:
            results = [r for r in ex.map(_check_one, summaries) if r]

        def _sort_key(item):
            v = item.get('last_modified_date') or ''
            if hasattr(v, 'isoformat'):
                return v.isoformat()
            return str(v)
        results.sort(key=_sort_key, reverse=True)
        logger.info(f'find_ao_opportunities: {len(results)} AO opportunity(ies) found')
        return results

    def list_engagement_invitations(self, since_days: int = 30, max_results: int = 50,
                                    participant_type: str = 'RECEIVER') -> List[Dict]:
        """List engagement invitations received from AWS, optionally filtered by date.

        Args:
            since_days: Only include invitations dated within the last N days.
                Set to None to disable the date filter.
            max_results: Max items per page (1-50, hard cap).
            participant_type: 'RECEIVER' for invitations sent TO this account,
                'SENDER' for invitations sent BY this account.

        Returns:
            List of EngagementInvitationSummary dicts (Id, EngagementTitle,
            Status, InvitationDate, SenderAwsAccountId, etc.).
        """
        try:
            params = {
                'Catalog': self.config.get('catalog', 'AWS'),
                'MaxResults': min(max_results, 50),
                'ParticipantType': participant_type,
            }
            invitations = []
            next_token = None
            while True:
                if next_token:
                    params['NextToken'] = next_token
                response = self.pc_client.list_engagement_invitations(**params)
                invitations.extend(response.get('EngagementInvitationSummaries', []))
                next_token = response.get('NextToken')
                if not next_token:
                    break
                if len(invitations) >= 200:
                    logger.warning('Stopping ListEngagementInvitations pagination at 200 results')
                    break

            if since_days:
                from datetime import datetime, timedelta, timezone
                cutoff = datetime.now(timezone.utc) - timedelta(days=since_days)

                def _on_or_after_cutoff(inv):
                    inv_date = inv.get('InvitationDate')
                    if not inv_date:
                        return False
                    if hasattr(inv_date, 'tzinfo'):
                        return inv_date >= cutoff
                    try:
                        from datetime import datetime as _dt
                        parsed = _dt.fromisoformat(str(inv_date).replace('Z', '+00:00'))
                        return parsed >= cutoff
                    except Exception:
                        return True

                invitations = [i for i in invitations if _on_or_after_cutoff(i)]

            logger.info(f'list_engagement_invitations: {len(invitations)} invitation(s) returned')
            return invitations
        except Exception as e:
            logger.error(f'Error listing engagement invitations: {e}')
            return []

    def get_engagement_invitation(self, invitation_id: str) -> Dict:
        """Fetch the full payload of an engagement invitation including customer details."""
        try:
            response = self.pc_client.get_engagement_invitation(
                Catalog=self.config.get('catalog', 'AWS'),
                Identifier=invitation_id,
            )
            return response
        except Exception as e:
            logger.warning(f'Error fetching engagement invitation {invitation_id}: {e}')
            return {}

    def find_engagement_invitations_by_country(self, country_code=None,
                                               since_days: int = 30,
                                               limit: int = 50) -> List[Dict]:
        """Find engagement invitations from AWS, optionally filtered by customer country.

        The Partner Central Agent has no tool for engagement invitations. The
        custom orchestrator chains ListEngagementInvitations with date filter
        + GetEngagementInvitation per item to read the customer country code,
        then filters locally to deliver country-scoped pipeline results.

        Args:
            country_code: Either a single ISO country code (e.g., 'US'), a list
                of codes (e.g., ['DE', 'FR', 'IT']) for regional groupings, or
                None to return all.
            since_days: Only invitations from the last N days (default 30).
            limit: Max invitations to scan (default 50).
        """
        from concurrent.futures import ThreadPoolExecutor
        summaries = self.list_engagement_invitations(
            since_days=since_days, max_results=50, participant_type='RECEIVER'
        )
        if not summaries:
            return []
        if len(summaries) > limit:
            logger.info(f'Truncating engagement invitation scan from {len(summaries)} to {limit}')
            summaries = summaries[:limit]

        if isinstance(country_code, str):
            target_countries = {country_code.strip().upper()} if country_code.strip() else None
        elif isinstance(country_code, (list, tuple, set)):
            target_countries = {c.strip().upper() for c in country_code if c and c.strip()} or None
        else:
            target_countries = None

        def _enrich_one(summary):
            inv_id = summary.get('Id')
            if not inv_id:
                return None
            detail = self.get_engagement_invitation(inv_id)
            payload = (detail.get('Payload') or {}).get('OpportunityInvitation') or {}
            customer = payload.get('Customer') or {}
            project = payload.get('Project') or {}
            inv_country = (customer.get('CountryCode') or '').strip().upper()
            if target_countries and inv_country not in target_countries:
                return None
            return {
                'id': inv_id,
                'engagement_title': summary.get('EngagementTitle', ''),
                'status': summary.get('Status', ''),
                'invitation_date': summary.get('InvitationDate'),
                'expiration_date': summary.get('ExpirationDate'),
                'sender_aws_account_id': summary.get('SenderAwsAccountId', ''),
                'sender_company_name': summary.get('SenderCompanyName', ''),
                'customer_company': customer.get('CompanyName', ''),
                'customer_country': inv_country,
                'customer_industry': customer.get('Industry', ''),
                'project_title': project.get('Title', ''),
                'project_business_problem': (project.get('BusinessProblem') or '')[:120],
            }

        with ThreadPoolExecutor(max_workers=8) as ex:
            results = [r for r in ex.map(_enrich_one, summaries) if r]

        def _sort_key(item):
            v = item.get('invitation_date') or ''
            if hasattr(v, 'isoformat'):
                return v.isoformat()
            return str(v)
        results.sort(key=_sort_key, reverse=True)
        logger.info(f'find_engagement_invitations_by_country: {len(results)} invitation(s) match')
        return results

    def create_opportunity(self, deal: 'HubSpotDeal', project_title: str = None) -> Dict:
        """Create a new ACE opportunity from HubSpot deal data using the HubSpot mapper"""
        try:
            from crm.hubspot_mapper import HubSpotToPartnerCentralMapper
            
            # Use the mapper to convert HubSpot deal to Partner Central format
            mapper = HubSpotToPartnerCentralMapper(catalog=self.config.get('catalog', 'Sandbox'))
            request_payload = mapper.map_deal_to_opportunity(deal, project_title)
            
            logger.info(f"Creating opportunity from HubSpot deal {deal.deal_id}...")
            logger.info(f"  PartnerOpportunityIdentifier: {request_payload.get('PartnerOpportunityIdentifier')}")
            logger.info(f"  TargetCloseDate: {request_payload.get('LifeCycle', {}).get('TargetCloseDate')}")
            logger.info(f"📤 CREATE OPPORTUNITY REQUEST: {json.dumps(request_payload, separators=(',', ':'))}")
            
            response = self.pc_client.create_opportunity(**request_payload)
            
            logger.info(f"📥 CREATE OPPORTUNITY RESPONSE: {json.dumps(response, separators=(',', ':'), default=str)}")
            logger.info(f"Opportunity created successfully: {response.get('Id', 'Unknown')}")
            
            return {
                "success": True,
                "opportunity_id": response.get("Id"),
                "response": response
            }
            
        except Exception as e:
            logger.error(f"❌ CREATE OPPORTUNITY ERROR: {e}")
            return {
                "success": False,
                "error": str(e)
            }
    
    def create_opportunity_from_salesforce(self, opp: 'SalesforceOpportunity', project_title: str = None) -> Dict:
        """Create a new ACE opportunity from Salesforce opportunity data using the Salesforce mapper"""
        try:
            from crm.salesforce_mapper import SalesforceToPartnerCentralMapper
            
            # Use the mapper to convert Salesforce opportunity to Partner Central format
            mapper = SalesforceToPartnerCentralMapper(catalog=self.config.get('catalog', 'Sandbox'))
            request_payload = mapper.map_opportunity_to_ace(opp, project_title)
            
            logger.info(f"Creating opportunity from Salesforce opportunity {opp.opportunity_id}...")
            partner_opp_identifier = request_payload.get('PartnerOpportunityIdentifier')
            masked_partner_opp_identifier = (
                f"***{str(partner_opp_identifier)[-4:]}" if partner_opp_identifier else "Unknown"
            )
            logger.info(f"  PartnerOpportunityIdentifier: {masked_partner_opp_identifier}")
            logger.info(f"  TargetCloseDate: {request_payload.get('LifeCycle', {}).get('TargetCloseDate')}")
            logger.info("📤 CREATE OPPORTUNITY REQUEST prepared (payload redacted)")
            
            response = self.pc_client.create_opportunity(**request_payload)
            
            response_id = response.get('Id')
            masked_response_id = f"***{str(response_id)[-4:]}" if response_id else "Unknown"
            logger.info(f"📥 CREATE OPPORTUNITY RESPONSE received (Id: {masked_response_id})")
            logger.info(f"Opportunity created successfully: {masked_response_id}")
            
            return {
                "success": True,
                "opportunity_id": response.get("Id"),
                "response": response
            }
            
        except Exception as e:
            logger.error(f"❌ CREATE OPPORTUNITY ERROR: {e}")
            return {
                "success": False,
                "error": str(e)
            }
    
    def create_opportunity_from_pipedrive(self, deal: 'PipedriveDeal', project_title: str = None) -> Dict:
        """Create a new ACE opportunity from Pipedrive deal data using the Pipedrive mapper"""
        try:
            from crm.pipedrive_mapper import PipedriveToPartnerCentralMapper

            mapper = PipedriveToPartnerCentralMapper(catalog=self.config.get('catalog', 'Sandbox'))
            request_payload = mapper.map_deal_to_opportunity(deal, project_title)

            logger.info(f"Creating opportunity from Pipedrive deal {deal.deal_id}...")
            logger.info(f"  PartnerOpportunityIdentifier: {request_payload.get('PartnerOpportunityIdentifier')}")
            logger.info(f"  TargetCloseDate: {request_payload.get('LifeCycle', {}).get('TargetCloseDate')}")
            logger.info(f"📤 CREATE OPPORTUNITY REQUEST: {json.dumps(request_payload, separators=(',', ':'))}")

            response = self.pc_client.create_opportunity(**request_payload)

            logger.info(f"📥 CREATE OPPORTUNITY RESPONSE: {json.dumps(response, separators=(',', ':'), default=str)}")
            logger.info(f"Opportunity created successfully: {response.get('Id', 'Unknown')}")

            return {
                "success": True,
                "opportunity_id": response.get("Id"),
                "response": response,
            }

        except Exception as e:
            logger.error(f"❌ CREATE OPPORTUNITY ERROR: {e}")
            return {
                "success": False,
                "error": str(e),
            }

    # ------------------------------------------------------------------
    # Shared MCP plumbing
    #
    # The Partner Central agent is reached over JSON-RPC `tools/call` with a
    # single `sendMessage` tool, SigV4-signed, plus a custom approval
    # handshake (tool_approval_request -> tool_approval_response). These
    # helpers centralize that protocol so both update_next_steps() and the
    # REST /api/ask endpoint share one implementation instead of duplicating
    # the signing + approval dance.
    # ------------------------------------------------------------------
    def _signed_post(self, payload: Dict) -> Dict:
        """SigV4-sign and POST a JSON-RPC payload to the PC MCP endpoint."""
        import boto3
        import requests
        from botocore.auth import SigV4Auth
        from botocore.awsrequest import AWSRequest

        endpoint = self.config['endpoints']['partnercentral_mcp']
        # gamma uses a different signing service name than prod/sandbox.
        service_name = 'partnercentral-agents' if 'gamma' in endpoint else 'partnercentral-agents-mcp'

        credentials = boto3.Session().get_credentials()
        request = AWSRequest(
            method='POST',
            url=endpoint,
            data=json.dumps(payload),
            headers={'Content-Type': 'application/json'},
        )
        SigV4Auth(credentials, service_name, self.config.get('region', 'us-east-1')).add_auth(request)

        response = requests.post(
            request.url,
            data=request.body,
            headers=dict(request.headers),
            timeout=120,
        )
        response.raise_for_status()
        return response.json()

    def _build_send_payload(self, text: str, session_id: str = None) -> Dict:
        """Build a `sendMessage` JSON-RPC payload carrying a text message."""
        arguments = {
            "content": [{"type": "text", "text": text}],
            "catalog": self.config.get('catalog', 'AWS'),
        }
        if session_id:
            arguments["sessionId"] = session_id
        return {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": "sendMessage", "arguments": arguments},
        }

    def _build_approval_payload(self, tool_use_id: str, decision: str, session_id: str) -> Dict:
        """Build a `sendMessage` payload that answers a tool approval request."""
        return {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {
                "name": "sendMessage",
                "arguments": {
                    "content": [{
                        "type": "tool_approval_response",
                        "toolUseId": tool_use_id,
                        "decision": decision,
                    }],
                    "catalog": self.config.get('catalog', 'AWS'),
                    "sessionId": session_id,
                },
            },
        }

    @staticmethod
    def _parse_envelope(mcp_response: Dict) -> Dict:
        """Return the inner agent payload (status/sessionId/content) from a result."""
        content = mcp_response.get('result', {}).get('content', [])
        if content and content[0].get('type') == 'text':
            try:
                return json.loads(content[0].get('text', '{}'))
            except (json.JSONDecodeError, TypeError):
                return {}
        return {}

    @staticmethod
    def _extract_approval(inner: Dict):
        """Return (tool_use_id, tool_name, tool_input) from a requires_approval payload."""
        for item in inner.get('content', []):
            if item.get('type') == 'tool_approval_request':
                tool_content = item.get('content', {})
                try:
                    approval_data = json.loads(tool_content.get('text', '{}'))
                    return (approval_data.get('tool_use_id'),
                            approval_data.get('tool_name'),
                            approval_data.get('input'))
                except (json.JSONDecodeError, TypeError, AttributeError):
                    return (tool_content.get('toolUseId'),
                            tool_content.get('name'),
                            tool_content.get('input'))
        return None, None, None

    @staticmethod
    def _extract_answer(inner: Dict, default: str = "No response from the agent.") -> str:
        """Pull the latest assistant text out of an agent payload."""
        for item in reversed(inner.get('content', [])):
            item_type = item.get('type', '')
            if item_type == 'ASSISTANT_RESPONSE':
                item_content = item.get('content', {})
                if isinstance(item_content, dict) and 'text' in item_content:
                    return item_content['text']
            elif item_type == 'text':
                return item.get('text', default)
        return default

    def send_message(self, text: str, session_id: str = None, decision: str = 'approve') -> Dict:
        """Send one natural-language message to the Partner Central agent.

        Transparently completes the approval handshake (using `decision`,
        'approve' or 'reject', for any tool the agent asks to run) since there
        is no human at a TTY for REST/programmatic callers.

        Returns a dict with: ``result`` (final raw MCP response), ``answer``
        (assistant text), ``session_id``, and ``status``.
        """
        result = self._signed_post(self._build_send_payload(text, session_id))
        inner = self._parse_envelope(result)
        session_id = inner.get('sessionId', session_id)

        if inner.get('status') == 'requires_approval':
            tool_use_id, _, _ = self._extract_approval(inner)
            if tool_use_id:
                result = self._signed_post(
                    self._build_approval_payload(tool_use_id, decision, session_id)
                )
                inner = self._parse_envelope(result)
                session_id = inner.get('sessionId', session_id)

        return {
            'result': result,
            'answer': self._extract_answer(inner),
            'session_id': session_id,
            'status': inner.get('status', ''),
        }

    def update_next_steps(
        self,
        opportunity_id: str,
        next_steps: str,
        interactive: bool = True,
        auto_approve: bool = False,
    ) -> Dict:
        """Update opportunity's NextSteps field via the Partner Central agent.

        Args:
            opportunity_id: ACE opportunity id (e.g., O15081741)
            next_steps: text to write into LifeCycle.NextSteps
            interactive: when True, prompts at the terminal for y/n approval
            auto_approve: when True, automatically approves the update
                without prompting. Use for non-interactive callers (REST
                API, scheduled jobs). Has no effect if `interactive` is True.
        """
        if len(next_steps) > 255:
            next_steps = next_steps[:252] + '...'
            logger.warning("Next steps truncated to 255 characters (Partner Central limit)")

        text = (
            f"Update opportunity {opportunity_id} with the following next steps:\n\n"
            f"{next_steps}\n\n"
            "Please update the LifeCycle.NextSteps field with this content."
        )

        try:
            result = self._signed_post(self._build_send_payload(text))
            inner = self._parse_envelope(result)

            # No approval needed (or unexpected shape) — return as-is.
            if inner.get('status') != 'requires_approval':
                return result

            tool_use_id, tool_name, tool_input = self._extract_approval(inner)
            if not tool_use_id:
                logger.warning("No tool approval request found in response")
                return result

            session_id = inner.get('sessionId', '')
            if interactive:
                decision = self._prompt_for_decision(tool_name, session_id, tool_input)
            else:
                decision = 'approve' if auto_approve else 'reject'
                logger.info(f"Auto-{decision} for tool {tool_name} (tool_use_id={tool_use_id})")

            logger.info(f"Sending {decision} decision...")
            final_result = self._signed_post(
                self._build_approval_payload(tool_use_id, decision, session_id)
            )
            self._report_update_outcome(final_result, decision)
            return final_result
        except Exception as e:
            logger.error(f"Error updating opportunity via MCP: {e}")
            return {"error": str(e)}

    @staticmethod
    def _prompt_for_decision(tool_name: str, session_id: str, tool_input) -> str:
        """Show the interactive approval prompt and return 'approve'/'reject'."""
        print("\n" + "="*60)
        print("🔐 APPROVAL REQUIRED")
        print("="*60)
        print(f"Tool: {tool_name}")
        print(f"Session: {session_id}")
        if tool_input:
            try:
                input_data = json.loads(tool_input) if isinstance(tool_input, str) else tool_input
                print(f"Action: Update NextSteps field")
                if 'NextSteps' in str(input_data):
                    print(f"Content preview: {str(input_data)[:200]}...")
            except (json.JSONDecodeError, TypeError):
                print(f"Input: {str(tool_input)[:200]}...")
        print("="*60)

        while True:
            choice = input("\nApprove this update? [y/n]: ").strip().lower()
            if choice in ['y', 'yes']:
                return 'approve'
            if choice in ['n', 'no']:
                return 'reject'
            print("Please enter 'y' or 'n'")

    def _report_update_outcome(self, final_result: Dict, decision: str) -> None:
        """Parse the final MCP response and print a human-readable outcome."""
        try:
            final_inner = self._parse_envelope(final_result)
            if not final_inner:
                return
            final_status = final_inner.get('status', '')

            update_error = None
            for item in final_inner.get('content', []):
                if item.get('type') == 'serverToolResult':
                    output = item.get('content', {}).get('output', '')
                    try:
                        output_data = json.loads(output)
                        update_resp = output_data.get('UpdateOpportunity', {}).get('response', {})
                        if 'error' in update_resp:
                            error_info = update_resp['error']
                            update_error = error_info.get('message', str(error_info))
                    except (json.JSONDecodeError, TypeError, AttributeError):
                        if 'error' in output.lower():
                            update_error = output

            if update_error:
                print("\n" + "="*60)
                print("❌ UPDATE FAILED")
                print("="*60)
                print(f"Error: {update_error}")
                print("="*60)
            elif final_status == 'complete':
                print("\n✅ Update approved and completed!")
            elif decision == 'reject':
                print("\n❌ Update rejected by user.")
        except Exception as parse_err:
            logger.warning(f"Could not parse final status: {parse_err}")



class MarketplaceCatalogClient:
    """
    AWS Marketplace Catalog API client for read-only operations.
    
    Provides access to DescribeEntity and ListEntities from the AWS Marketplace
    Catalog API, enabling queries about products, offers (including private offers),
    and other Marketplace entities.
    
    Required IAM permissions:
        - aws-marketplace:DescribeEntity
        - aws-marketplace:ListEntities
    
    Or use the managed policy: AWSMarketplaceSellerProductsReadOnly
    """
    
    def __init__(self, region: str = 'us-east-1'):
        self.region = region
        self._client = None
    
    @property
    def client(self):
        """Get Marketplace Catalog boto3 client (lazy initialization)"""
        if self._client is None:
            import boto3
            self._client = boto3.client(
                'marketplace-catalog',
                region_name=self.region
            )
        return self._client
    
    def list_entities(self, entity_type: str, max_results: int = 10, 
                      filters: List[Dict] = None, sort: Dict = None) -> Dict:
        """
        List entities of a given type in AWS Marketplace.
        
        Args:
            entity_type: Type of entity (e.g., 'Offer', 'AmiProduct', 'SaaSProduct',
                        'ContainerProduct', 'DataProduct', 'Experience')
            max_results: Maximum number of results to return (1-50)
            filters: Optional list of filter objects for narrowing results
            sort: Optional sort configuration
            
        Returns:
            Dict with 'EntitySummaryList' containing matched entities
        """
        try:
            params = {
                'Catalog': 'AWSMarketplace',
                'EntityType': entity_type,
                'MaxResults': min(max_results, 50)
            }
            
            if filters:
                params['EntityTypeFilters'] = filters
            if sort:
                params['EntityTypeSort'] = sort
            
            response = self.client.list_entities(**params)
            
            entity_count = len(response.get('EntitySummaryList', []))
            logger.info(f"Listed {entity_count} {entity_type} entities from Marketplace Catalog")
            
            return {
                'success': True,
                'entity_type': entity_type,
                'entities': response.get('EntitySummaryList', []),
                'next_token': response.get('NextToken')
            }
            
        except Exception as e:
            logger.error(f"Error listing {entity_type} entities: {e}")
            return {
                'success': False,
                'error': str(e),
                'entity_type': entity_type,
                'entities': []
            }
    
    def describe_entity(self, entity_id: str) -> Dict:
        """
        Describe a specific entity in AWS Marketplace.
        
        Args:
            entity_id: The unique identifier of the entity (e.g., offer ID, product ID)
            
        Returns:
            Dict with full entity details including type, ARN, and details document
        """
        try:
            response = self.client.describe_entity(
                Catalog='AWSMarketplace',
                EntityId=entity_id
            )
            
            logger.info(f"Described entity {entity_id} (type: {response.get('EntityType')})")
            
            # Parse the details JSON if present
            details = response.get('DetailsDocument') or response.get('Details')
            if isinstance(details, str):
                try:
                    details = json.loads(details)
                except json.JSONDecodeError:
                    pass
            
            return {
                'success': True,
                'entity_id': entity_id,
                'entity_type': response.get('EntityType'),
                'entity_arn': response.get('EntityArn'),
                'last_modified_date': response.get('LastModifiedDate'),
                'details': details
            }
            
        except Exception as e:
            logger.error(f"Error describing entity {entity_id}: {e}")
            return {
                'success': False,
                'error': str(e),
                'entity_id': entity_id
            }
    
    def list_offers(self, max_results: int = 10, **filters) -> Dict:
        """
        List offers (including private offers) with optional filters.
        
        Supports all OfferFilters from the AWS Marketplace Catalog API:
        https://docs.aws.amazon.com/marketplace/latest/APIReference/API_OfferFilters.html
        
        Args:
            max_results: Maximum number of results (1-50)
            **filters: Optional keyword filters. Supported filter names:
                - targeting: str or list — e.g., "BuyerAccounts" or "None" (public)
                - state: str or list — e.g., "Released", "Draft"
                - product_id: str or list — filter by product ID
                - buyer_accounts: str or list — filter by buyer account ID(s)
                - name: str or list — filter by offer name (wildcard supported)
                - entity_id: str or list — filter by entity ID
                - release_date: dict — {"AfterValue": "2024-01-01", "BeforeValue": "2024-12-31"}
                - last_modified_date: dict — {"AfterValue": "...", "BeforeValue": "..."}
                - availability_end_date: dict — {"AfterValue": "...", "BeforeValue": "..."}
                - resale_authorization_id: str or list — filter by resale auth ID
                
        Returns:
            Dict with 'entities' list and metadata
            
        Examples:
            # List private offers only
            client.list_offers(targeting="BuyerAccounts")
            
            # List offers for a specific product
            client.list_offers(product_id="prod-abcdef123456")
            
            # List released offers targeting specific buyer
            client.list_offers(state="Released", buyer_accounts="123456789012")
            
            # List offers by name (wildcard)
            client.list_offers(name="Enterprise*")
        """
        offer_filters = self._build_offer_filters(**filters) if filters else None
        return self.list_entities('Offer', max_results=max_results, filters=offer_filters)
    
    def _build_offer_filters(self, **kwargs) -> Dict:
        """
        Build the OfferFilters structure for the ListEntities API.
        
        Converts user-friendly keyword arguments into the nested API format:
        {"OfferFilters": {"Targeting": {"ValueList": ["BuyerAccounts"]}, ...}}
        """
        offer_filters = {}
        
        # Simple ValueList filters (string or list → {"ValueList": [...]})
        value_list_mappings = {
            'targeting': 'Targeting',
            'state': 'State',
            'product_id': 'ProductId',
            'buyer_accounts': 'BuyerAccounts',
            'entity_id': 'EntityId',
            'resale_authorization_id': 'ResaleAuthorizationId',
        }
        
        for kwarg_name, api_name in value_list_mappings.items():
            value = kwargs.get(kwarg_name)
            if value is not None:
                if isinstance(value, str):
                    value = [value]
                offer_filters[api_name] = {"ValueList": value}
        
        # Wildcard filter (Name supports wildcards)
        name_value = kwargs.get('name')
        if name_value is not None:
            if isinstance(name_value, str):
                name_value = [name_value]
            # Name uses WildCardValue for pattern matching
            if any('*' in v or '?' in v for v in name_value):
                offer_filters['Name'] = {"WildCardValue": name_value[0]}
            else:
                offer_filters['Name'] = {"ValueList": name_value}
        
        # Date range filters (dict with AfterValue/BeforeValue)
        date_mappings = {
            'release_date': 'ReleaseDate',
            'last_modified_date': 'LastModifiedDate',
            'availability_end_date': 'AvailabilityEndDate',
        }
        
        for kwarg_name, api_name in date_mappings.items():
            value = kwargs.get(kwarg_name)
            if value is not None and isinstance(value, dict):
                date_filter = {}
                if 'AfterValue' in value:
                    date_filter['AfterValue'] = value['AfterValue']
                if 'BeforeValue' in value:
                    date_filter['BeforeValue'] = value['BeforeValue']
                if date_filter:
                    offer_filters[api_name] = {"DateRange": date_filter}
        
        return {"OfferFilters": offer_filters} if offer_filters else None
    
    def list_products(self, product_type: str = 'SaaSProduct', max_results: int = 10) -> Dict:
        """
        List products of a given type.
        
        Args:
            product_type: One of 'AmiProduct', 'SaaSProduct', 'ContainerProduct', 'DataProduct'
            max_results: Maximum results to return
        """
        return self.list_entities(product_type, max_results=max_results)
    
    def describe_offer(self, offer_id: str) -> Dict:
        """Describe a specific offer (public or private) by its ID."""
        return self.describe_entity(offer_id)
    
    def describe_product(self, product_id: str) -> Dict:
        """Describe a specific product by its ID."""
        return self.describe_entity(product_id)
