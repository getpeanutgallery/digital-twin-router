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
