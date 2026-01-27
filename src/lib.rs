//! # Reachy Mini WebAssembly Bindings
//!
//! This module provides WebAssembly bindings for controlling the Reachy Mini robot
//! through either WebSocket or WebSerial connections.
//!
//! ## Motor Layout
//!
//! The Reachy Mini uses Dynamixel motors with the following IDs:
//!
//! | Motor ID | Description        | Joint Name |
//! |----------|--------------------| -----------|
//! | 11       | Head motor 1       | neck_roll  |
//! | 12       | Head motor 2       | neck_pitch |
//! | 13       | Head motor 3       | neck_yaw   |
//! | 14       | Head motor 4       | -          |
//! | 15       | Head motor 5       | -          |
//! | 16       | Head motor 6       | -          |
//! | 17       | Left antenna       | l_antenna  |
//! | 18       | Right antenna      | r_antenna  |
//!
//! ## Coordinate System
//!
//! - **Position**: X, Y, Z in millimeters (mm)
//! - **Orientation**: Roll, Pitch, Yaw in degrees (°)
//! - **Z = 0**: Corresponds to the minimum head height (172mm internal offset)
//!
//! ## Connection Priority
//!
//! 1. WebSocket (`ws://127.0.0.1:8000/api/move/ws/raw/write`)
//! 2. WebSerial (falls back if WebSocket unavailable)

mod audio_stream;
pub mod dynamixel;
pub mod kinematics;
mod video_stream;

// Re-export video and audio stream APIs
pub use audio_stream::*;
pub use video_stream::*;

use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::dynamixel::{
    address, build_read_packet, build_reboot_packet, build_sync_current_position,
    build_sync_read_hardware_error, build_sync_read_load, build_sync_read_temperature,
    build_sync_write_position_radians, build_sync_write_torque, parse_1byte_packets,
    parse_2byte_signed_packets, parse_position_packets, parse_status_packet_1byte,
    parse_status_packet_2byte_signed, raw_to_radians,
};
use crate::kinematics::Kinematics;

use futures_util::{SinkExt, StreamExt, TryStreamExt};
use gloo::net::websocket::futures::WebSocket;
use gloo::net::websocket::Message;
use gloo::utils::document;
use js_sys::Promise;
use serde::Deserialize;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;
use web_sys::{
    console, ReadableStream, ReadableStreamDefaultReader, WritableStream,
    WritableStreamDefaultWriter,
};

// ============================================================================
// Constants
// ============================================================================

/// Head motor IDs (motors 11-16 form the parallel kinematics mechanism)
const HEAD_MOTOR_IDS: [u8; 6] = [11, 12, 13, 14, 15, 16];

/// All motor IDs including antennas
const ALL_MOTOR_IDS: [u8; 8] = [11, 12, 13, 14, 15, 16, 17, 18];

/// Left antenna motor ID
const LEFT_ANTENNA_ID: u8 = 17;

/// Right antenna motor ID
const RIGHT_ANTENNA_ID: u8 = 18;

/// Internal Z offset in meters (head minimum height)
const HEAD_Z_OFFSET_M: f32 = 0.172;

/// Internal Z offset in millimeters
const HEAD_Z_OFFSET_MM: f32 = 172.0;

/// Default wait time for serial communication in milliseconds
const DEFAULT_WAIT_MS: u32 = 10;

// ============================================================================
// Thread-local Storage & Global State
// ============================================================================

thread_local! {
    /// Stored playback frames for recording/replay functionality
    static PLAYBACK_FRAMES: RefCell<Vec<Vec<f32>>> = RefCell::new(Vec::new());

    /// Global connection to the robot
    static GENERIC_PORT: RefCell<Option<Arc<GenericPort>>> = RefCell::new(None);
}

/// Flag to signal stopping of continuous operations (FK loop, replay, etc.)
static STOP_FLAG: AtomicBool = AtomicBool::new(false);

// ============================================================================
// External JavaScript Bindings
// ============================================================================

#[wasm_bindgen]
extern "C" {
    fn alert(s: &str);

    /// Request a serial port from the browser (WebSerial API)
    #[wasm_bindgen(js_namespace = window, catch)]
    async fn requestSerialPort() -> Result<JsValue, JsValue>;

    /// Close the current serial port connection
    #[wasm_bindgen(js_name = closeSerialPort)]
    async fn close_serial_port();

    /// Update the pose display in the UI
    ///
    /// # Arguments
    /// * `x` - X position in mm
    /// * `y` - Y position in mm  
    /// * `z` - Z position in mm (0 = minimum height)
    /// * `roll` - Roll angle in degrees
    /// * `pitch` - Pitch angle in degrees
    /// * `yaw` - Yaw angle in degrees
    #[wasm_bindgen(js_name = updatePose)]
    fn update_pose(x: f32, y: f32, z: f32, roll: f32, pitch: f32, yaw: f32);
}

// ============================================================================
// Utility Functions
// ============================================================================

/// Asynchronous sleep function for WASM environment.
///
/// # Arguments
/// * `ms` - Duration to sleep in milliseconds
///
/// # Returns
/// * `Ok(())` on success
/// * `Err(JsValue)` if the timeout fails to set
pub async fn sleep(ms: u32) -> Result<(), JsValue> {
    let promise = Promise::new(&mut |resolve, _| {
        web_sys::window()
            .unwrap()
            .set_timeout_with_callback_and_timeout_and_arguments_0(&resolve, ms as i32)
            .unwrap();
    });
    JsFuture::from(promise).await?;
    Ok(())
}

// ============================================================================
// WASM Entry Point
// ============================================================================

/// WASM module entry point. Called automatically when the module loads.
///
/// Initializes panic hooks for better error messages and enables the UI.
#[wasm_bindgen(start)]
pub fn main_js() -> Result<(), JsValue> {
    #[cfg(debug_assertions)]
    console_error_panic_hook::set_once();

    console::log_1(&JsValue::from_str("Reachy Mini WASM module loaded"));

    // Enable the connect button in the UI
    document()
        .get_element_by_id("toggle-connect")
        .map(|el| el.remove_attribute("disabled").unwrap_or_default());

    Ok(())
}

// ============================================================================
// Connection Management
// ============================================================================

/// Connect to the Reachy Mini robot.
///
/// Attempts to establish a connection in the following order:
/// 1. WebSocket connection (to provided address or default)
/// 2. WebSerial connection (prompts user to select a serial port)
///
/// # Arguments
/// * `address` - Optional WebSocket address. Can be:
///   - Full URL: `ws://192.168.1.100:8000/api/move/ws/raw/write`
///   - IP with port: `192.168.1.100:8000`
///   - IP only: `192.168.1.100` (uses default port 8000)
///   - `None` to use default address
///
/// # Returns
/// * `Ok(true)` - Successfully connected
/// * `Err(JsValue)` - Connection failed
///
/// # Example
/// ```javascript
/// // Connect with default address
/// await connect();
///
/// // Connect to specific IP
/// await connect("192.168.1.100");
///
/// // Connect to specific IP and port
/// await connect("192.168.1.100:9000");
///
/// // Connect with full WebSocket URL
/// await connect("ws://192.168.1.100:8000/api/move/ws/raw/write");
/// ```
#[wasm_bindgen]
pub async fn connect(address: Option<String>) -> Result<bool, JsValue> {
    let port = GenericPort::new(address).await?;
    GENERIC_PORT.with_borrow_mut(|p| *p = Some(Arc::new(port)));
    console::log_1(&JsValue::from_str("Connected to Reachy Mini"));
    Ok(true)
}

/// Disconnect from the Reachy Mini robot.
///
/// Releases all locks and closes the connection.
///
/// # Returns
/// * `Ok(())` on success
#[wasm_bindgen]
pub async fn disconnect() -> Result<(), JsValue> {
    GENERIC_PORT.with_borrow_mut(|port| {
        if let Some(p) = port.take() {
            let _ = p.release_lock();
        }
    });
    close_serial_port().await;
    console::log_1(&JsValue::from_str("Disconnected from Reachy Mini"));
    Ok(())
}

/// Check if currently connected to the robot.
///
/// # Returns
/// * `true` if connected
/// * `false` if not connected
#[wasm_bindgen]
pub fn is_connected() -> bool {
    GENERIC_PORT.with_borrow(|port| port.is_some())
}

// ============================================================================
// Head Pose API (Cartesian Space)
// ============================================================================

/// Get the current head pose in Cartesian coordinates.
///
/// Returns the current position and orientation of the head end-effector
/// computed via forward kinematics from the current motor positions.
///
/// # Returns
/// A vector of 6 floats: `[x, y, z, roll, pitch, yaw]`
/// - `x`, `y`, `z`: Position in millimeters
/// - `roll`, `pitch`, `yaw`: Orientation in degrees
///
/// # Errors
/// * Returns error if not connected to the robot
/// * Returns error if communication fails
///
/// # Example
/// ```javascript
/// const pose = await get_head_pose();
/// console.log(`Position: (${pose[0]}, ${pose[1]}, ${pose[2]}) mm`);
/// console.log(`Orientation: (${pose[3]}, ${pose[4]}, ${pose[5]}) deg`);
/// ```
#[wasm_bindgen]
pub async fn get_head_pose() -> Result<Vec<f32>, JsValue> {
    let port = get_port()?;

    // Read current joint positions
    let joint_angles = read_motor_positions(&port, &ALL_MOTOR_IDS).await?;

    // Extract head motors only (first 6)
    let head_angles: Vec<f32> = joint_angles[0..6].to_vec();

    // Compute forward kinematics
    let mut kinematics = create_kinematics();
    let t = kinematics.forward_kinematics(&head_angles, None);

    // Extract position (convert to mm and apply Z offset)
    let x = t[(0, 3)] * 1000.0;
    let y = t[(1, 3)] * 1000.0;
    let z = t[(2, 3)] * 1000.0 - HEAD_Z_OFFSET_MM;

    // Extract orientation (Euler XYZ)
    let (roll, pitch, yaw) = extract_euler_angles(&t);

    Ok(vec![
        x,
        y,
        z,
        roll.to_degrees(),
        pitch.to_degrees(),
        yaw.to_degrees(),
    ])
}

/// Set the head pose in Cartesian coordinates.
///
/// Computes inverse kinematics and commands the head motors to achieve
/// the specified pose.
///
/// # Arguments
/// * `x` - X position in millimeters
/// * `y` - Y position in millimeters
/// * `z` - Z position in millimeters (0 = minimum height)
/// * `roll` - Roll angle in degrees
/// * `pitch` - Pitch angle in degrees
/// * `yaw` - Yaw angle in degrees
///
/// # Errors
/// * Returns error if not connected
/// * Returns error if pose is unreachable (IK fails)
///
/// # Example
/// ```javascript
/// // Move head to center position, looking straight
/// await set_head_pose(0, 0, 50, 0, 0, 0);
/// ```
#[wasm_bindgen]
pub async fn set_head_pose(
    x: f32,
    y: f32,
    z: f32,
    roll: f32,
    pitch: f32,
    yaw: f32,
) -> Result<(), JsValue> {
    let port = get_port()?;

    // Compute inverse kinematics
    let joint_angles = compute_inverse_kinematics(x, y, z, roll, pitch, yaw)?;

    // Send to head motors only
    let packet = build_sync_write_position_radians(&HEAD_MOTOR_IDS.to_vec(), &joint_angles);

    port.write(&packet).await?;

    Ok(())
}

// ============================================================================
// Joint Position API (Joint Space)
// ============================================================================

/// Get current positions of all head joints.
///
/// Returns the raw joint angles for all 6 head motors (11-16).
///
/// # Returns
/// A vector of 6 floats representing joint angles in degrees.
///
/// # Example
/// ```javascript
/// const joints = await get_head_joints();
/// console.log(`Joint angles: ${joints.map(j => j.toFixed(2)).join(', ')} deg`);
/// ```
#[wasm_bindgen]
pub async fn get_head_joints() -> Result<Vec<f32>, JsValue> {
    let port = get_port()?;
    let angles_rad = read_motor_positions(&port, &HEAD_MOTOR_IDS).await?;
    let angles_deg: Vec<f32> = angles_rad.iter().map(|r| r.to_degrees()).collect();
    Ok(angles_deg)
}

/// Set positions of all head joints.
///
/// Directly commands all 6 head motors to the specified angles.
///
/// # Arguments
/// * `angles_deg` - Vector of 6 joint angles in degrees
///
/// # Errors
/// * Returns error if `angles_deg` length is not 6
/// * Returns error if not connected
///
/// # Example
/// ```javascript
/// // Set all head joints to zero position
/// await set_head_joints([0, 0, 0, 0, 0, 0]);
/// ```
#[wasm_bindgen]
pub async fn set_head_joints(angles_deg: Vec<f32>) -> Result<(), JsValue> {
    if angles_deg.len() != 6 {
        return Err(JsValue::from_str("Expected 6 joint angles for head motors"));
    }

    let port = get_port()?;
    let angles_rad: Vec<f32> = angles_deg.iter().map(|d| d.to_radians()).collect();

    let packet = build_sync_write_position_radians(&HEAD_MOTOR_IDS.to_vec(), &angles_rad);

    port.write(&packet).await?;

    Ok(())
}

/// Get positions of all motors (head + antennas).
///
/// Returns joint angles for all 8 motors (11-18).
///
/// # Returns
/// A vector of 8 floats representing joint angles in degrees:
/// - Index 0-5: Head motors (11-16)
/// - Index 6: Left antenna (17)
/// - Index 7: Right antenna (18)
///
/// # Example
/// ```javascript
/// const allJoints = await get_all_joints();
/// const headJoints = allJoints.slice(0, 6);
/// const leftAntenna = allJoints[6];
/// const rightAntenna = allJoints[7];
/// ```
#[wasm_bindgen]
pub async fn get_all_joints() -> Result<Vec<f32>, JsValue> {
    let port = get_port()?;
    let angles_rad = read_motor_positions(&port, &ALL_MOTOR_IDS).await?;
    let angles_deg: Vec<f32> = angles_rad.iter().map(|r| r.to_degrees()).collect();
    Ok(angles_deg)
}

/// Set positions of all motors (head + antennas).
///
/// Directly commands all 8 motors to the specified angles.
///
/// # Arguments
/// * `angles_deg` - Vector of 8 joint angles in degrees
///
/// # Errors
/// * Returns error if `angles_deg` length is not 8
///
/// # Example
/// ```javascript
/// // Set all joints including antennas
/// await set_all_joints([0, 0, 0, 0, 0, 0, 45, -45]);
/// ```
#[wasm_bindgen]
pub async fn set_all_joints(angles_deg: Vec<f32>) -> Result<(), JsValue> {
    if angles_deg.len() != 8 {
        return Err(JsValue::from_str(
            "Expected 8 joint angles (6 head + 2 antennas)",
        ));
    }

    let port = get_port()?;
    let angles_rad: Vec<f32> = angles_deg.iter().map(|d| d.to_radians()).collect();

    let packet = build_sync_write_position_radians(&ALL_MOTOR_IDS.to_vec(), &angles_rad);

    port.write(&packet).await?;

    Ok(())
}

// ============================================================================
// Antenna API
// ============================================================================

/// Get the current position of the left antenna.
///
/// # Returns
/// Antenna angle in degrees
///
/// # Example
/// ```javascript
/// const leftAngle = await get_left_antenna();
/// ```
#[wasm_bindgen]
pub async fn get_left_antenna() -> Result<f32, JsValue> {
    let port = get_port()?;
    let angles = read_motor_positions(&port, &[LEFT_ANTENNA_ID]).await?;
    Ok(angles[0].to_degrees())
}

/// Set the position of the left antenna.
///
/// # Arguments
/// * `angle_deg` - Target angle in degrees
///
/// # Example
/// ```javascript
/// await set_left_antenna(45);  // Raise left antenna
/// ```
#[wasm_bindgen]
pub async fn set_left_antenna(angle_deg: f32) -> Result<(), JsValue> {
    let port = get_port()?;
    let angle_rad = angle_deg.to_radians();

    let packet = build_sync_write_position_radians(&vec![LEFT_ANTENNA_ID], &vec![angle_rad]);

    port.write(&packet).await?;
    Ok(())
}

/// Get the current position of the right antenna.
///
/// # Returns
/// Antenna angle in degrees
///
/// # Example
/// ```javascript
/// const rightAngle = await get_right_antenna();
/// ```
#[wasm_bindgen]
pub async fn get_right_antenna() -> Result<f32, JsValue> {
    let port = get_port()?;
    let angles = read_motor_positions(&port, &[RIGHT_ANTENNA_ID]).await?;
    Ok(angles[0].to_degrees())
}

/// Set the position of the right antenna.
///
/// # Arguments
/// * `angle_deg` - Target angle in degrees
///
/// # Example
/// ```javascript
/// await set_right_antenna(-45);  // Raise right antenna
/// ```
#[wasm_bindgen]
pub async fn set_right_antenna(angle_deg: f32) -> Result<(), JsValue> {
    let port = get_port()?;
    let angle_rad = angle_deg.to_radians();

    let packet = build_sync_write_position_radians(&vec![RIGHT_ANTENNA_ID], &vec![angle_rad]);

    port.write(&packet).await?;
    Ok(())
}

/// Get positions of both antennas.
///
/// # Returns
/// Vector of 2 floats: `[left_angle, right_angle]` in degrees
///
/// # Example
/// ```javascript
/// const [left, right] = await get_antennas();
/// ```
#[wasm_bindgen]
pub async fn get_antennas() -> Result<Vec<f32>, JsValue> {
    let port = get_port()?;
    let angles = read_motor_positions(&port, &[LEFT_ANTENNA_ID, RIGHT_ANTENNA_ID]).await?;
    Ok(vec![angles[0].to_degrees(), angles[1].to_degrees()])
}

/// Set positions of both antennas.
///
/// # Arguments
/// * `left_deg` - Left antenna angle in degrees
/// * `right_deg` - Right antenna angle in degrees
///
/// # Example
/// ```javascript
/// await set_antennas(45, -45);  // Both antennas up (mirrored)
/// ```
#[wasm_bindgen]
pub async fn set_antennas(left_deg: f32, right_deg: f32) -> Result<(), JsValue> {
    let port = get_port()?;

    let packet = build_sync_write_position_radians(
        &vec![LEFT_ANTENNA_ID, RIGHT_ANTENNA_ID],
        &vec![left_deg.to_radians(), right_deg.to_radians()],
    );

    port.write(&packet).await?;
    Ok(())
}

// ============================================================================
// Torque Control API
// ============================================================================

/// Enable torque on all motors.
///
/// When torque is enabled, motors will actively hold their position
/// and resist external forces.
///
/// # Example
/// ```javascript
/// await enable_torque();
/// await set_head_pose(0, 0, 50, 0, 0, 0);  // Move head
/// ```
#[wasm_bindgen]
pub async fn enable_torque() -> Result<(), JsValue> {
    set_torque_internal(true).await
}

/// Disable torque on all motors.
///
/// When torque is disabled, motors are free to move and the robot
/// can be manually positioned (compliant mode).
///
/// # Safety
/// The head may drop when torque is disabled. Ensure the robot
/// is in a safe position before calling this function.
///
/// # Example
/// ```javascript
/// await disable_torque();  // Enable manual positioning
/// ```
#[wasm_bindgen]
pub async fn disable_torque() -> Result<(), JsValue> {
    set_torque_internal(false).await
}

/// Enable torque on head motors only (11-16).
///
/// Antennas remain in their current torque state.
#[wasm_bindgen]
pub async fn enable_head_torque() -> Result<(), JsValue> {
    let port = get_port()?;
    let packet = build_sync_write_torque(&HEAD_MOTOR_IDS.to_vec(), true);
    port.write(&packet).await?;
    Ok(())
}

/// Disable torque on head motors only (11-16).
///
/// Antennas remain in their current torque state.
#[wasm_bindgen]
pub async fn disable_head_torque() -> Result<(), JsValue> {
    let port = get_port()?;
    let packet = build_sync_write_torque(&HEAD_MOTOR_IDS.to_vec(), false);
    port.write(&packet).await?;
    Ok(())
}

/// Enable torque on antenna motors only (17-18).
#[wasm_bindgen]
pub async fn enable_antenna_torque() -> Result<(), JsValue> {
    let port = get_port()?;
    let packet = build_sync_write_torque(&vec![LEFT_ANTENNA_ID, RIGHT_ANTENNA_ID], true);
    port.write(&packet).await?;
    Ok(())
}

/// Disable torque on antenna motors only (17-18).
#[wasm_bindgen]
pub async fn disable_antenna_torque() -> Result<(), JsValue> {
    let port = get_port()?;
    let packet = build_sync_write_torque(&vec![LEFT_ANTENNA_ID, RIGHT_ANTENNA_ID], false);
    port.write(&packet).await?;
    Ok(())
}

/// Enable torque on left antenna motor only (17).
#[wasm_bindgen]
pub async fn enable_left_antenna_torque() -> Result<(), JsValue> {
    let port = get_port()?;
    let packet = build_sync_write_torque(&vec![LEFT_ANTENNA_ID], true);
    port.write(&packet).await?;
    Ok(())
}

/// Disable torque on left antenna motor only (17).
#[wasm_bindgen]
pub async fn disable_left_antenna_torque() -> Result<(), JsValue> {
    let port = get_port()?;
    let packet = build_sync_write_torque(&vec![LEFT_ANTENNA_ID], false);
    port.write(&packet).await?;
    Ok(())
}

/// Enable torque on right antenna motor only (18).
#[wasm_bindgen]
pub async fn enable_right_antenna_torque() -> Result<(), JsValue> {
    let port = get_port()?;
    let packet = build_sync_write_torque(&vec![RIGHT_ANTENNA_ID], true);
    port.write(&packet).await?;
    Ok(())
}

/// Disable torque on right antenna motor only (18).
#[wasm_bindgen]
pub async fn disable_right_antenna_torque() -> Result<(), JsValue> {
    let port = get_port()?;
    let packet = build_sync_write_torque(&vec![RIGHT_ANTENNA_ID], false);
    port.write(&packet).await?;
    Ok(())
}

// ============================================================================
// Motor Diagnostics API
// ============================================================================

/// Get the temperature of a specific motor.
///
/// # Arguments
/// * `motor_id` - Motor ID (11-18)
///
/// # Returns
/// Temperature in degrees Celsius
///
/// # Example
/// ```javascript
/// const temp = await get_motor_temperature(11);
/// console.log(`Motor 11 temperature: ${temp}°C`);
/// ```
#[wasm_bindgen]
pub async fn get_motor_temperature(motor_id: u8) -> Result<u8, JsValue> {
    let port = get_port()?;
    let packet = build_read_packet(motor_id, address::PRESENT_TEMPERATURE, 1);
    let response = port.write_read(&packet, Some(DEFAULT_WAIT_MS)).await?;
    parse_status_packet_1byte(&response)
}

/// Get the current load of a specific motor.
///
/// Load represents the percentage of maximum torque currently being applied.
///
/// # Arguments
/// * `motor_id` - Motor ID (11-18)
///
/// # Returns
/// Load value from -1000 to 1000 (percentage of max torque × 10)
/// - Positive values: Counter-clockwise load
/// - Negative values: Clockwise load
///
/// # Example
/// ```javascript
/// const load = await get_motor_load(11);
/// console.log(`Motor 11 load: ${load / 10}%`);
/// ```
#[wasm_bindgen]
pub async fn get_motor_load(motor_id: u8) -> Result<i16, JsValue> {
    let port = get_port()?;
    let packet = build_read_packet(motor_id, address::PRESENT_LOAD, 2);
    let response = port.write_read(&packet, Some(DEFAULT_WAIT_MS)).await?;
    parse_status_packet_2byte_signed(&response)
}

/// Get temperatures of all motors using bulk read.
///
/// Uses resilient parsing - missing motor responses don't affect others.
///
/// # Returns
/// Vector of 8 temperatures in °C for motors 11-18 (0 if motor didn't respond)
///
/// # Example
/// ```javascript
/// const temps = await get_all_motor_temperatures();
/// temps.forEach((t, i) => console.log(`Motor ${11 + i}: ${t}°C`));
/// ```
#[wasm_bindgen]
pub async fn get_all_motor_temperatures() -> Result<Vec<u8>, JsValue> {
    let port = get_port()?;
    let packet = build_sync_read_temperature(&ALL_MOTOR_IDS);
    let response = port.write_read(&packet, Some(DEFAULT_WAIT_MS)).await?;

    let parsed = parse_1byte_packets(&response);

    // Map by motor ID, default to 0 for missing
    let mut temps = vec![0u8; 8];
    for (id, temp) in parsed {
        if id >= 11 && id <= 18 {
            temps[(id - 11) as usize] = temp;
        }
    }
    Ok(temps)
}

/// Get loads of all motors using bulk read.
///
/// Uses resilient parsing - missing motor responses don't affect others.
///
/// # Returns
/// Vector of 8 load values for motors 11-18 (0 if motor didn't respond)
///
/// # Example
/// ```javascript
/// const loads = await get_all_motor_loads();
/// loads.forEach((l, i) => console.log(`Motor ${11 + i}: ${l / 10}%`));
/// ```
#[wasm_bindgen]
pub async fn get_all_motor_loads() -> Result<Vec<i16>, JsValue> {
    let port = get_port()?;
    let packet = build_sync_read_load(&ALL_MOTOR_IDS);
    let response = port.write_read(&packet, Some(DEFAULT_WAIT_MS)).await?;

    let parsed = parse_2byte_signed_packets(&response);

    let mut loads = vec![0i16; 8];
    for (id, load) in parsed {
        if id >= 11 && id <= 18 {
            loads[(id - 11) as usize] = load;
        }
    }
    Ok(loads)
}

/// Get temperatures of head motors (11-16) using bulk read.
///
/// # Returns
/// Vector of 6 temperatures in °C (0 if motor didn't respond)
#[wasm_bindgen]
pub async fn get_head_motor_temperatures() -> Result<Vec<u8>, JsValue> {
    let port = get_port()?;
    let packet = build_sync_read_temperature(&HEAD_MOTOR_IDS);
    let response = port.write_read(&packet, Some(DEFAULT_WAIT_MS)).await?;

    let parsed = parse_1byte_packets(&response);

    let mut temps = vec![0u8; 6];
    for (id, temp) in parsed {
        if id >= 11 && id <= 16 {
            temps[(id - 11) as usize] = temp;
        }
    }
    Ok(temps)
}

/// Get loads of head motors (11-16) using bulk read.
///
/// # Returns
/// Vector of 6 load values (0 if motor didn't respond)
#[wasm_bindgen]
pub async fn get_head_motor_loads() -> Result<Vec<i16>, JsValue> {
    let port = get_port()?;
    let packet = build_sync_read_load(&HEAD_MOTOR_IDS);
    let response = port.write_read(&packet, Some(DEFAULT_WAIT_MS)).await?;

    let parsed = parse_2byte_signed_packets(&response);

    let mut loads = vec![0i16; 6];
    for (id, load) in parsed {
        if id >= 11 && id <= 16 {
            loads[(id - 11) as usize] = load;
        }
    }
    Ok(loads)
}

/// Get the temperature of the left antenna motor (17).
///
/// # Returns
/// Temperature in degrees Celsius
#[wasm_bindgen]
pub async fn get_left_antenna_temperature() -> Result<u8, JsValue> {
    get_motor_temperature(LEFT_ANTENNA_ID).await
}

/// Get the temperature of the right antenna motor (18).
///
/// # Returns
/// Temperature in degrees Celsius
#[wasm_bindgen]
pub async fn get_right_antenna_temperature() -> Result<u8, JsValue> {
    get_motor_temperature(RIGHT_ANTENNA_ID).await
}

/// Get temperatures of both antenna motors using bulk read.
///
/// # Returns
/// Vector of 2 temperatures: `[left_temp, right_temp]` in °C (0 if motor didn't respond)
#[wasm_bindgen]
pub async fn get_antenna_temperatures() -> Result<Vec<u8>, JsValue> {
    let port = get_port()?;
    let motor_ids = [LEFT_ANTENNA_ID, RIGHT_ANTENNA_ID];
    let packet = build_sync_read_temperature(&motor_ids);
    let response = port.write_read(&packet, Some(DEFAULT_WAIT_MS)).await?;

    let parsed = parse_1byte_packets(&response);

    let mut temps = vec![0u8; 2];
    for (id, temp) in parsed {
        if id == LEFT_ANTENNA_ID {
            temps[0] = temp;
        } else if id == RIGHT_ANTENNA_ID {
            temps[1] = temp;
        }
    }
    Ok(temps)
}

/// Get the load of the left antenna motor (17).
///
/// # Returns
/// Load value from -1000 to 1000
#[wasm_bindgen]
pub async fn get_left_antenna_load() -> Result<i16, JsValue> {
    get_motor_load(LEFT_ANTENNA_ID).await
}

/// Get the load of the right antenna motor (18).
///
/// # Returns
/// Load value from -1000 to 1000
#[wasm_bindgen]
pub async fn get_right_antenna_load() -> Result<i16, JsValue> {
    get_motor_load(RIGHT_ANTENNA_ID).await
}

/// Get loads of both antenna motors using bulk read.
///
/// # Returns
/// Vector of 2 loads: `[left_load, right_load]` (0 if motor didn't respond)
#[wasm_bindgen]
pub async fn get_antenna_loads() -> Result<Vec<i16>, JsValue> {
    let port = get_port()?;
    let motor_ids = [LEFT_ANTENNA_ID, RIGHT_ANTENNA_ID];
    let packet = build_sync_read_load(&motor_ids);
    let response = port.write_read(&packet, Some(DEFAULT_WAIT_MS)).await?;

    let parsed = parse_2byte_signed_packets(&response);

    let mut loads = vec![0i16; 2];
    for (id, load) in parsed {
        if id == LEFT_ANTENNA_ID {
            loads[0] = load;
        } else if id == RIGHT_ANTENNA_ID {
            loads[1] = load;
        }
    }
    Ok(loads)
}

// ============================================================================
// Motor Reboot API
// ============================================================================

/// Reboot a specific motor by ID.
///
/// This clears any hardware error status and reinitializes the motor.
/// The motor will be unresponsive for approximately 500ms after reboot.
///
/// # Arguments
/// * `motor_id` - Motor ID (11-18)
///
/// # Example
/// ```javascript
/// await reboot_motor(11);
/// ```
#[wasm_bindgen]
pub async fn reboot_motor(motor_id: u8) -> Result<(), JsValue> {
    let port = get_port()?;
    console::log_1(&format!("Rebooting motor {}...", motor_id).into());

    let packet = build_reboot_packet(motor_id);
    port.write(&packet).await?;

    // Wait for motor to reboot
    sleep(500).await?;

    console::log_1(&format!("Motor {} rebooted", motor_id).into());
    Ok(())
}

/// Reboot the left antenna motor (17).
///
/// # Example
/// ```javascript
/// await reboot_left_antenna();
/// ```
#[wasm_bindgen]
pub async fn reboot_left_antenna() -> Result<(), JsValue> {
    reboot_motor(LEFT_ANTENNA_ID).await
}

/// Reboot the right antenna motor (18).
///
/// # Example
/// ```javascript
/// await reboot_right_antenna();
/// ```
#[wasm_bindgen]
pub async fn reboot_right_antenna() -> Result<(), JsValue> {
    reboot_motor(RIGHT_ANTENNA_ID).await
}

/// Reboot both antenna motors.
///
/// # Example
/// ```javascript
/// await reboot_antennas();
/// ```
#[wasm_bindgen]
pub async fn reboot_antennas() -> Result<(), JsValue> {
    reboot_motor(LEFT_ANTENNA_ID).await?;
    reboot_motor(RIGHT_ANTENNA_ID).await
}

/// Reboot all head motors (11-16).
///
/// Reboots each head motor sequentially with appropriate delays.
///
/// # Warning
/// This operation takes approximately 3 seconds.
///
/// # Example
/// ```javascript
/// await reboot_head_motors();
/// ```
#[wasm_bindgen]
pub async fn reboot_head_motors() -> Result<(), JsValue> {
    console::log_1(&JsValue::from_str("Rebooting head motors..."));
    for &motor_id in &HEAD_MOTOR_IDS {
        reboot_motor(motor_id).await?;
    }
    console::log_1(&JsValue::from_str("Head motors rebooted"));
    Ok(())
}

/// Reboot all motors (head + antennas).
///
/// Reboots each motor sequentially with appropriate delays.
/// This is useful for clearing hardware errors on all motors.
///
/// # Warning
/// This operation takes approximately 4 seconds (500ms per motor × 8 motors).
///
/// # Example
/// ```javascript
/// console.log('Rebooting all motors...');
/// await reboot_all_motors();
/// console.log('All motors rebooted');
/// ```
#[wasm_bindgen]
pub async fn reboot_all_motors() -> Result<(), JsValue> {
    console::log_1(&JsValue::from_str("Rebooting all motors..."));
    for &motor_id in &ALL_MOTOR_IDS {
        reboot_motor(motor_id).await?;
    }
    console::log_1(&JsValue::from_str("All motors rebooted successfully"));
    Ok(())
}

/// Get hardware error status for all motors.
///
/// Returns a vector of 8 values representing the Hardware Error Status
/// register for each motor (11-18). A value of 0 means no error.
///
/// Hardware Error Status bit meanings:
/// - Bit 0: Input Voltage Error
/// - Bit 2: Motor Hall Sensor Error
/// - Bit 3: Overheating Error
/// - Bit 4: Motor Encoder Error
/// - Bit 5: Electrical Shock Error
/// - Bit 7: Overload Error
///
/// # Example
/// ```javascript
/// const errors = await get_motor_errors();
/// errors.forEach((err, i) => {
///   if (err !== 0) console.log(`Motor ${11 + i} has error: 0x${err.toString(16)}`);
/// });
/// ```
#[wasm_bindgen]
pub async fn get_motor_errors() -> Result<Vec<u8>, JsValue> {
    let port = get_port()?;
    let packet = build_sync_read_hardware_error(&ALL_MOTOR_IDS);
    let response = port.write_read(&packet, Some(DEFAULT_WAIT_MS)).await?;

    let parsed = parse_1byte_packets(&response);

    // Map by motor ID, default to 0 for missing
    let mut errors = vec![0u8; 8];
    for (id, error) in parsed {
        if id >= 11 && id <= 18 {
            errors[(id - 11) as usize] = error;
        }
    }
    Ok(errors)
}

/// Check all motors and reboot any that have hardware errors.
///
/// This function reads the Hardware Error Status register from all motors,
/// identifies which motors have errors, and reboots only those motors.
///
/// # Returns
/// Returns a `CheckAndRebootResult` containing:
/// - `motors_checked`: Number of motors that responded
/// - `motors_with_errors`: Array of motor IDs that had errors
/// - `motors_rebooted`: Array of motor IDs that were rebooted
/// - `motors_no_response`: Array of motor IDs that didn't respond
///
/// # Example
/// ```javascript
/// const result = await check_and_reboot_motors();
/// console.log(`Checked ${result.motors_checked} motors`);
/// if (result.motors_rebooted.length > 0) {
///   console.log(`Rebooted motors: ${result.motors_rebooted.join(', ')}`);
/// }
/// ```
#[wasm_bindgen]
pub async fn check_and_reboot_motors() -> Result<JsValue, JsValue> {
    let port = get_port()?;

    console::log_1(&JsValue::from_str("Checking motors for hardware errors..."));

    // Use SYNC_READ to get hardware error status from all motors
    let packet = build_sync_read_hardware_error(&ALL_MOTOR_IDS);
    let response = port.write_read(&packet, Some(DEFAULT_WAIT_MS)).await?;

    let parsed = parse_1byte_packets(&response);

    // Track which motors responded and which have errors
    let mut motors_with_errors: Vec<u8> = Vec::new();
    let mut motors_responded: Vec<u8> = Vec::new();

    for (motor_id, error_status) in parsed {
        motors_responded.push(motor_id);
        if error_status != 0 {
            motors_with_errors.push(motor_id);
            console::log_1(
                &format!(
                    "Motor {} has hardware error: 0x{:02X}",
                    motor_id, error_status
                )
                .into(),
            );
        }
    }

    // Find motors that didn't respond
    let motors_no_response: Vec<u8> = ALL_MOTOR_IDS
        .iter()
        .filter(|id| !motors_responded.contains(id))
        .copied()
        .collect();

    if !motors_no_response.is_empty() {
        console::log_1(&format!("Motors did not respond: {:?}", motors_no_response).into());
    }

    // Reboot motors with errors
    let mut motors_rebooted: Vec<u8> = Vec::new();
    for motor_id in &motors_with_errors {
        console::log_1(&format!("Rebooting motor {}...", motor_id).into());
        reboot_motor(*motor_id).await?;
        motors_rebooted.push(*motor_id);
    }

    if motors_rebooted.is_empty() {
        console::log_1(&JsValue::from_str("All motors OK, no reboot needed"));
    } else {
        console::log_1(
            &format!(
                "Rebooted {} motor(s): {:?}",
                motors_rebooted.len(),
                motors_rebooted
            )
            .into(),
        );
    }

    // Return result as a JS object
    let result = js_sys::Object::new();
    let motors_checked = ALL_MOTOR_IDS.len() - motors_no_response.len();
    js_sys::Reflect::set(
        &result,
        &JsValue::from_str("motors_checked"),
        &JsValue::from(motors_checked as u32),
    )?;

    let errors_arr = js_sys::Array::new();
    for id in &motors_with_errors {
        errors_arr.push(&JsValue::from(*id));
    }
    js_sys::Reflect::set(
        &result,
        &JsValue::from_str("motors_with_errors"),
        &errors_arr,
    )?;

    let rebooted_arr = js_sys::Array::new();
    for id in &motors_rebooted {
        rebooted_arr.push(&JsValue::from(*id));
    }
    js_sys::Reflect::set(
        &result,
        &JsValue::from_str("motors_rebooted"),
        &rebooted_arr,
    )?;

    let no_response_arr = js_sys::Array::new();
    for id in &motors_no_response {
        no_response_arr.push(&JsValue::from(*id));
    }
    js_sys::Reflect::set(
        &result,
        &JsValue::from_str("motors_no_response"),
        &no_response_arr,
    )?;

    Ok(result.into())
}

// ============================================================================
// Kinematics Utilities (Pure Functions - No Hardware Access)
// ============================================================================

/// Compute forward kinematics from joint angles.
///
/// This is a pure computation function that does not communicate with hardware.
/// Use this for trajectory planning or simulation.
///
/// # Arguments
/// * `angles_deg` - Vector of 6 joint angles in degrees (or 8 if including antennas)
///
/// # Returns
/// Vector of 6 floats: `[x, y, z, roll, pitch, yaw]`
/// - Position in mm, orientation in degrees
///
/// # Example
/// ```javascript
/// const pose = forward_kinematics([0, 0, 0, 0, 0, 0]);
/// console.log(`At zero position, head is at: ${pose}`);
/// ```
#[wasm_bindgen]
pub fn forward_kinematics(angles_deg: Vec<f32>) -> Result<Vec<f32>, JsValue> {
    if angles_deg.len() < 6 {
        return Err(JsValue::from_str("Expected at least 6 joint angles"));
    }

    let angles_rad: Vec<f32> = angles_deg[0..6].iter().map(|d| d.to_radians()).collect();

    let mut kinematics = create_kinematics();

    // Initialize with default position
    let t_init =
        nalgebra::Matrix4::new_translation(&nalgebra::Vector3::new(0.0, 0.0, HEAD_Z_OFFSET_M));
    kinematics.reset_forward_kinematics(t_init);

    // Iterate to converge
    for _ in 0..100 {
        kinematics.forward_kinematics(&angles_rad, None);
    }

    let t = kinematics.forward_kinematics(&angles_rad, None);

    // Extract pose
    let x = t[(0, 3)] * 1000.0;
    let y = t[(1, 3)] * 1000.0;
    let z = t[(2, 3)] * 1000.0 - HEAD_Z_OFFSET_MM;

    let (roll, pitch, yaw) = extract_euler_angles(&t);

    Ok(vec![
        x,
        y,
        z,
        roll.to_degrees(),
        pitch.to_degrees(),
        yaw.to_degrees(),
    ])
}

/// Compute inverse kinematics from Cartesian pose.
///
/// This is a pure computation function that does not communicate with hardware.
/// Use this for trajectory planning or to preview joint angles before sending.
///
/// # Arguments
/// * `xyzrpy` - Vector of 6 floats: `[x, y, z, roll, pitch, yaw]`
///   - Position in mm, orientation in degrees
///
/// # Returns
/// Vector of 6 joint angles in degrees
///
/// # Errors
/// Returns error if the pose is unreachable
///
/// # Example
/// ```javascript
/// const joints = inverse_kinematics([0, 0, 50, 0, 15, 0]);
/// console.log(`To look up 15°, set joints to: ${joints}`);
/// ```
#[wasm_bindgen]
pub fn inverse_kinematics(xyzrpy: Vec<f32>) -> Result<Vec<f32>, JsValue> {
    if xyzrpy.len() != 6 {
        return Err(JsValue::from_str(
            "Expected 6 values: [x, y, z, roll, pitch, yaw]",
        ));
    }

    let mut kinematics = create_kinematics();

    // Build transformation matrix
    let roll_rad = xyzrpy[3].to_radians();
    let pitch_rad = xyzrpy[4].to_radians();
    let yaw_rad = xyzrpy[5].to_radians();

    let rotation = nalgebra::Rotation3::from_euler_angles(roll_rad, pitch_rad, yaw_rad);
    let mut t = rotation.to_homogeneous();

    // Apply translation (convert mm to m, add Z offset)
    t[(0, 3)] = xyzrpy[0] / 1000.0;
    t[(1, 3)] = xyzrpy[1] / 1000.0;
    t[(2, 3)] = (xyzrpy[2] + HEAD_Z_OFFSET_MM) / 1000.0;

    let joints = kinematics.inverse_kinematics(t, None);
    let joints_deg: Vec<f32> = joints.iter().map(|r| r.to_degrees()).collect();

    Ok(joints_deg)
}

// ============================================================================
// Recording & Playback API
// ============================================================================

/// Start continuous forward kinematics reading and optionally record.
///
/// This function reads motor positions in a loop and updates the UI.
/// If `duration` is provided, it records frames for that duration.
///
/// # Arguments
/// * `duration` - Optional recording duration in milliseconds.
///   If `None`, runs indefinitely until `stop()` is called.
///
/// # Example
/// ```javascript
/// // Start live FK display
/// start_fk_stream();
///
/// // Record for 5 seconds
/// await start_fk_stream(5000);
/// ```
///
/// # Deprecated
/// Consider using `get_head_pose()` in a JavaScript loop instead for more control.
#[wasm_bindgen]
#[deprecated(note = "Use get_head_pose() in a JS loop for more control")]
pub async fn start_fk_stream(duration: Option<f64>) -> Result<(), JsValue> {
    fk(duration).await
}

/// Replay recorded motion.
///
/// Plays back frames that were recorded during a previous `start_fk_stream(duration)` call.
/// Automatically enables torque before playback and disables after.
///
/// # Example
/// ```javascript
/// // Record motion
/// await start_fk_stream(3000);  // Record for 3 seconds
///
/// // Replay it
/// await replay_recording();
/// ```
#[wasm_bindgen]
pub async fn replay_recording() -> Result<(), JsValue> {
    enable_torque().await?;

    let frames = PLAYBACK_FRAMES.with_borrow(|f| f.clone());
    if frames.is_empty() {
        return Err(JsValue::from_str("No recorded frames to replay"));
    }

    STOP_FLAG.store(false, Ordering::Relaxed);
    let port = get_port()?;

    for frame in frames.iter() {
        let packet = build_sync_write_position_radians(&ALL_MOTOR_IDS.to_vec(), frame);
        port.write(&packet).await?;
        sleep(20).await?;

        if STOP_FLAG.load(Ordering::Relaxed) {
            break;
        }
    }

    disable_torque().await?;
    Ok(())
}

/// Stop any continuous operation (FK stream, replay, etc.).
///
/// # Example
/// ```javascript
/// start_fk_stream();  // Start streaming
/// // ... some time later ...
/// stop();  // Stop streaming
/// ```
#[wasm_bindgen]
pub fn stop() {
    STOP_FLAG.store(true, Ordering::Relaxed);
}

/// Clear recorded frames.
#[wasm_bindgen]
pub fn clear_recording() {
    PLAYBACK_FRAMES.with_borrow_mut(|f| f.clear());
}

/// Get the number of recorded frames.
#[wasm_bindgen]
pub fn get_recording_length() -> usize {
    PLAYBACK_FRAMES.with_borrow(|f| f.len())
}

// ============================================================================
// Internal Helper Functions
// ============================================================================

/// Get the current port or return an error.
fn get_port() -> Result<Arc<GenericPort>, JsValue> {
    GENERIC_PORT
        .with_borrow(|port| port.clone())
        .ok_or_else(|| JsValue::from_str("Not connected to Reachy Mini. Call connect() first."))
}

/// Read motor positions from specified motor IDs.
///
/// Uses resilient parsing that scans for packet headers,
/// so missing motor responses don't affect other results.
async fn read_motor_positions(port: &GenericPort, motor_ids: &[u8]) -> Result<Vec<f32>, JsValue> {
    let packet = build_sync_current_position(motor_ids);
    let response = port.write_read(&packet, Some(DEFAULT_WAIT_MS)).await?;

    // Parse all valid packets from response
    let parsed = parse_position_packets(&response);

    // Map results by motor ID, defaulting to 0.0 for missing motors
    let mut positions = vec![0.0f32; motor_ids.len()];
    for (id, raw_pos) in parsed {
        // Find index of this motor in our request
        if let Some(idx) = motor_ids.iter().position(|&m| m == id) {
            positions[idx] = raw_to_radians(raw_pos);
        }
    }

    Ok(positions)
}

/// Set torque on all motors.
async fn set_torque_internal(enable: bool) -> Result<(), JsValue> {
    let port = get_port()?;
    let packet = build_sync_write_torque(&ALL_MOTOR_IDS.to_vec(), enable);
    port.write(&packet).await?;
    Ok(())
}

/// Compute inverse kinematics for a given pose.
fn compute_inverse_kinematics(
    x: f32,
    y: f32,
    z: f32,
    roll: f32,
    pitch: f32,
    yaw: f32,
) -> Result<Vec<f32>, JsValue> {
    let mut kinematics = create_kinematics();

    let rotation = nalgebra::Rotation3::from_euler_angles(
        roll.to_radians(),
        pitch.to_radians(),
        yaw.to_radians(),
    );
    let mut t = rotation.to_homogeneous();

    t[(0, 3)] = x / 1000.0;
    t[(1, 3)] = y / 1000.0;
    t[(2, 3)] = (z + HEAD_Z_OFFSET_MM) / 1000.0;

    Ok(kinematics.inverse_kinematics(t, None))
}

/// Extract Euler angles (roll, pitch, yaw) from a transformation matrix.
fn extract_euler_angles(t: &nalgebra::Matrix4<f32>) -> (f32, f32, f32) {
    let r = t.fixed_view::<3, 3>(0, 0);

    let pitch = (-r[(2, 0)]).asin();

    let (roll, yaw) = if pitch.cos().abs() > 1e-6 {
        (r[(2, 1)].atan2(r[(2, 2)]), r[(1, 0)].atan2(r[(0, 0)]))
    } else {
        // Gimbal lock
        ((-r[(1, 2)]).atan2(r[(1, 1)]), 0.0)
    };

    (roll, pitch, yaw)
}

/// Create and configure the kinematics solver with motor parameters.
fn create_kinematics() -> Kinematics {
    let motors: Vec<Motor> =
        serde_json::from_str(MOTOR_JSON).expect("Failed to parse motor configuration JSON");

    let mut kinematics = Kinematics::new(0.038, 0.09);

    for motor in motors {
        let branch_position = nalgebra::Vector3::new(
            motor.branch_position[0],
            motor.branch_position[1],
            motor.branch_position[2],
        );

        let t_motor_world = nalgebra::Matrix4::new(
            motor.T_motor_world[0][0],
            motor.T_motor_world[0][1],
            motor.T_motor_world[0][2],
            motor.T_motor_world[0][3],
            motor.T_motor_world[1][0],
            motor.T_motor_world[1][1],
            motor.T_motor_world[1][2],
            motor.T_motor_world[1][3],
            motor.T_motor_world[2][0],
            motor.T_motor_world[2][1],
            motor.T_motor_world[2][2],
            motor.T_motor_world[2][3],
            motor.T_motor_world[3][0],
            motor.T_motor_world[3][1],
            motor.T_motor_world[3][2],
            motor.T_motor_world[3][3],
        );

        let solution = if motor.solution != 0.0 { 1.0 } else { -1.0 };
        kinematics.add_branch(
            branch_position,
            t_motor_world.try_inverse().unwrap(),
            solution,
        );
    }

    kinematics
}

// ============================================================================
// Legacy Functions (Deprecated)
// ============================================================================

/// Legacy forward kinematics loop.
///
/// # Deprecated
/// Use `start_fk_stream()` or `get_head_pose()` instead.
#[deprecated(note = "Use start_fk_stream() or get_head_pose() instead")]
pub async fn fk(duration: Option<f64>) -> Result<(), JsValue> {
    let port = get_port()?;
    let mut kinematics = create_kinematics();

    let mut results = vec![0.0f32; 8];
    let start_time = js_sys::Date::now();

    STOP_FLAG.store(false, Ordering::Relaxed);
    PLAYBACK_FRAMES.with_borrow_mut(|f| f.clear());

    loop {
        let ping_current = build_sync_current_position(&ALL_MOTOR_IDS);
        let result = port.write_read(&ping_current, Some(DEFAULT_WAIT_MS)).await;

        match result {
            Err(err) => {
                console::log_1(&format!("Error reading: {:?}", err).into());
            }
            Ok(res) => {
                // Use resilient parsing that handles missing motor responses
                for (id, pos) in parse_position_packets(&res) {
                    if id >= 11 && id <= 18 {
                        results[(id - 11) as usize] = raw_to_radians(pos);
                    }
                }

                if let Some(dur) = duration {
                    let progress = (js_sys::Date::now() - start_time) / dur;
                    if progress >= 1.0 {
                        break;
                    }
                    PLAYBACK_FRAMES.with_borrow_mut(|f| f.push(results.clone()));
                }

                let t = kinematics.forward_kinematics(&results[0..6].to_vec(), None);
                let x = t[(0, 3)] * 1000.0;
                let y = t[(1, 3)] * 1000.0;
                let z = t[(2, 3)] * 1000.0 - HEAD_Z_OFFSET_MM;
                let (roll, pitch, yaw) = extract_euler_angles(&t);

                update_pose(
                    x,
                    y,
                    z,
                    roll.to_degrees(),
                    pitch.to_degrees(),
                    yaw.to_degrees(),
                );

                sleep(DEFAULT_WAIT_MS).await?;

                if STOP_FLAG.load(Ordering::Relaxed) {
                    break;
                }
            }
        }
    }

    Ok(())
}

/// Legacy torque on function.
///
/// # Deprecated
/// Use `enable_torque()` instead.
#[wasm_bindgen]
#[deprecated(note = "Use enable_torque() instead")]
pub async fn torque_on() -> Result<(), JsValue> {
    enable_torque().await
}

/// Legacy torque off function.
///
/// # Deprecated
/// Use `disable_torque()` instead.
#[wasm_bindgen]
#[deprecated(note = "Use disable_torque() instead")]
pub async fn torque_off() -> Result<(), JsValue> {
    disable_torque().await
}

/// Legacy replay function.
///
/// # Deprecated
/// Use `replay_recording()` instead.
#[wasm_bindgen]
#[deprecated(note = "Use replay_recording() instead")]
pub async fn replay() -> Result<(), JsValue> {
    replay_recording().await
}

// ============================================================================
// Connection Infrastructure
// ============================================================================

/// Generic port wrapper supporting both WebSocket and WebSerial connections.
pub struct GenericPort {
    connection: Connection,
}

enum Connection {
    WebSerial {
        reader: ReadableStreamDefaultReader,
        writer: WritableStreamDefaultWriter,
    },
    WebSocket {
        sender: Arc<Mutex<futures_util::stream::SplitSink<WebSocket, Message>>>,
        receiver: Arc<Mutex<futures_util::stream::SplitStream<WebSocket>>>,
    },
}

/// Default WebSocket port for Reachy Mini
const DEFAULT_WS_PORT: u16 = 8000;

/// Default WebSocket path for raw motor control
const DEFAULT_WS_PATH: &str = "/api/move/ws/raw/write";

/// Default IP address (127.0.0.1)
const DEFAULT_WS_HOST: &str = "127.0.0.1";

impl GenericPort {
    /// Check if the browser supports WebSerial (Chrome/Chromium-based browsers).
    fn is_webserial_supported() -> bool {
        if let Some(window) = web_sys::window() {
            if let Ok(navigator) = js_sys::Reflect::get(&window, &"navigator".into()) {
                return js_sys::Reflect::has(&navigator, &"serial".into()).unwrap_or(false);
            }
        }
        false
    }

    /// Check if the browser is Safari.
    /// Safari has known issues connecting to localhost from HTTPS websites.
    fn is_safari() -> bool {
        if let Some(window) = web_sys::window() {
            if let Ok(navigator) = js_sys::Reflect::get(&window, &"navigator".into()) {
                if let Ok(user_agent) = js_sys::Reflect::get(&navigator, &"userAgent".into()) {
                    if let Some(ua_str) = user_agent.as_string() {
                        let ua_lower = ua_str.to_lowercase();
                        // Safari includes "safari" but Chrome also includes "safari" in its UA
                        // So we check for Safari but exclude Chrome and Android
                        return ua_lower.contains("safari")
                            && !ua_lower.contains("chrome")
                            && !ua_lower.contains("chromium")
                            && !ua_lower.contains("android");
                    }
                }
            }
        }
        false
    }

    /// Create a new connection, trying WebSocket first, then WebSerial.
    ///
    /// # Arguments
    /// * `address` - Optional address string. Can be:
    ///   - Full URL: `ws://192.168.1.100:8000/api/move/ws/raw/write`
    ///   - IP with port: `192.168.1.100:8000`
    ///   - IP only: `192.168.1.100` (uses default port 8000)
    ///   - `None` to use default (127.0.0.1:8000)
    pub async fn new(address: Option<String>) -> Result<Self, JsValue> {
        let url = Self::build_websocket_url(address.clone());
        console::log_1(&format!("Attempting WebSocket connection to: {}", url).into());

        match Self::from_websocket(&url).await {
            Ok(ws) => Ok(ws),
            Err(e) => {
                // Only try WebSerial on browsers that support it (Chrome/Chromium)
                if Self::is_webserial_supported() {
                    console::log_1(&format!("WebSocket failed: {:?}, trying WebSerial", e).into());
                    Self::from_webserial().await
                } else {
                    // Check if this is Safari - provide specific error message with underlying error
                    if Self::is_safari() {
                        return Err(JsValue::from_str(&format!(
                            "Safari has known issues connecting to localhost from HTTPS websites. Please use Chrome or Firefox for the best experience. (Error: {:?})",
                            e
                        )));
                    }

                    // Non-Chrome browser: show cleaner error about WebSocket connection
                    let is_localhost = url.contains("127.0.0.1") || url.contains("localhost");
                    let error_msg = if is_localhost {
                        format!(
                            "Could not connect to {}. Make sure the Reachy Mini desktop app is running.",
                            url
                        )
                    } else {
                        format!("Could not connect to {}", url)
                    };
                    Err(JsValue::from_str(&error_msg))
                }
            }
        }
    }

    /// Build a WebSocket URL from various address formats.
    fn build_websocket_url(address: Option<String>) -> String {
        match address {
            None => {
                // Use default 127.0.0.1
                format!(
                    "ws://{}:{}{}",
                    DEFAULT_WS_HOST, DEFAULT_WS_PORT, DEFAULT_WS_PATH
                )
            }
            Some(addr) => {
                let addr = addr.trim();

                // Already a full WebSocket URL
                if addr.starts_with("ws://") || addr.starts_with("wss://") {
                    return addr.to_string();
                }

                // Parse the address
                if addr.contains(':') {
                    // Has port specified (e.g., "192.168.1.100:9000")
                    let parts: Vec<&str> = addr.splitn(2, ':').collect();
                    let host = parts[0];
                    let port = parts[1].parse::<u16>().unwrap_or(DEFAULT_WS_PORT);
                    format!("ws://{}:{}{}", host, port, DEFAULT_WS_PATH)
                } else {
                    // Just IP/hostname (e.g., "192.168.1.100")
                    format!("ws://{}:{}{}", addr, DEFAULT_WS_PORT, DEFAULT_WS_PATH)
                }
            }
        }
    }

    /// Connect via WebSocket.
    pub async fn from_websocket(url: &str) -> Result<Self, JsValue> {
        let ws = WebSocket::open(url)
            .map_err(|e| JsValue::from_str(&format!("WebSocket open failed: {:?}", e)))?;

        // Wait for connection
        loop {
            match ws.state() {
                gloo::net::websocket::State::Connecting => sleep(10).await?,
                gloo::net::websocket::State::Open => break,
                _ => return Err(JsValue::from_str("WebSocket connection failed")),
            }
        }

        let (sender, receiver) = ws.split();
        Ok(Self {
            connection: Connection::WebSocket {
                sender: Arc::new(Mutex::new(sender)),
                receiver: Arc::new(Mutex::new(receiver)),
            },
        })
    }

    /// Connect via WebSerial.
    pub async fn from_webserial() -> Result<Self, JsValue> {
        let port = requestSerialPort().await?;

        let readable: ReadableStream =
            js_sys::Reflect::get(&port, &"readable".into())?.dyn_into()?;
        let writable: WritableStream =
            js_sys::Reflect::get(&port, &"writable".into())?.dyn_into()?;

        let reader: ReadableStreamDefaultReader = readable.get_reader().dyn_into()?;
        let writer: WritableStreamDefaultWriter = writable.get_writer()?.dyn_into()?;

        Ok(Self {
            connection: Connection::WebSerial { reader, writer },
        })
    }

    /// Read data from the connection.
    pub async fn read(&self) -> Result<Vec<u8>, JsValue> {
        match &self.connection {
            Connection::WebSerial { reader, .. } => {
                let result = JsFuture::from(reader.read()).await?;
                let value = js_sys::Reflect::get(&result, &"value".into())?;
                let data = js_sys::Uint8Array::from(value);
                Ok(data.to_vec())
            }
            Connection::WebSocket { receiver, .. } => {
                let mut rx = receiver
                    .try_lock()
                    .map_err(|e| JsValue::from_str(&format!("Lock failed: {:?}", e)))?;

                if let Some(msg) = rx
                    .try_next()
                    .await
                    .map_err(|e| JsValue::from_str(&format!("Read failed: {:?}", e)))?
                {
                    match msg {
                        Message::Bytes(bytes) => Ok(bytes),
                        _ => Err(JsValue::from_str("Unexpected message type")),
                    }
                } else {
                    Err(JsValue::from_str("WebSocket closed"))
                }
            }
        }
    }

    /// Write data to the connection.
    pub async fn write(&self, packet: &[u8]) -> Result<(), JsValue> {
        match &self.connection {
            Connection::WebSerial { writer, .. } => {
                let chunk = js_sys::Uint8Array::from(packet);
                JsFuture::from(writer.write_with_chunk(&chunk.into())).await?;
                Ok(())
            }
            Connection::WebSocket { sender, .. } => {
                sender
                    .try_lock()
                    .map_err(|e| JsValue::from_str(&format!("Lock failed: {:?}", e)))?
                    .send(Message::Bytes(packet.to_vec()))
                    .await
                    .map_err(|e| JsValue::from_str(&format!("Send failed: {:?}", e)))?;
                Ok(())
            }
        }
    }

    /// Write data and read response.
    pub async fn write_read(&self, packet: &[u8], wait: Option<u32>) -> Result<Vec<u8>, JsValue> {
        self.write(packet).await?;
        sleep(wait.unwrap_or(DEFAULT_WAIT_MS)).await?;
        self.read().await
    }

    /// Release stream locks (for WebSerial cleanup).
    pub fn release_lock(&self) -> Result<(), JsValue> {
        if let Connection::WebSerial { reader, writer, .. } = &self.connection {
            reader.release_lock();
            writer.release_lock();
        }
        Ok(())
    }
}

// ============================================================================
// Motor Configuration
// ============================================================================

#[derive(Deserialize)]
struct Motor {
    branch_position: [f32; 3],
    #[serde(rename = "T_motor_world")]
    T_motor_world: [[f32; 4]; 4],
    solution: f32,
}

/// Motor configuration JSON (loaded at compile time).
/// Contains transformation matrices and branch positions for the parallel kinematics.
const MOTOR_JSON: &str = include_str!("motors.json");
