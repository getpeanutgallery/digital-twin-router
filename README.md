# digital-twin-router

Router/interceptor wrapper for integrating digital twin recording and replay with AI provider and emotion-engine transports.

## Features

- **Transport Wrapper**: Wrap any async transport function to enable recording and replay.
- **Multiple Modes**: `replay`, `record`, and `off` modes controlled by `DIGITAL_TWIN_MODE` env var.
- **Flexible Cassette Loading**: Load cassettes from local filesystem paths or installed npm packages.
- **Strict Matching**: Uses `digital-twin-core`'s stable SHA-256 hashing for exact request matching.
- **Clear Errors**: Detailed error messages on cache misses showing computed hash and available interactions.
- **Recorded Failure Refs**: Recorded error payloads include stable `recordedFailure` cassette refs (`cassetteName`, `cassettePath`, entry `interactionId`, request hash) so upstream recovery artifacts can point back to replay-safe interactions.
- **Provider Failure Fidelity**: Recorded/replayed errors preserve `providerRequest`, `providerResponse`, `provider`, `failureCategory`, `failureCode`, `retryable`, request ids, and normalized debug metadata emitted by `ai-providers`.

## Installation

Canonical polyrepo installs should use the published repo dependency via `git+ssh` (matching the sibling repos in this workspace):

```json
{
  "dependencies": {
    "digital-twin-router": "git+ssh://git@github.com/getpeanutgallery/digital-twin-router.git#main",
    "digital-twin-core": "git+ssh://git@github.com/getpeanutgallery/digital-twin-core.git#main"
  }
}
```

For local development across sibling checkouts, point runtime config or test env at local pack paths (for example `DIGITAL_TWIN_PACK=../digital-twin-emotion-engine-providers`) rather than committing `file:` dependencies back into package manifests.

## Quick Start

```javascript
const { createTwinTransport } = require('digital-twin-router');

// Your actual transport (e.g., HTTP client, AI provider API)
async function realTransport(request) {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(request.body)
  });
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: await response.json()
  };
}

const transport = createTwinTransport({
  mode: process.env.DIGITAL_TWIN_MODE || 'off',
  twinPack: './cassettes',
  realTransport
});

const response = await transport.complete({
  method: 'GET',
  url: 'https://api.example.com/users',
  headers: { 'Content-Type': 'application/json' },
  body: null
});
```

## API

### `createTwinTransport(options)`

**Options:**

| Option | Type | Description |
|--------|------|-------------|
| `mode` | `string` (optional) | `'replay'`, `'record'`, `'off'`. Defaults based on `NODE_ENV` (test → replay) unless overridden. |
| `twinPack` | `string` (required) | Path to a twin pack dir (local or npm package). Supports `manifest.json` + `defaultCassetteId`. Auto-detects `cassettes/` subdir. |
| `realTransport` | `Function` | Async `(request) => response` used in record/off modes. |
| `engineOptions` | `Object` | Passed to `TwinEngine` (e.g., `normalizerOptions`). |

**Returns:** object with `complete(request)` plus debug helpers.

When `complete(request)` replays or records a transport failure, the thrown error may include additive metadata restored from the cassette, including:

- `requestId`
- `provider`, `failureCategory`, `failureCode`, `retryable`
- `providerRequest`, `providerResponse`
- `recordedFailure` with stable cassette/interaction refs for upstream recovery artifacts

### `resolveTwinPack(twinPack)`

Resolves a `twinPack` value to an absolute filesystem path.

## Environment Variables

| Variable | Effect |
|----------|--------|
| `DIGITAL_TWIN_MODE` | Force mode: `replay`, `record`, `off` |
| `DIGITAL_TWIN_PACK` | Pack path (typically set by tests) |
| `DIGITAL_TWIN_CASSETTE` | Select cassette id/name (overrides manifest default) |
| `NODE_ENV` | When `test`, defaults to replay if mode not explicitly set |

## Testing

```bash
npm test
```

## License

MIT
