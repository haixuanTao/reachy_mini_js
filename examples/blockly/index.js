import init, {
  // Kinematics (pure functions)
  forward_kinematics,
  inverse_kinematics,
  // Connection
  connect,
  disconnect,
  is_connected,
  // Head pose (Cartesian)
  get_head_pose,
  set_head_pose,
  // Joint positions (degrees)
  get_head_joints,
  set_head_joints,
  get_all_joints,
  set_all_joints,
  // Antenna control
  get_left_antenna,
  set_left_antenna,
  get_right_antenna,
  set_right_antenna,
  get_antennas,
  set_antennas,
  // Torque control
  enable_torque,
  disable_torque,
  enable_head_torque,
  disable_head_torque,
  enable_antenna_torque,
  disable_antenna_torque,
  enable_left_antenna_torque,
  disable_left_antenna_torque,
  enable_right_antenna_torque,
  disable_right_antenna_torque,
  // Motor diagnostics
  get_motor_temperature,
  get_motor_load,
  get_all_motor_temperatures,
  get_all_motor_loads,
  // Motor reboot
  reboot_motor,
  reboot_all_motors,
  reboot_head_motors,
  reboot_antennas,
  // Motor diagnostics - check and reboot
  get_motor_errors,
  check_and_reboot_motors,
  // Video Stream
  connect_video_stream,
  disconnect_video_stream,
  is_using_camera_fallback,
  read_video_frame,
  capture_camera_frame,
  get_latest_video_frame,
  // Audio Stream
  connect_audio_stream,
  disconnect_audio_stream,
  is_using_microphone_fallback,
  read_audio_chunk,
  get_latest_audio_chunk,
  send_audio_chunk,
} from 'https://unpkg.com/reachy-mini@0.6.1/index.js';

// ============ Serial Port Helpers (required by WASM for WebSerial fallback) ============
let cachedPort = null;

window.requestSerialPort = async function(forceNew = false) {
  if (cachedPort && !forceNew) {
    console.log('Using cached serial port');
    return cachedPort;
  }

  console.log('Using native WebSerial');
  if (!('serial' in navigator)) {
    throw new Error('WebSerial not available on this browser. Please use Chrome, Edge, or Opera.');
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

// Expose all WASM functions to window for blockly-app.js
window.wasm = {
  // Kinematics
  forward_kinematics,
  inverse_kinematics,
  // Connection
  connect,
  disconnect,
  is_connected,
  // Head pose
  get_head_pose,
  set_head_pose,
  // Joint positions
  get_head_joints,
  set_head_joints,
  get_all_joints,
  set_all_joints,
  // Antenna
  get_left_antenna,
  set_left_antenna,
  get_right_antenna,
  set_right_antenna,
  get_antennas,
  set_antennas,
  // Torque
  enable_torque,
  disable_torque,
  enable_head_torque,
  disable_head_torque,
  enable_antenna_torque,
  disable_antenna_torque,
  enable_left_antenna_torque,
  disable_left_antenna_torque,
  enable_right_antenna_torque,
  disable_right_antenna_torque,
  // Diagnostics
  get_motor_temperature,
  get_motor_load,
  get_all_motor_temperatures,
  get_all_motor_loads,
  // Reboot
  reboot_motor,
  reboot_all_motors,
  reboot_head_motors,
  reboot_antennas,
  // Check and reboot
  get_motor_errors,
  check_and_reboot_motors,
  // Video Stream
  connect_video_stream,
  disconnect_video_stream,
  is_using_camera_fallback,
  read_video_frame,
  capture_camera_frame,
  get_latest_video_frame,
  // Audio Stream
  connect_audio_stream,
  disconnect_audio_stream,
  is_using_microphone_fallback,
  read_audio_chunk,
  get_latest_audio_chunk,
  send_audio_chunk,
};

// Legacy: expose kinematics functions directly for backward compatibility
window.forward_kinematics = forward_kinematics;
window.inverse_kinematics = inverse_kinematics;

console.log('WASM module loaded (reachy-mini v0.6.1)');

// Dispatch event to signal WASM is ready
window.dispatchEvent(new CustomEvent('wasm-ready'));

