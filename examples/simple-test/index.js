import init, { start_fk_stream, connect, torque_off, torque_on, replay_recording, stop, forward_kinematics, inverse_kinematics } from 'https://unpkg.com/reachy-mini@0.5.3/index.js';

// WebSerial helpers (required by WASM for WebSerial fallback)
let cachedPort = null;

window.requestSerialPort = async function(forceNew = false) {
  if (cachedPort && !forceNew) {
    console.log('Using cached serial port');
    return cachedPort;
  }

  console.log('Using native WebSerial');
  if (!('serial' in navigator)) {
    throw new Error('WebSerial not available. Use Chrome/Edge, or provide a WebSocket address.');
  }

  const port = await navigator.serial.requestPort();
  await port.open({ baudRate: 1000000 });
  cachedPort = port;
  return port;
};

window.closeSerialPort = async function() {
  if (cachedPort) {
    try {
      await cachedPort.close();
    } catch (e) {
      console.warn('Error closing port:', e);
    }
    cachedPort = null;
  }
};

// Initialize WASM
await init();

// Expose WASM functions to window
window.connect = connect;
window.enableTorque = torque_on;
window.disableTorque = torque_off;
window.read_pose = start_fk_stream;
window.replay = replay_recording;
window.record = start_fk_stream;  // Recording happens during FK stream
window.stop = stop;
window.forward_kinematics = forward_kinematics;
window.inverse_kinematics = inverse_kinematics;

// Enable connect toggle once WASM is loaded
const toggleConnect = document.getElementById('toggle-connect');
if (toggleConnect) {
  toggleConnect.disabled = false;
}

console.log('WASM module loaded');
