#!/usr/bin/env python3
import re

path = '/Users/mattiabonzi/Progetti/vellum-assistant/assistant/src/telemetry/usage-telemetry-reporter.test.ts'

with open(path, 'r') as f:
    lines = f.readlines()

new_lines = []
i = 0

while i < len(lines):
    line = lines[i]
    
    # Fix mockQueryUnreportedUsageEvents declaration
    if 'const mockQueryUnreportedUsageEvents = mock<' in line and 'Promise<TelemetryEventSourceBatch>' in line:
        new_lines.append('const mockQueryUnreportedUsageEvents = mock<\n')
        new_lines.append(
            '  () => ReturnType<typeof import("../persistence/llm-usage-store.js").queryUnreportedUsageEvents>,\n'
        )
        new_lines.append('  () => [],\n')
        new_lines.append(');\n')
        i += 1
        while i < len(lines) and ');' not in lines[i]:
            i += 1
        i += 1
        continue
    
    # Fix mockQueryUnreportedTurnEvents declaration
    if 'const mockQueryUnreportedTurnEvents = mock<' in line and 'Promise<TelemetryEventSourceBatch>' in line:
        new_lines.append('const mockQueryUnreportedTurnEvents = mock<\n')
        new_lines.append('  () => Promise<{\n')
        for prop in [
            'id: string;',
            'createdAt: number;',
            'conversationId: string;',
            'conversationType: string;',
            'turnIndex: number;',
            'interfaceId: string | null;',
            'channelId: string | null;',
            'clientMetadata: string | null;',
            'outcome?: string | null;',
            'batchedInto?: string | null;',
            'failureCode?: string | null;',
        ]:
            new_lines.append('    ' + prop + '\n')
        new_lines.append('  }[]>>(\n')
        new_lines.append('  () => Promise.resolve([]),\n')
        new_lines.append(');\n')
        i += 1
        while i < len(lines) and ');' not in lines[i]:
            i += 1
        i += 1
        continue
        
    new_lines.append(line)
    i += 1

with open(path, 'w') as f:
    f.writelines(new_lines)

print(f"File written with {len(new_lines)} lines")
