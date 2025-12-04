/**
 * Kinematics tests for forward and inverse kinematics functions
 * Tests the JavaScript/WASM interface for coordinate transformations
 */

// Load the WASM module
const wasm = require('../pkg/index.js');

describe('Kinematics', () => {

  describe('Inverse Kinematics', () => {
    test('should work with minimum height [0, 0, 0, 0, 0, 0]', () => {
      const coords = [0, 0, 0, 0, 0, 0];
      const joints = wasm.inverse_kinematics(coords);

      expect(joints).toBeDefined();
      expect(joints.length).toBe(6);
      expect(joints.every(j => !isNaN(j))).toBe(true);
    });

    test('should fail with invalid position [0, 0, -10, 0, 0, 0] - below minimum Z', () => {
      const coords = [0, 0, -10, 0, 0, 0];
      const joints = wasm.inverse_kinematics(coords);

      // Should return NaN values because position is unreachable (Z < 0)
      expect(joints.some(j => isNaN(j))).toBe(true);
    });

    test('should work with translation [10, 20, 10, 0, 0, 0]', () => {
      const coords = [10, 20, 10, 0, 0, 0];
      const joints = wasm.inverse_kinematics(coords);

      expect(joints).toBeDefined();
      expect(joints.length).toBe(6);
      expect(joints.every(j => !isNaN(j))).toBe(true);
    });

    test('should work with rotation [0, 0, 0, 10, 15, 5]', () => {
      const coords = [0, 0, 0, 10, 15, 5];
      const joints = wasm.inverse_kinematics(coords);

      expect(joints).toBeDefined();
      expect(joints.length).toBe(6);
      expect(joints.every(j => !isNaN(j))).toBe(true);
    });

    test('should work with combined translation and rotation [5, -10, 10, 5, -10, 8]', () => {
      const coords = [5, -10, 10, 5, -10, 8];
      const joints = wasm.inverse_kinematics(coords);

      expect(joints).toBeDefined();
      expect(joints.length).toBe(6);
      expect(joints.every(j => !isNaN(j))).toBe(true);
    });
  });

  describe('Forward Kinematics', () => {
    test('should work with default joint angles', () => {
      // Default pose joint angles (in degrees)
      const joints = [31.33, -39.60, 36.04, -36.04, 39.60, -31.33];
      const coords = wasm.forward_kinematics(joints);

      expect(coords).toBeDefined();
      expect(coords.length).toBe(6);
      expect(coords.every(c => !isNaN(c))).toBe(true);
    });

    test('should return coordinates with valid Z height', () => {
      const joints = [0, 0, 0, 0, 0, 0];
      const coords = wasm.forward_kinematics(joints);

      expect(coords).toBeDefined();
      expect(coords[2]).toBeGreaterThanOrEqual(-10); // Z should be >= -10mm (allowing some tolerance)
      expect(coords[2]).toBeLessThan(100); // Z should be < 100mm from minimum
    });
  });

  describe('Forward/Inverse Kinematics Round-trip', () => {
    function expectCoordsClose(actual, expected, tolerance = 10) {
      for (let i = 0; i < 6; i++) {
        expect(Math.abs(actual[i] - expected[i])).toBeLessThan(tolerance);
      }
    }

    test('should round-trip at minimum height', () => {
      const originalCoords = [0, 0, 0, 0, 0, 0];

      const joints = wasm.inverse_kinematics(originalCoords);
      const reconstructedCoords = wasm.forward_kinematics(joints);

      expectCoordsClose(reconstructedCoords, originalCoords);
    });

    test('should round-trip with translation', () => {
      const originalCoords = [10, 20, 10, 0, 0, 0];

      const joints = wasm.inverse_kinematics(originalCoords);
      expect(joints.every(j => !isNaN(j))).toBe(true);

      const reconstructedCoords = wasm.forward_kinematics(joints);
      expectCoordsClose(reconstructedCoords, originalCoords);
    });

    test('should round-trip with rotation', () => {
      const originalCoords = [0, 0, 0, 10, 15, 5];

      const joints = wasm.inverse_kinematics(originalCoords);
      expect(joints.every(j => !isNaN(j))).toBe(true);

      const reconstructedCoords = wasm.forward_kinematics(joints);
      expectCoordsClose(reconstructedCoords, originalCoords);
    });

    test('should round-trip with combined translation and rotation', () => {
      const originalCoords = [5, -10, 10, 5, -10, 8];

      const joints = wasm.inverse_kinematics(originalCoords);
      expect(joints.every(j => !isNaN(j))).toBe(true);

      const reconstructedCoords = wasm.forward_kinematics(joints);
      expectCoordsClose(reconstructedCoords, originalCoords);
    });

    test('should maintain consistency across multiple conversions', () => {
      const originalCoords = [0, 0, 0, 0, 0, 0];

      // Convert multiple times
      let coords = originalCoords;
      for (let i = 0; i < 5; i++) {
        const joints = wasm.inverse_kinematics(coords);
        coords = wasm.forward_kinematics(joints);
      }

      expectCoordsClose(coords, originalCoords);
    });
  });

  describe('Edge Cases', () => {
    test('should handle small translations', () => {
      const coords = [1, 1, 1, 0, 0, 0];
      const joints = wasm.inverse_kinematics(coords);

      expect(joints.every(j => !isNaN(j))).toBe(true);
    });

    test('should handle small rotations', () => {
      const coords = [0, 0, 0, 1, 1, 1];
      const joints = wasm.inverse_kinematics(coords);

      expect(joints.every(j => !isNaN(j))).toBe(true);
    });

    test('should handle negative coordinates', () => {
      const coords = [-10, -10, 10, 0, 0, 0];
      const joints = wasm.inverse_kinematics(coords);

      expect(joints.every(j => !isNaN(j))).toBe(true);
    });

    test('should handle negative rotations', () => {
      const coords = [0, 0, 0, -10, -10, -10];
      const joints = wasm.inverse_kinematics(coords);

      expect(joints.every(j => !isNaN(j))).toBe(true);
    });
  });

  describe('Physical Constraints', () => {
    test('should document minimum Z height (Z=0 in user coordinates)', () => {
      // This test documents the physical constraint
      // Z=0 is now the minimum height (internally HEAD_Z_OFFSET = 177mm)
      const minZ = 0;
      const coords = [0, 0, minZ, 0, 0, 0];
      const joints = wasm.inverse_kinematics(coords);

      expect(joints.every(j => !isNaN(j))).toBe(true);
    });

    test('should show that Z < 0 produces unreachable positions', () => {
      // Below minimum height
      const coords = [0, 0, -10, 0, 0, 0];
      const joints = wasm.inverse_kinematics(coords);

      // Should produce NaN or invalid joint angles
      expect(joints.some(j => isNaN(j))).toBe(true);
    });

    test('should work at reasonable Z offsets above minimum', () => {
      // Test various Z heights above minimum
      const zOffsets = [0, 10, 20, 30, 40, 50];

      for (const offset of zOffsets) {
        const coords = [0, 0, offset, 0, 0, 0];
        const joints = wasm.inverse_kinematics(coords);

        expect(joints.every(j => !isNaN(j))).toBe(true);
      }
    });
  });
});
