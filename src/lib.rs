mod kinematics;
use futures_util::StreamExt;
use js_sys::Promise;
use serde::Deserialize;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;
use web_sys::{console, window, ReadableStreamDefaultReader, WritableStreamDefaultWriter};
use web_sys::{SerialOptions, SerialPort};

use crate::kinematics::Kinematics;
// When the `wee_alloc` feature is enabled, this uses `wee_alloc` as the global
// allocator.
//
// If you don't want to use `wee_alloc`, you can safely delete this.
#[cfg(feature = "wee_alloc")]
#[global_allocator]
static ALLOC: wee_alloc::WeeAlloc = wee_alloc::WeeAlloc::INIT;

pub async fn sleep(ms: u32) {
    let promise = Promise::new(&mut |resolve, _| {
        web_sys::window()
            .unwrap()
            .set_timeout_with_callback_and_timeout_and_arguments_0(&resolve, ms as i32)
            .unwrap();
    });
    JsFuture::from(promise).await.unwrap();
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

    Ok(())
}

#[wasm_bindgen]
extern "C" {
    fn alert(s: &str);
    // Import the JS function we created
    #[wasm_bindgen(js_namespace = window, catch)]
    async fn requestSerialPort() -> Result<JsValue, JsValue>;
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
#[wasm_bindgen]
pub async fn test3() {
    let data = String::from_utf8(MOTOR_JSON.to_vec()).unwrap();
    let motors: Vec<Motor> = serde_json::from_str(&data).expect("JSON was not well-formatted");
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

    let wait_time = if web_sys::window()
        .unwrap()
        .navigator()
        .user_agent()
        .unwrap()
        .to_lowercase()
        .contains("android")
    {
        100
    } else {
        25
    };
    // Test inverse kinematics
    let navigator = window().unwrap().navigator();

    let window = web_sys::window().expect("no global `window` exists");
    let document = window.document().expect("should have a document on window");
    let body = document.body().expect("document should have a body");

    let port_js = requestSerialPort()
        .await
        .expect("Failed to get serial port");

    let port = GenericSerialPort::new(port_js);

    // Open with baud rate
    port.open(1_000_000).await.expect("Failed to open port");
    web_sys::console::log_1(&format!("port").into());

    // Now you can read/write
    // Get the readable stream
    let readable = port.readable().unwrap();
    let writable = port.writable().unwrap();
    let reader: ReadableStreamDefaultReader = readable.get_reader().dyn_into().unwrap();
    let writer: WritableStreamDefaultWriter = writable.get_writer().unwrap().dyn_into().unwrap();
    web_sys::console::log_1(&reader);
    // Read data in a loop
    let motors = vec![1, 2, 3, 4, 5, 6]
        .iter()
        .map(|i| document.get_element_by_id(&format!("motor-{i}")).unwrap())
        .collect::<Vec<_>>();
    let pose_x = document.get_element_by_id("pose-x").unwrap();
    let pose_y = document.get_element_by_id("pose-y").unwrap();
    let pose_z = document.get_element_by_id("pose-z").unwrap();
    let pose_roll = document.get_element_by_id("pose-roll").unwrap();
    let pose_pitch = document.get_element_by_id("pose-pitch").unwrap();
    let pose_yaw = document.get_element_by_id("pose-yaw").unwrap();
    web_sys::console::log_1(&"ok".into());

    let mut results = vec![0.0; 6];
    loop {
        // sleep
        JsFuture::from(
            writer.write_with_chunk(&js_sys::Uint8Array::from(&SYNC_READ_POSITION[..]).into()),
        )
        .await
        .unwrap();
        sleep(wait_time).await;
        let result = JsFuture::from(reader.read()).await;
        match result {
            Err(err) => {
                web_sys::console::log_1(
                    &format!("Error reading from serial port: {:?}", err).into(),
                );
            }
            Ok(res) => {
                // Manufacture the element we're gonna append

                // Process the read data here
                let done = js_sys::Reflect::get(&res, &"done".into())
                    .unwrap()
                    .as_bool()
                    .unwrap_or(true);
                let value = js_sys::Reflect::get(&res, &"value".into()).unwrap();
                let data = js_sys::Uint8Array::from(value);
                let bytes = data.to_vec();
                // Parse motor positions
                for motor_id in 0..6 {
                    if let Some((id, pos)) = parse_status_packet(&bytes, motor_id * 15) {
                        results[id as usize - 1] = raw_to_radians(pos);
                        let val = &motors[id as usize - 1];
                        val.set_text_content(Some(
                            (raw_to_radians(pos) * 360. / (2. * std::f64::consts::PI))
                                .round()
                                .to_string()
                                .as_str(),
                        ));
                    } else {
                        web_sys::console::log_1(
                            &format!("Failed to parse packet for motor {}", motor_id + 1).into(),
                        );
                    }
                    if done {
                        break;
                    }
                }
                let mut t = kinematics.forward_kinematics(results.clone(), None);

                // remove head_z_offset
                let x = -t[(0, 3)] * 1000.; // Reverse X axis because don't know
                let y = t[(1, 3)] * 1000.;
                let z = t[(2, 3)] * 1000.; //- HEAD_Z_OFFSET * 1000.;
                pose_x.set_text_content(Some(&format!("{:.2}", x)));
                pose_y.set_text_content(Some(&format!("{:.2}", y)));
                pose_z.set_text_content(Some(&format!("{:.2}", z)));

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

                pose_roll.set_text_content(Some(&format!("{:.2}", roll_deg)));
                pose_pitch.set_text_content(Some(&format!("{:.2}", pitch_deg)));
                pose_yaw.set_text_content(Some(&format!("{:.2}", yaw_deg)));
                sleep(wait_time).await;
            }
        }
    }
}
#[allow(non_snake_case)]
#[derive(Deserialize)]
struct Motor {
    branch_position: Vec<f64>,
    T_motor_world: Vec<Vec<f64>>,
    solution: f64,
}
static MOTOR_JSON: [u8; include_bytes!("motors.json").len()] = *include_bytes!("motors.json");

const HEAD_Z_OFFSET: f64 = 0.177;
const MOTOR_ARM_LENGTH: f64 = 0.04;
const ROD_LENGTH: f64 = 0.085;

// Dynamixel Protocol 2.0 packets
const SYNC_READ_POSITION: [u8; 20] = [
    0xFF, 0xFF, 0xFD, 0x00, // Header
    0xFE, // Broadcast ID
    0x0D, 0x00, // Length = 13
    0x82, // SYNC_READ instruction
    0x84, 0x00, // Address 132 (Present Position)
    0x04, 0x00, // Data length = 4 bytes
    0x01, 0x02, 0x03, 0x04, 0x05, 0x06, // Motor IDs 1-6
    0xB2, 0x9B, // CRC
];

/// Convert raw motor position (0-4095) to radians
/// XL330: 0-4095 maps to 0-360 degrees, center (2048) = 0 radians
fn raw_to_radians(raw: i32) -> f64 {
    ((raw - 2048) as f64 / 4096.0) * 2.0 * std::f64::consts::PI
}

// ============================================================
// DYNAMIXEL PROTOCOL PARSING
// ============================================================

/// Parse a single status packet and return (motor_id, position) if valid
fn parse_status_packet(data: &[u8], offset: usize) -> Option<(u8, i32)> {
    if offset + 15 > data.len() {
        return None;
    }

    // Check header
    if data[offset] != 0xFF
        || data[offset + 1] != 0xFF
        || data[offset + 2] != 0xFD
        || data[offset + 3] != 0x00
    {
        return None;
    }

    let motor_id = data[offset + 4];
    let length = data[offset + 5] as u16 | ((data[offset + 6] as u16) << 8);
    let instruction = data[offset + 7];

    // Status packet has instruction 0x55
    if instruction != 0x55 {
        return None;
    }

    // Check we have enough data (header=4 + id=1 + len=2 + instr=1 + err=1 + data=4 + crc=2 = 15)
    if length != 8 {
        return None;
    }

    let error = data[offset + 8];
    if error != 0 {
        console::log_1(&format!("Motor {} error: {:#04x}", motor_id, error).into());
    }

    // Read position as little-endian i32
    let pos = data[offset + 9] as i32
        | ((data[offset + 10] as i32) << 8)
        | ((data[offset + 11] as i32) << 16)
        | ((data[offset + 12] as i32) << 24);

    Some((motor_id, pos))
}
