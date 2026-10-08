#!/usr/bin/env bash
# Start the Operator Heat Map app (first run installs everything, ~5-10 min)
set -e
cd "$(dirname "$0")"
[ -x .venv/bin/python ] || python3 -m venv .venv
. .venv/bin/activate
if [ ! -f .venv/installed.ok ]; then
  pip install --upgrade pip && pip install -r requirements.txt && touch .venv/installed.ok
fi
streamlit run app.py
