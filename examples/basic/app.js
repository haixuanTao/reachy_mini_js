// Import WASM module and functions from npm (published version)
import init, {
    connect,
    enable_torque,
    disable_torque,
    forward_kinematics,
    inverse_kinematics,
    start_fk_stream,
    replay_recording,
    stop,
    // Video Stream (optional - for future use)
    connect_video_stream,
    disconnect_video_stream,
    is_using_camera_fallback,
    // Audio Stream (optional - for future use)
    connect_audio_stream,
    disconnect_audio_stream,
    is_using_microphone_fallback,
} from 'https://unpkg.com/reachy-mini@0.6.0/index.js';

// Elements
const btnConnect = document.getElementById('btn-connect');
const btnTorqueOn = document.getElementById('btn-torque-on');
const btnTorqueOff = document.getElementById('btn-torque-off');
const btnFK = document.getElementById('btn-fk');
const btnIK = document.getElementById('btn-ik');
const btnRecord = document.getElementById('btn-record');
const btnReplay = document.getElementById('btn-replay');
const btnStop = document.getElementById('btn-stop');
const statusIndicator = document.getElementById('status-indicator');
const output = document.getElementById('output');

let isConnected = false;

// Logging
function log(message, type = 'info') {
    console.log(`[${type}] ${message}`);
    const line = document.createElement('div');
    line.className = 'output-line';
    const timestamp = new Date().toLocaleTimeString();
    const icon = type === 'success' ? '✓' : type === 'error' ? '✗' : 'ℹ';
    line.textContent = `[${timestamp}] ${icon} ${message}`;
    output.appendChild(line);
    output.scrollTop = output.scrollHeight;
}

// Initialize WASM
try {
    console.log('Initializing WASM...');
    await init();
    log('WASM module loaded successfully', 'success');
    console.log('connect function:', typeof connect);
} catch (err) {
    console.error('WASM init error:', err);
    log(`Failed to load WASM module: ${err.message}`, 'error');
    log('Make sure you run from a local server: python3 -m http.server 8080', 'error');
}

// Connection
btnConnect.addEventListener('click', async () => {
    console.log('Connect button clicked');
    try {
        btnConnect.disabled = true;
        btnConnect.textContent = 'Connecting...';

        log('Attempting to connect to Reachy Mini...');

        console.log('Calling connect()...');
        const result = await connect(null);
        console.log('Connect result:', result);

        isConnected = true;
        statusIndicator.textContent = 'Connected';
        statusIndicator.className = 'status status-connected';
        btnConnect.textContent = 'Connected';

        // Enable other buttons
        [btnTorqueOn, btnTorqueOff, btnFK, btnIK, btnRecord, btnReplay, btnStop].forEach(btn => {
            btn.disabled = false;
        });

        log('Successfully connected to Reachy Mini!', 'success');
    } catch (err) {
        console.error('Connection error:', err);
        btnConnect.disabled = false;
        btnConnect.textContent = 'Connect to Robot';
        log(`Connection failed: ${err}`, 'error');
    }
});

// Torque Control
btnTorqueOn.addEventListener('click', async () => {
    try {
        log('Enabling torque...');
        await enable_torque();
        log('Torque enabled', 'success');
    } catch (err) {
        log(`Error: ${err}`, 'error');
    }
});

btnTorqueOff.addEventListener('click', async () => {
    try {
        log('Disabling torque...');
        await disable_torque();
        log('Torque disabled', 'success');
    } catch (err) {
        log(`Error: ${err}`, 'error');
    }
});

// Forward Kinematics
btnFK.addEventListener('click', () => {
    try {
        log('Testing forward kinematics...');
        const angles = [0, 0, 0, 0, 0, 0]; // 6 head motors at 0 degrees
        const pose = forward_kinematics(angles);
        log(`Input angles: [${angles.join(', ')}]`);
        log(`Output pose [x, y, z, roll, pitch, yaw]: [${[...pose].map(v => v.toFixed(2)).join(', ')}]`, 'success');
    } catch (err) {
        log(`Error: ${err}`, 'error');
    }
});

// Inverse Kinematics
btnIK.addEventListener('click', () => {
    try {
        log('Testing inverse kinematics...');
        const pose = [0, 0, 0, 0, 0, 0]; // x, y, z, roll, pitch, yaw
        const joints = inverse_kinematics(pose);
        log(`Input pose [x, y, z, roll, pitch, yaw]: [${pose.join(', ')}]`);
        log(`Output joints (degrees): [${[...joints].map(v => v.toFixed(2)).join(', ')}]`, 'success');
    } catch (err) {
        log(`Error: ${err}`, 'error');
    }
});

// Recording
btnRecord.addEventListener('click', async () => {
    try {
        log('Recording movement for 10 seconds...');
        btnRecord.disabled = true;
        await start_fk_stream(10000);  // 10 seconds
        btnRecord.disabled = false;
        log('Recording complete', 'success');
    } catch (err) {
        btnRecord.disabled = false;
        log(`Error: ${err}`, 'error');
    }
});

btnReplay.addEventListener('click', async () => {
    try {
        log('Replaying recorded movement...');
        btnReplay.disabled = true;
        await replay_recording();
        btnReplay.disabled = false;
        log('Replay complete', 'success');
    } catch (err) {
        btnReplay.disabled = false;
        log(`Error: ${err}`, 'error');
    }
});

btnStop.addEventListener('click', async () => {
    try {
        log('Stopping current operation...');
        await stop();
        log('Stopped', 'success');
    } catch (err) {
        log(`Error: ${err.message}`, 'error');
    }
});

log('Ready to connect. Click "Connect to Robot" to begin.');
