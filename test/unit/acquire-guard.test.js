'use strict';

const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Worker } = require('worker_threads');
const { describe, test } = require('node:test');
const evernode = require('evernode-js-client');
const kp = require('ripple-keypairs');

const FAST_LIMIT_MS = 2000;
const FIXED_LCL_HASH = '1a20bec21ef8038f32eaed2f4d1907b9f0bdcc02e05d1ee09b199ac13db6518a';
const RUNNER = path.join(__dirname, '../fixtures/acquire-cluster-run.js');
const CONTEXT_ENTRY = path.join(__dirname, '../../dist/context/EvernodeContext.js');

describe('acquire encrypt entry rejects an invalid ephemeral key', { concurrency: 1 }, () => {
    test('a zero ephemeral key throws a normal error in under 2 seconds', async () => {
        await assertAcquireRejects('zero');
    });

    test('a curve-order ephemeral key throws a normal error in under 2 seconds', async () => {
        await assertAcquireRejects('order');
    });

    test('a library-derived ephemeral key still encrypts', async () => {
        const { publicKey } = hostKey();
        const { derivePrivateKey } = require('ripple-keypairs/dist/secp256k1');
        const key = derivePrivateKey(Buffer.from('everpocket-acquire-guard'), { validator: true }).toArrayLike(Buffer, 'be', 32);
        const started = Date.now();
        const encrypted = await evernode.EncryptionHelper.encrypt(publicKey, { ping: 1 }, {
            iv: crypto.randomBytes(16),
            ephemPrivateKey: key
        });
        assert.equal(typeof encrypted, 'string', 'a valid ephemeral key must encrypt');
        assert.ok(Date.now() - started < FAST_LIMIT_MS, 'a valid ephemeral key must encrypt quickly');
    });

    test('loading EvernodeContext does not replace EncryptionHelper.encrypt', () => {
        const child = spawnSync(process.execPath, ['-e', `
            const evernode = require('evernode-js-client');
            const before = evernode.EncryptionHelper.encrypt;
            require(${JSON.stringify(CONTEXT_ENTRY)});
            if (evernode.EncryptionHelper.encrypt !== before) {
                console.error('EncryptionHelper.encrypt was replaced');
                process.exit(1);
            }
        `], { cwd: path.join(__dirname, '../..'), encoding: 'utf8' });
        assert.equal(child.status, 0, `requiring EvernodeContext must leave EncryptionHelper.encrypt untouched\n${child.stdout}\n${child.stderr}`);
    });
});

describe('Math.random stays banned with inline config disabled', { concurrency: 1 }, () => {
    test('eslint --no-inline-config rejects Math.random in src', () => {
        const eslint = path.join(__dirname, '../../node_modules/.bin/eslint');
        const config = path.join(__dirname, '../../.eslintrc.json');
        const source = spawnSync(eslint, ['-c', config, '--no-inline-config', '--ext', '.ts', path.join(__dirname, '../../src')], {
            cwd: path.join(__dirname, '../..'),
            encoding: 'utf8'
        });
        assert.equal(source.status, 0, `Math.random must not be used in src, including behind an inline disable\n${source.stdout}\n${source.stderr}`);
    });
});

async function assertAcquireRejects(fault) {
    let outcome;
    try {
        outcome = await acquireInWorker({ ephemeralKeyFault: fault });
    } catch (error) {
        if (error && error.timedOut)
            assert.fail('encrypt did not reject out-of-range key within 2s');
        throw error;
    }
    assert.ok(outcome.elapsed < FAST_LIMIT_MS, `invalid ephemeral key must fail in under ${FAST_LIMIT_MS}ms, took ${outcome.elapsed}ms`);
    const report = outcome.report;
    assert.match((report.errors || []).join('\n'), /acquire ephemeral key is not a valid secp256k1 private key/);
    assert.equal(report.attempts, 0, 'an invalid ephemeral key must not reach the ledger');
    assert.equal(report.landed, 0);
}

test('a derived key of 0, 31, 33, or 64 bytes is rejected', async () => {
    for (const length of [0, 31, 33, 64]) {
        let outcome;
        try {
            outcome = await acquireInWorker({ derivedKeyLength: length });
        } catch (error) {
            if (error && error.timedOut)
                assert.fail('derived key was not rejected with an error');
            throw error;
        }
        const report = outcome.report;
        const errors = (report.errors || []).join('\n');
        assert.match(errors, /Error|acquire ephemeral key/, `a ${length}-byte derived key must be rejected with an Error`);
        assert.equal(report.landed, 0, `a ${length}-byte derived key must not land`);
        assert.equal(report.attempts, 0, `a ${length}-byte derived key must not be submitted`);
        assert.equal((report.uncaught || []).length, 0, `a ${length}-byte derived key must not raise an uncaught error`);
        assert.equal(report.inFlightClear, true, `a ${length}-byte derived key must clear the in-flight flag`);
    }
});

function acquireInWorker(extra) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acquire-oor-'));
    const resultPath = path.join(root, 'cluster-result.json');
    const config = {
        nodeCount: 1,
        lclHash: FIXED_LCL_HASH,
        rounds: 1,
        voteTimeout: 400,
        resultPath,
        ...extra
    };
    const previousCwd = process.cwd();
    // acquireSubmit writes acquires.json relative to cwd. A worker cannot
    // chdir, and cwd is process-global, so this test holds the temp directory
    // until that worker exits. The worker itself calls acquireSubmit.
    process.chdir(root);
    return new Promise((resolve, reject) => {
        let settled = false;
        let timedOut = false;
        let worker;
        let clock = null;
        let acquireStarted = 0;
        const restoreCwd = () => {
            try {
                process.chdir(previousCwd);
            } catch (error) {
                void error;
            }
        };
        const finish = (fn) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(setupTimer);
            if (clock)
                clearTimeout(clock);
            restoreCwd();
            fn();
        };
        // Setup is not part of the 2s budget. The budget starts when the worker
        // says it is about to call acquireSubmit.
        const setupTimer = setTimeout(() => {
            if (worker)
                worker.terminate();
            const error = new Error('worker did not reach acquireSubmit');
            error.setup = true;
            finish(() => reject(error));
        }, 60000);
        try {
            worker = new Worker(RUNNER, { workerData: config });
        } catch (error) {
            finish(() => {
                fs.rmSync(root, { recursive: true, force: true });
                reject(error);
            });
            return;
        }
        worker.on('message', (message) => {
            if (settled || clock || !message || message.event !== 'acquireSubmit')
                return;
            acquireStarted = Date.now();
            clock = setTimeout(() => {
                timedOut = true;
                worker.terminate();
            }, FAST_LIMIT_MS);
        });
        worker.once('exit', () => {
            finish(() => {
                if (timedOut) {
                    fs.rmSync(root, { recursive: true, force: true });
                    const error = new Error('encrypt did not reject out-of-range key within 2s');
                    error.timedOut = true;
                    reject(error);
                    return;
                }
                try {
                    resolve({
                        report: JSON.parse(fs.readFileSync(resultPath, 'utf8')),
                        elapsed: acquireStarted ? Date.now() - acquireStarted : 0
                    });
                } catch (error) {
                    reject(error);
                } finally {
                    fs.rmSync(root, { recursive: true, force: true });
                }
            });
        });
        worker.once('error', (error) => {
            worker.terminate();
            finish(() => {
                fs.rmSync(root, { recursive: true, force: true });
                reject(error);
            });
        });
    });
}

function hostKey() {
    const seed = kp.generateSeed({ algorithm: 'ecdsa-secp256k1' });
    return kp.deriveKeypair(seed);
}
