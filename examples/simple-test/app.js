// Elements
const $ = id => document.getElementById(id);
const toggleConnect = $('toggle-connect');
const toggleTorque = $('toggle-torque');
const toggleMic = $('toggle-mic');
const toggleVideo = $('toggle-video');
const connectControl = $('connect-control');
const connectStatus = $('connect-status');
const torqueStatus = $('torque-status');
const micStatus = $('mic-status');
const videoStatus = $('video-status');
const messagesContainer = $('messages-container');
const actionButtons = $('action-buttons');
const stopButtonContainer = $('stop-button-container');
const btnReadPosition = $('btn-read-position');
const btnRecord = $('btn-record');
const btnReplay = $('btn-replay');
const btnStop = $('btn-stop');

// State
let isConnected = false;
let currentMode = null;
let poseMessageId = null;

// Messages
function addMessage(type, title, text, id = null) {
    const msgId = id || ('msg-' + Date.now());
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const icons = { error: '⚠️', success: '✓', info: 'ℹ️', system: '🤖', pose: '📍' };

    const message = document.createElement('div');
    message.className = `message ${type}`;
    message.id = msgId;
    message.innerHTML = `
        <div class="message-avatar ${type}">${icons[type] || '•'}</div>
        <div class="message-content">
            <div class="message-header">
                <span class="message-title">${title}</span>
                <div style="display:flex;align-items:center;">
                    <span class="message-time">${time}</span>
                    <button class="message-dismiss" onclick="dismissMessage('${msgId}')">✕</button>
                </div>
            </div>
            <div class="message-text">${text}</div>
        </div>
    `;

    messagesContainer.appendChild(message);
    setTimeout(() => message.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    return msgId;
}

function updateMessage(id, text) {
    const msg = $(id);
    if (msg) msg.querySelector('.message-text').innerHTML = text;
}

function dismissMessage(id) {
    const msg = $(id);
    if (msg) {
        msg.style.opacity = '0';
        msg.style.transform = 'translateY(-8px)';
        msg.style.transition = 'all 0.2s';
        setTimeout(() => msg.remove(), 200);
    }
}

// Expose dismissMessage globally for onclick handlers
window.dismissMessage = dismissMessage;

// Pose
function updatePose(x, y, z, roll, pitch, yaw) {
    if (poseMessageId) {
        updateMessage(poseMessageId,
            `<strong>Position:</strong> X: ${x.toFixed(1)}mm, Y: ${y.toFixed(1)}mm, Z: ${z.toFixed(1)}mm<br>
             <strong>Rotation:</strong> Roll: ${roll.toFixed(1)}°, Pitch: ${pitch.toFixed(1)}°, Yaw: ${yaw.toFixed(1)}°`);
    }
}

// Mode
function setMode(mode) {
    currentMode = mode;
    actionButtons.classList.toggle('hidden', !!mode);
    stopButtonContainer.classList.toggle('hidden', !mode);
}

// Action handlers
btnReadPosition.onclick = async () => {
    setMode('reading');
    poseMessageId = addMessage('pose', 'Head Pose', '<strong>Position:</strong> --<br><strong>Rotation:</strong> --');
    addMessage('info', 'Reading Position', 'Continuously reading head position...');
    await read_pose();
};

btnRecord.onclick = async () => {
    setMode('recording');
    addMessage('info', 'Recording', 'Recording movement... Press Stop when done.');
    await record();
};

btnReplay.onclick = async () => {
    setMode('replaying');
    addMessage('info', 'Replaying', 'Replaying recorded movement...');
    await replay();
};

btnStop.onclick = async () => {
    const wasMode = currentMode;
    setMode(null);
    if (wasMode === 'reading') { await stop(); addMessage('info', 'Stopped', 'Position reading stopped.'); }
    else if (wasMode === 'recording') { await stop(); addMessage('success', 'Recording Saved', 'Movement recording saved.'); }
    else if (wasMode === 'replaying') { await stop(); addMessage('info', 'Stopped', 'Replay stopped.'); }
    poseMessageId = null;
};

// Toggle handlers
toggleConnect.onchange = async (e) => {
    if (e.target.checked) {
        try {
            await connect(null);
            isConnected = true;
            connectStatus.classList.add('active');
            connectControl.classList.remove('highlight');
            [toggleTorque, btnReadPosition, btnRecord, btnReplay].forEach(el => el.disabled = false);
            // [toggleTorque, toggleMic, toggleVideo, btnReadPosition, btnRecord, btnReplay].forEach(el => el.disabled = false);
            addMessage('success', 'Connected', 'Successfully connected to Reachy Mini.');
        } catch (err) {
            e.target.checked = false;
            addMessage('error', 'Connection Failed', err.message || 'Unable to connect.');
        }
    } else {
        if (currentMode) btnStop.click();
        await disconnect();
        isConnected = false;
        connectStatus.classList.remove('active');
        connectControl.classList.add('highlight');
        [toggleTorque, toggleMic, toggleVideo].forEach(el => { el.checked = false; el.disabled = true; });
        [torqueStatus, micStatus, videoStatus].forEach(el => el.classList.remove('active'));
        [btnReadPosition, btnRecord, btnReplay].forEach(el => el.disabled = true);
        addMessage('info', 'Disconnected', 'Disconnected from Reachy Mini.');
    }
};

toggleTorque.onchange = async (e) => {
    if (!isConnected) { e.target.checked = false; return; }
    if (e.target.checked) {
        try { await enableTorque(); torqueStatus.classList.add('active'); addMessage('success', 'Torque Enabled', 'Motor torque is now active.'); }
        catch (err) { e.target.checked = false; addMessage('error', 'Torque Error', err.message || 'Failed to enable torque.'); }
    } else {
        await disableTorque();
        torqueStatus.classList.remove('active');
        addMessage('info', 'Torque Disabled', 'Motor torque has been disabled.');
    }
};

toggleMic.onchange = (e) => {
    if (!isConnected) { e.target.checked = false; return; }
    micStatus.classList.toggle('active', e.target.checked);
    addMessage(e.target.checked ? 'success' : 'info',
        e.target.checked ? 'Microphone Active' : 'Microphone Stopped',
        e.target.checked ? 'Audio input is now streaming.' : 'Audio input has been stopped.');
};

toggleVideo.onchange = (e) => {
    if (!isConnected) { e.target.checked = false; return; }
    videoStatus.classList.toggle('active', e.target.checked);
    addMessage(e.target.checked ? 'success' : 'info',
        e.target.checked ? 'Video Stream Active' : 'Video Stream Stopped',
        e.target.checked ? 'Video is now streaming.' : 'Video stream has been stopped.');
};

// Implement these functions
async function disconnect() {}

// Welcome
addMessage('system', 'Welcome', 'Toggle "Connect" to start. Please use Chrome Browser and diactivate Reachy Mini Daemon ( for now )');
