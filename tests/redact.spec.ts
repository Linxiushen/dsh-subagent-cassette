import { describe, expect, it } from 'vitest'
import { redactJson } from '../src/redact.ts'

describe('default redaction coverage', () => {
  it('normalizes common structured credential field names', () => {
    const redacted = redactJson({
      openai_api_key: 'opaque-openai-key',
      access_token: 'opaque-access-token',
      clientSecret: 'opaque-client-secret',
      nested: {
        AZURE_OPENAI_API_KEY: 'opaque-azure-key',
        oauthRefreshToken: 'opaque-refresh-token',
      },
    })

    expect(redacted).toEqual({
      value: {
        openai_api_key: '[REDACTED]',
        access_token: '[REDACTED]',
        clientSecret: '[REDACTED]',
        nested: {
          AZURE_OPENAI_API_KEY: '[REDACTED]',
          oauthRefreshToken: '[REDACTED]',
        },
      },
      count: 5,
    })
  })

  it('redacts standard sk token families in free-form text', () => {
    const tokens = [
      'sk-0123456789abcdef',
      'sk-proj-0123456789abcdef',
      'sk-ant-api03-0123456789abcdef',
      'sk_0123456789abcdef',
    ]
    const redacted = redactJson(tokens.join(' | '))

    expect(redacted.count).toBe(tokens.length)
    for (const token of tokens) expect(redacted.value).not.toContain(token)
    expect(redacted.value).toBe(tokens.map(() => '[REDACTED]').join(' | '))
  })

  it('redacts normalized credential assignments in free-form config text', () => {
    const redacted = redactJson(
      'openai_api_key="opaque-openai" access_token=opaque-access clientSecret: opaque-client',
    )

    expect(redacted.count).toBe(3)
    expect(redacted.value).not.toContain('opaque-openai')
    expect(redacted.value).not.toContain('opaque-access')
    expect(redacted.value).not.toContain('opaque-client')
  })

  it('does not treat descriptive metadata or short sk labels as credentials', () => {
    const value = {
      tokenCount: 128,
      secretQuestion: 'first school',
      apiKeyLabel: 'staging',
      clientSecretHint: 'ends in 1234',
      note: 'Use sk-short in the documentation example.',
    }

    expect(redactJson(value)).toEqual({ value, count: 0 })
  })
})
