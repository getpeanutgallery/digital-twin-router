# digital-twin-router

Router/interceptor wrapper for integrating digital twin recording and replay with AI provider and emotion-engine transports.

## Features

- **Transport Wrapper**: Wrap any async transport function to enable recording and replay.
- **Multiple Modes**: `replay`, `record`, and `off` modes controlled by `DIGITAL_TWIN_MODE` env var.
- **Flexible Cassette Loading**: Load cassettes from local filesystem paths or installed npm packages.
- **Strict Matching**: Uses `digital-twin-core`'s stable SHA-256 hashing for exact request matching.
- **Clear Errors**: Detailed error messages on cache misses showing computed hash and available interactions.

## Installation

Since this package depends on `digital-twin-core` which may be local, use a file dependency:

```json
{
  "dependencies": {
    "digital-twin-router": "file:../digital-twin-router",
    "digital-twin-core": "file:../digital-twin-core"
  }
}
```

Or install directly if published:

```bash
npm install digital-twin-router
```

## Quick Start

```javascript
const { createTwinTransport } = require('digital-twin-router');

// Your actual transport (e.g., HTTP client, AI provider API)
async function realTransport(request) {
  // request: { method, url, headers, body }
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

// Create wrapped transport
const transport = createTwinTransport({
  mode: process.env.DIGITAL_TWIN_MODE || 'off',
  twinPack: './cassettes',  // or package name like 'my-cassettes'
  realTransport: realTransport
});

// Use it
const response = await transport.complete({
  method: 'GET',
  url: 'https://api.example.com/users',
  headers: { 'Content-Type': 'application/json' },
  body: null
});
```

## API

### `createTwinTransport(options)`

Factory function that creates a transport wrapper.

**Options:**

| Option | Type | Description |
|--------|------|-------------|
| `mode` | `string` (optional) | One of: `'replay'`, `'record'`, `'off'`. If not provided, defaults based on `NODE_ENV` (test → replay) or `DIGITAL_TWIN_MODE` env var. |
| `twinPack` | `string` (required) | Path to a directory containing cassette JSON files, or an installed npm package name that contains a `cassettes/` directory. |
| `realTransport` | `Function` (required for non-replay modes) | Async function `(request) => Promise<response>` that performs actual network or external calls. |
| `engineOptions` | `Object` (optional) | Additional options passed to `TwinEngine` (e.g., `normalizerOptions`, `redactionPatterns`). |

**Returns:** An object with:

- `complete(request)`: Async function that processes the request according to mode and returns a response.
- `getMode()`: Returns the active mode.
- `getCassetteName()`: Returns the cassette name derived from `twinPack`.
- `getStorePath()`: Returns the resolved absolute path to the store.
- `getEngine()`: Returns the underlying `TwinEngine` instance.
- `getStore()`: Returns the underlying `TwinStore` instance.

### `resolveTwinPack(twinPack)`

Resolves a `twinPack` value to an absolute filesystem path.

- If `twinPack` is an existing path (absolute or relative), returns the resolved absolute path.
- If `twinPack` is a package name, attempts `require.resolve()` and returns the package directory.
- Throws if resolution fails.

## Modes

### `replay`

- Looks up the request in the cassette store.
- On hit: returns the recorded response.
- On miss: throws an error showing the computed hash and listing available interactions.

**Use case:** Deterministic testing using recorded interactions. CI environments.

### `record`

- Calls `realTransport` to perform the actual request.
- Saves the request/response pair to the cassette store.
- Returns the live response.

**Use case:** Creating/updating cassettes for future replay.

### `off`

- Bypasses the twin system entirely.
- Just calls `realTransport` and returns the response.

**Use case:** Disabling twin behavior (e.g., production, development with live data).

## Environment Variables

| Variable | Effect |
|----------|--------|
| `DIGITAL_TWIN_MODE` | Override mode: `replay`, `record`, or `off`. Takes precedence over code config if set. |
| `NODE_ENV` | When set to `test` and `DIGITAL_TWIN_MODE` is not set, defaults mode to `replay`. |

## Cassette Storage

Cassettes are stored as JSON files in the `twinPack` directory under the hood by `digital-twin-core`. Each cassette is a file named `<cassette-name>.json` following the [Cassette Schema v1](https://github.com/your-org/digital-twin-core#cassette-schema-v1).

The `twinPack` can be:

1. **Local directory path**: Path to a directory containing one or more cassette JSON files.
2. **Package name**: If you install a package that provides cassettes (e.g., `npm install my-test-cassettes`), pass the package name as `twinPack`. The package should contain a `cassettes/` subdirectory with JSON files.

When passing a package name, the router resolves it via Node's module resolution and uses the package directory as the store location.

## Error Handling

In `replay` mode, when a request does not match any recorded interaction:

```js
{
  Error: Cache miss: No matching interaction found.
  Computed hash: sha256$abc123...
  Available interactions: [
    { interactionId: "xyz", requestMethod: "GET", requestUrl: "..." },
    ...
  ]
}
```

This strict matching ensures tests fail if requests drift, encouraging deliberate updates.

## Testing

```bash
npm test
```

Runs the Node.js test suite.

## License

MIT
