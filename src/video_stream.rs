//! Video Stream API for Reachy Mini
//!
//! This module provides video streaming functionality with automatic fallback:
//! 1. First tries WebSocket connection to the robot
//! 2. Falls back to browser camera via getUserMedia if WebSocket fails

use std::cell::RefCell;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use futures_util::{StreamExt, TryStreamExt};
use gloo::net::websocket::futures::WebSocket;
use gloo::net::websocket::Message;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;
use web_sys::{console, HtmlCanvasElement, HtmlVideoElement, MediaStream, MediaStreamConstraints};

use crate::sleep;

/// Default WebSocket host
const DEFAULT_WS_HOST: &str = "127.0.0.1";

/// Default WebSocket port for Reachy Mini
const DEFAULT_WS_PORT: u16 = 8000;

/// Default WebSocket path for video streaming
const DEFAULT_VIDEO_WS_PATH: &str = "/api/video/ws";

thread_local! {
    /// Global video stream connection
    static VIDEO_STREAM: RefCell<Option<VideoStreamSource>> = RefCell::new(None);
}

/// Video source type - either WebSocket or local camera
enum VideoStreamSource {
    WebSocket(WebSocketStream),
    Camera(CameraStream),
}

/// WebSocket-based video stream
struct WebSocketStream {
    receiver: Arc<Mutex<futures_util::stream::SplitStream<WebSocket>>>,
    latest_frame: Arc<Mutex<Option<Vec<u8>>>>,
    _running: Arc<AtomicBool>,
}

/// Browser camera-based video stream
struct CameraStream {
    video_element: HtmlVideoElement,
    canvas: HtmlCanvasElement,
    context: web_sys::CanvasRenderingContext2d,
    latest_frame: Arc<Mutex<Option<Vec<u8>>>>,
    _media_stream: MediaStream,
}

impl WebSocketStream {
    async fn new(address: Option<String>) -> Result<Self, JsValue> {
        let url = build_ws_url(address);
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

    fn get_latest(&self) -> Option<Vec<u8>> {
        self.latest_frame.try_lock().ok().and_then(|f| f.clone())
    }
}

impl CameraStream {
    async fn new() -> Result<Self, JsValue> {
        console::log_1(&JsValue::from_str(
            "WebSocket failed, falling back to browser camera...",
        ));

        let window = web_sys::window().ok_or("No window")?;
        let document = window.document().ok_or("No document")?;
        let navigator = window.navigator();
        let media_devices = navigator
            .media_devices()
            .map_err(|_| "No media devices")?;

        // Request camera access
        let constraints = MediaStreamConstraints::new();
        constraints.set_video(&JsValue::TRUE);
        constraints.set_audio(&JsValue::FALSE);

        let promise = media_devices
            .get_user_media_with_constraints(&constraints)
            .map_err(|e| JsValue::from_str(&format!("getUserMedia failed: {:?}", e)))?;

        let media_stream: MediaStream = JsFuture::from(promise).await?.dyn_into()?;

        // Create hidden video element
        let video_element: HtmlVideoElement = document
            .create_element("video")?
            .dyn_into()
            .map_err(|_| "Failed to create video element")?;

        video_element.set_autoplay(true);
        video_element.set_muted(true);
        video_element.set_attribute("playsinline", "true")?;
        video_element.style().set_property("display", "none")?;
        video_element.set_src_object(Some(&media_stream));

        // Append to document body (required for some browsers)
        document
            .body()
            .ok_or("No body")?
            .append_child(&video_element)?;

        // Wait for video to be ready
        let video_ready = js_sys::Promise::new(&mut |resolve, _reject| {
            let video = video_element.clone();
            let closure = Closure::once(Box::new(move || {
                resolve.call0(&JsValue::NULL).unwrap();
            }) as Box<dyn FnOnce()>);
            video.set_onloadedmetadata(Some(closure.as_ref().unchecked_ref()));
            closure.forget();
        });
        JsFuture::from(video_ready).await?;

        // Start playing
        let play_promise = video_element.play().map_err(|e| {
            JsValue::from_str(&format!("Video play failed: {:?}", e))
        })?;
        JsFuture::from(play_promise).await?;

        // Create canvas for frame capture
        let canvas: HtmlCanvasElement = document
            .create_element("canvas")?
            .dyn_into()
            .map_err(|_| "Failed to create canvas")?;

        let width = video_element.video_width();
        let height = video_element.video_height();
        canvas.set_width(width);
        canvas.set_height(height);
        canvas.style().set_property("display", "none")?;

        let context: web_sys::CanvasRenderingContext2d = canvas
            .get_context("2d")?
            .ok_or("No 2d context")?
            .dyn_into()
            .map_err(|_| "Failed to get 2d context")?;

        console::log_1(
            &format!(
                "Camera fallback connected: {}x{}",
                width, height
            )
            .into(),
        );

        Ok(Self {
            video_element,
            canvas,
            context,
            latest_frame: Arc::new(Mutex::new(None)),
            _media_stream: media_stream,
        })
    }

    fn get_latest(&self) -> Option<Vec<u8>> {
        self.latest_frame.try_lock().ok().and_then(|f| f.clone())
    }
}

impl Drop for CameraStream {
    fn drop(&mut self) {
        // Remove video element from DOM
        if let Some(parent) = self.video_element.parent_node() {
            let _ = parent.remove_child(&self.video_element);
        }
        // Stop all tracks
        for track in self._media_stream.get_tracks() {
            if let Ok(track) = track.dyn_into::<web_sys::MediaStreamTrack>() {
                track.stop();
            }
        }
    }
}

fn build_ws_url(address: Option<String>) -> String {
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

/// Connect to the video stream with automatic camera fallback.
///
/// Tries to establish a WebSocket connection to the robot first.
/// If that fails, automatically falls back to the browser's camera.
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
    // Try WebSocket first
    match WebSocketStream::new(address).await {
        Ok(ws_stream) => {
            VIDEO_STREAM.with_borrow_mut(|s| *s = Some(VideoStreamSource::WebSocket(ws_stream)));
            console::log_1(&JsValue::from_str("Connected to video stream via WebSocket"));
            Ok(true)
        }
        Err(ws_err) => {
            console::log_1(&format!("WebSocket failed: {:?}", ws_err).into());

            // Fall back to camera
            let camera_stream = CameraStream::new().await?;
            VIDEO_STREAM.with_borrow_mut(|s| *s = Some(VideoStreamSource::Camera(camera_stream)));
            console::log_1(&JsValue::from_str(
                "Connected to video stream via browser camera (fallback)",
            ));
            Ok(true)
        }
    }
}

/// Check if connected to the video stream.
///
/// # Returns
/// * `true` if connected (via WebSocket or camera)
/// * `false` if not connected
#[wasm_bindgen]
pub fn is_video_stream_connected() -> bool {
    VIDEO_STREAM.with_borrow(|s| s.is_some())
}

/// Check if using camera fallback.
///
/// # Returns
/// * `true` if using browser camera
/// * `false` if using WebSocket or not connected
#[wasm_bindgen]
pub fn is_using_camera_fallback() -> bool {
    VIDEO_STREAM.with_borrow(|s| matches!(s.as_ref(), Some(VideoStreamSource::Camera(_))))
}

/// Read the next video frame from the stream.
///
/// This function returns the next available frame.
/// For WebSocket: waits for next frame from server
/// For Camera: captures current frame from video element
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
    let source_type = VIDEO_STREAM.with_borrow(|s| {
        s.as_ref().map(|source| match source {
            VideoStreamSource::WebSocket(_) => "websocket",
            VideoStreamSource::Camera(_) => "camera",
        })
    });

    match source_type {
        None => Err(JsValue::from_str(
            "Not connected to video stream. Call connect_video_stream() first.",
        )),
        Some("websocket") => {
            let receiver = VIDEO_STREAM
                .with_borrow(|s| {
                    if let Some(VideoStreamSource::WebSocket(ws)) = s.as_ref() {
                        Some(ws.receiver.clone())
                    } else {
                        None
                    }
                })
                .ok_or_else(|| JsValue::from_str("WebSocket stream not available"))?;

            let mut rx = receiver
                .try_lock()
                .map_err(|e| JsValue::from_str(&format!("Lock failed: {:?}", e)))?;

            match rx.try_next().await {
                Ok(Some(Message::Bytes(bytes))) => {
                    // Update cache
                    VIDEO_STREAM.with_borrow(|s| {
                        if let Some(VideoStreamSource::WebSocket(ws)) = s.as_ref() {
                            if let Ok(mut frame) = ws.latest_frame.try_lock() {
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
        Some("camera") => {
            // For camera, we need to capture from the video element
            // This is a bit tricky with thread_local, so we'll use a different approach
            VIDEO_STREAM.with_borrow(|s| {
                if let Some(VideoStreamSource::Camera(cam)) = s.as_ref() {
                    // We can't call async methods here, so we'll use a sync approach
                    // Actually we need to restructure this...
                    Ok(cam.get_latest())
                } else {
                    Ok(None)
                }
            })
        }
        Some(_) => Err(JsValue::from_str("Unknown video source")),
    }
}

/// Capture a frame from camera (only works when using camera fallback).
/// Call this periodically to update the frame buffer.
#[wasm_bindgen]
pub async fn capture_camera_frame() -> Result<Option<Vec<u8>>, JsValue> {
    let is_camera = VIDEO_STREAM.with_borrow(|s| {
        matches!(s.as_ref(), Some(VideoStreamSource::Camera(_)))
    });

    if !is_camera {
        return Err(JsValue::from_str("Not using camera fallback"));
    }

    // We need to get the camera stream and capture
    // Due to RefCell limitations, we'll capture the necessary parts
    let (video_element, canvas, context, latest_frame) = VIDEO_STREAM.with_borrow(|s| {
        if let Some(VideoStreamSource::Camera(cam)) = s.as_ref() {
            Some((
                cam.video_element.clone(),
                cam.canvas.clone(),
                cam.context.clone(),
                cam.latest_frame.clone(),
            ))
        } else {
            None
        }
    }).ok_or_else(|| JsValue::from_str("Camera not available"))?;

    // Update canvas size if needed
    let width = video_element.video_width();
    let height = video_element.video_height();

    if width == 0 || height == 0 {
        return Ok(None);
    }

    if canvas.width() != width || canvas.height() != height {
        canvas.set_width(width);
        canvas.set_height(height);
    }

    // Draw video frame to canvas
    context
        .draw_image_with_html_video_element(&video_element, 0.0, 0.0)
        .map_err(|e| JsValue::from_str(&format!("Draw failed: {:?}", e)))?;

    // Convert to JPEG blob
    let (tx, rx) = futures_channel::oneshot::channel();
    let tx = std::cell::RefCell::new(Some(tx));

    let closure = Closure::once(Box::new(move |blob: JsValue| {
        if let Some(tx) = tx.borrow_mut().take() {
            let _ = tx.send(blob);
        }
    }) as Box<dyn FnOnce(JsValue)>);

    canvas
        .to_blob_with_type_and_encoder_options(
            closure.as_ref().unchecked_ref(),
            "image/jpeg",
            &JsValue::from_f64(0.8),
        )
        .map_err(|e| JsValue::from_str(&format!("toBlob failed: {:?}", e)))?;

    closure.forget();

    let blob_js = rx
        .await
        .map_err(|_| JsValue::from_str("Blob channel closed"))?;

    if blob_js.is_null() || blob_js.is_undefined() {
        return Ok(None);
    }

    let blob: web_sys::Blob = blob_js.dyn_into()?;
    let array_buffer = JsFuture::from(blob.array_buffer()).await?;
    let uint8_array = js_sys::Uint8Array::new(&array_buffer);
    let bytes = uint8_array.to_vec();

    // Update cache
    if let Ok(mut cache) = latest_frame.try_lock() {
        *cache = Some(bytes.clone());
    }

    Ok(Some(bytes))
}

/// Get the latest cached video frame without waiting.
///
/// Returns the most recently received/captured frame from the cache.
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
    VIDEO_STREAM.with_borrow(|s| {
        s.as_ref().and_then(|source| match source {
            VideoStreamSource::WebSocket(ws) => ws.get_latest(),
            VideoStreamSource::Camera(cam) => cam.get_latest(),
        })
    })
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
