//! Audio Stream API for Reachy Mini
//!
//! This module provides bidirectional WebSocket-based audio streaming
//! functionality to send and receive audio with the robot.

use std::cell::RefCell;
use std::convert::TryInto;
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt, TryStreamExt};
use gloo::net::websocket::futures::WebSocket;
use gloo::net::websocket::Message;
use wasm_bindgen::prelude::*;
use web_sys::console;

use crate::sleep;

/// Default WebSocket host
const DEFAULT_WS_HOST: &str = "127.0.0.1";

/// Default WebSocket port for Reachy Mini
const DEFAULT_WS_PORT: u16 = 8000;

/// Default WebSocket path for audio streaming
const DEFAULT_AUDIO_WS_PATH: &str = "/api/audio/ws";

thread_local! {
    /// Global audio stream connection
    static AUDIO_STREAM: RefCell<Option<AudioStream>> = RefCell::new(None);
}

/// Audio stream wrapper for bidirectional audio with the robot.
struct AudioStream {
    sender: Arc<Mutex<futures_util::stream::SplitSink<WebSocket, Message>>>,
    receiver: Arc<Mutex<futures_util::stream::SplitStream<WebSocket>>>,
    latest_audio: Arc<Mutex<Option<Vec<f32>>>>,
}

impl AudioStream {
    /// Create a new audio stream connection.
    async fn new(address: Option<String>) -> Result<Self, JsValue> {
        let url = Self::build_url(address);
        console::log_1(&format!("Connecting to audio stream: {}", url).into());

        let ws = WebSocket::open(&url)
            .map_err(|e| JsValue::from_str(&format!("Audio WebSocket open failed: {:?}", e)))?;

        // Wait for connection
        loop {
            match ws.state() {
                gloo::net::websocket::State::Connecting => sleep(10).await?,
                gloo::net::websocket::State::Open => break,
                _ => return Err(JsValue::from_str("Audio WebSocket connection failed")),
            }
        }

        let (sender, receiver) = ws.split();

        Ok(Self {
            sender: Arc::new(Mutex::new(sender)),
            receiver: Arc::new(Mutex::new(receiver)),
            latest_audio: Arc::new(Mutex::new(None)),
        })
    }

    fn build_url(address: Option<String>) -> String {
        match address {
            None => format!(
                "ws://{}:{}{}",
                DEFAULT_WS_HOST, DEFAULT_WS_PORT, DEFAULT_AUDIO_WS_PATH
            ),
            Some(addr) => {
                let addr = addr.trim();
                if addr.starts_with("ws://") || addr.starts_with("wss://") {
                    return addr.to_string();
                }
                if addr.contains(':') {
                    let parts: Vec<&str> = addr.splitn(2, ':').collect();
                    let host = parts[0];
                    let port = parts[1].parse::<u16>().unwrap_or(DEFAULT_WS_PORT);
                    format!("ws://{}:{}{}", host, port, DEFAULT_AUDIO_WS_PATH)
                } else {
                    format!("ws://{}:{}{}", addr, DEFAULT_WS_PORT, DEFAULT_AUDIO_WS_PATH)
                }
            }
        }
    }

    /// Get the latest cached audio chunk.
    fn get_latest(&self) -> Option<Vec<f32>> {
        self.latest_audio.try_lock().ok().and_then(|a| a.clone())
    }
}

/// Connect to the audio stream.
///
/// Establishes a bidirectional WebSocket connection for audio communication with the robot.
///
/// # Arguments
/// * `address` - Optional WebSocket address. Can be:
///   - Full URL: `ws://192.168.1.100:8000/api/audio/ws`
///   - IP with port: `192.168.1.100:8000`
///   - IP only: `192.168.1.100` (uses default port 8000)
///   - `None` to use default address (127.0.0.1:8000)
///
/// # Example
/// ```javascript
/// await connect_audio_stream();
/// // Or with specific address
/// await connect_audio_stream("192.168.1.100");
/// ```
#[wasm_bindgen]
pub async fn connect_audio_stream(address: Option<String>) -> Result<bool, JsValue> {
    let stream = AudioStream::new(address).await?;
    AUDIO_STREAM.with_borrow_mut(|s| *s = Some(stream));
    console::log_1(&JsValue::from_str("Connected to audio stream"));
    Ok(true)
}

/// Check if connected to the audio stream.
///
/// # Returns
/// * `true` if connected
/// * `false` if not connected
#[wasm_bindgen]
pub fn is_audio_stream_connected() -> bool {
    AUDIO_STREAM.with_borrow(|s| s.is_some())
}

/// Read the next audio chunk from the stream.
///
/// This function waits for and returns the next available audio chunk.
/// Audio is returned as float32 samples in the range [-1.0, 1.0].
///
/// # Returns
/// A `Float32Array` containing audio samples, or `null` if no audio available.
///
/// # Example
/// ```javascript
/// const audio = await read_audio_chunk();
/// if (audio) {
///   // Process audio samples
///   const audioContext = new AudioContext();
///   const buffer = audioContext.createBuffer(1, audio.length, 16000);
///   buffer.getChannelData(0).set(audio);
/// }
/// ```
#[wasm_bindgen]
pub async fn read_audio_chunk() -> Result<Option<Vec<f32>>, JsValue> {
    let (receiver, latest_audio) = AUDIO_STREAM
        .with_borrow(|s| {
            s.as_ref()
                .map(|a| (a.receiver.clone(), a.latest_audio.clone()))
        })
        .ok_or_else(|| {
            JsValue::from_str("Not connected to audio stream. Call connect_audio_stream() first.")
        })?;

    let mut rx = receiver
        .try_lock()
        .map_err(|e| JsValue::from_str(&format!("Lock failed: {:?}", e)))?;

    match rx.try_next().await {
        Ok(Some(Message::Bytes(bytes))) => {
            // Convert bytes to f32 samples (assuming little-endian float32)
            let samples: Vec<f32> = bytes
                .chunks_exact(4)
                .map(|chunk| {
                    let arr: [u8; 4] = chunk.try_into().unwrap();
                    f32::from_le_bytes(arr)
                })
                .collect();

            // Update cache
            if let Ok(mut cache) = latest_audio.try_lock() {
                *cache = Some(samples.clone());
            }

            Ok(Some(samples))
        }
        Ok(Some(_)) => Ok(None),
        Ok(None) => Err(JsValue::from_str("Audio stream closed")),
        Err(e) => Err(JsValue::from_str(&format!("Read error: {:?}", e))),
    }
}

/// Get the latest cached audio chunk without waiting.
///
/// Returns the most recently received audio chunk from the cache.
/// This is useful when you need non-blocking access to audio data.
///
/// # Returns
/// A `Float32Array` containing audio samples, or `null` if no audio cached.
///
/// # Example
/// ```javascript
/// const audio = get_latest_audio_chunk();
/// if (audio) {
///   // Process the audio
/// }
/// ```
#[wasm_bindgen]
pub fn get_latest_audio_chunk() -> Option<Vec<f32>> {
    AUDIO_STREAM.with_borrow(|s| s.as_ref().and_then(|a| a.get_latest()))
}

/// Send an audio chunk to the robot.
///
/// Sends audio samples to the robot for playback or processing.
/// Audio should be float32 samples in the range [-1.0, 1.0].
///
/// # Arguments
/// * `samples` - Float32Array of audio samples
///
/// # Example
/// ```javascript
/// // Send audio from microphone
/// const samples = new Float32Array(4096);
/// // ... fill samples from AudioWorklet or MediaRecorder ...
/// await send_audio_chunk(samples);
/// ```
#[wasm_bindgen]
pub async fn send_audio_chunk(samples: Vec<f32>) -> Result<(), JsValue> {
    let sender = AUDIO_STREAM
        .with_borrow(|s| s.as_ref().map(|a| a.sender.clone()))
        .ok_or_else(|| {
            JsValue::from_str("Not connected to audio stream. Call connect_audio_stream() first.")
        })?;

    // Convert f32 samples to bytes (little-endian)
    let bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();

    sender
        .try_lock()
        .map_err(|e| JsValue::from_str(&format!("Lock failed: {:?}", e)))?
        .send(Message::Bytes(bytes))
        .await
        .map_err(|e| JsValue::from_str(&format!("Send failed: {:?}", e)))?;

    Ok(())
}

/// Disconnect from the audio stream.
///
/// # Example
/// ```javascript
/// disconnect_audio_stream();
/// ```
#[wasm_bindgen]
pub fn disconnect_audio_stream() {
    AUDIO_STREAM.with_borrow_mut(|s| *s = None);
    console::log_1(&JsValue::from_str("Disconnected from audio stream"));
}
