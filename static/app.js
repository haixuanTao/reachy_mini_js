
// Reachy Mini Control Panel - WebSocket Version
// Connects to localhost:8000 WebSocket API for real-time control

const ROBOT_URL = 'localhost:8000';
const WS_URL = `ws://${ROBOT_URL}/api/move/ws/set_target`;

// Global state
const state = {
    ws: null,
    connected: false,
    isRefreshing: false,
    currentPose: {
        head: { x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0 },
        bodyYaw: 0,
        antennas: [0, 0]
    }
};

// DOM elements
const elements = {
    status: document.getElementById('connectionStatus'),
    sliders: {
        headX: document.getElementById('headX'),
        headY: document.getElementById('headY'),
        headZ: document.getElementById('headZ'),
        headRoll: document.getElementById('headRoll'),
        headPitch: document.getElementById('headPitch'),
        headYaw: document.getElementById('headYaw'),
        bodyYaw: document.getElementById('bodyYaw'),
        antennaLeft: document.getElementById('antennaLeft'),
        antennaRight: document.getElementById('antennaRight')
    },
    values: {
        headX: document.getElementById('headXValue'),
        headY: document.getElementById('headYValue'),
        headZ: document.getElementById('headZValue'),
        headRoll: document.getElementById('headRollValue'),
        headPitch: document.getElementById('headPitchValue'),
        headYaw: document.getElementById('headYawValue'),
        bodyYaw: document.getElementById('bodyYawValue'),
        antennaLeft: document.getElementById('antennaLeftValue'),
        antennaRight: document.getElementById('antennaRightValue')
    }
};

// WebSocket connection
function connectWebSocket() {
    console.log('Connecting to WebSocket:', WS_URL);

    state.ws = new WebSocket(WS_URL);

    state.ws.onopen = () => {
        console.log('WebSocket connected');
        state.connected = true;
        updateConnectionStatus(true);
        enableControls(true);
    };

    state.ws.onclose = () => {
        console.log('WebSocket disconnected');
        state.connected = false;
        updateConnectionStatus(false);
        enableControls(false);

        // Reconnect after 2 seconds
        setTimeout(connectWebSocket, 2000);
    };

    state.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
    };

    state.ws.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data);
            if (message.status === 'error') {
                console.error('Server error:', message.detail);
            }
        } catch (e) {
            console.error('Failed to parse message:', e);
        }
    };
}

// Update connection status UI
function updateConnectionStatus(connected) {
    if (connected) {
        elements.status.className = 'status connected';
        elements.status.innerHTML = '<span><span class="status-dot green"></span>Connected to robot</span>';
    } else {
        elements.status.className = 'status disconnected';
        elements.status.innerHTML = '<span><span class="status-dot red"></span>Disconnected - Reconnecting...</span>';
    }
}

// Enable/disable controls
function enableControls(enabled) {
    Object.values(elements.sliders).forEach(slider => {
        slider.disabled = !enabled;
    });
}

// Send target pose via WebSocket
function sendTargetPose() {
    if (!state.connected || !state.ws || state.ws.readyState !== WebSocket.OPEN) {
        console.warn('WebSocket not connected');
        return;
    }

    if (state.isRefreshing) {
        return; // Don't send during refresh
    }

    const message = {
        target_head_pose: {
            x: state.currentPose.head.x,
            y: state.currentPose.head.y,
            z: state.currentPose.head.z,
            roll: state.currentPose.head.roll,
            pitch: state.currentPose.head.pitch,
            yaw: state.currentPose.head.yaw
        },
        target_body_yaw: state.currentPose.bodyYaw,
        target_antennas: state.currentPose.antennas
    };

    try {
        state.ws.send(JSON.stringify(message));
    } catch (error) {
        console.error('Failed to send message:', error);
    }
}
