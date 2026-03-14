const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Import the module under test
const { createTwinTransport, resolveTwinPack } = require('../index.js');

// Helper: create temporary directory
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtwin-router-'));
  return dir;
}

// Mock real transport
function mockTransport(response = { status: 200, body: { ok: true } }) {
  return async () => response;
}

describe('createTwinTransport', () => {
  let tempStore;

  beforeEach(() => {
    tempStore = tempDir();
    // Set NODE_ENV to undefined by default
    delete process.env.NODE_ENV;
    delete process.env.DIGITAL_TWIN_MODE;
  });

  afterEach(() => {
    // Cleanup temp directory
    try {
      fs.rmSync(tempStore, { recursive: true, force: true });
    } catch (e) {
      // ignore
    }
  });

  test('throws if twinPack is missing', () => {
    assert.throws(
      () => createTwinTransport({ mode: 'off', realTransport: mockTransport() }),
      /twinPack is required/
    );
  });

  test('throws if realTransport missing in record mode', () => {
    assert.throws(
      () => createTwinTransport({ mode: 'record', twinPack: tempStore }),
      /realTransport is required/
    );
  });

  test('throws if realTransport missing in off mode', () => {
    assert.throws(
      () => createTwinTransport({ mode: 'off', twinPack: tempStore }),
      /realTransport is required/
    );
  });

  test('accepts valid configuration for replay mode', () => {
    // Create a cassette file for the directory name
    const cassetteName = path.basename(tempStore);
    const cassettePath = path.join(tempStore, `${cassetteName}.json`);
    fs.writeFileSync(cassettePath, JSON.stringify({
      version: '1.0',
      meta: { name: cassetteName },
      interactions: []
    }));
    const transport = createTwinTransport({
      mode: 'replay',
      twinPack: tempStore,
      engineOptions: { createIfMissing: false }
    });
    assert.strictEqual(transport.getMode(), 'replay');
    assert.strictEqual(typeof transport.complete, 'function');
  });

  test('accepts valid configuration for record mode', async () => {
    const transport = createTwinTransport({
      mode: 'record',
      twinPack: tempStore,
      realTransport: mockTransport(),
      engineOptions: { createIfMissing: false }
    });
    assert.strictEqual(transport.getMode(), 'record');
    // Perform a record to create cassette
    await transport.complete({
      method: 'GET',
      url: 'http://test.local/foo'
    });
    // Check that cassette was created
    const cassetteName = transport.getCassetteName();
    const cassettePath = path.join(tempStore, `${cassetteName}.json`);
    assert.ok(fs.existsSync(cassettePath));
  });

  test('accepts valid configuration for off mode', async () => {
    const transport = createTwinTransport({
      mode: 'off',
      twinPack: tempStore,
      realTransport: mockTransport({ status: 201, body: { created: true } }),
      engineOptions: { createIfMissing: false }
    });
    assert.strictEqual(transport.getMode(), 'off');
    const response = await transport.complete({ method: 'POST', url: 'http://test.local/create' });
    assert.strictEqual(response.status, 201);
  });

  test('defaults mode to replay when NODE_ENV=test', () => {
    process.env.NODE_ENV = 'test';
    const cassetteName = path.basename(tempStore);
    const cassettePath = path.join(tempStore, `${cassetteName}.json`);
    fs.writeFileSync(cassettePath, JSON.stringify({
      version: '1.0',
      meta: { name: cassetteName },
      interactions: []
    }));
    const transport = createTwinTransport({
      twinPack: tempStore,
      engineOptions: { createIfMissing: false }
    });
    assert.strictEqual(transport.getMode(), 'replay');
  });

  test('defaults mode to off when NODE_ENV not test and DIGITAL_TWIN_MODE unset', () => {
    process.env.NODE_ENV = 'development';
    const transport = createTwinTransport({
      twinPack: tempStore,
      realTransport: mockTransport(),
      engineOptions: { createIfMissing: false }
    });
    assert.strictEqual(transport.getMode(), 'off');
  });

  test('DIGITAL_TWIN_MODE overrides default', () => {
    process.env.NODE_ENV = 'test'; // would default to replay
    process.env.DIGITAL_TWIN_MODE = 'off';
    const transport = createTwinTransport({
      twinPack: tempStore,
      realTransport: mockTransport(),
      engineOptions: { createIfMissing: false }
    });
    assert.strictEqual(transport.getMode(), 'off');
  });

  test('throws on invalid mode', () => {
    assert.throws(
      () => createTwinTransport({ mode: 'invalid', twinPack: tempStore, realTransport: mockTransport(), engineOptions: { createIfMissing: false } }),
      /Invalid mode "invalid"/
    );
  });
});

describe('createTwinTransport - replay behavior', () => {
  let tempStore;

  beforeEach(() => {
    tempStore = tempDir();
  });

  afterEach(() => {
    try {
      fs.rmSync(tempStore, { recursive: true, force: true });
    } catch (e) {}
  });

  test('returns recorded response on hash match', async () => {
    // Use a dedicated cassette-named directory
    const cassetteName = 'my-api';
    const cassetteDir = path.join(tempStore, cassetteName);
    fs.mkdirSync(cassetteDir, { recursive: true });

    const request1 = {
      method: 'GET',
      url: 'https://api.example.com/users',
      headers: { 'Content-Type': 'application/json' },
      body: null
    };
    const response1 = { status: 200, headers: {}, body: { users: [{ id: 1, name: 'Alice' }] } };

    // Create cassette manually using the same store and engine that will be used by transport
    const { TwinStore, TwinEngine } = require('digital-twin-core');
    const store = new TwinStore({ storeDir: cassetteDir, createIfMissing: false });
    const engine = new TwinEngine({ store });
    await engine.create(cassetteName);
    await engine.record(request1, response1);

    // Now create transport in replay mode (using cassetteDir as twinPack)
    const transport = createTwinTransport({
      mode: 'replay',
      twinPack: cassetteDir,
      engineOptions: { createIfMissing: false }
    });

    const result = await transport.complete(request1);
    assert.deepStrictEqual(result, response1);
  });

  test('consumes sequential matches for identical requests (retries)', async () => {
    const cassetteName = 'retries';
    const cassetteDir = path.join(tempStore, cassetteName);
    fs.mkdirSync(cassetteDir, { recursive: true });

    const request = {
      method: 'POST',
      url: 'https://api.example.com/chat/completions',
      headers: { 'Content-Type': 'application/json' },
      body: { model: 'x', messages: [{ role: 'user', content: 'hi' }] }
    };

    const responseA = { status: 429, headers: {}, body: { error: 'rate_limited' } };
    const responseB = { status: 200, headers: {}, body: { ok: true, attempt: 2 } };

    const { TwinStore, TwinEngine } = require('digital-twin-core');
    const store = new TwinStore({ storeDir: cassetteDir, createIfMissing: false });
    const engine = new TwinEngine({ store });
    await engine.create(cassetteName);

    // Record the *same* request twice with different responses.
    await engine.record(request, responseA);
    await engine.record(request, responseB);

    const transport = createTwinTransport({
      mode: 'replay',
      twinPack: cassetteDir,
      engineOptions: { createIfMissing: false }
    });

    // First call should return first recorded response, second call should return second.
    assert.deepStrictEqual(await transport.complete(request), responseA);
    assert.deepStrictEqual(await transport.complete(request), responseB);

    // Third call is beyond recorded retries.
    await assert.rejects(() => transport.complete(request), /Cache miss/);
  });

  test('consumes sequential matches across transport instances for identical requests', async () => {
    const cassetteName = 'retries-across-instances';
    const cassetteDir = path.join(tempStore, cassetteName);
    fs.mkdirSync(cassetteDir, { recursive: true });

    const request = {
      method: 'POST',
      url: 'https://api.example.com/chat/completions',
      headers: { 'Content-Type': 'application/json' },
      body: { model: 'x', messages: [{ role: 'user', content: 'hi' }] }
    };

    const responseA = { status: 429, headers: {}, body: { error: 'rate_limited' } };
    const responseB = { status: 200, headers: {}, body: { ok: true, attempt: 2 } };

    const { TwinStore, TwinEngine } = require('digital-twin-core');
    const store = new TwinStore({ storeDir: cassetteDir, createIfMissing: false });
    const engine = new TwinEngine({ store });
    await engine.create(cassetteName);

    // Record the *same* request twice with different responses.
    await engine.record(request, responseA);
    await engine.record(request, responseB);

    // NOTE: emotion-engine/ai-providers creates a new transport per request.
    const transport1 = createTwinTransport({
      mode: 'replay',
      twinPack: cassetteDir,
      engineOptions: { createIfMissing: false }
    });
    assert.deepStrictEqual(await transport1.complete(request), responseA);

    const transport2 = createTwinTransport({
      mode: 'replay',
      twinPack: cassetteDir,
      engineOptions: { createIfMissing: false }
    });
    assert.deepStrictEqual(await transport2.complete(request), responseB);

    const transport3 = createTwinTransport({
      mode: 'replay',
      twinPack: cassetteDir,
      engineOptions: { createIfMissing: false }
    });
    await assert.rejects(() => transport3.complete(request), /Cache miss/);
  });

  test('throws detailed error on cache miss', async () => {
    const cassetteName = 'my-api';
    const cassetteDir = path.join(tempStore, cassetteName);
    fs.mkdirSync(cassetteDir, { recursive: true });

    const request1 = {
      method: 'GET',
      url: 'https://api.example.com/users',
      headers: {},
      body: null
    };
    const response1 = { status: 200, headers: {}, body: { users: [] } };

    // Create cassette
    const { TwinStore, TwinEngine } = require('digital-twin-core');
    const store = new TwinStore({ storeDir: cassetteDir, createIfMissing: false });
    const engine = new TwinEngine({ store });
    await engine.create(cassetteName);
    await engine.record(request1, response1);

    const transport = createTwinTransport({
      mode: 'replay',
      twinPack: cassetteDir,
      engineOptions: { createIfMissing: false }
    });

    // Different request
    const request2 = {
      method: 'POST',
      url: 'https://api.example.com/users',
      headers: { 'Content-Type': 'application/json' },
      body: { name: 'Bob' }
    };

    try {
      await transport.complete(request2);
      assert.fail('Expected error to be thrown');
    } catch (err) {
      assert.ok(err.message.includes('Cache miss'));
      assert.ok(err.message.includes('Computed hash'));
      assert.ok(err.message.includes('Available interactions'));
      // Verify the available interaction shows the original request details
      assert.ok(err.message.includes('GET'));
      assert.ok(err.message.includes('https://api.example.com/users'));
    }
  });

  test('handles multiple interactions in same cassette', async () => {
    const cassetteName = 'multi';
    const cassetteDir = path.join(tempStore, cassetteName);
    fs.mkdirSync(cassetteDir, { recursive: true });

    const { TwinStore, TwinEngine } = require('digital-twin-core');
    const store = new TwinStore({ storeDir: cassetteDir, createIfMissing: false });
    const engine = new TwinEngine({ store });
    await engine.create(cassetteName);

    const requests = [
      { method: 'GET', url: 'https://api.example.com/a', headers: {}, body: null },
      { method: 'POST', url: 'https://api.example.com/b', headers: { 'Content-Type': 'application/json' }, body: { x: 1 } },
      { method: 'DELETE', url: 'https://api.example.com/c?id=123', headers: {}, body: null }
    ];
    const responses = [
      { status: 200, headers: {}, body: { result: 'a' } },
      { status: 201, headers: {}, body: { result: 'b' } },
      { status: 204, headers: {}, body: null }
    ];

    for (let i = 0; i < requests.length; i++) {
      await engine.record(requests[i], responses[i]);
    }

    const transport = createTwinTransport({
      mode: 'replay',
      twinPack: cassetteDir,
      engineOptions: { createIfMissing: false }
    });

    for (let i = 0; i < requests.length; i++) {
      const res = await transport.complete(requests[i]);
      assert.deepStrictEqual(res, responses[i]);
    }
  });
});

describe('createTwinTransport - record behavior', () => {
  let tempStore;

  beforeEach(() => {
    tempStore = tempDir();
  });

  afterEach(() => {
    try {
      fs.rmSync(tempStore, { recursive: true, force: true });
    } catch (e) {}
  });

  test('records new interactions to cassette', async () => {
    const transport = createTwinTransport({
      mode: 'record',
      twinPack: tempStore,
      realTransport: mockTransport({ status: 200, body: { recorded: true } }),
      engineOptions: { createIfMissing: false }
    });

    const request = {
      method: 'POST',
      url: 'https://api.example.com/log',
      headers: { 'Content-Type': 'application/json' },
      body: { event: 'test' }
    };
    const expectedResponse = { status: 200, body: { recorded: true } };

    const result = await transport.complete(request);
    assert.deepStrictEqual(result, expectedResponse);

    // Verify cassette file was created and contains the interaction
    const cassetteName = transport.getCassetteName();
    const cassettePath = path.join(tempStore, `${cassetteName}.json`);
    assert.ok(fs.existsSync(cassettePath));
    const cassette = JSON.parse(fs.readFileSync(cassettePath, 'utf8'));
    assert.strictEqual(cassette.interactions.length, 1);
    assert.strictEqual(cassette.interactions[0].request.method, 'POST');
    assert.strictEqual(cassette.interactions[0].response.status, 200);
  });

  test('records an error interaction when realTransport throws', async () => {
    const realTransport = async () => {
      const err = new Error('boom Authorization: Bearer SECRET_TOKEN api_key=SHOULD_NOT_LEAK');
      err.name = 'TransportError';
      err.code = 'EBOOM';
      err.status = 503;
      err.debug = {
        headers: { Authorization: 'Bearer SECRET_TOKEN', 'x-api-key': 'SHOULD_NOT_LEAK' },
        body: { api_key: 'SHOULD_NOT_LEAK' }
      };
      throw err;
    };

    const transport = createTwinTransport({
      mode: 'record',
      twinPack: tempStore,
      realTransport,
      engineOptions: { createIfMissing: false }
    });

    const request = {
      method: 'GET',
      url: 'https://api.example.com/fail',
      headers: { Authorization: 'Bearer SECRET_TOKEN', 'x-api-key': 'SHOULD_NOT_LEAK' },
      body: null
    };

    await assert.rejects(() => transport.complete(request), /boom/);

    const cassetteName = transport.getCassetteName();
    const cassettePath = path.join(tempStore, `${cassetteName}.json`);
    const cassette = JSON.parse(fs.readFileSync(cassettePath, 'utf8'));

    assert.strictEqual(cassette.interactions.length, 1);
    const recorded = cassette.interactions[0].response;

    assert.strictEqual(recorded.__digitalTwinError, true);
    assert.strictEqual(recorded.error.code, 'EBOOM');
    assert.strictEqual(recorded.error.status, 503);

    const serialized = JSON.stringify(recorded);
    assert.ok(!serialized.includes('SECRET_TOKEN'));
    assert.ok(!serialized.includes('SHOULD_NOT_LEAK'));
  });

  test('records normalized status/request-id/classification and structured response from debug fallback', async () => {
    const realTransport = async () => {
      const err = new Error('wrapped upstream failure');
      err.name = 'WrappedProviderError';
      err.code = 'ERR_BAD_RESPONSE';
      err.provider = 'openrouter';
      err.failureCategory = 'rate_limit';
      err.failureCode = 'http_429';
      err.retryable = true;
      err.providerRequest = {
        method: 'POST',
        url: 'https://openrouter.ai/api/v1/chat/completions',
        headers: {
          authorization: 'Bearer SHOULD_NOT_LEAK',
          'content-type': 'application/json'
        },
        body: { model: 'openrouter/test-model' }
      };
      err.providerResponse = {
        status: 429,
        headers: {
          'x-request-id': 'req_debug_123',
          'retry-after': '3'
        },
        body: {
          error: {
            code: 429,
            message: 'Rate limited',
            metadata: { provider_name: 'openrouter' }
          }
        }
      };
      err.debug = {
        provider: 'openrouter',
        response: {
          status: 429,
          headers: {
            'x-request-id': 'req_debug_123',
            'x-api-key': 'SHOULD_NOT_LEAK'
          },
          body: JSON.stringify({
            error: {
              code: 429,
              message: 'Rate limited',
              metadata: { provider_name: 'openrouter' }
            }
          })
        },
        providerError: {
          httpStatus: 429,
          code: 429,
          message: 'Rate limited',
          metadata: { provider_name: 'openrouter' }
        }
      };
      err.aiTargets = { classification: 'retryable' };
      throw err;
    };

    const transport = createTwinTransport({
      mode: 'record',
      twinPack: tempStore,
      realTransport,
      engineOptions: { createIfMissing: false }
    });

    let recordedErr;
    await assert.rejects(
      () => transport.complete({ method: 'GET', url: 'https://api.example.com/debug-fallback', headers: {}, body: null }),
      (err) => {
        recordedErr = err;
        assert.strictEqual(err.message, 'wrapped upstream failure');
        return true;
      }
    );

    const cassetteName = transport.getCassetteName();
    const cassettePath = path.join(tempStore, `${cassetteName}.json`);
    const cassette = JSON.parse(fs.readFileSync(cassettePath, 'utf8'));
    const recorded = cassette.interactions[0].response;

    assert.strictEqual(recorded.error.status, 429);
    assert.strictEqual(recorded.error.requestId, 'req_debug_123');
    assert.strictEqual(recorded.error.provider, 'openrouter');
    assert.strictEqual(recorded.error.failureCategory, 'rate_limit');
    assert.strictEqual(recorded.error.failureCode, 'http_429');
    assert.strictEqual(recorded.error.retryable, true);
    assert.strictEqual(recorded.error.classification, 'retryable');
    assert.deepStrictEqual(recorded.error.response, {
      error: {
        code: 429,
        message: 'Rate limited',
        metadata: { provider_name: 'openrouter' }
      }
    });
    assert.deepStrictEqual(recorded.error.providerRequest, {
      method: 'POST',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      headers: {
        authorization: 'Bearer REDACTED',
        'content-type': 'application/json'
      },
      body: { model: 'openrouter/test-model' }
    });
    assert.deepStrictEqual(recorded.error.providerResponse, {
      status: 429,
      headers: {
        'x-request-id': 'req_debug_123',
        'retry-after': '3'
      },
      body: {
        error: {
          code: 429,
          message: 'Rate limited',
          metadata: { provider_name: 'openrouter' }
        }
      }
    });
    assert.strictEqual(recorded.error.recordedFailure.version, 'digital-twin-router.recorded-failure/v1');
    assert.strictEqual(recorded.error.recordedFailure.cassetteName, cassetteName);
    assert.strictEqual(recorded.error.recordedFailure.storeDir, tempStore);
    assert.strictEqual(recorded.error.recordedFailure.cassettePath, cassettePath);
    assert.strictEqual(recorded.error.recordedFailure.interactionId, cassette.interactions[0].id);
    assert.strictEqual(recorded.error.recordedFailure.requestHash, cassette.interactions[0].interactionId);
    assert.deepStrictEqual(recorded.error.recordedFailure.request, {
      method: 'GET',
      url: 'https://api.example.com/debug-fallback'
    });
    assert.deepStrictEqual(recordedErr.recordedFailure, recorded.error.recordedFailure);
    assert.strictEqual(recorded.error.debug.response.status, 429);
    assert.strictEqual(recorded.error.debug.response.headers['x-request-id'], 'req_debug_123');
    assert.ok(!JSON.stringify(recorded).includes('SHOULD_NOT_LEAK'));
  });

  test('surfaces engine.record failure when recording an error interaction', async () => {
    const realTransport = async () => {
      throw new Error('boom');
    };

    const transport = createTwinTransport({
      mode: 'record',
      twinPack: tempStore,
      realTransport,
      engineOptions: { createIfMissing: false }
    });

    // Simulate a failure inside the error-recording path.
    const engine = transport.getEngine();
    const originalRecord = engine.record.bind(engine);
    engine.record = async (req, res, options) => {
      if (res && res.__digitalTwinError) {
        throw new Error('store write failed Authorization: Bearer SECRET_TOKEN');
      }
      return originalRecord(req, res, options);
    };

    const originalWarn = console.warn;
    let warnLine = '';
    console.warn = (...args) => {
      warnLine = args.map(String).join(' ');
    };

    const request = {
      method: 'GET',
      url: 'https://api.example.com/fail',
      headers: { Authorization: 'Bearer SECRET_TOKEN' },
      body: null
    };

    try {
      await assert.rejects(
        () => transport.complete(request),
        (err) => {
          assert.strictEqual(err.message, 'boom');
          assert.ok(err.__digitalTwinRecordError);
          assert.match(err.__digitalTwinRecordError.message, /Bearer REDACTED/);
          assert.ok(!err.__digitalTwinRecordError.message.includes('SECRET_TOKEN'));
          return true;
        }
      );

      assert.ok(warnLine.includes('Failed to record error interaction'));
      assert.ok(!warnLine.includes('SECRET_TOKEN'));
    } finally {
      console.warn = originalWarn;
    }
  });

  test('replay rethrows recorded error payload', async () => {
    const cassetteName = 'replay-error';
    const cassetteDir = path.join(tempStore, cassetteName);
    fs.mkdirSync(cassetteDir, { recursive: true });

    const request = {
      method: 'GET',
      url: 'https://api.example.com/error',
      headers: { 'Content-Type': 'application/json' },
      body: null
    };

    const { TwinStore, TwinEngine } = require('digital-twin-core');
    const store = new TwinStore({ storeDir: cassetteDir, createIfMissing: false });
    const engine = new TwinEngine({ store });
    await engine.create(cassetteName);

    const recordedErrorResponse = {
      __digitalTwinError: true,
      status: 599,
      headers: {},
      body: null,
      error: {
        name: 'UpstreamError',
        message: 'upstream failed',
        code: 'EUPSTREAM',
        status: 418,
        requestId: 'req_replay_123',
        provider: 'openrouter',
        failureCategory: 'provider_response',
        failureCode: 'http_418',
        retryable: false,
        classification: 'retryable',
        response: { error: { code: 418, message: 'teapot' } },
        providerRequest: {
          method: 'POST',
          url: 'https://openrouter.ai/api/v1/chat/completions',
          headers: { 'content-type': 'application/json' },
          body: { model: 'openrouter/test-model' }
        },
        providerResponse: {
          status: 418,
          headers: { 'x-request-id': 'req_replay_123' },
          body: { error: { code: 418, message: 'teapot' } }
        },
        recordedFailure: {
          version: 'digital-twin-router.recorded-failure/v1',
          cassetteName,
          storeDir: cassetteDir,
          cassettePath: path.join(cassetteDir, `${cassetteName}.json`),
          interactionId: 'entry_test_replay_1',
          requestHash: 'hash_test_replay_1',
          recordedAt: '2026-03-14T22:00:00.000Z',
          request: {
            method: 'GET',
            url: 'https://api.example.com/error'
          }
        },
        debug: {
          why: 'teapot',
          response: {
            status: 418,
            headers: { 'x-request-id': 'req_replay_123' },
            data: { error: { code: 418, message: 'teapot' } }
          }
        }
      }
    };

    await engine.record(request, recordedErrorResponse);

    const transport = createTwinTransport({
      mode: 'replay',
      twinPack: cassetteDir,
      engineOptions: { createIfMissing: false }
    });

    await assert.rejects(
      () => transport.complete(request),
      (err) => {
        assert.strictEqual(err.name, 'UpstreamError');
        assert.strictEqual(err.message, 'upstream failed');
        assert.strictEqual(err.code, 'EUPSTREAM');
        assert.strictEqual(err.status, 418);
        assert.strictEqual(err.requestId, 'req_replay_123');
        assert.strictEqual(err.provider, 'openrouter');
        assert.strictEqual(err.failureCategory, 'provider_response');
        assert.strictEqual(err.failureCode, 'http_418');
        assert.strictEqual(err.retryable, false);
        assert.deepStrictEqual(err.aiTargets, { classification: 'retryable' });
        assert.deepStrictEqual(err.response, {
          status: 418,
          data: { error: { code: 418, message: 'teapot' } },
          headers: { 'x-request-id': 'req_replay_123' }
        });
        assert.deepStrictEqual(err.providerRequest, {
          method: 'POST',
          url: 'https://openrouter.ai/api/v1/chat/completions',
          headers: { 'content-type': 'application/json' },
          body: { model: 'openrouter/test-model' }
        });
        assert.deepStrictEqual(err.providerResponse, {
          status: 418,
          headers: { 'x-request-id': 'req_replay_123' },
          body: { error: { code: 418, message: 'teapot' } }
        });
        assert.deepStrictEqual(err.recordedFailure, {
          version: 'digital-twin-router.recorded-failure/v1',
          cassetteName,
          storeDir: cassetteDir,
          cassettePath: path.join(cassetteDir, `${cassetteName}.json`),
          interactionId: 'entry_test_replay_1',
          requestHash: 'hash_test_replay_1',
          recordedAt: '2026-03-14T22:00:00.000Z',
          request: {
            method: 'GET',
            url: 'https://api.example.com/error'
          }
        });
        assert.deepStrictEqual(err.debug, {
          why: 'teapot',
          response: {
            status: 418,
            headers: { 'x-request-id': 'req_replay_123' },
            data: { error: { code: 418, message: 'teapot' } }
          }
        });
        assert.strictEqual(err.__digitalTwinRecordedError, true);
        return true;
      }
    );
  });

  test('appends to existing cassette', async () => {
    // Pre-create cassette with one interaction using a named subdir
    const cassetteName = 'multi';
    const cassetteDir = path.join(tempStore, cassetteName);
    fs.mkdirSync(cassetteDir, { recursive: true });

    const { TwinStore, TwinEngine } = require('digital-twin-core');
    const store = new TwinStore({ storeDir: cassetteDir, createIfMissing: false });
    const engine = new TwinEngine({ store });
    await engine.create(cassetteName);
    await engine.record(
      { method: 'GET', url: 'https://api.example.com/first', headers: {}, body: null },
      { status: 200, headers: {}, body: { n: 1 } }
    );

    const transport = createTwinTransport({
      mode: 'record',
      twinPack: cassetteDir,
      realTransport: mockTransport({ status: 200, body: { n: 2 } }),
      engineOptions: { createIfMissing: false }
    });

    await transport.complete({
      method: 'GET',
      url: 'https://api.example.com/second',
      headers: {},
      body: null
    });

    // Check that cassette now has 2 interactions
    const cassette = await store.read(cassetteName);
    assert.strictEqual(cassette.interactions.length, 2);
    assert.strictEqual(cassette.interactions[1].response.body.n, 2);
  });
});

describe('resolveTwinPack', () => {
  let tempStore;

  beforeEach(() => {
    tempStore = tempDir();
  });

  afterEach(() => {
    try {
      fs.rmSync(tempStore, { recursive: true, force: true });
    } catch (e) {}
  });

  test('resolves existing absolute path', () => {
    const resolved = resolveTwinPack(tempStore);
    assert.strictEqual(resolved, path.resolve(tempStore));
  });

  test('resolves existing relative path', () => {
    const cwd = process.cwd();
    const relPath = path.relative(cwd, tempStore);
    const resolved = resolveTwinPack(relPath);
    assert.strictEqual(resolved, path.resolve(tempStore));
  });

  test('throws if path does not exist and cannot be resolved as package', () => {
    assert.throws(
      () => resolveTwinPack('nonexistent-dir-or-pkg'),
      /Cannot resolve twinPack/
    );
  });
});

describe('createTwinTransport - cassette resolution', () => {
  let tempStore;

  beforeEach(() => {
    tempStore = tempDir();
    // Clear env vars that affect resolution
    delete process.env.NODE_ENV;
    delete process.env.DIGITAL_TWIN_MODE;
    delete process.env.DIGITAL_TWIN_CASSETTE;
  });

  afterEach(() => {
    try {
      fs.rmSync(tempStore, { recursive: true, force: true });
    } catch (e) {}
    delete process.env.DIGITAL_TWIN_CASSETTE;
  });

  test('uses manifest.defaultCassetteId when present', () => {
    const packDir = path.join(tempStore, 'mypack');
    fs.mkdirSync(packDir, { recursive: true });

    // Create a cassette with a specific ID (does not match parent dir name)
    const cassetteId = 'my-special-cassette';
    const cassettePath = path.join(packDir, `${cassetteId}.json`);
    fs.writeFileSync(cassettePath, JSON.stringify({
      version: '1.0',
      meta: { name: cassetteId },
      interactions: []
    }));

    // Create manifest.json with defaultCassetteId
    const manifestPath = path.join(packDir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      packType: 'twin-pack',
      name: 'mypack',
      defaultCassetteId: cassetteId,
      cassettes: [`${cassetteId}.json`]
    }));

    const transport = createTwinTransport({
      mode: 'replay',
      twinPack: packDir,
      engineOptions: { createIfMissing: false }
    });

    assert.strictEqual(transport.getCassetteName(), cassetteId);
  });

  test('DIGITAL_TWIN_CASSETTE env var overrides manifest', () => {
    const packDir = path.join(tempStore, 'mypack');
    fs.mkdirSync(packDir, { recursive: true });

    // Create two cassettes
    const cassetteA = 'cassette-a';
    const cassetteB = 'cassette-b';
    fs.writeFileSync(path.join(packDir, `${cassetteA}.json`), JSON.stringify({
      version: '1.0', meta: { name: cassetteA }, interactions: []
    }));
    fs.writeFileSync(path.join(packDir, `${cassetteB}.json`), JSON.stringify({
      version: '1.0', meta: { name: cassetteB }, interactions: []
    }));

    // Manifest points to cassette-a
    fs.writeFileSync(path.join(packDir, 'manifest.json'), JSON.stringify({
      packType: 'twin-pack',
      name: 'mypack',
      defaultCassetteId: cassetteA,
      cassettes: [`${cassetteA}.json`, `${cassetteB}.json`]
    }));

    // Set env to cassette-b
    process.env.DIGITAL_TWIN_CASSETTE = cassetteB;

    const transport = createTwinTransport({
      mode: 'replay',
      twinPack: packDir,
      engineOptions: { createIfMissing: false }
    });

    assert.strictEqual(transport.getCassetteName(), cassetteB);
  });

  test('detects cassettes/ subdirectory and uses it as storeDir', () => {
    const packDir = path.join(tempStore, 'mypack');
    const cassettesDir = path.join(packDir, 'cassettes');
    fs.mkdirSync(cassettesDir, { recursive: true });

    // Create cassette inside cassettes/ with a specific name
    const cassetteId = 'pack-dir-cassette';
    fs.writeFileSync(path.join(cassettesDir, `${cassetteId}.json`), JSON.stringify({
      version: '1.0', meta: { name: cassetteId }, interactions: []
    }));

    // Use env var to specify cassette name (avoid fallback)
    process.env.DIGITAL_TWIN_CASSETTE = cassetteId;

    const transport = createTwinTransport({
      mode: 'replay',
      twinPack: packDir,
      engineOptions: { createIfMissing: false }
    });

    assert.strictEqual(transport.getCassetteName(), cassetteId);
    // Verify storePath (twinPack root) is still packDir
    assert.strictEqual(transport.getStorePath(), packDir);
  });

  test('manifest and cassettes/ subdir combine correctly', () => {
    const packDir = path.join(tempStore, 'mypack');
    const cassettesDir = path.join(packDir, 'cassettes');
    fs.mkdirSync(cassettesDir, { recursive: true });

    const cassetteId = 'combined-test';
    fs.writeFileSync(path.join(cassettesDir, `${cassetteId}.json`), JSON.stringify({
      version: '1.0', meta: { name: cassetteId }, interactions: []
    }));

    // Manifest in packDir
    fs.writeFileSync(path.join(packDir, 'manifest.json'), JSON.stringify({
      packType: 'twin-pack',
      name: 'mypack',
      defaultCassetteId: cassetteId,
      cassettes: [`cassettes/${cassetteId}.json`]
    }));

    const transport = createTwinTransport({
      mode: 'replay',
      twinPack: packDir,
      engineOptions: { createIfMissing: false }
    });

    assert.strictEqual(transport.getCassetteName(), cassetteId);
  });
});
