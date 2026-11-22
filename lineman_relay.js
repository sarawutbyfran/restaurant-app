'use strict';
// LINE MAN Kitchen Queue relay. NO PostgreSQL calls and NO disk persistence.
// One Render instance only; Windows is the authoritative queue store.
const crypto = require('node:crypto');

function setupLineManRelay(app) {
  const bridgeKey = process.env.LINEMAN_BRIDGE_KEY || '';
  const adminPin = process.env.LINEMAN_ADMIN_PASSCODE || '';
  const configured = bridgeKey.length >= 20 && adminPin.length >= 8;
  const sessionSecret = crypto.createHash('sha256').update('lmq2|' + bridgeKey + '|' + adminPin).digest();
  const sessionAgeMs = 12 * 60 * 60 * 1000;
  const orders = new Map();
  const commands = new Map();
  let lastSyncAt = 0;
  let instanceId = null;

  function safeEq(a, b) {
    const ah = crypto.createHash('sha256').update(String(a || '')).digest();
    const bh = crypto.createHash('sha256').update(String(b || '')).digest();
    return crypto.timingSafeEqual(ah, bh);
  }
  function gateConfigured(req, res, next) {
    if (!configured) return res.status(503).json({error:'LINE MAN queue relay is not configured on Render'});
    next();
  }
  function gateBridge(req, res, next) {
    if (!safeEq(req.get('x-lineman-bridge-key'), bridgeKey)) return res.status(403).json({error:'Forbidden'});
    next();
  }
  function sign(timestamp) {
    return crypto.createHmac('sha256', sessionSecret).update(String(timestamp)).digest('hex');
  }
  function getCookie(req, name) {
    const cookie = String(req.headers.cookie || '').split(';').map(x => x.trim())
      .find(x => x.startsWith(name + '='));
    return cookie ? cookie.slice(name.length + 1) : '';
  }
  function gateAdmin(req, res, next) {
    const [ts, signature] = getCookie(req, 'lmq_session').split('.');
    const issued = Number(ts);
    if (!Number.isSafeInteger(issued) || issued > Date.now() + 60000 || Date.now() - issued > sessionAgeMs ||
        !safeEq(signature, sign(ts))) return res.status(401).json({error:'LINE MAN admin login required'});
    next();
  }
  function gateSameOrigin(req, res, next) {
    const origin = req.get('origin');
    if (origin) {
      try { if (new URL(origin).host !== req.get('host')) return res.status(403).json({error:'Bad origin'}); }
      catch { return res.status(403).json({error:'Bad origin'}); }
    }
    if (!req.is('application/json')) return res.status(415).json({error:'JSON required'});
    next();
  }
  function cleanItem(i) {
    return {name:String(i?.name || '').slice(0,180),
      quantity:Math.min(999, Math.max(1, Math.floor(Number(i?.quantity)||1))),
      notes:String(i?.notes || '').slice(0,350),
      options:Array.isArray(i?.options) ? i.options.slice(0,15).map(s=>String(s).slice(0,160)) : []};
  }
  function cleanOrder(o) {
    if (!o || typeof o !== 'object') return null;
    const id = String(o.id || '').trim();
    if (!id || id.length > 140 || !Array.isArray(o.items) || !o.items.length) return null;
    return {id, orderKey:String(o.orderKey || id).slice(0,140),
      shortId:String(o.shortId || '').slice(0,40),
      createdAt:String(o.createdAt || '').slice(0,40),
      printStatus:['pending','printing','printed','error','uncertain'].includes(o.printStatus) ? o.printStatus : 'pending',
      printMessage:String(o.printMessage || '').slice(0,180),
      items:o.items.slice(0,80).map(cleanItem)};
  }

  // Bridge owns canonical snapshot. Unfinished orders are never written on Render.
  app.post('/api/lineman/bridge/sync', gateConfigured, gateBridge, (req, res) => {
    const body = req.body || {};
    if (!Array.isArray(body.orders) || body.orders.length > 100 ||
        !Array.isArray(body.acks) || body.acks.length > 300) return res.status(400).json({error:'Invalid sync payload'});
    const incomingInstance = String(body.instanceId || '').slice(0,70);
    if (!incomingInstance) return res.status(400).json({error:'Missing instanceId'});
    if (instanceId !== incomingInstance) {
      instanceId = incomingInstance;
      commands.clear();  // Never deliver a command to a different Windows installation.
    }
    for (const ack of body.acks) {
      const cmdId = typeof ack === 'string' ? ack : String(ack?.id || '');
      commands.delete(cmdId);
    }
    const next = new Map();
    for (const raw of body.orders) {
      const o = cleanOrder(raw);
      if (o) next.set(o.id, o);
    }
    orders.clear();
    for (const [id, o] of next) orders.set(id, o);
    lastSyncAt = Date.now();
    const pending = [...commands.values()].filter(c=>c.instanceId === instanceId).slice(0,30);
    res.json({ok:true, commands:pending});
  });

  app.post('/api/lineman/session', gateConfigured, gateSameOrigin, (req,res) => {
    if (!safeEq(req.body?.passcode, adminPin)) return res.status(403).json({error:'รหัสคิว LINE MAN ไม่ถูกต้อง'});
    const t = String(Date.now());
    const secure = (req.secure || req.get('x-forwarded-proto') === 'https') ? '; Secure' : '';
    res.setHeader('Set-Cookie', `lmq_session=${t}.${sign(t)}; Path=/api/lineman; HttpOnly; SameSite=Strict; Max-Age=43200${secure}`);
    res.json({ok:true});
  });

  app.get('/api/lineman/orders', gateConfigured, gateAdmin, (req,res) => {
    const online = lastSyncAt > 0 && (Date.now()-lastSyncAt) < 20000;
    const pendingByOrder = new Map([...commands.values()].map(c => [c.orderId,c.action]));
    res.set('Cache-Control','no-store');
    res.json({ok:true, online, lastSyncAt,
      orders:[...orders.values()].sort((a,b)=>(b.createdAt || '').localeCompare(a.createdAt || ''))
        .map(o=>({...o,commandPending:pendingByOrder.get(o.id)||null}))});
  });

  app.post('/api/lineman/orders/:id/action', gateConfigured, gateSameOrigin, gateAdmin, (req,res) => {
    if (!lastSyncAt || Date.now()-lastSyncAt>20000) return res.status(503).json({error:'Windows Bridge ไม่ออนไลน์'});
    const orderId=String(req.params.id || '');
    const action=String(req.body?.action || '');
    if (!['complete','reprint','discard_duplicate'].includes(action)) return res.status(400).json({error:'Invalid action'});
    if (!orders.has(orderId)) return res.status(404).json({error:'ไม่พบคิวนี้'});
    if (action==='discard_duplicate') {
      const key=String(orders.get(orderId)?.orderKey || '');
      const siblings=[...orders.values()].filter(o=>String(o.orderKey || '')===key);
      if (!key || siblings.length<2) return res.status(409).json({error:'ไม่มีคิวซ้ำที่ลบได้'});
    }
    const existing=[...commands.values()].find(c=>c.orderId===orderId);
    if (existing) return res.status(409).json({error:'มีคำสั่งของคิวนี้กำลังดำเนินการ'});
    const id=crypto.randomUUID();
    commands.set(id,{id,orderId,action,instanceId,createdAt:new Date().toISOString()});
    res.status(202).json({ok:true,queued:true,commandId:id});
  });
  if (!configured) console.warn('[LMQ] Disabled: configure LINEMAN_BRIDGE_KEY and LINEMAN_ADMIN_PASSCODE');
  else console.log('[LMQ] In-memory relay active (no database writes)');
}
module.exports = setupLineManRelay;
