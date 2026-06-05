# scripts/ — HubSpot custom-property provisioners

One-time (idempotent) scripts that create the HubSpot deal properties the integration depends on. Run them after `./infra/deploy.sh` and `./infra/set-secrets.sh` have populated AWS Secrets Manager.

| Script | What it creates |
|--------|-----------------|
| `check-prereqs.sh` / `check-prereqs.ps1` | **Prerequisite checker** (macOS/Linux + Windows). Verifies Node / AWS CLI / HubSpot CLI / Git / Python versions; `--install` / `-Install` installs anything missing. Run before starting either workshop. |
| `setup-hubspot-properties.sh` | **Wrapper** — runs all five provisioning steps in order. Use this for first-time setup. |
| `setup_ace_picklists.py` | ~15 picklist properties (industry, currency, opportunity type, primary need, marketing source, sales activities, …) |
| `setup_ace_bidirectional_fields.py` | Bidirectionally editable freeform / picklist fields (involvement type, visibility, AWS account ID, address, additional comments, …) plus four read-only AWS-side mirrors |
| `setup_ace_solutions.py` | The `ace_solutions` multi-picklist, populated from your ACE solutions catalog |
| `seed-aws-products-picklist.py` | The `ace_aws_products` multi-checkbox picklist, populated from `aws-samples/partner-crm-integration-samples` |
| `create-test-deal.py` | Idempotent helper that creates (or updates) a HubSpot deal pre-populated with everything the Share Lambda needs to pass preconditions. Used by the workshop to bootstrap a fresh test account. |

All scripts read the HubSpot Private App token from AWS Secrets Manager via the shared helper `_hubspot_token.py`.

## Configuration

| Env var               | Default                  | Purpose |
|-----------------------|--------------------------|---------|
| `ACE_SHARE_SECRET_ID` | `crm-connector/ace-share` | Secrets Manager secret holding `HUBSPOT_PRIVATE_APP_TOKEN` |
| `AWS_PROFILE`         | AWS CLI default          | which AWS profile to use |
| `AWS_REGION`          | `us-east-1`              | which region the secret lives in |

If you deploy under a different stack name or secret name, point at it:

```bash
export ACE_SHARE_SECRET_ID=my-stack/my-secret
export AWS_PROFILE=my-profile
```

## Usage

For first-time setup, use the wrapper — it runs every step in order and downloads the AWS Products CSV automatically:

```bash
./scripts/setup-hubspot-properties.sh --profile my-aws-profile
```

If you only need to re-run a subset (e.g. you added an industry option), invoke the relevant script directly:

```bash
python3 scripts/setup_ace_picklists.py
python3 scripts/setup_ace_bidirectional_fields.py
python3 scripts/setup_ace_solutions.py
CSV_PATH=/tmp/SampleAWSProducts.csv python3 scripts/seed-aws-products-picklist.py
```

Every script is idempotent — re-running them is safe. Existing deal property values in HubSpot are never touched; only the property definitions and picklist option lists are reconciled.

## Adding a new picklist option

If you want to add a new option to one of the picklists (e.g. an extra industry), edit the relevant constant in the corresponding script and re-run it. The new option appears in HubSpot within seconds; existing deal values are preserved.
