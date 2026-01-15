const puppeteer = require('puppeteer');

describe('JS to Blockly Converter', () => {
  let browser;
  let page;

  beforeAll(async () => {
    browser = await puppeteer.launch({ headless: true });
    page = await browser.newPage();
    // Load the blockly page - assumes webpack dev server is running
    await page.goto('http://127.0.0.1:8081/blockly.html', { waitUntil: 'networkidle0' });
  });

  afterAll(async () => {
    await browser.close();
  });

  async function testConversion(jsCode) {
    return await page.evaluate((code) => {
      workspace.clear();
      const result = jsToBlocks(code);
      const blocks = workspace.getAllBlocks();
      const topBlocks = workspace.getTopBlocks(false);
      const generatedCode = Blockly.JavaScript.workspaceToCode(workspace);

      // Count orphan blocks (blocks that should be connected but aren't)
      // A block is orphan if it's a top block but not a statement block
      let orphanBlocks = [];
      blocks.forEach(b => {
        // Check if this block has no parent and is not a top-level statement
        if (!b.getParent() && !b.previousConnection) {
          // This is a top block - check if it should be
          // Value blocks (with output) shouldn't be top blocks unless they're shadow
          if (b.outputConnection && !b.isShadow()) {
            orphanBlocks.push({ type: b.type, id: b.id });
          }
        }
      });

      return {
        success: result.success,
        error: result.error,
        blockCount: blocks.length,
        topBlockCount: topBlocks.length,
        blockTypes: blocks.map(b => b.type),
        generatedCode: generatedCode,
        orphanBlocks: orphanBlocks
      };
    }, jsCode);
  }

  test('Simple function call', async () => {
    const result = await testConversion('Robot.setPositionLimited(17, 2048);');
    expect(result.success).toBe(true);
    expect(result.blockTypes).toContain('set_joint');
    expect(result.orphanBlocks).toHaveLength(0);
  });

  test('Variable declaration with number', async () => {
    const result = await testConversion('let x = 100;');
    expect(result.success).toBe(true);
    expect(result.blockTypes).toContain('variables_set');
    expect(result.orphanBlocks).toHaveLength(0);
  });

  test('Variable with function call', async () => {
    const result = await testConversion('let pos = Robot.getPosition(17);');
    expect(result.success).toBe(true);
    expect(result.blockTypes).toContain('variables_set');
    expect(result.blockTypes).toContain('get_joint');
    expect(result.orphanBlocks).toHaveLength(0);
  });

  test('For loop', async () => {
    const result = await testConversion('for (let i = 0; i < 5; i++) { logConsole("test"); }');
    expect(result.success).toBe(true);
    expect(result.blockTypes).toContain('controls_for');
    expect(result.blockTypes).toContain('log');
    expect(result.orphanBlocks).toHaveLength(0);
  });

  test('String concatenation', async () => {
    const result = await testConversion('logConsole("Value: " + x);');
    expect(result.success).toBe(true);
    expect(result.blockTypes).toContain('log');
    expect(result.blockTypes).toContain('text_join');
    expect(result.orphanBlocks).toHaveLength(0);
  });

  test('Multi-part string concatenation', async () => {
    const result = await testConversion('logConsole("Motor " + i + " pos: " + pos);');
    expect(result.success).toBe(true);
    expect(result.blockTypes).toContain('text_join');
    expect(result.orphanBlocks).toHaveLength(0);
  });

  test('If statement', async () => {
    const result = await testConversion('if (x > 10) { logConsole("big"); }');
    expect(result.success).toBe(true);
    expect(result.blockTypes).toContain('controls_if');
    expect(result.orphanBlocks).toHaveLength(0);
  });

  test('If-else statement', async () => {
    const result = await testConversion('if (x > 10) { logConsole("big"); } else { logConsole("small"); }');
    expect(result.success).toBe(true);
    expect(result.blockTypes).toContain('controls_if');
    expect(result.orphanBlocks).toHaveLength(0);
  });

  test('Array literal', async () => {
    const result = await testConversion('let arr = [1, 2, 3];');
    expect(result.success).toBe(true);
    expect(result.blockTypes).toContain('lists_create_with');
    expect(result.orphanBlocks).toHaveLength(0);
  });

  test('Array with expressions - coordinates pattern', async () => {
    const result = await testConversion(`
      var currentCoords = Robot.getCurrentCoordinates();
      var coordsUp = [currentCoords[0], currentCoords[1], currentCoords[2] + 10, currentCoords[3], currentCoords[4], currentCoords[5]];
    `);
    expect(result.success).toBe(true);
    expect(result.blockTypes).toContain('lists_create_with');
    expect(result.blockTypes).toContain('lists_getIndex');
    expect(result.blockTypes).toContain('math_arithmetic');
    expect(result.orphanBlocks).toHaveLength(0);
  });

  test('Array length', async () => {
    const result = await testConversion('let len = arr.length;');
    expect(result.success).toBe(true);
    expect(result.blockTypes).toContain('lists_length');
    expect(result.orphanBlocks).toHaveLength(0);
  });

  test('Array index access', async () => {
    const result = await testConversion('let val = arr[0];');
    expect(result.success).toBe(true);
    expect(result.blockTypes).toContain('lists_getIndex');
    expect(result.orphanBlocks).toHaveLength(0);
  });

  test('Array index assignment', async () => {
    const result = await testConversion('arr[0] = 100;');
    expect(result.success).toBe(true);
    expect(result.blockTypes).toContain('lists_setIndex');
    expect(result.orphanBlocks).toHaveLength(0);
  });

  test('Multiple statements chain correctly', async () => {
    const result = await testConversion(`
      Robot.setPositionLimited(17, 2048);
      wait(1);
      logConsole("done");
    `);
    expect(result.success).toBe(true);
    expect(result.topBlockCount).toBe(3);
    expect(result.orphanBlocks).toHaveLength(0);
  });

  test('Kinematics - getAllPositions', async () => {
    const result = await testConversion('let positions = Robot.getAllPositions();');
    expect(result.success).toBe(true);
    expect(result.blockTypes).toContain('get_all_joints');
    expect(result.orphanBlocks).toHaveLength(0);
  });

  test('Kinematics - jointsToDegrees', async () => {
    const result = await testConversion('let degrees = Robot.jointsToDegrees(positions);');
    expect(result.success).toBe(true);
    expect(result.blockTypes).toContain('joints_to_degrees');
    expect(result.orphanBlocks).toHaveLength(0);
  });

  test('Kinematics - coordinatesToJoints', async () => {
    const result = await testConversion('let joints = Robot.coordinatesToJoints(coords);');
    expect(result.success).toBe(true);
    expect(result.blockTypes).toContain('coordinates_to_joints');
    expect(result.orphanBlocks).toHaveLength(0);
  });

  test('Kinematics - getCurrentCoordinates', async () => {
    const result = await testConversion('let coords = Robot.getCurrentCoordinates();');
    expect(result.success).toBe(true);
    expect(result.blockTypes).toContain('get_current_coordinates');
    expect(result.orphanBlocks).toHaveLength(0);
  });

  test('Full kinematics workflow', async () => {
    const result = await testConversion(`
      var currentCoords = Robot.getCurrentCoordinates();
      var coordsUp = [currentCoords[0], currentCoords[1], currentCoords[2] + 10, currentCoords[3], currentCoords[4], currentCoords[5]];
      var jointsUp = Robot.coordinatesToJoints(coordsUp);
      Robot.setAllPositions(Robot.degreesToJoints(jointsUp));
      wait(1);
    `);
    expect(result.success).toBe(true);
    expect(result.blockTypes).toContain('get_current_coordinates');
    expect(result.blockTypes).toContain('lists_create_with');
    expect(result.blockTypes).toContain('coordinates_to_joints');
    expect(result.blockTypes).toContain('degrees_to_joints');
    expect(result.blockTypes).toContain('set_all_joints');
    expect(result.orphanBlocks).toHaveLength(0);
  });

  test('Head nodding with kinematics', async () => {
    const result = await testConversion(`
      Robot.setTorqueMultiple(Robot.motorIds, true);
      var baseCoords = Robot.getCurrentCoordinates();
      for (var i = 0; i < 5; i++) {
        var upCoords = [baseCoords[0], baseCoords[1], baseCoords[2] + 5, baseCoords[3], baseCoords[4], baseCoords[5]];
        var upJoints = Robot.coordinatesToJoints(upCoords);
        Robot.setAllPositions(Robot.degreesToJoints(upJoints));
        wait(0.5);
        var downCoords = [baseCoords[0], baseCoords[1], baseCoords[2] - 5, baseCoords[3], baseCoords[4], baseCoords[5]];
        var downJoints = Robot.coordinatesToJoints(downCoords);
        Robot.setAllPositions(Robot.degreesToJoints(downJoints));
        wait(0.5);
      }
    `);
    expect(result.success).toBe(true);
    expect(result.blockTypes).toContain('enable_all');
    expect(result.blockTypes).toContain('get_current_coordinates');
    expect(result.blockTypes).toContain('controls_for');
    expect(result.blockTypes).toContain('lists_create_with');
    expect(result.blockTypes).toContain('coordinates_to_joints');
    expect(result.orphanBlocks).toHaveLength(0);
  });

  test('Complex example - log all positions', async () => {
    const result = await testConversion(`
      var positions = Robot.getAllPositions();
      for (var i = 0; i < positions.length; i++) {
        logConsole("Motor " + (11 + i) + " position: " + positions[i]);
      }
    `);
    expect(result.success).toBe(true);
    expect(result.blockTypes).toContain('get_all_joints');
    expect(result.blockTypes).toContain('controls_for');
    expect(result.blockTypes).toContain('log');
    expect(result.orphanBlocks).toHaveLength(0);
  });

  test('Compound assignment +=', async () => {
    const result = await testConversion('x += 10;');
    expect(result.success).toBe(true);
    expect(result.blockTypes).toContain('variables_set');
    expect(result.blockTypes).toContain('math_arithmetic');
    expect(result.orphanBlocks).toHaveLength(0);
  });

  test('Math functions', async () => {
    const result = await testConversion('var y = Math.floor(x / 10);');
    expect(result.success).toBe(true);
    expect(result.blockTypes).toContain('math_single');
    expect(result.orphanBlocks).toHaveLength(0);
  });

  test('Roundtrip - simple set and wait', async () => {
    const original = 'Robot.setPositionLimited(17, 2048);\nwait(1);';
    const result = await testConversion(original);
    expect(result.success).toBe(true);
    // Check that generated code contains the key operations
    expect(result.generatedCode).toContain('setPositionLimited');
    expect(result.generatedCode).toContain('17');
    expect(result.generatedCode).toContain('2048');
    expect(result.orphanBlocks).toHaveLength(0);
  });

  test('Roundtrip - kinematics workflow', async () => {
    const result = await testConversion(`
      var coords = Robot.getCurrentCoordinates();
      coords[2] += 5;
      var joints = Robot.coordinatesToJoints(coords);
      Robot.setAllPositions(Robot.degreesToJoints(joints));
    `);
    expect(result.success).toBe(true);
    expect(result.generatedCode).toContain('forward_kinematics');
    expect(result.generatedCode).toContain('inverse_kinematics');
    expect(result.orphanBlocks).toHaveLength(0);
  });
});
