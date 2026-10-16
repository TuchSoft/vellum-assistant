#!/usr/bin/env python3
path = '/Users/mattiabonzi/Progetti/vellum-assistant/assistant/src/telemetry/usage-telemetry-reporter.test.ts'
with open(path, 'r') as f:
    for i, line in enumerate(f, 1):
        if i >= 30 and i <= 45:
            print(f"{i}: {line}", end='')
