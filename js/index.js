import init, { get_head_pose, connect, torque_off, torque_on, start_fk_stream, replay, stop, forward_kinematics, inverse_kinematics } from "../pkg/index.js";
import { SerialPort as PolyfillSerialPort } from 'web-serial-polyfill';

// Initialize WASM (serial helpers auto-exposed to window!)
await init();

import("../pkg/index.js").catch(console.error);

// Expose WASM functions to window
window.connect = connect;
window.enableTorque = torque_on;
window.disableTorque = torque_off;
window.read_pose = get_head_pose;
window.replay = replay;
window.record = start_fk_stream;
window.stop = stop;
window.forward_kinematics = forward_kinematics;
window.inverse_kinematics = inverse_kinematics;

// ============ Serial Port Helper ============

const USB_FILTERS = [
  { vendorId: 0x2341 },  // Arduino
  { vendorId: 0x0403 },  // FTDI
  { vendorId: 0x10c4 },  // CP210x
  { vendorId: 0x1a86 },  // CH340
  { vendorId: 0x239A },  // Adafruit
  { vendorId: 0x2E8A },  // Raspberry Pi Pico
];

let cachedPort = null;

function isAndroid() {
  return /android/i.test(navigator.userAgent);
}

async function requestSerialPort(mode = 'auto', forceNew = false) {
  if (cachedPort && !forceNew) {
    console.log('Using cached serial port');
    return cachedPort;
  }

  const usePolyfill = mode === 'polyfill' || (mode === 'auto' && isAndroid());

  if (usePolyfill) {
    console.log('Using WebUSB polyfill (Android/mobile USB)');
    if (!('usb' in navigator)) {
      throw new Error('WebUSB not available on this browser');
    }
    const device = await navigator.usb.requestDevice({ filters: USB_FILTERS });
    const port = new PolyfillSerialPort(device);
    port._isPolyfill = true;
    await port.open({ baudRate: 1000000 });
    cachedPort = port;
    return port;
  }

  console.log('Using native WebSerial (desktop)');
  if (!('serial' in navigator)) {
    throw new Error('WebSerial not available on this browser');
  }
  const port = await navigator.serial.requestPort();
  await port.open({ baudRate: 1000000 });
  port._isPolyfill = false;
  cachedPort = port;
  return port;
}

async function closeSerialPort() {
  if (cachedPort) {
    try {
      await cachedPort.close();
    } catch (e) {
      console.warn('Error closing port:', e);
    }
    cachedPort = null;
  }
}

// Expose serial functions to window (used by WASM)
window.requestSerialPort = requestSerialPort;
window.closeSerialPort = closeSerialPort;
