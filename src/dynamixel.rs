//! # Dynamixel Protocol 2.0
//!
//! Low-level packet building and parsing for Dynamixel XL330 motors.
//!
//! ## XL330 Control Table (commonly used addresses)
//!
//! | Address | Name                | Size | Access |
//! |---------|---------------------|------|--------|
//! | 64      | Torque Enable       | 1    | RW     |
//! | 116     | Goal Position       | 4    | RW     |
//! | 126     | Present Load        | 2    | R      |
//! | 132     | Present Position    | 4    | R      |
//! | 146     | Present Temperature | 1    | R      |

use wasm_bindgen::JsValue;

// ============================================================================
// Constants
// ============================================================================

/// Broadcast ID (all motors)
pub const BROADCAST_ID: u8 = 0xFE;

/// XL330 control table addresses
pub mod address {
    pub const TORQUE_ENABLE: u16 = 64;
    pub const GOAL_POSITION: u16 = 116;
    pub const PRESENT_LOAD: u16 = 126;
    pub const PRESENT_POSITION: u16 = 132;
    pub const PRESENT_TEMPERATURE: u16 = 146;
}

/// Dynamixel Protocol 2.0 instruction codes
mod instruction {
    pub const READ: u8 = 0x02;
    pub const REBOOT: u8 = 0x08;
    pub const SYNC_READ: u8 = 0x82;
    pub const SYNC_WRITE: u8 = 0x83;
    pub const STATUS: u8 = 0x55;
}

// ============================================================================
// CRC Calculation
// ============================================================================

/// CRC16 lookup table for Dynamixel Protocol 2.0
static CRC_TABLE: [u16; 256] = [
    0x0000, 0x8005, 0x800F, 0x000A, 0x801B, 0x001E, 0x0014, 0x8011, 0x8033, 0x0036, 0x003C, 0x8039,
    0x0028, 0x802D, 0x8027, 0x0022, 0x8063, 0x0066, 0x006C, 0x8069, 0x0078, 0x807D, 0x8077, 0x0072,
    0x0050, 0x8055, 0x805F, 0x005A, 0x804B, 0x004E, 0x0044, 0x8041, 0x80C3, 0x00C6, 0x00CC, 0x80C9,
    0x00D8, 0x80DD, 0x80D7, 0x00D2, 0x00F0, 0x80F5, 0x80FF, 0x00FA, 0x80EB, 0x00EE, 0x00E4, 0x80E1,
    0x00A0, 0x80A5, 0x80AF, 0x00AA, 0x80BB, 0x00BE, 0x00B4, 0x80B1, 0x8093, 0x0096, 0x009C, 0x8099,
    0x0088, 0x808D, 0x8087, 0x0082, 0x8183, 0x0186, 0x018C, 0x8189, 0x0198, 0x819D, 0x8197, 0x0192,
    0x01B0, 0x81B5, 0x81BF, 0x01BA, 0x81AB, 0x01AE, 0x01A4, 0x81A1, 0x01E0, 0x81E5, 0x81EF, 0x01EA,
    0x81FB, 0x01FE, 0x01F4, 0x81F1, 0x81D3, 0x01D6, 0x01DC, 0x81D9, 0x01C8, 0x81CD, 0x81C7, 0x01C2,
    0x0140, 0x8145, 0x814F, 0x014A, 0x815B, 0x015E, 0x0154, 0x8151, 0x8173, 0x0176, 0x017C, 0x8179,
    0x0168, 0x816D, 0x8167, 0x0162, 0x8123, 0x0126, 0x012C, 0x8129, 0x0138, 0x813D, 0x8137, 0x0132,
    0x0110, 0x8115, 0x811F, 0x011A, 0x810B, 0x010E, 0x0104, 0x8101, 0x8303, 0x0306, 0x030C, 0x8309,
    0x0318, 0x831D, 0x8317, 0x0312, 0x0330, 0x8335, 0x833F, 0x033A, 0x832B, 0x032E, 0x0324, 0x8321,
    0x0360, 0x8365, 0x836F, 0x036A, 0x837B, 0x037E, 0x0374, 0x8371, 0x8353, 0x0356, 0x035C, 0x8359,
    0x0348, 0x834D, 0x8347, 0x0342, 0x03C0, 0x83C5, 0x83CF, 0x03CA, 0x83DB, 0x03DE, 0x03D4, 0x83D1,
    0x83F3, 0x03F6, 0x03FC, 0x83F9, 0x03E8, 0x83ED, 0x83E7, 0x03E2, 0x83A3, 0x03A6, 0x03AC, 0x83A9,
    0x03B8, 0x83BD, 0x83B7, 0x03B2, 0x0390, 0x8395, 0x839F, 0x039A, 0x838B, 0x038E, 0x0384, 0x8381,
    0x0280, 0x8285, 0x828F, 0x028A, 0x829B, 0x029E, 0x0294, 0x8291, 0x82B3, 0x02B6, 0x02BC, 0x82B9,
    0x02A8, 0x82AD, 0x82A7, 0x02A2, 0x82E3, 0x02E6, 0x02EC, 0x82E9, 0x02F8, 0x82FD, 0x82F7, 0x02F2,
    0x02D0, 0x82D5, 0x82DF, 0x02DA, 0x82CB, 0x02CE, 0x02C4, 0x82C1, 0x8243, 0x0246, 0x024C, 0x8249,
    0x0258, 0x825D, 0x8257, 0x0252, 0x0270, 0x8275, 0x827F, 0x027A, 0x826B, 0x026E, 0x0264, 0x8261,
    0x0220, 0x8225, 0x822F, 0x022A, 0x823B, 0x023E, 0x0234, 0x8231, 0x8213, 0x0216, 0x021C, 0x8219,
    0x0208, 0x820D, 0x8207, 0x0202,
];

/// Calculate CRC16 for Dynamixel Protocol 2.0
#[inline]
fn crc16(data: &[u8]) -> u16 {
    data.iter().fold(0u16, |crc, &byte| {
        let idx = ((crc >> 8) ^ byte as u16) as u8;
        (crc << 8) ^ CRC_TABLE[idx as usize]
    })
}

// ============================================================================
// Packet Builder
// ============================================================================

/// Packet builder for Dynamixel Protocol 2.0
///
/// Pre-allocates buffer and provides fluent API for building packets.
struct PacketBuilder {
    buf: Vec<u8>,
}

impl PacketBuilder {
    /// Create new packet with header and motor ID
    #[inline]
    fn new(id: u8, capacity: usize) -> Self {
        let mut buf = Vec::with_capacity(capacity);
        buf.extend_from_slice(&[0xFF, 0xFF, 0xFD, 0x00, id]);
        Self { buf }
    }

    /// Set packet length and instruction (call after header)
    #[inline]
    fn instruction(mut self, instr: u8, param_len: u16) -> Self {
        let len = param_len + 3; // params + instr + crc(2)
        self.buf.push((len & 0xFF) as u8);
        self.buf.push((len >> 8) as u8);
        self.buf.push(instr);
        self
    }

    /// Add a u8 parameter
    #[inline]
    fn u8(mut self, val: u8) -> Self {
        self.buf.push(val);
        self
    }

    /// Add a u16 parameter (little-endian)
    #[inline]
    fn u16_le(mut self, val: u16) -> Self {
        self.buf.push((val & 0xFF) as u8);
        self.buf.push((val >> 8) as u8);
        self
    }

    /// Add an i32 parameter (little-endian)
    #[inline]
    fn i32_le(mut self, val: i32) -> Self {
        self.buf.push((val & 0xFF) as u8);
        self.buf.push(((val >> 8) & 0xFF) as u8);
        self.buf.push(((val >> 16) & 0xFF) as u8);
        self.buf.push(((val >> 24) & 0xFF) as u8);
        self
    }

    /// Add raw bytes
    #[inline]
    fn bytes(mut self, data: &[u8]) -> Self {
        self.buf.extend_from_slice(data);
        self
    }

    /// Finalize packet by appending CRC
    #[inline]
    fn build(mut self) -> Vec<u8> {
        let crc = crc16(&self.buf);
        self.buf.push((crc & 0xFF) as u8);
        self.buf.push((crc >> 8) as u8);
        self.buf
    }
}

// ============================================================================
// Packet Building Functions
// ============================================================================

/// Build READ packet for a single motor.
///
/// # Example
/// ```ignore
/// let packet = build_read_packet(11, address::PRESENT_TEMPERATURE, 1);
/// ```
#[inline]
pub fn build_read_packet(motor_id: u8, addr: u16, length: u16) -> Vec<u8> {
    PacketBuilder::new(motor_id, 14)
        .instruction(instruction::READ, 4)
        .u16_le(addr)
        .u16_le(length)
        .build()
}

/// Build REBOOT packet for a single motor.
#[inline]
pub fn build_reboot_packet(motor_id: u8) -> Vec<u8> {
    PacketBuilder::new(motor_id, 10)
        .instruction(instruction::REBOOT, 0)
        .build()
}

/// Build SYNC_READ for Present Position (address 132, 4 bytes).
pub fn build_sync_current_position(motor_ids: &[u8]) -> Vec<u8> {
    let param_len = 4 + motor_ids.len() as u16; // addr(2) + data_len(2) + ids

    PacketBuilder::new(BROADCAST_ID, 14 + motor_ids.len())
        .instruction(instruction::SYNC_READ, param_len)
        .u16_le(address::PRESENT_POSITION)
        .u16_le(4)
        .bytes(motor_ids)
        .build()
}

/// Build SYNC_WRITE for Torque Enable (address 64, 1 byte).
pub fn build_sync_write_torque(motor_ids: &[u8], enable: bool) -> Vec<u8> {
    let param_len = 4 + (2 * motor_ids.len()) as u16; // addr(2) + data_len(2) + n*(id + val)
    let val = if enable { 1u8 } else { 0u8 };

    let mut builder = PacketBuilder::new(BROADCAST_ID, 14 + 2 * motor_ids.len())
        .instruction(instruction::SYNC_WRITE, param_len)
        .u16_le(address::TORQUE_ENABLE)
        .u16_le(1);

    for &id in motor_ids {
        builder = builder.u8(id).u8(val);
    }

    builder.build()
}

/// Build SYNC_WRITE for Goal Position (address 116, 4 bytes).
pub fn build_sync_write_position(motor_ids: &[u8], positions: &[i32]) -> Vec<u8> {
    debug_assert_eq!(motor_ids.len(), positions.len());

    let param_len = 4 + (5 * motor_ids.len()) as u16; // addr(2) + data_len(2) + n*(id + 4)

    let mut builder = PacketBuilder::new(BROADCAST_ID, 14 + 5 * motor_ids.len())
        .instruction(instruction::SYNC_WRITE, param_len)
        .u16_le(address::GOAL_POSITION)
        .u16_le(4);

    for (&id, &pos) in motor_ids.iter().zip(positions.iter()) {
        builder = builder.u8(id).i32_le(pos);
    }

    builder.build()
}

/// Build SYNC_WRITE for positions in radians.
#[inline]
pub fn build_sync_write_position_radians(motor_ids: &[u8], radians: &[f32]) -> Vec<u8> {
    let positions: Vec<i32> = radians.iter().map(|&r| radians_to_raw(r)).collect();
    build_sync_write_position(motor_ids, &positions)
}

/// Build SYNC_READ for temperature from multiple motors.
pub fn build_sync_read_temperature(motor_ids: &[u8]) -> Vec<u8> {
    let param_len = 4 + motor_ids.len() as u16;

    PacketBuilder::new(BROADCAST_ID, 14 + motor_ids.len())
        .instruction(instruction::SYNC_READ, param_len)
        .u16_le(address::PRESENT_TEMPERATURE)
        .u16_le(1)
        .bytes(motor_ids)
        .build()
}

/// Build SYNC_READ for load from multiple motors.
pub fn build_sync_read_load(motor_ids: &[u8]) -> Vec<u8> {
    let param_len = 4 + motor_ids.len() as u16;

    PacketBuilder::new(BROADCAST_ID, 14 + motor_ids.len())
        .instruction(instruction::SYNC_READ, param_len)
        .u16_le(address::PRESENT_LOAD)
        .u16_le(2)
        .bytes(motor_ids)
        .build()
}

// ============================================================================
// Packet Parsing
// ============================================================================

/// Status packet parsing error
#[derive(Debug, Clone, Copy)]
pub enum ParseError {
    TooShort,
    InvalidHeader,
    InvalidInstruction,
    InvalidLength,
    MotorError(u8),
}

impl From<ParseError> for JsValue {
    fn from(e: ParseError) -> Self {
        JsValue::from_str(match e {
            ParseError::TooShort => "Packet too short",
            ParseError::InvalidHeader => "Invalid header",
            ParseError::InvalidInstruction => "Invalid instruction",
            ParseError::InvalidLength => "Invalid length",
            ParseError::MotorError(code) => {
                return JsValue::from_str(&format!("Motor error: 0x{:02X}", code))
            }
        })
    }
}

/// Validate packet header and return (id, length, error_byte, data_start)
#[inline]
fn validate_header(data: &[u8], min_len: usize) -> Result<(u8, u16, u8, usize), ParseError> {
    if data.len() < min_len {
        return Err(ParseError::TooShort);
    }

    // Check header: FF FF FD 00
    if data[0] != 0xFF || data[1] != 0xFF || data[2] != 0xFD || data[3] != 0x00 {
        return Err(ParseError::InvalidHeader);
    }

    let id = data[4];
    let length = u16::from_le_bytes([data[5], data[6]]);

    if data[7] != instruction::STATUS {
        return Err(ParseError::InvalidInstruction);
    }

    let error = data[8];

    Ok((id, length, error, 9))
}

/// Parse status packet for position read (4 bytes).
///
/// Returns `(motor_id, raw_position)`.
pub fn parse_status_packet(data: &[u8], offset: usize) -> Result<(u8, i32), JsValue> {
    let slice = &data[offset..];

    // Position response: header(4) + id(1) + len(2) + instr(1) + err(1) + data(4) + crc(2) = 15
    let (id, length, _error, data_start) = validate_header(slice, 15)?;

    if length != 8 {
        return Err(ParseError::InvalidLength.into());
    }

    let pos = i32::from_le_bytes([
        slice[data_start],
        slice[data_start + 1],
        slice[data_start + 2],
        slice[data_start + 3],
    ]);

    Ok((id, pos))
}

/// Parse status packet for 1-byte read (e.g., temperature).
pub fn parse_status_packet_1byte(data: &[u8]) -> Result<u8, JsValue> {
    // 1-byte response: header(4) + id(1) + len(2) + instr(1) + err(1) + data(1) + crc(2) = 12
    let (_id, _length, error, data_start) = validate_header(data, 12)?;

    if error != 0 {
        return Err(ParseError::MotorError(error).into());
    }

    Ok(data[data_start])
}

/// Parse status packet for 2-byte signed read (e.g., load).
pub fn parse_status_packet_2byte_signed(data: &[u8]) -> Result<i16, JsValue> {
    // 2-byte response: header(4) + id(1) + len(2) + instr(1) + err(1) + data(2) + crc(2) = 13
    let (_id, _length, error, data_start) = validate_header(data, 13)?;

    if error != 0 {
        return Err(ParseError::MotorError(error).into());
    }

    Ok(i16::from_le_bytes([data[data_start], data[data_start + 1]]))
}

// ============================================================================
// Conversion Utilities
// ============================================================================

/// Ticks per radian for XL330 (4096 positions per revolution)
const TICKS_PER_RAD: f32 = 4096.0 / (2.0 * std::f32::consts::PI);

/// Radians per tick for XL330
const RAD_PER_TICK: f32 = (2.0 * std::f32::consts::PI) / 4096.0;

/// Convert radians to raw Dynamixel position.
///
/// XL330: 4096 positions/revolution, center = 2048 = 0 rad
#[inline]
pub fn radians_to_raw(rad: f32) -> i32 {
    (2048.0 + rad * TICKS_PER_RAD) as i32
}

/// Convert raw Dynamixel position to radians.
#[inline]
pub fn raw_to_radians(raw: i32) -> f32 {
    (raw as f32 - 2048.0) * RAD_PER_TICK
}

// ============================================================================
// Resilient Multi-Packet Parsing
// ============================================================================

/// Scan buffer for Dynamixel packet headers (FF FF FD 00).
///
/// Returns iterator of byte offsets where valid headers were found.
fn find_packet_headers(data: &[u8]) -> impl Iterator<Item = usize> + '_ {
    data.windows(4)
        .enumerate()
        .filter(|(_, w)| w == &[0xFF, 0xFF, 0xFD, 0x00])
        .map(|(i, _)| i)
}

/// Parse all position status packets from a response buffer.
///
/// This function scans for packet headers instead of using fixed offsets,
/// making it resilient to missing motor responses.
///
/// # Returns
/// Vector of (motor_id, raw_position) for each successfully parsed packet.
pub fn parse_position_packets(data: &[u8]) -> Vec<(u8, i32)> {
    let mut results = Vec::new();

    for offset in find_packet_headers(data) {
        // Need at least 15 bytes for a position status packet
        if offset + 15 > data.len() {
            continue;
        }

        let slice = &data[offset..];

        // Check it's a status packet (instruction = 0x55)
        if slice[7] != instruction::STATUS {
            continue;
        }

        // Check length field indicates position data (length = 8)
        let length = u16::from_le_bytes([slice[5], slice[6]]);
        if length != 8 {
            continue;
        }

        let motor_id = slice[4];
        let pos = i32::from_le_bytes([slice[9], slice[10], slice[11], slice[12]]);

        results.push((motor_id, pos));
    }

    results
}

/// Parse all 1-byte status packets (e.g., temperature) from a response buffer.
///
/// # Returns
/// Vector of (motor_id, value) for each successfully parsed packet.
pub fn parse_1byte_packets(data: &[u8]) -> Vec<(u8, u8)> {
    let mut results = Vec::new();

    for offset in find_packet_headers(data) {
        // Need at least 12 bytes for a 1-byte status packet
        if offset + 12 > data.len() {
            continue;
        }

        let slice = &data[offset..];

        if slice[7] != instruction::STATUS {
            continue;
        }

        // Length = 5 for 1-byte data (instr + err + data + crc)
        let length = u16::from_le_bytes([slice[5], slice[6]]);
        if length != 5 {
            continue;
        }

        let error = slice[8];
        if error != 0 {
            continue;
        }

        let motor_id = slice[4];
        let value = slice[9];

        results.push((motor_id, value));
    }

    results
}

/// Parse all 2-byte signed status packets (e.g., load) from a response buffer.
///
/// # Returns
/// Vector of (motor_id, value) for each successfully parsed packet.
pub fn parse_2byte_signed_packets(data: &[u8]) -> Vec<(u8, i16)> {
    let mut results = Vec::new();

    for offset in find_packet_headers(data) {
        // Need at least 13 bytes for a 2-byte status packet
        if offset + 13 > data.len() {
            continue;
        }

        let slice = &data[offset..];

        if slice[7] != instruction::STATUS {
            continue;
        }

        // Length = 6 for 2-byte data (instr + err + data + crc)
        let length = u16::from_le_bytes([slice[5], slice[6]]);
        if length != 6 {
            continue;
        }

        let error = slice[8];
        if error != 0 {
            continue;
        }

        let motor_id = slice[4];
        let value = i16::from_le_bytes([slice[9], slice[10]]);

        results.push((motor_id, value));
    }

    results
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_crc() {
        // Test vector from Dynamixel documentation
        let data = [
            0xFF, 0xFF, 0xFD, 0x00, 0x01, 0x07, 0x00, 0x55, 0x00, 0x06, 0x04, 0x26,
        ];
        let crc = crc16(&data);
        assert_eq!(crc, 0x5D65);
    }

    #[test]
    fn test_radians_conversion() {
        assert_eq!(radians_to_raw(0.0), 2048);
        assert!((raw_to_radians(2048) - 0.0).abs() < 0.001);

        let rad = std::f32::consts::PI / 2.0;
        let raw = radians_to_raw(rad);
        let back = raw_to_radians(raw);
        assert!((back - rad).abs() < 0.01);
    }

    #[test]
    fn test_read_packet_structure() {
        let packet = build_read_packet(11, 146, 1);
        assert_eq!(packet[0..4], [0xFF, 0xFF, 0xFD, 0x00]); // Header
        assert_eq!(packet[4], 11); // Motor ID
        assert_eq!(packet[7], instruction::READ);
        assert_eq!(packet[8], 146); // Address low
        assert_eq!(packet[9], 0); // Address high
    }

    #[test]
    fn test_reboot_packet_structure() {
        let packet = build_reboot_packet(17);
        assert_eq!(packet[4], 17); // Motor ID
        assert_eq!(packet[7], instruction::REBOOT);
        assert_eq!(packet.len(), 10);
    }
}
