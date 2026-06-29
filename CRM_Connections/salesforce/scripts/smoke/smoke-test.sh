#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# smoke-test.sh — End-to-end smoke test for partner-central-chat-agent
#
# Runs a series of checks against a real org to verify the chat agent's
# server-side paths work end-to-end. Divided into three tiers so the
# destructive paths are opt-in:
#
#   tier 1 (default):  Config / connector detect / session round-trip /
#                      record-context describe / permission-set grant /
#                      recent audit log sanity. Zero MCP callouts. Safe
#                      to run any time.
#
#   tier 2 (--live):   Tier 1 plus one live read-only sendMessage turn
#                      against the MCP server. Consumes a small amount of
#                      upstream quota. Does not mutate Partner Central.
#
#   tier 3 (--approve):Tier 2 plus a full approval round-trip that auto-
#                      rejects the agent's write so Partner Central stays
#                      unchanged. Use this to verify the approve/reject
#                      plumbing; the write side intentionally never
#                      commits.
#
#   attachment (--attach): Tier 2 plus a real document upload to the Partner
#                      Central ephemeral S3 bucket and a read-only
#                      sendMessage that references it. Implies --live.
#                      Skips cleanly if the S3 upload config is absent.
#
# Usage:
#   ./scripts/smoke/smoke-test.sh <target-org> [--live] [--approve] [--attach]
#                                  [--general-chat]
#                                  [--record-id <id>]
#                                  [--message "<text>"]
#
# --general-chat forces the record-less (standalone) path for orgs without
# the AWS Partner CRM Connector. If omitted, the script auto-detects: when no
# ACE Opportunity exists it falls back to general-chat mode instead of failing.
#
# Example:
#   ./scripts/smoke/smoke-test.sh my-dev-org
#   ./scripts/smoke/smoke-test.sh my-dev-org --live
#   ./scripts/smoke/smoke-test.sh my-dev-org --general-chat --live
#   ./scripts/smoke/smoke-test.sh my-dev-org --approve --record-id <opportunity-record-id>
# -----------------------------------------------------------------------------
set -euo pipefail

TARGET_ORG="${1:-}"
if [ -z "${TARGET_ORG}" ] || [[ "${TARGET_ORG}" == --* ]]; then
    echo "Usage: $0 <target-org> [--live] [--approve] [--attach] [--general-chat] [--record-id <id>] [--message \"<text>\"]" >&2
    exit 1
fi
shift

LIVE=0
APPROVE=0
ATTACH=0
GENERAL=0
RECORD_ID=""
MESSAGE="Give me a one-sentence summary of this opportunity."
REJECT_MESSAGE="Change the Next Step field to 'smoke-test — please reject this'"

while [ $# -gt 0 ]; do
    case "$1" in
        --live)         LIVE=1 ;;
        --approve)      LIVE=1; APPROVE=1 ;;
        --attach)       LIVE=1; ATTACH=1 ;;
        --general-chat) GENERAL=1 ;;
        --record-id)    RECORD_ID="$2"; shift ;;
        --message)      MESSAGE="$2"; shift ;;
        *) echo "Unknown flag: $1" >&2; exit 1 ;;
    esac
    shift
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APEX_DIR="${SCRIPT_DIR}/apex"

pass() { printf '\033[0;32m✓\033[0m  %s\n' "$*"; }
fail() { printf '\033[0;31m✗\033[0m  %s\n' "$*"; exit 1; }
info() { printf '   %s\n'           "$*"; }
hdr()  { printf '\n\033[1;34m— %s —\033[0m\n' "$*"; }

run_anon() {
    # Executes an apex file and fails if compile or runtime fails.
    # Captures stdout separately from stderr because `sf` emits CLI
    # upgrade notices to stderr that would otherwise corrupt the JSON.
    local file="$1"
    local out
    if ! out=$(sf apex run --target-org "${TARGET_ORG}" --file "${file}" --json 2>/dev/null); then
        echo "${out}" >&2
        fail "sf apex run exited non-zero: ${file}"
    fi
    local compiled success logs exc
    compiled=$(echo "${out}" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(bool(d["result"]["compiled"]))' 2>/dev/null || echo "False")
    success=$(echo "${out}"  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(bool(d["result"]["success"]))'  2>/dev/null || echo "False")
    logs=$(echo "${out}"     | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["result"].get("logs","") or "")' 2>/dev/null || echo "")
    exc=$(echo "${out}"      | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["result"].get("exceptionMessage","") or "")' 2>/dev/null || echo "")
    if [ "${compiled}" != "True" ]; then
        echo "${out}" >&2
        fail "Anonymous Apex failed to compile: ${file}"
    fi
    if [ "${success}" != "True" ]; then
        echo "${logs}" >&2
        echo "exception: ${exc}" >&2
        fail "Anonymous Apex threw at runtime: ${file}"
    fi
    # Surface the USER_DEBUG lines so the shell log is readable. The
    # `logs` field uses literal \n sequences, not newlines; restore
    # them, decode HTML entities (`&#124;` -> `|`), and print the
    # DEBUG lines verbatim.
    printf '%s\n' "${logs}" \
        | python3 -c 'import sys,html; raw=sys.stdin.read(); print(html.unescape(raw))' \
        | grep -E 'USER_DEBUG' \
        | sed 's/^.*USER_DEBUG|\[[0-9]*\]|DEBUG|/      /' || true
}

soql() {
    local q="$1"
    local out
    if ! out=$(sf data query --target-org "${TARGET_ORG}" -q "${q}" --json 2>/dev/null); then
        echo "[]"
        return 0
    fi
    echo "${out}" | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
    print(json.dumps(d.get("result", {}).get("records", [])))
except Exception:
    print("[]")'
}

# -----------------------------------------------------------------------------
# Tier 1: read-only safety checks
# -----------------------------------------------------------------------------
hdr "Tier 1 / config + connector + session round-trip"

info "target org      : ${TARGET_ORG}"
info "live MCP calls  : $([ $LIVE -eq 1 ] && echo yes || echo no)"
info "approval path   : $([ $APPROVE -eq 1 ] && echo yes || echo no)"
info "attachment test : $([ $ATTACH -eq 1 ] && echo yes || echo no)"

# Mode resolution. --general-chat forces the record-less path (standalone
# deployment without the AWS Partner CRM Connector). Otherwise try to resolve
# the most-recently-modified ACE opportunity that has an APN CRM id; if none
# exists (no connector, or no records), fall back to general-chat mode rather
# than failing.
if [ "${GENERAL}" -eq 0 ] && [ -z "${RECORD_ID}" ]; then
    RECORD_ID=$(soql "SELECT Id FROM awsapn__ACE_Opportunity__c WHERE awsapn__APN_CRM_Id__c != null ORDER BY LastModifiedDate DESC LIMIT 1" \
        | python3 -c 'import json,sys; rows=json.load(sys.stdin); print(rows[0]["Id"] if rows else "")')
    if [ -z "${RECORD_ID}" ]; then
        GENERAL=1
        info "no ACE Opportunity found (or no connector) — using general-chat (record-less) mode"
    fi
fi

if [ "${GENERAL}" -eq 1 ]; then
    info "mode            : general-chat (record-less)"
else
    info "mode            : record-aware"
    info "record id       : ${RECORD_ID}"
fi

export SMOKE_RECORD_ID="${RECORD_ID}"
export SMOKE_MESSAGE="${MESSAGE}"
export SMOKE_REJECT_MESSAGE="${REJECT_MESSAGE}"

# 1. Permission set assignment on the running user (the one sf CLI uses).
pset=$(soql "SELECT PermissionSet.Name FROM PermissionSetAssignment WHERE PermissionSet.Name = 'Partner_Central_Chat_Agent_User' AND Assignee.Username = '$(sf org display --target-org ${TARGET_ORG} --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["username"])')' LIMIT 1")
if [ "${pset}" = "[]" ]; then
    fail "The running user is NOT assigned the Partner_Central_Chat_Agent_User permission set. Assign it and rerun."
else
    pass "Permission set Partner_Central_Chat_Agent_User is assigned"
fi

# 2. Config + connector detect + client DTO round-trip
info "running tier-1 anon apex..."
if [ "${GENERAL}" -eq 1 ]; then
    run_anon "${APEX_DIR}/tier1_general.apex"
    pass "ConfigProvider / SessionManager / getClientConfig round-trip succeeded (general-chat)"
else
    run_anon "${APEX_DIR}/tier1_config_and_session.apex"
    pass "ConfigProvider / SessionManager / getRecordContext round-trip succeeded"
fi

# 3. Recent audit log sanity — ok to be empty on a fresh org, but if
#    rows exist they should include at least one non-5xx status.
recent_count=$(soql "SELECT COUNT(Id) c FROM Audit_Log__c WHERE CreatedDate = LAST_N_DAYS:1" \
    | python3 -c 'import json,sys; rows=json.load(sys.stdin); print(rows[0]["c"] if rows else 0)')
info "audit log rows (last 24h): ${recent_count}"
if [ "${recent_count}" -gt 0 ]; then
    latest_audit=$(soql "SELECT Http_Status__c, Mcp_Method__c, Session_Id__c FROM Audit_Log__c ORDER BY CreatedDate DESC LIMIT 1")
    info "most recent audit row: ${latest_audit}"
fi

if [ $LIVE -eq 0 ]; then
    pass "Tier 1 complete. Pass --live to exercise the MCP server."
    exit 0
fi

# -----------------------------------------------------------------------------
# Tier 2: live read-only sendMessage turn
# -----------------------------------------------------------------------------
hdr "Tier 2 / live sendMessage"

if [ "${GENERAL}" -eq 1 ]; then
    info "sending a read-only general-chat prompt (no record context)..."
    run_anon "${APEX_DIR}/tier2_general.apex"
else
    info "sending: \"${MESSAGE}\""
    run_anon "${APEX_DIR}/tier2_live_submit.apex"
fi
pass "Live sendMessage round-trip completed without a structured error"

# Post-callout check: the turn should have produced one Audit_Log__c row
# with a 200 status and a captured Session_Id.
latest=$(soql "SELECT Id, Http_Status__c, Session_Id__c, Mcp_Method__c FROM Audit_Log__c ORDER BY CreatedDate DESC LIMIT 1")
info "latest audit log row: ${latest}"

# -----------------------------------------------------------------------------
# Attachment: real S3 upload + document round-trip (opt-in via --attach)
# -----------------------------------------------------------------------------
if [ $ATTACH -eq 1 ]; then
    hdr "Attachment / S3 upload + document round-trip"
    info "uploading a small test document, then asking the agent to read it..."
    info "(skips cleanly if AWS_Partner_Central_S3 / Aws_Account_Id__c are unset)"
    run_anon "${APEX_DIR}/tier_attachment.apex"
    pass "Attachment tier completed (uploaded + sent, or cleanly skipped if S3 unconfigured)"
fi

if [ $APPROVE -eq 0 ]; then
    pass "Tier 2 complete. Pass --approve to exercise the approval plumbing (auto-rejects)."
    exit 0
fi

# -----------------------------------------------------------------------------
# Tier 3: approval round-trip (auto-rejects so nothing commits)
# -----------------------------------------------------------------------------
hdr "Tier 3 / approval round-trip (auto-rejecting)"

info "step 3a — submit write request, register pending operation..."
if [ "${GENERAL}" -eq 1 ]; then
    info "(general-chat: no anchored record, so this may yield no pending op)"
    run_anon "${APEX_DIR}/tier3a_general.apex"
else
    info "asking for a write that requires approval: \"${REJECT_MESSAGE}\""
    run_anon "${APEX_DIR}/tier3a_submit_write.apex"
fi

info "step 3b — reject the pending operation (fresh transaction)..."
run_anon "${APEX_DIR}/tier3b_reject.apex"
pass "Approval round-trip completed; any pending operation was rejected"

# Verify the pending row is in the 'cancelled' state with decision='rejected'.
pending=$(soql "SELECT Status__c, Decision__c, Operation_Name__c FROM Pending_Write_Operation__c WHERE CreatedDate = LAST_N_DAYS:1 ORDER BY CreatedDate DESC LIMIT 1")
info "latest pending op: ${pending}"

pass "All smoke-test tiers passed."
