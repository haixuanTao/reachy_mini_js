use wasm_bindgen_test::{wasm_bindgen_test, wasm_bindgen_test_configure};

wasm_bindgen_test_configure!(run_in_browser);

// This runs a unit test in native Rust, so it can only use Rust APIs.
#[test]
fn rust_test() {
    assert_eq!(1, 1);
}

// This runs a unit test in the browser, so it can use browser APIs.
#[wasm_bindgen_test]
fn web_test() {
    assert_eq!(1, 1);
}

// ============================================================================
// Dynamixel Protocol Tests
// ============================================================================

use reachy_mini::dynamixel::{
    address, build_read_packet, build_reboot_packet, build_sync_current_position,
    build_sync_read_hardware_error, build_sync_read_load, build_sync_read_temperature,
    build_sync_write_position, build_sync_write_position_radians, build_sync_write_torque,
    parse_1byte_packets, parse_1byte_packets_with_errors, parse_2byte_signed_packets,
    parse_position_packets, parse_status_packet, radians_to_raw, raw_to_radians, BROADCAST_ID,
};
use reachy_mini::kinematics::Kinematics;
use nalgebra::{Matrix4, Rotation3, Vector3};

// Motor configuration (same as src/motors.json)
const MOTOR_CONFIG: &str = r#"[
  {"branch_position": [0.0299, 0.025, -0.0012], "T_motor_world": [[0.866025, -0.500001, 0.0, -0.01025], [0.0, 0.0, 1.0, -0.07095], [-0.500001, -0.866025, 0.0, 0.03491], [0, 0, 0, 1]], "solution": 0},
  {"branch_position": [0.0187, 0.0315, -0.0012], "T_motor_world": [[-0.866028, 0.499995, 0.0, -0.01025], [0.0, 0.0, -1.0, 0.07095], [-0.499995, -0.866028, 0.0, 0.03491], [0, 0, 0, 1]], "solution": 1},
  {"branch_position": [-0.0246, 0.0065, -0.0012], "T_motor_world": [[0.0, 1.0, 0.0, -0.01025], [0.0, 0.0, 1.0, -0.07095], [1.0, 0.0, 0.0, 0.03491], [0, 0, 0, 1]], "solution": 0},
  {"branch_position": [-0.0246, -0.0065, -0.0012], "T_motor_world": [[0.0, -1.0, 0.0, -0.01025], [0.0, 0.0, -1.0, 0.07095], [1.0, 0.0, 0.0, 0.03491], [0, 0, 0, 1]], "solution": 1},
  {"branch_position": [0.0187, -0.0315, -0.0012], "T_motor_world": [[-0.866021, -0.500007, 0.0, -0.01025], [0.0, 0.0, 1.0, -0.07095], [-0.500007, 0.866021, 0.0, 0.03491], [0, 0, 0, 1]], "solution": 0},
  {"branch_position": [0.0299, -0.025, -0.0012], "T_motor_world": [[0.866025, 0.500001, 0.0, -0.01025], [0.0, 0.0, -1.0, 0.07095], [-0.500001, 0.866025, 0.0, 0.03491], [0, 0, 0, 1]], "solution": 1}
]"#;

const HEAD_Z_OFFSET_M: f32 = 0.172;

#[derive(serde::Deserialize)]
struct MotorConfig {
    branch_position: [f32; 3],
    #[serde(rename = "T_motor_world")]
    t_motor_world: [[f32; 4]; 4],
    solution: f32,
}

/// Create kinematics solver configured for the robot
fn create_test_kinematics() -> Kinematics {
    let motors: Vec<MotorConfig> = serde_json::from_str(MOTOR_CONFIG).expect("Failed to parse motor config");
    let mut kinematics = Kinematics::new(0.038, 0.09);

    for motor in motors {
        let branch_position = Vector3::new(
            motor.branch_position[0],
            motor.branch_position[1],
            motor.branch_position[2],
        );

        let t = motor.t_motor_world;
        let t_motor_world = Matrix4::new(
            t[0][0], t[0][1], t[0][2], t[0][3],
            t[1][0], t[1][1], t[1][2], t[1][3],
            t[2][0], t[2][1], t[2][2], t[2][3],
            t[3][0], t[3][1], t[3][2], t[3][3],
        );

        let solution = if motor.solution != 0.0 { 1.0 } else { -1.0 };
        kinematics.add_branch(branch_position, t_motor_world.try_inverse().unwrap(), solution);
    }

    kinematics
}

/// Compute joint angles for a given Cartesian pose using inverse kinematics
fn compute_joint_angles(x_mm: f32, y_mm: f32, z_mm: f32, roll_deg: f32, pitch_deg: f32, yaw_deg: f32) -> Vec<f32> {
    let mut kinematics = create_test_kinematics();

    // Build transformation matrix
    let rotation = Rotation3::from_euler_angles(
        roll_deg.to_radians(),
        pitch_deg.to_radians(),
        yaw_deg.to_radians(),
    );
    let mut t = rotation.to_homogeneous();

    // Apply translation (convert mm to m, add Z offset)
    t[(0, 3)] = x_mm / 1000.0;
    t[(1, 3)] = y_mm / 1000.0;
    t[(2, 3)] = (z_mm / 1000.0) + HEAD_Z_OFFSET_M;

    // Compute inverse kinematics
    kinematics.inverse_kinematics(t, None)
}

/// Verify packet header structure (FF FF FD 00)
fn assert_valid_header(packet: &[u8], expected_id: u8) {
    assert!(packet.len() >= 7, "Packet too short");
    assert_eq!(packet[0], 0xFF, "Header byte 0");
    assert_eq!(packet[1], 0xFF, "Header byte 1");
    assert_eq!(packet[2], 0xFD, "Header byte 2");
    assert_eq!(packet[3], 0x00, "Header byte 3");
    assert_eq!(packet[4], expected_id, "Motor ID");
}

// ----------------------------------------------------------------------------
// Packet Building Tests
// ----------------------------------------------------------------------------

#[test]
fn test_build_read_packet_structure() {
    let motor_id = 11;
    let addr = address::PRESENT_TEMPERATURE;
    let length = 1;

    let packet = build_read_packet(motor_id, addr, length);

    // READ packet: header(4) + id(1) + len(2) + instr(1) + addr(2) + data_len(2) + crc(2) = 14
    assert_eq!(packet.len(), 14, "READ packet should be 14 bytes");
    assert_valid_header(&packet, motor_id);

    // Instruction should be READ (0x02)
    assert_eq!(packet[7], 0x02, "Instruction should be READ");

    // Address (little-endian)
    assert_eq!(packet[8], (addr & 0xFF) as u8, "Address low byte");
    assert_eq!(packet[9], (addr >> 8) as u8, "Address high byte");

    // Data length (little-endian)
    assert_eq!(packet[10], (length & 0xFF) as u8, "Length low byte");
    assert_eq!(packet[11], (length >> 8) as u8, "Length high byte");
}

#[test]
fn test_build_read_packet_different_addresses() {
    // Test PRESENT_POSITION (4 bytes)
    let packet = build_read_packet(12, address::PRESENT_POSITION, 4);
    assert_eq!(packet[8], 132); // 132 = 0x84
    assert_eq!(packet[9], 0);
    assert_eq!(packet[10], 4); // 4 bytes
    assert_eq!(packet[11], 0);

    // Test PRESENT_LOAD (2 bytes)
    let packet = build_read_packet(13, address::PRESENT_LOAD, 2);
    assert_eq!(packet[8], 126); // 126 = 0x7E
    assert_eq!(packet[9], 0);
    assert_eq!(packet[10], 2); // 2 bytes
    assert_eq!(packet[11], 0);
}

#[test]
fn test_build_reboot_packet_structure() {
    let motor_id = 17;
    let packet = build_reboot_packet(motor_id);

    // REBOOT packet: header(4) + id(1) + len(2) + instr(1) + crc(2) = 10
    assert_eq!(packet.len(), 10, "REBOOT packet should be 10 bytes");
    assert_valid_header(&packet, motor_id);

    // Instruction should be REBOOT (0x08)
    assert_eq!(packet[7], 0x08, "Instruction should be REBOOT");
}

#[test]
fn test_build_sync_current_position() {
    let motor_ids = [11, 12, 13, 14, 15, 16];
    let packet = build_sync_current_position(&motor_ids);

    assert_valid_header(&packet, BROADCAST_ID);

    // Instruction should be SYNC_READ (0x82)
    assert_eq!(packet[7], 0x82, "Instruction should be SYNC_READ");

    // Address should be PRESENT_POSITION (132)
    assert_eq!(packet[8], 132);
    assert_eq!(packet[9], 0);

    // Data length should be 4 bytes
    assert_eq!(packet[10], 4);
    assert_eq!(packet[11], 0);

    // Motor IDs should follow
    for (i, &id) in motor_ids.iter().enumerate() {
        assert_eq!(packet[12 + i], id, "Motor ID at index {}", i);
    }
}

#[test]
fn test_build_sync_write_torque_enable() {
    let motor_ids = [11, 12, 13];
    let packet = build_sync_write_torque(&motor_ids, true);

    assert_valid_header(&packet, BROADCAST_ID);

    // Instruction should be SYNC_WRITE (0x83)
    assert_eq!(packet[7], 0x83, "Instruction should be SYNC_WRITE");

    // Address should be TORQUE_ENABLE (64)
    assert_eq!(packet[8], 64);
    assert_eq!(packet[9], 0);

    // Data length should be 1 byte
    assert_eq!(packet[10], 1);
    assert_eq!(packet[11], 0);

    // Each motor should have id + value(1)
    assert_eq!(packet[12], 11); // Motor 11
    assert_eq!(packet[13], 1); // Enable = 1
    assert_eq!(packet[14], 12); // Motor 12
    assert_eq!(packet[15], 1); // Enable = 1
    assert_eq!(packet[16], 13); // Motor 13
    assert_eq!(packet[17], 1); // Enable = 1
}

#[test]
fn test_build_sync_write_torque_disable() {
    let motor_ids = [17, 18];
    let packet = build_sync_write_torque(&motor_ids, false);

    // Torque disable value should be 0
    assert_eq!(packet[13], 0); // First motor value
    assert_eq!(packet[15], 0); // Second motor value
}

#[test]
fn test_build_sync_write_position() {
    let motor_ids = [11, 12];
    let positions = [2048i32, 3000i32]; // Center and offset positions

    let packet = build_sync_write_position(&motor_ids, &positions);

    assert_valid_header(&packet, BROADCAST_ID);

    // Instruction should be SYNC_WRITE (0x83)
    assert_eq!(packet[7], 0x83);

    // Address should be GOAL_POSITION (116)
    assert_eq!(packet[8], 116);
    assert_eq!(packet[9], 0);

    // Data length should be 4 bytes
    assert_eq!(packet[10], 4);
    assert_eq!(packet[11], 0);

    // Motor 11 with position 2048 (0x00000800)
    assert_eq!(packet[12], 11);
    assert_eq!(packet[13], 0x00); // 2048 & 0xFF
    assert_eq!(packet[14], 0x08); // (2048 >> 8) & 0xFF
    assert_eq!(packet[15], 0x00);
    assert_eq!(packet[16], 0x00);

    // Motor 12 with position 3000 (0x00000BB8)
    assert_eq!(packet[17], 12);
    assert_eq!(packet[18], 0xB8); // 3000 & 0xFF
    assert_eq!(packet[19], 0x0B); // (3000 >> 8) & 0xFF
    assert_eq!(packet[20], 0x00);
    assert_eq!(packet[21], 0x00);
}

#[test]
fn test_build_sync_write_position_radians() {
    let motor_ids = [11];
    let radians = [0.0f32]; // 0 radians should be center position (2048)

    let packet = build_sync_write_position_radians(&motor_ids, &radians);

    // Position for 0 radians should be 2048
    assert_eq!(packet[12], 11); // Motor ID
    assert_eq!(packet[13], 0x00); // 2048 low byte
    assert_eq!(packet[14], 0x08); // 2048 high byte
}

#[test]
fn test_build_sync_read_temperature() {
    let motor_ids = [11, 12, 13, 14, 15, 16, 17, 18];
    let packet = build_sync_read_temperature(&motor_ids);

    assert_valid_header(&packet, BROADCAST_ID);
    assert_eq!(packet[7], 0x82); // SYNC_READ

    // Address should be PRESENT_TEMPERATURE (146)
    assert_eq!(packet[8], 146);
    assert_eq!(packet[9], 0);

    // Data length should be 1 byte
    assert_eq!(packet[10], 1);
    assert_eq!(packet[11], 0);
}

#[test]
fn test_build_sync_read_load() {
    let motor_ids = [11, 12];
    let packet = build_sync_read_load(&motor_ids);

    assert_valid_header(&packet, BROADCAST_ID);

    // Address should be PRESENT_LOAD (126)
    assert_eq!(packet[8], 126);
    assert_eq!(packet[9], 0);

    // Data length should be 2 bytes
    assert_eq!(packet[10], 2);
    assert_eq!(packet[11], 0);
}

#[test]
fn test_build_sync_read_hardware_error() {
    let motor_ids = [11];
    let packet = build_sync_read_hardware_error(&motor_ids);

    assert_valid_header(&packet, BROADCAST_ID);

    // Address should be HARDWARE_ERROR_STATUS (70)
    assert_eq!(packet[8], 70);
    assert_eq!(packet[9], 0);

    // Data length should be 1 byte
    assert_eq!(packet[10], 1);
    assert_eq!(packet[11], 0);
}

// ----------------------------------------------------------------------------
// Conversion Tests
// ----------------------------------------------------------------------------

#[test]
fn test_radians_to_raw_center() {
    // 0 radians should be center position (2048)
    assert_eq!(radians_to_raw(0.0), 2048);
}

#[test]
fn test_radians_to_raw_pi() {
    // PI radians should be approximately 2048 + 2048 = 4096
    let raw = radians_to_raw(std::f32::consts::PI);
    // Allow some floating point tolerance
    assert!((raw - 4096).abs() <= 1, "PI radians should be ~4096, got {}", raw);
}

#[test]
fn test_radians_to_raw_negative_pi() {
    // -PI radians should be approximately 2048 - 2048 = 0
    let raw = radians_to_raw(-std::f32::consts::PI);
    assert!((raw - 0).abs() <= 1, "-PI radians should be ~0, got {}", raw);
}

#[test]
fn test_radians_to_raw_half_pi() {
    // PI/2 radians should be 2048 + 1024 = 3072
    let raw = radians_to_raw(std::f32::consts::PI / 2.0);
    assert!((raw - 3072).abs() <= 1, "PI/2 radians should be ~3072, got {}", raw);
}

#[test]
fn test_raw_to_radians_center() {
    // 2048 should be 0 radians
    let rad = raw_to_radians(2048);
    assert!(rad.abs() < 0.001, "2048 should be ~0 radians, got {}", rad);
}

#[test]
fn test_raw_to_radians_roundtrip() {
    // Test round-trip conversion
    let original_rad = std::f32::consts::PI / 4.0; // 45 degrees
    let raw = radians_to_raw(original_rad);
    let back = raw_to_radians(raw);

    assert!(
        (back - original_rad).abs() < 0.01,
        "Round-trip failed: {} -> {} -> {}",
        original_rad,
        raw,
        back
    );
}

#[test]
fn test_radians_conversion_symmetry() {
    // Test multiple angles for symmetry
    let test_angles = [0.0, 0.5, 1.0, -0.5, -1.0, std::f32::consts::PI / 3.0];

    for &angle in &test_angles {
        let raw = radians_to_raw(angle);
        let back = raw_to_radians(raw);
        assert!(
            (back - angle).abs() < 0.01,
            "Symmetry failed for angle {}: {} != {}",
            angle,
            angle,
            back
        );
    }
}

// ----------------------------------------------------------------------------
// Packet Parsing Tests
// ----------------------------------------------------------------------------

#[test]
fn test_parse_position_packets_single() {
    // Simulated status packet for position read
    // Header(4) + ID(1) + Length(2) + Instruction(1) + Error(1) + Data(4) + CRC(2) = 15 bytes
    let packet = vec![
        0xFF, 0xFF, 0xFD, 0x00, // Header
        11,                     // Motor ID
        0x08, 0x00,             // Length (8 = 1 + 1 + 4 + 2)
        0x55,                   // STATUS instruction
        0x00,                   // Error (no error)
        0x00, 0x08, 0x00, 0x00, // Position = 2048 (little-endian)
        0x00, 0x00,             // CRC (placeholder)
    ];

    let results = parse_position_packets(&packet);

    assert_eq!(results.len(), 1, "Should parse one packet");
    assert_eq!(results[0].0, 11, "Motor ID should be 11");
    assert_eq!(results[0].1, 2048, "Position should be 2048");
}

#[test]
fn test_parse_position_packets_multiple() {
    // Two position status packets concatenated
    let packet = vec![
        // First packet - Motor 11, Position 2048
        0xFF, 0xFF, 0xFD, 0x00, 11, 0x08, 0x00, 0x55, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00,
        // Second packet - Motor 12, Position 3000 (0x0BB8)
        0xFF, 0xFF, 0xFD, 0x00, 12, 0x08, 0x00, 0x55, 0x00, 0xB8, 0x0B, 0x00, 0x00, 0x00, 0x00,
    ];

    let results = parse_position_packets(&packet);

    assert_eq!(results.len(), 2, "Should parse two packets");
    assert_eq!(results[0].0, 11);
    assert_eq!(results[0].1, 2048);
    assert_eq!(results[1].0, 12);
    assert_eq!(results[1].1, 3000);
}

#[test]
fn test_parse_position_packets_with_garbage() {
    // Packet with some garbage bytes before a valid packet
    let packet = vec![
        0x00, 0x00, 0x00,       // Garbage
        0xFF, 0xFF, 0xFD, 0x00, // Valid header
        13,                     // Motor ID
        0x08, 0x00,             // Length
        0x55,                   // STATUS
        0x00,                   // Error
        0x00, 0x10, 0x00, 0x00, // Position = 4096
        0x00, 0x00,             // CRC
    ];

    let results = parse_position_packets(&packet);

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].0, 13);
    assert_eq!(results[0].1, 4096);
}

#[test]
fn test_parse_1byte_packets() {
    // Temperature status packet
    // Length = 5 for 1-byte data (instr + err + data + crc)
    let packet = vec![
        0xFF, 0xFF, 0xFD, 0x00, // Header
        14,                     // Motor ID
        0x05, 0x00,             // Length (5)
        0x55,                   // STATUS
        0x00,                   // Error (no error)
        42,                     // Temperature = 42°C
        0x00, 0x00,             // CRC
    ];

    let results = parse_1byte_packets(&packet);

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].0, 14, "Motor ID");
    assert_eq!(results[0].1, 42, "Temperature");
}

#[test]
fn test_parse_1byte_packets_with_error_skipped() {
    // Packet with motor error - should be skipped by parse_1byte_packets
    let packet = vec![
        0xFF, 0xFF, 0xFD, 0x00, 15, 0x05, 0x00, 0x55, 0x04, // Error = 0x04 (overheating)
        50, 0x00, 0x00,
    ];

    let results = parse_1byte_packets(&packet);
    assert_eq!(results.len(), 0, "Error packets should be skipped");
}

#[test]
fn test_parse_1byte_packets_with_errors_included() {
    // Same packet but using parse_1byte_packets_with_errors
    let packet = vec![
        0xFF, 0xFF, 0xFD, 0x00, 15, 0x05, 0x00, 0x55, 0x04, // Error = 0x04
        50, 0x00, 0x00,
    ];

    let results = parse_1byte_packets_with_errors(&packet);
    assert_eq!(results.len(), 1, "Error packets should be included");
    assert_eq!(results[0].0, 15);
    assert_eq!(results[0].1, 50);
}

#[test]
fn test_parse_2byte_signed_packets() {
    // Load status packet
    // Length = 6 for 2-byte data
    let packet = vec![
        0xFF, 0xFF, 0xFD, 0x00, // Header
        16,                     // Motor ID
        0x06, 0x00,             // Length (6)
        0x55,                   // STATUS
        0x00,                   // Error
        0x64, 0x00,             // Load = 100 (little-endian)
        0x00, 0x00,             // CRC
    ];

    let results = parse_2byte_signed_packets(&packet);

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].0, 16);
    assert_eq!(results[0].1, 100);
}

#[test]
fn test_parse_2byte_signed_packets_negative() {
    // Negative load value (-100 = 0xFF9C)
    let packet = vec![
        0xFF, 0xFF, 0xFD, 0x00, 17, 0x06, 0x00, 0x55, 0x00, 0x9C, 0xFF, // -100 little-endian
        0x00, 0x00,
    ];

    let results = parse_2byte_signed_packets(&packet);

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].0, 17);
    assert_eq!(results[0].1, -100);
}

#[test]
fn test_parse_status_packet() {
    // Position status packet at offset 0
    let packet = vec![
        0xFF, 0xFF, 0xFD, 0x00, 18, 0x08, 0x00, 0x55, 0x00, 0x00, 0x0C, 0x00, 0x00, // Pos = 3072
        0x00, 0x00,
    ];

    let result = parse_status_packet(&packet, 0);
    assert!(result.is_ok());

    let (id, pos) = result.unwrap();
    assert_eq!(id, 18);
    assert_eq!(pos, 3072);
}

// ----------------------------------------------------------------------------
// Edge Cases and Error Handling
// ----------------------------------------------------------------------------

#[test]
fn test_parse_empty_buffer() {
    let results = parse_position_packets(&[]);
    assert!(results.is_empty());
}

#[test]
fn test_parse_truncated_packet() {
    // Packet that starts valid but is truncated
    let packet = vec![0xFF, 0xFF, 0xFD, 0x00, 11, 0x08, 0x00, 0x55];

    let results = parse_position_packets(&packet);
    assert!(results.is_empty(), "Truncated packet should not parse");
}

#[test]
fn test_parse_wrong_instruction() {
    // Packet with wrong instruction (not STATUS)
    let packet = vec![
        0xFF, 0xFF, 0xFD, 0x00, 11, 0x08, 0x00, 0x02, // READ instead of STATUS
        0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00,
    ];

    let results = parse_position_packets(&packet);
    assert!(results.is_empty(), "Wrong instruction should not parse");
}

#[test]
fn test_broadcast_id_constant() {
    assert_eq!(BROADCAST_ID, 0xFE);
}

#[test]
fn test_address_constants() {
    assert_eq!(address::TORQUE_ENABLE, 64);
    assert_eq!(address::HARDWARE_ERROR_STATUS, 70);
    assert_eq!(address::GOAL_POSITION, 116);
    assert_eq!(address::PRESENT_LOAD, 126);
    assert_eq!(address::PRESENT_POSITION, 132);
    assert_eq!(address::PRESENT_TEMPERATURE, 146);
}

// ============================================================================
// WebSocket Integration Tests
// ============================================================================
//
// These tests require a running Reachy Mini server at ws://127.0.0.1:8000
// Run with: cargo test --test app websocket -- --ignored

use std::net::TcpStream;
use tungstenite::{connect, Message};

const WS_URL: &str = "ws://127.0.0.1:8000/api/move/ws/raw/write";
const HEAD_MOTOR_IDS: [u8; 6] = [11, 12, 13, 14, 15, 16];
const ALL_MOTOR_IDS: [u8; 8] = [11, 12, 13, 14, 15, 16, 17, 18];

/// Helper to check if WebSocket server is available
fn is_server_available() -> bool {
    TcpStream::connect("127.0.0.1:8000").is_ok()
}

#[test]
#[ignore] // Run with: cargo test --test app websocket_write_read -- --ignored
fn test_websocket_write_and_read_positions() {
    if !is_server_available() {
        eprintln!("Skipping test: WebSocket server not available at 127.0.0.1:8000");
        return;
    }

    // Connect to WebSocket
    let (mut socket, _response) = connect(WS_URL).expect("Failed to connect to WebSocket");
    println!("Connected to WebSocket server");

    // Set socket to non-blocking for reads with timeout
    if let tungstenite::stream::MaybeTlsStream::Plain(ref stream) = socket.get_ref() {
        stream
            .set_read_timeout(Some(std::time::Duration::from_millis(200)))
            .ok();
        stream.set_nonblocking(false).ok();
    }

    // Step 1: Enable torque on all motors
    let torque_packet = build_sync_write_torque(&ALL_MOTOR_IDS, true);
    socket
        .send(Message::Binary(torque_packet))
        .expect("Failed to send torque enable");
    println!("Sent torque enable command");

    std::thread::sleep(std::time::Duration::from_millis(100));

    // Step 2: Write positions to 0 radians (center = 2048) for head motors
    let target_radians = [0.0f32; 6];
    let write_packet = build_sync_write_position_radians(&HEAD_MOTOR_IDS.to_vec(), &target_radians);
    socket
        .send(Message::Binary(write_packet))
        .expect("Failed to send position write");
    println!("Sent position write command (all zeros)");

    // Wait for motors to move
    std::thread::sleep(std::time::Duration::from_millis(500));

    // Step 3: Read current positions
    let read_packet = build_sync_current_position(&HEAD_MOTOR_IDS);
    socket
        .send(Message::Binary(read_packet))
        .expect("Failed to send position read");
    println!("Sent position read command");

    // Step 4: Try to receive response with retries
    let mut all_data = Vec::new();
    let mut attempts = 0;
    let max_attempts = 20;

    while attempts < max_attempts {
        match socket.read() {
            Ok(Message::Binary(data)) => {
                println!("Received {} bytes (attempt {})", data.len(), attempts + 1);
                if !data.is_empty() {
                    all_data.extend_from_slice(&data);
                    // Check if we have enough data
                    let positions = parse_position_packets(&all_data);
                    if !positions.is_empty() {
                        println!("Parsed {} position packets", positions.len());

                        // Print all positions
                        for (motor_id, raw_pos) in &positions {
                            let radians = raw_to_radians(*raw_pos);
                            println!(
                                "Motor {}: raw={}, radians={:.3}, degrees={:.1}",
                                motor_id,
                                raw_pos,
                                radians,
                                radians.to_degrees()
                            );
                        }

                        // Verify we got position data for our motors (values are reasonable)
                        for (motor_id, raw_pos) in &positions {
                            // Position should be within valid range (0-4095)
                            assert!(
                                *raw_pos >= 0 && *raw_pos <= 4095,
                                "Motor {} position {} is out of valid range",
                                motor_id,
                                raw_pos
                            );
                        }

                        // Step 5: Disable torque
                        let torque_off = build_sync_write_torque(&ALL_MOTOR_IDS, false);
                        socket
                            .send(Message::Binary(torque_off))
                            .expect("Failed to send torque disable");
                        println!("Sent torque disable command");

                        socket.close(None).ok();
                        println!("Test passed!");
                        return;
                    }
                }
            }
            Ok(msg) => {
                println!("Received non-binary message: {:?}", msg);
            }
            Err(e) => {
                let err_str = e.to_string();
                // On timeout or WouldBlock, continue trying
                if err_str.contains("timed out")
                    || err_str.contains("WouldBlock")
                    || err_str.contains("Resource temporarily unavailable")
                {
                    println!("Waiting for data (attempt {})...", attempts + 1);
                    std::thread::sleep(std::time::Duration::from_millis(200));
                } else {
                    println!("Read error (attempt {}): {:?}", attempts + 1, e);
                    break;
                }
            }
        }
        attempts += 1;
    }

    // If we got here without returning, check what we accumulated
    if !all_data.is_empty() {
        println!("Total data accumulated: {} bytes", all_data.len());
        println!("Raw data: {:02X?}", &all_data[..std::cmp::min(50, all_data.len())]);
    }

    // Disable torque before failing
    let torque_off = build_sync_write_torque(&ALL_MOTOR_IDS, false);
    socket.send(Message::Binary(torque_off)).ok();
    socket.close(None).ok();

    panic!(
        "Failed to receive valid position data after {} attempts. Accumulated {} bytes.",
        max_attempts,
        all_data.len()
    );
}

#[test]
#[ignore] // Run with: cargo test --test app websocket_read_temperature -- --ignored
fn test_websocket_read_temperature() {
    if !is_server_available() {
        eprintln!("Skipping test: WebSocket server not available at 127.0.0.1:8000");
        return;
    }

    let (mut socket, _) = connect(WS_URL).expect("Failed to connect");

    // Set read timeout
    if let tungstenite::stream::MaybeTlsStream::Plain(ref stream) = socket.get_ref() {
        stream
            .set_read_timeout(Some(std::time::Duration::from_millis(200)))
            .ok();
    }

    // Read temperature from all motors
    let packet = build_sync_read_temperature(&ALL_MOTOR_IDS);
    socket
        .send(Message::Binary(packet))
        .expect("Failed to send temperature read");

    // Try to receive response with retries
    let mut attempts = 0;
    let max_attempts = 15;

    while attempts < max_attempts {
        match socket.read() {
            Ok(Message::Binary(data)) => {
                if !data.is_empty() {
                    println!("Received {} bytes: {:02X?}", data.len(), &data[..std::cmp::min(30, data.len())]);
                    // Use _with_errors since motors might have status flags set
                    let temps = parse_1byte_packets_with_errors(&data);
                    println!("Parsed {} temperature packets", temps.len());

                    if !temps.is_empty() {
                        for (motor_id, temp) in &temps {
                            println!("Motor {}: {}°C", motor_id, temp);
                            // Temperature should be reasonable (15-80°C)
                            assert!(
                                *temp >= 15 && *temp <= 80,
                                "Motor {} temperature {} is out of range",
                                motor_id,
                                temp
                            );
                        }
                        socket.close(None).ok();
                        println!("Temperature test passed!");
                        return;
                    }
                }
            }
            Ok(_) => {}
            Err(e) => {
                let err_str = e.to_string();
                if err_str.contains("WouldBlock") || err_str.contains("Resource temporarily") {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                } else {
                    println!("Read error: {:?}", e);
                    break;
                }
            }
        }
        attempts += 1;
    }

    socket.close(None).ok();
    panic!("Failed to receive temperature data after {} attempts", max_attempts);
}

/// Helper to read positions from socket with retries
fn read_positions(socket: &mut tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<TcpStream>>, motor_ids: &[u8]) -> Vec<(u8, i32)> {
    let read_packet = build_sync_current_position(motor_ids);
    socket.send(Message::Binary(read_packet)).expect("Failed to send read");

    for _ in 0..20 {
        match socket.read() {
            Ok(Message::Binary(data)) if !data.is_empty() => {
                let positions = parse_position_packets(&data);
                if !positions.is_empty() {
                    return positions;
                }
            }
            Err(e) if e.to_string().contains("WouldBlock") || e.to_string().contains("Resource temporarily") => {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            _ => {}
        }
    }
    vec![]
}

#[test]
#[ignore] // Run with: cargo test --test app websocket_move_to_zero -- --ignored
fn test_websocket_move_to_zero() {
    if !is_server_available() {
        eprintln!("Skipping test: WebSocket server not available at 127.0.0.1:8000");
        return;
    }

    let (mut socket, _) = connect(WS_URL).expect("Failed to connect");
    println!("Connected to WebSocket server");

    // Set read timeout
    if let tungstenite::stream::MaybeTlsStream::Plain(ref stream) = socket.get_ref() {
        stream
            .set_read_timeout(Some(std::time::Duration::from_millis(200)))
            .ok();
    }

    // Step 1: Read initial positions BEFORE any commands
    println!("\n=== INITIAL POSITIONS (before any commands) ===");
    let initial_positions = read_positions(&mut socket, &HEAD_MOTOR_IDS);
    for (motor_id, raw_pos) in &initial_positions {
        println!("  Motor {}: {:.1}° (raw={})", motor_id, raw_to_radians(*raw_pos).to_degrees(), raw_pos);
    }

    // Step 2: Enable torque
    println!("\n=== ENABLING TORQUE ===");
    let torque_packet = build_sync_write_torque(&HEAD_MOTOR_IDS, true);
    socket
        .send(Message::Binary(torque_packet))
        .expect("Failed to send torque enable");
    std::thread::sleep(std::time::Duration::from_millis(200));

    // Step 3: Use inverse kinematics to compute joint angles for center pose (0,0,0,0,0,0)
    println!("\n=== COMPUTING JOINT ANGLES VIA INVERSE KINEMATICS ===");
    let target_joints = compute_joint_angles(0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    println!("  Target pose: x=0, y=0, z=0, roll=0, pitch=0, yaw=0");
    println!("  Computed joint angles (radians): {:?}", target_joints);
    println!("  Computed joint angles (degrees):");
    for (i, &angle) in target_joints.iter().enumerate() {
        println!("    Motor {}: {:.2}°", 11 + i, angle.to_degrees());
    }

    // Convert to array for the packet builder
    let target_radians: [f32; 6] = [
        target_joints[0], target_joints[1], target_joints[2],
        target_joints[3], target_joints[4], target_joints[5],
    ];

    println!("\n=== SENDING POSITION COMMAND ===");
    let write_packet = build_sync_write_position_radians(&HEAD_MOTOR_IDS.to_vec(), &target_radians);
    println!("  Packet bytes: {:02X?}", &write_packet[..std::cmp::min(30, write_packet.len())]);
    socket
        .send(Message::Binary(write_packet))
        .expect("Failed to send position write");

    // Step 4: Wait for motors to move and settle
    println!("\n=== WAITING 2 seconds for motors to move ===");
    std::thread::sleep(std::time::Duration::from_millis(2000));

    // Step 5: Read positions after move command
    println!("\n=== POSITIONS AFTER MOVE COMMAND ===");
    let final_positions = read_positions(&mut socket, &HEAD_MOTOR_IDS);

    let mut all_close_to_target = true;
    let tolerance_rad = 0.15; // ~9 degrees tolerance

    for (motor_id, raw_pos) in &final_positions {
        let actual_rad = raw_to_radians(*raw_pos);
        let actual_deg = actual_rad.to_degrees();

        // Find target angle for this motor
        let motor_idx = (*motor_id - 11) as usize;
        let target_rad = if motor_idx < target_radians.len() {
            target_radians[motor_idx]
        } else {
            0.0
        };
        let target_deg = target_rad.to_degrees();

        let error_rad = (actual_rad - target_rad).abs();
        let is_close = error_rad < tolerance_rad;

        // Find initial position for this motor
        let initial = initial_positions.iter().find(|(id, _)| *id == *motor_id);
        let moved = if let Some((_, init_raw)) = initial {
            let diff = (*raw_pos - *init_raw).abs();
            if diff > 10 { format!("(moved {} ticks)", diff) } else { "(no movement)".to_string() }
        } else {
            "".to_string()
        };

        println!(
            "  Motor {}: actual={:.1}° target={:.1}° error={:.1}° {} {}",
            motor_id,
            actual_deg,
            target_deg,
            error_rad.to_degrees(),
            if is_close { "✓" } else { "✗" },
            moved
        );

        if !is_close {
            all_close_to_target = false;
        }
    }

    // Disable torque
    println!("\n=== DISABLING TORQUE ===");
    socket
        .send(Message::Binary(build_sync_write_torque(&HEAD_MOTOR_IDS, false)))
        .ok();
    socket.close(None).ok();

    // Check if motors actually moved in response to our command
    let mut total_movement = 0i32;
    for (motor_id, final_raw) in &final_positions {
        if let Some((_, initial_raw)) = initial_positions.iter().find(|(id, _)| *id == *motor_id) {
            total_movement += (*final_raw - *initial_raw).abs();
        }
    }

    println!("\nTotal movement: {} ticks across all motors", total_movement);

    // Motors should have moved significantly in response to our command
    let min_expected_movement = 100; // At least 100 total ticks of movement
    assert!(
        total_movement >= min_expected_movement,
        "Motors did not respond to position command! Total movement: {} ticks (expected >= {})",
        total_movement,
        min_expected_movement
    );

    if all_close_to_target {
        println!("\n✓ Test passed: All motors reached target positions computed by inverse kinematics!");
    } else {
        panic!(
            "\n✗ Motors did not reach target positions! Expected within {:.1}° of IK-computed targets",
            tolerance_rad.to_degrees()
        );
    }
}

#[test]
#[ignore] // Run with: cargo test --test app websocket_ik_movements -- --ignored
fn test_websocket_ik_movements() {
    if !is_server_available() {
        eprintln!("Skipping test: WebSocket server not available at 127.0.0.1:8000");
        return;
    }

    let (mut socket, _) = connect(WS_URL).expect("Failed to connect");
    println!("Connected to WebSocket server");

    // Set read timeout
    if let tungstenite::stream::MaybeTlsStream::Plain(ref stream) = socket.get_ref() {
        stream
            .set_read_timeout(Some(std::time::Duration::from_millis(200)))
            .ok();
    }

    // Enable torque
    socket
        .send(Message::Binary(build_sync_write_torque(&HEAD_MOTOR_IDS, true)))
        .expect("Failed to send torque enable");
    std::thread::sleep(std::time::Duration::from_millis(100));

    // First, move to center pose and wait for motors to settle
    println!("Moving to initial center pose...");
    let center_joints = compute_joint_angles(0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    let center_radians: [f32; 6] = [
        center_joints[0], center_joints[1], center_joints[2],
        center_joints[3], center_joints[4], center_joints[5],
    ];
    socket
        .send(Message::Binary(build_sync_write_position_radians(&HEAD_MOTOR_IDS.to_vec(), &center_radians)))
        .expect("Failed to send initial center pose");
    std::thread::sleep(std::time::Duration::from_millis(1500)); // Wait for initial move

    // Test poses: (x_mm, y_mm, z_mm, roll_deg, pitch_deg, yaw_deg, description)
    let test_poses: Vec<(f32, f32, f32, f32, f32, f32, &str)> = vec![
        (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, "Center pose"),
        (5.0, 0.0, 0.0, 0.0, 0.0, 0.0, "Translate X +5mm"),
        (-5.0, 0.0, 0.0, 0.0, 0.0, 0.0, "Translate X -5mm"),
        (0.0, 5.0, 0.0, 0.0, 0.0, 0.0, "Translate Y +5mm"),
        (0.0, -5.0, 0.0, 0.0, 0.0, 0.0, "Translate Y -5mm"),
        (0.0, 0.0, 5.0, 0.0, 0.0, 0.0, "Translate Z +5mm"),
        (0.0, 0.0, -5.0, 0.0, 0.0, 0.0, "Translate Z -5mm"),
        (0.0, 0.0, 0.0, 5.0, 0.0, 0.0, "Roll +5°"),
        (0.0, 0.0, 0.0, -5.0, 0.0, 0.0, "Roll -5°"),
        (0.0, 0.0, 0.0, 0.0, 5.0, 0.0, "Pitch +5°"),
        (0.0, 0.0, 0.0, 0.0, -5.0, 0.0, "Pitch -5°"),
        (0.0, 0.0, 0.0, 0.0, 0.0, 5.0, "Yaw +5°"),
        (0.0, 0.0, 0.0, 0.0, 0.0, -5.0, "Yaw -5°"),
        (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, "Return to center"),
    ];

    let tolerance_rad = 0.15; // ~9 degrees
    let mut all_tests_passed = true;

    for (x, y, z, roll, pitch, yaw, desc) in &test_poses {
        println!("\n============================================================");
        println!("Testing: {}", desc);
        println!("  Pose: x={:.1}mm y={:.1}mm z={:.1}mm roll={:.1}° pitch={:.1}° yaw={:.1}°", x, y, z, roll, pitch, yaw);

        // Compute joint angles
        let target_joints = compute_joint_angles(*x, *y, *z, *roll, *pitch, *yaw);
        println!("  IK joint angles: [{:.1}°, {:.1}°, {:.1}°, {:.1}°, {:.1}°, {:.1}°]",
            target_joints[0].to_degrees(),
            target_joints[1].to_degrees(),
            target_joints[2].to_degrees(),
            target_joints[3].to_degrees(),
            target_joints[4].to_degrees(),
            target_joints[5].to_degrees(),
        );

        // Send position command
        let target_radians: [f32; 6] = [
            target_joints[0], target_joints[1], target_joints[2],
            target_joints[3], target_joints[4], target_joints[5],
        ];
        let write_packet = build_sync_write_position_radians(&HEAD_MOTOR_IDS.to_vec(), &target_radians);
        socket
            .send(Message::Binary(write_packet))
            .expect("Failed to send position write");

        // Wait for motors to move
        std::thread::sleep(std::time::Duration::from_millis(800));

        // Read positions
        let positions = read_positions(&mut socket, &HEAD_MOTOR_IDS);

        // Check results
        let mut pose_passed = true;
        print!("  Results: ");
        for (motor_id, raw_pos) in &positions {
            let actual_rad = raw_to_radians(*raw_pos);
            let motor_idx = (*motor_id - 11) as usize;
            let target_rad = target_radians[motor_idx];
            let error_rad = (actual_rad - target_rad).abs();

            if error_rad >= tolerance_rad {
                pose_passed = false;
                all_tests_passed = false;
            }
        }

        if pose_passed {
            println!("✓ PASS");
        } else {
            println!("✗ FAIL");
            // Print detailed errors
            for (motor_id, raw_pos) in &positions {
                let actual_rad = raw_to_radians(*raw_pos);
                let motor_idx = (*motor_id - 11) as usize;
                let target_rad = target_radians[motor_idx];
                let error_deg = (actual_rad - target_rad).abs().to_degrees();
                println!("    Motor {}: actual={:.1}° target={:.1}° error={:.1}°",
                    motor_id,
                    actual_rad.to_degrees(),
                    target_rad.to_degrees(),
                    error_deg
                );
            }
        }
    }

    // Disable torque
    socket
        .send(Message::Binary(build_sync_write_torque(&HEAD_MOTOR_IDS, false)))
        .ok();
    socket.close(None).ok();

    println!("\n============================================================");
    if all_tests_passed {
        println!("✓ All {} movement tests passed!", test_poses.len());
    } else {
        panic!("✗ Some movement tests failed!");
    }
}

#[test]
#[ignore] // Run with: cargo test --test app websocket_roundtrip -- --ignored
fn test_websocket_position_roundtrip() {
    if !is_server_available() {
        eprintln!("Skipping test: WebSocket server not available at 127.0.0.1:8000");
        return;
    }

    let (mut socket, _) = connect(WS_URL).expect("Failed to connect");

    // Enable torque
    socket
        .send(Message::Binary(build_sync_write_torque(&HEAD_MOTOR_IDS, true)))
        .expect("Failed to send");
    std::thread::sleep(std::time::Duration::from_millis(50));

    // Test multiple positions
    let test_angles: [f32; 6] = [0.1, -0.1, 0.05, -0.05, 0.0, 0.0]; // Small angles in radians

    // Write positions
    let write_packet = build_sync_write_position_radians(&HEAD_MOTOR_IDS.to_vec(), &test_angles);
    socket
        .send(Message::Binary(write_packet))
        .expect("Failed to send write");
    println!("Wrote positions: {:?}", test_angles);

    // Wait for motors to settle
    std::thread::sleep(std::time::Duration::from_millis(800));

    // Read positions back
    socket
        .send(Message::Binary(build_sync_current_position(&HEAD_MOTOR_IDS)))
        .expect("Failed to send read");
    std::thread::sleep(std::time::Duration::from_millis(50));

    let response = socket.read().expect("Failed to read");
    if let Message::Binary(data) = response {
        let positions = parse_position_packets(&data);

        for (motor_id, raw_pos) in positions.iter() {
            let actual_rad = raw_to_radians(*raw_pos);
            let expected_rad = test_angles.get((*motor_id - 11) as usize).unwrap_or(&0.0);
            let error = (actual_rad - expected_rad).abs();

            println!(
                "Motor {}: expected={:.3} rad, actual={:.3} rad, error={:.3} rad ({:.1}°)",
                motor_id,
                expected_rad,
                actual_rad,
                error,
                error.to_degrees()
            );

            // Allow 0.15 radians (~9 degrees) tolerance for motor accuracy
            assert!(
                error < 0.15,
                "Motor {} position error {:.3} rad exceeds tolerance",
                motor_id,
                error
            );
        }
    }

    // Return to center and disable torque
    socket
        .send(Message::Binary(build_sync_write_position_radians(
            &HEAD_MOTOR_IDS.to_vec(),
            &[0.0; 6],
        )))
        .expect("Failed to send");
    std::thread::sleep(std::time::Duration::from_millis(500));

    socket
        .send(Message::Binary(build_sync_write_torque(&HEAD_MOTOR_IDS, false)))
        .expect("Failed to send");

    socket.close(None).ok();
    println!("Roundtrip test passed!");
}
