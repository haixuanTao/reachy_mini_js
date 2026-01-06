// ========== Python Code Generators ==========
// This module handles Python code generation from Blockly blocks

(function() {
    'use strict';

    // Initialize Python generator
    Blockly.Python = new Blockly.Generator('Python');

    // Python operator precedence
    Blockly.Python.ORDER_ATOMIC = 0;
    Blockly.Python.ORDER_COLLECTION = 1;
    Blockly.Python.ORDER_STRING_CONVERSION = 1;
    Blockly.Python.ORDER_MEMBER = 2;
    Blockly.Python.ORDER_FUNCTION_CALL = 2;
    Blockly.Python.ORDER_EXPONENTIATION = 3;
    Blockly.Python.ORDER_UNARY_SIGN = 4;
    Blockly.Python.ORDER_BITWISE_NOT = 4;
    Blockly.Python.ORDER_MULTIPLICATIVE = 5;
    Blockly.Python.ORDER_ADDITIVE = 6;
    Blockly.Python.ORDER_BITWISE_SHIFT = 7;
    Blockly.Python.ORDER_BITWISE_AND = 8;
    Blockly.Python.ORDER_BITWISE_XOR = 9;
    Blockly.Python.ORDER_BITWISE_OR = 10;
    Blockly.Python.ORDER_RELATIONAL = 11;
    Blockly.Python.ORDER_LOGICAL_NOT = 12;
    Blockly.Python.ORDER_LOGICAL_AND = 13;
    Blockly.Python.ORDER_LOGICAL_OR = 14;
    Blockly.Python.ORDER_CONDITIONAL = 15;
    Blockly.Python.ORDER_LAMBDA = 16;
    Blockly.Python.ORDER_NONE = 99;

    // Initialize the generator
    Blockly.Python.init = function(workspace) {
      Blockly.Python.definitions_ = Object.create(null);
      Blockly.Python.functionNames_ = Object.create(null);
      if (!Blockly.Python.nameDB_) {
        Blockly.Python.nameDB_ = new Blockly.Names(Blockly.Python.RESERVED_WORDS_);
      } else {
        Blockly.Python.nameDB_.reset();
      }
      Blockly.Python.nameDB_.setVariableMap(workspace.getVariableMap());
      Blockly.Python.nameDB_.populateVariables(workspace);
      Blockly.Python.nameDB_.populateProcedures(workspace);
    };

    Blockly.Python.finish = function(code) {
      var definitions = [];
      for (var name in Blockly.Python.definitions_) {
        definitions.push(Blockly.Python.definitions_[name]);
      }
      var allDefs = definitions.join('\n\n');
      return allDefs.replace(/\n\n+/g, '\n\n').replace(/\n*$/, '\n') + '\n\n' + code;
    };

    Blockly.Python.scrubNakedValue = function(line) {
      return line + '\n';
    };

    Blockly.Python.quote_ = function(string) {
      string = string.replace(/\\/g, '\\\\').replace(/\n/g, '\\\n');
      return '"' + string + '"';
    };

    Blockly.Python.scrub_ = function(block, code, thisOnly) {
      var nextBlock = block.nextConnection && block.nextConnection.targetBlock();
      var nextCode = '';
      if (nextBlock && !thisOnly) {
        nextCode = Blockly.Python.blockToCode(nextBlock);
      }
      return code + nextCode;
    };

    Blockly.Python.RESERVED_WORDS_ = 'False,None,True,and,as,assert,break,class,continue,def,del,elif,else,except,finally,for,from,global,if,import,in,is,lambda,nonlocal,not,or,pass,raise,return,try,while,with,yield';

    // Helper methods for Python generator
    Blockly.Python.INDENT = '    ';

    Blockly.Python.valueToCode = function(block, name, outerOrder) {
      if (isNaN(outerOrder)) {
        throw TypeError('Expecting valid order from block: ' + block.type);
      }
      var targetBlock = block.getInputTargetBlock(name);
      if (!targetBlock) {
        return '';
      }
      var tuple = this.blockToCode(targetBlock);
      if (tuple === '') {
        return '';
      }
      if (!Array.isArray(tuple)) {
        return tuple;
      }
      var code = tuple[0];
      var innerOrder = tuple[1];
      if (isNaN(innerOrder)) {
        throw TypeError('Expecting valid order from value block: ' + targetBlock.type);
      }
      if (!code) {
        return '';
      }
      var parensNeeded = false;
      if (outerOrder <= innerOrder) {
        if (outerOrder == innerOrder && (outerOrder == 0 || outerOrder == 99)) {
          parensNeeded = false;
        } else {
          parensNeeded = true;
        }
      }
      return parensNeeded ? '(' + code + ')' : code;
    };

    Blockly.Python.statementToCode = function(block, name) {
      var targetBlock = block.getInputTargetBlock(name);
      var code = this.blockToCode(targetBlock);
      if (typeof code !== 'string') {
        throw TypeError('Expecting code from statement block: ' + (targetBlock && targetBlock.type));
      }
      if (code) {
        code = Blockly.Python.prefixLines(code, Blockly.Python.INDENT);
      }
      return code;
    };

    Blockly.Python.prefixLines = function(text, prefix) {
      return prefix + text.replace(/\n(.)/g, '\n' + prefix + '$1');
    };

    Blockly.Python.blockToCode = function(block) {
      if (!block) {
        return '';
      }
      if (!block.isEnabled()) {
        return this.blockToCode(block.getNextBlock());
      }

      var func = this.forBlock[block.type];
      if (typeof func !== 'function') {
        throw Error('Language "' + this.name_ + '" does not know how to generate code for block type "' + block.type + '".');
      }
      var code = func.call(this, block);
      if (Array.isArray(code)) {
        return [this.scrub_(block, code[0], true), code[1]];
      } else if (typeof code === 'string') {
        var id = block.id.replace(/\$/g, '$$$$');
        return this.scrub_(block, code, false);
      } else if (code === null) {
        return '';
      } else {
        throw SyntaxError('Invalid code generated: ' + code);
      }
    };

    Blockly.Python.workspaceToCode = function(workspace) {
      if (!workspace) {
        console.warn('No workspace was provided to workspaceToCode');
        return '';
      }
      var code = [];
      this.init(workspace);
      var blocks = workspace.getTopBlocks(true);
      for (var i = 0, block; (block = blocks[i]); i++) {
        var line = this.blockToCode(block);
        if (Array.isArray(line)) {
          line = line[0];
        }
        if (line) {
          code.push(line);
        }
      }
      code = code.join('\n');
      code = this.finish(code);
      code = code.replace(/^\s+\n/, '');
      code = code.replace(/\n\s+$/, '\n');
      code = code.replace(/[ \t]+\n/g, '\n');
      return code;
    };

    // === Python Connection Blocks ===
    Blockly.Python.forBlock['enable_torque'] = function(block) {
      return '# enable_torque not supported in Python API\n';
    };

    Blockly.Python.forBlock['disable_torque'] = function(block) {
      return '# disable_torque not supported in Python API\n';
    };

    Blockly.Python.forBlock['enable_all'] = function(block) {
      return '# enable_all not supported in Python API\n';
    };

    Blockly.Python.forBlock['disable_all'] = function(block) {
      return '# disable_all not supported in Python API\n';
    };

    Blockly.Python.forBlock['check_joints'] = function(block) {
      return '# check_joints not supported in Python API\n';
    };

    Blockly.Python.forBlock['ping_joint'] = function(block) {
      return ['False', Blockly.Python.ORDER_ATOMIC];
    };

    Blockly.Python.forBlock['reboot_joint'] = function(block) {
      return '# reboot_joint not supported in Python API\n';
    };

    Blockly.Python.forBlock['reboot_all'] = function(block) {
      return '# reboot_all not supported in Python API\n';
    };

    // === Python Joint Blocks ===
    Blockly.Python.forBlock['set_joint'] = function(block) {
      var motor = block.getFieldValue('MOTOR');
      var joint = Blockly.Python.valueToCode(block, 'JOINT', Blockly.Python.ORDER_ATOMIC) || '2048';
      return '# set_joint not directly supported - use goto_target or set_target instead\n';
    };

    Blockly.Python.forBlock['set_degrees'] = function(block) {
      var motor = block.getFieldValue('MOTOR');
      var deg = Blockly.Python.valueToCode(block, 'DEGREES', Blockly.Python.ORDER_ATOMIC) || '0';
      var antennaIndex = motor === '17' ? '0' : '1';
      Blockly.Python.definitions_['import_numpy'] = 'import numpy as np';
      return 'mini.set_target(antennas=[np.deg2rad(' + deg + '), 0] if ' + antennaIndex + ' == 0 else [0, np.deg2rad(' + deg + ')])\n';
    };

    Blockly.Python.forBlock['get_joint'] = function(block) {
      return ['0', Blockly.Python.ORDER_ATOMIC];
    };

    Blockly.Python.forBlock['get_degrees'] = function(block) {
      return ['0', Blockly.Python.ORDER_ATOMIC];
    };

    Blockly.Python.forBlock['move_by'] = function(block) {
      var motor = block.getFieldValue('MOTOR');
      var amount = Blockly.Python.valueToCode(block, 'AMOUNT', Blockly.Python.ORDER_ATOMIC) || '0';
      return '# move_by not supported in Python API\n';
    };

    Blockly.Python.forBlock['move_smooth'] = function(block) {
      var motor = block.getFieldValue('MOTOR');
      var joint = Blockly.Python.valueToCode(block, 'JOINT', Blockly.Python.ORDER_ATOMIC) || '2048';
      var dur = Blockly.Python.valueToCode(block, 'DURATION', Blockly.Python.ORDER_ATOMIC) || '1';
      return '# move_smooth - use goto_target with duration instead\n';
    };

    // === Python Kinematics Blocks ===
    Blockly.Python.forBlock['get_head_coordinates'] = function(block) {
      Blockly.Python.definitions_['import_reachy'] = 'from reachy_mini import ReachyMini';
      Blockly.Python.definitions_['import_utils'] = 'from reachy_mini.utils import create_head_pose';
      return ['mini.head.pose', Blockly.Python.ORDER_MEMBER];
    };

    Blockly.Python.forBlock['set_head_coordinates'] = function(block) {
      var coords = Blockly.Python.valueToCode(block, 'COORDS', Blockly.Python.ORDER_ATOMIC) || 'np.eye(4)';
      Blockly.Python.definitions_['import_reachy'] = 'from reachy_mini import ReachyMini';
      return 'mini.goto_target(' + coords + ', duration=1.0)\n';
    };

    Blockly.Python.forBlock['joints_to_coordinates'] = function(block) {
      var joints = Blockly.Python.valueToCode(block, 'JOINTS', Blockly.Python.ORDER_ATOMIC) || '[]';
      return ['[]', Blockly.Python.ORDER_ATOMIC];
    };

    Blockly.Python.forBlock['coordinates_to_joints'] = function(block) {
      var coordinates = Blockly.Python.valueToCode(block, 'COORDINATES', Blockly.Python.ORDER_ATOMIC) || '[0,0,0,0,0,0]';
      return ['[]', Blockly.Python.ORDER_ATOMIC];
    };

    Blockly.Python.forBlock['create_coordinates'] = function(block) {
      var x = Blockly.Python.valueToCode(block, 'X', Blockly.Python.ORDER_ATOMIC) || '0';
      var y = Blockly.Python.valueToCode(block, 'Y', Blockly.Python.ORDER_ATOMIC) || '0';
      var z = Blockly.Python.valueToCode(block, 'Z', Blockly.Python.ORDER_ATOMIC) || '0';
      var roll = Blockly.Python.valueToCode(block, 'ROLL', Blockly.Python.ORDER_ATOMIC) || '0';
      var pitch = Blockly.Python.valueToCode(block, 'PITCH', Blockly.Python.ORDER_ATOMIC) || '0';
      var yaw = Blockly.Python.valueToCode(block, 'YAW', Blockly.Python.ORDER_ATOMIC) || '0';
      Blockly.Python.definitions_['import_utils'] = 'from reachy_mini.utils import create_head_pose';
      return ['create_head_pose(x=' + x + ', y=' + y + ', z=' + z + ', roll=' + roll + ', pitch=' + pitch + ', yaw=' + yaw + ', degrees=True, mm=True)', Blockly.Python.ORDER_FUNCTION_CALL];
    };

    Blockly.Python.forBlock['get_coordinate'] = function(block) {
      var component = block.getFieldValue('COMPONENT');
      var coordinates = Blockly.Python.valueToCode(block, 'COORDINATES', Blockly.Python.ORDER_MEMBER) || 'np.eye(4)';
      var componentMap = {'0': '[0,3]', '1': '[1,3]', '2': '[2,3]', '3': 'roll', '4': 'pitch', '5': 'yaw'};
      if (component === '0' || component === '1' || component === '2') {
        return ['(' + coordinates + ')' + componentMap[component], Blockly.Python.ORDER_MEMBER];
      }
      return ['0', Blockly.Python.ORDER_ATOMIC];
    };

    // === Python Sensing Blocks ===
    Blockly.Python.forBlock['is_moving'] = function(block) {
      return ['False', Blockly.Python.ORDER_ATOMIC];
    };

    Blockly.Python.forBlock['wait_until_stopped'] = function(block) {
      var motor = block.getFieldValue('MOTOR');
      var timeout = Blockly.Python.valueToCode(block, 'TIMEOUT', Blockly.Python.ORDER_ATOMIC) || '5';
      return '# wait_until_stopped not supported in Python API\n';
    };

    Blockly.Python.forBlock['get_load'] = function(block) {
      return ['0', Blockly.Python.ORDER_ATOMIC];
    };

    Blockly.Python.forBlock['get_temperature'] = function(block) {
      return ['0', Blockly.Python.ORDER_ATOMIC];
    };

    Blockly.Python.forBlock['joint_in_range'] = function(block) {
      var motor = block.getFieldValue('MOTOR');
      var min = Blockly.Python.valueToCode(block, 'MIN', Blockly.Python.ORDER_ATOMIC) || '-180';
      var max = Blockly.Python.valueToCode(block, 'MAX', Blockly.Python.ORDER_ATOMIC) || '180';
      return ['False', Blockly.Python.ORDER_ATOMIC];
    };

    // === Python Timing Blocks ===
    Blockly.Python.forBlock['wait'] = function(block) {
      var time = Blockly.Python.valueToCode(block, 'TIME', Blockly.Python.ORDER_ATOMIC) || '1';
      Blockly.Python.definitions_['import_time'] = 'import time';
      return 'time.sleep(' + time + ')\n';
    };

    Blockly.Python.forBlock['wait_ms'] = function(block) {
      var time = Blockly.Python.valueToCode(block, 'TIME', Blockly.Python.ORDER_ATOMIC) || '100';
      Blockly.Python.definitions_['import_time'] = 'import time';
      return 'time.sleep(' + time + ' / 1000)\n';
    };

    Blockly.Python.forBlock['get_time'] = function(block) {
      Blockly.Python.definitions_['import_time'] = 'import time';
      return ['int(time.time() * 1000)', Blockly.Python.ORDER_FUNCTION_CALL];
    };

    Blockly.Python.forBlock['reset_timer'] = function(block) {
      return 'program_timer = time.time()\n';
    };

    Blockly.Python.forBlock['timer_value'] = function(block) {
      Blockly.Python.definitions_['import_time'] = 'import time';
      return ['(time.time() - program_timer)', Blockly.Python.ORDER_ADDITIVE];
    };

    // === Python Output Blocks ===
    Blockly.Python.forBlock['log'] = function(block) {
      var msg = Blockly.Python.valueToCode(block, 'MESSAGE', Blockly.Python.ORDER_ATOMIC) || '""';
      return 'print(' + msg + ')\n';
    };

    Blockly.Python.forBlock['log_joint'] = function(block) {
      var motor = block.getFieldValue('MOTOR');
      return 'print("Joint ' + motor + ':")  # Joint values not readable in Python API\n';
    };

    Blockly.Python.forBlock['log_type'] = function(block) {
      var msg = Blockly.Python.valueToCode(block, 'MESSAGE', Blockly.Python.ORDER_ATOMIC) || '""';
      var type = block.getFieldValue('TYPE');
      return 'print(' + msg + ')  # Log type: ' + type + '\n';
    };

    Blockly.Python.forBlock['alert'] = function(block) {
      var msg = Blockly.Python.valueToCode(block, 'MESSAGE', Blockly.Python.ORDER_ATOMIC) || '""';
      return 'print(' + msg + ')  # Alert\n';
    };

    // === Python Built-in Block Generators ===
    // Controls blocks
    Blockly.Python.forBlock['controls_if'] = function(block) {
      var n = 0;
      var code = '', branchCode, conditionCode;
      if (Blockly.Python.STATEMENT_PREFIX) {
        code += Blockly.Python.injectId(Blockly.Python.STATEMENT_PREFIX, block);
      }
      do {
        conditionCode = Blockly.Python.valueToCode(block, 'IF' + n, Blockly.Python.ORDER_NONE) || 'False';
        branchCode = Blockly.Python.statementToCode(block, 'DO' + n) || Blockly.Python.PASS;
        if (Blockly.Python.STATEMENT_SUFFIX) {
          branchCode = Blockly.Python.prefixLines(Blockly.Python.injectId(Blockly.Python.STATEMENT_SUFFIX, block), Blockly.Python.INDENT) + branchCode;
        }
        code += (n === 0 ? 'if ' : 'elif ') + conditionCode + ':\n' + branchCode;
        n++;
      } while (block.getInput('IF' + n));

      if (block.getInput('ELSE') || Blockly.Python.STATEMENT_SUFFIX) {
        branchCode = Blockly.Python.statementToCode(block, 'ELSE') || Blockly.Python.PASS;
        if (Blockly.Python.STATEMENT_SUFFIX) {
          branchCode = Blockly.Python.prefixLines(Blockly.Python.injectId(Blockly.Python.STATEMENT_SUFFIX, block), Blockly.Python.INDENT) + branchCode;
        }
        code += 'else:\n' + branchCode;
      }
      return code;
    };

    Blockly.Python.forBlock['controls_repeat_ext'] = function(block) {
      var repeats = Blockly.Python.valueToCode(block, 'TIMES', Blockly.Python.ORDER_NONE) || '0';
      var branch = Blockly.Python.statementToCode(block, 'DO') || Blockly.Python.PASS;
      var loopVar = Blockly.Python.nameDB_.getDistinctName('count', Blockly.VARIABLE_CATEGORY_NAME);
      return 'for ' + loopVar + ' in range(int(' + repeats + ')):\n' + branch;
    };

    Blockly.Python.forBlock['controls_whileUntil'] = function(block) {
      var until = block.getFieldValue('MODE') === 'UNTIL';
      var argument0 = Blockly.Python.valueToCode(block, 'BOOL', until ? Blockly.Python.ORDER_LOGICAL_NOT : Blockly.Python.ORDER_NONE) || 'False';
      var branch = Blockly.Python.statementToCode(block, 'DO') || Blockly.Python.PASS;
      if (until) {
        argument0 = 'not ' + argument0;
      }
      return 'while ' + argument0 + ':\n' + branch;
    };

    Blockly.Python.forBlock['controls_for'] = function(block) {
      var variable0 = Blockly.Python.nameDB_.getName(block.getFieldValue('VAR'), Blockly.VARIABLE_CATEGORY_NAME);
      var argument0 = Blockly.Python.valueToCode(block, 'FROM', Blockly.Python.ORDER_NONE) || '0';
      var argument1 = Blockly.Python.valueToCode(block, 'TO', Blockly.Python.ORDER_NONE) || '0';
      var increment = Blockly.Python.valueToCode(block, 'BY', Blockly.Python.ORDER_NONE) || '1';
      var branch = Blockly.Python.statementToCode(block, 'DO') || Blockly.Python.PASS;
      var code = 'for ' + variable0 + ' in range(int(' + argument0 + '), int(' + argument1 + ') + 1, int(' + increment + ')):\n' + branch;
      return code;
    };

    Blockly.Python.forBlock['controls_forEach'] = function(block) {
      var variable0 = Blockly.Python.nameDB_.getName(block.getFieldValue('VAR'), Blockly.VARIABLE_CATEGORY_NAME);
      var argument0 = Blockly.Python.valueToCode(block, 'LIST', Blockly.Python.ORDER_RELATIONAL) || '[]';
      var branch = Blockly.Python.statementToCode(block, 'DO') || Blockly.Python.PASS;
      var code = 'for ' + variable0 + ' in ' + argument0 + ':\n' + branch;
      return code;
    };

    Blockly.Python.forBlock['controls_flow_statements'] = function(block) {
      var keyword = block.getFieldValue('FLOW');
      if (keyword === 'BREAK') {
        return 'break\n';
      } else if (keyword === 'CONTINUE') {
        return 'continue\n';
      }
      return '';
    };

    // Logic blocks
    Blockly.Python.forBlock['logic_boolean'] = function(block) {
      var code = (block.getFieldValue('BOOL') === 'TRUE') ? 'True' : 'False';
      return [code, Blockly.Python.ORDER_ATOMIC];
    };

    Blockly.Python.forBlock['logic_null'] = function(block) {
      return ['None', Blockly.Python.ORDER_ATOMIC];
    };

    Blockly.Python.forBlock['logic_negate'] = function(block) {
      var order = Blockly.Python.ORDER_LOGICAL_NOT;
      var argument0 = Blockly.Python.valueToCode(block, 'BOOL', order) || 'True';
      return ['not ' + argument0, order];
    };

    Blockly.Python.forBlock['logic_compare'] = function(block) {
      var OPERATORS = {'EQ': '==', 'NEQ': '!=', 'LT': '<', 'LTE': '<=', 'GT': '>', 'GTE': '>='};
      var operator = OPERATORS[block.getFieldValue('OP')];
      var order = Blockly.Python.ORDER_RELATIONAL;
      var argument0 = Blockly.Python.valueToCode(block, 'A', order) || '0';
      var argument1 = Blockly.Python.valueToCode(block, 'B', order) || '0';
      return [argument0 + ' ' + operator + ' ' + argument1, order];
    };

    Blockly.Python.forBlock['logic_operation'] = function(block) {
      var operator = (block.getFieldValue('OP') === 'AND') ? 'and' : 'or';
      var order = (operator === 'and') ? Blockly.Python.ORDER_LOGICAL_AND : Blockly.Python.ORDER_LOGICAL_OR;
      var argument0 = Blockly.Python.valueToCode(block, 'A', order) || 'False';
      var argument1 = Blockly.Python.valueToCode(block, 'B', order) || 'False';
      return [argument0 + ' ' + operator + ' ' + argument1, order];
    };

    // Math blocks
    Blockly.Python.forBlock['math_number'] = function(block) {
      var code = Number(block.getFieldValue('NUM'));
      var order = code < 0 ? Blockly.Python.ORDER_UNARY_SIGN : Blockly.Python.ORDER_ATOMIC;
      return [code, order];
    };

    Blockly.Python.forBlock['math_arithmetic'] = function(block) {
      var OPERATORS = {
        'ADD': [' + ', Blockly.Python.ORDER_ADDITIVE],
        'MINUS': [' - ', Blockly.Python.ORDER_ADDITIVE],
        'MULTIPLY': [' * ', Blockly.Python.ORDER_MULTIPLICATIVE],
        'DIVIDE': [' / ', Blockly.Python.ORDER_MULTIPLICATIVE],
        'POWER': [' ** ', Blockly.Python.ORDER_EXPONENTIATION]
      };
      var tuple = OPERATORS[block.getFieldValue('OP')];
      var operator = tuple[0];
      var order = tuple[1];
      var argument0 = Blockly.Python.valueToCode(block, 'A', order) || '0';
      var argument1 = Blockly.Python.valueToCode(block, 'B', order) || '0';
      return [argument0 + operator + argument1, order];
    };

    Blockly.Python.forBlock['math_constant'] = function(block) {
      var CONSTANTS = {
        'PI': ['math.pi', Blockly.Python.ORDER_MEMBER],
        'E': ['math.e', Blockly.Python.ORDER_MEMBER],
        'GOLDEN_RATIO': ['(1 + math.sqrt(5)) / 2', Blockly.Python.ORDER_MULTIPLICATIVE],
        'SQRT2': ['math.sqrt(2)', Blockly.Python.ORDER_FUNCTION_CALL],
        'SQRT1_2': ['math.sqrt(1.0 / 2)', Blockly.Python.ORDER_FUNCTION_CALL],
        'INFINITY': ['float("inf")', Blockly.Python.ORDER_FUNCTION_CALL]
      };
      Blockly.Python.definitions_['import_math'] = 'import math';
      var constant = block.getFieldValue('CONSTANT');
      if (constant in CONSTANTS) {
        return CONSTANTS[constant];
      }
      return ['0', Blockly.Python.ORDER_ATOMIC];
    };

    Blockly.Python.forBlock['math_single'] = function(block) {
      var OPERATORS = {
        'ROOT': ['math.sqrt', Blockly.Python.ORDER_FUNCTION_CALL],
        'ABS': ['abs', Blockly.Python.ORDER_FUNCTION_CALL],
        'NEG': ['-', Blockly.Python.ORDER_UNARY_SIGN],
        'LN': ['math.log', Blockly.Python.ORDER_FUNCTION_CALL],
        'LOG10': ['math.log10', Blockly.Python.ORDER_FUNCTION_CALL],
        'EXP': ['math.exp', Blockly.Python.ORDER_FUNCTION_CALL],
        'POW10': ['math.pow(10, ', Blockly.Python.ORDER_FUNCTION_CALL],
        'SIN': ['math.sin', Blockly.Python.ORDER_FUNCTION_CALL],
        'COS': ['math.cos', Blockly.Python.ORDER_FUNCTION_CALL],
        'TAN': ['math.tan', Blockly.Python.ORDER_FUNCTION_CALL],
        'ASIN': ['math.asin', Blockly.Python.ORDER_FUNCTION_CALL],
        'ACOS': ['math.acos', Blockly.Python.ORDER_FUNCTION_CALL],
        'ATAN': ['math.atan', Blockly.Python.ORDER_FUNCTION_CALL]
      };
      var operator = block.getFieldValue('OP');
      var tuple = OPERATORS[operator];
      var func = tuple[0];
      var order = tuple[1];
      var arg = Blockly.Python.valueToCode(block, 'NUM', Blockly.Python.ORDER_NONE) || '0';
      Blockly.Python.definitions_['import_math'] = 'import math';

      var code;
      if (operator === 'NEG') {
        code = func + arg;
      } else if (operator === 'POW10') {
        code = func + arg + ')';
      } else {
        code = func + '(' + arg + ')';
      }
      return [code, order];
    };

    Blockly.Python.forBlock['math_trig'] = function(block) {
      var OPERATORS = {
        'SIN': 'math.sin',
        'COS': 'math.cos',
        'TAN': 'math.tan',
        'ASIN': 'math.asin',
        'ACOS': 'math.acos',
        'ATAN': 'math.atan'
      };
      var operator = block.getFieldValue('OP');
      var arg = Blockly.Python.valueToCode(block, 'NUM', Blockly.Python.ORDER_NONE) || '0';
      Blockly.Python.definitions_['import_math'] = 'import math';
      var code = OPERATORS[operator] + '(' + arg + ')';
      return [code, Blockly.Python.ORDER_FUNCTION_CALL];
    };

    Blockly.Python.forBlock['math_round'] = function(block) {
      var OPERATORS = {
        'ROUND': 'round',
        'ROUNDUP': 'math.ceil',
        'ROUNDDOWN': 'math.floor'
      };
      var operator = block.getFieldValue('OP');
      var arg = Blockly.Python.valueToCode(block, 'NUM', Blockly.Python.ORDER_NONE) || '0';
      if (operator === 'ROUNDUP' || operator === 'ROUNDDOWN') {
        Blockly.Python.definitions_['import_math'] = 'import math';
      }
      var code = OPERATORS[operator] + '(' + arg + ')';
      return [code, Blockly.Python.ORDER_FUNCTION_CALL];
    };

    Blockly.Python.forBlock['math_modulo'] = function(block) {
      var arg1 = Blockly.Python.valueToCode(block, 'DIVIDEND', Blockly.Python.ORDER_MULTIPLICATIVE) || '0';
      var arg2 = Blockly.Python.valueToCode(block, 'DIVISOR', Blockly.Python.ORDER_MULTIPLICATIVE) || '0';
      var code = arg1 + ' % ' + arg2;
      return [code, Blockly.Python.ORDER_MULTIPLICATIVE];
    };

    Blockly.Python.forBlock['math_constrain'] = function(block) {
      var arg = Blockly.Python.valueToCode(block, 'VALUE', Blockly.Python.ORDER_NONE) || '0';
      var low = Blockly.Python.valueToCode(block, 'LOW', Blockly.Python.ORDER_NONE) || '0';
      var high = Blockly.Python.valueToCode(block, 'HIGH', Blockly.Python.ORDER_NONE) || '0';
      var code = 'min(max(' + arg + ', ' + low + '), ' + high + ')';
      return [code, Blockly.Python.ORDER_FUNCTION_CALL];
    };

    Blockly.Python.forBlock['math_random_int'] = function(block) {
      var arg1 = Blockly.Python.valueToCode(block, 'FROM', Blockly.Python.ORDER_NONE) || '0';
      var arg2 = Blockly.Python.valueToCode(block, 'TO', Blockly.Python.ORDER_NONE) || '0';
      Blockly.Python.definitions_['import_random'] = 'import random';
      var code = 'random.randint(' + arg1 + ', ' + arg2 + ')';
      return [code, Blockly.Python.ORDER_FUNCTION_CALL];
    };

    Blockly.Python.forBlock['math_random_float'] = function(block) {
      Blockly.Python.definitions_['import_random'] = 'import random';
      return ['random.random()', Blockly.Python.ORDER_FUNCTION_CALL];
    };

    Blockly.Python.forBlock['math_atan2'] = function(block) {
      var arg1 = Blockly.Python.valueToCode(block, 'X', Blockly.Python.ORDER_NONE) || '0';
      var arg2 = Blockly.Python.valueToCode(block, 'Y', Blockly.Python.ORDER_NONE) || '0';
      Blockly.Python.definitions_['import_math'] = 'import math';
      var code = 'math.atan2(' + arg2 + ', ' + arg1 + ')';
      return [code, Blockly.Python.ORDER_FUNCTION_CALL];
    };

    // Text blocks
    Blockly.Python.forBlock['text'] = function(block) {
      var code = Blockly.Python.quote_(block.getFieldValue('TEXT'));
      return [code, Blockly.Python.ORDER_ATOMIC];
    };

    Blockly.Python.forBlock['text_print'] = function(block) {
      var msg = Blockly.Python.valueToCode(block, 'TEXT', Blockly.Python.ORDER_NONE) || '""';
      return 'print(' + msg + ')\n';
    };

    Blockly.Python.forBlock['text_join'] = function(block) {
      if (block.itemCount_ === 0) {
        return ['\'\'', Blockly.Python.ORDER_ATOMIC];
      } else if (block.itemCount_ === 1) {
        var element = Blockly.Python.valueToCode(block, 'ADD0', Blockly.Python.ORDER_NONE) || '\'\'';
        return ['str(' + element + ')', Blockly.Python.ORDER_FUNCTION_CALL];
      } else {
        var elements = [];
        for (var i = 0; i < block.itemCount_; i++) {
          elements[i] = Blockly.Python.valueToCode(block, 'ADD' + i, Blockly.Python.ORDER_NONE) || '\'\'';
        }
        return ['str(' + elements.join(') + str(') + ')', Blockly.Python.ORDER_FUNCTION_CALL];
      }
    };

    // Variables
    Blockly.Python.forBlock['variables_get'] = function(block) {
      var code = Blockly.Python.nameDB_.getName(block.getFieldValue('VAR'), Blockly.VARIABLE_CATEGORY_NAME);
      return [code, Blockly.Python.ORDER_ATOMIC];
    };

    Blockly.Python.forBlock['variables_set'] = function(block) {
      var argument0 = Blockly.Python.valueToCode(block, 'VALUE', Blockly.Python.ORDER_NONE) || '0';
      var varName = Blockly.Python.nameDB_.getName(block.getFieldValue('VAR'), Blockly.VARIABLE_CATEGORY_NAME);
      return varName + ' = ' + argument0 + '\n';
    };

    // Lists
    Blockly.Python.forBlock['lists_create_with'] = function(block) {
      var elements = new Array(block.itemCount_);
      for (var i = 0; i < block.itemCount_; i++) {
        elements[i] = Blockly.Python.valueToCode(block, 'ADD' + i, Blockly.Python.ORDER_NONE) || 'None';
      }
      return ['[' + elements.join(', ') + ']', Blockly.Python.ORDER_ATOMIC];
    };

    // Set PASS for empty blocks
    Blockly.Python.PASS = '    pass\n';

})();
