// index.js
require('dotenv').config();
const io = require('socket.io-client');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// কনফিগারেশন
const SERVER_URL = process.env.SERVER_URL || "http://localhost:3000"; // সার্ভারের আইপি
const MACHINE_ID = process.env.MACHINE_ID || "PC-01";
const API_KEY = process.env.API_KEY; // PBSNet API Key

if (!API_KEY) {
    console.error("❌ Error: API_KEY is missing in .env file");
    process.exit(1);
}

// Logic File পাথ
const LOGIC_PATH = path.join(__dirname, 'logic.js');

// 1. সার্ভারে কানেকশন
console.log(`🔌 Connecting to Server: ${SERVER_URL}`);
const socket = io(SERVER_URL, {
    query: { type: 'worker' },
    auth: { 
        machineId: MACHINE_ID,
        apiKey: API_KEY
    },
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 2000
});

// 2. কানেকশন ইভেন্ট হ্যান্ডলার
socket.on('connect', () => {
    console.log(`✅ Connected as ${MACHINE_ID}`);
    checkLogicVersion(); // কানেক্ট হলে লজিক ফাইল চেক করবে
});

socket.on('connect_error', (err) => {
    console.log(`❌ Connection Error: ${err.message}`);
});

socket.on('disconnect', () => {
    console.log("⚠️ Disconnected from server");
});

// 3. লজিক ফাইল সিঙ্কিং (Auto Update)
function getLocalLogicHash() {
    try {
        if (!fs.existsSync(LOGIC_PATH)) return null;
        const content = fs.readFileSync(LOGIC_PATH);
        return crypto.createHash('md5').update(content).digest('hex');
    } catch (e) { return null; }
}

function checkLogicVersion() {
    const hash = getLocalLogicHash();
    socket.emit('check_version', hash); // সার্ভারকে হ্যাশ পাঠাবে
}

socket.on('update_logic_file', (data) => {
    console.log("📥 Downloading new logic file from server...");
    try {
        fs.writeFileSync(LOGIC_PATH, data.content); // নতুন ফাইল সেভ
        delete require.cache[require.resolve(LOGIC_PATH)]; // মেমোরি ক্লিয়ার
        console.log("✅ Logic file updated successfully!");
        socket.emit('logic_uptodate');
        
        // ফাইল আপডেট হলে ওয়ার্কার রেডি সিগন্যাল দিবে
        socket.emit('worker_ready');
    } catch (e) {
        console.error("❌ Failed to update logic file:", e.message);
    }
});

socket.on('logic_uptodate', () => {
    console.log("⚡ Logic is up-to-date. Waiting for tasks...");
    socket.emit('worker_ready'); // কাজ নিতে প্রস্তুত
});


// 4. টাস্ক এক্সিকিউশন (Task Handler)
socket.on('execute_task', async (job) => {
    console.log(`🚀 New Task Received: ${job.taskType} [ID: ${job.requestId}]`);
    
    // লজিক ফাইল লোড করা (ডাইনামিক)
    let logic;
    try {
        if (!fs.existsSync(LOGIC_PATH)) throw new Error("Logic file missing!");
        logic = require('./logic.js');
    } catch (e) {
        return sendResult(job.requestId, { error: "Logic Module Error: " + e.message });
    }

    try {
        let result;
        const { payload } = job;

        // টাস্ক অনুযায়ী ফাংশন কল
        switch (job.taskType) {
            case 'LOGIN_CHECK':
                result = await logic.verifyLoginDetails(payload.userid, payload.password);
                break;

            case 'METER_POST': // স্লো/সিকুয়েন্সিয়াল
                result = await logic.processBatch(
                    payload.userid, 
                    payload.password, 
                    payload.meters,
                    (progress) => sendProgress(job.requestId, progress) // লাইভ প্রগ্রেস আপডেট
                );
                break;

            case 'FAST_POST': // প্যারালাল/ফাস্ট
                result = await logic.processConcurrentBatch(
                    payload.userid, 
                    payload.password, 
                    payload.meters,
                    (progress) => sendProgress(job.requestId, progress)
                );
                break;

            case 'SINGLE_CHECK': // সিঙ্গেল মিটার ভেরিফাই
                // (যদি logic.js এ verifyMeter থাকে)
                 const auth = await logic.verifyLoginDetails(payload.userid, payload.password);
                 if(auth.success) {
                     result = await logic.verifyMeter(auth.cookies, payload.meterNo);
                 } else {
                     result = { error: "Login Failed" };
                 }
                break;
                
            case 'INVENTORY': // ইনভেন্টরি লিস্ট
                const invAuth = await logic.verifyLoginDetails(payload.userid, payload.password);
                if(invAuth.success) {
                    const list = await logic.getInventoryList(invAuth.cookies, payload.limit || 50);
                    result = { count: list.length, data: list };
                } else {
                    result = { error: invAuth.message };
                }
                break;

            default:
                throw new Error("Unknown Task Type: " + job.taskType);
        }

        // কাজ শেষে রেজাল্ট পাঠানো
        sendResult(job.requestId, result);

    } catch (error) {
        console.error("Task Execution Error:", error);
        sendResult(job.requestId, { error: error.message, stack: error.stack });
    }
});

// হেল্পার ফাংশন
function sendProgress(requestId, progress) {
    socket.emit('task_progress', { requestId, progress });
    // কনসোলে প্রগ্রেস প্রিন্ট (অপশনাল)
    // console.log(`⏳ Progress: ${progress.current}/${progress.total} - ${progress.status}`);
}

function sendResult(requestId, result) {
    console.log(`🏁 Task Completed [ID: ${requestId}]`);
    socket.emit('task_completed', { requestId, result });
}