/**
 * Kinematics integration tests
 * Tests the WASM kinematics functions work correctly
 * Run with: node tests/kinematics-node.test.js
 */

const fs = require('fs');
const path = require('path');

// Simple test framework
class TestRunner {
  constructor(name) {
    this.name = name;
    this.tests = [];
    this.passed = 0;
    this.failed = 0;
  }

  test(description, fn) {
    this.tests.push({ description, fn });
  }

  async run() {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Running: ${this.name}`);
    console.log(`${'='.repeat(60)}\n`);

    for (const test of this.tests) {
      try {
        await test.fn();
        this.passed++;
        console.log(`✓ ${test.description}`);
      } catch (error) {
        this.failed++;
        console.log(`✗ ${test.description}`);
        console.log(`  Error: ${error.message}`);
      }
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Results: ${this.passed} passed, ${this.failed} failed`);
    console.log(`${'='.repeat(60)}\n`);

    return this.failed === 0;
  }
}

// Helper functions
function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

function assertClose(actual, expected, tolerance, message) {
  const diff = Math.abs(actual - expected);
  if (diff >= tolerance) {
    throw new Error(`${message}: expected ${expected}, got ${actual} (diff: ${diff})`);
  }
}

function assertArrayClose(actual, expected, tolerance) {
  assert(actual.length === expected.length, `Array length mismatch: expected ${expected.length}, got ${actual.length}`);
  for (let i = 0; i < actual.length; i++) {
    assertClose(actual[i], expected[i], tolerance, `Index ${i}`);
  }
}

// Main test suite
async function main() {
  // Load WASM using Node's WebAssembly API
  const wasmPath = path.join(__dirname, '..', 'pkg', 'index_bg.wasm');

  if (!fs.existsSync(wasmPath)) {
    console.error('WASM file not found. Run `npm run build` first.');
    process.exit(1);
  }

  const wasmBuffer = fs.readFileSync(wasmPath);
  const wasmModule = await WebAssembly.instantiate(wasmBuffer, {
    './index_bg.js': {
      __wbg_new_abda76e883ba8a5f: () => {},
      __wbg_stack_658279fe44541cf6: () => '',
      __wbg_error_f851667af71bcfc6: () => {},
      __wbindgen_object_drop_ref: () => {},
      __wbindgen_throw: (ptr, len) => {
        throw new Error('WASM throw');
      }
    }
  });

  const wasm = wasmModule.instance.exports;

  // Helper to convert JS array to WASM memory
  function createFloat32Array(arr) {
    const ptr = wasm.__wbindgen_malloc(arr.length * 4);
    const view = new Float32Array(wasm.memory.buffer, ptr, arr.length);
    view.set(arr);
    return ptr;
  }

  function readFloat32Array(ptr, len) {
    const view = new Float32Array(wasm.memory.buffer, ptr, len);
    return Array.from(view);
  }

  // Wrapper functions
  function forward_kinematics(joints) {
    const inputPtr = createFloat32Array(joints);
    const resultPtr = wasm.forward_kinematics(inputPtr, joints.length);
    const result = readFloat32Array(resultPtr, 6);
    wasm.__wbindgen_free(inputPtr, joints.length * 4);
    return result;
  }

  function inverse_kinematics(coords) {
    const inputPtr = createFloat32Array(coords);
    const resultPtr = wasm.inverse_kinematics(inputPtr, coords.length);
    const result = readFloat32Array(resultPtr, 6);
    wasm.__wbindgen_free(inputPtr, coords.length * 4);
    return result;
  }

  const runner = new TestRunner('Kinematics WASM Integration Tests');

  // Test 1: Minimum height (Z=0)
  runner.test('FK/IK round-trip at minimum height [0, 0, 0, 0, 0, 0]', () => {
    const originalCoords = [0, 0, 0, 0, 0, 0];
    const joints = inverse_kinematics(originalCoords);

    assert(!joints.some(j => isNaN(j)), 'IK should not return NaN');

    const reconstructedCoords = forward_kinematics(joints);
    assertArrayClose(reconstructedCoords, originalCoords, 10);
  });

  // Test 2: Translation
  runner.test('FK/IK round-trip with translation [10, 20, 10, 0, 0, 0]', () => {
    const originalCoords = [10, 20, 10, 0, 0, 0];
    const joints = inverse_kinematics(originalCoords);

    assert(!joints.some(j => isNaN(j)), 'IK should not return NaN for valid position');

    const reconstructedCoords = forward_kinematics(joints);
    assertArrayClose(reconstructedCoords, originalCoords, 10);
  });

  // Test 3: Rotation
  runner.test('FK/IK round-trip with rotation [0, 0, 0, 10, 15, 5]', () => {
    const originalCoords = [0, 0, 0, 10, 15, 5];
    const joints = inverse_kinematics(originalCoords);

    assert(!joints.some(j => isNaN(j)), 'IK should not return NaN for valid rotation');

    const reconstructedCoords = forward_kinematics(joints);
    assertArrayClose(reconstructedCoords, originalCoords, 10);
  });

  // Test 4: Combined
  runner.test('FK/IK round-trip with translation and rotation', () => {
    const originalCoords = [5, -10, 10, 5, -10, 8];
    const joints = inverse_kinematics(originalCoords);

    assert(!joints.some(j => isNaN(j)), 'IK should not return NaN');

    const reconstructedCoords = forward_kinematics(joints);
    assertArrayClose(reconstructedCoords, originalCoords, 10);
  });

  // Test 5: Invalid position (below minimum Z)
  runner.test('IK should fail for unreachable position [0, 0, -10, 0, 0, 0]', () => {
    const coords = [0, 0, -10, 0, 0, 0];
    const joints = inverse_kinematics(coords);

    // Should produce NaN or invalid values (Z < 0 is below minimum)
    assert(joints.some(j => isNaN(j) || Math.abs(j) > 360),
           'IK should return invalid values for Z < 0');
  });

  // Test 6: Multiple conversions maintain consistency
  runner.test('Multiple FK/IK conversions maintain consistency', () => {
    let coords = [0, 0, 0, 0, 0, 0];

    for (let i = 0; i < 5; i++) {
      const joints = inverse_kinematics(coords);
      coords = forward_kinematics(joints);
    }

    assertArrayClose(coords, [0, 0, 0, 0, 0, 0], 10);
  });

  const success = await runner.run();
  process.exit(success ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
