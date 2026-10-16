#!/usr/bin/env python3
import re

path = '/Users/mattiabonzi/Progetti/vellum-assistant/assistant/src/telemetry/usage-telemetry-reporter.test.ts'

with open(path, 'r') as f:
    content = f.read()

# Fix all mock calls that wrap values in {events, lastCursor, fullBatch}
# Pattern 1: .mockReturnValue({ events: [...], lastCursor: null, fullBatch: false });
#            -> .mockReturnValue([...])
content = re.sub(
    r'\.mockReturnValue\(\{\s*events:\s*(.*?)\s*,\s*lastCursor:\s*null\s*,\s*fullBatch:\s*\w+\s*\}\)',
    lambda m: f'.mockReturnValue([{m.group(1).strip()}])',
    content
)

# Pattern 2: .mockResolvedValue({ events: [...], lastCursor: null, fullBatch: false });
#            -> .mockResolvedValue([:])
content = re.sub(
    r'\.mockResolvedValue\(\{\s*events:\s*(.*?)\s*,\s*lastCursor:\s*null\s*,\s*fullBatch:\s*\w+\s*\}\)',
    lambda m: f'.mockResolvedValue([{m.group(1).strip()}])',
    content
)

# Pattern 3: Variable reference like { events, lastCursor: null, fullBatch: false }
#            -> events
content = re.sub(
    r'\.(?:mock)?(?:Resolved)?Value\(\{\s*events\s*,\s*lastCursor:\s*null\s*,\s*fullBatch:\s*\w+\s*\}\)',
    lambda m: '.mockReturnValue(events)' if 'MockCalledWith' not in m else '.mockReturnValue(events)',
    content
)

with open(path, 'w') as f:
    f.write(content)
print("Done")
