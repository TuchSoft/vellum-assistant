#!/bin/bash
export PATH="$HOME/.bun/bin:$PATH"
cd /Users/mattiabonzi/Progetti/vellum-assistant/assistant
echo "=== BEFORE ===" > /tmp/status.txt
wc -l src/telemetry/usage-telemetry-reporter.test.ts >> /tmp/status.txt 2>&1
echo "=== RUNNING PRETTIER ===" >> /tmp/status.txt
bunx --yes prettier --write src/telemetry/usage-telemetry-reporter.test.ts >> /tmp/status.txt 2>&1
echo "=== EXIT: $? ===" >> /tmp/status.txt
echo "=== RUNNING ESLINT ===" >> /tmp/status.txt
bunx --yes eslint --fix src/telemetry/usage-telemetry-reporter.test.ts >> /tmp/lint.txt 2>&1
echo "=== ESLINT EXIT: $? ===" >> /tmp/lint.txt
echo "=== RUNNING TYPECHECK ===" >> /tmp/status.txt
bunx --yes tsc --noEmit 2>&1 | grep "usage-telemetry-reporter" > /tmp/tsc.txt
echo "=== TSC ERRORS: $(wc -l < /tmp/tsc.txt) ===" >> /tmp/status.txt
