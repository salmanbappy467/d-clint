const axios = require('axios');
const cheerio = require('cheerio');
const qs = require('querystring');

// ==========================================
// 1-4.3. HELPER: INTERNAL LOGIN (NOT EXPORTED)
// ==========================================

async function login(userId, password) {
    const url = 'http://www.rebpbs.com/login.aspx';
    try {
        const initialPage = await axios.get(url);
        const $ = cheerio.load(initialPage.data);
        const initialCookies = initialPage.headers['set-cookie'] || [];

        const payload = {
            '__VIEWSTATE': $('#__VIEWSTATE').val(),
            '__VIEWSTATEGENERATOR': $('#__VIEWSTATEGENERATOR').val(),
            '__EVENTVALIDATION': $('#__EVENTVALIDATION').val(),
            'txtusername': userId,
            'txtpassword': password,
            'btnLogin': decodeURIComponent('%E0%A6%B2%E0%A6%97%E0%A6%87%E0%A6%A8')
        };

        const response = await axios.post(url, qs.stringify(payload), {
            headers: { 
                'Cookie': initialCookies.join('; '),
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            maxRedirects: 0,
            validateStatus: (status) => status >= 200 && status < 400
        });

        const authCookies = response.headers['set-cookie'] || [];
        // কুকি মার্জ করা (রিপিটেশন এড়ানো)
        return [...new Set([...initialCookies, ...authCookies])];
    } catch (error) {
        console.error("Login Error:", error.message);
        return null;
    }
}

// ==========================================
// 2. EXPORTED FUNCTIONS (CORE LOGIC)
// ==========================================

async function verifyLoginDetails({ userid, password }) {
    try {
        console.log(`🔐 Verifying Login for: ${userid}`);
        const cookies = await login(userid, password);
        
        if (!cookies || cookies.length === 0) {
            return { success: false, message: "Network Error: No cookies received" };
        }

        // ড্যাশবোর্ড চেক
        const dashUrl = 'http://www.rebpbs.com/UI/OnM/frm_OCMeterTesterDashboard.aspx';
        const response = await axios.get(dashUrl, { headers: { 'Cookie': cookies.join('; ') } });
        const $ = cheerio.load(response.data);

        const pbsName = $('#ctl00_lblPBSname').text().trim();
        const userInfo = $('#ctl00_lblLoggedUser').text().trim();

        // যদি PBS Name না পাওয়া যায়, তার মানে লগইন হয়নি
        if (!pbsName) {
            console.log("❌ Login Failed: Dashboard not accessible.");
            return { success: false, message: "Login Failed: Invalid Credentials" };
        }

        let zonalName = "Unknown Office";
        if (userInfo.includes(',')) {
            zonalName = userInfo.split(',').pop().replace(']', '').trim();
        }

        return { success: true, cookies, userInfo, pbs: pbsName, zonal: zonalName };
    } catch (error) {
        return { success: false, message: error.message };
    }
}

const DEFAULTS = {
    payMode: '1', manfId: '581', phase: '1', type: 'j-39',
    volt: '240', mult: '1', zero: '0', sealTxt: 'LS'
};

async function postMeterData(cookies, m, options = {}) {
    const url = 'http://www.rebpbs.com/UI/Setup/meterinfo_setup.aspx';
    const session = axios.create({
        headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': cookies.join('; '), 'Referer': url },
        timeout: 30000 
    });

    try {
        let newVS, newEV, pbs, zonal, gen;
        if (options.viewState) {
            newVS = options.viewState; newEV = options.eventValidation; gen = options.viewStateGen; pbs = options.pbs; zonal = options.zonal;
        } else {
            const page = await session.get(url);
            const $ = cheerio.load(page.data);
            pbs = $('#ctl00_ContentPlaceHolder1_txtPBSName').val();
            zonal = $('#ctl00_ContentPlaceHolder1_txtZonalName').val();
            newVS = $('#__VIEWSTATE').val();
            newEV = $('#__EVENTVALIDATION').val();
            gen = $('#__VIEWSTATEGENERATOR').val();
        }

        if (!pbs) return { success: false, sessionExpired: true, reason: "Session Expired" };

        const savePayload = qs.stringify({
            '__EVENTTARGET': '', '__EVENTARGUMENT': '', '__VIEWSTATEENCRYPTED': '',
            '__VIEWSTATE': newVS, '__VIEWSTATEGENERATOR': gen, '__EVENTVALIDATION': newEV,
            'ctl00$ContentPlaceHolder1$txtPBSName': pbs,
            'ctl00$ContentPlaceHolder1$txtZonalName': zonal,
            
            // 🔥 ফিক্সড: ডায়নামিক ভ্যালু চেকিং (ইনপুট থাকলে সেটি, না থাকলে ডিফল্ট)
            'ctl00$ContentPlaceHolder1$ddlMeterPaymentMode': String(m.paymentMode || DEFAULTS.payMode),
            'ctl00$ContentPlaceHolder1$ddlMANUFACTUREname': String(m.manufacturerId || DEFAULTS.manfId),
            'ctl00$ContentPlaceHolder1$ddlPhase': String(m.phase || DEFAULTS.phase),
            'ctl00$ContentPlaceHolder1$txtMETER_NO': String(m.meterNo),
            'ctl00$ContentPlaceHolder1$txtSEAL_NO': String(m.sealNo),
            'ctl00$ContentPlaceHolder1$txtBULK_METER_NO': DEFAULTS.zero,
            
            'ctl00$ContentPlaceHolder1$txtMETER_TYPE': m.meterType || DEFAULTS.type,
            'ctl00$ContentPlaceHolder1$txtVOLT': String(m.volt || DEFAULTS.volt),
            'ctl00$ContentPlaceHolder1$txtMULTIPLIER': DEFAULTS.mult,
            
            'ctl00$ContentPlaceHolder1$txtINITIAL_READING': m.initialReading || DEFAULTS.zero,
            'ctl00$ContentPlaceHolder1$txtDEMAND_READING': m.demandReading || DEFAULTS.zero,
            'ctl00$ContentPlaceHolder1$txtKWH_READING': m.kwhReading || DEFAULTS.zero,
            
            'ctl00$ContentPlaceHolder1$txtCT_DATA_MANUFACTURER': m.ctManufacturer || DEFAULTS.zero,
            'ctl00$ContentPlaceHolder1$txtCT_SERIAL_NO': DEFAULTS.zero,
            'ctl00$ContentPlaceHolder1$txtCT_RATIO': DEFAULTS.mult,
            'ctl00$ContentPlaceHolder1$txtCT_SEAL_NO': m.ctSeal || DEFAULTS.zero,
            
            'ctl00$ContentPlaceHolder1$txtPT_DATA_MANUFACTURER': DEFAULTS.zero,
            'ctl00$ContentPlaceHolder1$txtPT_SERIAL_NO': DEFAULTS.zero,
            'ctl00$ContentPlaceHolder1$txtPT_RATIO': DEFAULTS.mult,
            'ctl00$ContentPlaceHolder1$txtPT_SEAL_NO': DEFAULTS.zero,
            'ctl00$ContentPlaceHolder1$txtPT_MULTIPLYING_FACTOR': DEFAULTS.zero,
            
            'ctl00$ContentPlaceHolder1$txtBODY_SEAL': DEFAULTS.zero,
            'ctl00$ContentPlaceHolder1$txtTERMINAL': DEFAULTS.zero,
            'ctl00$ContentPlaceHolder1$txtBODY_SEAL1': m.bodySeal1 || DEFAULTS.sealTxt,
            'ctl00$ContentPlaceHolder1$txtTERMINAL2': DEFAULTS.zero,
            'ctl00$ContentPlaceHolder1$txtBODY_SEAL2': m.bodySeal2 || DEFAULTS.sealTxt,
            'ctl00$ContentPlaceHolder1$txtBODY_SEAL3': DEFAULTS.zero,
            
            'ctl00$ContentPlaceHolder1$ddlQMeterPaymentMode': '1',
            'ctl00$ContentPlaceHolder1$txtSearch': '',
            'ctl00$ContentPlaceHolder1$btSave': decodeURIComponent('%E0%A6%B8%E0%A6%82%E0%A6%B0%E0%A6%95%E0%A7%8D%E0%A6%B7%E0%A6%A3%20%E0%A6%95%E0%A6%B0%E0%A7%81%E0%A6%A8')
        });

        const finalRes = await session.post(url, savePayload);
        const $res = cheerio.load(finalRes.data);
        const lblMsg = $res('#ctl00_ContentPlaceHolder1_lblMsg').text().trim();
        
        const isSuccess = finalRes.data.includes('Successful') || finalRes.data.includes('Action was Successful');
        const isDuplicate = finalRes.data.includes('Already Exists') || lblMsg.includes('exists');
        
        return { success: isSuccess, reason: isSuccess ? "Saved Successfully" : (isDuplicate ? "Duplicate Meter" : (lblMsg || "Server Rejected")), isDuplicate };
    } catch (e) { return { success: false, reason: e.message }; }
}

async function fetchInventoryInternal(cookies, limit) {
    const url = 'http://www.rebpbs.com/UI/OfficeAutomation/Monitoring/EngineeringAndMaintenance/frmMeterInventoryMonitoring.aspx';
    const session = axios.create({ headers: { 'Cookie': cookies.join('; ') } });
    let allMeters = [];
    let currentPage = 1;

    try {
        const res = await session.get(url);
        let $ = cheerio.load(res.data);
        
        if ($('#txtusername').length > 0) {
            console.log("⚠️ Redirected to Login Page!");
            return [];
        }
        if ($('#ctl00_ContentPlaceHolder1_gvMeterLOG').length === 0) {
            console.log("⚠️ Table not found (Maybe no records).");
        }

        const parse = ($) => {
            const list = [];
            $('#ctl00_ContentPlaceHolder1_gvMeterLOG tr').each((i, el) => {
                if (i === 0) return;
                const cols = $(el).children('td');
                if (cols.length >= 9) {
                    const mNo = $(cols[1]).text().trim();
                    if (mNo.length > 3) list.push({ brand: $(cols[0]).text().trim(), meterNo: mNo, status: $(cols[2]).text().trim(), cmo: $(cols[5]).text().trim().replace(/&nbsp;/g, '') || "N/A", seal: $(cols[6]).text().trim(), date: $(cols[8]).text().trim() });
                }
            });
            return list;
        };
        allMeters = parse($);
        while (allMeters.length < limit) {
            currentPage++;
            try {
                const payload = { '__EVENTTARGET': 'ctl00$ContentPlaceHolder1$gvMeterLOG', '__EVENTARGUMENT': `Page$${currentPage}`, '__VIEWSTATE': $('#__VIEWSTATE').val(), '__EVENTVALIDATION': $('#__EVENTVALIDATION').val(), '__VIEWSTATEGENERATOR': $('#__VIEWSTATEGENERATOR').val() };
                const nextRes = await session.post(url, qs.stringify(payload));
                $ = cheerio.load(nextRes.data);
                const newMeters = parse($);
                if (newMeters.length === 0) break;
                allMeters = allMeters.concat(newMeters);
            } catch(e) { break; }
        }
        return allMeters.slice(0, limit);
    } catch (e) { return allMeters; }
}

async function getInventoryList({ userid, password, limit }) {
    console.log(`📋 Fetching Inventory for: ${userid}`);
    
    const auth = await verifyLoginDetails({ userid, password });
    if (!auth.success) {
        console.log(`❌ Inventory Fetch Aborted: ${auth.message}`);
        return { count: 0, data: [], error: auth.message };
    }
    
    const list = await fetchInventoryInternal(auth.cookies, limit || 50);
    return { count: list.length, data: list };
}

async function processBatch({ userid, password, meters }) {
    console.log(`📦 Batch Process: ${meters.length} meters`);
    const auth = await verifyLoginDetails({ userid, password });
    if (!auth.success) return { status: "error", message: auth.message };
    const results = [];
    let failed = 0;
    for (const m of meters) {
        const res = await postMeterData(auth.cookies, m);
        if (!res.success && !res.isDuplicate) failed++;
        results.push({ meterNo: m.meterNo, status: res.success ? "SUCCESS" : "FAILED", reason: res.reason });
        await new Promise(r => setTimeout(r, 1000));
    }
    return { status: "completed", count: meters.length, failed, data: results };
}

async function processConcurrentBatch({ userid, password, meters }) {
    console.log(`🚀 Fast Process: ${meters.length} meters`);
    const auth = await verifyLoginDetails({ userid, password });
    if (!auth.success) return { status: "error", message: auth.message };
    const url = 'http://www.rebpbs.com/UI/Setup/meterinfo_setup.aspx';
    let tokens = {};
    try {
        const page = await axios.get(url, { headers: { 'Cookie': auth.cookies.join('; ') } });
        const $ = cheerio.load(page.data);
        tokens = { viewState: $('#__VIEWSTATE').val(), eventValidation: $('#__EVENTVALIDATION').val(), viewStateGen: $('#__VIEWSTATEGENERATOR').val(), pbs: $('#ctl00_ContentPlaceHolder1_txtPBSName').val(), zonal: $('#ctl00_ContentPlaceHolder1_txtZonalName').val() };
    } catch(e) { return { status: "error", message: "Token fetch failed" }; }
    let results = [];
    const CHUNK_SIZE = 5;
    for (let i = 0; i < meters.length; i += CHUNK_SIZE) {
        const chunk = meters.slice(i, i + CHUNK_SIZE);
        const promises = chunk.map(m => postMeterData(auth.cookies, m, tokens).then(res => ({ meterNo: m.meterNo, status: res.success ? "SUCCESS" : "FAILED", reason: res.reason })));
        results = results.concat(await Promise.all(promises));
    }
    return { status: "completed_chunked", count: meters.length, data: results };
}

// ==========================================
// 3. MAIN RUN FUNCTION
// ==========================================

async function run(payload) {
    const action = payload.action ? payload.action.toUpperCase() : 'CHECK';
    console.log(`▶ Executing Action: ${action}`);

    switch (action) {
        case 'LOGIN':
        case 'LOGIN_CHECK':
        case 'CHECK':
        case 'VERIFY':
        case 'VERIFYLOGINDETAILS':
            return await verifyLoginDetails(payload);
        
        case 'INVENTORY':
        case 'LIST':
        case 'GETINVENTORYLIST':
        case 'INVENTORY_LIST':
            return await getInventoryList(payload);

        case 'POST':
        case 'METER_POST':
        case 'BATCH':
        case 'PROCESSBATCH':
            return await processBatch(payload);

        case 'FAST':
        case 'FAST_POST':
        case 'CONCURRENT':
        case 'PROCESSCONCURRENTBATCH':
            return await processConcurrentBatch(payload);

        default:
            return { error: `Unknown Action: ${action}. Please specify a valid action.` };
    }
}

module.exports = {
    run, 
    verifyLoginDetails,
    getInventoryList,
    processBatch,
    processConcurrentBatch
};

