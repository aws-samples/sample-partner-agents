#!/usr/bin/env python
"""
PipeRun to Partner Central Data Mapper.

Maps PipeRun CRM deal data to AWS Partner Central opportunity format.

Unlike the other CRMs in this app (HubSpot / Salesforce / Pipedrive), which
connect over direct REST, PipeRun data is fetched through the PipeRun **MCP
server** (see crm/piperun_client.py). The mapper itself is transport-agnostic:
it takes a normalized PipeRunDeal and produces the same CreateOpportunity
payload shape the other mappers do, so it reuses the Pipedrive mapper's
CRM-agnostic helpers (address/industry/contact/spend/country/state) and only
overrides the PipeRun-specific stage mapping and identifiers.

Field Mapping Reference
-----------------------
PipeRun Field                 -> Partner Central Field
------------------------------   -------------------------------------------
title                            Project.Title
value                            Project.ExpectedCustomerSpend.Amount
currency                         Project.ExpectedCustomerSpend.CurrencyCode
probably_closed_at               LifeCycle.TargetCloseDate
stage_id (-> stage name)         LifeCycle.Stage (mapped)
person.name / email / phone      Customer.Contacts[0]
company.name                     Customer.Account.CompanyName
company.address.*                Customer.Account.Address
id                               PartnerOpportunityIdentifier (prefixed PR-)
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Dict

from crm.pipedrive_mapper import PipedriveToPartnerCentralMapper


@dataclass
class PipeRunDeal:
    """Represents a PipeRun deal with the fields we map to Partner Central.

    Mirrors the shape of PipedriveDeal so it can reuse the Pipedrive mapper's
    CRM-agnostic helpers. `stage` is the human-readable stage name (resolved
    from stage_id via the PipeRun MCP `list_stages` tool).
    """

    deal_id: str
    title: str
    value: float
    stage: str
    expected_close_date: str
    org_name: str
    contact_name: str
    contact_email: str
    description: str = ""
    properties: Dict = field(default_factory=dict)


class PipeRunToPartnerCentralMapper(PipedriveToPartnerCentralMapper):
    """Map a PipeRunDeal into a Partner Central CreateOpportunity payload.

    Inherits all the CRM-agnostic mapping (customer/address/industry/contact/
    spend/phone/country/state normalization and the Partner Central enum
    allow-lists) from PipedriveToPartnerCentralMapper and overrides only the
    PipeRun-specific stage mapping, sales-activity mapping, and identifiers.
    """

    # PipeRun stage names -> Partner Central Stage. Keys are lowercased.
    #
    # A PipeRun account has several funnels (Vendas/Pré-Vendas/Prospecção/...);
    # the "Vendas" (sales) funnel is the one that maps to a co-sell lifecycle.
    # PipeRun stage names are Portuguese by default, so we key on those and
    # also include common English equivalents. Won/Lost are PipeRun deal
    # *statuses* rather than stages, but we map their names too for accounts
    # that model them as stages. Anything unknown falls back to "Prospect".
    PIPERUN_STAGE_MAPPING = {
        # Vendas (sales) funnel — ordered early -> late
        "lead mql": "Prospect",
        "lead": "Prospect",
        "lista": "Prospect",
        "lista de leads": "Prospect",
        "contato": "Qualified",
        "conectar pessoas": "Qualified",
        "qualificar fit": "Qualified",
        "enriquecer dados": "Qualified",
        "reunião": "Technical Validation",
        "reuniao": "Technical Validation",
        "proposta": "Business Validation",
        "follow-up": "Business Validation",
        "follow up": "Business Validation",
        "negociação": "Committed",
        "negociacao": "Committed",
        "contrato": "Committed",
        # Won / Lost (deal outcome)
        "ganha": "Launched",
        "ganho": "Launched",
        "won": "Launched",
        "perdida": "Closed Lost",
        "perdido": "Closed Lost",
        "lost": "Closed Lost",
        # English fallbacks
        "qualified": "Qualified",
        "contact made": "Qualified",
        "meeting": "Technical Validation",
        "demo": "Technical Validation",
        "proposal": "Business Validation",
        "negotiation": "Committed",
        "contract": "Committed",
    }

    # PipeRun stage name -> Partner Central SalesActivity (must be a member of
    # PipedriveToPartnerCentralMapper.VALID_SALES_ACTIVITIES).
    PIPERUN_STAGE_TO_ACTIVITY = {
        "lead mql": "Initialized discussions with customer",
        "lead": "Initialized discussions with customer",
        "lista": "Initialized discussions with customer",
        "contato": "Customer has shown interest in solution",
        "conectar pessoas": "Customer has shown interest in solution",
        "qualificar fit": "Customer has shown interest in solution",
        "reunião": "Conducted POC / Demo",
        "reuniao": "Conducted POC / Demo",
        "proposta": "Agreed on solution to Business Problem",
        "follow-up": "Agreed on solution to Business Problem",
        "negociação": "Completed Action Plan",
        "negociacao": "Completed Action Plan",
        "contrato": "SOW Signed",
        "ganha": "SOW Signed",
        "ganho": "SOW Signed",
        "won": "SOW Signed",
    }

    # PipeRun stage name -> a human business-problem line for demo readability.
    PIPERUN_STAGE_PROBLEMS = {
        "lead mql": "Initial discovery — understanding customer needs",
        "lead": "Initial discovery — understanding customer needs",
        "contato": "Customer has shown interest in a cloud solution",
        "qualificar fit": "Qualifying fit for an AWS solution",
        "reunião": "Evaluating AWS solutions for business requirements",
        "reuniao": "Evaluating AWS solutions for business requirements",
        "proposta": "Proposal shared — ready to proceed with AWS implementation",
        "follow-up": "Following up on the AWS proposal",
        "negociação": "Finalizing terms for the AWS engagement",
        "negociacao": "Finalizing terms for the AWS engagement",
        "contrato": "Contract stage — closing the AWS opportunity",
    }

    # ---- PipeRun-specific overrides -----------------------------------------

    def _map_stage(self, deal: "PipeRunDeal") -> str:
        stage_lower = (deal.stage or "").lower().strip()
        mapped = self.PIPERUN_STAGE_MAPPING.get(stage_lower, "Prospect")
        return mapped if mapped in self.VALID_STAGES else "Prospect"

    def _map_sales_activity(self, deal: "PipeRunDeal") -> str:
        stage_lower = (deal.stage or "").lower().strip()
        activity = self.PIPERUN_STAGE_TO_ACTIVITY.get(
            stage_lower, self.DEFAULT_SALES_ACTIVITY
        )
        return activity if activity in self.VALID_SALES_ACTIVITIES else self.DEFAULT_SALES_ACTIVITY

    def _map_business_problem(self, deal: "PipeRunDeal") -> str:
        if deal.properties.get("customer_business_problem"):
            return deal.properties["customer_business_problem"]
        if deal.description:
            return deal.description[:500]
        stage_lower = (deal.stage or "").lower().strip()
        return self.PIPERUN_STAGE_PROBLEMS.get(
            stage_lower, "Opportunity from PipeRun - New Business"
        )

    def _generate_company_name(self, deal: "PipeRunDeal", timestamp: int) -> str:
        base = deal.org_name or "PROpportunity"
        return f"{base}-{timestamp}"

    def _generate_partner_opportunity_id(self, deal: "PipeRunDeal", timestamp: int) -> str:
        return f"PR-{deal.deal_id}-{timestamp}"

    def _generate_client_token(self, deal: "PipeRunDeal", timestamp: int) -> str:
        safe = re.sub(r"\s+", "-", (deal.title or "deal"))[:20]
        return f"piperun-{safe}-{timestamp}"
