#!/usr/bin/env python
"""
Orchestrator Agent - Agent-to-Agent Communication

This agent:
1. Reads context from multiple sources (Slack, local files, uploads, HubSpot)
2. Uses Claude AI to generate "next steps" content
3. Calls Partner Central MCP to update opportunities
4. Creates ACE opportunities from HubSpot deals via Partner Central Selling API
"""

import os
import sys
import json
import logging
import argparse
from typing import Dict, List, Optional

# Real (non-string) type annotations used by OrchestratorAgent.
from crm.hubspot_mapper import HubSpotDeal
from crm.salesforce_mapper import SalesforceOpportunity

# Components were extracted into focused modules. Re-export them here so existing
# imports (server.py, demo_ui.py, verify_setup.py, crm adapters) keep working
# unchanged, and so they remain available as globals to OrchestratorAgent.
from context_sources import ContextSource, AgentResult, SlackReader, FileReader
from crm.hubspot_client import HubSpotClient
from crm.salesforce_client import SalesforceClient
from crm.pipedrive_client import PipedriveClient
from next_steps import NextStepsGenerator
from partner_central import PartnerCentralMCPClient, MarketplaceCatalogClient

# Configure logging for the application entry point.
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

__all__ = [
    'OrchestratorAgent', 'AgentResult', 'ContextSource', 'SlackReader',
    'FileReader', 'HubSpotClient', 'SalesforceClient', 'PipedriveClient',
    'NextStepsGenerator', 'PartnerCentralMCPClient', 'MarketplaceCatalogClient',
]


class OrchestratorAgent:
    """Main orchestrator that coordinates all components"""
    
    def __init__(self, config_path: str = None, hubspot_token: str = None,
                 salesforce_token: str = None, salesforce_instance_url: str = None,
                 pipedrive_token: str = None, pipedrive_instance_url: str = None):
        self.slack_reader = SlackReader()
        self.file_reader = FileReader()
        self.next_steps_generator = NextStepsGenerator()
        self.mcp_client = PartnerCentralMCPClient(config_path)
        self.hubspot_client = HubSpotClient(hubspot_token)
        self.salesforce_client = SalesforceClient(salesforce_token, salesforce_instance_url)
        self.pipedrive_client = PipedriveClient(pipedrive_token, pipedrive_instance_url)
        self.marketplace_client = MarketplaceCatalogClient(
            region=self.mcp_client.config.get('region', 'us-east-1')
        )
    
    def gather_context(
        self,
        slack_channels: List[str] = None,
        local_folders: List[str] = None,
        uploaded_files: List[str] = None
    ) -> List[ContextSource]:
        """Gather context from all specified sources"""
        sources = []
        
        # Read from Slack channels
        if slack_channels:
            for channel in slack_channels:
                logger.info(f"Reading Slack channel: {channel}")
                source = self.slack_reader.read_channel(channel)
                sources.append(source)
        
        # Read from local folders
        if local_folders:
            for folder in local_folders:
                logger.info(f"Reading local folder: {folder}")
                folder_sources = self.file_reader.read_folder(folder)
                sources.extend(folder_sources)
        
        # Read uploaded files
        if uploaded_files:
            for file_path in uploaded_files:
                logger.info(f"Reading uploaded file: {file_path}")
                source = self.file_reader.read_file(file_path)
                sources.append(source)
        
        logger.info(f"Gathered {len(sources)} context sources")
        return sources
    
    def run(
        self,
        opportunity_id: str,
        prompt: str,
        slack_channels: List[str] = None,
        local_folders: List[str] = None,
        uploaded_files: List[str] = None,
        update_opportunity: bool = True,
        auto_approve: bool = False,
    ) -> AgentResult:
        """
        Run the full agent workflow:
        1. Gather context from sources
        2. Fetch current opportunity data
        3. Generate next steps using AI
        4. Update opportunity via MCP
        
        When `auto_approve` is True, the MCP update skips the interactive
        y/n approval prompt and applies the change directly. Use this for
        non-interactive callers (REST API, CI jobs, scheduled scripts)
        where there's no human at a terminal to type 'y'.
        """
        try:
            logger.info(f"Starting orchestrator for opportunity: {opportunity_id}")
            
            # Step 1: Gather context (optional - opportunity data alone may be sufficient)
            context_sources = self.gather_context(
                slack_channels=slack_channels,
                local_folders=local_folders,
                uploaded_files=uploaded_files
            )
            
            if not context_sources:
                logger.info("No external context provided - using opportunity data only")
            
            # Step 2: Fetch opportunity data
            logger.info(f"Fetching opportunity data: {opportunity_id}")
            opportunity_data = self.mcp_client.get_opportunity(opportunity_id)
            
            # Step 3: Generate next steps
            logger.info("Generating next steps with AI...")
            next_steps = self.next_steps_generator.generate(
                context_sources=context_sources,
                prompt=prompt,
                opportunity_data=opportunity_data
            )
            
            logger.info(f"Generated next steps:\n{next_steps}")
            
            # Step 4: Update opportunity via MCP
            mcp_response = None
            if update_opportunity:
                logger.info(f"Updating opportunity {opportunity_id} via MCP...")
                mcp_response = self.mcp_client.update_next_steps(
                    opportunity_id,
                    next_steps,
                    interactive=not auto_approve,
                    auto_approve=auto_approve,
                )
                
                if "error" in mcp_response:
                    logger.warning(f"MCP update warning: {mcp_response['error']}")
                else:
                    logger.info("Opportunity updated successfully")
            
            return AgentResult(
                success=True,
                next_steps=next_steps,
                context_sources=context_sources,
                mcp_response=mcp_response
            )
            
        except Exception as e:
            logger.error(f"Orchestrator error: {e}")
            return AgentResult(
                success=False,
                next_steps="",
                context_sources=[],
                error=str(e)
            )
    
    def create_opportunity_from_hubspot(self, deal_id: str, project_title: str = None) -> Dict:
        """
        Create an ACE opportunity from a HubSpot deal:
        1. Fetch deal data from HubSpot API
        2. Map deal fields to Partner Central opportunity fields
        3. Create opportunity via Partner Central Selling API
        """
        try:
            logger.info(f"Fetching HubSpot deal: {deal_id}")
            
            # Step 1: Get deal from HubSpot
            deal = self.hubspot_client.get_deal(deal_id)
            
            if not deal:
                return {
                    "success": False,
                    "error": f"Could not fetch HubSpot deal: {deal_id}"
                }
            
            logger.info(f"Found deal: {deal.deal_name} ({deal.company_name})")
            logger.info(f"  Amount: ${deal.amount:,.2f}")
            logger.info(f"  Stage: {deal.stage}")
            logger.info(f"  Contact: {deal.contact_name} ({deal.contact_email})")
            
            # Step 2: Create opportunity in Partner Central
            result = self.mcp_client.create_opportunity(deal, project_title)
            
            if result.get("success"):
                logger.info(f"✅ ACE Opportunity created: {result.get('opportunity_id')}")
            else:
                logger.error(f"❌ Failed to create opportunity: {result.get('error')}")
            
            return {
                "success": result.get("success", False),
                "hubspot_deal": {
                    "id": deal.deal_id,
                    "name": deal.deal_name,
                    "company": deal.company_name,
                    "amount": deal.amount
                },
                "ace_opportunity_id": result.get("opportunity_id"),
                "error": result.get("error")
            }
            
        except Exception as e:
            logger.error(f"Error creating opportunity from HubSpot: {e}")
            return {
                "success": False,
                "error": str(e)
            }
    
    def list_hubspot_deals(self, limit: int = 10) -> List[HubSpotDeal]:
        """List recent HubSpot deals"""
        return self.hubspot_client.list_deals(limit)

    def process_call_from_notes(self, notes: str, submit_to_aws: bool = False,
                                project_title: str = None) -> Dict:
        """End-to-end "Process Call" demo flow — agent-first.

        Showcases the Partner Central Agent: the agent CREATES the opportunity
        from the call notes and (optionally) SUBMITS it to AWS for co-sell. The
        only step the agent can't do — creating the CRM deal — is supplemented
        with the HubSpot API.

        Chain:
          1. extract fields (Strands/Bedrock)        -> for the CRM deal
          2. create HubSpot deal + contact           -> HubSpot API (agent gap)
          3. create the opportunity from the notes    -> Partner Central Agent (MCP)
          4. (optional) submit to AWS for co-sell     -> Partner Central Agent (MCP)
          5. confirm review status                    -> Selling API read (verify)

        Returns a dict describing each step so the UI can render progress.
        """
        steps = {"extract": None, "hubspot": None, "ace": None, "submit": None}
        try:
            # Step 1: extract structured fields (needed to build the CRM deal;
            # the agent will read the raw notes itself for the ACE side).
            logger.info("Process-call: extracting fields from notes...")
            fields = self.next_steps_generator.extract_call_fields(notes)
            if not fields:
                return {"success": False, "steps": steps,
                        "error": "Could not extract opportunity fields from the notes."}
            steps["extract"] = "ok"

            # Step 2: create the HubSpot deal + contact (API — the agent has no
            # CRM capability, so this is the supplement).
            logger.info("Process-call: creating HubSpot deal...")
            from datetime import datetime
            stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
            base_title = fields.get("project_title") or f"{fields.get('company_name', 'New')} Opportunity"
            deal_props = {
                "dealname": f"{base_title} - {stamp}",
                "amount": str(fields.get("amount") or "").replace(",", "").replace("$", "") or None,
                "description": self._compose_deal_description(fields),
            }
            close_date = (fields.get("close_date") or "").strip()
            if close_date:
                deal_props["closedate"] = f"{close_date}T00:00:00.000Z"
            contact_props = {
                "firstname": fields.get("contact_first_name"),
                "lastname": fields.get("contact_last_name"),
                "email": fields.get("contact_email"),
                "phone": fields.get("contact_phone"),
                "jobtitle": fields.get("contact_title"),
            }
            hs = self.hubspot_client.create_deal_with_contact(deal_props, contact_props)
            if not hs.get("success"):
                steps["hubspot"] = "error"
                return {"success": False, "steps": steps, "fields": fields,
                        "error": f"HubSpot deal creation failed: {hs.get('error')}"}
            steps["hubspot"] = "ok"
            deal_id = hs["deal_id"]

            # Step 3: let the Partner Central AGENT create the opportunity from
            # the notes — CREATE ONLY. Splitting create and submit into two
            # turns (and referencing the exact ID when submitting) prevents the
            # agent from occasionally firing a second CreateOpportunity.
            #
            # AWS rejects submitting a DUPLICATE opportunity for the same
            # customer. So each demo run gets a unique customer company name
            # (a short run token) — otherwise re-running with the same notes
            # creates an opportunity that can't be submitted ("Duplicate Record").
            logger.info("Process-call: asking the Partner Central Agent to create the opportunity...")
            company = fields.get("company_name") or "the customer"
            run_token = datetime.now().strftime("Demo-%m%d-%H%M%S")
            unique_company = f"{company} ({run_token})"
            create_instruction = (
                "Create a new AWS Partner Central opportunity from the meeting notes below. "
                "Extract the customer account, primary contact, project/business problem, "
                "use case, expected customer spend, and target close date from the notes. "
                f"IMPORTANT: set the customer company name to exactly '{unique_company}' "
                "(this unique demo suffix avoids AWS duplicate-opportunity detection so the "
                "opportunity can be submitted). "
                "Create exactly ONE opportunity. Do NOT submit it to AWS — stop as soon as "
                "the opportunity is created and tell me its opportunity ID."
                f"\n\n## Meeting Notes:\n{notes}"
            )
            create_res = self.mcp_client.run_agent_autopilot(create_instruction)
            ace_ids = create_res.get("opportunity_ids") or []
            ace_id = create_res.get("opportunity_id")
            session_id = create_res.get("session_id")
            if not ace_id:
                steps["ace"] = "error"
                return {"success": False, "steps": steps, "fields": fields,
                        "deal_id": deal_id, "deal_url": hs.get("deal_url"),
                        "agent_answer": create_res.get("answer"),
                        "error": "The Partner Central Agent did not return a created opportunity ID. "
                                 "It may have asked a clarifying question — see agent_answer."}
            if len(ace_ids) > 1:
                logger.warning(f"Agent referenced multiple opportunity IDs {ace_ids}; "
                               f"using the newest ({ace_id}) as the one it just created.")
            steps["ace"] = "ok"

            # Step 4 (optional): submit THAT opportunity for co-sell. Reference
            # the exact ID in the same session so the agent submits the existing
            # opportunity instead of creating a new one.
            submitted = False
            submit_error = None
            if submit_to_aws:
                logger.info(f"Process-call: asking the agent to submit {ace_id} for co-sell...")
                submit_instruction = (
                    f"Submit opportunity {ace_id} to AWS for review as a co-sell engagement "
                    f"with full visibility. Do not create a new opportunity — submit the "
                    f"existing opportunity {ace_id}."
                )
                self.mcp_client.run_agent_autopilot(submit_instruction, session_id=session_id)
                # Verify the real review status (poll briefly — submission is async).
                submitted = self._poll_review_submitted(ace_id, attempts=4, delay=2)
                if not submitted:
                    # Agent submit didn't take — supplement with a direct Selling
                    # API submit and surface its real task status / error.
                    logger.info(f"Process-call: agent submit not reflected; supplementing with "
                                f"Selling API submit for {ace_id}")
                    api_submit = self.mcp_client.submit_opportunity(ace_id)
                    if api_submit.get("success"):
                        submitted = self._poll_review_submitted(ace_id, attempts=4, delay=2)
                    else:
                        submit_error = api_submit.get("error")
                steps["submit"] = "ok" if submitted else "error"

            return {
                "success": True,
                "steps": steps,
                "fields": fields,
                "deal_id": deal_id,
                "deal_url": hs.get("deal_url"),
                "ace_opportunity_id": ace_id,
                "submitted": submitted,
                "submit_error": submit_error,
                "agent_answer": create_res.get("answer"),
                "error": None,
            }
        except Exception as e:
            logger.error(f"Process-call error: {e}")
            return {"success": False, "steps": steps, "error": str(e)}

    def _poll_review_submitted(self, opportunity_id: str, attempts: int = 4, delay: int = 2) -> bool:
        """Poll the opportunity's ReviewStatus; return True once it leaves
        'Pending Submission' (submission is asynchronous)."""
        import time
        for _ in range(attempts):
            opp = self.mcp_client.get_opportunity(opportunity_id)
            status = (opp.get("LifeCycle", {}) or {}).get("ReviewStatus", "")
            if status and status.strip().lower() != "pending submission":
                return True
            time.sleep(delay)
        return False

    @staticmethod
    def _compose_deal_description(fields: Dict) -> str:
        """Build a readable HubSpot deal description from extracted fields."""
        parts = []
        if fields.get("business_problem"):
            parts.append(f"Business problem: {fields['business_problem']}")
        if fields.get("use_case"):
            parts.append(f"Use case: {fields['use_case']}")
        if fields.get("solution_description"):
            parts.append(f"Solution: {fields['solution_description']}")
        if fields.get("competitor"):
            parts.append(f"Competitor: {fields['competitor']}")
        if fields.get("primary_need"):
            parts.append(f"Primary need from AWS: {fields['primary_need']}")
        return " | ".join(parts)[:1000] if parts else "Created from call notes."

    def create_opportunity_from_salesforce(self, opportunity_id: str, project_title: str = None) -> Dict:
        """
        Create an ACE opportunity from a Salesforce opportunity:
        1. Fetch opportunity data from Salesforce API
        2. Map opportunity fields to Partner Central opportunity fields
        3. Create opportunity via Partner Central Selling API
        """
        try:
            logger.info(f"Fetching Salesforce opportunity: {opportunity_id}")
            
            # Step 1: Get opportunity from Salesforce
            opp = self.salesforce_client.get_opportunity(opportunity_id)
            
            if not opp:
                return {
                    "success": False,
                    "error": f"Could not fetch Salesforce opportunity: {opportunity_id}"
                }
            
            logger.info(f"Found opportunity: {opp.name} ({opp.account_name})")
            logger.info(f"  Amount: ${opp.amount:,.2f}")
            logger.info(f"  Stage: {opp.stage}")
            logger.info(f"  Contact: {opp.contact_name} ({opp.contact_email})")
            
            # Step 2: Create opportunity in Partner Central
            result = self.mcp_client.create_opportunity_from_salesforce(opp, project_title)
            
            if result.get("success"):
                logger.info(f"✅ ACE Opportunity created: {result.get('opportunity_id')}")
            else:
                logger.error(f"❌ Failed to create opportunity: {result.get('error')}")
            
            return {
                "success": result.get("success", False),
                "salesforce_opportunity": {
                    "id": opp.opportunity_id,
                    "name": opp.name,
                    "account": opp.account_name,
                    "amount": opp.amount
                },
                "ace_opportunity_id": result.get("opportunity_id"),
                "error": result.get("error")
            }
            
        except Exception as e:
            logger.error(f"Error creating opportunity from Salesforce: {e}")
            return {
                "success": False,
                "error": str(e)
            }
    
    def list_salesforce_opportunities(self, limit: int = 10) -> List[SalesforceOpportunity]:
        """List recent Salesforce opportunities"""
        return self.salesforce_client.list_opportunities(limit)
    
    def create_opportunity_from_pipedrive(self, deal_id: str, project_title: str = None) -> Dict:
        """
        Create an ACE opportunity from a Pipedrive deal.

        Args:
            deal_id: Pipedrive deal numeric ID.
            project_title: Optional custom title for the ACE opportunity.

        Returns:
            Dict with success status, ACE opportunity ID, and any errors.
        """
        try:
            logger.info(f"Fetching Pipedrive deal: {deal_id}")

            deal = self.pipedrive_client.get_deal(deal_id)
            if not deal:
                return {
                    "success": False,
                    "error": f"Could not fetch Pipedrive deal: {deal_id}",
                }

            logger.info(f"Found deal: {deal.title} ({deal.org_name})")
            logger.info(f"  Value: ${deal.value:,.2f}")
            logger.info(f"  Stage: {deal.stage}")
            logger.info(f"  Contact: {deal.contact_name} ({deal.contact_email})")

            result = self.mcp_client.create_opportunity_from_pipedrive(deal, project_title)

            if result.get("success"):
                logger.info(f"✅ ACE Opportunity created: {result.get('opportunity_id')}")
            else:
                logger.error(f"❌ Failed to create opportunity: {result.get('error')}")

            return {
                "success": result.get("success", False),
                "pipedrive_deal": {
                    "id": deal.deal_id,
                    "name": deal.title,
                    "organization": deal.org_name,
                    "amount": deal.value,
                },
                "ace_opportunity_id": result.get("opportunity_id"),
                "error": result.get("error"),
            }

        except Exception as e:
            logger.error(f"Error creating opportunity from Pipedrive: {e}")
            return {
                "success": False,
                "error": str(e),
            }

    def list_pipedrive_deals(self, limit: int = 10):
        """List recent Pipedrive deals."""
        return self.pipedrive_client.list_deals(limit)

    def sync_to_hubspot(self, opportunity_id: str, hubspot_deal_id: str) -> Dict:
        """
        Sync Partner Central opportunity status back to HubSpot deal.
        
        This enables bi-directional sync:
        - When PC opportunity status changes (e.g., Approved, Rejected)
        - Update the corresponding HubSpot deal stage
        
        Args:
            opportunity_id: Partner Central opportunity ID
            hubspot_deal_id: HubSpot deal ID to update
            
        Returns:
            Dict with sync result including success status and updated properties
        """
        try:
            from crm.hubspot_mapper import HubSpotSyncClient
            
            logger.info(f"Syncing PC opportunity {opportunity_id} to HubSpot deal {hubspot_deal_id}")
            
            # Initialize sync client with HubSpot token
            if not self.hubspot_client.bearer_token:
                return {
                    "success": False,
                    "error": "HubSpot bearer token not configured"
                }
            
            sync_client = HubSpotSyncClient(self.hubspot_client.bearer_token)
            
            # Perform sync using PC client to fetch opportunity
            result = sync_client.check_and_sync(
                deal_id=hubspot_deal_id,
                opportunity_id=opportunity_id,
                pc_client=self.mcp_client
            )
            
            if result.get("success"):
                logger.info(f"✅ Successfully synced to HubSpot deal {hubspot_deal_id}")
                sync_status = result.get("sync_status", {})
                logger.info(f"  PC Status: {sync_status.get('review_status')} / {sync_status.get('stage')}")
                logger.info(f"  HubSpot Stage: {sync_status.get('recommended_hubspot_stage')}")
            else:
                logger.error(f"❌ Sync failed: {result.get('error')}")
            
            return result
            
        except Exception as e:
            logger.error(f"Error syncing to HubSpot: {e}")
            return {
                "success": False,
                "error": str(e)
            }
    
    def check_and_sync_opportunity(self, opportunity_id: str, hubspot_deal_id: str = None) -> Dict:
        """
        Check opportunity status and optionally sync to HubSpot.
        
        Useful for checking if an opportunity is approved/rejected and
        automatically updating the HubSpot deal stage.
        
        Args:
            opportunity_id: Partner Central opportunity ID
            hubspot_deal_id: Optional HubSpot deal ID (if not provided, only checks status)
            
        Returns:
            Dict with opportunity status and optional sync result
        """
        try:
            # Get opportunity status
            opportunity = self.mcp_client.get_opportunity(opportunity_id)
            
            if not opportunity:
                return {
                    "success": False,
                    "error": f"Could not fetch opportunity {opportunity_id}"
                }
            
            lifecycle = opportunity.get('LifeCycle', {})
            result = {
                "success": True,
                "opportunity_id": opportunity_id,
                "review_status": lifecycle.get('ReviewStatus'),
                "stage": lifecycle.get('Stage'),
                "next_steps": lifecycle.get('NextSteps', '')[:100] + '...' if lifecycle.get('NextSteps') else None
            }
            
            # If HubSpot deal ID provided, sync the status
            if hubspot_deal_id:
                sync_result = self.sync_to_hubspot(opportunity_id, hubspot_deal_id)
                result["hubspot_sync"] = sync_result
            
            return result
            
        except Exception as e:
            logger.error(f"Error checking opportunity: {e}")
            return {
                "success": False,
                "error": str(e)
            }

    # --- CRM Sync (ACE → CRM) methods ---
    
    def sync_to_salesforce(self, opportunity_id: str, sf_opportunity_id: str) -> Dict:
        """
        Sync Partner Central opportunity status back to Salesforce opportunity.
        
        Args:
            opportunity_id: Partner Central opportunity ID
            sf_opportunity_id: Salesforce opportunity ID to update
            
        Returns:
            Dict with sync result including success status and updated fields
        """
        try:
            from crm.salesforce_mapper import SalesforceSyncClient
            
            logger.info(f"Syncing PC opportunity {opportunity_id} to Salesforce opportunity {sf_opportunity_id}")
            
            if not self.salesforce_client.bearer_token:
                return {
                    "success": False,
                    "error": "Salesforce access token not configured"
                }
            
            sync_client = SalesforceSyncClient(
                bearer_token=self.salesforce_client.bearer_token,
                instance_url=self.salesforce_client.instance_url
            )
            
            result = sync_client.check_and_sync(
                sf_opportunity_id=sf_opportunity_id,
                pc_opportunity_id=opportunity_id,
                pc_client=self.mcp_client
            )
            
            if result.get("success"):
                logger.info(f"✅ Successfully synced to Salesforce opportunity {sf_opportunity_id}")
            else:
                logger.error(f"❌ Sync failed: {result.get('error')}")
            
            return result
            
        except Exception as e:
            logger.error(f"Error syncing to Salesforce: {e}")
            return {"success": False, "error": str(e)}
    
    def sync_to_pipedrive(self, opportunity_id: str, pipedrive_deal_id: str) -> Dict:
        """
        Sync Partner Central opportunity status back to Pipedrive deal.
        
        Args:
            opportunity_id: Partner Central opportunity ID
            pipedrive_deal_id: Pipedrive deal ID to update
            
        Returns:
            Dict with sync result including success status and updated fields
        """
        try:
            from crm.pipedrive_mapper import PipedriveSyncClient
            
            logger.info(f"Syncing PC opportunity {opportunity_id} to Pipedrive deal {pipedrive_deal_id}")
            
            if not self.pipedrive_client.bearer_token:
                return {
                    "success": False,
                    "error": "Pipedrive API token not configured"
                }
            
            sync_client = PipedriveSyncClient(
                api_token=self.pipedrive_client.bearer_token,
                instance_url=self.pipedrive_client.instance_url
            )
            
            result = sync_client.check_and_sync(
                deal_id=pipedrive_deal_id,
                pc_opportunity_id=opportunity_id,
                pc_client=self.mcp_client
            )
            
            if result.get("success"):
                logger.info(f"✅ Successfully synced to Pipedrive deal {pipedrive_deal_id}")
            else:
                logger.error(f"❌ Sync failed: {result.get('error')}")
            
            return result
            
        except Exception as e:
            logger.error(f"Error syncing to Pipedrive: {e}")
            return {"success": False, "error": str(e)}
    
    # --- AWS Marketplace Catalog methods ---
    
    def list_marketplace_offers(self, max_results: int = 10, **filters) -> Dict:
        """List offers (including private offers) from AWS Marketplace Catalog with optional filters."""
        return self.marketplace_client.list_offers(max_results=max_results, **filters)
    
    def list_marketplace_products(self, product_type: str = 'SaaSProduct', max_results: int = 10) -> Dict:
        """List products of a given type from AWS Marketplace Catalog."""
        return self.marketplace_client.list_products(product_type=product_type, max_results=max_results)
    
    def describe_marketplace_entity(self, entity_id: str) -> Dict:
        """Describe a specific entity (offer, product, etc.) from AWS Marketplace Catalog."""
        return self.marketplace_client.describe_entity(entity_id)

    def find_ao_opportunities(self, since_days: int = 180, limit: int = 100) -> List[Dict]:
        """Find AWS-originated opportunities (Origin = 'AWS Referral').

        Demonstrates the value of a custom orchestrator: the Partner Central
        Agent cannot reliably filter the pipeline by Origin = 'AWS Referral',
        but the orchestrator can chain ListOpportunities + GetAwsOpportunitySummary
        + GetOpportunity to do it. See PartnerCentralMCPClient.find_ao_opportunities
        for the full implementation.
        """
        return self.mcp_client.find_ao_opportunities(since_days=since_days, limit=limit)

    def find_engagement_invitations_by_country(self, country_code=None,
                                               since_days: int = 30,
                                               limit: int = 50) -> List[Dict]:
        """Find engagement invitations from AWS, optionally filtered by customer country.

        Demonstrates another custom-orchestrator value-prop: the Partner Central
        Agent has no tool for engagement invitations. The orchestrator chains
        ListEngagementInvitations (with date filter) + GetEngagementInvitation
        (per item) to read the customer country and surfaces invitations from
        AWS scoped to a region/country.
        """
        return self.mcp_client.find_engagement_invitations_by_country(
            country_code=country_code, since_days=since_days, limit=limit
        )



def main():
    """CLI entry point"""
    parser = argparse.ArgumentParser(description='Agent-to-Agent Orchestrator: Next Steps Generator & HubSpot Integration')
    subparsers = parser.add_subparsers(dest='command', help='Available commands')
    
    # Update command (existing functionality)
    update_parser = subparsers.add_parser('update', help='Update opportunity next steps')
    update_parser.add_argument('--opportunity-id', '-o', required=True, help='Partner Central Opportunity ID')
    update_parser.add_argument('--prompt', '-p', default='Generate next steps based on the context', help='Prompt for AI')
    update_parser.add_argument('--slack-channel', '-s', action='append', help='Slack channel(s) to read')
    update_parser.add_argument('--local-folder', '-f', action='append', help='Local folder(s) to scan')
    update_parser.add_argument('--upload', '-u', action='append', help='File(s) to upload as context')
    update_parser.add_argument('--dry-run', action='store_true', help='Generate but do not update opportunity')
    update_parser.add_argument(
        '--auto-approve', '-y', action='store_true',
        help='Auto-approve the MCP write so no terminal prompt is needed (use for headless scripts/CI)'
    )
    update_parser.add_argument('--config', '-c', help='Path to config.json')
    
    # HubSpot create command
    hubspot_parser = subparsers.add_parser('hubspot-create', help='Create ACE opportunity from HubSpot deal')
    hubspot_parser.add_argument('--deal-id', '-d', required=True, help='HubSpot Deal ID')
    hubspot_parser.add_argument('--title', '-t', help='Custom project title (defaults to deal name)')
    hubspot_parser.add_argument('--hubspot-token', help='HubSpot bearer token (or set HUBSPOT_BEARER_TOKEN env)')
    hubspot_parser.add_argument('--config', '-c', help='Path to config.json')
    
    # HubSpot list command
    list_parser = subparsers.add_parser('hubspot-list', help='List recent HubSpot deals')
    list_parser.add_argument('--limit', '-l', type=int, default=10, help='Number of deals to list')
    list_parser.add_argument('--hubspot-token', help='HubSpot bearer token (or set HUBSPOT_BEARER_TOKEN env)')
    
    # HubSpot sync command (bi-directional sync: PC → HubSpot)
    sync_parser = subparsers.add_parser('hubspot-sync', help='Sync Partner Central opportunity status to HubSpot deal')
    sync_parser.add_argument('--opportunity-id', '-o', required=True, help='Partner Central Opportunity ID')
    sync_parser.add_argument('--deal-id', '-d', required=True, help='HubSpot Deal ID to update')
    sync_parser.add_argument('--hubspot-token', help='HubSpot bearer token (or set HUBSPOT_BEARER_TOKEN env)')
    sync_parser.add_argument('--config', '-c', help='Path to config.json')
    
    # Salesforce create command
    sf_create_parser = subparsers.add_parser('salesforce-create', help='Create ACE opportunity from Salesforce opportunity')
    sf_create_parser.add_argument('--opportunity-id', '-o', required=True, help='Salesforce Opportunity ID')
    sf_create_parser.add_argument('--title', '-t', help='Custom project title (defaults to opportunity name)')
    sf_create_parser.add_argument('--salesforce-token', help='Salesforce access token (or set SALESFORCE_ACCESS_TOKEN env)')
    sf_create_parser.add_argument('--instance-url', help='Salesforce instance URL (or set SALESFORCE_INSTANCE_URL env)')
    sf_create_parser.add_argument('--config', '-c', help='Path to config.json')
    
    # Salesforce list command
    sf_list_parser = subparsers.add_parser('salesforce-list', help='List recent Salesforce opportunities')
    sf_list_parser.add_argument('--limit', '-l', type=int, default=10, help='Number of opportunities to list')
    sf_list_parser.add_argument('--salesforce-token', help='Salesforce access token (or set SALESFORCE_ACCESS_TOKEN env)')
    sf_list_parser.add_argument('--instance-url', help='Salesforce instance URL (or set SALESFORCE_INSTANCE_URL env)')
    
    # Salesforce sync command (ACE → Salesforce)
    sf_sync_parser = subparsers.add_parser('salesforce-sync', help='Sync Partner Central opportunity status to Salesforce opportunity')
    sf_sync_parser.add_argument('--opportunity-id', '-o', required=True, help='Partner Central Opportunity ID')
    sf_sync_parser.add_argument('--sf-opportunity-id', '-s', required=True, help='Salesforce Opportunity ID to update')
    sf_sync_parser.add_argument('--salesforce-token', help='Salesforce access token (or set SALESFORCE_ACCESS_TOKEN env)')
    sf_sync_parser.add_argument('--instance-url', help='Salesforce instance URL (or set SALESFORCE_INSTANCE_URL env)')
    sf_sync_parser.add_argument('--config', '-c', help='Path to config.json')
    
    # Pipedrive sync command (ACE → Pipedrive)
    pd_sync_parser = subparsers.add_parser('pipedrive-sync', help='Sync Partner Central opportunity status to Pipedrive deal')
    pd_sync_parser.add_argument('--opportunity-id', '-o', required=True, help='Partner Central Opportunity ID')
    pd_sync_parser.add_argument('--deal-id', '-d', required=True, help='Pipedrive Deal ID to update')
    pd_sync_parser.add_argument('--pipedrive-token', help='Pipedrive API token (or set PIPEDRIVE_API_TOKEN env)')
    pd_sync_parser.add_argument('--instance-url', help='Pipedrive instance URL (or set PIPEDRIVE_INSTANCE_URL env)')
    pd_sync_parser.add_argument('--config', '-c', help='Path to config.json')
    
    # AWS Marketplace Catalog commands
    mp_list_parser = subparsers.add_parser('marketplace-list', help='List entities from AWS Marketplace Catalog')
    mp_list_parser.add_argument('--entity-type', '-e', default='Offer',
                                choices=['Offer', 'AmiProduct', 'SaaSProduct', 'ContainerProduct', 'DataProduct'],
                                help='Entity type to list (default: Offer)')
    mp_list_parser.add_argument('--limit', '-l', type=int, default=10, help='Number of results to return')
    mp_list_parser.add_argument('--targeting', help='Filter offers by targeting type (e.g., BuyerAccounts, None)')
    mp_list_parser.add_argument('--state', help='Filter offers by state (e.g., Released, Draft)')
    mp_list_parser.add_argument('--product-id', help='Filter offers by product ID')
    mp_list_parser.add_argument('--buyer-accounts', help='Filter offers by buyer account ID (comma-separated for multiple)')
    mp_list_parser.add_argument('--name', help='Filter offers by name (supports wildcards with *)')
    mp_list_parser.add_argument('--config', '-c', help='Path to config.json')
    
    mp_describe_parser = subparsers.add_parser('marketplace-describe', help='Describe a specific AWS Marketplace entity')
    mp_describe_parser.add_argument('--entity-id', '-e', required=True, help='Entity ID to describe (offer ID, product ID, etc.)')
    mp_describe_parser.add_argument('--config', '-c', help='Path to config.json')

    # Ask command — send a question to the Partner Central Agent
    ask_parser = subparsers.add_parser('ask', help='Ask the Partner Central Agent a question')
    ask_parser.add_argument('question', nargs='?', help='Question to ask (or use --prompt)')
    ask_parser.add_argument('--prompt', '-p', help='Question to ask the Partner Central Agent')
    ask_parser.add_argument('--opportunity-id', '-o', help='Opportunity ID for context (optional)')
    ask_parser.add_argument('--config', '-c', help='Path to config.json')

    # Legacy support: if the first CLI argument starts with '-' (a flag like
    # --opportunity-id), it's not a subcommand — go straight to legacy mode.
    # This lets users run:
    #   python orchestrator_agent.py --opportunity-id O123 --upload file.txt
    # without the explicit 'update' subcommand.
        
    if len(sys.argv) > 1 and sys.argv[1].startswith('-'):
        # Legacy mode: treat as 'update' command
        legacy_parser = argparse.ArgumentParser(description='Agent-to-Agent Next Steps Generator')
        legacy_parser.add_argument('--opportunity-id', '-o', required=True, help='Partner Central Opportunity ID')
        legacy_parser.add_argument('--prompt', '-p', default='Generate next steps based on the context', help='Prompt for AI')
        legacy_parser.add_argument('--slack-channel', '-s', action='append', help='Slack channel(s) to read')
        legacy_parser.add_argument('--local-folder', '-f', action='append', help='Local folder(s) to scan')
        legacy_parser.add_argument('--upload', '-u', action='append', help='File(s) to upload as context')
        legacy_parser.add_argument('--dry-run', action='store_true', help='Generate but do not update opportunity')
        legacy_parser.add_argument(
            '--auto-approve', '-y', action='store_true',
            help='Auto-approve the MCP write so no terminal prompt is needed (use for headless scripts/CI)'
        )
        legacy_parser.add_argument('--config', '-c', help='Path to config.json')
        args = legacy_parser.parse_args()
        args.command = 'update'
    else:
        args = parser.parse_args()
        if args.command is None:
            parser.print_help()
            sys.exit(1)
    
    if args.command == 'update':
        agent = OrchestratorAgent(config_path=args.config)
        
        result = agent.run(
            opportunity_id=args.opportunity_id,
            prompt=args.prompt,
            slack_channels=args.slack_channel,
            local_folders=args.local_folder,
            uploaded_files=args.upload,
            update_opportunity=not args.dry_run,
            auto_approve=getattr(args, 'auto_approve', False),
        )
        
        print("\n" + "="*60)
        print("ORCHESTRATOR AGENT RESULT")
        print("="*60)
        print(f"Success: {result.success}")
        print(f"Context Sources: {len(result.context_sources)}")
        print(f"\nGenerated Next Steps:\n{result.next_steps}")
        
        if result.mcp_response:
            try:
                content = result.mcp_response.get('result', {}).get('content', [])
                if content and content[0].get('type') == 'text':
                    inner = json.loads(content[0].get('text', '{}'))
                    status = inner.get('status', 'unknown')
                    print(f"\nMCP Status: {status}")
                    if status == 'requires_approval':
                        print("⏳ Partner Central Agent is waiting for human approval to update the opportunity.")
                    elif status == 'complete':
                        print("✅ Opportunity update completed.")
            except Exception:
                pass
            
            if 'error' in result.mcp_response:
                print(f"\nMCP Error: {result.mcp_response['error']}")
        
        if result.error:
            print(f"\nError: {result.error}")
        
        return 0 if result.success else 1
    
    elif args.command == 'hubspot-create':
        hubspot_token = args.hubspot_token or os.environ.get('HUBSPOT_BEARER_TOKEN')
        if not hubspot_token:
            print("❌ Error: HubSpot bearer token required. Use --hubspot-token or set HUBSPOT_BEARER_TOKEN env var.")
            return 1
        
        agent = OrchestratorAgent(config_path=args.config, hubspot_token=hubspot_token)
        
        print("\n" + "="*60)
        print("HUBSPOT → ACE OPPORTUNITY CREATION")
        print("="*60)
        
        result = agent.create_opportunity_from_hubspot(
            deal_id=args.deal_id,
            project_title=args.title
        )
        
        if result.get("success"):
            print("\n✅ SUCCESS!")
            print(f"HubSpot Deal: {result['hubspot_deal']['name']} ({result['hubspot_deal']['company']})")
            print(f"Deal Amount: ${result['hubspot_deal']['amount']:,.2f}")
            print(f"ACE Opportunity ID: {result['ace_opportunity_id']}")
        else:
            print(f"\n❌ FAILED: {result.get('error')}")
        
        return 0 if result.get("success") else 1
    
    elif args.command == 'hubspot-list':
        hubspot_token = args.hubspot_token or os.environ.get('HUBSPOT_BEARER_TOKEN')
        if not hubspot_token:
            print("❌ Error: HubSpot bearer token required. Use --hubspot-token or set HUBSPOT_BEARER_TOKEN env var.")
            return 1
        
        agent = OrchestratorAgent(hubspot_token=hubspot_token)
        deals = agent.list_hubspot_deals(limit=args.limit)
        
        print("\n" + "="*60)
        print("HUBSPOT DEALS")
        print("="*60)
        
        if not deals:
            print("No deals found.")
            return 0
        
        for deal in deals:
            print(f"\n📋 {deal.deal_name}")
            print(f"   ID: {deal.deal_id}")
            print(f"   Amount: ${deal.amount:,.2f}")
            print(f"   Stage: {deal.stage}")
            if deal.close_date:
                print(f"   Close Date: {deal.close_date}")
        
        print(f"\n💡 To create an ACE opportunity from a deal:")
        print(f"   python orchestrator_agent.py hubspot-create -d <DEAL_ID>")
        
        return 0
    
    elif args.command == 'hubspot-sync':
        hubspot_token = args.hubspot_token or os.environ.get('HUBSPOT_BEARER_TOKEN')
        if not hubspot_token:
            print("❌ Error: HubSpot bearer token required. Use --hubspot-token or set HUBSPOT_BEARER_TOKEN env var.")
            return 1
        
        agent = OrchestratorAgent(config_path=args.config, hubspot_token=hubspot_token)
        
        print("\n" + "="*60)
        print("PARTNER CENTRAL → HUBSPOT SYNC")
        print("="*60)
        print(f"Opportunity ID: {args.opportunity_id}")
        print(f"HubSpot Deal ID: {args.deal_id}")
        print("="*60)
        
        result = agent.sync_to_hubspot(
            opportunity_id=args.opportunity_id,
            hubspot_deal_id=args.deal_id
        )
        
        if result.get("success"):
            print("\n✅ SYNC SUCCESSFUL!")
            sync_status = result.get("sync_status", {})
            print(f"PC Review Status: {sync_status.get('review_status')}")
            print(f"PC Stage: {sync_status.get('stage')}")
            print(f"HubSpot Stage Updated To: {sync_status.get('recommended_hubspot_stage')}")
            
            updated_props = result.get("updated_properties", {})
            if updated_props:
                print("\nUpdated HubSpot Properties:")
                for key, value in updated_props.items():
                    print(f"  {key}: {value}")
        else:
            print(f"\n❌ SYNC FAILED: {result.get('error')}")
        
        return 0 if result.get("success") else 1
    
    elif args.command == 'salesforce-create':
        salesforce_token = args.salesforce_token or os.environ.get('SALESFORCE_ACCESS_TOKEN')
        instance_url = args.instance_url or os.environ.get('SALESFORCE_INSTANCE_URL')
        
        if not salesforce_token:
            print("❌ Error: Salesforce access token required. Use --salesforce-token or set SALESFORCE_ACCESS_TOKEN env var.")
            return 1
        
        if not instance_url:
            print("❌ Error: Salesforce instance URL required. Use --instance-url or set SALESFORCE_INSTANCE_URL env var.")
            return 1
        
        agent = OrchestratorAgent(
            config_path=args.config,
            salesforce_token=salesforce_token,
            salesforce_instance_url=instance_url
        )
        
        print("\n" + "="*60)
        print("SALESFORCE → ACE OPPORTUNITY CREATION")
        print("="*60)
        
        result = agent.create_opportunity_from_salesforce(
            opportunity_id=args.opportunity_id,
            project_title=args.title
        )
        
        if result.get("success"):
            print("\n✅ SUCCESS!")
            sf_opp = result.get('salesforce_opportunity', {})
            print(f"Salesforce Opportunity: {sf_opp.get('name')} ({sf_opp.get('account')})")
            print(f"Amount: ${sf_opp.get('amount', 0):,.2f}")
            print(f"ACE Opportunity ID: {result['ace_opportunity_id']}")
        else:
            print(f"\n❌ FAILED: {result.get('error')}")
        
        return 0 if result.get("success") else 1
    
    elif args.command == 'salesforce-list':
        salesforce_token = args.salesforce_token or os.environ.get('SALESFORCE_ACCESS_TOKEN')
        instance_url = args.instance_url or os.environ.get('SALESFORCE_INSTANCE_URL')
        
        if not salesforce_token:
            print("❌ Error: Salesforce access token required. Use --salesforce-token or set SALESFORCE_ACCESS_TOKEN env var.")
            return 1
        
        if not instance_url:
            print("❌ Error: Salesforce instance URL required. Use --instance-url or set SALESFORCE_INSTANCE_URL env var.")
            return 1
        
        agent = OrchestratorAgent(
            salesforce_token=salesforce_token,
            salesforce_instance_url=instance_url
        )
        opportunities = agent.list_salesforce_opportunities(limit=args.limit)
        
        print("\n" + "="*60)
        print("SALESFORCE OPPORTUNITIES")
        print("="*60)
        
        if not opportunities:
            print("No opportunities found.")
            return 0
        
        for opp in opportunities:
            print(f"\n📋 {opp.name}")
            print(f"   ID: {opp.opportunity_id}")
            print(f"   Amount: ${opp.amount:,.2f}")
            print(f"   Stage: {opp.stage}")
            if opp.close_date:
                print(f"   Close Date: {opp.close_date}")
        
        print(f"\n💡 To create an ACE opportunity from a Salesforce opportunity:")
        print(f"   python orchestrator_agent.py salesforce-create -o <OPPORTUNITY_ID>")
        
        return 0
    
    elif args.command == 'salesforce-sync':
        salesforce_token = args.salesforce_token or os.environ.get('SALESFORCE_ACCESS_TOKEN')
        instance_url = args.instance_url or os.environ.get('SALESFORCE_INSTANCE_URL')
        
        if not salesforce_token:
            print("❌ Error: Salesforce access token required. Use --salesforce-token or set SALESFORCE_ACCESS_TOKEN env var.")
            return 1
        if not instance_url:
            print("❌ Error: Salesforce instance URL required. Use --instance-url or set SALESFORCE_INSTANCE_URL env var.")
            return 1
        
        agent = OrchestratorAgent(
            config_path=args.config,
            salesforce_token=salesforce_token,
            salesforce_instance_url=instance_url
        )
        
        print("\n" + "="*60)
        print("PARTNER CENTRAL → SALESFORCE SYNC")
        print("="*60)
        print(f"PC Opportunity ID: {args.opportunity_id}")
        print(f"Salesforce Opportunity ID: {args.sf_opportunity_id}")
        print("="*60)
        
        result = agent.sync_to_salesforce(
            opportunity_id=args.opportunity_id,
            sf_opportunity_id=args.sf_opportunity_id
        )
        
        if result.get("success"):
            print("\n✅ SYNC SUCCESSFUL!")
            sync_status = result.get("sync_status", {})
            print(f"PC Review Status: {sync_status.get('review_status')}")
            print(f"PC Stage: {sync_status.get('stage')}")
            print(f"Salesforce Stage Updated To: {sync_status.get('recommended_salesforce_stage')}")
            
            updated_fields = result.get("updated_fields", {})
            if updated_fields:
                print("\nUpdated Salesforce Fields:")
                for key, value in updated_fields.items():
                    print(f"  {key}: {value}")
        else:
            print(f"\n❌ SYNC FAILED: {result.get('error')}")
        
        return 0 if result.get("success") else 1
    
    elif args.command == 'pipedrive-sync':
        pipedrive_token = args.pipedrive_token or os.environ.get('PIPEDRIVE_API_TOKEN')
        instance_url = args.instance_url or os.environ.get('PIPEDRIVE_INSTANCE_URL')
        
        if not pipedrive_token:
            print("❌ Error: Pipedrive API token required. Use --pipedrive-token or set PIPEDRIVE_API_TOKEN env var.")
            return 1
        if not instance_url:
            print("❌ Error: Pipedrive instance URL required. Use --instance-url or set PIPEDRIVE_INSTANCE_URL env var.")
            return 1
        
        agent = OrchestratorAgent(
            config_path=args.config,
            pipedrive_token=pipedrive_token,
            pipedrive_instance_url=instance_url
        )
        
        print("\n" + "="*60)
        print("PARTNER CENTRAL → PIPEDRIVE SYNC")
        print("="*60)
        print(f"PC Opportunity ID: {args.opportunity_id}")
        print(f"Pipedrive Deal ID: {args.deal_id}")
        print("="*60)
        
        result = agent.sync_to_pipedrive(
            opportunity_id=args.opportunity_id,
            pipedrive_deal_id=args.deal_id
        )
        
        if result.get("success"):
            print("\n✅ SYNC SUCCESSFUL!")
            sync_status = result.get("sync_status", {})
            print(f"PC Review Status: {sync_status.get('review_status')}")
            print(f"PC Stage: {sync_status.get('stage')}")
            print(f"Pipedrive Stage Updated To: {sync_status.get('recommended_pipedrive_stage')}")
            
            updated_fields = result.get("updated_fields", {})
            if updated_fields:
                print("\nUpdated Pipedrive Fields:")
                for key, value in updated_fields.items():
                    print(f"  {key}: {value}")
        else:
            print(f"\n❌ SYNC FAILED: {result.get('error')}")
        
        return 0 if result.get("success") else 1
    
    elif args.command == 'marketplace-list':
        agent = OrchestratorAgent(config_path=args.config)
        
        print("\n" + "="*60)
        print(f"AWS MARKETPLACE CATALOG — {args.entity_type} ENTITIES")
        print("="*60)
        
        if args.entity_type == 'Offer':
            # Build filters from CLI arguments
            offer_filters = {}
            if args.targeting:
                offer_filters['targeting'] = args.targeting
            if args.state:
                offer_filters['state'] = args.state
            if args.product_id:
                offer_filters['product_id'] = args.product_id
            if args.buyer_accounts:
                offer_filters['buyer_accounts'] = [a.strip() for a in args.buyer_accounts.split(',')]
            if args.name:
                offer_filters['name'] = args.name
            
            if offer_filters:
                print(f"Filters: {offer_filters}")
            
            result = agent.list_marketplace_offers(max_results=args.limit, **offer_filters)
        else:
            result = agent.list_marketplace_products(product_type=args.entity_type, max_results=args.limit)
        
        if not result.get('success'):
            print(f"\n❌ Error: {result.get('error')}")
            return 1
        
        entities = result.get('entities', [])
        if not entities:
            print(f"No {args.entity_type} entities found.")
            return 0
        
        for entity in entities:
            print(f"\n📦 {entity.get('Name', 'Unnamed')}")
            print(f"   ID: {entity.get('EntityId')}")
            print(f"   Type: {entity.get('EntityType')}")
            if entity.get('Visibility'):
                print(f"   Visibility: {entity.get('Visibility')}")
            if entity.get('LastModifiedDate'):
                print(f"   Last Modified: {entity.get('LastModifiedDate')}")
        
        print(f"\n💡 To describe a specific entity:")
        print(f"   python orchestrator_agent.py marketplace-describe -e <ENTITY_ID>")
        
        return 0
    
    elif args.command == 'marketplace-describe':
        agent = OrchestratorAgent(config_path=args.config)
        
        print("\n" + "="*60)
        print(f"AWS MARKETPLACE CATALOG — ENTITY DETAILS")
        print("="*60)
        
        result = agent.describe_marketplace_entity(entity_id=args.entity_id)
        
        if not result.get('success'):
            print(f"\n❌ Error: {result.get('error')}")
            return 1
        
        print(f"\n📦 Entity: {result.get('entity_id')}")
        print(f"   Type: {result.get('entity_type')}")
        print(f"   ARN: {result.get('entity_arn')}")
        print(f"   Last Modified: {result.get('last_modified_date')}")
        
        details = result.get('details')
        if details:
            print(f"\n   Details:")
            print(f"   {json.dumps(details, indent=2, default=str)[:2000]}")
        
        return 0
    
    elif args.command == 'ask':
        question = args.question or args.prompt
        if not question:
            print("❌ Error: Provide a question as an argument or via --prompt.")
            return 1

        agent = OrchestratorAgent(config_path=args.config)
        config = agent.mcp_client.config
        mcp_endpoint = config['endpoints']['partnercentral_mcp']

        if args.opportunity_id:
            question = f"Regarding opportunity {args.opportunity_id}: {question}"

        import boto3
        import requests
        from botocore.auth import SigV4Auth
        from botocore.awsrequest import AWSRequest

        mcp_payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "sendMessage",
                "arguments": {
                    "content": [{
                        "type": "text",
                        "text": question
                    }],
                    "catalog": config.get('catalog', 'Sandbox')
                }
            }
        }

        session = boto3.Session()
        credentials = session.get_credentials()

        request = AWSRequest(
            method='POST',
            url=mcp_endpoint,
            data=json.dumps(mcp_payload),
            headers={'Content-Type': 'application/json'}
        )

        service_name = 'partnercentral-agents' if 'gamma' in mcp_endpoint else 'partnercentral-agents-mcp'
        SigV4Auth(credentials, service_name, config.get('region', 'us-east-1')).add_auth(request)

        print(f"\n💬 Asking Partner Central Agent: {question}\n")

        try:
            response = requests.post(
                request.url,
                data=request.body,
                headers=dict(request.headers),
                timeout=120
            )
            response.raise_for_status()
            result = response.json()

            content = result.get('result', {}).get('content', [])
            if content and content[0].get('type') == 'text':
                inner = json.loads(content[0].get('text', '{}'))
                status = inner.get('status', '')
                session_id = inner.get('sessionId', '')

                # Extract agent response
                answer = None
                for item in reversed(inner.get('content', [])):
                    item_type = item.get('type', '')
                    if item_type == 'ASSISTANT_RESPONSE':
                        item_content = item.get('content', {})
                        if isinstance(item_content, dict) and 'text' in item_content:
                            answer = item_content['text']
                            break
                    elif item_type == 'text':
                        answer = item.get('text')
                        break

                if status == 'requires_approval':
                    # Auto-approve read operations, prompt for writes
                    for item in inner.get('content', []):
                        if item.get('type') == 'tool_approval_request':
                            tool_content = item.get('content', {})
                            try:
                                approval_data = json.loads(tool_content.get('text', '{}'))
                                tool_name = approval_data.get('tool_name', '')
                                tool_use_id = approval_data.get('tool_use_id')

                                is_read = any(k in tool_name.lower() for k in ('get', 'list', 'read', 'describe'))

                                if is_read:
                                    decision = 'approve'
                                    print(f"🔄 Auto-approving read operation: {tool_name}")
                                else:
                                    print(f"\n🔐 APPROVAL REQUIRED")
                                    print(f"   Tool: {tool_name}")
                                    while True:
                                        choice = input("\nApprove this action? [y/n]: ").strip().lower()
                                        if choice in ('y', 'yes'):
                                            decision = 'approve'
                                            break
                                        elif choice in ('n', 'no'):
                                            decision = 'reject'
                                            break
                                        print("Please enter 'y' or 'n'")

                                # Send approval
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

                                approval_request = AWSRequest(
                                    method='POST',
                                    url=mcp_endpoint,
                                    data=json.dumps(approval_payload),
                                    headers={'Content-Type': 'application/json'}
                                )
                                SigV4Auth(credentials, service_name, config.get('region', 'us-east-1')).add_auth(approval_request)

                                approval_response = requests.post(
                                    approval_request.url,
                                    data=approval_request.body,
                                    headers=dict(approval_request.headers),
                                    timeout=120
                                )
                                approval_response.raise_for_status()
                                approval_result = approval_response.json()

                                # Extract final answer
                                final_content = approval_result.get('result', {}).get('content', [])
                                if final_content and final_content[0].get('type') == 'text':
                                    final_inner = json.loads(final_content[0].get('text', '{}'))
                                    for fi in reversed(final_inner.get('content', [])):
                                        fi_type = fi.get('type', '')
                                        if fi_type == 'ASSISTANT_RESPONSE':
                                            fi_content = fi.get('content', {})
                                            if isinstance(fi_content, dict) and 'text' in fi_content:
                                                answer = fi_content['text']
                                                break
                                        elif fi_type == 'text':
                                            answer = fi.get('text')
                                            break
                            except Exception as approval_err:
                                logger.warning(f"Error in approval flow: {approval_err}")
                            break

                if answer:
                    print("=" * 60)
                    print("PARTNER CENTRAL AGENT RESPONSE")
                    print("=" * 60)
                    print(f"\n{answer}\n")
                else:
                    print("No response from the agent.")

            return 0

        except Exception as e:
            logger.error(f"Error asking agent: {e}")
            print(f"\n❌ Error: {e}")
            return 1

    else:
        parser.print_help()
        return 1


if __name__ == "__main__":
    exit(main())

