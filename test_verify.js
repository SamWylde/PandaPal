
import manifestFn from './api/manifest.js';
import configureFn from './api/configure.js';

// Mock Response object
class MockRes {
    constructor(name) {
        this.name = name;
        this.headers = {};
        this.body = '';
        this.finished = false;
    }

    setHeader(key, value) {
        this.headers[key] = value;
    }

    end(body) {
        this.body = body;
        this.finished = true;
        // console.log(`[${this.name}] Response ended. Length: ${body ? body.length : 0}`);
    }
}

// Mock Request object
const mockReq = (query = {}) => ({
    query,
    headers: {
        'x-forwarded-proto': 'http',
        'host': 'localhost:3000'
    }
});

async function runTests() {
    console.log('--- Starting Verification Tests ---');
    let passed = 0;
    let failed = 0;

    // Test 1: Manifest Generation (Default)
    try {
        const req = mockReq();
        const res = new MockRes('Manifest');
        await manifestFn(req, res);

        const data = JSON.parse(res.body);
        if (data.id === 'brazuca.pandapal' && data.name === 'PandaPal') {
            console.log('✅ Manifest: Valid ID and Name');
            passed++;
        } else {
            console.error('❌ Manifest: Invalid ID or Name', data.id, data.name);
            failed++;
        }
    } catch (e) {
        console.error('❌ Manifest: Error in execution', e);
        failed++;
    }

    // Test 2: Configure Page Generation
    try {
        const req = mockReq();
        const res = new MockRes('Configure');
        await configureFn(req, res);

        if (typeof res.body === 'string' && res.body.includes('<!DOCTYPE html>') && res.body.includes('PandaPal')) {
            console.log('✅ Configure: Valid HTML generated');
            passed++;
        } else {
            console.error('❌ Configure: Invalid HTML output');
            // console.log(res.body.substring(0, 100));
            failed++;
        }
    } catch (e) {
        console.error('❌ Configure: Error in execution', e);
        failed++;
    }

    // Test 3: Manifest with Catalog Config
    try {
        const req = mockReq({ configs: 'catalogs=netflix,trending|providers=yts' });
        const res = new MockRes('Manifest Configured');
        await manifestFn(req, res);

        const data = JSON.parse(res.body);
        // Note: Python sidebar logic won't run here, so we verify we didn't crash
        if (data.id === 'brazuca.pandapal') {
            console.log('✅ Configured Manifest: Handled valid config string');
            passed++;
        } else {
            console.error('❌ Configured Manifest: Failed to handle config');
            failed++;
        }

    } catch (e) {
        console.error('❌ Configured Manifest: Error in execution', e);
        failed++;
    }

    console.log('--- Test Summary ---');
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}`);

    if (failed > 0) process.exit(1);
}

runTests();
