#!/usr/bin/env bash
#
# Workshop prerequisite checker / installer for macOS and Linux.
#
# Verifies every tool the HubSpot ↔ AWS Partner Central workshops need,
# prints a status table, and (with --install) installs anything missing
# via Homebrew (macOS) or the system package manager (Linux).
#
# Usage:
#   ./scripts/check-prereqs.sh             # check only, report status
#   ./scripts/check-prereqs.sh --install   # check, then install missing
#   ./scripts/check-prereqs.sh --agent     # agent workshop (skips Python)
#   ./scripts/check-prereqs.sh -h          # help
#
# Exit code: 0 if all required tools satisfied, 1 if any are missing
# (in check-only mode) or if an install failed.

set -uo pipefail

INSTALL=false
AGENT_ONLY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install) INSTALL=true; shift ;;
    --agent)   AGENT_ONLY=true; shift ;;
    -h|--help) sed -n '3,18p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

# ---- platform + package manager detection -----------------------------------
OS="$(uname -s)"
PKG=""          # how we install: brew | apt | dnf | none
case "${OS}" in
  Darwin)
    if command -v brew >/dev/null 2>&1; then PKG="brew"; fi
    ;;
  Linux)
    if command -v apt-get >/dev/null 2>&1; then PKG="apt"
    elif command -v dnf >/dev/null 2>&1; then PKG="dnf"
    fi
    ;;
esac

# ANSI colours (fall back to plain if not a tty)
if [[ -t 1 ]]; then
  GREEN=$'\033[32m'; RED=$'\033[31m'; YEL=$'\033[33m'; DIM=$'\033[2m'; RST=$'\033[0m'
else
  GREEN=""; RED=""; YEL=""; DIM=""; RST=""
fi

MISSING=()      # tool keys that are absent or too old

# ---- version helpers --------------------------------------------------------
# ver_ge A B  ->  true if version A >= version B (dotted numeric compare)
ver_ge() {
  # shellcheck disable=SC2046
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -t. -k1,1n -k2,2n -k3,3n | head -1)" = "$2" ]
}

# extract first dotted-number token (e.g. "v22.1.0" -> "22.1.0")
extract_ver() {
  echo "$1" | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1
}

row() {
  # row <label> <status-symbol> <detail>
  printf "  %-16s %s %s\n" "$1" "$2" "$3"
}

check_tool() {
  # check_tool <key> <label> <cmd> <version-flag> <min-version> <required:yes|no>
  local key="$1" label="$2" cmd="$3" vflag="$4" minv="$5" req="$6"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    row "${label}" "${RED}✗${RST}" "not found${req:+ ${DIM}(${req})${RST}}"
    [[ "${req}" == "required" ]] && MISSING+=("${key}")
    return
  fi
  local raw cur
  raw="$("$cmd" $vflag 2>&1 | head -3)"
  cur="$(extract_ver "$raw")"
  if [[ -z "${minv}" || -z "${cur}" ]]; then
    row "${label}" "${GREEN}✓${RST}" "${cur:-installed}"
    return
  fi
  if ver_ge "${cur}" "${minv}"; then
    row "${label}" "${GREEN}✓${RST}" "${cur} ${DIM}(>= ${minv})${RST}"
  else
    row "${label}" "${YEL}⚠${RST}" "${cur} ${DIM}(need >= ${minv})${RST}"
    [[ "${req}" == "required" ]] && MISSING+=("${key}")
  fi
}

echo
echo "=== Workshop prerequisite check (${OS}) ==="
echo "Package manager: ${PKG:-none detected}"
echo

check_tool node   "Node.js"     node   --version  22     required
check_tool npm    "npm"         npm    --version  ""     required
check_tool aws    "AWS CLI"     aws    --version  2.15   required
check_tool git    "Git"         git    --version  ""     required
check_tool hs     "HubSpot CLI" hs     --version  8.6    required
check_tool zip    "zip"         zip    -v         ""     required
check_tool shasum "shasum"      shasum -v         ""     required
if ! "${AGENT_ONLY}"; then
  check_tool python3 "Python 3" python3 --version 3.11   required
fi

echo
if [[ ${#MISSING[@]} -eq 0 ]]; then
  echo "${GREEN}All required tools satisfied.${RST}"
  echo
  exit 0
fi

echo "${YEL}Missing or outdated:${RST} ${MISSING[*]}"
echo

if ! "${INSTALL}"; then
  echo "Re-run with ${DIM}--install${RST} to install the missing tools,"
  echo "or install them manually (see docs/workshop.md § 0)."
  echo
  exit 1
fi

# ---- install path -----------------------------------------------------------
if [[ -z "${PKG}" ]]; then
  if [[ "${OS}" == "Darwin" ]]; then
    echo "${RED}Homebrew not found.${RST} Install it first:"
    echo '  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
    echo "then re-run this script with --install."
  else
    echo "${RED}No supported package manager (apt/dnf) detected.${RST}"
    echo "Install the missing tools manually (see docs/workshop.md § 0)."
  fi
  exit 1
fi

# npm/shasum/zip are bundled with node / base OS — map tool keys to packages.
brew_pkg() {
  case "$1" in
    node) echo "node@22" ;;
    aws)  echo "awscli" ;;
    git)  echo "git" ;;
    hs)   echo "" ;;     # hs installs via npm, handled below
    python3) echo "python@3.11" ;;
    *) echo "" ;;
  esac
}
apt_pkg() {
  case "$1" in
    node) echo "nodejs" ;;        # see NodeSource note below
    aws)  echo "awscli" ;;
    git)  echo "git" ;;
    zip)  echo "zip" ;;
    python3) echo "python3" ;;
    *) echo "" ;;
  esac
}

echo "=== Installing missing tools via ${PKG} ==="
FAILED=()
for key in "${MISSING[@]}"; do
  case "${PKG}" in
    brew)
      if [[ "${key}" == "hs" || "${key}" == "npm" ]]; then
        # HubSpot CLI + npm come from node; ensure node first, then npm i -g.
        if [[ "${key}" == "hs" ]]; then
          echo "  → npm i -g @hubspot/cli@latest"
          npm i -g @hubspot/cli@latest || FAILED+=("hs")
        fi
        continue
      fi
      pkg="$(brew_pkg "${key}")"
      [[ -z "${pkg}" ]] && continue
      echo "  → brew install ${pkg}"
      brew install "${pkg}" || FAILED+=("${key}")
      # Homebrew keeps versioned node keg-only; link it.
      [[ "${key}" == "node" ]] && brew link --overwrite --force node@22 2>/dev/null || true
      ;;
    apt)
      if [[ "${key}" == "hs" ]]; then
        echo "  → npm i -g @hubspot/cli@latest"; npm i -g @hubspot/cli@latest || FAILED+=("hs"); continue
      fi
      pkg="$(apt_pkg "${key}")"; [[ -z "${pkg}" ]] && continue
      echo "  → sudo apt-get install -y ${pkg}"
      sudo apt-get update -qq && sudo apt-get install -y "${pkg}" || FAILED+=("${key}")
      ;;
    dnf)
      if [[ "${key}" == "hs" ]]; then
        echo "  → npm i -g @hubspot/cli@latest"; npm i -g @hubspot/cli@latest || FAILED+=("hs"); continue
      fi
      echo "  → sudo dnf install -y ${key}"
      sudo dnf install -y "${key}" || FAILED+=("${key}")
      ;;
  esac
done

echo
if [[ ${#FAILED[@]} -eq 0 ]]; then
  echo "${GREEN}Install complete.${RST} Re-run without --install to verify."
  echo
  exit 0
fi
echo "${RED}Some installs failed:${RST} ${FAILED[*]}"
echo "Install those manually — see docs/workshop.md § 0."
echo
exit 1
