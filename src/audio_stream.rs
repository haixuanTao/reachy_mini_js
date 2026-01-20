//! Audio Stream API for Reachy Mini
//!
//! This module provides bidirectional audio streaming functionality with automatic fallback:
//! 1. First tries WebSocket connection to the robot
//! 2. Falls back to browser microphone via getUserMedia if WebSocket fails

use std::cell::RefCell;
use std::convert::TryInto;
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt, TryStreamExt};
use gloo::net::websocket::futures::WebSocket;
use gloo::net::websocket::Message;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;
use web_sys::{console, MediaStream, MediaStreamConstraints};

use crate::sleep;

/// Default WebSocket host
const DEFAULT_WS_HOST: &str = "127.0.0.1";

/// Default WebSocket port for Reachy Mini
const DEFAULT_WS_PORT: u16 = 8000;

/// Default WebSocket path for audio streaming
const DEFAULT_AUDIO_WS_PATH: &str = "/api/audio/ws";

thread_local! {
    /// Global audio stream connection
    static AUDIO_STREAM: RefCell<Option<AudioStreamSource>> = RefCell::new(None);
}

/// Audio source type - either WebSocket or local microphone
enum AudioStreamSource {
    WebSocket(WebSocketAudioStream),
    Microphone(MicrophoneStream),
}

/// WebSocket-based audio stream
struct WebSocketAudioStream {
    sender: Arc<Mutex<futures_util::stream::SplitSink<WebSocket, Message>>>,
    receiver: Arc<Mutex<futures_util::stream::SplitStream<WebSocket>>>,
    latest_audio: Arc<Mutex<Option<Vec<f32>>>>,
}

/// Browser microphone-based audio stream using AudioWorklet/ScriptProcessor
struct MicrophoneStream {
    _media_stream: MediaStream,
    audio_context: web_sys::AudioContext,
    latest_audio: Arc<Mutex<Option<Vec<f32>>>>,
    // We'll use a ScriptProcessorNode for simplicity (AudioWorklet requires more setup)
    _script_processor: web_sys::ScriptProcessorNode,
    _closure: Closure<dyn FnMut(web_sys::AudioProcessingEvent)>,
}

impl WebSocketAudioStream {
    async fn new(address: Option<String>) -> Result<Self, JsValue> {
        let url = build_ws_url(address);
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

    fn get_latest(&self) -> Option<Vec<f32>> {
        self.latest_audio.try_lock().ok().and_then(|a| a.clone())
    }
}

impl MicrophoneStream {
    async fn new() -> Result<Self, JsValue> {
        console::log_1(&JsValue::from_str(
            "WebSocket failed, falling back to browser microphone...",
        ));

        let window = web_sys::window().ok_or("No window")?;
        let navigator = window.navigator();
        let media_devices = navigator
            .media_devices()
            .map_err(|_| "No media devices")?;

        // Request microphone access
        let constraints = MediaStreamConstraints::new();
        constraints.set_video(&JsValue::FALSE);
        constraints.set_audio(&JsValue::TRUE);

        let promise = media_devices
            .get_user_media_with_constraints(&constraints)
            .map_err(|e| JsValue::from_str(&format!("getUserMedia failed: {:?}", e)))?;

        let media_stream: MediaStream = JsFuture::from(promise).await?.dyn_into()?;

        // Create AudioContext
        let audio_context = web_sys::AudioContext::new()
            .map_err(|e| JsValue::from_str(&format!("AudioContext failed: {:?}", e)))?;

        // Create source from microphone stream
        let source = audio_context
            .create_media_stream_source(&media_stream)
            .map_err(|e| JsValue::from_str(&format!("createMediaStreamSource failed: {:?}", e)))?;

        // Create ScriptProcessorNode for capturing audio data
        // Buffer size of 4096 samples, mono input/output
        let script_processor = audio_context
            .create_script_processor_with_buffer_size_and_number_of_input_channels_and_number_of_output_channels(
                4096, 1, 1,
            )
            .map_err(|e| JsValue::from_str(&format!("createScriptProcessor failed: {:?}", e)))?;

        // Connect source -> script processor -> destination (to keep it running)
        source
            .connect_with_audio_node(&script_processor)
            .map_err(|e| JsValue::from_str(&format!("connect source failed: {:?}", e)))?;

        script_processor
            .connect_with_audio_node(&audio_context.destination())
            .map_err(|e| JsValue::from_str(&format!("connect destination failed: {:?}", e)))?;

        // Set up audio processing callback
        let latest_audio: Arc<Mutex<Option<Vec<f32>>>> = Arc::new(Mutex::new(None));
        let latest_audio_clone = latest_audio.clone();

        let closure = Closure::new(move |event: web_sys::AudioProcessingEvent| {
            if let Ok(input_buffer) = event.input_buffer() {
                if let Ok(channel_data) = input_buffer.get_channel_data(0) {
                    let samples: Vec<f32> = channel_data.to_vec();
                    if let Ok(mut cache) = latest_audio_clone.try_lock() {
                        *cache = Some(samples);
                    }
                }
            }
        });

        script_processor.set_onaudioprocess(Some(closure.as_ref().unchecked_ref()));

        console::log_1(&JsValue::from_str("Microphone fallback connected"));

        Ok(Self {
            _media_stream: media_stream,
            audio_context,
            latest_audio,
            _script_processor: script_processor,
            _closure: closure,
        })
    }

    fn get_latest(&self) -> Option<Vec<f32>> {
        self.latest_audio.try_lock().ok().and_then(|a| a.clone())
    }
}

impl Drop for MicrophoneStream {
    fn drop(&mut self) {
        // Close audio context
        let _ = self.audio_context.close();
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

/// Connect to the audio stream with automatic microphone fallback.
///
/// Tries to establish a WebSocket connection to the robot first.
/// If that fails, automatically falls back to the browser's microphone.
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
    // Try WebSocket first
    match WebSocketAudioStream::new(address).await {
        Ok(ws_stream) => {
            AUDIO_STREAM.with_borrow_mut(|s| *s = Some(AudioStreamSource::WebSocket(ws_stream)));
            console::log_1(&JsValue::from_str("Connected to audio stream via WebSocket"));
            Ok(true)
        }
        Err(ws_err) => {
            console::log_1(&format!("WebSocket failed: {:?}", ws_err).into());

            // Fall back to microphone
            let mic_stream = MicrophoneStream::new().await?;
            AUDIO_STREAM.with_borrow_mut(|s| *s = Some(AudioStreamSource::Microphone(mic_stream)));
            console::log_1(&JsValue::from_str(
                "Connected to audio stream via browser microphone (fallback)",
            ));
            Ok(true)
        }
    }
}

/// Check if connected to the audio stream.
///
/// # Returns
/// * `true` if connected (via WebSocket or microphone)
/// * `false` if not connected
#[wasm_bindgen]
pub fn is_audio_stream_connected() -> bool {
    AUDIO_STREAM.with_borrow(|s| s.is_some())
}

/// Check if using microphone fallback.
///
/// # Returns
/// * `true` if using browser microphone
/// * `false` if using WebSocket or not connected
#[wasm_bindgen]
pub fn is_using_microphone_fallback() -> bool {
    AUDIO_STREAM.with_borrow(|s| matches!(s.as_ref(), Some(AudioStreamSource::Microphone(_))))
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
    let source_type = AUDIO_STREAM.with_borrow(|s| {
        s.as_ref().map(|source| match source {
            AudioStreamSource::WebSocket(_) => "websocket",
            AudioStreamSource::Microphone(_) => "microphone",
        })
    });

    match source_type {
        None => Err(JsValue::from_str(
            "Not connected to audio stream. Call connect_audio_stream() first.",
        )),
        Some("websocket") => {
            let (receiver, latest_audio) = AUDIO_STREAM
                .with_borrow(|s| {
                    if let Some(AudioStreamSource::WebSocket(ws)) = s.as_ref() {
                        Some((ws.receiver.clone(), ws.latest_audio.clone()))
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
        Some("microphone") => {
            // For microphone, return the latest captured audio
            AUDIO_STREAM.with_borrow(|s| {
                if let Some(AudioStreamSource::Microphone(mic)) = s.as_ref() {
                    Ok(mic.get_latest())
                } else {
                    Ok(None)
                }
            })
        }
        Some(_) => Err(JsValue::from_str("Unknown audio source")),
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
    AUDIO_STREAM.with_borrow(|s| {
        s.as_ref().and_then(|source| match source {
            AudioStreamSource::WebSocket(ws) => ws.get_latest(),
            AudioStreamSource::Microphone(mic) => mic.get_latest(),
        })
    })
}

/// Send an audio chunk to the robot.
///
/// Sends audio samples to the robot for playback or processing.
/// Audio should be float32 samples in the range [-1.0, 1.0].
///
/// Note: This only works when connected via WebSocket, not microphone fallback.
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
        .with_borrow(|s| {
            if let Some(AudioStreamSource::WebSocket(ws)) = s.as_ref() {
                Some(ws.sender.clone())
            } else {
                None
            }
        })
        .ok_or_else(|| {
            JsValue::from_str(
                "Cannot send audio: not connected via WebSocket (microphone fallback is receive-only)",
            )
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
