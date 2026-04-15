require('dotenv').config();
const { io } = require("socket.io-client");
const fs = require("fs");
const path = require("path");
const crypto = require('crypto');
const os = require('os');

// ==========================================
// 1. CONFIGURATION & SETUP
// ==========================================

const SERVER_URL = process.env.SERVER_URL || "https://mtroom-server.koyeb.app"; 
const API_KEY = process.env.API_KEY || "pbsnet-testistest"; 
const TASK_TIMEOUT_MS = 5 * 60 * 1000; 

// কনসোল কালার কোড
const COLORS = {
    RESET: "\x1b[0m",
    RED: "\x1b[31m",
    GREEN: "\x1b[32m",
    YELLOW: "\x1b[33m",
    BLUE: "\x1b[34m",
    MAGENTA: "\x1b[35m",
    CYAN: "\x1b[36m",
    BG_RED: "\x1b[41m\x1b[37m"
};

// লগার হেল্পার
const log = (type, msg) => {
    const time = new Date().toLocaleTimeString();
    console.log(`${time} ${type} ${msg}${COLORS.RESET}`);
};

if (!API_KEY) {
    console.error(`${COLORS.BG_RED} ❌ ERROR ${COLORS.RESET} API_KEY missing in .env file`);
    process.exit(1);
}

const ID_FILE = path.join(__dirname, 'machine_id.txt');
let MACHINE_ID = fs.existsSync(ID_FILE) ? fs.readFileSync(ID_FILE, 'utf8').trim() : '';

const getSystemSpecs = () => ({
    os: os.type() + ' ' + os.release(),
    ram: Math.round(os.totalmem() / (1024 * 1024 * 1024)) + ' GB',
    hostname: os.hostname(),
    cores: os.cpus().length
});

// ==========================================
// 2. SOCKET CONNECTION
// ==========================================

const socket = io(SERVER_URL, {
    query: { type: 'worker' },
    auth: { 
        machineId: MACHINE_ID, 
        apiKey: API_KEY, 
        config: getSystemSpecs() 
    },
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 3000,
    timeout: 20000,
    transports: ["polling", "websocket"]
});

function getLocalFileHash(fileName) {
    const filePath = path.join(__dirname, fileName);
    if (!fs.existsSync(filePath)) return null;
    try {
        return crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex');
    } catch (e) { return null; }
}

let pendingUpdates = 0;

// ==========================================
// 3. EVENT LISTENERS
// ==========================================

socket.on('connect', () => {
    log(COLORS.GREEN, `[STATUS] Connected! ID: ${MACHINE_ID || 'New Node'} | User: ${API_KEY.substring(0,6)}...`);
});

// 🔥 NEW: Auth Error Handler (১ মিনিট ডিলে)
socket.on('auth_error', (data) => {
    log(COLORS.RED, `⛔ Auth Failed: ${data.message}`);
    log(COLORS.YELLOW, `⏳ Waiting 1 minute before retrying...`);
    
    // অটো-রিকানেকশন লুপ থামানোর জন্য ম্যানুয়ালি ডিসকানেক্ট করা
    socket.disconnect();

    // ১ মিনিট (৬০,০০০ ms) পর আবার কানেক্ট করার চেষ্টা
    setTimeout(() => {
        log(COLORS.CYAN, `🔄 Retrying connection...`);
        socket.connect();
    }, 60 * 1000);
});

socket.on('save_machine_id', (data) => {
    try {
        const newId = typeof data === 'object' ? data.newMachineId : data;
        if (newId && newId !== "Pending...") {
            fs.writeFileSync(ID_FILE, newId);
            MACHINE_ID = newId;
            log(COLORS.YELLOW, `💾 Registry Updated: ID assigned ${MACHINE_ID}`);
        }
    } catch (e) { console.error("❌ ID Save Error:", e); }
});

socket.on('disconnect', (reason) => {
    if (reason === 'io client disconnect') {
        // ম্যানুয়াল ডিসকানেক্ট (অথেন্টিকেশন এররের জন্য)
    } else {
        log(COLORS.RED, `[SYSTEM] Disconnected: ${reason}. Retrying...`);
    }
});

socket.on('point_received', (data) => {
    const color = data.type === 'SUCCESS' ? COLORS.YELLOW : COLORS.MAGENTA; 
    console.log(`\n${color}💎 [REWARD] ${data.msg}${COLORS.RESET}`);
});

// ==========================================
// 4. SYNC SYSTEM (ATOMIC UPDATES)
// ==========================================

socket.on('server_ready_for_sync', () => { 
    socket.emit('get_scripts_manifest'); 
});

socket.on('scripts_manifest', (serverFiles) => {
    pendingUpdates = 0;
    serverFiles.forEach(file => {
        const localHash = getLocalFileHash(file.name);
        if (!localHash || localHash !== file.hash) {
            log(COLORS.CYAN, `⬇️ Update found: ${file.name}`);
            socket.emit('request_file', file.name);
            pendingUpdates++;
        }
    });

    if (pendingUpdates === 0) {
        socket.emit('worker_ready');
    }
});

socket.on('receive_file', (file) => {
    try {
        const filePath = path.join(__dirname, file.name);
        const tempPath = `${filePath}.tmp`;

        if (!filePath.startsWith(__dirname)) {
            throw new Error("Invalid file path security violation.");
        }

        fs.writeFileSync(tempPath, file.content);
        fs.renameSync(tempPath, filePath);
        
        if (require.cache[require.resolve(filePath)]) {
            delete require.cache[require.resolve(filePath)];
        }
        
        log(COLORS.GREEN, `✅ Installed: ${file.name}`);
        
        pendingUpdates--;
        if (pendingUpdates <= 0) {
            log(COLORS.GREEN, `[SYNC] All updates finished! System Ready.`);
            socket.emit('worker_ready');
        }
    } catch (e) { 
        console.error(`❌ Save Error (${file.name}):`, e.message); 
    }
});

// ==========================================
// 5. ROBUST TASK EXECUTION ENGINE
// ==========================================

socket.on('execute_task', async (job) => {
    console.log(`\n${COLORS.BG_RED} 📥 NEW JOB ${COLORS.RESET} ${job.taskType} | ID: ${job.requestId.slice(0,6)}`);
    
    let result;
    let timer;

    try {
        let scriptName = job.taskType.replace(/(\.\.|\/)/g, '');
        if (scriptName.endsWith('.js')) scriptName = scriptName.slice(0, -3);

        const specificScriptPath = path.join(__dirname, `${scriptName}.js`);
        
        if (!fs.existsSync(specificScriptPath)) {
            throw new Error(`Script '${scriptName}.js' not found locally.`);
        }

        const resolvedPath = require.resolve(specificScriptPath);
        if (require.cache[resolvedPath]) delete require.cache[resolvedPath];
        
        const module = require(specificScriptPath);
        const action = job.payload.action;

        log(COLORS.CYAN, `[RUN] Module: ${scriptName} | Action: ${action || 'Default'}`);

        const taskPromise = (async () => {
            if (action && typeof module[action] === 'function') {
                return await module[action](job.payload);
            } else if (module.run && typeof module.run === 'function') {
                return await module.run(job.payload);
            } else if (typeof module === 'function') {
                return await module(job.payload);
            } else {
                throw new Error(`Entry point not found in ${scriptName}.js`);
            }
        })();

        result = await Promise.race([
            taskPromise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error("Execution Timed Out (5m limit)")), TASK_TIMEOUT_MS);
            })
        ]);

        clearTimeout(timer);

        socket.emit('task_completed', { requestId: job.requestId, result });
        log(COLORS.GREEN, `[DONE] Task completed successfully.`);

    } catch (e) {
        clearTimeout(timer);
        log(COLORS.RED, `❌ EXEC ERROR: ${e.message}`);
        socket.emit('task_completed', { requestId: job.requestId, result: { error: e.message } });
    }
});

// ==========================================
// 6. SYSTEM UTILITIES
// ==========================================

setInterval(() => { 
    if (socket.connected) {
        const usedMem = process.memoryUsage().rss / 1024 / 1024;
        socket.emit("worker_ping", { 
            t: Date.now(),
            mem: Math.round(usedMem) + 'MB'
        }); 
    }
}, 30000); 

process.on('unhandledRejection', (reason, promise) => {
    console.error(`${COLORS.RED}🚨 Unhandled Rejection:${COLORS.RESET}`, reason);
});

process.on('uncaughtException', (err) => {
    console.error(`${COLORS.RED}🚨 Critical Error:${COLORS.RESET}`, err.message);
});