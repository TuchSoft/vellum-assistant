#!/bin/bash
export PATH="$HOME/.bun/bin:$PATH"
python3 /Users/mattiabonzi/Progetti/vellum-assistant/fix_test.py > /tmp/py_output.txt 2>&1
echo "PY_EXIT=$?" >> /tmp/py_output.txt
echo "=== After fix ===" >> /tmp/py_output.txt
wc -l /Users/mattiabonzi/Progetti/vellum-assistant/assistant/src/telemetry/usage-telemetry-reporter.test.ts >> /tmp/py_output.txt 2>&1
