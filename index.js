/**
 * digital-twin-router
 * Router/interceptor for digital twin recording and replay
 */

const {
  TwinStore,
  TwinEngine,
  normalizeAndHash,
  cassette: { findByHash, validateCassette }
} = require('digital-twin-core');
const fs = require('fs');
const path = require('path');

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

  // Create TwinStore and Engine
  const store = new TwinStore({
    storeDir: storePath,
    ...engineOptions
  });

  const engine = new TwinEngine({
    store,
    ...engineOptions
  });

  let cassetteName = null;

  // Determine cassette name from twinPack if possible
  try {
    // Try to get cassette name from a manifest or use the pack name itself
    const stats = fs.statSync(storePath);
    if (stats.isDirectory()) {
      // Use the directory basename as cassette name
      cassetteName = path.basename(storePath);
    } else {
      cassetteName = 'default';
    }
  } catch (e) {
    cassetteName = 'default';
  }

  // Ensure cassette exists in record mode
  if (effectiveMode === 'record') {
    // We'll create cassette on first record if it doesn't exist
  }

  /**
   * Complete a request through the transport.
   * @param {Object} request - The request object (method, url, headers, body, etc.)
   * @returns {Promise<Object>} response object
   */
  async function complete(request) {
    switch (effectiveMode) {
      case 'replay': {
        // Hash the request to find matching interaction
        const { hash } = normalizeAndHash(request, {
          includeHeaders: engine.options.normalizerOptions?.includeHeaders ?? true,
          includeBody: engine.options.normalizerOptions?.includeBody ?? true
        });

        // Try to load cassette
        let cassette;
        try {
          cassette = await store.read(cassetteName);
        } catch (err) {
          if (err.code === 'ENOENT' || err.message.includes('not found')) {
            throw new Error(
              `Cassette not found: ${cassetteName} at ${storePath}\n` +
              `Ensure the cassette exists or switch to 'record' mode to create it.`
            );
          }
          throw err;
        }

        // Find interaction by hash
        const match = findByHash(cassette, hash);

        if (!match) {
          // Format available keys for error message
          const available = cassette.interactions.map((int) => ({
            interactionId: int.interactionId,
            requestMethod: int.request.method,
            requestUrl: int.request.url
          }));

          throw new Error(
            `Cache miss: No matching interaction found.\n` +
            `Computed hash: ${hash}\n` +
            `Available interactions: ${JSON.stringify(available, null, 2)}`
          );
        }

        // Return the recorded response (clone to avoid mutation)
        return JSON.parse(JSON.stringify(match.response));
      }

      case 'record': {
        if (!realTransport) {
          throw new Error('realTransport is required in record mode');
        }

        // Ensure cassette exists (create if not)
        try {
          await store.read(cassetteName);
        } catch (err) {
          if (err.code === 'ENOENT' || err.message.includes('not found')) {
            await engine.create(cassetteName, {
              description: `Auto-created cassette for ${cassetteName}`,
              createdBy: 'digital-twin-router'
            });
          }
        }

        // Actually perform the request
        const response = await realTransport(request);

        // Record the interaction
        await engine.record(request, response);

        return response;
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
