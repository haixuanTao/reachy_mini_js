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

## License

MIT
