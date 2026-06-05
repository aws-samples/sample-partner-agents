# Contributing to HubSpot AWS Pipeline Sync

Thanks for your interest in contributing! This guide will help you get started.

## Getting Started

1. **Fork** the repository
2. **Clone** your fork locally
3. **Create a branch** for your change (`git checkout -b my-feature`)
4. **Install** dependencies: `pip install -e ".[dev]"`
5. **Make your changes**
6. **Run checks** before committing (see below)
7. **Push** your branch and open a **Pull Request**

## Development Setup

```bash
# Clone your fork
git clone https://github.com/<your-username>/hubspot-crm-pcagent-integration.git
cd hubspot-aws-pipeline-sync

# Create a virtual environment
python -m venv .venv
source .venv/bin/activate

# Install with dev dependencies
pip install -e ".[dev]"

# Create a .env file for the Python provisioning CLI
# Set HUBSPOT_API_KEY to your HubSpot Private App token.
# Alternatively, scripts/get-hubspot-token.sh pulls the token from Secrets Manager.
echo 'HUBSPOT_API_KEY=pat-eu1-...' > .env
```

## Running Checks

All of these must pass before your PR can be merged:

```bash
# Format code
black src/ tests/
isort src/ tests/

# Lint
flake8 src/ tests/

# Test
pytest -v
```

## Pull Request Guidelines

- **One PR per feature/fix** — keep changes focused
- **Write tests** for new functionality
- **Update docs** if you change behavior (README, .env, relevant sub-package README)
- **Follow existing code style** — black + isort handle formatting, flake8 handles linting
- **Describe your changes** in the PR description — what and why

## Branch Protection

The `main` branch is protected:
- All PRs require passing CI (lint + tests)
- At least 1 approving review is required
- Direct pushes to `main` are not allowed

## Reporting Issues

- Use [GitHub Issues](https://github.com/your-org/hubspot-crm-pcagent-integration/issues)
- Include steps to reproduce, expected vs actual behavior
- For security issues, please email directly instead of opening a public issue

## Code of Conduct

Be respectful and constructive. We're all here to build something useful.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
