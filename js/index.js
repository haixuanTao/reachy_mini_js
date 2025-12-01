import { fk, connect, read_websocket, torque_off, torque_on, record, replay, stop } from "../pkg/index.js";

import("../pkg/index.js").catch(console.error);

// Import the serial helper
import './serial.js';

// Expose to window for WASM
window.connect = connect;
window.enableTorque = torque_on;
window.disableTorque = torque_off;
window.read_pose = fk;
window.replay = replay;
window.record = record;
window.stop = stop;