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
| `twinPack` | `string` (required) | Path to a twin pack directory (local or npm package). The router resolves the path, reads `manifest.json` (if present) for `defaultCassetteId`, and automatically detects if cassettes are in a `cassettes/` subdirectory. |
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
| `DIGITAL_TWIN_CASSETTE` | Override which cassette to use. Overrides `manifest.json`'s `defaultCassetteId` and the automatic derivation. |
| `NODE_ENV` | When set to `test` and `DIGITAL_TWIN_MODE` is not set, defaults mode to `replay`. |

## Cassette Storage and Resolution

Cassettes are stored as JSON files (`<cassette-name>.json`) following the [Cassette Schema v1](https://github.com/your-org/digital-twin-core#cassette-schema-v1).

The `twinPack` can be:

1. **Local directory path**: A directory containing cassette JSON files.
2. **Package name**: An installed npm package that provides cassettes.

### Resolution order for selecting the default cassette:

1. `DIGITAL_TWIN_CASSETTE` environment variable (highest priority)
2. `manifest.json`'s `defaultCassetteId` field (if present)
3. Automatic fallback: the base name of the store directory (e.g., if store dir is `my-pack`, it looks for `my-pack.json`)

### Store directory detection

The router automatically determines where cassette files live:

- If the `twinPack` directory contains a `cassettes/` subdirectory with `.json` or `.cassette` files, the `storeDir` is set to that subdirectory.
- Otherwise, the `twinPack` directory itself is used as the `storeDir`.

This allows twin packs to organize files either directly in the package root or within a `cassettes/` subfolder.

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
