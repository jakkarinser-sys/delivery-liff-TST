// ===== CONFIG =====
const SHEET_ID          = '1FJ06GF6Jsbf-kkO94bWP5UlIjL-rcyWvzNILIq-gaB8';
const LIFF_ID           = '2009553396-cEG6A3LK';

const LINE_CHANNEL_TOKEN = 'XFp90k30M9bhcRs/Q/zi1hwECzeqdxPaqQahiSXrwXtkwR4ybvfNw4Q5jT2TfS1i4j7CZ1XsaxD/QCYrywTgeUcB51oYeIuElbbo9zcdO/o+iXFZsvkaJj8J6fvHiqh7xjLJk/F2K0O30D8i7okMmAdB04t89/1O/w1cDnyilFU=';
const SUPERVISOR_USER_ID = 'U6c5d09a20c85cf011935fa91fac05f15';
const GROUP_ID           = 'C2c67b82c0843b60f096aeba09af86747';

// Sheet names
const SH_PLAN    = 'Logistic_Plan';
const SH_LOG     = 'TripLog';
const SH_DRIVERS = 'Driver Name';

// ===== MAIN ROUTER =====
function doGet(e) {
  let res;

  try {
    const p    = e.parameter;
    const path = p.action || '';

    if      (path === 'plans')      res = getPlans(p);
    else if (path === 'tripState')  res = getTripState(p);
    else if (path === 'history')    res = getHistory(p);
    else if (path === 'summary')    res = getSummary(p);
    else if (path === 'depart')     res = recordDepart(p);
    else if (path === 'arrive')     res = recordArrive(p);
    else if (path === 'return')     res = recordReturn(p);
    else if (path === 'complete')   res = recordComplete(p);
    else                            res = { error: 'Unknown action' };
  } catch (err) {
    Logger.log('doGet error: ' + err.message + '\nStack: ' + err.stack);
    res = { error: err.message };
  }

  return ContentService.createTextOutput(JSON.stringify(res))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===== GET TRIP STATE (เช็ค session ที่ค้างอยู่) =====
// GET ?action=tripState&planId=WLTST2603053
// ใช้ตอน LIFF โหลดกลับมา — ดึงข้อมูลที่บันทึกไปแล้วกลับมาต่อ
function getTripState({ planId }) {
  const ss    = SpreadsheetApp.openById(SHEET_ID);
  const logSh = ss.getSheetByName(SH_LOG);
  const allShopsArrived = checkAllShopsArrived(ss, logSh, planId);
  const row   = findTripRow(logSh, planId);
  if (!row) return { status: 'pending', allShopsArrived };

  const r      = logSh.getRange(row, 1, 1, 28).getValues()[0];
  const tz     = Session.getScriptTimeZone();
  const fmt    = (v) => v ? Utilities.formatDate(new Date(v), tz, 'HH:mm') : null;
  return {
    status        : r[13] || 'pending',
    allShopsArrived,
    departTime    : fmt(r[3]),
    departOdo     : r[4]  || null,
    arriveTime    : fmt(r[5]),
    arriveOdo     : r[6]  || null,
    distance      : r[7]  || null,
    returnTime    : fmt(r[16]),   // Q — เวลาออกจากร้าน (กำลังกลับ)
    returnOdo     : r[17] || null,// R — ไมล์ออกจากร้าน
    completeTime  : fmt(r[23]),   // X — เวลาถึงบริษัท
    completeOdo   : r[24] || null // Y — ไมล์ถึงบริษัท
  };
}

// ตรวจสอบว่าทุกร้านในเที่ยวนี้ถึงแล้วหรือยัง
function checkAllShopsArrived(ss, logSh, planId) {
  try {
    const basePlanId = String(planId).split('_')[0];
    const planSh     = ss.getSheetByName(SH_PLAN);
    if (!planSh) return false;
    const planData = planSh.getDataRange().getValues();
    const planRow  = planData.find(r => String(r[0]) === basePlanId);
    if (!planRow) return false;
    const shopCount = String(planRow[6] || '').split(',').filter(s => s.trim()).length || 1;
    const logData   = logSh.getDataRange().getValues();
    let arrivedCount = 0;
    for (let i = 0; i < shopCount; i++) {
      const searchId = shopCount === 1 ? basePlanId : `${basePlanId}_${i}`;
      const logRow   = logData.find(r => String(r[0]) === searchId);
      if (logRow && ['arrived','returning','completed'].includes(String(logRow[13]))) arrivedCount++;
    }
    return arrivedCount >= shopCount;
  } catch(e) { return false; }
}

// ===== GET PLANS =====
// GET ?action=plans&date=2026-03-19&lineUserId=Uxxxx
// ช่อง "ร้านค้า" อาจมีหลายร้านคั่นด้วย "," → split เป็น shopItems แยกกัน
// แต่ละ shopItem ใช้ key = PlanID + "_" + shopIndex เช่น WLTST2603073_0, WLTST2603073_1
function getPlans({ date, lineUserId }) {
  const ss     = SpreadsheetApp.openById(SHEET_ID);
  const planSh = ss.getSheetByName(SH_PLAN);
  const logSh  = ss.getSheetByName(SH_LOG);
  if (!planSh) throw new Error(`ไม่พบชีตชื่อ ${SH_PLAN}`);

  const driverName = getDriverName(ss, lineUserId);
  const planData = planSh.getDataRange().getValues();

  const COL_PLANID = 0;  // A
  const COL_DATE   = 1;  // B
  const COL_DRIVER = 3;  // D
  const COL_TRIPNO = 4;  // E
  const COL_TYPE   = 5;  // F
  const COL_SHOP   = 6;  // G
  const COL_DIST   = 7;  // H

  const plans = [];

  planData.slice(1).forEach((r, idx) => {
    try {
      let rowDateValue = r[COL_DATE];
      if (!(rowDateValue instanceof Date)) rowDateValue = new Date(rowDateValue);
      if (isNaN(rowDateValue.getTime())) return;

      const rowDate    = Utilities.formatDate(rowDateValue, Session.getScriptTimeZone(), 'yyyy-MM-dd');
      const cellDriver = String(r[COL_DRIVER] || '');
      if (rowDate !== date || !cellDriver.includes(driverName)) return;

      const planId  = r[COL_PLANID];
      const shopRaw = String(r[COL_SHOP] || '');
      const shops   = shopRaw.split(',').map(s => s.trim()).filter(Boolean);

      shops.forEach((shopName, si) => {
        const itemId = shops.length > 1 ? `${planId}_${si}` : planId;
        plans.push({
          itemId,
          planId,
          shopIndex : si,
          shopTotal : shops.length,
          shop      : shopName,
          tripNo    : r[COL_TRIPNO],
          type      : r[COL_TYPE],
          dist      : r[COL_DIST],
          status    : getTripStatus(logSh, itemId)
        });
      });
    } catch (e) {
      Logger.log(`Error at row ${idx + 2}: ${e.message}`);
    }
  });

  return { plans, driverName };
}

// ===== COOLDOWN CHECK (10 นาที) =====
function minutesSince(dateStr) {
  if (!dateStr) return 9999;
  try {
    const past = new Date(dateStr);
    return (new Date() - past) / 60000;
  } catch(e) { return 9999; }
}

// ===== RECORD DEPART =====
function recordDepart({ planId, lineUserId, lineDisplayName, shop, odo, lat, lng, note }) {
  const ss    = SpreadsheetApp.openById(SHEET_ID);
  const logSh = ss.getSheetByName(SH_LOG);

  // ถ้ามี row แล้ว → ห้ามบันทึกซ้ำ คืน state ที่มีอยู่กลับไปแทน
  const existingRow = findTripRow(logSh, planId);
  if (existingRow) {
    const status = logSh.getRange(existingRow, 14).getValue();
    return { success: false, alreadyRecorded: true, status,
             error: `บันทึกออกเดินทางไปแล้ว (status: ${status})` };
  }

  const now = new Date();
  const mapsDepart = (lat && lng) ? `https://maps.google.com/?q=${lat},${lng}` : '';
  logSh.appendRow([
    planId,
    lineUserId,
    lineDisplayName,
    Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss'),
    odo,          // E — DepartOdo
    '',           // F — ArriveTime
    '',           // G — ArriveOdo
    '',           // H — Distance
    lat, lng,     // I J — GPS ออก
    '', '',       // K L — GPS ถึง
    note || '',   // M — Note
    'departed',   // N — Status
    shop || '',   // O — ShopName
    '',           // P — ความเร็วเฉลี่ย
    '',           // Q — เวลากลับบริษัท
    '',           // R — เลขไมล์กลับ
    '', '',       // S T — GPS กลับ
    mapsDepart,   // U — Maps link ออก
    '',           // V — Maps link ถึงร้าน
    '',           // W — Maps link ออกจากร้าน (กำลังกลับ)
    '',           // X — เวลาถึงบริษัท
    '',           // Y — ไมล์ถึงบริษัท
    '',           // Z — GPS ถึงบริษัท(Lat)
    '',           // AA — GPS ถึงบริษัท(Lng)
    ''            // AB — Maps ถึงบริษัท
  ]);

  // แจ้งกลุ่มว่าออกเดินทางแล้ว
  const driverName = getDriverName(ss, lineUserId);
  const departTimeStr = Utilities.formatDate(now, Session.getScriptTimeZone(), 'HH:mm');
  const planData = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SH_PLAN).getDataRange().getValues();
  const planRow  = planData.find(r => String(r[0]) === String(planId).split('_')[0]);
  const tripNo   = planRow ? planRow[4] : '-';

  notifyGroup([{
    type   : 'flex',
    altText: `🚗 ${driverName} กำลังเดินทางไป ${shop}`,
    contents: {
      type: 'bubble',
      header: {
        type:'box', layout:'vertical',
        backgroundColor:'#1565C0', paddingAll:'14px',
        contents:[{ type:'text', text:'🚗 กำลังเดินทางแล้ว', weight:'bold', color:'#ffffff', size:'md' }]
      },
      body: {
        type:'box', layout:'vertical', spacing:'sm', paddingAll:'14px',
        contents:[
          infoRow('👤 พนักงาน',    driverName),
          infoRow('🔢 เที่ยวที่',   String(tripNo)),
          infoRow('📋 Plan ID',    String(planId).split('_')[0]),
          infoRow('🏪 มุ่งหน้าไป', shop || '-'),
          infoRow('🕐 เวลาออก',    `${departTimeStr} น.`),
          infoRow('🔢 ไมล์ออก',    `${odo} km`),
          mapsDepart ? { type:'button', style:'link', height:'sm',
            action:{ type:'uri', label:'📍 ดูพิกัดออก', uri: mapsDepart }} : null
        ].filter(Boolean)
      }
    }
  }]);

  return { success: true, departTime: now.toISOString() };
}

// ===== RECORD ARRIVE =====
function recordArrive({ planId, lineUserId, odo, lat, lng, note }) {
  const ss    = SpreadsheetApp.openById(SHEET_ID);
  const logSh = ss.getSheetByName(SH_LOG);

  const row = findTripRow(logSh, planId);
  if (!row) return { success: false, error: 'ไม่พบข้อมูลออกเดินทาง กรุณากด "ออกจากต้นทาง" ก่อน' };

  // ถ้า arrive ไปแล้ว → ห้ามบันทึกซ้ำ
  const currentStatus = logSh.getRange(row, 14).getValue();
  if (currentStatus === 'arrived' || currentStatus === 'completed') {
    return { success: false, alreadyRecorded: true, status: currentStatus,
             error: `บันทึกถึงปลายทางไปแล้ว (status: ${currentStatus})` };
  }

  const now        = new Date();
  const departOdo  = parseFloat(logSh.getRange(row, 5).getValue()) || 0;
  const distance   = odo - departOdo;
  const rowData    = logSh.getRange(row, 1, 1, 16).getValues()[0];
  const storedUid  = rowData[1];
  const shopName   = rowData[14] || planId;
  const driverName = getDriverName(ss, storedUid);

  // เวลาออกจากต้นทาง (คอลัมน์ D)
  const departTimeRaw = rowData[3];
  const departTime = departTimeRaw
    ? Utilities.formatDate(new Date(departTimeRaw), Session.getScriptTimeZone(), 'HH:mm')
    : '?';

  // คำนวณความเร็วเฉลี่ย km/h
  let avgSpeed = null;
  if (departTimeRaw && distance > 0) {
    const diffMs  = now.getTime() - new Date(departTimeRaw).getTime();
    const diffHrs = diffMs / (1000 * 60 * 60);
    if (diffHrs > 0) avgSpeed = (distance / diffHrs).toFixed(1);
  }

  const arriveTimeStr = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  logSh.getRange(row, 6).setValue(arriveTimeStr);
  logSh.getRange(row, 7).setValue(odo);
  logSh.getRange(row, 8).setValue(distance > 0 ? distance : '');
  logSh.getRange(row, 11).setValue(lat);
  logSh.getRange(row, 12).setValue(lng);
  if (note) logSh.getRange(row, 13).setValue(note);
  logSh.getRange(row, 14).setValue('arrived');
  if (avgSpeed) logSh.getRange(row, 16).setValue(parseFloat(avgSpeed)); // P
  const mapsArrive = (lat && lng) ? `https://maps.google.com/?q=${lat},${lng}` : '';
  if (mapsArrive) logSh.getRange(row, 22).setValue(mapsArrive);         // V

  // แจ้ง Supervisor ผ่าน LINE Notify
  notifySupervisor({
    driverName, planId, shopName,
    departTime,
    arriveTime : Utilities.formatDate(now, Session.getScriptTimeZone(), 'HH:mm'),
    distance   : distance > 0 ? distance.toFixed(1) : '?',
    avgSpeed   : avgSpeed || '?',
    lat, lng
  });

  return { success: true, arriveTime: now.toISOString(), distance };
}

// ===== LINE MESSAGING API — แจ้ง Supervisor =====
function notifySupervisor({ driverName, planId, shopName, departTime, arriveTime, distance, avgSpeed, lat, lng }) {
  if (!LINE_CHANNEL_TOKEN || LINE_CHANNEL_TOKEN === 'YOUR_CHANNEL_ACCESS_TOKEN') return;

  const mapLink = (lat && lng && lat !== 'null' && lng !== 'null')
    ? `https://maps.google.com/?q=${lat},${lng}`
    : null;

  // สร้าง Flex Message ให้ดูสวยงามบนมือถือ
  const bubbleBody = [
    { type:'text', text:'✅ ถึงร้านแล้ว', weight:'bold', size:'lg', color:'#06C755' },
    { type:'separator', margin:'sm' },
    infoRow('👤 พนักงาน',  driverName),
    infoRow('📋 Plan ID',   planId),
    infoRow('🏪 ร้านค้า',   shopName),
    infoRow('🚀 เวลาออก',      `${departTime} น.`),
    infoRow('🏁 เวลาถึง',      `${arriveTime} น.`),
    infoRow('📏 ระยะทาง',      `${distance} km`),
    infoRow('⚡ ความเร็วเฉลี่ย', `${avgSpeed} km/h`),
  ];

  if (mapLink) {
    bubbleBody.push({ type:'separator', margin:'sm' });
    bubbleBody.push({
      type:'button', style:'link', height:'sm',
      action:{ type:'uri', label:'📍 ดูแผนที่', uri: mapLink }
    });
  }

  const messages = [];

  messages.push({
    type   : 'flex',
    altText: `✅ ${driverName} ถึงร้านแล้ว — ${shopName}`,
    contents: {
      type: 'bubble',
      body: { type:'box', layout:'vertical', spacing:'sm', contents: bubbleBody }
    }
  });

  notifyGroup(messages);
}

// ── ส่งข้อความเข้ากลุ่ม (ใช้ร่วมกันทุก notification) ──
function notifyGroup(messages) {
  if (!LINE_CHANNEL_TOKEN || LINE_CHANNEL_TOKEN === 'YOUR_CHANNEL_ACCESS_TOKEN') return;
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method     : 'post',
    contentType: 'application/json',
    headers    : { Authorization: `Bearer ${LINE_CHANNEL_TOKEN}` },
    payload    : JSON.stringify({ to: GROUP_ID || SUPERVISOR_USER_ID, messages }),
    muteHttpExceptions: true
  });
}

// helper สร้าง row ข้อความ key-value
function infoRow(label, value) {
  return {
    type:'box', layout:'horizontal', margin:'sm',
    contents:[
      { type:'text', text: label, size:'sm', color:'#888888', flex:3 },
      { type:'text', text: value, size:'sm', color:'#333333', flex:5, wrap:true }
    ]
  };
}

// ===== RECORD RETURN (กลับบริษัท = กำลังเดินทางกลับ) =====
function recordReturn({ planId, lineUserId, odo, lat, lng }) {
  const ss    = SpreadsheetApp.openById(SHEET_ID);
  const logSh = ss.getSheetByName(SH_LOG);

  const row = findTripRow(logSh, planId);
  if (!row) return { success: false, error: 'ไม่พบข้อมูล' };

  const currentStatus = logSh.getRange(row, 14).getValue();
  if (currentStatus === 'returning' || currentStatus === 'completed') {
    return { success: false, alreadyRecorded: true, status: currentStatus,
             error: `บันทึกกลับบริษัทไปแล้ว` };
  }

  const now     = new Date();
  const timeStr = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  const mapsReturn = (lat && lng) ? `https://maps.google.com/?q=${lat},${lng}` : '';

  logSh.getRange(row, 14).setValue('returning');
  logSh.getRange(row, 17).setValue(timeStr);          // Q — เวลาออกจากร้าน
  if (odo) logSh.getRange(row, 18).setValue(odo);     // R — ไมล์ออกจากร้าน
  if (lat) logSh.getRange(row, 19).setValue(lat);     // S
  if (lng) logSh.getRange(row, 20).setValue(lng);     // T
  if (mapsReturn) logSh.getRange(row, 23).setValue(mapsReturn); // W

  const rowData    = logSh.getRange(row, 1, 1, 23).getValues()[0];
  const driverName = getDriverName(ss, rowData[1]);
  const timeDisplay = Utilities.formatDate(now, Session.getScriptTimeZone(), 'HH:mm');

  // ── ดึงลำดับร้านทั้งหมดของ PlanID นี้จาก TripLog ──
  const basePlanId = String(planId).split('_')[0];
  const allRows    = logSh.getDataRange().getValues();
  const shopList   = [];
  allRows.forEach((r, i) => {
    if (i === 0) return;
    const rid = String(r[0]).split('_')[0];
    if (rid === basePlanId && r[14]) {
      const arrTime = r[5] ? Utilities.formatDate(new Date(r[5]), Session.getScriptTimeZone(), 'HH:mm') : '';
      shopList.push({ shop: r[14], arrTime });
    }
  });
  shopList.sort((a, b) => a.arrTime > b.arrTime ? 1 : -1);

  // สร้าง contents ลำดับร้าน
  const shopContents = shopList.map((s, i) => ({
    type:'box', layout:'horizontal', spacing:'sm',
    contents:[
      { type:'text', text:`${i+1}.`, size:'xs', color:'#888888', flex:0 },
      { type:'text', text:s.shop, size:'xs', color:'#333333', flex:3, wrap:true },
      { type:'text', text:s.arrTime ? `${s.arrTime} น.` : '', size:'xs', color:'#06C755', flex:2, align:'end' }
    ]
  }));

  notifyGroup([{
    type   : 'flex',
    altText: `🔄 ${driverName} กำลังเดินทางกลับบริษัท`,
    contents: {
      type: 'bubble',
      header: {
        type:'box', layout:'vertical',
        backgroundColor:'#FF8F00', paddingAll:'14px',
        contents:[{ type:'text', text:'🔄 กำลังเดินทางกลับบริษัท', weight:'bold', color:'#ffffff', size:'md' }]
      },
      body: {
        type:'box', layout:'vertical', spacing:'sm', paddingAll:'14px',
        contents:[
          infoRow('👤 พนักงาน',        driverName),
          infoRow('📋 Plan ID',        basePlanId),
          infoRow('🕐 เวลาออกจากร้าน', `${timeDisplay} น.`),
          infoRow('🔢 ไมล์ออกจากร้าน', odo ? `${odo} km` : '-'),
          // ── ลำดับร้านที่ส่ง ──
          shopContents.length > 0 ? {
            type:'box', layout:'vertical', spacing:'xs',
            margin:'md',
            contents:[
              { type:'text', text:'📦 ลำดับการส่ง', size:'xs', weight:'bold', color:'#FF8F00' },
              ...shopContents
            ]
          } : null,
          mapsReturn ? { type:'button', style:'link', height:'sm',
            action:{ type:'uri', label:'📍 ดูพิกัด', uri: mapsReturn }} : null
        ].filter(Boolean)
      }
    }
  }]);

  return { success: true, returnTime: now.toISOString() };
}

// ===== RECORD COMPLETE (ถึงบริษัท) =====
function recordComplete({ planId, lineUserId, odo, lat, lng }) {
  const ss    = SpreadsheetApp.openById(SHEET_ID);
  const logSh = ss.getSheetByName(SH_LOG);

  const row = findTripRow(logSh, planId);
  if (!row) return { success: false, error: 'ไม่พบข้อมูล' };

  const now     = new Date();
  const timeStr = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  const mapsComplete = (lat && lng) ? `https://maps.google.com/?q=${lat},${lng}` : '';

  logSh.getRange(row, 14).setValue('completed');
  logSh.getRange(row, 24).setValue(timeStr);            // X — เวลาถึงบริษัท
  if (odo) logSh.getRange(row, 25).setValue(odo);       // Y — ไมล์ถึงบริษัท
  if (lat) logSh.getRange(row, 26).setValue(lat);       // Z
  if (lng) logSh.getRange(row, 27).setValue(lng);       // AA
  if (mapsComplete) logSh.getRange(row, 28).setValue(mapsComplete); // AB

  const rowData    = logSh.getRange(row, 1, 1, 24).getValues()[0];
  const driverName = getDriverName(ss, rowData[1]);
  const shopName   = rowData[14] || planId;
  const timeDisplay = Utilities.formatDate(now, Session.getScriptTimeZone(), 'HH:mm');
  // คำนวณเวลาใช้ในการเดินทางกลับ
  const returnTimeRaw2 = rowData[16];
  let travelBack = '-';
  if (returnTimeRaw2) {
    const mins = Math.round((now - new Date(returnTimeRaw2)) / 60000);
    travelBack = `${mins} นาที`;
  }

  notifyGroup([{
    type   : 'flex',
    altText: `🏢 ${driverName} ถึงบริษัทแล้ว`,
    contents: {
      type: 'bubble',
      header: {
        type:'box', layout:'vertical',
        backgroundColor:'#757575', paddingAll:'14px',
        contents:[{ type:'text', text:'🏢 ถึงบริษัทแล้ว', weight:'bold', color:'#ffffff', size:'md' }]
      },
      body: {
        type:'box', layout:'vertical', spacing:'sm', paddingAll:'14px',
        contents:[
          infoRow('👤 พนักงาน',        driverName),
          infoRow('📋 Plan ID',        String(planId).split('_')[0]),
          infoRow('🕐 เวลาถึงบริษัท',  `${timeDisplay} น.`),
          infoRow('🔢 ไมล์ถึงบริษัท',  odo ? `${odo} km` : '-'),
          infoRow('⏱ เวลาเดินทางกลับ', travelBack),
          mapsComplete ? { type:'button', style:'link', height:'sm',
            action:{ type:'uri', label:'📍 ดูพิกัดถึงบริษัท', uri: mapsComplete }} : null
        ].filter(Boolean)
      }
    }
  }]);

  return { success: true, completeTime: now.toISOString() };
}

// ===== GET HISTORY =====
function getHistory({ lineUserId, date }) {
  try {
    const ss    = SpreadsheetApp.openById(SHEET_ID);
    const logSh = ss.getSheetByName(SH_LOG);
    if (!logSh) return { logs: [] };

    const data = logSh.getDataRange().getValues();
    const logs = data.slice(1)
      .filter(r => r[1] === lineUserId)
      .filter(r => {
        if (!date) return true;
        if (!r[3]) return false;
        const logDate = (r[3] instanceof Date)
          ? Utilities.formatDate(r[3], Session.getScriptTimeZone(), 'yyyy-MM-dd')
          : String(r[3]);
        return logDate.startsWith(date);
      })
      .map(r => ({
        planId     : r[0],
        driverName : r[2],
        departTime : r[3],
        departOdo  : r[4],
        arriveTime : r[5],
        arriveOdo  : r[6],
        distance   : r[7],
        status     : r[13]
      }));

    return { logs };
  } catch (err) {
    Logger.log('getHistory error: ' + err.message);
    return { logs: [], error: err.message };
  }
}

// ===== GET SUMMARY =====
function getSummary({ date }) {
  const ss    = SpreadsheetApp.openById(SHEET_ID);
  const logSh = ss.getSheetByName(SH_LOG);
  const data  = logSh.getDataRange().getValues();

  const rows = data.slice(1).filter(r => r[3].toString().startsWith(date));
  const total = rows.reduce((s, r) => s + (parseFloat(r[7]) || 0), 0);

  return {
    date,
    count    : rows.length,
    totalDist: total.toFixed(1),
    rows     : rows.map(r => ({
      planId    : r[0],
      driver    : r[2],
      shop      : r[14] || r[0],
      depart    : r[3],
      arrive    : r[5],
      distance  : r[7],
      status    : r[13]
    }))
  };
}

// ===== HELPERS =====
function findTripRow(sh, planId) {
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === planId) return i + 1; // 1-indexed
  }
  return null;
}

function getTripStatus(logSh, planId) {
  const row = findTripRow(logSh, planId);
  if (!row) return 'pending';
  return logSh.getRange(row, 14).getValue() || 'pending';
}

function getDriverName(ss, lineUserId) {
  const sh   = ss.getSheetByName(SH_DRIVERS);
  if (!sh) return lineUserId;
  const data = sh.getDataRange().getValues();
  // Driver Name sheet: A=รหัสพนักงาน, B=ชื่อพนักงาน, C=LineUserId, D=Phone
  for (let i = 1; i < data.length; i++) {
    if (data[i][2] === lineUserId) return data[i][1]; // C=LineUserId, B=ชื่อ
  }
  return lineUserId; // fallback
}

// ===== SETUP: สร้าง Sheet ที่จำเป็น =====
function setupSheets() {
  const ss = SpreadsheetApp.openById(SHEET_ID);

  // TripLog headers
  let sh = ss.getSheetByName(SH_LOG);
  if (!sh) {
    sh = ss.insertSheet(SH_LOG);
  }
  // อัปเดตหัวตารางเสมอ (ภาษาไทย)
  sh.getRange(1, 1, 1, 28).setValues([[
    'รหัสแผนงาน','LineUserId','ชื่อพนักงาน',              // A B C
    'เวลาออก','เลขไมล์ออก',                               // D E
    'เวลาถึงร้าน','เลขไมล์ถึงร้าน','ระยะทาง(km)',         // F G H
    'GPS ออก(Lat)','GPS ออก(Lng)',                         // I J
    'GPS ถึงร้าน(Lat)','GPS ถึงร้าน(Lng)',                // K L
    'หมายเหตุ','สถานะ','ชื่อร้านค้า',                    // M N O
    'ความเร็วเฉลี่ย(km/h)',                                // P
    'เวลาออกจากร้าน','เลขไมล์ออกจากร้าน',                // Q R
    'GPS ออกจากร้าน(Lat)','GPS ออกจากร้าน(Lng)',          // S T
    'Maps ออก','Maps ถึงร้าน','Maps ออกจากร้าน',          // U V W
    'เวลาถึงบริษัท','เลขไมล์ถึงบริษัท',                  // X Y
    'GPS ถึงบริษัท(Lat)','GPS ถึงบริษัท(Lng)',            // Z AA
    'Maps ถึงบริษัท'                                       // AB
  ]]);
  sh.getRange('1:1').setFontWeight('bold').setBackground('#d9ead3');

  // Drivers
  let dsh = ss.getSheetByName(SH_DRIVERS);
  if (!dsh) {
    dsh = ss.insertSheet(SH_DRIVERS);
  }
  dsh.getRange(1, 1, 1, 4).setValues([[
    'รหัสพนักงาน','ชื่อพนักงาน','LineUserId','เบอร์โทร'
  ]]);
  dsh.getRange('1:1').setFontWeight('bold').setBackground('#cfe2f3');

  SpreadsheetApp.flush();
  Logger.log('Setup complete!');
}
// ===================================================
// WEBHOOK — เพิ่มต่อท้าย Code.gs เดิม
// ตั้งค่า: LINE Developers → Messaging API → Webhook URL
// ใส่ URL ของ Apps Script Web App นี้เลย (URL เดียวกัน)
// ===================================================

// doPost รับทั้ง Webhook และ API call จาก LIFF
// แยกด้วย body.action — ถ้ามี action = API, ไม่มี = LINE Webhook
function doPost(e) {
  const body = JSON.parse(e.postData.contents);

  // ── LINE Webhook event (ไม่มี action field) ──
  if (!body.action && body.events) {
    body.events.forEach(event => {
      try {
        handleLineEvent(event);
      } catch(err) {
        Logger.log('Webhook error: ' + err.message);
        // ส่ง error กลับให้ผู้ใช้เพื่อ debug
        if (event.replyToken) {
          replyText(event.replyToken, '⚠️ Error: ' + err.message);
        }
      }
    });
    return ContentService.createTextOutput('OK');
  }

  // ── LIFF API call (มี action field) ──
  let res;
  try {
    const path = body.action;
    if      (path === 'depart')      res = recordDepart(body);
    else if (path === 'arrive')      res = recordArrive(body);
    else if (path === 'return')      res = recordReturn(body);
    else if (path === 'complete')    res = recordComplete(body);
    else                             res = { error: 'Unknown action' };
  } catch (err) {
    res = { error: err.message };
  }

  return ContentService.createTextOutput(JSON.stringify(res))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── จัดการแต่ละ event ──
function handleLineEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const userId  = event.source.userId;
  const text    = event.message.text.trim();
  const replyToken = event.replyToken;

  // keyword matching (รองรับทั้งไทยและตัวพิมพ์ใหญ่/เล็ก)
  const kw = text.toLowerCase();

  if (kw === 'myid') {
    replyText(replyToken, `🪪 LINE User ID ของคุณ:\n${userId}`);
  } else if (kw === 'groupid') {
    const groupId = event.source.groupId || event.source.roomId || '(ไม่ได้อยู่ในกลุ่ม)';
    replyText(replyToken, `🪪 Group ID:\n${groupId}`);
  } else if (kw === 'แผนงาน' || kw === 'plan') {
    replyPlanSummary(userId, replyToken);
  } else if (kw === 'สถานะ' || kw === 'status') {
    replyTodayStatus(userId, replyToken);
  } else if (kw === 'บันทึก' || kw === 'record') {
    replyOpenLiff(userId, replyToken);
  } else if (kw === 'ช่วยเหลือ' || kw === 'help') {
    replyHelp(replyToken);
  }
  // ถ้าไม่ตรง keyword ไม่ตอบ (ไม่รบกวน)
}

// ── Reply: แผนงานวันนี้ของพนักงานคนนั้น ──
function replyPlanSummary(userId, replyToken) {
  const tz      = Session.getScriptTimeZone();
  const today   = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const todayTH = Utilities.formatDate(new Date(), tz, 'dd/MM/yyyy');
  const result  = getPlans({ date: today, lineUserId: userId });
  const plans   = result.plans || [];
  const driverName = result.driverName || '';

  if (!plans.length) {
    replyText(replyToken, `📋 ไม่มีแผนงานสำหรับวันนี้ (${todayTH}) ครับ`);
    return;
  }

  // Group by TripNo
  const tripMap = {};
  plans.forEach(p => {
    const k = String(p.tripNo || '1');
    if (!tripMap[k]) tripMap[k] = [];
    tripMap[k].push(p);
  });

  const statusLabel = {
    pending  : '⬜ รอดำเนินการ',
    departed : '🔵 กำลังเดินทาง',
    arrived  : '✅ ถึงแล้ว',
    returning: '🔄 กำลังกลับ',
    completed: '🏁 เสร็จสิ้น'
  };

  // สร้าง Bubble ต่อ 1 เที่ยว
  const bubbles = Object.entries(tripMap).map(([tripNo, shops]) => {
    const doneCount  = shops.filter(s => s.status === 'arrived' || s.status === 'completed').length;
    const totalDist  = shops.reduce((s, p) => s + (parseFloat(p.dist) || 0), 0).toFixed(1);
    const allDone    = doneCount === shops.length;
    const hasActive  = shops.some(s => s.status === 'departed' || s.status === 'returning');
    const headerColor = allDone ? '#2E7D32' : hasActive ? '#1565C0' : '#06C755';

    // Shop rows
    const shopRows = [];
    shops.forEach((s, i) => {
      if (i > 0) shopRows.push({ type:'separator', margin:'md' });

      shopRows.push({
        type:'box', layout:'vertical', margin:'md', spacing:'xs',
        contents:[
          // บรรทัด 1: ชื่อร้าน
          {
            type:'box', layout:'horizontal', spacing:'sm',
            contents:[
              { type:'text', text: s.shop, size:'sm', weight:'bold', wrap:true, color:'#111111', flex:1 }
            ]
          },
          // บรรทัด 2: Plan ID + ระยะทาง
          {
            type:'box', layout:'horizontal', spacing:'sm',
            contents:[
              { type:'text', text:`📋 ${s.planId}`, size:'xs', color:'#666666', flex:3, wrap:true },
              { type:'text', text:`📏 ${s.dist} km`, size:'xs', color:'#666666', flex:2, align:'end' }
            ]
          },
          // บรรทัด 3: ประเภทงาน + สถานะ
          {
            type:'box', layout:'horizontal', spacing:'sm',
            contents:[
              { type:'text', text: s.type ? `🚛 ${s.type}` : ' ', size:'xs', color:'#888888', flex:3 },
              { type:'text', text: statusLabel[s.status] || '⬜ รอดำเนินการ', size:'xs', color:'#555555', flex:2, align:'end', wrap:false }
            ]
          }
        ]
      });
    });

    return {
      type  : 'bubble',
      header: {
        type:'box', layout:'vertical', paddingAll:'14px',
        backgroundColor: headerColor,
        contents:[
          {
            type:'box', layout:'horizontal',
            contents:[
              { type:'text', text:`🚚 เที่ยวที่ ${tripNo}`, weight:'bold', color:'#ffffff', size:'md', flex:1 },
              { type:'text', text:`${doneCount}/${shops.length} ร้าน`, size:'sm', color:'#FFFFFFDD', align:'end', flex:0 }
            ]
          },
          {
            type:'box', layout:'horizontal', margin:'xs',
            contents:[
              { type:'text', text:`👤 ${driverName}`, size:'xs', color:'#FFFFFFCC', flex:1 },
              { type:'text', text:`📅 ${todayTH}`, size:'xs', color:'#FFFFFFCC', align:'end', flex:0 }
            ]
          },
          {
            type:'box', layout:'horizontal', margin:'xs',
            contents:[
              { type:'text', text: allDone ? '✅ ส่งครบแล้ว' : hasActive ? '🔵 กำลังดำเนินการ' : '⬜ รอดำเนินการ',
                size:'xs', color:'#FFFFFFF2', flex:1 },
              { type:'text', text:`📏 ~${totalDist} km`, size:'xs', color:'#FFFFFFDD', align:'end', flex:0 }
            ]
          }
        ]
      },
      body: {
        type:'box', layout:'vertical', paddingAll:'14px',
        contents: shopRows
      },
      footer: {
        type:'box', layout:'vertical', paddingAll:'10px',
        contents:[{
          type:'button', style:'primary', color:'#06C755', height:'sm',
          action:{ type:'uri', label:'✍️ เปิดแอปบันทึก', uri:`https://liff.line.me/${LIFF_ID}` }
        }]
      }
    };
  });

  const totalAllDist = plans.reduce((s, p) => s + (parseFloat(p.dist) || 0), 0).toFixed(1);
  const altText = `📋 แผนงานวันนี้ ${driverName} — ${plans.length} ร้าน ~${totalAllDist} km`;

  const message = bubbles.length === 1
    ? { type:'flex', altText, contents: bubbles[0] }
    : { type:'flex', altText, contents: { type:'carousel', contents: bubbles } };

  callReplyAPI(replyToken, [message]);
}

// ── Reply: สถานะวันนี้ (สรุปเที่ยว) ──
function replyTodayStatus(userId, replyToken) {
  const today  = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const result = getHistory({ lineUserId: userId, date: today });
  const logs   = result.logs || [];

  if (!logs.length) {
    replyText(replyToken, 'ยังไม่มีการบันทึกวันนี้ครับ');
    return;
  }

  const totalDist = logs.reduce((s, l) => s + (parseFloat(l.distance) || 0), 0).toFixed(1);
  const doneCount = logs.filter(l => l.status === 'arrived' || l.status === 'completed').length;

  const rows = logs.map(l => ({
    type   : 'box',
    layout : 'horizontal',
    contents: [
      { type:'text', text: statusIcon(l.status), size:'sm', flex:0 },
      { type:'text', text: l.planId, size:'sm', flex:4, color:'#333333', wrap:true },
      { type:'text', text: l.distance ? `${l.distance} km` : '—', size:'xs', flex:2, align:'end', color:'#888888' }
    ],
    margin: 'sm'
  }));

  const bubble = {
    type  : 'bubble',
    header: {
      type    : 'box',
      layout  : 'vertical',
      contents: [
        { type:'text', text:'สรุปวันนี้', weight:'bold', color:'#ffffff', size:'md' },
        { type:'text', text:`${doneCount}/${logs.length} ร้าน · รวม ${totalDist} km`, color:'#FFFFFFCC', size:'sm' }
      ],
      backgroundColor: '#1565C0',
      paddingAll: '14px'
    },
    body: {
      type:'box', layout:'vertical', contents: rows, paddingAll:'14px'
    }
  };

  callReplyAPI(replyToken, [{
    type:'flex', altText:`สรุปวันนี้ ${doneCount}/${logs.length} ร้าน`,
    contents: bubble
  }]);
}

// ── Reply: ปุ่มเปิด LIFF ──
function replyOpenLiff(userId, replyToken) {
  callReplyAPI(replyToken, [{
    type    : 'flex',
    altText : 'เปิดแอปบันทึกการจัดส่ง',
    contents: {
      type : 'bubble',
      body : {
        type    : 'box',
        layout  : 'vertical',
        contents: [{
          type  : 'text',
          text  : 'แตะปุ่มด้านล่างเพื่อเปิดแอปบันทึก',
          wrap  : true,
          color : '#555555',
          size  : 'sm'
        }],
        paddingAll: '16px'
      },
      footer: {
        type    : 'box',
        layout  : 'vertical',
        contents: [{
          type  : 'button',
          style : 'primary',
          color : '#06C755',
          action: { type:'uri', label:'เปิดแอปบันทึก', uri:`https://liff.line.me/${LIFF_ID}` }
        }],
        paddingAll: '12px'
      }
    }
  }]);
}

// ── Reply: คู่มือ ──
function replyHelp(replyToken) {
  replyText(replyToken,
    'คำสั่งที่ใช้ได้ครับ\n\n' +
    '📋 แผนงาน — ดูแผนงานวันนี้\n' +
    '📊 สถานะ — สรุปเที่ยวที่ส่งแล้ว\n' +
    '✍️ บันทึก — เปิดแอปบันทึกไมล์\n' +
    '❓ ช่วยเหลือ — แสดงคำสั่งนี้'
  );
}

// ── Helpers ──
function statusIcon(s) {
  return { pending:'⬜', departed:'🔵', arrived:'✅', completed:'✅' }[s] || '⬜';
}

function replyText(replyToken, text) {
  callReplyAPI(replyToken, [{ type:'text', text }]);
}

function callReplyAPI(replyToken, messages) {
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method     : 'post',
    contentType: 'application/json',
    headers    : { Authorization: `Bearer ${LINE_CHANNEL_TOKEN}` },
    payload    : JSON.stringify({ replyToken, messages }),
    muteHttpExceptions: true
  });
}
