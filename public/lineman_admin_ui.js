'use strict';
// LINE MAN renders cards into the SAME kitchen timeline as restaurant orders.
// All LINE MAN actions use /api/lineman/*; none call restaurant order/status APIs.
(() => {
  const host = document.getElementById('lineman-queue-host');
  const kitchenList = document.getElementById('kitchen-orders-list');
  if (!host || !kitchenList) return;

  const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
  const formatTime = s => {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('th-TH', {
      hour: '2-digit', minute: '2-digit'
    });
  };
  let queue = [];
  let online = false;
  let loggedIn = false;
  let fetching = false;
  // Immediate UI feedback only. Canonical queue remains on Windows and is
  // restored if Windows has not confirmed within the timeout.
  const pendingHide = new Map();
  const pendingHideTimeoutMs = 30000;
  function notifyUnconfirmed() {
    const message = 'Windows ยังไม่ยืนยันการนำคิว LINE MAN ออก กรุณาตรวจสอบก่อนกดซ้ำ';
    if (typeof window.showToast === 'function') window.showToast(message, true);
    else alert(message);
  }
  function reconcilePending(currentIds = null) {
    let timedOut = false;
    for (const [id, entry] of pendingHide) {
      if (currentIds && !currentIds.has(id)) pendingHide.delete(id);
      else if (Date.now() - entry.since >= pendingHideTimeoutMs) {
        pendingHide.delete(id);
        timedOut = true;
      }
    }
    if (timedOut) notifyUnconfirmed();
  }

  function refreshMergedList() {
    if (typeof window.renderCombinedKitchenCards === 'function') {
      window.renderCombinedKitchenCards();
    }
  }
  function renderToolbar(mode) {
    if (mode === 'login') {
      host.innerHTML = '<span style="color:#747d8c;">🛵 LINE MAN:</span> ' +
        '<button class="btn-print" type="button" data-lmq-login="1">เข้าสู่ระบบคิว</button>';
      return;
    }
    if (mode === 'offline') {
      host.innerHTML = '<span style="color:#d35400;">🛵 LINE MAN: ⚠️ Windows ไม่ออนไลน์ · แสดงคิวล่าสุด</span>';
      return;
    }
    if (mode === 'error') {
      host.innerHTML = '<span style="color:#d35400;">🛵 LINE MAN: ⚠️ เชื่อมต่อคิวไม่ได้</span>';
      return;
    }
    if (mode === 'disabled') {
      host.innerHTML = '<span style="color:#d35400;">🛵 LINE MAN: ยังไม่ตั้งค่า Render</span>';
      return;
    }
    host.innerHTML = '<span style="color:#2d8752;">🛵 LINE MAN: ● เชื่อมต่อ Windows</span>';
  }

  function cardOf(order, duplicateIndex = 1, duplicateCount = 1) {
    const statusKey = String(order.printStatus || 'pending');
    const printed = statusKey === 'printed';
    const status = printed ? '🖨️ พิมพ์แล้ว' : statusKey === 'printing' ? '⏳ กำลังพิมพ์' :
      statusKey === 'pending' ? '⏳ รอพิมพ์' : statusKey === 'uncertain' ? '⚠️ สถานะไม่แน่นอน' :
      '⚠️ พิมพ์ไม่สำเร็จ';
    const topStatus = printed ? '✅ พิมพ์ครบแล้ว' : statusKey === 'error' ? '⚠️ พิมพ์ไม่สำเร็จ' :
      statusKey === 'uncertain' ? '⚠️ ตรวจใบพิมพ์' : '⏳ กำลังพิมพ์';
    const pending = Boolean(order.commandPending);
    const items = (Array.isArray(order.items) ? order.items : []).map(i => {
      const qty = Math.max(1, Number(i.quantity) || 1);
      const note = i.notes ? '<div style="color:#d35400;font-size:10.5px;margin-left:8px;">-(โน๊ต: '+escapeHTML(i.notes)+')</div>' : '';
      const options = Array.isArray(i.options) ? i.options.map(opt =>
        '<div style="color:#d35400;font-size:10.5px;margin-left:8px;">- '+escapeHTML(opt)+'</div>').join('') : '';
      return '<div style="padding:3px 0;">• '+escapeHTML(i.name)+' <strong>x'+escapeHTML(qty)+'</strong>'+note+options+'</div>';
    }).join('');
    const orderId = escapeHTML(order.id);
    const shortId = escapeHTML(order.shortId || order.orderKey || order.id);
    const disableActions = pending || !online;
    const isDuplicateGroup = duplicateCount > 1;
    const duplicateNote = duplicateIndex > 1
      ? ' <span style="font-size:10px;color:#d35400;">· ส่งซ้ำใบที่ '+duplicateIndex+'</span>' : '';
    const removeDuplicateButton = isDuplicateGroup
      ? `<button class="btn-print" style="background:#9b4040;" type="button" data-lmq-id="${orderId}" data-lmq-action="discard_duplicate" ${disableActions ? 'disabled' : ''}>🗑️ ลบคิวซ้ำ</button>` : '';
    const cardHTML = `<div class="kitchen-card ${printed ? '' : 'unprinted-blink'}" style="${printed ? 'border-left-color:#3742fa; background:#f0f4ff;' : ''}">
      <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px dashed #eee;padding-bottom:3px;margin-bottom:3px;">
        <span style="font-weight:bold;color:var(--primary);font-size:12px;">🛵 ออเดอร์ #${shortId}${duplicateNote}</span>
        <span style="font-size:10px;color:var(--gray);">${topStatus}</span>
      </div>
      <div style="color:var(--text);margin:4px 0;line-height:1.4;">${items}</div>
      <div style="font-size:10px;margin-top:2px;">LINE MAN: ${status}${order.printMessage ? ' · '+escapeHTML(order.printMessage) : ''}</div>
      ${pending ? '<div style="color:#d35400;font-size:10px;">⏳ รอ Windows ดำเนินการ: '+escapeHTML(order.commandPending)+'</div>' : ''}
      <div style="display:flex;justify-content:flex-end;flex-wrap:wrap;gap:4px;margin-top:6px;border-top:1px solid #eee;padding-top:4px;">
        <button class="btn-action" type="button" data-lmq-id="${orderId}" data-lmq-action="complete" ${disableActions ? 'disabled' : ''}>✔️ เสร็จ</button>
        <button class="btn-print" type="button" data-lmq-id="${orderId}" data-lmq-action="reprint" ${disableActions ? 'disabled' : ''}>🔄 พิมพ์ใหม่</button>
        ${removeDuplicateButton}
      </div>
    </div>`;
    return {source:'lineman',createdAt:order.createdAt,html:cardHTML};
  }

  window.LineManKitchenQueue = {
    getCards: () => {
      if (!loggedIn) return [];
      const activeQueue = queue.filter(order => !pendingHide.has(String(order.id)));
      const counts = new Map();
      const occurrenceById = new Map();
      const inOriginalOrder = activeQueue.slice().sort((a,b) => {
        const left=Date.parse(a.createdAt || '') || 0;
        const right=Date.parse(b.createdAt || '') || 0;
        return left-right || String(a.id).localeCompare(String(b.id));
      });
      for (const order of inOriginalOrder) {
        const key = String(order.orderKey || order.shortId || order.id);
        const n=(counts.get(key)||0)+1;
        counts.set(key,n);
        occurrenceById.set(order.id,n);
      }
      return activeQueue.map(order => cardOf(order,
        occurrenceById.get(order.id) || 1,
        counts.get(String(order.orderKey || order.shortId || order.id)) || 1));
    }
  };

  async function refresh() {
    if (fetching) return;
    fetching = true;
    try {
      const res = await fetch('/api/lineman/orders', {cache:'no-store', credentials:'same-origin'});
      if (res.status === 401) {
        pendingHide.clear();
        loggedIn = false;
        online = false;
        queue = [];
        renderToolbar('login');
        refreshMergedList();
        return;
      }
      if (!res.ok) {
        reconcilePending();
        online = false;
        renderToolbar(res.status === 503 ? 'disabled' : 'error');
        refreshMergedList();
        return;
      }
      const data = await res.json();
      queue = Array.isArray(data.orders) ? data.orders : [];
      // Missing ID confirms Windows has removed the entry from its snapshot.
      reconcilePending(new Set(queue.map(order => String(order.id))));
      online = Boolean(data.online);
      loggedIn = true;
      renderToolbar(online ? 'online' : 'offline');
      refreshMergedList();
    } catch (error) {
      reconcilePending();
      online = false;
      renderToolbar('error');
      refreshMergedList();
    } finally {
      fetching = false;
    }
  }

  async function login() {
    const passcode = prompt('รหัสเข้าจัดการคิว LINE MAN (จดจำคอมพิวเตอร์ร้าน 30 วัน และต่ออายุระหว่างใช้งาน):');
    if (!passcode) return;
    try {
      const response = await fetch('/api/lineman/session', {
        method:'POST', credentials:'same-origin',
        headers:{'content-type':'application/json'},body:JSON.stringify({passcode})
      });
      if (!response.ok) {alert('เข้าสู่ระบบคิว LINE MAN ไม่สำเร็จ');return;}
      await refresh();
    } catch {alert('ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์คิว LINE MAN');}
  }
  async function takeAction(orderId, action, button) {
    if (action === 'reprint' && !confirm('ต้องการพิมพ์ใบ LINE MAN นี้ซ้ำอีกหนึ่งใบใช่หรือไม่?')) return;
    if (action === 'complete' && !confirm('ยืนยันว่าอาหารออเดอร์ LINE MAN นี้ทำเสร็จแล้ว?')) return;
    if (action === 'discard_duplicate' &&
        !confirm('ลบเฉพาะการ์ด LINE MAN ที่ส่งซ้ำใบนี้ใช่หรือไม่?\nจะเหลือออเดอร์จริงอย่างน้อยหนึ่งใบ ไม่ยกเลิกออเดอร์บน Wongnai และไม่ย้อนกระดาษที่พิมพ์ไปแล้ว')) return;
    button.disabled = true;
    try {
      const res = await fetch('/api/lineman/orders/'+encodeURIComponent(orderId)+'/action', {
        method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},
        body:JSON.stringify({action})
      });
      if (!res.ok) {
        let error = {}; try {error = await res.json();} catch {}
        alert(error.error || 'สั่งงาน LINE MAN ไม่สำเร็จ');
        button.disabled = false;
      } else if (res.status === 202 && (action === 'complete' || action === 'discard_duplicate')) {
        // 202 = relay accepted the command, NOT Windows confirmation.
        // Hide the selected card now, while Windows remains authoritative.
        pendingHide.set(String(orderId), {since:Date.now(), action});
        refreshMergedList();
      }
      await refresh();
    } catch {
      alert('เชื่อมต่อคำสั่ง LINE MAN ไม่สำเร็จ');
      button.disabled = false;
    }
  }

  // LINE MAN actions are delegated to the kitchen list; restaurant buttons keep their original onclick.
  kitchenList.addEventListener('click', event => {
    const button = event.target.closest('button[data-lmq-action]');
    if (!button || !kitchenList.contains(button)) return;
    takeAction(button.dataset.lmqId, button.dataset.lmqAction, button);
  });
  host.addEventListener('click', event => {
    const button = event.target.closest('button[data-lmq-login]');
    if (button) login();
  });
  setInterval(refresh, 5000);
  refresh();
})();
