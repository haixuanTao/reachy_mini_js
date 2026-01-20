# Reachy Mini

Browser-based control for Reachy Mini robot via WebAssembly.

```bash
npm install reachy-mini
```

## Complete Example

```js
import init, {
  // Connection
  connect,
  disconnect,
  is_connected,

  // Head pose (Cartesian)
  get_head_pose,
  set_head_pose,

  // Joints (degrees)
  get_head_joints,
  set_head_joints,
  get_all_joints,
  set_all_joints,

  // Antennas
  get_antennas,
  set_antennas,
  get_left_antenna,
  set_left_antenna,
  get_right_antenna,
  set_right_antenna,

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
  get_head_motor_temperatures,
  get_head_motor_loads,
  get_antenna_temperatures,
  get_antenna_loads,
  get_left_antenna_temperature,
  get_right_antenna_temperature,
  get_left_antenna_load,
  get_right_antenna_load,

  // Reboot
  reboot_motor,
  reboot_all_motors,
  reboot_head_motors,
  reboot_antennas,
  reboot_left_antenna,
  reboot_right_antenna,

  // Kinematics (offline)
  forward_kinematics,
  inverse_kinematics,

  // Recording
  start_fk_stream,
  replay_recording,
  stop,
  clear_recording,
  get_recording_length,

  // Video Stream (with browser camera fallback)
  connect_video_stream,
  disconnect_video_stream,
  is_video_stream_connected,
  is_using_camera_fallback,
  read_video_frame,
  get_latest_video_frame,
  capture_camera_frame,

  // Audio Stream (with browser microphone fallback)
  connect_audio_stream,
  disconnect_audio_stream,
  is_audio_stream_connected,
  is_using_microphone_fallback,
  read_audio_chunk,
  get_latest_audio_chunk,
  send_audio_chunk,
} from "https://unpkg.com/reachy-mini@0.3.1";

await init();
await connect(); // WARNING: Connect should be in block with user motion like a click
await enable_torque();

// Head pose: x, y, z (mm), roll, pitch, yaw (degrees)
await set_head_pose(0, 0, 50, 0, 15, 0);
const pose = await get_head_pose();

// Joints (degrees)
await set_head_joints([0, 0, 0, 0, 0, 0]);
await set_all_joints([0, 0, 0, 0, 0, 0, 45, -45]);

// Antennas
await set_antennas(45, -45);
await set_left_antenna(30);
await set_right_antenna(-30);

// Diagnostics
const temps = await get_all_motor_temperatures();
const loads = await get_all_motor_loads();

// Offline kinematics
const joints = inverse_kinematics([0, 0, 50, 0, 15, 0]);
const xyz = forward_kinematics([0, 0, 0, 0, 0, 0]);

// Recording
await start_fk_stream(3000); // record 3s
await replay_recording();

// Video streaming (auto-fallback to browser camera if WebSocket fails)
await connect_video_stream(); // Tries WebSocket, falls back to getUserMedia
if (is_using_camera_fallback()) {
  // Using browser camera - need to capture frames manually
  const frame = await capture_camera_frame();
} else {
  // Using WebSocket - frames arrive automatically
  const frame = await read_video_frame();
}
const frame = get_latest_video_frame(); // Get cached frame (non-blocking)
if (frame) {
  const blob = new Blob([frame], { type: "image/jpeg" });
  document.getElementById("video").src = URL.createObjectURL(blob);
}
disconnect_video_stream();

// Audio streaming (auto-fallback to browser microphone if WebSocket fails)
await connect_audio_stream(); // Tries WebSocket, falls back to getUserMedia
if (is_using_microphone_fallback()) {
  // Using browser mic - receive only, can't send
  const audio = await read_audio_chunk();
} else {
  // Using WebSocket - bidirectional
  const audio = await read_audio_chunk();
  await send_audio_chunk(new Float32Array([...])); // Send audio to robot
}
disconnect_audio_stream();

await disable_torque();
await disconnect();
```

## Motors

- **11-16**: Head (parallel kinematics)
- **17**: Left antenna
- **18**: Right antenna

## Hardware

- Reachy Mini Lite ( Wireless supported soon ) with 8× Dynamixel XL330
- USB serial adapter (1,000,000 baud)
- Or WebSocket at `ws://127.0.0.1:8000/api/move/ws/raw/write`

## WebSocket Endpoints

| Endpoint | Description |
|----------|-------------|
| `/api/move/ws/raw/write` | Motor control (used by `connect()`) |
| `/api/video/ws` | Video stream (JPEG frames) |
| `/api/audio/ws` | Bidirectional audio stream (Float32 little-endian)

## License

MIT
