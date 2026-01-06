// ========== JavaScript Code Generators ==========
// This module handles JavaScript code generation from Blockly blocks

(function() {
    'use strict';

    // === Connection Blocks ===
    Blockly.JavaScript.forBlock['enable_torque'] = function(block) {
      var motor = block.getFieldValue('MOTOR');
      return 'await Robot.setTorque(' + motor + ', true);\n';
    };

    Blockly.JavaScript.forBlock['disable_torque'] = function(block) {
      var motor = block.getFieldValue('MOTOR');
      return 'await Robot.setTorque(' + motor + ', false);\n';
    };

    Blockly.JavaScript.forBlock['enable_all'] = function(block) {
      return 'await Robot.setTorqueMultiple([11,12,13,14,15,16,17,18], true);\n';
    };

    Blockly.JavaScript.forBlock['disable_all'] = function(block) {
      return 'await Robot.setTorqueMultiple([11,12,13,14,15,16,17,18], false);\n';
    };

    Blockly.JavaScript.forBlock['check_joints'] = function(block) {
      return 'await (async function() { var results = await Robot.checkAllMotors(); var ok = [], failed = []; for (var id in results) { if (results[id].ok) ok.push(id); else failed.push(id); } if (failed.length === 0) { logConsole("All " + ok.length + " joints OK", "success"); var allMotors = [11,12,13,14,15,16,17,18]; for (var i = 0; i < allMotors.length; i++) { var id = allMotors[i]; var pos = await Robot.getPosition(id); var deg = Robot.positionToDegrees(pos).toFixed(1); logConsole("Joint " + id + ": " + pos + " (" + deg + "°)", "info"); } } else { logConsole("OK: " + ok.join(", ") + " | FAILED: " + failed.join(", "), "error"); } })();\n';
    };

    Blockly.JavaScript.forBlock['ping_joint'] = function(block) {
      var motor = block.getFieldValue('MOTOR');
      return ['(await Robot.pingMotor(' + motor + ')).ok', Blockly.JavaScript.ORDER_AWAIT];
    };

    Blockly.JavaScript.forBlock['reboot_joint'] = function(block) {
      var motor = block.getFieldValue('MOTOR');
      return 'await Robot.rebootMotor(' + motor + ');\n';
    };

    Blockly.JavaScript.forBlock['reboot_all'] = function(block) {
      return 'await Robot.rebootAllMotors();\n';
    };

    // === Joint Blocks ===
    Blockly.JavaScript.forBlock['set_joint'] = function(block) {
      var motor = block.getFieldValue('MOTOR');
      var joint = Blockly.JavaScript.valueToCode(block, 'JOINT', Blockly.JavaScript.ORDER_ATOMIC) || '2048';
      return 'await Robot.setPositionLimited(' + motor + ', ' + joint + ');\n';
    };

    Blockly.JavaScript.forBlock['set_degrees'] = function(block) {
      var motor = block.getFieldValue('MOTOR');
      var deg = Blockly.JavaScript.valueToCode(block, 'DEGREES', Blockly.JavaScript.ORDER_ATOMIC) || '0';
      return 'await Robot.setDegrees(' + motor + ', ' + deg + ');\n';
    };

    Blockly.JavaScript.forBlock['get_joint'] = function(block) {
      var motor = block.getFieldValue('MOTOR');
      return ['await Robot.getPosition(' + motor + ')', Blockly.JavaScript.ORDER_AWAIT];
    };

    Blockly.JavaScript.forBlock['get_degrees'] = function(block) {
      var motor = block.getFieldValue('MOTOR');
      return ['await Robot.getDegrees(' + motor + ')', Blockly.JavaScript.ORDER_AWAIT];
    };

    Blockly.JavaScript.forBlock['move_by'] = function(block) {
      var motor = block.getFieldValue('MOTOR');
      var amount = Blockly.JavaScript.valueToCode(block, 'AMOUNT', Blockly.JavaScript.ORDER_ATOMIC) || '0';
      return 'await Robot.setDegrees(' + motor + ', (await Robot.getDegrees(' + motor + ')) + (' + amount + '));\n';
    };

    Blockly.JavaScript.forBlock['move_smooth'] = function(block) {
      var motor = block.getFieldValue('MOTOR');
      var joint = Blockly.JavaScript.valueToCode(block, 'JOINT', Blockly.JavaScript.ORDER_ATOMIC) || '2048';
      var dur = Blockly.JavaScript.valueToCode(block, 'DURATION', Blockly.JavaScript.ORDER_ATOMIC) || '1';
      return 'await Robot.moveSmooth(' + motor + ', ' + joint + ', ' + dur + ' * 1000);\n';
    };

    // === Multi-Motor Blocks ===
    Blockly.JavaScript.forBlock['get_head_coordinates'] = function(block) {
      return ['(Robot.jointsToCoordinates(await Robot.getAllPositions()))', Blockly.JavaScript.ORDER_FUNCTION_CALL];
    };

    Blockly.JavaScript.forBlock['set_head_coordinates'] = function(block) {
      var coords = Blockly.JavaScript.valueToCode(block, 'COORDS', Blockly.JavaScript.ORDER_ATOMIC) || '[0,0,0,0,0,0]';
      return 'await Robot.setAllPositions(Robot.coordinatesToJoints(' + coords + '));\n';
    };

    // === Kinematics Blocks ===
    Blockly.JavaScript.forBlock['joints_to_coordinates'] = function(block) {
      var joints = Blockly.JavaScript.valueToCode(block, 'JOINTS', Blockly.JavaScript.ORDER_ATOMIC) || '[]';
      return ['Robot.jointsToCoordinates(' + joints + ')', Blockly.JavaScript.ORDER_FUNCTION_CALL];
    };

    Blockly.JavaScript.forBlock['coordinates_to_joints'] = function(block) {
      var coordinates = Blockly.JavaScript.valueToCode(block, 'COORDINATES', Blockly.JavaScript.ORDER_ATOMIC) || '[0,0,0,0,0,0]';
      return ['Robot.coordinatesToJoints(' + coordinates + ')', Blockly.JavaScript.ORDER_FUNCTION_CALL];
    };

    Blockly.JavaScript.forBlock['create_coordinates'] = function(block) {
      var x = Blockly.JavaScript.valueToCode(block, 'X', Blockly.JavaScript.ORDER_ATOMIC) || '0';
      var y = Blockly.JavaScript.valueToCode(block, 'Y', Blockly.JavaScript.ORDER_ATOMIC) || '0';
      var z = Blockly.JavaScript.valueToCode(block, 'Z', Blockly.JavaScript.ORDER_ATOMIC) || '0';
      var roll = Blockly.JavaScript.valueToCode(block, 'ROLL', Blockly.JavaScript.ORDER_ATOMIC) || '0';
      var pitch = Blockly.JavaScript.valueToCode(block, 'PITCH', Blockly.JavaScript.ORDER_ATOMIC) || '0';
      var yaw = Blockly.JavaScript.valueToCode(block, 'YAW', Blockly.JavaScript.ORDER_ATOMIC) || '0';
      return ['[' + x + ', ' + y + ', ' + z + ', ' + roll + ', ' + pitch + ', ' + yaw + ']', Blockly.JavaScript.ORDER_ATOMIC];
    };

    Blockly.JavaScript.forBlock['get_coordinate'] = function(block) {
      var component = block.getFieldValue('COMPONENT');
      var coordinates = Blockly.JavaScript.valueToCode(block, 'COORDINATES', Blockly.JavaScript.ORDER_MEMBER) || '[0,0,0,0,0,0]';
      return ['(' + coordinates + ')[' + component + ']', Blockly.JavaScript.ORDER_MEMBER];
    };

    // === Sensing Blocks ===
    Blockly.JavaScript.forBlock['is_moving'] = function(block) {
      var motor = block.getFieldValue('MOTOR');
      // Check if position changed from cached value (threshold: 1 degree)
      return ['(Math.abs((await Robot.getDegrees(' + motor + ')) - Robot.positionToDegrees(motorPositionCache[' + motor + '] || 2048)) > 1)', Blockly.JavaScript.ORDER_AWAIT];
    };

    Blockly.JavaScript.forBlock['wait_until_stopped'] = function(block) {
      var motor = block.getFieldValue('MOTOR');
      var timeout = Blockly.JavaScript.valueToCode(block, 'TIMEOUT', Blockly.JavaScript.ORDER_ATOMIC) || '5';
      return 'var _start = Date.now(); var _lastPos = await Robot.getDegrees(' + motor + '); while (Date.now() - _start < ' + timeout + ' * 1000) { await new Promise(function(r) { setTimeout(r, 50); }); var _newPos = await Robot.getDegrees(' + motor + '); if (Math.abs(_newPos - _lastPos) < 0.5) break; _lastPos = _newPos; }\n';
    };

    Blockly.JavaScript.forBlock['get_load'] = function(block) {
      var motor = block.getFieldValue('MOTOR');
      return ['(await Robot.getLoad(' + motor + '))', Blockly.JavaScript.ORDER_AWAIT];
    };

    Blockly.JavaScript.forBlock['get_temperature'] = function(block) {
      var motor = block.getFieldValue('MOTOR');
      return ['(await Robot.getTemperature(' + motor + '))', Blockly.JavaScript.ORDER_AWAIT];
    };

    Blockly.JavaScript.forBlock['joint_in_range'] = function(block) {
      var motor = block.getFieldValue('MOTOR');
      var min = Blockly.JavaScript.valueToCode(block, 'MIN', Blockly.JavaScript.ORDER_ATOMIC) || '-180';
      var max = Blockly.JavaScript.valueToCode(block, 'MAX', Blockly.JavaScript.ORDER_ATOMIC) || '180';
      return ['(function() { var j = Robot.positionToDegrees(motorPositionCache[' + motor + '] || 2048); return j >= ' + min + ' && j <= ' + max + '; })()', Blockly.JavaScript.ORDER_FUNCTION_CALL];
    };

    // === Timing Blocks ===
    Blockly.JavaScript.forBlock['wait'] = function(block) {
      var time = Blockly.JavaScript.valueToCode(block, 'TIME', Blockly.JavaScript.ORDER_ATOMIC) || '1';
      return 'await wait(' + time + ');\n';
    };

    Blockly.JavaScript.forBlock['wait_ms'] = function(block) {
      var time = Blockly.JavaScript.valueToCode(block, 'TIME', Blockly.JavaScript.ORDER_ATOMIC) || '100';
      return 'await sleep(' + time + ');\n';
    };

    Blockly.JavaScript.forBlock['get_time'] = function(block) {
      return ['Date.now()', Blockly.JavaScript.ORDER_FUNCTION_CALL];
    };

    Blockly.JavaScript.forBlock['reset_timer'] = function(block) {
      return 'programTimer = Date.now();\n';
    };

    Blockly.JavaScript.forBlock['timer_value'] = function(block) {
      return ['((Date.now() - programTimer) / 1000)', Blockly.JavaScript.ORDER_DIVISION];
    };

    // === Output Blocks ===
    Blockly.JavaScript.forBlock['log'] = function(block) {
      var msg = Blockly.JavaScript.valueToCode(block, 'MESSAGE', Blockly.JavaScript.ORDER_ATOMIC) || '""';
      return 'logConsole(' + msg + ');\n';
    };

    Blockly.JavaScript.forBlock['log_joint'] = function(block) {
      var motor = block.getFieldValue('MOTOR');
      return 'logConsole("Joint ' + motor + ': " + (await Robot.getDegrees(' + motor + ')).toFixed(1) + "°", "info");\n';
    };

    Blockly.JavaScript.forBlock['log_type'] = function(block) {
      var msg = Blockly.JavaScript.valueToCode(block, 'MESSAGE', Blockly.JavaScript.ORDER_ATOMIC) || '""';
      var type = block.getFieldValue('TYPE');
      return 'logConsole(' + msg + ', "' + type + '");\n';
    };

    Blockly.JavaScript.forBlock['alert'] = function(block) {
      var msg = Blockly.JavaScript.valueToCode(block, 'MESSAGE', Blockly.JavaScript.ORDER_ATOMIC) || '""';
      return 'alert(' + msg + ');\n';
    };

})();
