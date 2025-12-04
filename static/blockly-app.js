    // ========== Global State ==========
    var stopRequested = false;
    var programTimer = 0;
    var recordedPoses = {};
    var motorPositionCache = {};

    // ========== Kinematics Functions ==========
    // These call the WASM functions attached to window
    // joints -> coordinates: window.forward_kinematics(joints) -> [x, y, z, roll, pitch, yaw]
    // coordinates -> joints: window.inverse_kinematics(coordinates) -> [j1, j2, ..., j8]

    function callFK(joints) {
      return window.forward_kinematics(joints);
    }

    function callIK(coordinates) {
      return window.inverse_kinematics(coordinates);
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

    // ========== Robot Communication ==========
    var Robot = {
      port: null,
      reader: null,
      writer: null,
      connected: false,
      readBuffer: [],
      motorIds: [11, 12, 13, 14, 15, 16],  // Head motors only (ears are controlled separately)

      CRC_TABLE: [
        0x0000, 0x8005, 0x800F, 0x000A, 0x801B, 0x001E, 0x0014, 0x8011,
        0x8033, 0x0036, 0x003C, 0x8039, 0x0028, 0x802D, 0x8027, 0x0022,
        0x8063, 0x0066, 0x006C, 0x8069, 0x0078, 0x807D, 0x8077, 0x0072,
        0x0050, 0x8055, 0x805F, 0x005A, 0x804B, 0x004E, 0x0044, 0x8041,
        0x80C3, 0x00C6, 0x00CC, 0x80C9, 0x00D8, 0x80DD, 0x80D7, 0x00D2,
        0x00F0, 0x80F5, 0x80FF, 0x00FA, 0x80EB, 0x00EE, 0x00E4, 0x80E1,
        0x00A0, 0x80A5, 0x80AF, 0x00AA, 0x80BB, 0x00BE, 0x00B4, 0x80B1,
        0x8093, 0x0096, 0x009C, 0x8099, 0x0088, 0x808D, 0x8087, 0x0082,
        0x8183, 0x0186, 0x018C, 0x8189, 0x0198, 0x819D, 0x8197, 0x0192,
        0x01B0, 0x81B5, 0x81BF, 0x01BA, 0x81AB, 0x01AE, 0x01A4, 0x81A1,
        0x01E0, 0x81E5, 0x81EF, 0x01EA, 0x81FB, 0x01FE, 0x01F4, 0x81F1,
        0x81D3, 0x01D6, 0x01DC, 0x81D9, 0x01C8, 0x81CD, 0x81C7, 0x01C2,
        0x0140, 0x8145, 0x814F, 0x014A, 0x815B, 0x015E, 0x0154, 0x8151,
        0x8173, 0x0176, 0x017C, 0x8179, 0x0168, 0x816D, 0x8167, 0x0162,
        0x8123, 0x0126, 0x012C, 0x8129, 0x0138, 0x813D, 0x8137, 0x0132,
        0x0110, 0x8115, 0x811F, 0x011A, 0x810B, 0x010E, 0x0104, 0x8101,
        0x8303, 0x0306, 0x030C, 0x8309, 0x0318, 0x831D, 0x8317, 0x0312,
        0x0330, 0x8335, 0x833F, 0x033A, 0x832B, 0x032E, 0x0324, 0x8321,
        0x0360, 0x8365, 0x836F, 0x036A, 0x837B, 0x037E, 0x0374, 0x8371,
        0x8353, 0x0356, 0x035C, 0x8359, 0x0348, 0x834D, 0x8347, 0x0342,
        0x03C0, 0x83C5, 0x83CF, 0x03CA, 0x83DB, 0x03DE, 0x03D4, 0x83D1,
        0x83F3, 0x03F6, 0x03FC, 0x83F9, 0x03E8, 0x83ED, 0x83E7, 0x03E2,
        0x83A3, 0x03A6, 0x03AC, 0x83A9, 0x03B8, 0x83BD, 0x83B7, 0x03B2,
        0x0390, 0x8395, 0x839F, 0x039A, 0x838B, 0x038E, 0x0384, 0x8381,
        0x0280, 0x8285, 0x828F, 0x028A, 0x829B, 0x029E, 0x0294, 0x8291,
        0x82B3, 0x02B6, 0x02BC, 0x82B9, 0x02A8, 0x82AD, 0x82A7, 0x02A2,
        0x82E3, 0x02E6, 0x02EC, 0x82E9, 0x02F8, 0x82FD, 0x82F7, 0x02F2,
        0x02D0, 0x82D5, 0x82DF, 0x02DA, 0x82CB, 0x02CE, 0x02C4, 0x82C1,
        0x8243, 0x0246, 0x024C, 0x8249, 0x0258, 0x825D, 0x8257, 0x0252,
        0x0270, 0x8275, 0x827F, 0x027A, 0x826B, 0x026E, 0x0264, 0x8261,
        0x0220, 0x8225, 0x822F, 0x022A, 0x823B, 0x023E, 0x0234, 0x8231,
        0x8213, 0x0216, 0x021C, 0x8219, 0x0208, 0x820D, 0x8207, 0x0202
      ],

      calculateCRC: function(data) {
        var crc = 0;
        for (var j = 0; j < data.length; j++) {
          var i = ((crc >> 8) ^ data[j]) & 0xFF;
          crc = ((crc << 8) ^ this.CRC_TABLE[i]) & 0xFFFF;
        }
        return crc;
      },

      buildPacket: function(id, instruction, params) {
        params = params || [];
        var length = 1 + params.length + 2;
        var packet = [0xFF, 0xFF, 0xFD, 0x00, id, length & 0xFF, (length >> 8) & 0xFF, instruction];
        for (var i = 0; i < params.length; i++) packet.push(params[i]);
        var crc = this.calculateCRC(packet);
        packet.push(crc & 0xFF, (crc >> 8) & 0xFF);
        return new Uint8Array(packet);
      },

      buildWritePacket: function(id, address, data) {
        var params = [address & 0xFF, (address >> 8) & 0xFF];
        for (var i = 0; i < data.length; i++) params.push(data[i]);
        return this.buildPacket(id, 0x03, params);
      },

      buildReadPacket: function(id, address, dataLength) {
        var params = [address & 0xFF, (address >> 8) & 0xFF, dataLength & 0xFF, (dataLength >> 8) & 0xFF];
        return this.buildPacket(id, 0x02, params);
      },

      buildSyncWritePacket: function(address, dataLength, motorData) {
        var n = motorData.length;
        var length = 1 + 2 + 2 + n * (1 + dataLength) + 2;
        var packet = [0xFF, 0xFF, 0xFD, 0x00, 0xFE, length & 0xFF, (length >> 8) & 0xFF, 0x83,
                      address & 0xFF, (address >> 8) & 0xFF, dataLength & 0xFF, (dataLength >> 8) & 0xFF];
        for (var i = 0; i < motorData.length; i++) {
          packet.push(motorData[i].id);
          for (var j = 0; j < motorData[i].data.length; j++) {
            packet.push(motorData[i].data[j]);
          }
        }
        var crc = this.calculateCRC(packet);
        packet.push(crc & 0xFF, (crc >> 8) & 0xFF);
        return new Uint8Array(packet);
      },

      buildSyncReadPacket: function(address, dataLength, motorIds) {
        var n = motorIds.length;
        var length = 1 + 2 + 2 + n + 2;
        var packet = [0xFF, 0xFF, 0xFD, 0x00, 0xFE, length & 0xFF, (length >> 8) & 0xFF, 0x82,
                      address & 0xFF, (address >> 8) & 0xFF, dataLength & 0xFF, (dataLength >> 8) & 0xFF];
        for (var i = 0; i < motorIds.length; i++) {
          packet.push(motorIds[i]);
        }
        var crc = this.calculateCRC(packet);
        packet.push(crc & 0xFF, (crc >> 8) & 0xFF);
        return new Uint8Array(packet);
      },

      connect: function() {
        var self = this;
        return navigator.serial.requestPort().then(function(p) {
          self.port = p;
          return self.port.open({ baudRate: 1000000 });
        }).then(function() {
          self.writer = self.port.writable.getWriter();
          self.reader = self.port.readable.getReader();
          self.connected = true;
          self.readBuffer = [];
          self.startBackgroundReader();
          updateConnectionStatus(true);
          logConsole('Connected to robot', 'success');
          self.startPositionPolling();
          // Auto-check motors after connection
          setTimeout(function() { checkMotors(); }, 500);
          return true;
        }).catch(function(e) {
          logConsole('Connection failed: ' + e.message, 'error');
          return false;
        });
      },

      disconnect: function() {
        var self = this;
        self.connected = false;
        self.stopPositionPolling();
        return Promise.resolve().then(function() {
          if (self.reader) return self.reader.cancel();
        }).then(function() {
          if (self.reader) self.reader.releaseLock();
          if (self.writer) self.writer.releaseLock();
          if (self.port) return self.port.close();
        }).then(function() {
          self.port = null;
          self.reader = null;
          self.writer = null;
          self.readBuffer = [];
          updateConnectionStatus(false);
          logConsole('Disconnected', 'log');
        }).catch(function() {});
      },

      startBackgroundReader: function() {
        var self = this;
        function readLoop() {
          if (!self.connected || !self.reader) return;
          self.reader.read().then(function(result) {
            if (result.done) return;
            if (result.value) {
              for (var i = 0; i < result.value.length; i++) {
                self.readBuffer.push(result.value[i]);
              }
              if (self.readBuffer.length > 2048) {
                self.readBuffer = self.readBuffer.slice(-1024);
              }
            }
            readLoop();
          }).catch(function() {});
        }
        readLoop();
      },

      pollingInterval: null,
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

      waitForPacket: function(motorId, timeout) {
        var self = this;
        timeout = timeout || 200;
        var start = Date.now();
        return new Promise(function(resolve) {
          function check() {
            if (Date.now() - start > timeout) { resolve(null); return; }
            for (var i = 0; i < self.readBuffer.length - 10; i++) {
              if (self.readBuffer[i] === 0xFF && self.readBuffer[i+1] === 0xFF &&
                  self.readBuffer[i+2] === 0xFD && self.readBuffer[i+3] === 0x00) {
                var packetId = self.readBuffer[i+4];
                var len = self.readBuffer[i+5] | (self.readBuffer[i+6] << 8);
                var totalLen = 7 + len;
                if (i + totalLen <= self.readBuffer.length) {
                  if (self.readBuffer[i+7] === 0x55 && packetId === motorId) {
                    var pkt = self.readBuffer.slice(i, i + totalLen);
                    self.readBuffer = self.readBuffer.slice(i + totalLen);
                    resolve(pkt);
                    return;
                  }
                  self.readBuffer = self.readBuffer.slice(i + totalLen);
                  i = -1;
                }
              }
            }
            setTimeout(check, 5);
          }
          check();
        });
      },

      waitForSyncReadPackets: function(motorIds, timeout) {
        var self = this;
        timeout = timeout || 500;
        var start = Date.now();
        var packets = {};

        return new Promise(function(resolve) {
          function check() {
            if (Date.now() - start > timeout) { resolve(packets); return; }

            for (var i = 0; i < self.readBuffer.length - 10; i++) {
              if (self.readBuffer[i] === 0xFF && self.readBuffer[i+1] === 0xFF &&
                  self.readBuffer[i+2] === 0xFD && self.readBuffer[i+3] === 0x00) {
                var packetId = self.readBuffer[i+4];
                var len = self.readBuffer[i+5] | (self.readBuffer[i+6] << 8);
                var totalLen = 7 + len;

                if (i + totalLen <= self.readBuffer.length) {
                  if (self.readBuffer[i+7] === 0x55 && motorIds.indexOf(packetId) !== -1) {
                    packets[packetId] = self.readBuffer.slice(i, i + totalLen);
                  }
                  self.readBuffer = self.readBuffer.slice(i + totalLen);
                  i = -1;

                  // Check if we got all packets
                  if (Object.keys(packets).length === motorIds.length) {
                    resolve(packets);
                    return;
                  }
                }
              }
            }
            setTimeout(check, 5);
          }
          check();
        });
      },

      sendPacket: function(packet, expectResponse, motorId) {
        var self = this;
        if (!self.connected || !self.writer) return Promise.resolve(null);
        self.readBuffer = [];
        return self.writer.write(packet).then(function() {
          if (!expectResponse) return new Promise(function(r) { setTimeout(function() { r(null); }, 5); });
          return self.waitForPacket(motorId);
        });
      },

      // High-level API
      
      // Dynamixel error codes
      errorCodes: {
        0x01: 'Result Fail',
        0x02: 'Instruction Error',
        0x04: 'CRC Error',
        0x08: 'Data Range Error',
        0x10: 'Data Length Error',
        0x20: 'Data Limit Error',
        0x40: 'Access Error',
        0x80: 'Hardware Alert'  // Voltage, Overheating, etc.
      },
      
      parseError: function(errorByte) {
        if (errorByte === 0) return null;
        var errors = [];
        for (var code in this.errorCodes) {
          if (errorByte & parseInt(code)) {
            errors.push(this.errorCodes[code]);
          }
        }
        return errors.join(', ');
      },

      // Build REBOOT packet (instruction 0x08)
      buildRebootPacket: function(id) {
        return this.buildPacket(id, 0x08, []);
      },

      // Build PING packet (instruction 0x01)
      buildPingPacket: function(id) {
        return this.buildPacket(id, 0x01, []);
      },

      // Ping a motor to check if it responds
      pingMotor: function(id) {
        var self = this;
        var packet = this.buildPingPacket(id);
        return this.sendPacket(packet, true, id).then(function(response) {
          if (response && response.length >= 11) {
            var error = response[8];
            if (error !== 0) {
              var errorMsg = self.parseError(error);
              return { ok: false, error: errorMsg, hasHardwareAlert: !!(error & 0x80) };
            }
            return { ok: true, error: null };
          }
          return { ok: false, error: 'No response', hasHardwareAlert: false };
        });
      },

      // Check all motors and report status
      checkAllMotors: function() {
        var self = this;
        var results = {};
        var allMotors = [11,12,13,14,15,16,17,18];
        var checkNext = function(index) {
          if (index >= allMotors.length) {
            return Promise.resolve(results);
          }
          var id = allMotors[index];
          return self.pingMotor(id).then(function(result) {
            results[id] = result;
            return checkNext(index + 1);
          });
        };
        return checkNext(0);
      },

      // Reboot a motor (clears hardware error status)
      rebootMotor: function(id) {
        var self = this;
        var packet = this.buildRebootPacket(id);
        logConsole('Rebooting motor ' + id + '...', 'warn');
        return this.sendPacket(packet, false).then(function() {
          // Wait for motor to reboot
          return new Promise(function(r) { setTimeout(r, 500); });
        }).then(function() {
          return self.pingMotor(id);
        }).then(function(result) {
          if (result.ok) {
            logConsole('Motor ' + id + ' rebooted successfully', 'success');
          } else {
            logConsole('Motor ' + id + ' still has error after reboot: ' + result.error, 'error');
          }
          return result;
        });
      },

      // Reboot all motors
      rebootAllMotors: function() {
        var self = this;
        var allMotors = [11,12,13,14,15,16,17,18];
        var rebootNext = function(index) {
          if (index >= allMotors.length) {
            return Promise.resolve();
          }
          return self.rebootMotor(allMotors[index]).then(function() {
            return rebootNext(index + 1);
          });
        };
        return rebootNext(0);
      },

      setTorque: function(id, enable) {
        var self = this;
        var packet = this.buildWritePacket(id, 64, [enable ? 1 : 0]);
        return this.sendPacket(packet, true, id).then(function(response) {
          if (response && response.length >= 11) {
            var error = response[8];
            if (error !== 0) {
              var errorMsg = self.parseError(error);
              logConsole('Motor ' + id + ' torque error: ' + errorMsg, 'error');
              if (error & 0x80) {
                logConsole('Motor ' + id + ' has hardware alert - try rebooting', 'warn');
              }
              return false;
            }
            // If enabling torque, set current position as goal position to prevent fast jumps
            if (enable) {
              return self.getPosition(id).then(function(currentPos) {
                return self.setPosition(id, currentPos).then(function() {
                  return true;
                });
              }).catch(function(err) {
                console.warn('Failed to set initial goal position for motor ' + id + ':', err);
                return true; // Still return true since torque was enabled
              });
            }
            return true;
          } else {
            logConsole('Motor ' + id + ' not responding', 'error');
            return false;
          }
        });
      },

      setTorqueMultiple: function(ids, enable) {
        var self = this;

        // Build sync write packet for torque enable/disable
        var motorData = [];
        for (var i = 0; i < ids.length; i++) {
          motorData.push({
            id: ids[i],
            data: [enable ? 1 : 0]
          });
        }
        var torquePacket = this.buildSyncWritePacket(64, 1, motorData);

        // Send the sync write torque command
        return this.sendPacket(torquePacket, false).then(function() {
          // If enabling torque, set current positions as goal positions
          if (enable) {
            // Sync read current positions from all motors
            var readPacket = self.buildSyncReadPacket(132, 4, ids);
            self.readBuffer = [];

            return self.writer.write(readPacket).then(function() {
              return self.waitForSyncReadPackets(ids);
            }).then(function(packets) {
              // Extract positions and build sync write for goal positions
              var positionData = [];
              for (var i = 0; i < ids.length; i++) {
                var id = ids[i];
                var response = packets[id];
                var pos = 2048; // default to center

                if (response && response.length >= 15) {
                  pos = response[9] | (response[10] << 8) | (response[11] << 16) | (response[12] << 24);
                  if (pos > 0x7FFFFFFF) pos -= 0x100000000;
                }

                // CRITICAL: Update the motor position cache with actual current positions
                // This ensures subsequent speed-limited movements start from the correct position
                motorPositionCache[id] = pos;

                var posUint = pos < 0 ? pos + 0x100000000 : pos;
                positionData.push({
                  id: id,
                  data: [posUint & 0xFF, (posUint >> 8) & 0xFF, (posUint >> 16) & 0xFF, (posUint >> 24) & 0xFF]
                });
              }

              // Sync write goal positions
              var positionPacket = self.buildSyncWritePacket(116, 4, positionData);
              return self.sendPacket(positionPacket, false);
            });
          }

          return Promise.resolve();
        }).then(function() {
          return { success: ids, failed: [] };
        }).catch(function(err) {
          console.error('Error setting torque:', err);
          return { success: [], failed: ids };
        });
      },

      setPosition: function(id, position) {
        var pos = Math.round(position);
        var posUint = pos < 0 ? pos + 0x100000000 : pos;
        var data = [posUint & 0xFF, (posUint >> 8) & 0xFF, (posUint >> 16) & 0xFF, (posUint >> 24) & 0xFF];
        var packet = this.buildWritePacket(id, 116, data);
        motorPositionCache[id] = pos;
        return this.sendPacket(packet, false);
      },

      setPositionMultiple: function(ids, positions) {
        var motorData = [];
        for (var i = 0; i < ids.length; i++) {
          var pos = Math.round(positions[i]);
          var posUint = pos < 0 ? pos + 0x100000000 : pos;
          motorData.push({
            id: ids[i],
            data: [posUint & 0xFF, (posUint >> 8) & 0xFF, (posUint >> 16) & 0xFF, (posUint >> 24) & 0xFF]
          });
          motorPositionCache[ids[i]] = pos;
        }
        var packet = this.buildSyncWritePacket(116, 4, motorData);
        return this.sendPacket(packet, false);
      },

      getPosition: function(id) {
        var self = this;
        var packet = this.buildReadPacket(id, 132, 4);
        return this.sendPacket(packet, true, id).then(function(response) {
          if (response && response.length >= 15) {
            var pos = response[9] | (response[10] << 8) | (response[11] << 16) | (response[12] << 24);
            if (pos > 0x7FFFFFFF) pos -= 0x100000000;
            motorPositionCache[id] = pos;
            return pos;
          }
          return motorPositionCache[id] || 2048;
        });
      },

      // Get motor temperature in °C (XL330 address 146)
      getTemperature: function(id) {
        var packet = this.buildReadPacket(id, 146, 1);
        return this.sendPacket(packet, true, id).then(function(response) {
          if (response && response.length >= 12) {
            return response[9];
          }
          return 0;
        });
      },

      // Get motor load (-1000 to 1000) (XL330 address 126)
      getLoad: function(id) {
        var packet = this.buildReadPacket(id, 126, 2);
        return this.sendPacket(packet, true, id).then(function(response) {
          if (response && response.length >= 13) {
            var load = response[9] | (response[10] << 8);
            if (load > 32767) load -= 65536;
            return load;
          }
          return 0;
        });
      },

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

      degreesToPosition: function(deg) {
        return Math.round(2048 + (deg * 4096 / 360));
      },

      positionToDegrees: function(pos) {
        return (pos - 2048) * 360 / 4096;
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

        // Get current position - read from motor if not cached
        function getStartPos() {
          if (motorPositionCache[id] !== undefined) {
            return Promise.resolve(motorPositionCache[id]);
          }
          return self.getPosition(id);
        }

        return getStartPos().then(function(startPos) {
          var delta = Math.abs(targetPos - startPos);

          // Calculate duration based on max speed
          var durationMs = (delta / self.maxStepsPerSecond) * 1000;
          if (durationMs < 50) {
            // Very small move, just do it directly
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

      // Speed-limited multi-motor move (all motors move together, speed limited by slowest)
      setPositionMultipleLimited: function(ids, positions) {
        var self = this;

        // First, get all current positions (read from motor if not cached)
        var positionPromises = ids.map(function(id) {
          if (motorPositionCache[id] !== undefined) {
            return Promise.resolve(motorPositionCache[id]);
          }
          return self.getPosition(id);
        });

        return Promise.all(positionPromises).then(function(startPositions) {
          // Calculate deltas and find max
          var maxDelta = 0;
          for (var i = 0; i < ids.length; i++) {
            var delta = Math.abs(positions[i] - startPositions[i]);
            if (delta > maxDelta) maxDelta = delta;
          }

          // Calculate duration based on the motor that needs to move the most
          var durationMs = (maxDelta / self.maxStepsPerSecond) * 1000;
          if (durationMs < 50) {
            // Very small move, just do it directly
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
      // These are called by AI-generated JavaScript code

      // Get all 8 motor positions as an array
      getAllPositions: function() {
        var self = this;
        if (!self.connected || !self.writer) return Promise.resolve(self.motorIds.map(function() { return 0; }));

        var packet = this.buildSyncReadPacket(132, 4, this.motorIds);
        self.readBuffer = [];

        return self.writer.write(packet).then(function() {
          return self.waitForSyncReadPackets(self.motorIds);
        }).then(function(packets) {
          var degrees = [];
          for (var i = 0; i < self.motorIds.length; i++) {
            var id = self.motorIds[i];
            var response = packets[id];
            if (response && response.length >= 15) {
              var pos = response[9] | (response[10] << 8) | (response[11] << 16) | (response[12] << 24);
              if (pos > 0x7FFFFFFF) pos -= 0x100000000;
              motorPositionCache[id] = pos;
              degrees.push(self.positionToDegrees(pos));
            } else {
              degrees.push(self.positionToDegrees(motorPositionCache[id] || 2048));
            }
          }
          return degrees;
        });
      },

      // Set all 8 motor positions (speed-limited) - accepts degrees
      setAllPositions: function(degrees) {
        var self = this;
        var positions = degrees.map(function(deg) {
          return self.degreesToPosition(deg);
        });
        return this.setPositionMultipleLimited(this.motorIds, positions);
      },

      // Forward Kinematics: joint degrees -> coordinates [x, y, z, roll, pitch, yaw]
      jointsToCoordinates: function(degrees) {
        return callFK(degrees);
      },

      // Inverse Kinematics: coordinates -> joint degrees
      coordinatesToJoints: function(coordinates) {
        return callIK(coordinates);
      },

      // Combined: Set head to coordinates directly (does IK conversion internally)
      setHeadCoordinates: function(coordinates) {
        var joints = this.coordinatesToJoints(coordinates);
        return this.setAllPositions(joints);
      },

      // Combined: Get current head coordinates (does FK conversion internally)
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

    function checkMotors() {
      if (!Robot.connected) { logConsole('Not connected', 'error'); return; }
      logConsole('Checking all motors...', 'info');
      Robot.checkAllMotors().then(function(results) {
        var ok = [];
        var failed = [];
        var alerts = [];
        for (var id in results) {
          var el = document.getElementById('motor' + id);
          if (results[id].ok) {
            ok.push(id);
            if (el) {
              el.classList.remove('error');
              el.classList.add('active');
            }
          } else {
            failed.push(id);
            if (el) {
              el.classList.add('error');
              el.classList.remove('active');
            }
            if (results[id].hasHardwareAlert) {
              alerts.push(id);
            }
          }
        }
        if (failed.length === 0) {
          logConsole('All ' + ok.length + ' motors OK', 'success');
        } else {
          logConsole('Motors OK: ' + ok.join(', '), 'success');
          logConsole('Motors FAILED: ' + failed.join(', '), 'error');
          if (alerts.length > 0) {
            logConsole('Motors with hardware alert (need reboot): ' + alerts.join(', '), 'warn');
          }
        }
      });
    }

    function rebootAllMotors() {
      if (!Robot.connected) { logConsole('Not connected', 'error'); return; }
      if (!confirm('Reboot all motors? This will clear hardware errors but motors will lose torque.')) return;
      logConsole('Rebooting all motors...', 'warn');
      Robot.rebootAllMotors().then(function() {
        logConsole('All motors rebooted', 'success');
        checkMotors();
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
    var EARS = [['Left ear (17)','17'],['Right ear (18)','18']];
    var HEAD_MOTORS = [['11','11'],['12','12'],['13','13'],['14','14'],['15','15'],['16','16']];
    var ALL_MOTORS = [['Head 11','11'],['Head 12','12'],['Head 13','13'],['Head 14','14'],['Head 15','15'],['Head 16','16'],['Left ear (17)','17'],['Right ear (18)','18']];
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
        this.appendDummyInput().appendField('enable all joints');
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
        this.appendDummyInput().appendField('disable all joints');
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
            .appendField('set')
            .appendField(new Blockly.FieldDropdown(EARS), 'MOTOR')
            .appendField('to');
        this.appendDummyInput().appendField('degrees');
        this.setInputsInline(true);
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(160);
        this.setTooltip('Set ear angle in degrees (0 = center)');
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
            .appendField('degrees of')
            .appendField(new Blockly.FieldDropdown(EARS), 'MOTOR');
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
            .appendField('move')
            .appendField(new Blockly.FieldDropdown(EARS), 'MOTOR')
            .appendField('by')
            .appendField('degrees');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(160);
        this.setTooltip('Move ear by relative amount in degrees');
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

    Blockly.Blocks['set_speed'] = {
      init: function() {
        this.appendValueInput('SPEED').setCheck('Number')
            .appendField('set')
            .appendField(new Blockly.FieldDropdown(EARS), 'MOTOR')
            .appendField('speed to');
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(160);
        this.setTooltip('Set ear velocity limit (0-1023)');
      }
    };
    Blockly.JavaScript.forBlock['set_speed'] = function(block) {
      var motor = block.getFieldValue('MOTOR');
      var speed = Blockly.JavaScript.valueToCode(block, 'SPEED', Blockly.JavaScript.ORDER_ATOMIC) || '100';
      // Address 112 = Profile Velocity
      return 'await Robot.sendPacket(Robot.buildWritePacket(' + motor + ', 112, [' + speed + ' & 0xFF, (' + speed + ' >> 8) & 0xFF, (' + speed + ' >> 16) & 0xFF, (' + speed + ' >> 24) & 0xFF]), false);\n';
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
    Blockly.JavaScript.forBlock['alert'] = function(block) {
      var msg = Blockly.JavaScript.valueToCode(block, 'MESSAGE', Blockly.JavaScript.ORDER_ATOMIC) || '""';
      return 'alert(' + msg + ');\n';
    };

    // ========== Workspace ==========
    var workspace = Blockly.inject('blocklyDiv', {
      toolbox: document.getElementById('toolbox'),
      grid: { spacing: 20, length: 3, colour: '#2a2a4a', snap: true },
      zoom: { controls: true, startScale: 1.0, maxScale: 2, minScale: 0.5, scaleSpeed: 1.1 },
      trashcan: true,
      move: { scrollbars: true, drag: true, wheel: true }
    });

    workspace.addChangeListener(function() {
      var code = Blockly.JavaScript.workspaceToCode(workspace);
      document.getElementById('codeOutput').textContent = code || '// Drag blocks here...';
    });

    // ========== Block Value Preview ==========
    workspace.addChangeListener(function(event) {
      if (event.type === Blockly.Events.BLOCK_CLICK) {
        var block = workspace.getBlockById(event.blockId);
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
            var motorName = motor === '17' ? 'Left ear' : motor === '18' ? 'Right ear' : 'Motor ' + motor;
            logConsole(motorName + ' angle: ' + degrees.toFixed(1) + '°', 'info');
          }).catch(function(e) {
            logConsole('Failed to get degrees: ' + e.message, 'error');
          });
        } else if (blockType === 'get_joint') {
          var motor = block.getFieldValue('MOTOR');
          Robot.getPosition(motor).then(function(pos) {
            var degrees = Robot.positionToDegrees(pos);
            var motorName = motor === '17' ? 'Left ear' : motor === '18' ? 'Right ear' : 'Motor ' + motor;
            logConsole(motorName + ': ' + pos + ' (' + degrees.toFixed(1) + '°)', 'info');
          }).catch(function(e) {
            logConsole('Failed to get position: ' + e.message, 'error');
          });
        } else if (blockType === 'get_load') {
          var motor = block.getFieldValue('MOTOR');
          Robot.getLoad(motor).then(function(load) {
            var motorName = motor === '17' ? 'Left ear' : motor === '18' ? 'Right ear' : 'Motor ' + motor;
            logConsole(motorName + ' load: ' + load, 'info');
          }).catch(function(e) {
            logConsole('Failed to get load: ' + e.message, 'error');
          });
        } else if (blockType === 'get_temperature') {
          var motor = block.getFieldValue('MOTOR');
          Robot.getTemperature(motor).then(function(temp) {
            var motorName = motor === '17' ? 'Left ear' : motor === '18' ? 'Right ear' : 'Motor ' + motor;
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
    workspace.addChangeListener(function(event) {
      if (event.type === Blockly.Events.CLICK) {
        var block = workspace.getBlockById(event.blockId);
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
        block.initSvg();

        // If there's an else clause, we need to mutate the block
        if (node.alternate) {
          block.elseCount_ = 1;
          block.updateShape_();
        }

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

      // Robot.setSpeed(motor, speed) -> set_speed
      if (callee === 'Robot.setSpeed' && args.length >= 2) {
        var block = workspace.newBlock('set_speed');
        block.initSvg();
        setMotorField(block, args[0]);
        var speedBlock = processExpression(args[1], false);
        if (speedBlock) connectValue(block, 'SPEED', speedBlock);
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

    // ========== JS to Blockly Tests ==========
    function testJsToBlocks() {
      var tests = [
        {
          name: 'Simple function call',
          code: 'Robot.setDegrees(17, 0);',
          expected: 'set_degrees'
        },
        {
          name: 'Variable declaration',
          code: 'let x = 100;',
          expected: 'variables_set'
        },
        {
          name: 'Function call with variable',
          code: 'let deg = Robot.getDegrees(17);',
          expected: 'variables_set'
        },
        {
          name: 'For loop',
          code: 'for (let i = 0; i < 5; i++) { logConsole("test"); }',
          expected: 'controls_for'
        },
        {
          name: 'String concatenation',
          code: 'logConsole("Value: " + x);',
          expected: 'log'
        },
        {
          name: 'If statement',
          code: 'if (x > 10) { logConsole("big"); }',
          expected: 'controls_if'
        },
        {
          name: 'Array literal',
          code: 'let arr = [1, 2, 3];',
          expected: 'variables_set'
        },
        {
          name: 'Multiple statements',
          code: 'Robot.setDegrees(17, 0);\nwait(1);\nlogConsole("done");',
          expected: 'set_degrees'
        }
      ];

      var results = [];
      for (var i = 0; i < tests.length; i++) {
        var test = tests[i];
        workspace.clear();
        var result = jsToBlocks(test.code);
        var blocks = workspace.getAllBlocks();
        var passed = result.success && blocks.length > 0;

        results.push({
          name: test.name,
          passed: passed,
          error: result.error,
          blockCount: blocks.length,
          firstBlockType: blocks.length > 0 ? blocks[0].type : null
        });

        logConsole((passed ? '✓' : '✗') + ' ' + test.name + (result.error ? ': ' + result.error : ''), passed ? 'success' : 'error');
      }

      workspace.clear();
      return results;
    }

    // Run tests with: testJsToBlocks()
    // Available in console

    // ========== AI Assistant ==========
    var aiSettings = {
      provider: 'anthropic',
      endpoint: 'http://localhost:11434',
      apiKey: '',
      model: 'claude-sonnet-4-20250514'
    };

    // Load settings from localStorage
    var savedAISettings = localStorage.getItem('aiSettings');
    if (savedAISettings) {
      try {
        aiSettings = JSON.parse(savedAISettings);
        document.getElementById('aiProviderSelect').value = aiSettings.provider;
      } catch (e) {}
    }

    var aiChatHistory = [];

    function openAISettings() {
      document.getElementById('settingsProvider').value = aiSettings.provider;
      document.getElementById('settingsEndpoint').value = aiSettings.endpoint;
      document.getElementById('settingsApiKey').value = aiSettings.apiKey;
      document.getElementById('settingsModel').value = aiSettings.model;
      updateSettingsUI();
      document.getElementById('aiSettingsModal').classList.add('show');
    }

    function closeAISettings() {
      document.getElementById('aiSettingsModal').classList.remove('show');
    }

    function updateSettingsUI() {
      var provider = document.getElementById('settingsProvider').value;
      var endpointGroup = document.getElementById('endpointGroup');
      var apiKeyGroup = document.getElementById('apiKeyGroup');
      var modelInput = document.getElementById('settingsModel');

      if (provider === 'ollama') {
        endpointGroup.style.display = 'block';
        apiKeyGroup.style.display = 'none';
        document.getElementById('settingsEndpoint').placeholder = 'http://localhost:11434';
        modelInput.placeholder = 'llama3.2';
      } else if (provider === 'openai') {
        endpointGroup.style.display = 'none';
        apiKeyGroup.style.display = 'block';
        modelInput.placeholder = 'gpt-4o';
      } else if (provider === 'anthropic') {
        endpointGroup.style.display = 'none';
        apiKeyGroup.style.display = 'block';
        modelInput.placeholder = 'claude-sonnet-4-20250514';
      }
    }

    function saveAISettings() {
      aiSettings.provider = document.getElementById('settingsProvider').value;
      aiSettings.endpoint = document.getElementById('settingsEndpoint').value;
      aiSettings.apiKey = document.getElementById('settingsApiKey').value;
      aiSettings.model = document.getElementById('settingsModel').value;
      localStorage.setItem('aiSettings', JSON.stringify(aiSettings));
      document.getElementById('aiProviderSelect').value = aiSettings.provider;
      closeAISettings();
      addAIMessage('Settings saved!', 'system');
    }

    // Sync dropdown with settings
    document.getElementById('aiProviderSelect').addEventListener('change', function() {
      aiSettings.provider = this.value;
      localStorage.setItem('aiSettings', JSON.stringify(aiSettings));
    });

    function addAIMessage(content, type) {
      var chat = document.getElementById('aiChat');
      var msg = document.createElement('div');
      msg.className = 'ai-message ' + type;
      msg.textContent = content;
      chat.appendChild(msg);
      chat.scrollTop = chat.scrollHeight;
    }

    function addAICodeMessage(code) {
      var chat = document.getElementById('aiChat');
      var msg = document.createElement('div');
      msg.className = 'ai-message code';
      msg.textContent = code;
      chat.appendChild(msg);
      chat.scrollTop = chat.scrollHeight;
    }

    function getWorkspaceContext() {
      // Get current blocks as XML
      var xml = Blockly.Xml.workspaceToDom(workspace);
      var xmlText = Blockly.Xml.domToText(xml);

      // Get generated code
      var code = Blockly.JavaScript.workspaceToCode(workspace);

      // Get available block types
      var availableBlocks = [
        'Connection: enable_torque, disable_torque, enable_all, disable_all, check_joints, ping_joint, reboot_joint, reboot_all',
        'Ears (motors 17-18): set_degrees, get_degrees, move_by, set_speed',
        'Head (coordinate control): get_head_coordinates, set_head_coordinates',
        'Coordinates: create_coordinates, get_coordinate',
        'Sensing: is_moving, wait_until_stopped, get_load, get_temperature, joint_in_range',
        'Timing: wait, wait_ms, get_time, reset_timer, timer_value',
        'Output: log, log_joint, log_type, alert',
        'Blockly built-ins: controls_if, controls_repeat_ext, controls_whileUntil, controls_for, logic_compare, logic_operation, math_number, math_arithmetic, text, lists_create_with, variables_get, variables_set'
      ];

      return {
        xml: xmlText,
        code: code,
        availableBlocks: availableBlocks.join('\n')
      };
    }

    async function sendAIMessage() {
      var input = document.getElementById('aiInput');
      var userMessage = input.value.trim();
      if (!userMessage) return;

      input.value = '';
      addAIMessage(userMessage, 'user');

      var sendBtn = document.getElementById('aiSendBtn');
      sendBtn.disabled = true;
      sendBtn.textContent = '...';

      // Show thinking animation
      var thinkingEl = document.createElement('div');
      thinkingEl.className = 'ai-thinking';
      thinkingEl.innerHTML = '<div class="ai-thinking-dots"><span></span><span></span><span></span></div><span>Thinking...</span>';
      var chat = document.getElementById('aiChat');
      chat.appendChild(thinkingEl);
      chat.scrollTop = chat.scrollHeight;

      try {
        var context = getWorkspaceContext();
        var systemPrompt = 'You are an AI assistant helping users program a robot called Reachy Mini using JavaScript. ' +
          'The code you write will be converted to visual Blockly blocks, so you MUST use only supported syntax.\n\n' +
          'ROBOT ARCHITECTURE:\n' +
          'Reachy Mini has two separate control systems:\n\n' +
          '1. HEAD (motors 11-16): Stewart Platform with 6DOF (x, y, z, roll, pitch, yaw)\n' +
          '   - ALWAYS use coordinate-based control, NEVER control individual head motors!\n' +
          '   - Kinematics conversion happens automatically behind the scenes\n' +
          '   - Coordinates: [x, y, z, roll, pitch, yaw]\n' +
          '     * Position in millimeters:\n' +
          '       - X: forward (+) / backward (-)\n' +
          '       - Y: right (+) / left (-)\n' +
          '       - Z: up (+) / down (-), where Z=0 is neutral position\n' +
          '     * Rotation in degrees:\n' +
          '       - Roll: tilt left/right (rotate around X axis)\n' +
          '       - Pitch: nod up/down (rotate around Y axis)\n' +
          '       - Yaw: turn left/right (rotate around Z axis)\n' +
          '     * Example: [0, 0, 0, 0, 0, 0] = neutral position with no rotation\n' +
          '     * Example: [10, 0, 0, 0, 0, 0] = move forward 10mm\n' +
          '     * Example: [0, 5, 0, 0, 0, 0] = move right 5mm\n' +
          '     * Example: [0, 0, -10, 0, 0, 0] = move down 10mm\n\n' +
          '2. EARS (motors 17-18): Independent motors that can be controlled directly\n' +
          '   - Motor 17: Left ear\n' +
          '   - Motor 18: Right ear\n' +
          '   - Control using degrees (angle position)\n\n' +
          'AVAILABLE FUNCTIONS:\n\n' +
          'HEAD CONTROL (coordinate-based only):\n' +
          '- await Robot.setHeadCoordinates(coords) - set head to coordinates [x, y, z, roll, pitch, yaw]\n' +
          '  ALWAYS create coordinates inline like: [x, y, z, roll, pitch, yaw]\n' +
          '  Example: await Robot.setHeadCoordinates([0, 0, -10, 0, 0, 0]);\n' +
          '  This converts to the "create coordinates" block with labeled fields for children\n' +
          '- await Robot.getHeadCoordinates() - get current head coordinates\n' +
          '  Returns [x, y, z, roll, pitch, yaw]\n' +
          '- To modify coordinates, store in variable first:\n' +
          '  var coords = [x, y, z, roll, pitch, yaw];\n' +
          '  coords[2] = -10; // change z\n' +
          '  await Robot.setHeadCoordinates(coords);\n\n' +
          'EAR CONTROL (direct motor control):\n' +
          '- Robot.setDegrees(motor, degrees) - set ear angle in degrees\n' +
          '- Robot.getDegrees(motor) - get ear angle in degrees\n' +
          '- Robot.setSpeed(motor, speed) - set ear movement speed (0-1023)\n' +
          '- Motors: 17 = left ear, 18 = right ear\n\n' +
          'TORQUE (enable/disable motors):\n' +
          '- Robot.setTorque(motor, true/false) - enable/disable single motor (11-18)\n' +
          '- Robot.setTorqueMultiple([11,12,13,14,15,16], true/false) - enable/disable all head motors\n' +
          '- Robot.setTorqueMultiple([11,12,13,14,15,16,17,18], true/false) - enable/disable all motors (head + ears)\n\n' +
          'STATUS & DIAGNOSTICS:\n' +
          '- Robot.checkAllMotors() - check all motors (11-18)\n' +
          '- Robot.ping(motor) - ping single motor\n' +
          '- Robot.reboot(motor) - reboot single motor\n' +
          '- Robot.rebootAll() - reboot all motors (11-18)\n\n' +
          'SENSING (works with any motor 11-18):\n' +
          '- Robot.isMoving(motor) - check if motor is moving\n' +
          '- Robot.getLoad(motor) - get load/torque (-100 to 100)\n' +
          '- Robot.getTemperature(motor) - get motor temperature\n\n' +
          'TIMING:\n' +
          '- wait(seconds) - wait N seconds (use this for delays!)\n' +
          '- sleep(ms) - wait N milliseconds\n' +
          '- Date.now() - get current time in milliseconds since epoch\n' +
          '  To get current seconds: Math.floor((Date.now() / 1000) % 60)\n' +
          '  To get current minutes: Math.floor((Date.now() / 60000) % 60)\n' +
          '  To get current hours: Math.floor((Date.now() / 3600000) % 24)\n\n' +
          'OUTPUT:\n' +
          '- logConsole(message) - log message to console\n' +
          '- logJoint(motor) - log joint position\n' +
          '- alert(message) - show alert dialog\n\n' +
          'SUPPORTED SYNTAX (use only these!):\n' +
          '- var/let variable declarations: var x = 10;\n' +
          '- for loops: for (var i = 0; i < 10; i++) { ... }\n' +
          '- while loops: while (x < 100) { ... }\n' +
          '- if/else statements: if (x > 10) { ... } else { ... }\n' +
          '- Math operators: +, -, *, /, %\n' +
          '- Math functions: Math.floor(), Math.ceil(), Math.round(), Math.abs(), Math.sqrt()\n' +
          '- Trigonometry - ALL ANGLES ARE IN DEGREES! Keep all angle variables in degrees.\n' +
          '  To use cos/sin/tan, inline the degree-to-radian conversion DIRECTLY in the function call:\n' +
          '    Math.cos(angleDegrees * Math.PI / 180)\n' +
          '    Math.sin(angleDegrees * Math.PI / 180)\n' +
          '    Math.tan(angleDegrees * Math.PI / 180)\n' +
          '  Example: var angle = 90; var x = 10 * Math.cos(angle * Math.PI / 180);\n' +
          '  NEVER create a separate radian variable! Keep everything in degrees!\n' +
          '  WRONG: var angleRad = angle * Math.PI / 180; var x = Math.cos(angleRad);\n' +
          '  CORRECT: var x = Math.cos(angle * Math.PI / 180);\n' +
          '  Inverse functions return radians, convert to degrees inline:\n' +
          '    Math.asin(x) * 180 / Math.PI, Math.acos(x) * 180 / Math.PI, Math.atan(x) * 180 / Math.PI\n' +
          '- Math constants: Math.PI (represents 180 degrees, use Math.PI / 180 to convert degrees to radians)\n' +
          '- Comparisons: <, >, <=, >=, ==, !=\n' +
          '- Logic: &&, ||, !\n' +
          '- String concatenation: "text " + variable\n' +
          '- Arrays: [1, 2, 3], arr.length, arr[i], arr[i] = value\n\n' +
          'NEVER USE THESE (will break the converter!):\n' +
          '- function declarations (NEVER write "function myFunc() {}" - inline the code instead!)\n' +
          '- setTimeout, setInterval (use for/while loops with wait() instead)\n' +
          '- arrow functions (no () => {})\n' +
          '- new Date(), date.getSeconds() etc. (use Date.now() with math instead - see TIMING section)\n' +
          '- template literals (no `${var}`)\n' +
          '- console.log (use logConsole instead)\n' +
          '- JSON.stringify\n' +
          '- callbacks or closures\n\n' +
          'NOTE: You can use "await" with Robot functions - it will be automatically stripped during conversion.\n\n' +
          'EXAMPLE 1 - Move head down and back to neutral:\n' +
          'Robot.setTorqueMultiple([11,12,13,14,15,16], true);\n' +
          'for (var i = 0; i < 3; i++) {\n' +
          '  await Robot.setHeadCoordinates([0, 0, -10, 0, 0, 0]);\n' +
          '  wait(0.5);\n' +
          '  await Robot.setHeadCoordinates([0, 0, 0, 0, 0, 0]);\n' +
          '  wait(0.5);\n' +
          '}\n\n' +
          'EXAMPLE 2 - Move ears back and forth:\n' +
          'Robot.setTorqueMultiple([17,18], true);\n' +
          'for (var i = 0; i < 3; i++) {\n' +
          '  Robot.setDegrees(17, 45);\n' +
          '  Robot.setDegrees(18, -45);\n' +
          '  wait(0.5);\n' +
          '  Robot.setDegrees(17, -45);\n' +
          '  Robot.setDegrees(18, 45);\n' +
          '  wait(0.5);\n' +
          '}\n\n' +
          'Current workspace code:\n' + context.code + '\n\n' +
          'IMPORTANT: Always respond with working JavaScript code in a ```javascript``` code block. Keep it simple and use only supported syntax.';

        aiChatHistory.push({ role: 'user', content: userMessage });
        var response = await callLLM(systemPrompt, aiChatHistory);
        aiChatHistory.push({ role: 'assistant', content: response });

        // Check if response contains JavaScript code
        var jsMatch = response.match(/```javascript\s*([\s\S]*?)```/) || response.match(/```js\s*([\s\S]*?)```/) || response.match(/```\s*([\s\S]*?)```/);
        if (jsMatch) {
          var jsCode = jsMatch[1].trim();

          // Show the generated code
          addAIMessage('Generated code:', 'assistant');
          addAICodeMessage(jsCode);

          var result = jsToBlocks(jsCode);

          if (result.success) {
            addAIMessage('✓ Workspace updated!', 'assistant');
            var explanation = response.replace(/```[\s\S]*?```/g, '').trim();
            if (explanation) {
              addAIMessage(explanation, 'assistant');
            }
          } else {
            // Send error back to AI for retry
            addAIMessage('Parse error: ' + result.error, 'error');
            addAIMessage('Asking AI to fix...', 'system');
            var errorMsg = 'Your JavaScript had an error: ' + result.error + '\n\nPlease fix the code. Use only the allowed functions: Robot.setDegrees(), Robot.getDegrees(), Robot.setTorque(), Robot.setTorqueMultiple(), logConsole(), wait(), etc. For head control, use coordinate arrays [x,y,z,roll,pitch,yaw].';
            aiChatHistory.push({ role: 'user', content: errorMsg });

            var retryResponse = await callLLM(systemPrompt, aiChatHistory);
            aiChatHistory.push({ role: 'assistant', content: retryResponse });

            var retryMatch = retryResponse.match(/```javascript\s*([\s\S]*?)```/) || retryResponse.match(/```js\s*([\s\S]*?)```/) || retryResponse.match(/```\s*([\s\S]*?)```/);
            if (retryMatch) {
              var retryCode = retryMatch[1].trim();
              addAIMessage('Retry code:', 'assistant');
              addAICodeMessage(retryCode);

              var retryResult = jsToBlocks(retryCode);
              if (retryResult.success) {
                addAIMessage('✓ Workspace updated!', 'assistant');
              } else {
                addAIMessage('Still could not parse: ' + retryResult.error, 'error');
              }
            } else {
              addAIMessage(retryResponse, 'assistant');
            }
          }
        } else {
          addAIMessage(response, 'assistant');
        }
      } catch (e) {
        addAIMessage('Error: ' + e.message, 'error');
      } finally {
        // Remove thinking animation
        if (thinkingEl && thinkingEl.parentNode) {
          thinkingEl.parentNode.removeChild(thinkingEl);
        }
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send';
      }
    }

    async function callLLM(systemPrompt, messages) {
      var provider = aiSettings.provider;

      if (provider === 'ollama') {
        return await callOllama(systemPrompt, messages);
      } else if (provider === 'openai') {
        return await callOpenAI(systemPrompt, messages);
      } else if (provider === 'anthropic') {
        return await callAnthropic(systemPrompt, messages);
      }
      throw new Error('Unknown provider: ' + provider);
    }

    async function callOllama(systemPrompt, messages) {
      var endpoint = aiSettings.endpoint || 'http://localhost:11434';
      var model = aiSettings.model || 'llama3.2';

      var ollamaMessages = [{ role: 'system', content: systemPrompt }];
      messages.forEach(function(m) {
        ollamaMessages.push({ role: m.role, content: m.content });
      });

      var response = await fetch(endpoint + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model,
          messages: ollamaMessages,
          stream: false
        })
      });

      if (!response.ok) {
        throw new Error('Ollama error: ' + response.status);
      }

      var data = await response.json();
      return data.message.content;
    }

    async function callOpenAI(systemPrompt, messages) {
      var model = aiSettings.model || 'gpt-4o';
      var apiKey = aiSettings.apiKey;

      if (!apiKey) {
        throw new Error('OpenAI API key not configured. Click Settings to add it.');
      }

      var openaiMessages = [{ role: 'system', content: systemPrompt }];
      messages.forEach(function(m) {
        openaiMessages.push({ role: m.role, content: m.content });
      });

      var response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey
        },
        body: JSON.stringify({
          model: model,
          messages: openaiMessages
        })
      });

      if (!response.ok) {
        var errorData = await response.json();
        throw new Error('OpenAI error: ' + (errorData.error?.message || response.status));
      }

      var data = await response.json();
      return data.choices[0].message.content;
    }

    async function callAnthropic(systemPrompt, messages) {
      var model = aiSettings.model || 'claude-sonnet-4-20250514';
      var apiKey = aiSettings.apiKey;

      if (!apiKey) {
        throw new Error('Anthropic API key not configured. Click Settings to add it.');
      }

      // Anthropic format: system is separate, messages alternate user/assistant
      var anthropicMessages = messages.map(function(m) {
        return { role: m.role, content: m.content };
      });

      var response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model: model,
          max_tokens: 4096,
          system: systemPrompt,
          messages: anthropicMessages
        })
      });

      if (!response.ok) {
        var errorData = await response.json();
        throw new Error('Anthropic error: ' + (errorData.error?.message || response.status));
      }

      var data = await response.json();
      return data.content[0].text;
    }
