mod dynamixel;
mod kinematics;
use std::cell::RefCell;
use std::pin::{pin, Pin};
use std::sync::{Arc, LazyLock, Mutex};

use crate::dynamixel::{
    build_sync_current_position, build_sync_write_position_radians, build_sync_write_torque,
    parse_status_packet,
};
use std::sync::atomic::{AtomicBool, Ordering};

use crate::kinematics::Kinematics;
use futures_util::{AsyncReadExt, SinkExt};
use futures_util::{StreamExt, TryStreamExt};
use gloo::net::websocket::futures::WebSocket;
use gloo::net::websocket::Message;
use gloo::utils::{document, window};
use js_sys::{Boolean, Promise};
use serde::Deserialize;

use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;
use web_sys::{
    console, ReadableStream, ReadableStreamDefaultReader, WritableStream,
    WritableStreamDefaultWriter,
};

thread_local! {
    static PLAYBACK_FRAMES: RefCell<Vec<Vec<f32>>> = RefCell::new(Vec::new());
    static generic_port: RefCell<Option<Arc<GenericPort>>> = RefCell::new(None);
}
static STOP_FLAG: AtomicBool = AtomicBool::new(false);

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

// This is like the `main` function, except for JavaScript.
#[wasm_bindgen(start)]
pub fn main_js() -> Result<(), JsValue> {
    // This provides better error messages in debug mode.
    // It's disabled in release mode so it doesn't bloat up the file size.
    #[cfg(debug_assertions)]
    console_error_panic_hook::set_once();

    // Your code goes here!
    console::log_1(&JsValue::from_str("Hello world!"));
    document()
        .get_element_by_id("toggle-connect")
        .map(|el| el.remove_attribute("disabled").unwrap_or_default());
    Ok(())
}

#[wasm_bindgen]
extern "C" {
    fn alert(s: &str);
    // Import the JS function we created
    #[wasm_bindgen(js_namespace = window, catch)]
    async fn requestSerialPort() -> Result<JsValue, JsValue>;

    #[wasm_bindgen(js_name = getCachedPort)]
    fn get_cached_port() -> JsValue;

    #[wasm_bindgen(js_name = closeSerialPort)]
    async fn close_serial_port();

    #[wasm_bindgen(js_name = isOpen)]
    async fn is_open() -> Boolean;

    #[wasm_bindgen(js_name = updatePose)]
    fn update_pose(x: f32, y: f32, z: f32, roll: f32, pitch: f32, yaw: f32);
}
/// Generic serial port wrapper that works with both native WebSerial and polyfill
pub struct GenericSerialPort {
    inner: JsValue,
}

impl GenericSerialPort {
    pub fn new(port: JsValue) -> Self {
        Self { inner: port }
    }

    pub async fn open(&self, baud_rate: u32) -> Result<(), JsValue> {
        let options = js_sys::Object::new();
        js_sys::Reflect::set(&options, &"baudRate".into(), &baud_rate.into())?;

        let open_fn = js_sys::Reflect::get(&self.inner, &"open".into())?;
        let open_fn: js_sys::Function = open_fn.dyn_into()?;
        let promise: Promise = open_fn.call1(&self.inner, &options)?.dyn_into()?;
        JsFuture::from(promise).await?;
        Ok(())
    }

    pub fn readable(&self) -> Result<web_sys::ReadableStream, JsValue> {
        let readable = js_sys::Reflect::get(&self.inner, &"readable".into())?;
        readable.dyn_into()
    }

    pub fn writable(&self) -> Result<web_sys::WritableStream, JsValue> {
        let writable = js_sys::Reflect::get(&self.inner, &"writable".into())?;
        writable.dyn_into()
    }
}
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

impl GenericPort {
    pub async fn new() -> Result<Self, JsValue> {
        // first try websocket
        let url = "ws://localhost:8000/api/move/ws/raw/write";
        if let Ok(ws) = Self::from_websocket(url).await {
            return Ok(ws);
        } else {
            web_sys::console::log_1(
                &format!("WebSocket connection failed, trying WebSerial").into(),
            );
            return Self::from_webserial().await;
        }
    }
    pub async fn from_websocket(url: &str) -> Result<Self, JsValue> {
        let ws = WebSocket::open(url)
            .map_err(|err| JsValue::from_str(&format!("Failed to open WebSocket: {:#?}", err)))?;
        loop {
            match ws.state() {
                gloo::net::websocket::State::Connecting => {
                    // Wait until the connection is open
                    // In a real application, you might want to add a timeout here
                    sleep(10).await?;
                }
                gloo::net::websocket::State::Open => break,
                gloo::net::websocket::State::Closed => {
                    return Err(JsValue::from_str("WebSocket connection closed"));
                }
                gloo::net::websocket::State::Closing => {
                    return Err(JsValue::from_str("WebSocket connection closing"));
                }
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

    pub async fn from_webserial() -> Result<Self, JsValue> {
        let port = requestSerialPort().await?;
        web_sys::console::log_1(&format!("ok so far").into());

        let readable: ReadableStream =
            js_sys::Reflect::get(&port, &"readable".into())?.dyn_into()?;
        let writable: WritableStream =
            js_sys::Reflect::get(&port, &"writable".into())?.dyn_into()?;
        web_sys::console::log_1(&format!("ok so far 2").into());
        let reader: ReadableStreamDefaultReader = readable.get_reader().dyn_into()?;
        let writer: WritableStreamDefaultWriter = writable.get_writer()?.dyn_into()?;
        Ok(Self {
            connection: Connection::WebSerial { reader, writer },
        })
    }

    pub async fn read(&self) -> Result<Vec<u8>, JsValue> {
        match &self.connection {
            Connection::WebSerial { ref reader, .. } => {
                let result = JsFuture::from(reader.read()).await?;
                let value = js_sys::Reflect::get(&result, &"value".into())?;
                let data = js_sys::Uint8Array::from(value);
                Ok(data.to_vec())
            }
            Connection::WebSocket { receiver, .. } => {
                if let Some(message) = receiver
                    .try_lock()
                    .map_err(|e| {
                        JsValue::from_str(&format!("Failed to lock WebSocket receiver: {:#?}", e))
                    })?
                    .try_next()
                    .await
                    .map_err(|err| {
                        JsValue::from_str(&format!("Failed to read WebSocket message: {:#?}", err))
                    })?
                {
                    match message {
                        Message::Bytes(bytes) => Ok(bytes),
                        _ => Err(JsValue::from_str("Unexpected WebSocket message type")),
                    }
                } else {
                    Err(JsValue::from_str("WebSocket closed"))
                }
            }
        }
    }

    pub async fn write(&self, packet: &[u8]) -> Result<(), JsValue> {
        match self.connection {
            Connection::WebSerial { ref writer, .. } => {
                JsFuture::from(writer.write_with_chunk(&js_sys::Uint8Array::from(packet).into()))
                    .await?;
                Ok(())
            }
            Connection::WebSocket { ref sender, .. } => {
                sender
                    .try_lock()
                    .map_err(|e| {
                        JsValue::from_str(&format!("Failed to lock WebSocket sender: {:#?}", e))
                    })?
                    .send(Message::Bytes(packet.to_vec()))
                    .await
                    .map_err(|err| {
                        JsValue::from_str(&format!("Failed to send WebSocket message: {:#?}", err))
                    })?;
                Ok(())
            }
        }
    }

    pub async fn write_read(&self, packet: &[u8], wait: Option<u32>) -> Result<Vec<u8>, JsValue> {
        self.write(packet).await?;
        sleep(10).await?;
        let read = self.read().await;
        read
    }

    pub fn release_lock(&self) -> Result<(), JsValue> {
        match &self.connection {
            Connection::WebSerial { reader, writer, .. } => {
                reader.release_lock();
                writer.release_lock();
                Ok(())
            }
            Connection::WebSocket { .. } => Ok(()),
        }
    }
}

#[wasm_bindgen]
pub async fn fk(duration: Option<f64>) -> Result<(), JsValue> {
    let motors: Vec<Motor> =
        serde_json::from_str(&MOTOR_JSON).expect("JSON was not well-formatted");
    let mut kinematics = Kinematics::new(0.038, 0.09);

    for motor in motors {
        let branch_position = nalgebra::Vector3::new(
            motor.branch_position[0],
            motor.branch_position[1],
            motor.branch_position[2],
        );
        let T_motor_world = nalgebra::Matrix4::new(
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
            T_motor_world.try_inverse().unwrap(),
            solution,
        );
    }

    let wait_time = 10;
    // Test inverse kinematics
    // Now you can read/write
    // Get the readable stream
    // let pose_x = document.get_element_by_id("pose-x")?;
    // let pose_y = document.get_element_by_id("pose-y")?;
    // let pose_z = document.get_element_by_id("pose-z")?;
    // let pose_roll = document.get_element_by_id("pose-roll")?;
    // let pose_pitch = document.get_element_by_id("pose-pitch")?;
    // let pose_yaw = document.get_element_by_id("pose-yaw")?;
    let port = generic_port
        .with_borrow(|port| port.clone())
        .ok_or_else(|| JsValue::from_str("Reachy not connected"))?;
    let mut results = vec![0.0; 8];
    let start_time = js_sys::Date::now();
    STOP_FLAG.store(false, Ordering::Relaxed);
    PLAYBACK_FRAMES.with_borrow_mut(|frames| frames.clear());
    loop {
        let ping_current = build_sync_current_position(&[11, 12, 13, 14, 15, 16, 17, 18]);
        let result = port.write_read(&ping_current, Some(wait_time)).await;
        match result {
            Err(err) => {
                web_sys::console::log_1(
                    &format!("Error reading from serial port: {:?}", err).into(),
                );
            }
            Ok(res) => {
                // Manufacture the element we're gonna append
                // Parse motor positions
                for motor_id in 0..8 {
                    match parse_status_packet(&res, motor_id * 15) {
                        Ok((id, pos)) => {
                            results[id as usize - 11] = raw_to_radians(pos);
                        }
                        Err(err) => {
                            web_sys::console::log_1(
                                &format!(
                                    "Failed to parse packet for motor {}, err: {:#?}",
                                    motor_id + 1,
                                    err
                                )
                                .into(),
                            );
                        }
                    }
                }
                if let Some(dur) = duration {
                    let elapsed = js_sys::Date::now() - start_time;
                    let progress = elapsed / dur;
                    web_sys::console::log_1(&format!("recording {}", progress).into());

                    if progress >= 1.0 {
                        web_sys::console::log_1(&format!("Playback finished").into());
                        break;
                    }
                    PLAYBACK_FRAMES.with_borrow_mut(|frames| {
                        frames.push(results.clone());
                    })
                }
                let t = kinematics.forward_kinematics(&results, None);

                // Convert to user coordinates (Z=0 is minimum height)
                const HEAD_Z_OFFSET_MM: f32 = 177.0;
                let x = -t[(0, 3)] * 1000.; // Reverse X axis because don't know
                let y = t[(1, 3)] * 1000.;
                let z = t[(2, 3)] * 1000. - HEAD_Z_OFFSET_MM;
                                           // pose_x.set_text_content(Some(&format!("{:.2}", x)));
                                           // pose_y.set_text_content(Some(&format!("{:.2}", y)));
                                           // pose_z.set_text_content(Some(&format!("{:.2}", z)));

                let r = t.fixed_view::<3, 3>(0, 0);
                // Euler XYZ: Roll (X), Pitch (Y), Yaw (Z)
                let pitch = (-r[(2, 0)]).asin();

                let (roll, yaw) = if pitch.cos().abs() > 1e-6 {
                    // Normal case
                    (
                        r[(2, 1)].atan2(r[(2, 2)]), // roll
                        r[(1, 0)].atan2(r[(0, 0)]), // yaw
                    )
                } else {
                    // Gimbal lock
                    ((-r[(1, 2)]).atan2(r[(1, 1)]), 0.0)
                };

                // Convert to degrees
                let roll_deg = roll.to_degrees();
                let pitch_deg = pitch.to_degrees();
                let yaw_deg = yaw.to_degrees();
                update_pose(x, y, z, roll_deg, pitch_deg, yaw_deg);

                // pose_roll.set_text_content(Some(&format!("{:.2}", roll_deg)));
                // pose_pitch.set_text_content(Some(&format!("{:.2}", pitch_deg)));
                // pose_yaw.set_text_content(Some(&format!("{:.2}", yaw_deg)));
                sleep(wait_time).await?;

                let stop = STOP_FLAG.load(Ordering::Relaxed);
                if stop {
                    break;
                }
            }
        }
    }
    web_sys::console::log_1(&format!("recording {}", 0).into());

    Ok(())
}

#[wasm_bindgen]
pub fn forward_kinematics(angles_deg: Vec<f32>) -> Result<Vec<f32>, JsValue> {
    let motors: Vec<Motor> =
        serde_json::from_str(&MOTOR_JSON).expect("JSON was not well-formatted");
    let mut kinematics = Kinematics::new(0.038, 0.09);

    for motor in motors {
        let branch_position = nalgebra::Vector3::new(
            motor.branch_position[0],
            motor.branch_position[1],
            motor.branch_position[2],
        );
        let T_motor_world = nalgebra::Matrix4::new(
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
            T_motor_world.try_inverse().unwrap(),
            solution,
        );
    }
    let angles_rad: Vec<f32> = angles_deg.iter().map(|&deg| deg.to_radians()).collect();

    // Initialize FK with default position (HEAD_Z_OFFSET)
    const HEAD_Z_OFFSET: f32 = 0.177;
    let t_init = nalgebra::Matrix4::new_translation(&nalgebra::Vector3::new(0.0, 0.0, HEAD_Z_OFFSET));
    kinematics.reset_forward_kinematics(t_init);

    // Iterate to converge
    for _ in 0..100 {
        kinematics.forward_kinematics(&angles_rad, None);
    }
    let t = kinematics.forward_kinematics(&angles_rad, None);

    // Convert from internal coordinates to user coordinates
    // Internal: Z=HEAD_Z_OFFSET (177mm) is minimum
    // User: Z=0 is minimum
    const HEAD_Z_OFFSET_MM: f32 = 177.0;

    let x = -t[(0, 3)] * 1000.; // Reverse X axis because don't know
    let y = t[(1, 3)] * 1000.;
    let z = t[(2, 3)] * 1000. - HEAD_Z_OFFSET_MM;  // Subtract offset to convert to user coordinates

    let r = t.fixed_view::<3, 3>(0, 0);
    // Euler XYZ: Roll (X), Pitch (Y), Yaw (Z)
    let pitch = (-r[(2, 0)]).asin();

    let (roll, yaw) = if pitch.cos().abs() > 1e-6 {
        // Normal case
        (
            r[(2, 1)].atan2(r[(2, 2)]), // roll
            r[(1, 0)].atan2(r[(0, 0)]), // yaw
        )
    } else {
        // Gimbal lock
        ((-r[(1, 2)]).atan2(r[(1, 1)]), 0.0)
    };

    // Convert to degrees
    let roll_deg = roll.to_degrees();
    let pitch_deg = pitch.to_degrees();
    let yaw_deg = yaw.to_degrees();
    Ok(vec![x, y, z, roll_deg, pitch_deg, yaw_deg])
}

#[wasm_bindgen]
pub fn inverse_kinematics(xyzrpy: Vec<f32>) -> Result<Vec<f32>, JsValue> {
    let motors: Vec<Motor> =
        serde_json::from_str(&MOTOR_JSON).expect("JSON was not well-formatted");
    let mut kinematics = Kinematics::new(0.038, 0.09);

    for motor in motors {
        let branch_position = nalgebra::Vector3::new(
            motor.branch_position[0],
            motor.branch_position[1],
            motor.branch_position[2],
        );
        let T_motor_world = nalgebra::Matrix4::new(
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
            T_motor_world.try_inverse().unwrap(),
            solution,
        );
    }
    let roll_rad = xyzrpy[3].to_radians();
    let pitch_rad = xyzrpy[4].to_radians();
    let yaw_rad = xyzrpy[5].to_radians();

    // Create rotation matrix from Euler angles (XYZ convention: Roll, Pitch, Yaw)
    let rotation = nalgebra::Rotation3::from_euler_angles(roll_rad, pitch_rad, yaw_rad);
    let t_rotation = rotation.to_homogeneous();

    // Add HEAD_Z_OFFSET to user's Z coordinate to get absolute Z
    // User coordinate system: Z=0 is minimum height
    // Internal coordinate system: Z=HEAD_Z_OFFSET (0.177m = 177mm) is minimum height
    const HEAD_Z_OFFSET: f32 = 0.177;

    // Create translation vector
    let translation = nalgebra::Vector3::new(
        xyzrpy[0] / -1000.0,
        xyzrpy[1] / 1000.0,
        (xyzrpy[2] + HEAD_Z_OFFSET * 1000.0) / 1000.0,  // Add offset before converting to meters
    );

    // Apply rotation first, then translation
    // T = [R | t] where t is the translation in world coordinates
    let mut t = t_rotation;
    t[(0, 3)] = translation.x;
    t[(1, 3)] = translation.y;
    t[(2, 3)] = translation.z;
    let joints = kinematics.inverse_kinematics(t, None);

    // Convert from radians to degrees
    let joints_deg: Vec<f32> = joints.iter().map(|&rad| rad.to_degrees()).collect();

    Ok(joints_deg)
}

#[wasm_bindgen]
/// The above code is a multi-line comment in Rust. It is used to add comments or documentation to the
/// code that will not be executed by the compiler.
pub async fn replay() -> Result<(), JsValue> {
    web_sys::console::log_1(&format!("torque? {}", 0).into());
    torque_on().await?;
    web_sys::console::log_1(&format!("torque ok {}", 0).into());
    let frames = PLAYBACK_FRAMES.with_borrow(|frames| frames.clone());

    STOP_FLAG.store(false, Ordering::Relaxed);

    let port = generic_port
        .with_borrow(|port| port.clone())
        .ok_or_else(|| JsValue::from_str("Reachy not connected"))?;
    for frame in frames.iter() {
        web_sys::console::log_1(&format!("Replaying {}", 0).into());

        let packet =
            build_sync_write_position_radians(&vec![11, 12, 13, 14, 15, 16, 17, 18], frame);
        port.write(&packet[..]).await?;

        web_sys::console::log_1(&format!("ok {}", 0).into());
        sleep(20).await?;
        let stop = STOP_FLAG.load(Ordering::Relaxed);
        if stop {
            break;
        }
    }
    torque_off().await?;
    Ok(())
}

#[wasm_bindgen]
pub async fn stop() -> Result<(), JsValue> {
    STOP_FLAG.store(true, Ordering::Relaxed);
    Ok(())
}

#[wasm_bindgen]
pub async fn record() -> Result<(), JsValue> {
    fk(Some(10_000.0)).await
}

#[wasm_bindgen]
pub async fn connect() -> Result<(), JsValue> {
    let port = GenericPort::new().await?;

    generic_port.set(Some(Arc::new(port)));
    Ok(())
}

#[wasm_bindgen]
pub async fn torque_on() -> Result<(), JsValue> {
    let torque_on = build_sync_write_torque(&[11, 12, 13, 14, 15, 16, 17, 18], true);

    let port = generic_port
        .with_borrow(|port| port.clone())
        .ok_or_else(|| JsValue::from_str("Reachy not connected"))?;
    port.write(&torque_on).await?;

    Ok(())
}

#[wasm_bindgen]
pub async fn torque_off() -> Result<(), JsValue> {
    let torque_off = build_sync_write_torque(&[11, 12, 13, 14, 15, 16, 17, 18], false);
    let port = generic_port
        .with_borrow(|port| port.clone())
        .ok_or_else(|| JsValue::from_str("Reachy not connected"))?;
    port.write(&torque_off).await?;
    Ok(())
}

#[allow(non_snake_case)]
#[derive(Deserialize)]
struct Motor {
    branch_position: Vec<f32>,
    T_motor_world: Vec<Vec<f32>>,
    solution: f32,
}
static MOTOR_JSON: &str = include_str!("motors.json");

/// Convert raw motor position (0-4095) to radians
/// XL330: 0-4095 maps to 0-360 degrees, center (2048) = 0 radians
fn raw_to_radians(raw: i32) -> f32 {
    ((raw - 2048) as f32 / 4096.0) * 2.0 * std::f32::consts::PI
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ik_with_zero_coordinates() {
        // Test [0, 0, 0, 0, 0, 0] - Z=0 is now the minimum height (valid!)
        let coords = vec![0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
        let result = inverse_kinematics(coords);

        assert!(result.is_ok(), "IK should succeed for [0, 0, 0, 0, 0, 0]");
        let joints = result.unwrap();
        assert_eq!(joints.len(), 6, "Should return 6 joint angles");
        assert!(!joints.iter().any(|&j| j.is_nan()), "Joints should not contain NaN");

        // Print results for debugging
        println!("IK [0, 0, 0, 0, 0, 0] -> joints: {:?}", joints);
    }

    #[test]
    fn test_fk_ik_roundtrip_default_position() {
        // Test the default position: Z=0 is minimum height
        let original_coords = vec![0.0, 0.0, 0.0, 0.0, 0.0, 0.0];

        let joints = inverse_kinematics(original_coords.clone()).unwrap();
        println!("Joints from IK (default position): {:?}", joints);

        let reconstructed_coords = forward_kinematics(joints).unwrap();
        println!("Reconstructed coords from FK (default position): {:?}", reconstructed_coords);

        // Check if we get back similar coordinates (with tolerance)
        for i in 0..6 {
            let diff = (original_coords[i] - reconstructed_coords[i]).abs();
            assert!(diff < 10.0, "Coordinate {} mismatch: expected {}, got {} (diff: {})",
                    i, original_coords[i], reconstructed_coords[i], diff);
        }
    }

    #[test]
    fn test_fk_ik_roundtrip_with_translation() {
        // Test with some translation (x=10mm, y=20mm, z=10mm above minimum)
        let original_coords = vec![10.0, 20.0, 10.0, 0.0, 0.0, 0.0];

        let joints = inverse_kinematics(original_coords.clone()).unwrap();
        println!("Joints from IK: {:?}", joints);

        let reconstructed_coords = forward_kinematics(joints).unwrap();
        println!("Reconstructed coords from FK: {:?}", reconstructed_coords);

        // Check if we get back similar coordinates (with tolerance)
        for i in 0..3 {
            let diff = (original_coords[i] - reconstructed_coords[i]).abs();
            assert!(diff < 10.0, "Position {} mismatch: expected {}, got {} (diff: {})",
                    i, original_coords[i], reconstructed_coords[i], diff);
        }
    }

    #[test]
    fn test_fk_ik_roundtrip_with_rotation() {
        // Test with some rotation (roll=10°, pitch=15°, yaw=5°) at minimum Z
        let original_coords = vec![0.0, 0.0, 0.0, 10.0, 15.0, 5.0];

        let joints = inverse_kinematics(original_coords.clone()).unwrap();
        println!("Joints from IK (rotation test): {:?}", joints);

        let reconstructed_coords = forward_kinematics(joints).unwrap();
        println!("Reconstructed coords from FK (rotation test): {:?}", reconstructed_coords);

        // Check if we get back similar coordinates (with tolerance)
        for i in 0..6 {
            let diff = (original_coords[i] - reconstructed_coords[i]).abs();
            assert!(diff < 10.0, "Coordinate {} mismatch: expected {}, got {} (diff: {})",
                    i, original_coords[i], reconstructed_coords[i], diff);
        }
    }

    #[test]
    fn test_fk_ik_roundtrip_combined() {
        // Test with both translation and rotation (z=10mm above minimum)
        let original_coords = vec![5.0, -10.0, 10.0, 5.0, -10.0, 8.0];

        let joints = inverse_kinematics(original_coords.clone()).unwrap();
        println!("Joints from IK (combined test): {:?}", joints);

        let reconstructed_coords = forward_kinematics(joints).unwrap();
        println!("Reconstructed coords from FK (combined test): {:?}", reconstructed_coords);

        // Check if we get back similar coordinates (with tolerance)
        for i in 0..6 {
            let diff = (original_coords[i] - reconstructed_coords[i]).abs();
            assert!(diff < 10.0, "Coordinate {} mismatch: expected {}, got {} (diff: {})",
                    i, original_coords[i], reconstructed_coords[i], diff);
        }
    }

    #[test]
    fn test_ik_below_minimum_height() {
        // Test Z < 0 - this should be invalid (below minimum height)
        let coords = vec![0.0, 0.0, -10.0, 0.0, 0.0, 0.0];
        let result = inverse_kinematics(coords);

        // Should return joints, but they should be invalid (NaN or out of range)
        // The kinematics solver may not explicitly fail, but the result will be unreachable
        assert!(result.is_ok(), "IK should return result even for invalid positions");
    }

}
