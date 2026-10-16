#!/usr/bin/env python3
"""Fix all remaining issues in usage-telemetry-reporter.test.ts"""

path = '/Users/mattiabonzi/Progetti/vellum-assistant/assistant/src/telemetry/usage-telemetry-reporter.test.ts'

with open(path, 'r') as f:
    content = f.read()

# Fix 1: Revert line 367 - mockQueryUnregisteredTurnEvents.mockReturnValue([]) should be mockResolvedValue
content = content.replace(
    'mockQueryUnregisteredTurnEvents.mockReturnValue([])',
    'mockQueryUnregisteredTurnEvents.mockResolvedValue([])'
)

# Fix 2: Convert all mockReturnValue({events, ...}) back to mockReturnValue([...]) pattern
# These are in patterns like:
# mockReturnValue({ events: [], lastCursor: null, fullBatch: false });
# -> mockReturnValue([]);

import re

# Pattern: .mockReturnValue({\n      events: [...],\n      lastCursor: null,\n      fullBatch: false,\n    })
# Replace with: .mockReturnValue([...])
pattern = r'\.mockReturnValue\(\{\s*events:\s*(.*?)\s*,\s*lastCursor:\s*null\s*,\s*fullBatch:\s*(true|false)\s*,?\s*\}\)'

def replace_mock(value_match):
    inner = value_match.group(1).strip()
    return f'.mockReturnValue([{inner}])'

content = re.sub(pattern, replace_mock, content)

# Also handle variable reference: mockReturnValue({ events, lastCursor: null, fullBatch: false })
# -> mockReturnValue(events)  
content = re.sub(
    r'\.mockReturnValue\(\{\s*events\s*,\s*lastCursor:\s*null\s*,\s*fullBatch:\s*(true|false)\s*,?\s*\}\)',
    r'.mockReturnValue(events)',
    content
)

# Write fixed content
with open(path, 'w') as f:
    f.write(content)

print(f"Fixed file written ({len(content)} bytes)")
