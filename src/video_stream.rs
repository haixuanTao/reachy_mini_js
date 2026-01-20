//! Video Stream API for Reachy Mini
//!
//! This module provides WebSocket-based video streaming functionality
//! to receive video frames from the robot.

use std::cell::RefCell;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use futures_util::{StreamExt, TryStreamExt};
use gloo::net::websocket::futures::WebSocket;
use gloo::net::websocket::Message;
use wasm_bindgen::prelude::*;
use web_sys::console;

use crate::sleep;

/// Default WebSocket host
const DEFAULT_WS_HOST: &str = "127.0.0.1";

/// Default WebSocket port for Reachy Mini
const DEFAULT_WS_PORT: u16 = 8000;

/// Default WebSocket path for video streaming
const DEFAULT_VIDEO_WS_PATH: &str = "/api/video/ws";

thread_local! {
    /// Global video stream connection
    static VIDEO_STREAM: RefCell<Option<VideoStream>> = RefCell::new(None);
}

/// Video stream wrapper for receiving frames from the robot.
struct VideoStream {
    receiver: Arc<Mutex<futures_util::stream::SplitStream<WebSocket>>>,
    latest_frame: Arc<Mutex<Option<Vec<u8>>>>,
    _running: Arc<AtomicBool>,
}

impl VideoStream {
    /// Create a new video stream connection.
    async fn new(address: Option<String>) -> Result<Self, JsValue> {
        let url = Self::build_url(address);
        console::log_1(&format!("Connecting to video stream: {}", url).into());

        let ws = WebSocket::open(&url)
            .map_err(|e| JsValue::from_str(&format!("Video WebSocket open failed: {:?}", e)))?;

        // Wait for connection
        loop {
            match ws.state() {
                gloo::net::websocket::State::Connecting => sleep(10).await?,
                gloo::net::websocket::State::Open => break,
                _ => return Err(JsValue::from_str("Video WebSocket connection failed")),
            }
        }

        let (_sender, receiver) = ws.split();

        Ok(Self {
            receiver: Arc::new(Mutex::new(receiver)),
            latest_frame: Arc::new(Mutex::new(None)),
            _running: Arc::new(AtomicBool::new(true)),
        })
    }

    fn build_url(address: Option<String>) -> String {
        match address {
            None => format!(
                "ws://{}:{}{}",
                DEFAULT_WS_HOST, DEFAULT_WS_PORT, DEFAULT_VIDEO_WS_PATH
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
                    format!("ws://{}:{}{}", host, port, DEFAULT_VIDEO_WS_PATH)
                } else {
                    format!("ws://{}:{}{}", addr, DEFAULT_WS_PORT, DEFAULT_VIDEO_WS_PATH)
                }
            }
        }
    }

    /// Get the latest cached frame without blocking.
    fn get_latest(&self) -> Option<Vec<u8>> {
        self.latest_frame.try_lock().ok().and_then(|f| f.clone())
    }
}

/// Connect to the video stream.
///
/// Establishes a WebSocket connection to receive video frames from the robot.
///
/// # Arguments
/// * `address` - Optional WebSocket address. Can be:
///   - Full URL: `ws://192.168.1.100:8000/api/video/ws`
///   - IP with port: `192.168.1.100:8000`
///   - IP only: `192.168.1.100` (uses default port 8000)
///   - `None` to use default address (127.0.0.1:8000)
///
/// # Example
/// ```javascript
/// await connect_video_stream();
/// // Or with specific address
/// await connect_video_stream("192.168.1.100");
/// ```
#[wasm_bindgen]
pub async fn connect_video_stream(address: Option<String>) -> Result<bool, JsValue> {
    let stream = VideoStream::new(address).await?;
    VIDEO_STREAM.with_borrow_mut(|s| *s = Some(stream));
    console::log_1(&JsValue::from_str("Connected to video stream"));
    Ok(true)
}

/// Check if connected to the video stream.
///
/// # Returns
/// * `true` if connected
/// * `false` if not connected
#[wasm_bindgen]
pub fn is_video_stream_connected() -> bool {
    VIDEO_STREAM.with_borrow(|s| s.is_some())
}

/// Read the next video frame from the stream.
///
/// This function waits for and returns the next available frame.
/// Use this in a loop for continuous frame processing.
///
/// # Returns
/// A `Uint8Array` containing the JPEG-encoded frame, or `null` if no frame available.
///
/// # Example
/// ```javascript
/// const frame = await read_video_frame();
/// if (frame) {
///   const blob = new Blob([frame], { type: 'image/jpeg' });
///   const url = URL.createObjectURL(blob);
///   imgElement.src = url;
/// }
/// ```
#[wasm_bindgen]
pub async fn read_video_frame() -> Result<Option<Vec<u8>>, JsValue> {
    let stream = VIDEO_STREAM
        .with_borrow(|s| s.as_ref().map(|vs| vs.receiver.clone()))
        .ok_or_else(|| {
            JsValue::from_str("Not connected to video stream. Call connect_video_stream() first.")
        })?;

    let mut rx = stream
        .try_lock()
        .map_err(|e| JsValue::from_str(&format!("Lock failed: {:?}", e)))?;

    match rx.try_next().await {
        Ok(Some(Message::Bytes(bytes))) => {
            // Also update the latest frame cache
            VIDEO_STREAM.with_borrow(|s| {
                if let Some(vs) = s.as_ref() {
                    if let Ok(mut frame) = vs.latest_frame.try_lock() {
                        *frame = Some(bytes.clone());
                    }
                }
            });
            Ok(Some(bytes))
        }
        Ok(Some(_)) => Ok(None),
        Ok(None) => Err(JsValue::from_str("Video stream closed")),
        Err(e) => Err(JsValue::from_str(&format!("Read error: {:?}", e))),
    }
}

/// Get the latest cached video frame without waiting.
///
/// Returns the most recently received frame from the cache.
/// This is useful when you need non-blocking access to video data.
///
/// # Returns
/// A `Uint8Array` containing the JPEG-encoded frame, or `null` if no frame cached.
///
/// # Example
/// ```javascript
/// const frame = get_latest_video_frame();
/// if (frame) {
///   // Process the frame
/// }
/// ```
#[wasm_bindgen]
pub fn get_latest_video_frame() -> Option<Vec<u8>> {
    VIDEO_STREAM.with_borrow(|s| s.as_ref().and_then(|vs| vs.get_latest()))
}

/// Disconnect from the video stream.
///
/// # Example
/// ```javascript
/// disconnect_video_stream();
/// ```
#[wasm_bindgen]
pub fn disconnect_video_stream() {
    VIDEO_STREAM.with_borrow_mut(|s| *s = None);
    console::log_1(&JsValue::from_str("Disconnected from video stream"));
}
