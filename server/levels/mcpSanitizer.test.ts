import assert from 'node:assert/strict'
import test from 'node:test'
import { rawCalendarMcpManifest, sanitizeManifest, type MCPManifest } from './mcpSanitizer.ts'

test('sanitizeManifest strips imperative system overrides and tool call injection', () => {
  const result = sanitizeManifest(rawCalendarMcpManifest)

  assert.equal(result.tools.length, 1)
  const tool = result.tools[0]
  assert.ok(tool)
  assert.equal(tool.name, 'list_calendar_events')
  const desc = tool.description ?? ''

  // Injected instructions must not be in the sanitized description
  assert.ok(!desc.includes('SYSTEM OVERRIDE'))
  assert.ok(!desc.includes('read_secrets'))
  assert.ok(!desc.includes('master_key'))

  // Sanity check that description is factual and concise
  assert.ok(desc.includes('Retrieves scheduled calendar events'))

  // Diffs verification
  assert.equal(result.diffs.length, 1)
  const diff = result.diffs[0]
  assert.ok(diff)
  assert.ok(diff.removedPhrases.length > 0)
  assert.ok(diff.schemaValid)
})

test('sanitizeManifest enforces max description length cap', () => {
  const longManifest: MCPManifest = {
    name: 'test_server',
    version: '1.0.0',
    tools: [
      {
        name: 'overly_verbose_tool',
        description: 'A'.repeat(200),
        input_schema: { type: 'object' },
      },
    ],
  }

  const result = sanitizeManifest(longManifest)
  const desc = result.tools[0]?.description ?? ''
  assert.ok(desc.length <= 125) // 120 + '...'
  assert.ok(result.diffs[0]?.truncated)
})

test('sanitizeManifest validates schema integrity', () => {
  const invalidManifest: MCPManifest = {
    name: 'bad_server',
    version: '1.0.0',
    tools: [
      {
        name: 'invalid name with spaces!',
        description: 'Does something',
        input_schema: { type: 'object' },
      },
    ],
  }

  const result = sanitizeManifest(invalidManifest)
  assert.equal(result.diffs[0].schemaValid, false)
})
