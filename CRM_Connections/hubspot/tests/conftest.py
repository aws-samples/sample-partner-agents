"""Test fixtures for the HubSpot provisioning CLI tests."""

import os
import sys
from pathlib import Path

# Add parent of src to path so 'from src import ...' works
project_root = Path(__file__).parent.parent
if str(project_root) not in sys.path:
    sys.path.insert(0, str(project_root))

# `src/main.py` calls `load_dotenv` at import-time and the HubSpotClient
# constructor demands `HUBSPOT_API_KEY`. Tests always patch the client,
# but the import path still resolves through the constructor's
# default-config check, so seed a dummy value.
if not os.getenv("HUBSPOT_API_KEY"):
    os.environ["HUBSPOT_API_KEY"] = "test-api-key-12345"
