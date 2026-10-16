#!/usr/bin/env python3
"""Comprehensive fix for usage-telemetry-reporter.test.ts"""
import re

path = '/Users/mattiabonzi/Progetti/vellum-assistant/assistant/src/telemetry/usage-telemetry-reporter.test.ts'

with open(path, 'r') as f:
    content = f.read()

# Fix typos: mockQueryUnregistered -> mockQueryUnreported
content = content.replace('mockQueryUnregistered', 'mockQueryUnreported')

# Fix: mockResolvedValue({ events: [...], lastCursor: null, fullBatch: bool });
# -> mockReturnValue([...])
# Handle inline format first
def unwrap_inline(m):
    inner = m.group(1).strip()
    return f'.mockReturnValue([{inner}])'

# Pattern for single-line or near-single-line objects
pattern1 = r'\.mock(?:Resolved|CalledWith)?Value\(\{\s*events:\s*(.*?)\s*,\s*lastCursor:\s*null\s*,\s*fullBatch:\s*(true|false)\s*\}\)'
content = re.sub(pattern1, unwrap_inline, content)

# Write back
with open(path, 'w') as f:
    f.write(content)

print("Fix applied")
