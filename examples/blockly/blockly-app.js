// Wait for WASM module to be ready before initializing
function initBlocklyApp() {
    // ========== Global State ==========
    var stopRequested = false;
    var programTimer = 0;
    var recordedPoses = {};
    var motorPositionCache = {};

    // ========== Kinematics Functions ==========
    // These call the WASM functions attached to window.wasm
    // joints -> coordinates: window.wasm.forward_kinematics(joints) -> [x, y, z, roll, pitch, yaw]
    // coordinates -> joints: window.wasm.inverse_kinematics(coordinates) -> [j1, j2, ..., j8]

    function callFK(joints) {
      return window.wasm.forward_kinematics(joints);
    }

    function callIK(coordinates) {
      return window.wasm.inverse_kinematics(coordinates);
    }

    // ========== Console Logging ==========
    function logConsole(message, type) {
      type = type || 'log';
      var el = document.getElementById('consoleOutput');
      var line = document.createElement('div');
      line.className = type;
      var time = new Date().toLocaleTimeString();
      line.textContent = '[' + time + '] ' + message;
      el.appendChild(line);
      el.scrollTop = el.scrollHeight;
      // Also log to browser console
      console.log('[' + type + ']', message);
    }

    // Global timing functions (used by AI-generated code and block generators)
    // Check stopRequested every 50ms so Stop button responds quickly
    function wait(seconds) {
      return new Promise(function(resolve, reject) {
        var elapsed = 0;
        var interval = 50; // Check every 50ms
        var totalMs = seconds * 1000;
        var timer = setInterval(function() {
          elapsed += interval;
          if (stopRequested) {
            clearInterval(timer);
            reject(new Error('Stop requested'));
          } else if (elapsed >= totalMs) {
            clearInterval(timer);
            resolve();
          }
        }, interval);
      });
    }

    function sleep(ms) {
      return new Promise(function(resolve, reject) {
        var elapsed = 0;
        var interval = 50;
        var timer = setInterval(function() {
          elapsed += interval;
          if (stopRequested) {
            clearInterval(timer);
            reject(new Error('Stop requested'));
          } else if (elapsed >= ms) {
            clearInterval(timer);
            resolve();
          }
        }, interval);
      });
    }

    function switchTab(tab) {
      document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
      document.querySelectorAll('.tab-content').forEach(function(t) { t.classList.remove('active'); });
      document.querySelector('.tab:nth-child(' + (tab === 'code' ? '1' : '2') + ')').classList.add('active');
      document.getElementById(tab + 'Tab').classList.add('active');
    }

    // ========== Robot Communication (WASM-backed) ==========
    // This Robot object wraps the Rust WASM module for motor control
    var Robot = {
      connected: false,
      motorIds: [11, 12, 13, 14, 15, 16],  // Head motors only (antennas 17-18 controlled separately)
      pollingInterval: null,

      // Position conversion utilities
      degreesToPosition: function(deg) {
        return Math.round(2048 + (deg * 4096 / 360));
      },

      positionToDegrees: function(pos) {
        return (pos - 2048) * 360 / 4096;
      },

      // Connection management (uses WASM)
      connect: function() {
        var self = this;

        logConsole('Connecting...', 'info');
        return window.wasm.connect(null).then(function(result) {
          self.connected = true;
          updateConnectionStatus(true);
          logConsole('Connected to robot', 'success');
          self.startPositionPolling();
          // Auto-check motors after connection
          setTimeout(function() { checkMotors(); }, 500);
          return true;
        }).catch(function(e) {
          logConsole('Connection failed: ' + (e.message || e), 'error');
          return false;
        });
      },

      disconnect: function() {
        var self = this;
        self.connected = false;
        self.stopPositionPolling();
        return window.wasm.disconnect().then(function() {
          updateConnectionStatus(false);
          logConsole('Disconnected', 'log');
        }).catch(function() {
          updateConnectionStatus(false);
        });
      },

      startPositionPolling: function() {
        var self = this;
        this.pollingInterval = setInterval(function() {
          if (!self.connected) return;
          // Update motor status display with cached positions
          for (var i = 0; i < self.motorIds.length; i++) {
            var id = self.motorIds[i];
            var el = document.getElementById('motor' + id);
            if (el && motorPositionCache[id] !== undefined) {
              var deg = Math.round(self.positionToDegrees(motorPositionCache[id]));
              el.querySelector('span').textContent = deg + '°';
              el.classList.add('active');
            }
          }
        }, 200);
      },

      stopPositionPolling: function() {
        if (this.pollingInterval) {
          clearInterval(this.pollingInterval);
          this.pollingInterval = null;
        }
      },

      // Motor status check - uses WASM temperature read as a ping
      pingMotor: function(id) {
        return window.wasm.get_motor_temperature(id).then(function(temp) {
          return { ok: true, error: null };
        }).catch(function(e) {
          return { ok: false, error: e.message || String(e), hasHardwareAlert: false };
        });
      },

      // Check all motors - use bulk position read which is more reliable
      checkAllMotors: function() {
        var results = {};
        var allMotors = [11, 12, 13, 14, 15, 16, 17, 18];

        // Use get_all_joints which does a bulk sync read - more reliable over WebSocket
        return window.wasm.get_all_joints().then(function(joints) {
          // If we got 8 joint values, all motors responded
          for (var i = 0; i < allMotors.length; i++) {
            var id = allMotors[i];
            var angle = joints[i];
            // If angle is exactly 0 and not a valid position, might indicate no response
            // But typically any response means motor is OK
            results[id] = { ok: true, angle: angle, error: null };
          }
          return results;
        }).catch(function(e) {
          // Bulk read failed - try to determine which motors are responding
          var errorMsg = e.message || String(e);
          for (var i = 0; i < allMotors.length; i++) {
            results[allMotors[i]] = { ok: false, error: errorMsg, hasHardwareAlert: errorMsg.includes('Motor error') };
          }
          return results;
        });
      },

      // Reboot a motor (uses WASM)
      rebootMotor: function(id) {
        logConsole('Rebooting motor ' + id + '...', 'warn');
        return window.wasm.reboot_motor(id).then(function() {
          logConsole('Motor ' + id + ' rebooted successfully', 'success');
          return { ok: true };
        }).catch(function(e) {
          logConsole('Motor ' + id + ' reboot failed: ' + (e.message || e), 'error');
          return { ok: false, error: e.message || String(e) };
        });
      },

      // Reboot all motors (uses WASM)
      rebootAllMotors: function() {
        logConsole('Rebooting all motors...', 'warn');
        return window.wasm.reboot_all_motors().then(function() {
          logConsole('All motors rebooted', 'success');
        });
      },

      // Torque control (uses WASM)
      setTorque: function(id, enable) {
        var self = this;
        // Determine which torque function to use based on motor ID
        var torquePromise;
        if (id === 17) {
          torquePromise = enable ? window.wasm.enable_left_antenna_torque() : window.wasm.disable_left_antenna_torque();
        } else if (id === 18) {
          torquePromise = enable ? window.wasm.enable_right_antenna_torque() : window.wasm.disable_right_antenna_torque();
        } else if (id >= 11 && id <= 16) {
          // For individual head motors, we use head torque (affects all 6)
          // This is a limitation - WASM doesn't have per-motor head torque
          torquePromise = enable ? window.wasm.enable_head_torque() : window.wasm.disable_head_torque();
        } else {
          return Promise.resolve(false);
        }

        return torquePromise.then(function() {
          return true;
        }).catch(function(e) {
          logConsole('Motor ' + id + ' torque error: ' + (e.message || e), 'error');
          return false;
        });
      },

      setTorqueMultiple: function(ids, enable) {
        // Use WASM bulk torque control
        var torquePromise = enable ? window.wasm.enable_torque() : window.wasm.disable_torque();
        return torquePromise.then(function() {
          return { success: ids, failed: [] };
        }).catch(function(e) {
          console.error('Error setting torque:', e);
          return { success: [], failed: ids };
        });
      },

      // Position control - convert degrees for WASM
      setPosition: function(id, position) {
        var self = this;
        var deg = self.positionToDegrees(position);
        motorPositionCache[id] = position;

        // Route to appropriate WASM function based on motor ID
        if (id === 17) {
          return window.wasm.set_left_antenna(deg);
        } else if (id === 18) {
          return window.wasm.set_right_antenna(deg);
        } else if (id >= 11 && id <= 16) {
          // For head motors, we need to get all joints and set them
          return window.wasm.get_head_joints().then(function(joints) {
            joints[id - 11] = deg;
            return window.wasm.set_head_joints(joints);
          });
        }
        return Promise.resolve();
      },

      setPositionMultiple: function(ids, positions) {
        var self = this;
        // Convert positions to degrees
        var degrees = positions.map(function(pos) {
          return self.positionToDegrees(pos);
        });

        // Update cache
        for (var i = 0; i < ids.length; i++) {
          motorPositionCache[ids[i]] = positions[i];
        }

        // If all head motors (11-16), use set_head_joints
        var headOnly = ids.every(function(id) { return id >= 11 && id <= 16; });
        if (headOnly && ids.length === 6) {
          return window.wasm.set_head_joints(degrees);
        }

        // If all motors (11-18), use set_all_joints
        if (ids.length === 8) {
          return window.wasm.set_all_joints(degrees);
        }

        // Otherwise, set individually (less efficient)
        var promises = [];
        for (var i = 0; i < ids.length; i++) {
          promises.push(self.setPosition(ids[i], positions[i]));
        }
        return Promise.all(promises);
      },

      getPosition: function(id) {
        var self = this;

        // Route to appropriate WASM function
        if (id === 17) {
          return window.wasm.get_left_antenna().then(function(deg) {
            var pos = self.degreesToPosition(deg);
            motorPositionCache[id] = pos;
            return pos;
          });
        } else if (id === 18) {
          return window.wasm.get_right_antenna().then(function(deg) {
            var pos = self.degreesToPosition(deg);
            motorPositionCache[id] = pos;
            return pos;
          });
        } else if (id >= 11 && id <= 16) {
          return window.wasm.get_head_joints().then(function(joints) {
            var deg = joints[id - 11];
            var pos = self.degreesToPosition(deg);
            motorPositionCache[id] = pos;
            return pos;
          });
        }
        return Promise.resolve(motorPositionCache[id] || 2048);
      },

      // Get motor temperature (uses WASM)
      getTemperature: function(id) {
        return window.wasm.get_motor_temperature(id);
      },

      // Get motor load (uses WASM)
      getLoad: function(id) {
        return window.wasm.get_motor_load(id);
      },

      // Smooth motion using interpolation
      moveSmooth: function(id, targetPos, durationMs) {
        var self = this;
        return self.getPosition(id).then(function(startPos) {
          var steps = Math.max(10, Math.floor(durationMs / 20));
          var stepDelay = durationMs / steps;
          var delta = targetPos - startPos;

          function doStep(step) {
            if (step > steps || stopRequested) return Promise.resolve();
            var t = step / steps;
            // Ease in-out
            t = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
            var pos = Math.round(startPos + delta * t);
            return self.setPosition(id, pos).then(function() {
              return new Promise(function(r) { setTimeout(r, stepDelay); });
            }).then(function() {
              return doStep(step + 1);
            });
          }
          return doStep(1);
        });
      },

      // Convenience methods for degrees (used by AI-generated code)
      getDegrees: function(id) {
        var self = this;
        return this.getPosition(id).then(function(pos) {
          return self.positionToDegrees(pos);
        });
      },

      setDegrees: function(id, deg) {
        var pos = this.degreesToPosition(deg);
        return this.setPositionLimited(id, pos);
      },

      // Max speed: 1 rotation per second = 4096 steps/sec (360° per second)
      maxStepsPerSecond: 4096,
      stepIntervalMs: 20, // Send commands every 20ms

      // Speed-limited single motor move
      setPositionLimited: function(id, targetPos) {
        var self = this;

        function getStartPos() {
          if (motorPositionCache[id] !== undefined) {
            return Promise.resolve(motorPositionCache[id]);
          }
          return self.getPosition(id);
        }

        return getStartPos().then(function(startPos) {
          var delta = Math.abs(targetPos - startPos);
          var durationMs = (delta / self.maxStepsPerSecond) * 1000;
          if (durationMs < 50) {
            return self.setPosition(id, targetPos);
          }

          var steps = Math.max(2, Math.floor(durationMs / self.stepIntervalMs));
          var stepDelay = durationMs / steps;
          var direction = targetPos > startPos ? 1 : -1;
          var stepSize = delta / steps;

          function doStep(step) {
            if (step > steps || stopRequested) return Promise.resolve();
            var pos = Math.round(startPos + direction * stepSize * step);
            return self.setPosition(id, pos).then(function() {
              return new Promise(function(r) { setTimeout(r, stepDelay); });
            }).then(function() {
              return doStep(step + 1);
            });
          }
          return doStep(1);
        });
      },

      // Speed-limited multi-motor move
      setPositionMultipleLimited: function(ids, positions) {
        var self = this;

        var positionPromises = ids.map(function(id) {
          if (motorPositionCache[id] !== undefined) {
            return Promise.resolve(motorPositionCache[id]);
          }
          return self.getPosition(id);
        });

        return Promise.all(positionPromises).then(function(startPositions) {
          var maxDelta = 0;
          for (var i = 0; i < ids.length; i++) {
            var delta = Math.abs(positions[i] - startPositions[i]);
            if (delta > maxDelta) maxDelta = delta;
          }

          var durationMs = (maxDelta / self.maxStepsPerSecond) * 1000;
          if (durationMs < 50) {
            return self.setPositionMultiple(ids, positions);
          }

          var steps = Math.max(2, Math.floor(durationMs / self.stepIntervalMs));
          var stepDelay = durationMs / steps;

          function doStep(step) {
            if (step > steps || stopRequested) return Promise.resolve();
            var t = step / steps;
            var currentPositions = [];
            for (var i = 0; i < ids.length; i++) {
              currentPositions.push(Math.round(startPositions[i] + (positions[i] - startPositions[i]) * t));
            }
            return self.setPositionMultiple(ids, currentPositions).then(function() {
              return new Promise(function(r) { setTimeout(r, stepDelay); });
            }).then(function() {
              return doStep(step + 1);
            });
          }
          return doStep(1);
        });
      },

      // ========== Kinematics API Methods ==========
      // Get all motor positions as degrees array (uses WASM)
      getAllPositions: function() {
        var self = this;
        if (!self.connected) {
          return Promise.resolve(self.motorIds.map(function() { return 0; }));
        }

        return window.wasm.get_head_joints().then(function(headJoints) {
          // Update cache
          for (var i = 0; i < headJoints.length; i++) {
            motorPositionCache[11 + i] = self.degreesToPosition(headJoints[i]);
          }
          return headJoints;
        });
      },

      // Set all motor positions from degrees array (uses WASM)
      setAllPositions: function(degrees) {
        return window.wasm.set_head_joints(degrees);
      },

      // Forward Kinematics: joint degrees -> coordinates [x, y, z, roll, pitch, yaw]
      jointsToCoordinates: function(degrees) {
        return callFK(degrees);
      },

      // Inverse Kinematics: coordinates -> joint degrees
      coordinatesToJoints: function(coordinates) {
        return callIK(coordinates);
      },

      // Set head to coordinates (does IK conversion internally)
      setHeadCoordinates: function(coordinates) {
        var joints = this.coordinatesToJoints(coordinates);
        return this.setAllPositions(joints);
      },

      // Get current head coordinates (does FK conversion internally)
      getHeadCoordinates: function() {
        var self = this;
        return this.getAllPositions().then(function(joints) {
          return self.jointsToCoordinates(joints);
        });
      }
    };

    // ========== UI Functions ==========
    function updateConnectionStatus(connected) {
      document.getElementById('statusDot').className = 'status-dot' + (connected ? ' connected' : '');
      document.getElementById('statusText').textContent = connected ? 'Connected' : 'Disconnected';
      document.getElementById('connectBtn').textContent = connected ? '🔌 Disconnect' : '🔌 Connect';

      // Disable/enable URL input based on connection status
      var urlInput = document.getElementById('robotUrl');
      if (urlInput) {
        urlInput.disabled = connected;
        urlInput.style.opacity = connected ? '0.5' : '1';
      }

      // Reset motor badges
      if (!connected) {
        Robot.motorIds.forEach(function(id) {
          var el = document.getElementById('motor' + id);
          if (el) {
            el.querySelector('span').textContent = '--';
            el.classList.remove('active');
          }
        });
      }
    }

    function toggleConnection() {
      if (Robot.connected) {
        Robot.disconnect();
      } else {
        Robot.connect();
      }
    }

    function enableAllTorque() {
      if (!Robot.connected) { logConsole('Not connected', 'error'); return; }
      Robot.setTorqueMultiple([11,12,13,14,15,16,17,18], true).then(function(results) {
        if (results.failed.length === 0) {
          logConsole('All motors enabled', 'success');
        }
      });
    }

    function disableAllTorque() {
      if (!Robot.connected) { logConsole('Not connected', 'error'); return; }
      Robot.setTorqueMultiple([11,12,13,14,15,16,17,18], false).then(function(results) {
        if (results.failed.length === 0) {
          logConsole('All motors disabled', 'success');
        }
      });
    }

    // Fallback motor check using position read (when get_motor_errors isn't available)
    function fallbackPositionCheck() {
      var allMotors = [11, 12, 13, 14, 15, 16, 17, 18];
      window.wasm.get_all_joints().then(function(joints) {
        console.log('Fallback - Joints:', joints);
        for (var i = 0; i < allMotors.length; i++) {
          var id = allMotors[i];
          var el = document.getElementById('motor' + id);
          if (el) {
            el.classList.remove('error');
            el.classList.add('active');
          }
        }
        logConsole('All ' + allMotors.length + ' motors responding', 'success');
      }).catch(function(e) {
        logConsole('Error reading joints: ' + e.message, 'error');
        var allMotors = [11, 12, 13, 14, 15, 16, 17, 18];
        for (var i = 0; i < allMotors.length; i++) {
          var el = document.getElementById('motor' + allMotors[i]);
          if (el) {
            el.classList.add('error');
            el.classList.remove('active');
          }
        }
      });
    }

    function checkMotors() {
      if (!Robot.connected) { logConsole('Not connected', 'error'); return; }
      logConsole('Checking all motors for hardware errors...', 'info');

      // Check if get_motor_errors exists, otherwise fall back to position check
      if (!window.wasm.get_motor_errors) {
        logConsole('get_motor_errors not available, using position check', 'info');
        fallbackPositionCheck();
        return;
      }

      window.wasm.get_motor_errors().then(function(rawErrors) {
        console.log('Raw errors response:', rawErrors, 'type:', typeof rawErrors);
        var allMotors = [11, 12, 13, 14, 15, 16, 17, 18];
        var ok = [];
        var withErrors = [];

        // Convert to regular array if needed (WASM might return typed array)
        var errors = rawErrors ? Array.from(rawErrors) : [];
        console.log('Converted errors:', errors);

        // Handle case where errors might not be returned properly
        if (!errors || errors.length === 0) {
          logConsole('Could not read motor errors, falling back to position check', 'warn');
          fallbackPositionCheck();
          return;
        }

        for (var i = 0; i < allMotors.length; i++) {
          var id = allMotors[i];
          var el = document.getElementById('motor' + id);
          var errorStatus = errors[i];

          // Check for undefined or null as well as 0
          if (errorStatus === 0 || errorStatus === undefined || errorStatus === null) {
            ok.push(id);
            if (el) {
              el.classList.remove('error');
              el.classList.add('active');
            }
          } else {
            withErrors.push(id);
            if (el) {
              el.classList.add('error');
              el.classList.remove('active');
            }
            logConsole('Motor ' + id + ' has hardware error: 0x' + errorStatus.toString(16).toUpperCase(), 'warn');
          }
        }

        if (withErrors.length === 0) {
          logConsole('All ' + ok.length + ' motors OK', 'success');
        } else {
          logConsole('Motors OK: ' + ok.join(', '), 'success');
          logConsole('Motors with errors (need reboot): ' + withErrors.join(', '), 'error');
        }
      }).catch(function(e) {
        logConsole('Error checking motors: ' + e.message, 'error');
      });
    }

    function rebootAllMotors() {
      if (!Robot.connected) { logConsole('Not connected', 'error'); return; }
      if (!confirm('Reboot all motors? Motors will lose torque during reboot.')) return;

      // Check if check_and_reboot_motors exists, otherwise fall back to reboot_all_motors
      if (!window.wasm.check_and_reboot_motors) {
        logConsole('Rebooting all motors...', 'warn');
        window.wasm.reboot_all_motors().then(function() {
          logConsole('All motors rebooted', 'success');
          setTimeout(checkMotors, 500);
        }).catch(function(e) {
          logConsole('Error: ' + e.message, 'error');
        });
        return;
      }

      logConsole('Checking and rebooting motors with errors...', 'warn');

      // Use the new check_and_reboot_motors function
      window.wasm.check_and_reboot_motors().then(function(result) {
        if (result.motors_rebooted.length === 0) {
          logConsole('No motors needed reboot', 'success');
        } else {
          logConsole('Rebooted ' + result.motors_rebooted.length + ' motor(s): ' + result.motors_rebooted.join(', '), 'success');
        }
        if (result.motors_no_response.length > 0) {
          logConsole('Motors did not respond: ' + result.motors_no_response.join(', '), 'warn');
        }
        // Re-check motors after reboot
        setTimeout(checkMotors, 500);
      }).catch(function(e) {
        logConsole('Error: ' + e.message, 'error');
      });
    }

    function runCode() {
      if (!Robot.connected) {
        logConsole('Please connect to the robot first', 'error');
        return;
      }
      stopRequested = false;
      programTimer = Date.now();
      var code = Blockly.JavaScript.workspaceToCode(workspace);
      if (!code.trim()) {
        logConsole('No blocks to run', 'error');
        return;
      }
      logConsole('Running program...', 'success');
      switchTab('console');
      var asyncCode = '(async function() { ' + code + ' })()';
      eval(asyncCode).then(function() {
        if (!stopRequested) logConsole('Program completed (' + ((Date.now() - programTimer)/1000).toFixed(1) + 's)', 'success');
      }).catch(function(e) {
        // Don't log stop requests as errors - they're intentional
        if (e.message === 'Stop requested') return;
        logConsole('Error: ' + e.message, 'error');
        console.error(e);
      });
    }

    function stopCode() {
      stopRequested = true;
      logConsole('Program stopped', 'warn');

      // Safety: disable torque to stop robot movement
      if (Robot.connected) {
        Robot.setTorqueMultiple(Robot.motorIds, false).then(function() {
          logConsole('Motors disabled for safety', 'info');
        }).catch(function(e) {
          console.error('Failed to disable motors:', e);
        });
      }
    }

    function saveWorkspace() {
      var xml = Blockly.Xml.workspaceToDom(workspace);
      var xmlText = Blockly.Xml.domToText(xml);
      var blob = new Blob([xmlText], {type: 'text/xml'});
      var a = document.createElement('a');
      a.download = 'reachy-program.xml';
      a.href = URL.createObjectURL(blob);
      a.click();
      logConsole('Workspace saved', 'success');
    }

    function loadWorkspace() {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = '.xml';
      input.onchange = function(e) {
        var file = e.target.files[0];
        var reader = new FileReader();
        reader.onload = function(e) {
          var xml = Blockly.utils.xml.textToDom(e.target.result);
          Blockly.Xml.clearWorkspaceAndLoadFromXml(xml, workspace);
          logConsole('Workspace loaded', 'success');
        };
        reader.readAsText(file);
      };
      input.click();
    }

    // ========== Custom Blocks ==========
    var ANTENNAS = [['Left antenna (17)','17'],['Right antenna (18)','18']];
    var HEAD_MOTORS = [['11','11'],['12','12'],['13','13'],['14','14'],['15','15'],['16','16']];
    var ALL_MOTORS = [['Head 11','11'],['Head 12','12'],['Head 13','13'],['Head 14','14'],['Head 15','15'],['Head 16','16'],['Left antenna (17)','17'],['Right antenna (18)','18']];
    var LOG_TYPES = [['info','info'],['success','success'],['warning','warn'],['error','error']];

    // === Connection Blocks ===
    Blockly.Blocks['enable_torque'] = {
      init: function() {
        this.appendDummyInput()
            .appendField('enable torque joint')
            .appendField(new Blockly.FieldDropdown(ALL_MOTORS), 'MOTOR');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(260);
        this.setTooltip('Enable torque for a single joint');
      }
    };
    Blockly.JavaScript.forBlock['enable_torque'] = function(block) {
      var motor = block.getFieldValue('MOTOR');
      return 'await Robot.setTorque(' + motor + ', true);\n';
    };

    Blockly.Blocks['disable_torque'] = {
      init: function() {
        this.appendDummyInput()
            .appendField('disable torque joint')
            .appendField(new Blockly.FieldDropdown(ALL_MOTORS), 'MOTOR');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(260);
        this.setTooltip('Disable torque for a single joint');
      }
    };
    Blockly.JavaScript.forBlock['disable_torque'] = function(block) {
      var motor = block.getFieldValue('MOTOR');
      return 'await Robot.setTorque(' + motor + ', false);\n';
    };

    Blockly.Blocks['enable_all'] = {
      init: function() {
        this.appendDummyInput().appendField('torque on');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(260);
      }
    };
    Blockly.JavaScript.forBlock['enable_all'] = function(block) {
      return 'await Robot.setTorqueMultiple([11,12,13,14,15,16,17,18], true);\n';
    };

    Blockly.Blocks['disable_all'] = {
      init: function() {
        this.appendDummyInput().appendField('torque off');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(260);
      }
    };
    Blockly.JavaScript.forBlock['disable_all'] = function(block) {
      return 'await Robot.setTorqueMultiple([11,12,13,14,15,16,17,18], false);\n';
    };

    Blockly.Blocks['check_joints'] = {
      init: function() {
        this.appendDummyInput().appendField('check all joints');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(260);
        this.setTooltip('Ping all joints, read positions, and log their status');
      }
    };
    Blockly.JavaScript.forBlock['check_joints'] = function(block) {
      return 'await (async function() { var results = await Robot.checkAllMotors(); var ok = [], failed = []; for (var id in results) { if (results[id].ok) ok.push(id); else failed.push(id); } if (failed.length === 0) { logConsole("All " + ok.length + " joints OK", "success"); var allMotors = [11,12,13,14,15,16,17,18]; for (var i = 0; i < allMotors.length; i++) { var id = allMotors[i]; var pos = await Robot.getPosition(id); var deg = Robot.positionToDegrees(pos).toFixed(1); logConsole("Joint " + id + ": " + pos + " (" + deg + "°)", "info"); } } else { logConsole("OK: " + ok.join(", ") + " | FAILED: " + failed.join(", "), "error"); } })();\n';
    };

    Blockly.Blocks['ping_joint'] = {
      init: function() {
        this.appendDummyInput()
            .appendField('joint')
            .appendField(new Blockly.FieldDropdown(ALL_MOTORS), 'MOTOR')
            .appendField('is responding');
        this.setOutput(true, 'Boolean');
        this.setColour(260);
        this.setTooltip('Check if a joint responds to ping');
      }
    };
    Blockly.JavaScript.forBlock['ping_joint'] = function(block) {
      var motor = block.getFieldValue('MOTOR');
      return ['(await Robot.pingMotor(' + motor + ')).ok', Blockly.JavaScript.ORDER_AWAIT];
    };

    Blockly.Blocks['reboot_joint'] = {
      init: function() {
        this.appendDummyInput()
            .appendField('reboot joint')
            .appendField(new Blockly.FieldDropdown(ALL_MOTORS), 'MOTOR');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(260);
        this.setTooltip('Reboot joint to clear hardware errors');
      }
    };
    Blockly.JavaScript.forBlock['reboot_joint'] = function(block) {
      var motor = block.getFieldValue('MOTOR');
      return 'await Robot.rebootMotor(' + motor + ');\n';
    };

    Blockly.Blocks['reboot_all'] = {
      init: function() {
        this.appendDummyInput().appendField('reboot all joints');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(260);
        this.setTooltip('Reboot all joints to clear hardware errors');
      }
    };
    Blockly.JavaScript.forBlock['reboot_all'] = function(block) {
      return 'await Robot.rebootAllMotors();\n';
    };

    // === Joint Blocks ===
    Blockly.Blocks['set_joint'] = {
      init: function() {
        this.appendValueInput('JOINT').setCheck('Number')
            .appendField('set joint')
            .appendField(new Blockly.FieldDropdown(ALL_MOTORS), 'MOTOR')
            .appendField('to');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(160);
        this.setTooltip('Set joint value (0-4095, center=2048)');
      }
    };
    Blockly.JavaScript.forBlock['set_joint'] = function(block) {
      var motor = block.getFieldValue('MOTOR');
      var joint = Blockly.JavaScript.valueToCode(block, 'JOINT', Blockly.JavaScript.ORDER_ATOMIC) || '2048';
      return 'await Robot.setPositionLimited(' + motor + ', ' + joint + ');\n';
    };

    Blockly.Blocks['set_degrees'] = {
      init: function() {
        this.appendValueInput('DEGREES').setCheck('Number')
            .appendField('set angle of')
            .appendField(new Blockly.FieldDropdown(ANTENNAS), 'MOTOR')
            .appendField('to');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(160);
        this.setTooltip('Set antenna angle in degrees (0 = center)');
      }
    };
    Blockly.JavaScript.forBlock['set_degrees'] = function(block) {
      var motor = block.getFieldValue('MOTOR');
      var deg = Blockly.JavaScript.valueToCode(block, 'DEGREES', Blockly.JavaScript.ORDER_ATOMIC) || '0';
      return 'await Robot.setDegrees(' + motor + ', ' + deg + ');\n';
    };

    Blockly.Blocks['get_joint'] = {
      init: function() {
        this.appendDummyInput()
            .appendField('value of joint')
            .appendField(new Blockly.FieldDropdown(ALL_MOTORS), 'MOTOR');
        this.setOutput(true, 'Number');
        this.setColour(160);
      }
    };
    Blockly.JavaScript.forBlock['get_joint'] = function(block) {
      var motor = block.getFieldValue('MOTOR');
      return ['await Robot.getPosition(' + motor + ')', Blockly.JavaScript.ORDER_AWAIT];
    };

    Blockly.Blocks['get_degrees'] = {
      init: function() {
        this.appendDummyInput()
            .appendField('get angle of')
            .appendField(new Blockly.FieldDropdown(ANTENNAS), 'MOTOR');
        this.setOutput(true, 'Number');
        this.setColour(160);
      }
    };
    Blockly.JavaScript.forBlock['get_degrees'] = function(block) {
      var motor = block.getFieldValue('MOTOR');
      return ['await Robot.getDegrees(' + motor + ')', Blockly.JavaScript.ORDER_AWAIT];
    };

    Blockly.Blocks['move_by'] = {
      init: function() {
        this.appendValueInput('AMOUNT').setCheck('Number')
            .appendField('change angle of')
            .appendField(new Blockly.FieldDropdown(ANTENNAS), 'MOTOR')
            .appendField('by');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(160);
        this.setTooltip('Change antenna angle by relative amount in degrees');
      }
    };
    Blockly.JavaScript.forBlock['move_by'] = function(block) {
      var motor = block.getFieldValue('MOTOR');
      var amount = Blockly.JavaScript.valueToCode(block, 'AMOUNT', Blockly.JavaScript.ORDER_ATOMIC) || '0';
      return 'await Robot.setDegrees(' + motor + ', (await Robot.getDegrees(' + motor + ')) + (' + amount + '));\n';
    };

    Blockly.Blocks['move_smooth'] = {
      init: function() {
        this.appendValueInput('JOINT').setCheck('Number')
            .appendField('smooth move joint')
            .appendField(new Blockly.FieldDropdown(ALL_MOTORS), 'MOTOR')
            .appendField('to');
        this.appendValueInput('DURATION').setCheck('Number').appendField('over');
        this.appendDummyInput().appendField('seconds');
        this.setInputsInline(true);
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(160);
        this.setTooltip('Smoothly move joint to value over time');
      }
    };
    Blockly.JavaScript.forBlock['move_smooth'] = function(block) {
      var motor = block.getFieldValue('MOTOR');
      var joint = Blockly.JavaScript.valueToCode(block, 'JOINT', Blockly.JavaScript.ORDER_ATOMIC) || '2048';
      var dur = Blockly.JavaScript.valueToCode(block, 'DURATION', Blockly.JavaScript.ORDER_ATOMIC) || '1';
      return 'await Robot.moveSmooth(' + motor + ', ' + joint + ', ' + dur + ' * 1000);\n';
    };

    // === Multi-Motor Blocks ===
    
    Blockly.Blocks['get_head_coordinates'] = {
      init: function() {
        this.appendDummyInput().appendField('get head coordinates');
        this.setOutput(true, 'Array');
        this.setColour(180);
        this.setTooltip('Returns [x, y, z, roll, pitch, yaw] for head position');
      }
    };
    Blockly.JavaScript.forBlock['get_head_coordinates'] = function(block) {
      return ['(Robot.jointsToCoordinates(await Robot.getAllPositions()))', Blockly.JavaScript.ORDER_FUNCTION_CALL];
    };

    Blockly.Blocks['set_head_coordinates'] = {
      init: function() {
        this.appendValueInput('COORDS').setCheck('Array')
            .appendField('set head to coordinates');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(180);
        this.setTooltip('Set head position from [x, y, z, roll, pitch, yaw]');
      }
    };
    Blockly.JavaScript.forBlock['set_head_coordinates'] = function(block) {
      var coords = Blockly.JavaScript.valueToCode(block, 'COORDS', Blockly.JavaScript.ORDER_ATOMIC) || '[0,0,0,0,0,0]';
      return 'await Robot.setAllPositions(Robot.coordinatesToJoints(' + coords + '));\n';
    };
    // === Kinematics Blocks ===

    var COORDINATE_COMPONENTS = [['x','0'],['y','1'],['z','2'],['roll','3'],['pitch','4'],['yaw','5']];

    Blockly.Blocks['joints_to_coordinates'] = {
      init: function() {
        this.appendValueInput('JOINTS').setCheck('Array')
            .appendField('head joints to coordinates');
        this.setOutput(true, 'Array');
        this.setColour(290);
        this.setTooltip('Convert a list of 6 head joint angles (degrees) to coordinates [x, y, z, roll, pitch, yaw]');
        this.setHelpUrl('');
      }
    };
    Blockly.JavaScript.forBlock['joints_to_coordinates'] = function(block) {
      var joints = Blockly.JavaScript.valueToCode(block, 'JOINTS', Blockly.JavaScript.ORDER_ATOMIC) || '[]';
      return ['Robot.jointsToCoordinates(' + joints + ')', Blockly.JavaScript.ORDER_FUNCTION_CALL];
    };

    Blockly.Blocks['coordinates_to_joints'] = {
      init: function() {
        this.appendValueInput('COORDINATES').setCheck('Array')
            .appendField('coordinates to head joints');
        this.setOutput(true, 'Array');
        this.setColour(290);
        this.setTooltip('Convert coordinates [x, y, z, roll, pitch, yaw] to a list of 6 head joint angles (degrees)');
      }
    };
    Blockly.JavaScript.forBlock['coordinates_to_joints'] = function(block) {
      var coordinates = Blockly.JavaScript.valueToCode(block, 'COORDINATES', Blockly.JavaScript.ORDER_ATOMIC) || '[0,0,0,0,0,0]';
      return ['Robot.coordinatesToJoints(' + coordinates + ')', Blockly.JavaScript.ORDER_FUNCTION_CALL];
    };

    Blockly.Blocks['create_coordinates'] = {
      init: function() {
        this.appendDummyInput().appendField('create coordinates');
        this.appendValueInput('X').setCheck('Number').appendField('x');
        this.appendValueInput('Y').setCheck('Number').appendField('y');
        this.appendValueInput('Z').setCheck('Number').appendField('z');
        this.appendValueInput('ROLL').setCheck('Number').appendField('roll');
        this.appendValueInput('PITCH').setCheck('Number').appendField('pitch');
        this.appendValueInput('YAW').setCheck('Number').appendField('yaw');
        this.setInputsInline(true);
        this.setOutput(true, 'Array');
        this.setColour(290);
        this.setTooltip('Create a coordinates list [x, y, z, roll, pitch, yaw]. x/y/z are position in mm, roll/pitch/yaw are rotation in degrees.');
      }
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

    Blockly.Blocks['get_coordinate'] = {
      init: function() {
        this.appendValueInput('COORDINATES').setCheck('Array')
            .appendField('get')
            .appendField(new Blockly.FieldDropdown(COORDINATE_COMPONENTS), 'COMPONENT')
            .appendField('from coordinates');
        this.setOutput(true, 'Number');
        this.setColour(290);
        this.setTooltip('Extract a single value from coordinates: x/y/z (position in mm) or roll/pitch/yaw (rotation in degrees).');
      }
    };
    Blockly.JavaScript.forBlock['get_coordinate'] = function(block) {
      var component = block.getFieldValue('COMPONENT');
      var coordinates = Blockly.JavaScript.valueToCode(block, 'COORDINATES', Blockly.JavaScript.ORDER_MEMBER) || '[0,0,0,0,0,0]';
      return ['(' + coordinates + ')[' + component + ']', Blockly.JavaScript.ORDER_MEMBER];
    };

    // === Sensing Blocks ===
    Blockly.Blocks['is_moving'] = {
      init: function() {
        this.appendDummyInput()
            .appendField('joint')
            .appendField(new Blockly.FieldDropdown(ALL_MOTORS), 'MOTOR')
            .appendField('is moving');
        this.setOutput(true, 'Boolean');
        this.setColour(210);
      }
    };
    Blockly.JavaScript.forBlock['is_moving'] = function(block) {
      var motor = block.getFieldValue('MOTOR');
      // Check if position changed from cached value (threshold: 1 degree)
      return ['(Math.abs((await Robot.getDegrees(' + motor + ')) - Robot.positionToDegrees(motorPositionCache[' + motor + '] || 2048)) > 1)', Blockly.JavaScript.ORDER_AWAIT];
    };

    Blockly.Blocks['wait_until_stopped'] = {
      init: function() {
        this.appendValueInput('TIMEOUT').setCheck('Number')
            .appendField('wait until joint')
            .appendField(new Blockly.FieldDropdown(ALL_MOTORS), 'MOTOR')
            .appendField('stopped, timeout');
        this.appendDummyInput().appendField('seconds');
        this.setInputsInline(true);
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(210);
      }
    };
    Blockly.JavaScript.forBlock['wait_until_stopped'] = function(block) {
      var motor = block.getFieldValue('MOTOR');
      var timeout = Blockly.JavaScript.valueToCode(block, 'TIMEOUT', Blockly.JavaScript.ORDER_ATOMIC) || '5';
      return 'var _start = Date.now(); var _lastPos = await Robot.getDegrees(' + motor + '); while (Date.now() - _start < ' + timeout + ' * 1000) { await new Promise(function(r) { setTimeout(r, 50); }); var _newPos = await Robot.getDegrees(' + motor + '); if (Math.abs(_newPos - _lastPos) < 0.5) break; _lastPos = _newPos; }\n';
    };

    Blockly.Blocks['get_load'] = {
      init: function() {
        this.appendDummyInput()
            .appendField('load of joint')
            .appendField(new Blockly.FieldDropdown(ALL_MOTORS), 'MOTOR');
        this.setOutput(true, 'Number');
        this.setColour(210);
        this.setTooltip('Get joint current load (-1000 to 1000)');
      }
    };
    Blockly.JavaScript.forBlock['get_load'] = function(block) {
      var motor = block.getFieldValue('MOTOR');
      return ['(await Robot.getLoad(' + motor + '))', Blockly.JavaScript.ORDER_AWAIT];
    };

    Blockly.Blocks['get_temperature'] = {
      init: function() {
        this.appendDummyInput()
            .appendField('temperature of joint')
            .appendField(new Blockly.FieldDropdown(ALL_MOTORS), 'MOTOR');
        this.setOutput(true, 'Number');
        this.setColour(210);
        this.setTooltip('Get joint temperature in °C');
      }
    };
    Blockly.JavaScript.forBlock['get_temperature'] = function(block) {
      var motor = block.getFieldValue('MOTOR');
      return ['(await Robot.getTemperature(' + motor + '))', Blockly.JavaScript.ORDER_AWAIT];
    };

    Blockly.Blocks['joint_in_range'] = {
      init: function() {
        this.appendValueInput('MIN').setCheck('Number')
            .appendField('joint')
            .appendField(new Blockly.FieldDropdown(ALL_MOTORS), 'MOTOR')
            .appendField('between');
        this.appendValueInput('MAX').setCheck('Number').appendField('and');
        this.setInputsInline(true);
        this.setOutput(true, 'Boolean');
        this.setColour(210);
      }
    };
    Blockly.JavaScript.forBlock['joint_in_range'] = function(block) {
      var motor = block.getFieldValue('MOTOR');
      var min = Blockly.JavaScript.valueToCode(block, 'MIN', Blockly.JavaScript.ORDER_ATOMIC) || '-180';
      var max = Blockly.JavaScript.valueToCode(block, 'MAX', Blockly.JavaScript.ORDER_ATOMIC) || '180';
      return ['(function() { var j = Robot.positionToDegrees(motorPositionCache[' + motor + '] || 2048); return j >= ' + min + ' && j <= ' + max + '; })()', Blockly.JavaScript.ORDER_FUNCTION_CALL];
    };

    // === Timing Blocks ===
    Blockly.Blocks['wait'] = {
      init: function() {
        this.appendValueInput('TIME').setCheck('Number').appendField('wait');
        this.appendDummyInput().appendField('seconds');
        this.setInputsInline(true);
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(120);
      }
    };
    Blockly.JavaScript.forBlock['wait'] = function(block) {
      var time = Blockly.JavaScript.valueToCode(block, 'TIME', Blockly.JavaScript.ORDER_ATOMIC) || '1';
      return 'await wait(' + time + ');\n';
    };

    Blockly.Blocks['wait_ms'] = {
      init: function() {
        this.appendValueInput('TIME').setCheck('Number').appendField('wait');
        this.appendDummyInput().appendField('milliseconds');
        this.setInputsInline(true);
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(120);
      }
    };
    Blockly.JavaScript.forBlock['wait_ms'] = function(block) {
      var time = Blockly.JavaScript.valueToCode(block, 'TIME', Blockly.JavaScript.ORDER_ATOMIC) || '100';
      return 'await sleep(' + time + ');\n';
    };

    Blockly.Blocks['get_time'] = {
      init: function() {
        this.appendDummyInput().appendField('current time (ms)');
        this.setOutput(true, 'Number');
        this.setColour(120);
      }
    };
    Blockly.JavaScript.forBlock['get_time'] = function(block) {
      return ['Date.now()', Blockly.JavaScript.ORDER_FUNCTION_CALL];
    };

    Blockly.Blocks['reset_timer'] = {
      init: function() {
        this.appendDummyInput().appendField('reset timer');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(120);
      }
    };
    Blockly.JavaScript.forBlock['reset_timer'] = function(block) {
      return 'programTimer = Date.now();\n';
    };

    Blockly.Blocks['timer_value'] = {
      init: function() {
        this.appendDummyInput().appendField('timer (seconds)');
        this.setOutput(true, 'Number');
        this.setColour(120);
      }
    };
    Blockly.JavaScript.forBlock['timer_value'] = function(block) {
      return ['((Date.now() - programTimer) / 1000)', Blockly.JavaScript.ORDER_DIVISION];
    };

    // === Output Blocks ===
    Blockly.Blocks['log'] = {
      init: function() {
        this.appendValueInput('MESSAGE').appendField('log');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(60);
      }
    };
    Blockly.JavaScript.forBlock['log'] = function(block) {
      var msg = Blockly.JavaScript.valueToCode(block, 'MESSAGE', Blockly.JavaScript.ORDER_ATOMIC) || '""';
      return 'logConsole(' + msg + ');\n';
    };

    Blockly.Blocks['log_joint'] = {
      init: function() {
        this.appendDummyInput()
            .appendField('log joint')
            .appendField(new Blockly.FieldDropdown(ALL_MOTORS), 'MOTOR');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(60);
      }
    };
    Blockly.JavaScript.forBlock['log_joint'] = function(block) {
      var motor = block.getFieldValue('MOTOR');
      return 'logConsole("Joint ' + motor + ': " + (await Robot.getDegrees(' + motor + ')).toFixed(1) + "°", "info");\n';
    };

    Blockly.Blocks['log_type'] = {
      init: function() {
        this.appendValueInput('MESSAGE').appendField('log');
        this.appendDummyInput()
            .appendField('as')
            .appendField(new Blockly.FieldDropdown(LOG_TYPES), 'TYPE');
        this.setInputsInline(true);
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(60);
      }
    };
    Blockly.JavaScript.forBlock['log_type'] = function(block) {
      var msg = Blockly.JavaScript.valueToCode(block, 'MESSAGE', Blockly.JavaScript.ORDER_ATOMIC) || '""';
      var type = block.getFieldValue('TYPE');
      return 'logConsole(' + msg + ', "' + type + '");\n';
    };

    Blockly.Blocks['alert'] = {
      init: function() {
        this.appendValueInput('MESSAGE').appendField('alert');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(60);
        this.setTooltip('Show a popup alert message');
      }
    };
    // Note: JavaScript and Python code generators have been moved to separate files:
    // - javascript-generator.js
    // - python-generator.js

    // ========== Workspace ==========
    window.workspace = Blockly.inject('blocklyDiv', {
      toolbox: document.getElementById('toolbox'),
      grid: { spacing: 20, length: 3, colour: '#2a2a4a', snap: true },
      zoom: { controls: true, startScale: 1.0, maxScale: 2, minScale: 0.5, scaleSpeed: 1.1 },
      trashcan: true,
      move: { scrollbars: true, drag: true, wheel: true }
    });

    // Note: Python generators have been moved to python-generator.js
    // Note: JavaScript generators have been moved to javascript-generator.js

    // Function to update code output based on selected language (made global)
    window.updateCodeOutput = function() {
      var workspace = window.workspace;
      var language = document.getElementById('languageSelect').value;
      var code;

      if (language === 'python') {
        code = Blockly.Python.workspaceToCode(workspace);
        if (!code || code.trim() === '') {
          code = '# Drag blocks here...';
        } else {
          // Wrap in main structure
          var imports = [];
          // Always import ReachyMini since we wrap code in the context manager
          imports.push('from reachy_mini import ReachyMini');

          if (code.includes('time.') || code.includes('program_timer')) {
            imports.push('import time');
          }
          if (code.includes('np.')) {
            imports.push('import numpy as np');
          }
          if (code.includes('create_head_pose')) {
            imports.push('from reachy_mini.utils import create_head_pose');
          }

          var header = '"""Generated by Blockly for Reachy Mini"""\n\n';
          if (imports.length > 0) {
            header += imports.join('\n') + '\n\n';
          }
          header += 'with ReachyMini(media_backend="no_media") as mini:\n';
          header += '    program_timer = time.time()\n';

          // Indent all code by 4 spaces
          var indentedCode = code.split('\n').map(function(line) {
            return line ? '    ' + line : '';
          }).join('\n');

          code = header + indentedCode;
        }
      } else {
        code = Blockly.JavaScript.workspaceToCode(workspace);
        if (!code || code.trim() === '') {
          code = '// Drag blocks here...';
        }
      }

      document.getElementById('codeOutput').textContent = code;
    }

    window.workspace.addChangeListener(function() {
      updateCodeOutput();
    });

    // NOTE: Python generator code moved to python-generator.js
    // NOTE: JavaScript generator code moved to javascript-generator.js


    // ========== Block Value Preview ==========
    window.workspace.addChangeListener(function(event) {
      if (event.type === Blockly.Events.BLOCK_CLICK) {
        var block = window.workspace.getBlockById(event.blockId);
        if (!block || !Robot.connected) return;

        // Preview blocks that fetch values
        var blockType = block.type;

        if (blockType === 'get_head_coordinates') {
          Robot.getAllPositions().then(function(joints) {
            var coords = Robot.jointsToCoordinates(joints);
            var formatted = '[' + coords.map(function(v) { return v.toFixed(2); }).join(', ') + ']';
            logConsole('Head coordinates: ' + formatted, 'info');
          }).catch(function(e) {
            logConsole('Failed to get head coordinates: ' + e.message, 'error');
          });
        } else if (blockType === 'get_degrees') {
          var motor = block.getFieldValue('MOTOR');
          Robot.getDegrees(motor).then(function(degrees) {
            var motorName = motor === '17' ? 'Left antenna' : motor === '18' ? 'Right antenna' : 'Motor ' + motor;
            logConsole(motorName + ' angle: ' + degrees.toFixed(1) + '°', 'info');
          }).catch(function(e) {
            logConsole('Failed to get degrees: ' + e.message, 'error');
          });
        } else if (blockType === 'get_joint') {
          var motor = block.getFieldValue('MOTOR');
          Robot.getPosition(motor).then(function(pos) {
            var degrees = Robot.positionToDegrees(pos);
            var motorName = motor === '17' ? 'Left antenna' : motor === '18' ? 'Right antenna' : 'Motor ' + motor;
            logConsole(motorName + ': ' + pos + ' (' + degrees.toFixed(1) + '°)', 'info');
          }).catch(function(e) {
            logConsole('Failed to get position: ' + e.message, 'error');
          });
        } else if (blockType === 'get_load') {
          var motor = block.getFieldValue('MOTOR');
          Robot.getLoad(motor).then(function(load) {
            var motorName = motor === '17' ? 'Left antenna' : motor === '18' ? 'Right antenna' : 'Motor ' + motor;
            logConsole(motorName + ' load: ' + load, 'info');
          }).catch(function(e) {
            logConsole('Failed to get load: ' + e.message, 'error');
          });
        } else if (blockType === 'get_temperature') {
          var motor = block.getFieldValue('MOTOR');
          Robot.getTemperature(motor).then(function(temp) {
            var motorName = motor === '17' ? 'Left antenna' : motor === '18' ? 'Right antenna' : 'Motor ' + motor;
            logConsole(motorName + ' temperature: ' + temp + '°C', 'info');
          }).catch(function(e) {
            logConsole('Failed to get temperature: ' + e.message, 'error');
          });
        }
      }
    });

    // ========== Multi-Select Functionality ==========
    var selectedBlocks = new Set();

    function highlightBlock(block, selected) {
      var svg = block.getSvgRoot();
      if (svg) {
        if (selected) {
          svg.style.filter = 'drop-shadow(0 0 8px #00ffff) drop-shadow(0 0 4px #00ffff)';
          svg.style.outline = '2px solid #00ffff';
          svg.style.outlineOffset = '2px';
        } else {
          svg.style.filter = '';
          svg.style.outline = '';
          svg.style.outlineOffset = '';
        }
      }
    }

    function selectBlock(block, addToSelection) {
      if (!addToSelection) {
        // Clear previous selection
        selectedBlocks.forEach(function(b) {
          if (b && b.getSvgRoot) highlightBlock(b, false);
        });
        selectedBlocks.clear();
      }

      if (block) {
        if (selectedBlocks.has(block)) {
          // Toggle off if already selected
          selectedBlocks.delete(block);
          highlightBlock(block, false);
        } else {
          selectedBlocks.add(block);
          highlightBlock(block, true);
        }
      }
    }

    function clearSelection() {
      selectedBlocks.forEach(function(b) {
        if (b && b.getSvgRoot) highlightBlock(b, false);
      });
      selectedBlocks.clear();
    }

    function deleteSelectedBlocks() {
      if (selectedBlocks.size === 0) return;
      var blocksToDelete = Array.from(selectedBlocks);
      clearSelection();
      blocksToDelete.forEach(function(block) {
        if (block && !block.disposed) {
          block.dispose(true, true);
        }
      });
    }

    function duplicateSelectedBlocks() {
      if (selectedBlocks.size === 0) return;
      var newBlocks = [];
      selectedBlocks.forEach(function(block) {
        if (block && !block.disposed) {
          var xml = Blockly.Xml.blockToDom(block);
          var newBlock = Blockly.Xml.domToBlock(xml, workspace);
          var pos = block.getRelativeToSurfaceXY();
          newBlock.moveBy(pos.x + 30, pos.y + 30);
          newBlocks.push(newBlock);
        }
      });
      clearSelection();
      newBlocks.forEach(function(b) { selectBlock(b, true); });
    }

    // Listen for block clicks with Shift key
    window.workspace.addChangeListener(function(event) {
      if (event.type === Blockly.Events.CLICK) {
        var block = window.workspace.getBlockById(event.blockId);
        if (block) {
          // Check if Shift key was held (we detect this via a global flag)
          if (window.shiftKeyHeld) {
            selectBlock(block, true);
          }
        }
      } else if (event.type === Blockly.Events.BLOCK_DELETE) {
        // Remove deleted blocks from selection
        selectedBlocks.forEach(function(b) {
          if (b && b.disposed) selectedBlocks.delete(b);
        });
      }
    });

    // Track Shift key state globally
    window.shiftKeyHeld = false;
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Shift') window.shiftKeyHeld = true;

      // Delete key removes selected blocks
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedBlocks.size > 0 && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
          e.preventDefault();
          deleteSelectedBlocks();
        }
      }

      // Ctrl+D or Cmd+D duplicates selected blocks
      if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
        if (selectedBlocks.size > 0) {
          e.preventDefault();
          duplicateSelectedBlocks();
        }
      }

      // Escape clears selection
      if (e.key === 'Escape') {
        clearSelection();
      }
    });

    document.addEventListener('keyup', function(e) {
      if (e.key === 'Shift') window.shiftKeyHeld = false;
    });

    // ========== Box Selection ==========
    var blocklyDiv = document.getElementById('blocklyDiv');
    var selectionBox = null;
    var boxStartX = 0, boxStartY = 0;
    var isBoxSelecting = false;

    // Create selection box element
    function createSelectionBox() {
      var box = document.createElement('div');
      box.style.position = 'absolute';
      box.style.border = '2px dashed #00ffff';
      box.style.backgroundColor = 'rgba(0, 255, 255, 0.1)';
      box.style.pointerEvents = 'none';
      box.style.zIndex = '1000';
      box.style.display = 'none';
      blocklyDiv.appendChild(box);
      return box;
    }
    selectionBox = createSelectionBox();

    blocklyDiv.addEventListener('mousedown', function(e) {
      // Only start box selection on workspace background
      var isBackground = e.target.classList.contains('blocklyMainBackground') ||
                         (e.target.tagName === 'svg' && e.target.classList.contains('blocklySvg'));

      if (isBackground && e.button === 0) {
        // Clear selection unless shift is held
        if (!window.shiftKeyHeld) {
          clearSelection();
        }

        // Start box selection
        isBoxSelecting = true;
        var rect = blocklyDiv.getBoundingClientRect();
        boxStartX = e.clientX - rect.left;
        boxStartY = e.clientY - rect.top;

        selectionBox.style.left = boxStartX + 'px';
        selectionBox.style.top = boxStartY + 'px';
        selectionBox.style.width = '0';
        selectionBox.style.height = '0';
        selectionBox.style.display = 'block';

        e.preventDefault();
      }
    });

    document.addEventListener('mousemove', function(e) {
      if (!isBoxSelecting) return;

      var rect = blocklyDiv.getBoundingClientRect();
      var currentX = e.clientX - rect.left;
      var currentY = e.clientY - rect.top;

      // Calculate box dimensions (handle negative direction)
      var left = Math.min(boxStartX, currentX);
      var top = Math.min(boxStartY, currentY);
      var width = Math.abs(currentX - boxStartX);
      var height = Math.abs(currentY - boxStartY);

      selectionBox.style.left = left + 'px';
      selectionBox.style.top = top + 'px';
      selectionBox.style.width = width + 'px';
      selectionBox.style.height = height + 'px';
    });

    document.addEventListener('mouseup', function(e) {
      if (!isBoxSelecting) return;
      isBoxSelecting = false;
      selectionBox.style.display = 'none';

      // Get the selection box bounds in workspace coordinates
      var rect = blocklyDiv.getBoundingClientRect();
      var currentX = e.clientX - rect.left;
      var currentY = e.clientY - rect.top;

      var boxLeft = Math.min(boxStartX, currentX);
      var boxTop = Math.min(boxStartY, currentY);
      var boxRight = Math.max(boxStartX, currentX);
      var boxBottom = Math.max(boxStartY, currentY);

      // Only select if box is larger than 5px (to avoid accidental clicks)
      if (boxRight - boxLeft < 5 && boxBottom - boxTop < 5) return;

      // Get workspace metrics for coordinate conversion
      var metrics = workspace.getMetrics();
      var scale = workspace.scale;

      // Find blocks that intersect with the selection box
      var allBlocks = workspace.getAllBlocks(false);
      allBlocks.forEach(function(block) {
        var blockSvg = block.getSvgRoot();
        if (!blockSvg) return;

        // Get block bounding box in screen coordinates
        var blockRect = blockSvg.getBoundingClientRect();
        var blockLeft = blockRect.left - rect.left;
        var blockTop = blockRect.top - rect.top;
        var blockRight = blockRect.right - rect.left;
        var blockBottom = blockRect.bottom - rect.top;

        // Check intersection
        var intersects = !(blockRight < boxLeft || blockLeft > boxRight ||
                          blockBottom < boxTop || blockTop > boxBottom);

        if (intersects) {
          selectBlock(block, true);
        }
      });
    });

    logConsole('Ready! Connect to your robot to start.', 'info');
    logConsole('Tip: Drag on workspace to box-select, Shift+click to add, Delete to remove', 'info');
    logConsole('Tip: Use Save/Load to keep your programs', 'info');

    // ========== JS to Blockly Converter ==========
    function jsToBlocks(jsCode) {
      try {
        // Strip 'await' keywords since Blockly doesn't use async/await
        // All blocks execute sequentially anyway
        jsCode = jsCode.replace(/\bawait\s+/g, '');

        // Parse JavaScript to AST
        var ast = acorn.parse(jsCode, { ecmaVersion: 2020, sourceType: 'script' });

        // Find lowest Y position of existing blocks to append below
        var existingBlocks = workspace.getTopBlocks(false);
        var yPos = 50;
        for (var i = 0; i < existingBlocks.length; i++) {
          var blockY = existingBlocks[i].getRelativeToSurfaceXY().y;
          var blockHeight = existingBlocks[i].getHeightWidth().height;
          var bottomY = blockY + blockHeight + 30; // 30px gap
          if (bottomY > yPos) yPos = bottomY;
        }

        // Process top-level statements and append to workspace
        var lastBlock = null;

        for (var i = 0; i < ast.body.length; i++) {
          var stmt = ast.body[i];
          var block = processStatement(stmt);
          if (block) {
            if (lastBlock && lastBlock.nextConnection && block.previousConnection) {
              lastBlock.nextConnection.connect(block.previousConnection);
            } else {
              block.moveBy(50, yPos);
              yPos += 80;
            }
            lastBlock = getLastBlock(block);
          }
        }

        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    function getLastBlock(block) {
      while (block.nextConnection && block.nextConnection.targetBlock()) {
        block = block.nextConnection.targetBlock();
      }
      return block;
    }

    function processStatement(node) {
      if (!node) return null;

      // Expression statement (function calls)
      if (node.type === 'ExpressionStatement') {
        return processExpression(node.expression, true);
      }

      // Variable declaration: let x = value;
      if (node.type === 'VariableDeclaration') {
        var declarations = node.declarations;
        var firstBlock = null;
        var lastBlock = null;

        for (var i = 0; i < declarations.length; i++) {
          var decl = declarations[i];
          var varName = decl.id.name;

          var block = workspace.newBlock('variables_set');
          block.initSvg();

          var variable = workspace.createVariable(varName);
          block.setFieldValue(variable.getId(), 'VAR');

          if (decl.init) {
            var valueBlock = processExpression(decl.init, false);
            if (valueBlock) connectValue(block, 'VALUE', valueBlock);
          }

          block.render();

          if (!firstBlock) firstBlock = block;
          if (lastBlock && lastBlock.nextConnection) {
            lastBlock.nextConnection.connect(block.previousConnection);
          }
          lastBlock = block;
        }

        return firstBlock;
      }

      // For loop: for (let i = start; i < end; i++)
      if (node.type === 'ForStatement') {
        var block = workspace.newBlock('controls_for');
        block.initSvg();

        // Get variable name and create it in workspace
        if (node.init && node.init.declarations) {
          var varName = node.init.declarations[0].id.name;
          var variable = workspace.createVariable(varName);
          block.setFieldValue(variable.getId(), 'VAR');

          // FROM value
          var fromVal = node.init.declarations[0].init;
          if (fromVal) {
            var fromBlock = processExpression(fromVal, false);
            if (fromBlock) connectValue(block, 'FROM', fromBlock);
          }
        }

        // TO value (from condition i < end)
        if (node.test && node.test.right) {
          var toBlock = processExpression(node.test.right, false);
          if (toBlock) connectValue(block, 'TO', toBlock);
        }

        // BY value (default 1)
        var byBlock = workspace.newBlock('math_number');
        byBlock.setFieldValue('1', 'NUM');
        byBlock.initSvg();
        connectValue(block, 'BY', byBlock);

        // Body
        if (node.body && node.body.body) {
          var firstBodyBlock = null;
          var lastBodyBlock = null;
          for (var i = 0; i < node.body.body.length; i++) {
            var bodyBlock = processStatement(node.body.body[i]);
            if (bodyBlock) {
              if (!firstBodyBlock) firstBodyBlock = bodyBlock;
              if (lastBodyBlock && lastBodyBlock.nextConnection) {
                lastBodyBlock.nextConnection.connect(bodyBlock.previousConnection);
              }
              lastBodyBlock = getLastBlock(bodyBlock);
            }
          }
          if (firstBodyBlock) {
            block.getInput('DO').connection.connect(firstBodyBlock.previousConnection);
          }
        }

        block.render();
        return block;
      }

      // While loop
      if (node.type === 'WhileStatement') {
        var block = workspace.newBlock('controls_whileUntil');
        block.initSvg();

        var condBlock = processExpression(node.test, false);
        if (condBlock) connectValue(block, 'BOOL', condBlock);

        if (node.body && node.body.body) {
          var firstBodyBlock = null;
          var lastBodyBlock = null;
          for (var i = 0; i < node.body.body.length; i++) {
            var bodyBlock = processStatement(node.body.body[i]);
            if (bodyBlock) {
              if (!firstBodyBlock) firstBodyBlock = bodyBlock;
              if (lastBodyBlock && lastBodyBlock.nextConnection) {
                lastBodyBlock.nextConnection.connect(bodyBlock.previousConnection);
              }
              lastBodyBlock = getLastBlock(bodyBlock);
            }
          }
          if (firstBodyBlock) {
            block.getInput('DO').connection.connect(firstBodyBlock.previousConnection);
          }
        }

        block.render();
        return block;
      }

      // If statement
      if (node.type === 'IfStatement') {
        var block = workspace.newBlock('controls_if');

        // If there's an else clause, we need to mutate the block BEFORE initSvg
        if (node.alternate) {
          block.elseCount_ = 1;
          block.updateShape_();
        }

        block.initSvg();

        var condBlock = processExpression(node.test, false);
        if (condBlock) connectValue(block, 'IF0', condBlock);

        if (node.consequent && node.consequent.body) {
          var firstBodyBlock = null;
          var lastBodyBlock = null;
          for (var i = 0; i < node.consequent.body.length; i++) {
            var bodyBlock = processStatement(node.consequent.body[i]);
            if (bodyBlock) {
              if (!firstBodyBlock) firstBodyBlock = bodyBlock;
              if (lastBodyBlock && lastBodyBlock.nextConnection) {
                lastBodyBlock.nextConnection.connect(bodyBlock.previousConnection);
              }
              lastBodyBlock = getLastBlock(bodyBlock);
            }
          }
          if (firstBodyBlock) {
            block.getInput('DO0').connection.connect(firstBodyBlock.previousConnection);
          }
        }

        // Handle else clause
        if (node.alternate && node.alternate.body) {
          var firstElseBlock = null;
          var lastElseBlock = null;
          for (var i = 0; i < node.alternate.body.length; i++) {
            var elseBlock = processStatement(node.alternate.body[i]);
            if (elseBlock) {
              if (!firstElseBlock) firstElseBlock = elseBlock;
              if (lastElseBlock && lastElseBlock.nextConnection) {
                lastElseBlock.nextConnection.connect(elseBlock.previousConnection);
              }
              lastElseBlock = getLastBlock(elseBlock);
            }
          }
          if (firstElseBlock) {
            block.getInput('ELSE').connection.connect(firstElseBlock.previousConnection);
          }
        }

        block.render();
        return block;
      }

      return null;
    }

    function processExpression(node, asStatement) {
      if (!node) return null;

      // Await expression
      if (node.type === 'AwaitExpression') {
        return processExpression(node.argument, asStatement);
      }

      // Assignment expression: x = value, x += value, arr[i] = value
      if (node.type === 'AssignmentExpression') {
        // Handle array index assignment: arr[i] = value
        if (node.left.type === 'MemberExpression' && node.left.computed) {
          var block = workspace.newBlock('lists_setIndex');
          block.initSvg();
          block.setFieldValue('SET', 'MODE');
          block.setFieldValue('FROM_START', 'WHERE');
          var listBlock = processExpression(node.left.object, false);
          if (listBlock) connectValue(block, 'LIST', listBlock);

          // Blockly uses 1-based indexing, JavaScript uses 0-based
          // For literal numbers, add 1 to convert from JS (0-based) to Blockly (1-based)
          if (node.left.property.type === 'Literal' && typeof node.left.property.value === 'number') {
            var adjustedIndexBlock = workspace.newBlock('math_number');
            adjustedIndexBlock.initSvg();
            adjustedIndexBlock.setFieldValue(String(node.left.property.value + 1), 'NUM');
            adjustedIndexBlock.render();
            connectValue(block, 'AT', adjustedIndexBlock);
          } else {
            // For variables/expressions, wrap in (index + 1)
            var indexBlock = processExpression(node.left.property, false);
            if (indexBlock) {
              var addBlock = workspace.newBlock('math_arithmetic');
              addBlock.initSvg();
              addBlock.setFieldValue('ADD', 'OP');
              connectValue(addBlock, 'A', indexBlock);
              var oneBlock = workspace.newBlock('math_number');
              oneBlock.initSvg();
              oneBlock.setFieldValue('1', 'NUM');
              oneBlock.render();
              connectValue(addBlock, 'B', oneBlock);
              addBlock.render();
              connectValue(block, 'AT', addBlock);
            }
          }

          var valueBlock = processExpression(node.right, false);
          if (valueBlock) connectValue(block, 'TO', valueBlock);
          block.render();
          return block;
        }

        var varName = node.left.name;

        // Handle compound assignment: +=, -=, *=, /=
        if (node.operator !== '=') {
          var opMap = { '+=': 'ADD', '-=': 'MINUS', '*=': 'MULTIPLY', '/=': 'DIVIDE', '%=': 'MODULO' };
          var op = opMap[node.operator];
          if (op) {
            var block = workspace.newBlock('variables_set');
            block.initSvg();
            var variable = workspace.createVariable(varName);
            block.setFieldValue(variable.getId(), 'VAR');

            // Create math block: varName OP right
            var mathBlock = workspace.newBlock('math_arithmetic');
            mathBlock.setFieldValue(op, 'OP');
            mathBlock.initSvg();

            var varBlock = workspace.newBlock('variables_get');
            varBlock.initSvg();
            var varRef = workspace.createVariable(varName);
            varBlock.setFieldValue(varRef.getId(), 'VAR');
            varBlock.render();
            connectValue(mathBlock, 'A', varBlock);

            var rightBlock = processExpression(node.right, false);
            if (rightBlock) connectValue(mathBlock, 'B', rightBlock);
            mathBlock.render();

            connectValue(block, 'VALUE', mathBlock);
            block.render();
            return block;
          }
        }

        // Simple assignment: x = value
        var block = workspace.newBlock('variables_set');
        block.initSvg();
        var variable = workspace.createVariable(varName);
        block.setFieldValue(variable.getId(), 'VAR');
        var valueBlock = processExpression(node.right, false);
        if (valueBlock) connectValue(block, 'VALUE', valueBlock);
        block.render();
        return block;
      }

      // Call expression
      if (node.type === 'CallExpression') {
        // Handle Math functions
        if (node.callee.type === 'MemberExpression' &&
            node.callee.object.name === 'Math') {
          var mathFunc = node.callee.property.name;

          // Trigonometric functions use math_trig block
          var trigOpMap = {
            'sin': 'SIN',
            'cos': 'COS',
            'tan': 'TAN',
            'asin': 'ASIN',
            'acos': 'ACOS',
            'atan': 'ATAN'
          };
          if (trigOpMap[mathFunc] && node.arguments.length >= 1) {
            var block = workspace.newBlock('math_trig');
            block.setFieldValue(trigOpMap[mathFunc], 'OP');
            block.initSvg();

            // Extract the angle value from the conversion pattern
            // Pattern: Math.cos(angle * Math.PI / 180) -> extract 'angle'
            var arg = node.arguments[0];
            var angleExpr = arg;

            // Check if argument is (expr * Math.PI / 180) - degrees to radians conversion
            if (arg.type === 'BinaryExpression' && arg.operator === '/') {
              var left = arg.left;
              var right = arg.right;
              // Check for (expr * Math.PI) / 180
              if (left.type === 'BinaryExpression' && left.operator === '*' &&
                  right.type === 'Literal' && right.value === 180) {
                // Check if left side is expr * Math.PI
                if (left.right.type === 'MemberExpression' &&
                    left.right.object.name === 'Math' &&
                    left.right.property.name === 'PI') {
                  // Found the pattern! Extract the angle expression
                  angleExpr = left.left;
                }
              }
            }

            var argBlock = processExpression(angleExpr, false);
            if (argBlock) connectValue(block, 'NUM', argBlock);
            block.render();
            return block;
          }

          // Rounding functions use math_round block
          var roundOpMap = {
            'floor': 'ROUNDDOWN',
            'ceil': 'ROUNDUP',
            'round': 'ROUND'
          };
          if (roundOpMap[mathFunc] && node.arguments.length >= 1) {
            var block = workspace.newBlock('math_round');
            block.setFieldValue(roundOpMap[mathFunc], 'OP');
            block.initSvg();
            var argBlock = processExpression(node.arguments[0], false);
            if (argBlock) connectValue(block, 'NUM', argBlock);
            block.render();
            return block;
          }

          // Other single-argument math functions use math_single block
          var mathOpMap = {
            'abs': 'ABS',
            'sqrt': 'ROOT'
          };
          if (mathOpMap[mathFunc] && node.arguments.length >= 1) {
            var block = workspace.newBlock('math_single');
            block.setFieldValue(mathOpMap[mathFunc], 'OP');
            block.initSvg();
            var argBlock = processExpression(node.arguments[0], false);
            if (argBlock) connectValue(block, 'NUM', argBlock);
            block.render();
            return block;
          }
        }

        // Handle Date.now() -> get_time block
        if (node.callee.type === 'MemberExpression' &&
            node.callee.object.name === 'Date' &&
            node.callee.property.name === 'now' &&
            node.arguments.length === 0) {
          var block = workspace.newBlock('get_time');
          block.initSvg();
          block.render();
          return block;
        }

        return processCall(node, asStatement);
      }

      // Number literal
      if (node.type === 'Literal' && typeof node.value === 'number') {
        var block = workspace.newBlock('math_number');
        block.setFieldValue(String(node.value), 'NUM');
        block.initSvg();
        block.render();
        return block;
      }

      // String literal
      if (node.type === 'Literal' && typeof node.value === 'string') {
        var block = workspace.newBlock('text');
        block.setFieldValue(node.value, 'TEXT');
        block.initSvg();
        block.render();
        return block;
      }

      // Boolean literal
      if (node.type === 'Literal' && typeof node.value === 'boolean') {
        var block = workspace.newBlock('logic_boolean');
        block.setFieldValue(node.value ? 'TRUE' : 'FALSE', 'BOOL');
        block.initSvg();
        block.render();
        return block;
      }

      // Unary expression: -x, !x
      if (node.type === 'UnaryExpression') {
        if (node.operator === '-') {
          var block = workspace.newBlock('math_single');
          block.setFieldValue('NEG', 'OP');
          block.initSvg();
          var argBlock = processExpression(node.argument, false);
          if (argBlock) connectValue(block, 'NUM', argBlock);
          block.render();
          return block;
        }
        if (node.operator === '!') {
          var block = workspace.newBlock('logic_negate');
          block.initSvg();
          var argBlock = processExpression(node.argument, false);
          if (argBlock) connectValue(block, 'BOOL', argBlock);
          block.render();
          return block;
        }
      }

      // Logical expression: && ||
      if (node.type === 'LogicalExpression') {
        var block = workspace.newBlock('logic_operation');
        block.setFieldValue(node.operator === '&&' ? 'AND' : 'OR', 'OP');
        block.initSvg();
        var leftBlock = processExpression(node.left, false);
        var rightBlock = processExpression(node.right, false);
        if (leftBlock) connectValue(block, 'A', leftBlock);
        if (rightBlock) connectValue(block, 'B', rightBlock);
        block.render();
        return block;
      }

      // Binary expression (comparisons, math)
      if (node.type === 'BinaryExpression') {
        var opMap = {
          '==': 'EQ', '===': 'EQ', '!=': 'NEQ', '!==': 'NEQ',
          '<': 'LT', '<=': 'LTE', '>': 'GT', '>=': 'GTE',
          '+': 'ADD', '-': 'MINUS', '*': 'MULTIPLY', '/': 'DIVIDE', '%': 'MODULO'
        };

        // Special case: inverse trig functions with radian-to-degree conversion
        // Pattern: Math.asin(x) * 180 / Math.PI -> extract as asin(x) block
        if (node.operator === '/' && node.right.type === 'MemberExpression' &&
            node.right.object.name === 'Math' && node.right.property.name === 'PI') {
          var left = node.left;
          // Check for (Math.asin(x) * 180)
          if (left.type === 'BinaryExpression' && left.operator === '*' &&
              left.right.type === 'Literal' && left.right.value === 180) {
            var trigCall = left.left;
            // Check if it's an inverse trig function
            if (trigCall.type === 'CallExpression' &&
                trigCall.callee.type === 'MemberExpression' &&
                trigCall.callee.object.name === 'Math') {
              var funcName = trigCall.callee.property.name;
              var inverseTrigMap = { 'asin': 'ASIN', 'acos': 'ACOS', 'atan': 'ATAN' };
              if (inverseTrigMap[funcName] && trigCall.arguments.length >= 1) {
                // Found the pattern! Create math_trig block for inverse function
                var block = workspace.newBlock('math_trig');
                block.setFieldValue(inverseTrigMap[funcName], 'OP');
                block.initSvg();
                var argBlock = processExpression(trigCall.arguments[0], false);
                if (argBlock) connectValue(block, 'NUM', argBlock);
                block.render();
                return block;
              }
            }
          }
        }

        if (['==', '===', '!=', '!==', '<', '<=', '>', '>='].includes(node.operator)) {
          var block = workspace.newBlock('logic_compare');
          block.setFieldValue(opMap[node.operator], 'OP');
          block.initSvg();
          var leftBlock = processExpression(node.left, false);
          var rightBlock = processExpression(node.right, false);
          if (leftBlock) connectValue(block, 'A', leftBlock);
          if (rightBlock) connectValue(block, 'B', rightBlock);
          block.render();
          return block;
        }

        // Check if this is string concatenation (+ with a string anywhere in the chain)
        if (node.operator === '+') {
          var parts = flattenStringConcat(node);
          var hasString = parts.some(function(p) { return p.type === 'Literal' && typeof p.value === 'string'; });

          if (hasString) {
            var block = workspace.newBlock('text_join');
            block.initSvg();
            block.itemCount_ = parts.length;
            block.updateShape_();
            for (var i = 0; i < parts.length; i++) {
              var partBlock = processExpression(parts[i], false);
              if (partBlock) connectValue(block, 'ADD' + i, partBlock);
            }
            block.render();
            return block;
          }
        }

        if (['+', '-', '*', '/', '%'].includes(node.operator)) {
          var block = workspace.newBlock('math_arithmetic');
          block.setFieldValue(opMap[node.operator], 'OP');
          block.initSvg();
          var leftBlock = processExpression(node.left, false);
          var rightBlock = processExpression(node.right, false);
          if (leftBlock) connectValue(block, 'A', leftBlock);
          if (rightBlock) connectValue(block, 'B', rightBlock);
          block.render();
          return block;
        }
      }

      // Identifier (variable)
      if (node.type === 'Identifier') {
        var block = workspace.newBlock('variables_get');
        var variable = workspace.createVariable(node.name);
        block.setFieldValue(variable.getId(), 'VAR');
        block.initSvg();
        block.render();
        return block;
      }

      // Member expression: obj.prop or arr[i]
      if (node.type === 'MemberExpression') {
        // Math.PI -> math_constant block with PI value
        if (!node.computed && node.object.name === 'Math' && node.property.name === 'PI') {
          var block = workspace.newBlock('math_constant');
          block.initSvg();
          block.setFieldValue('PI', 'CONSTANT');
          block.render();
          return block;
        }

        // arr.length -> lists_length
        if (!node.computed && node.property.name === 'length') {
          var block = workspace.newBlock('lists_length');
          block.initSvg();
          var listBlock = processExpression(node.object, false);
          if (listBlock) connectValue(block, 'VALUE', listBlock);
          block.render();
          return block;
        }

        // arr[i] -> lists_getIndex
        if (node.computed) {
          var block = workspace.newBlock('lists_getIndex');
          block.initSvg();
          block.setFieldValue('GET', 'MODE');
          block.setFieldValue('FROM_START', 'WHERE');
          var listBlock = processExpression(node.object, false);
          if (listBlock) connectValue(block, 'VALUE', listBlock);

          // Blockly uses 1-based indexing, JavaScript uses 0-based
          // For literal numbers, add 1 to convert from JS (0-based) to Blockly (1-based)
          if (node.property.type === 'Literal' && typeof node.property.value === 'number') {
            var adjustedIndexBlock = workspace.newBlock('math_number');
            adjustedIndexBlock.initSvg();
            adjustedIndexBlock.setFieldValue(String(node.property.value + 1), 'NUM');
            adjustedIndexBlock.render();
            connectValue(block, 'AT', adjustedIndexBlock);
          } else {
            // For variables/expressions, wrap in (index + 1)
            var indexBlock = processExpression(node.property, false);
            if (indexBlock) {
              var addBlock = workspace.newBlock('math_arithmetic');
              addBlock.initSvg();
              addBlock.setFieldValue('ADD', 'OP');
              connectValue(addBlock, 'A', indexBlock);
              var oneBlock = workspace.newBlock('math_number');
              oneBlock.initSvg();
              oneBlock.setFieldValue('1', 'NUM');
              oneBlock.render();
              connectValue(addBlock, 'B', oneBlock);
              addBlock.render();
              connectValue(block, 'AT', addBlock);
            }
          }

          block.render();
          return block;
        }
      }

      // Array expression [1, 2, 3]
      if (node.type === 'ArrayExpression') {
        // Special case: 6-element arrays are coordinates [x, y, z, roll, pitch, yaw]
        // Use the child-friendly "create coordinates" block instead of generic list
        if (node.elements.length === 6) {
          var block = workspace.newBlock('create_coordinates');
          block.initSvg();
          var fieldNames = ['X', 'Y', 'Z', 'ROLL', 'PITCH', 'YAW'];
          for (var i = 0; i < 6; i++) {
            var elemBlock = processExpression(node.elements[i], false);
            if (elemBlock) connectValue(block, fieldNames[i], elemBlock);
          }
          block.render();
          return block;
        }

        // Generic list for other cases
        var block = workspace.newBlock('lists_create_with');
        block.initSvg();
        // Set number of items
        var itemCount = node.elements.length;
        block.itemCount_ = itemCount;
        block.updateShape_();
        // Add each element
        for (var i = 0; i < itemCount; i++) {
          var elemBlock = processExpression(node.elements[i], false);
          if (elemBlock) connectValue(block, 'ADD' + i, elemBlock);
        }
        block.render();
        return block;
      }

      return null;
    }

    function processCall(node, asStatement) {
      var callee = getCalleeName(node.callee);
      var args = node.arguments;

      // Robot.setPositionLimited(motor, pos) -> set_joint
      if (callee === 'Robot.setPositionLimited' && args.length >= 2) {
        var block = workspace.newBlock('set_joint');
        block.initSvg();
        setMotorField(block, args[0]);
        var posBlock = processExpression(args[1], false);
        if (posBlock) connectValue(block, 'JOINT', posBlock);
        block.render();
        return block;
      }

      // Robot.getPosition(motor) -> get_joint
      if (callee === 'Robot.getPosition' && args.length >= 1) {
        var block = workspace.newBlock('get_joint');
        block.initSvg();
        setMotorField(block, args[0]);
        block.render();
        return block;
      }

      // Robot.setTorque(motor, true) -> enable_torque
      if (callee === 'Robot.setTorque' && args.length >= 2) {
        var enable = args[1].value === true;
        var block = workspace.newBlock(enable ? 'enable_torque' : 'disable_torque');
        block.initSvg();
        setMotorField(block, args[0]);
        block.render();
        return block;
      }

      // Robot.setTorqueMultiple -> enable_all / disable_all
      if (callee === 'Robot.setTorqueMultiple' && args.length >= 2) {
        var enable = args[1].value === true;
        var block = workspace.newBlock(enable ? 'enable_all' : 'disable_all');
        block.initSvg();
        block.render();
        return block;
      }

      // logConsole(msg) -> log
      if (callee === 'logConsole') {
        var block = workspace.newBlock('log');
        block.initSvg();
        if (args.length >= 1) {
          var msgBlock = processExpression(args[0], false);
          if (msgBlock) connectValue(block, 'MESSAGE', msgBlock);
        }
        block.render();
        return block;
      }

      // alert(msg) -> alert
      if (callee === 'alert') {
        var block = workspace.newBlock('alert');
        block.initSvg();
        if (args.length >= 1) {
          var msgBlock = processExpression(args[0], false);
          if (msgBlock) connectValue(block, 'MESSAGE', msgBlock);
        }
        block.render();
        return block;
      }

      // sleep(ms) -> wait_ms or wait
      if (callee === 'sleep') {
        var block = workspace.newBlock('wait_ms');
        block.initSvg();
        if (args.length >= 1) {
          var timeBlock = processExpression(args[0], false);
          if (timeBlock) connectValue(block, 'TIME', timeBlock);
        }
        block.render();
        return block;
      }

      // wait(seconds) -> wait
      if (callee === 'wait') {
        var block = workspace.newBlock('wait');
        block.initSvg();
        if (args.length >= 1) {
          var timeBlock = processExpression(args[0], false);
          if (timeBlock) connectValue(block, 'TIME', timeBlock);
        }
        block.render();
        return block;
      }

      // Robot.moveSmooth(motor, pos, duration) -> move_smooth
      if (callee === 'Robot.moveSmooth' && args.length >= 3) {
        var block = workspace.newBlock('move_smooth');
        block.initSvg();
        setMotorField(block, args[0]);
        var posBlock = processExpression(args[1], false);
        if (posBlock) connectValue(block, 'JOINT', posBlock);
        var durBlock = processExpression(args[2], false);
        if (durBlock) connectValue(block, 'DURATION', durBlock);
        block.render();
        return block;
      }

      // Robot.checkAllMotors() -> check_joints
      if (callee === 'Robot.checkAllMotors') {
        var block = workspace.newBlock('check_joints');
        block.initSvg();
        block.render();
        return block;
      }

      // Robot.setDegrees(motor, degrees) -> set_degrees
      if (callee === 'Robot.setDegrees' && args.length >= 2) {
        var block = workspace.newBlock('set_degrees');
        block.initSvg();
        setMotorField(block, args[0]);
        var degBlock = processExpression(args[1], false);
        if (degBlock) connectValue(block, 'DEGREES', degBlock);
        block.render();
        return block;
      }

      // Robot.getDegrees(motor) -> get_degrees
      if (callee === 'Robot.getDegrees' && args.length >= 1) {
        var block = workspace.newBlock('get_degrees');
        block.initSvg();
        setMotorField(block, args[0]);
        block.render();
        return block;
      }

      // Robot.setHeadCoordinates(coords) -> set_head_coordinates
      if (callee === 'Robot.setHeadCoordinates' && args.length >= 1) {
        var block = workspace.newBlock('set_head_coordinates');
        block.initSvg();
        var listBlock = processExpression(args[0], false);
        if (listBlock) connectValue(block, 'COORDS', listBlock);
        block.render();
        return block;
      }

      // Robot.getHeadCoordinates() -> get_head_coordinates
      if (callee === 'Robot.getHeadCoordinates') {
        var block = workspace.newBlock('get_head_coordinates');
        block.initSvg();
        block.render();
        return block;
      }

      // Robot.setAllPositions(Robot.coordinatesToJoints(...)) -> set_head_coordinates (legacy)
      if (callee === 'Robot.setAllPositions' && args.length >= 1) {
        var block = workspace.newBlock('set_head_coordinates');
        block.initSvg();
        var listBlock = processExpression(args[0], false);
        if (listBlock) connectValue(block, 'COORDS', listBlock);
        block.render();
        return block;
      }

      // Robot.jointsToCoordinates(arr) -> joints_to_coordinates
      if (callee === 'Robot.jointsToCoordinates' && args.length >= 1) {
        var block = workspace.newBlock('joints_to_coordinates');
        block.initSvg();
        var listBlock = processExpression(args[0], false);
        if (listBlock) connectValue(block, 'JOINTS', listBlock);
        block.render();
        return block;
      }

      // Robot.coordinatesToJoints(arr) -> coordinates_to_joints
      if (callee === 'Robot.coordinatesToJoints' && args.length >= 1) {
        var block = workspace.newBlock('coordinates_to_joints');
        block.initSvg();
        var listBlock = processExpression(args[0], false);
        if (listBlock) connectValue(block, 'COORDINATES', listBlock);
        block.render();
        return block;
      }

      // Robot.isMoving(motor) -> is_moving
      if (callee === 'Robot.isMoving' && args.length >= 1) {
        var block = workspace.newBlock('is_moving');
        block.initSvg();
        setMotorField(block, args[0]);
        block.render();
        return block;
      }

      // Robot.getLoad(motor) -> get_load
      if (callee === 'Robot.getLoad' && args.length >= 1) {
        var block = workspace.newBlock('get_load');
        block.initSvg();
        setMotorField(block, args[0]);
        block.render();
        return block;
      }

      // Robot.getTemperature(motor) -> get_temperature
      if (callee === 'Robot.getTemperature' && args.length >= 1) {
        var block = workspace.newBlock('get_temperature');
        block.initSvg();
        setMotorField(block, args[0]);
        block.render();
        return block;
      }

      // logJoint(motor) -> log_joint
      if (callee === 'logJoint' && args.length >= 1) {
        var block = workspace.newBlock('log_joint');
        block.initSvg();
        setMotorField(block, args[0]);
        block.render();
        return block;
      }

      // Robot.ping(motor) -> ping_joint
      if (callee === 'Robot.ping' && args.length >= 1) {
        var block = workspace.newBlock('ping_joint');
        block.initSvg();
        setMotorField(block, args[0]);
        block.render();
        return block;
      }

      // Robot.reboot(motor) -> reboot_joint
      if (callee === 'Robot.reboot' && args.length >= 1) {
        var block = workspace.newBlock('reboot_joint');
        block.initSvg();
        setMotorField(block, args[0]);
        block.render();
        return block;
      }

      // Robot.rebootAll() -> reboot_all
      if (callee === 'Robot.rebootAll') {
        var block = workspace.newBlock('reboot_all');
        block.initSvg();
        block.render();
        return block;
      }

      return null;
    }

    function getCalleeName(callee) {
      if (callee.type === 'Identifier') {
        return callee.name;
      }
      if (callee.type === 'MemberExpression') {
        var obj = callee.object.name || '';
        var prop = callee.property.name || '';
        return obj + '.' + prop;
      }
      return '';
    }

    function setMotorField(block, arg) {
      if (arg.type === 'Literal') {
        block.setFieldValue(String(arg.value), 'MOTOR');
      }
    }

    function connectValue(block, inputName, valueBlock) {
      var input = block.getInput(inputName);
      if (input && input.connection && valueBlock.outputConnection) {
        input.connection.connect(valueBlock.outputConnection);
      }
    }

    // Flatten chained + expressions into array of parts
    function flattenStringConcat(node) {
      var parts = [];
      function collect(n) {
        if (n.type === 'BinaryExpression' && n.operator === '+') {
          collect(n.left);
          collect(n.right);
        } else {
          parts.push(n);
        }
      }
      collect(node);
      return parts;
    }

    // ========== Expose to Global Scope ==========
    // For AI Assistant
    window.jsToBlocks = jsToBlocks;
    window.blocklyWorkspace = window.workspace;

    // For HTML onclick handlers
    window.toggleConnection = toggleConnection;
    window.checkMotors = checkMotors;
    window.enableAllTorque = enableAllTorque;
    window.disableAllTorque = disableAllTorque;
    window.rebootAllMotors = rebootAllMotors;
    window.runCode = runCode;
    window.stopCode = stopCode;
    window.saveWorkspace = saveWorkspace;
    window.loadWorkspace = loadWorkspace;
    window.switchTab = switchTab;
    window.updateCodeOutput = updateCodeOutput;
    window.logConsole = logConsole;
    window.Robot = Robot;
    window.wait = wait;
    window.sleep = sleep;
}

// Initialize when WASM is ready, or immediately if already loaded
if (window.wasm) {
    initBlocklyApp();
} else {
    window.addEventListener('wasm-ready', initBlocklyApp);
}
