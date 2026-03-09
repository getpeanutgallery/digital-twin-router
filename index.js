/**
 * digital-twin-router
 * Router/interceptor for digital twin recording and replay
 */

const {
  TwinStore,
  TwinEngine,
  normalizeAndHash,
  cassette: { findByHash },
  redaction: { redactResponse, redactBody, redactHeaders }
} = require('digital-twin-core');
const fs = require('fs');
const path = require('path');

// Module-level replay cursor map to persist sequential replay consumption across
// transport instances (e.g., when createTwinTransport is created per request).
// Keyed by storeDir + cassetteName (+ normalizerOptions).
const replayCursorByCassetteKey = new Map();

function stableStringify(value) {
  try {
    if (value === null || value === undefined) return '';
    if (typeof value !== 'object') return String(value);

    const seen = new WeakSet();
    const sorter = (v) => {
      if (v === null || v === undefined) return v;
      if (typeof v !== 'object') return v;
      if (seen.has(v)) return '[Circular]';
      seen.add(v);
      if (Array.isArray(v)) return v.map(sorter);
      const out = {};
      for (const k of Object.keys(v).sort()) {
        out[k] = sorter(v[k]);
      }
      return out;
    };

    return JSON.stringify(sorter(value));
  } catch (e) {
    // Last resort: avoid throwing when building cursor keys
    return '';
  }
}

function getReplayCursorKey({ storeDir, cassetteName, normalizerOptions }) {
  return `${storeDir}::${cassetteName}::${stableStringify(normalizerOptions)}`;
}


function isRecordedErrorResponse(response) {
  if (!response) return false;
  if (response.__digitalTwinError) return true;
  if (response.body && response.body.__digitalTwinError) return true;
  return false;
}

function getErrorMetaFromRecordedErrorResponse(response) {
  if (!response) return null;
  if (response.error && typeof response.error === 'object') return response.error;
  if (response.body && response.body.__digitalTwinError) return response.body;
  // Back-compat / fallthrough: treat top-level as meta
  return response;
}

function buildRecordedErrorResponse(err, redactionPatterns = []) {
  const extraPatterns = [
    // Messages often contain tokens without JSON structure.
    {
      name: 'Bearer token in text',
      pattern: /Bearer\s+[A-Za-z0-9._-]+/g,
      type: 'body',
      replacement: 'Bearer REDACTED'
    },
    {
      name: 'apiKey in text',
      pattern: /api[_-]?key\s*[:=]\s*['" ]?[A-Za-z0-9._-]+['" ]?/gi,
      type: 'body',
      replacement: 'api_key=REDACTED'
    },
    {
      name: 'x-api-key in JSON',
      pattern: /"x-api-key"\s*:\s*"[^"]+"/gi,
      type: 'body',
      replacement: '"x-api-key": "REDACTED"'
    },
    {
      name: 'authorization bearer in JSON (case-insensitive)',
      pattern: /"authorization"\s*:\s*"Bearer [^"]+"/gi,
      type: 'body',
      replacement: '"authorization": "Bearer REDACTED"'
    }
  ];

  const patterns = [...redactionPatterns, ...extraPatterns];

  const status =
    err?.status ??
    err?.statusCode ??
    err?.response?.status ??
    err?.response?.statusCode ??
    err?.cause?.status ??
    undefined;

  const debug = {};

  if (err?.stack) debug.stack = redactBody(err.stack, patterns);

  if (err?.debug !== undefined) {
    debug.debug = redactBody(err.debug, patterns);
  }

  if (err?.details !== undefined) {
    debug.details = redactBody(err.details, patterns);
  }

  if (err?.response) {
    debug.response = {
      status: err.response.status ?? err.response.statusCode,
      headers: redactHeaders(err.response.headers || {}, patterns),
      data: redactBody(err.response.data, patterns)
    };
  }

  // If debug ended up empty, omit it to keep cassettes clean.
  const hasDebug = Object.keys(debug).length > 0;

  const message = redactBody(err?.message ?? String(err), patterns);

  return {
    __digitalTwinError: true,
    status: status ?? 599,
    headers: {},
    body: null,
    error: {
      name: err?.name || 'Error',
      message,
      code: err?.code,
      status,
      debug: hasDebug ? debug : undefined
    }
  };
}

function rethrowRecordedError(response) {
  const meta = getErrorMetaFromRecordedErrorResponse(response) || {};
  const err = new Error(meta.message || 'Recorded transport error');
  if (meta.name) err.name = meta.name;
  if (meta.code !== undefined) err.code = meta.code;
  if (meta.status !== undefined) err.status = meta.status;
  if (meta.debug !== undefined) err.debug = meta.debug;
  err.__digitalTwinRecordedError = true;
  throw err;
}

/**
 * Resolve twinPack to a filesystem path.
 * twinPack can be either:
 * - local filesystem path (absolute or relative)
 * - package name (will try to resolve via require.resolve)
 */
function resolveTwinPack(twinPack) {
  if (!twinPack) {
    throw new Error('twinPack is required');
  }

  // If it's an absolute path or relative path that exists, use it directly
  if (path.isAbsolute(twinPack) || fs.existsSync(twinPack)) {
    return path.resolve(twinPack);
  }

  // Try to resolve as a package/module
  try {
    const resolved = require.resolve(twinPack);
    return path.dirname(resolved);
  } catch (err) {
    throw new Error(
      `Cannot resolve twinPack "${twinPack}". It must be either a valid filesystem path ` +
      `or an installed npm package that contains cassettes.`
    );
  }
}

/**
 * Create a transport wrapper that intercepts requests for recording/replay.
 *
 * @param {Object} options
 * @param {string} [options.mode] - 'replay' | 'record' | 'off'. Defaults to 'replay' when NODE_ENV=test, else 'off'.
 * @param {string} options.twinPack - Path to twin store or package name containing cassettes.
 * @param {Function} options.realTransport - Function that performs actual request: (request) => Promise<response>.
 * @param {Object} [options.engineOptions] - Additional options for TwinEngine.
 * @returns {Object} Transport wrapper with complete(request) method.
 */
function createTwinTransport({ mode, twinPack, realTransport, engineOptions = {} }) {
  // Determine mode from environment if not explicitly provided
  let effectiveMode = mode;
  if (!effectiveMode) {
    const nodeEnv = process.env.NODE_ENV || '';
    const dtwinMode = process.env.DIGITAL_TWIN_MODE;
    effectiveMode = dtwinMode || (nodeEnv === 'test' ? 'replay' : 'off');
  }

  if (!['replay', 'record', 'off'].includes(effectiveMode)) {
    throw new Error(`Invalid mode "${effectiveMode}". Must be one of: replay, record, off`);
  }

  if (typeof realTransport !== 'function' && effectiveMode !== 'replay') {
    throw new Error('realTransport is required when mode is not "replay"');
  }

  // Resolve twinPack to path
  const storePath = resolveTwinPack(twinPack);

  // Determine actual storeDir (where cassette files are stored)
  let storeDir = storePath;
  try {
    const possibleSubDir = path.join(storePath, 'cassettes');
    const stats = fs.statSync(possibleSubDir);
    if (stats.isDirectory()) {
      // Check if it contains any .json or .cassette files
      const files = fs.readdirSync(possibleSubDir);
      const hasCassettes = files.some(f => f.endsWith('.json') || f.endsWith('.cassette'));
      if (hasCassettes) {
        storeDir = possibleSubDir;
      }
    }
  } catch (e) {
    // If cassettes subdir doesn't exist or can't be read, keep storeDir = storePath
  }

  // Determine cassette name: priority 1) env DIGITAL_TWIN_CASSETTE, 2) manifest.json, 3) fallback
  let cassetteName = null;

  // 1. Override from environment
  if (process.env.DIGITAL_TWIN_CASSETTE) {
    cassetteName = process.env.DIGITAL_TWIN_CASSETTE;
  } else {
    // 2. Try manifest.json in storePath (package root)
    const manifestPath = path.join(storePath, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
        const manifest = JSON.parse(manifestContent);
        if (manifest.defaultCassetteId) {
          cassetteName = manifest.defaultCassetteId;
        }
      } catch (e) {
        // ignore manifest read/parse errors
      }
    }

    // 3. Fallback: derive from storeDir basename
    if (!cassetteName) {
      try {
        const stats = fs.statSync(storeDir);
        if (stats.isDirectory()) {
          cassetteName = path.basename(storeDir);
        } else {
          cassetteName = path.basename(storeDir, path.extname(storeDir));
        }
      } catch (e) {
        cassetteName = 'default';
      }
    }
  }

  // Create TwinStore and Engine using the determined storeDir
  const store = new TwinStore({
    storeDir: storeDir,
    ...engineOptions
  });

  const engine = new TwinEngine({
    store,
    ...engineOptions
  });

  // Cache for engine loaded state
  let engineLoaded = false;

  // Local replay cursor (index into cassette.interactions). This is synchronized with a
  // module-level cursor map so sequential replay consumption persists across transport
  // instances (e.g., when the caller constructs a new transport per request).
  let replayCursor = 0;

  /**
   * Ensure engine is loaded with cassette for replay/record modes.
   * Creates cassette if it doesn't exist (for record mode).
   */
  async function ensureEngineLoaded() {
    if (engineLoaded) {
      return;
    }

    try {
      // Try to load existing cassette
      await engine.load(cassetteName);
    } catch (err) {
      if (err.message.includes('not found') || err.code === 'ENOENT') {
        // Cassette doesn't exist - only allowed in record mode
        if (effectiveMode === 'record') {
          await engine.create(cassetteName, {
            description: `Auto-created cassette for ${cassetteName}`,
            createdBy: 'digital-twin-router'
          });
        } else {
          throw new Error(
            `Cassette not found: ${cassetteName} at ${storeDir}\n` +
            `Ensure the cassette exists or switch to 'record' mode to create it.`
          );
        }
      } else {
        throw err;
      }
    }

    engineLoaded = true;
  }

  /**
   * Complete a request through the transport.
   * @param {Object} request - The request object (method, url, headers, body, etc.)
   * @returns {Promise<Object>} response object
   */
  async function complete(request) {
    switch (effectiveMode) {
      case 'replay': {
        await ensureEngineLoaded();

        const { hash } = normalizeAndHash(request, engine.normalizerOptions);

        // Sequential replay consumption: when identical requests appear multiple times in
        // the cassette (e.g., retries), match the first interaction at/after the current
        // cursor and advance the cursor.
        //
        // Cursor is persisted across transport instances via module-level map.
        const replayKey = getReplayCursorKey({
          storeDir,
          cassetteName,
          normalizerOptions: engine.normalizerOptions
        });
        replayCursor = replayCursorByCassetteKey.get(replayKey) ?? 0;

        const interactions = engine.cassette?.interactions || [];
        const matchCount = findByHash(engine.cassette, hash).length;

        let matchIndex = -1;
        for (let i = replayCursor; i < interactions.length; i++) {
          if (interactions[i].interactionId === hash) {
            matchIndex = i;
            break;
          }
        }

        if (matchIndex === -1) {
          // Format available keys for error message
          const available = interactions.map((int) => ({
            interactionId: int.interactionId,
            requestMethod: int.request.method,
            requestUrl: int.request.url
          }));

          throw new Error(
            `Cache miss: No matching interaction found.\n` +
            `Computed hash: ${hash}\n` +
            `Replay cursor: ${replayCursor} (cassette interactions: ${interactions.length}, total matches for hash: ${matchCount})\n` +
            `Available interactions: ${JSON.stringify(available, null, 2)}`
          );
        }

        const interaction = interactions[matchIndex];
        replayCursor = matchIndex + 1;
        replayCursorByCassetteKey.set(replayKey, replayCursor);

        if (isRecordedErrorResponse(interaction.response)) {
          const redacted = redactResponse(interaction.response, engine.redactionPatterns);
          rethrowRecordedError(redacted);
        }

        const response = redactResponse(interaction.response, engine.redactionPatterns);
        return response;
      }

      case 'record': {
        if (!realTransport) {
          throw new Error('realTransport is required in record mode');
        }

        await ensureEngineLoaded();

        try {
          // Perform the actual request
          const response = await realTransport(request);

          // Record the interaction
          await engine.record(request, response);

          return response;
        } catch (err) {
          const errorResponse = buildRecordedErrorResponse(err, engine.redactionPatterns);

          // Best-effort: still record the failed interaction so replay has no gaps.
          try {
            await engine.record(request, errorResponse);
          } catch (recordErr) {
            // Do not mask the real transport error, but do not swallow the recording failure.
            // Attach redacted context so callers can debug missing interactions/cassette gaps.
            try {
              const redactedRecordErr = buildRecordedErrorResponse(
                recordErr,
                engine.redactionPatterns
              );

              if (err && typeof err === 'object') {
                err.__digitalTwinRecordError = {
                  name: redactedRecordErr?.error?.name,
                  message: redactedRecordErr?.error?.message,
                  stack: redactedRecordErr?.error?.debug?.stack
                };
              }

              // One-line warning only; avoid printing request/response details.
              console.warn(
                `[digital-twin-router] Failed to record error interaction: ${redactedRecordErr?.error?.message || 'unknown error'}`
              );
            } catch (attachErr) {
              // Never let instrumentation break the main error path.
            }
          }

          throw err;
        }
      }

      case 'off': {
        if (!realTransport) {
          throw new Error('realTransport is required when mode is not "replay"');
        }
        return realTransport(request);
      }

      default:
        throw new Error(`Unhandled mode: ${effectiveMode}`);
    }
  }

  // Expose some metadata
  const transport = {
    complete,
    getMode: () => effectiveMode,
    getCassetteName: () => cassetteName,
    getStorePath: () => storePath,
    getEngine: () => engine,
    getStore: () => store
  };

  return transport;
}

module.exports = { createTwinTransport, resolveTwinPack };
