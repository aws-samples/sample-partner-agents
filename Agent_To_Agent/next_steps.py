"""Next-steps generation backed by the Strands Agents SDK."""

import os
import logging
from typing import Dict, List
from context_sources import ContextSource

logger = logging.getLogger(__name__)


class NextStepsGenerator:
    """Generate next steps using Claude via the Strands Agents SDK.

    The manual Bedrock model discovery + converse plumbing has been replaced
    by a Strands ``Agent`` backed by ``BedrockModel``. Strands owns the model
    invocation, credential/region resolution, and the agent loop; this class
    just builds the prompt and picks the first usable model from a candidate
    list, so model-access friction still degrades gracefully to a fallback.
    """

    # Ordered candidate list tried when BEDROCK_MODEL_ID isn't pinned. The
    # first model that returns a response is cached for the life of the
    # process. Cross-region inference profiles ("us.") come first because the
    # newer Claude models are only invocable through them.
    FALLBACK_BEDROCK_CANDIDATES = (
        'us.anthropic.claude-haiku-4-5-20251001-v1:0',
        'us.anthropic.claude-3-5-haiku-20241022-v1:0',
        'us.anthropic.claude-3-haiku-20240307-v1:0',
        'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
        'us.anthropic.claude-sonnet-4-20250514-v1:0',
        'anthropic.claude-3-haiku-20240307-v1:0',
        'anthropic.claude-3-5-sonnet-20241022-v2:0',
    )

    SYSTEM_PROMPT = (
        "You are an AI assistant helping a partner sales team manage AWS "
        "Partner Central opportunities. Based on the context you are given, "
        "generate clear, actionable next steps for the opportunity."
    )

    # Substrings in a Bedrock error that mean "this model isn't usable on this
    # account/region — try the next candidate" rather than a hard failure.
    _MODEL_UNAVAILABLE_MARKERS = (
        'AccessDeniedException', 'ValidationException', 'ResourceNotFoundException',
        'inference profile', 'not found', 'does not exist', 'on-demand throughput',
    )

    def __init__(self, use_bedrock: bool = True):
        self.use_bedrock = use_bedrock
        # Pinned override: BEDROCK_MODEL_ID skips the candidate probe.
        self._pinned_bedrock_model_id = os.environ.get('BEDROCK_MODEL_ID')
        # Resolved on first successful invoke. None means "not yet resolved".
        self._resolved_bedrock_model_id = None
        # Cached Strands Agent for the resolved model.
        self._agent = None
        self.bedrock_region = (
            os.environ.get('AWS_REGION')
            or os.environ.get('AWS_DEFAULT_REGION')
            or 'us-east-1'
        )
        # Stores the last warning/error if the keyword fallback was used.
        self.last_warning = None

    @property
    def bedrock_model_id(self):
        """Resolved Bedrock model ID. None until a model responds successfully."""
        return self._resolved_bedrock_model_id or self._pinned_bedrock_model_id

    def _candidate_models(self) -> List[str]:
        """Models to try, in order. A pinned BEDROCK_MODEL_ID wins outright."""
        if self._pinned_bedrock_model_id:
            return [self._pinned_bedrock_model_id]
        return list(self.FALLBACK_BEDROCK_CANDIDATES)

    def _make_agent(self, model_id: str):
        """Build a Strands Agent backed by a specific Bedrock model.

        ``callback_handler=None`` silences Strands' default stdout streaming so
        the agent stays quiet when driven from the REST server or demo UI.
        """
        from strands import Agent
        from strands.models import BedrockModel

        model = BedrockModel(
            model_id=model_id,
            region_name=self.bedrock_region,
            temperature=0.7,
            max_tokens=1000,
        )
        return Agent(model=model, system_prompt=self.SYSTEM_PROMPT, callback_handler=None)

    def _invoke(self, user_message: str) -> str:
        """Run the prompt through Strands, picking the first usable model.

        Tries the cached/pinned model first, then walks the candidate list,
        skipping any model the account can't invoke. Re-raises the last error
        if none succeed so the caller can fall back to keyword generation.
        """
        candidates = (
            [self._resolved_bedrock_model_id]
            if self._resolved_bedrock_model_id
            else self._candidate_models()
        )
        last_error = None
        for model_id in candidates:
            try:
                if self._agent is None or self._resolved_bedrock_model_id != model_id:
                    self._agent = self._make_agent(model_id)
                result = self._agent(user_message)
                self._resolved_bedrock_model_id = model_id
                logger.info(f"Strands agent responded using Bedrock model: {model_id}")
                return str(result).strip()
            except Exception as e:
                err = str(e)
                if any(marker in err for marker in self._MODEL_UNAVAILABLE_MARKERS):
                    logger.debug(f"Bedrock model {model_id} not usable: {err[:150]}")
                    self._agent = None
                    last_error = e
                    continue
                # Transient/unknown error (network, throttling) — stop probing
                # so we don't burn through the whole candidate list.
                raise
        if last_error:
            raise last_error
        raise RuntimeError("No Bedrock model candidates available")

    def _build_prompt(self, context_sources: List[ContextSource], prompt: str,
                      opportunity_data: Dict = None) -> str:
        """Assemble the user message (context + opportunity + instructions)."""
        context_parts = []
        for source in context_sources:
            context_parts.append(f"### Source: {source.source_name} ({source.source_type})\n{source.content}\n")
        context_text = "\n".join(context_parts)

        opp_context = ""
        if opportunity_data:
            opp_context = f"""
### Current Opportunity Data
- Customer: {opportunity_data.get('Customer', {}).get('Account', {}).get('CompanyName', 'Unknown')}
- Stage: {opportunity_data.get('LifeCycle', {}).get('Stage', 'Unknown')}
- Current Next Steps: {opportunity_data.get('LifeCycle', {}).get('NextSteps', 'None')}
"""

        return f"""Based on the following context from various sources, generate clear, actionable next steps for this opportunity.

{opp_context}

## Context from Sources:
{context_text}

## User Request:
{prompt}

## Instructions:
1. Analyze all the context provided
2. Identify the TOP 2-3 most critical action items
3. CRITICAL: Total response must be UNDER 255 characters (Partner Central field limit)
4. Be extremely concise - use abbreviations if needed
5. Format as a simple numbered list without headers

## Next Steps:"""

    def generate(self, context_sources: List[ContextSource], prompt: str, opportunity_data: Dict = None) -> str:
        """Generate next steps from gathered context via the Strands agent."""
        self.last_warning = None  # Clear any previous warning

        if not self.use_bedrock:
            return self._generate_fallback(
                context_sources, opportunity_data,
                reason="Bedrock disabled (use_bedrock=False)",
            )

        user_message = self._build_prompt(context_sources, prompt, opportunity_data)

        try:
            return self._invoke(user_message)
        except Exception as e:
            logger.error(f"Error generating next steps via Strands: {e}")
            return self._generate_fallback(
                context_sources, opportunity_data,
                reason=(
                    f"{e}\n\nNo usable Bedrock Claude model in region "
                    f"{self.bedrock_region}. Anthropic models are auto-enabled on "
                    "first invoke in commercial regions, but first-time users may "
                    "need to submit a one-time use-case form via the Bedrock console "
                    "Model catalog. Confirm IAM grants bedrock:InvokeModel on the "
                    "Anthropic foundation-model/* and inference-profile/* ARNs, or "
                    "set BEDROCK_MODEL_ID to pin a specific model."
                ),
            )

    def _generate_fallback(self, context_sources: List[ContextSource], opportunity_data: Dict = None, reason: str = "") -> str:
        """Generate a reasonable placeholder when Bedrock/Anthropic is unavailable.

        This allows participants to continue the workshop (MCP update, approval
        flow, chat) even if their Bedrock permissions aren't set up correctly.
        The fallback extracts keywords from the context and builds a generic
        but plausible next-steps string.
        """
        warning_msg = (
            f"⚠️ AI model (Bedrock) failed — using keyword-based fallback. "
            f"Error: {reason}\n\n"
            f"To fix: check your IAM policy includes "
            f"'arn:aws:bedrock:*::foundation-model/*' and "
            f"'arn:aws:bedrock:*:*:inference-profile/*' in the Resource field. "
            f"Share this error with your cloud admin."
        )
        self.last_warning = warning_msg
        logger.warning(f"Using fallback next-steps generator (reason: {reason})")

        # Try to extract something useful from the context
        keywords = []
        for source in (context_sources or []):
            text = source.content.lower()
            if "migration" in text or "migrate" in text:
                keywords.append("migration planning")
            if "cost" in text or "spend" in text or "savings" in text:
                keywords.append("cost optimization review")
            if "architecture" in text or "well-architected" in text:
                keywords.append("architectural review")
            if "funding" in text or "map" in text:
                keywords.append("MAP funding application")
            if "security" in text or "compliance" in text or "hipaa" in text:
                keywords.append("security/compliance review")
            if "poc" in text or "demo" in text or "proof" in text:
                keywords.append("schedule POC/demo")
            if "meeting" in text or "call" in text:
                keywords.append("follow-up meeting")

        # Deduplicate and limit
        seen = set()
        unique_keywords = []
        for kw in keywords:
            if kw not in seen:
                seen.add(kw)
                unique_keywords.append(kw)
            if len(unique_keywords) >= 3:
                break

        # Build fallback steps
        if unique_keywords:
            steps = [f"{i+1}. {kw.capitalize()}" for i, kw in enumerate(unique_keywords)]
        else:
            # Generic fallback if no keywords found
            steps = [
                "1. Schedule follow-up meeting with customer",
                "2. Prepare technical proposal and pricing",
                "3. Submit opportunity for AWS review"
            ]

        result = "\n".join(steps)

        # Truncate to 255 chars (Partner Central limit)
        if len(result) > 255:
            result = result[:252] + "..."

        logger.info(f"Fallback next steps generated: {result}")
        return result
