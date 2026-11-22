'use strict';
// LINE MAN queue only. Does not mutate the existing restaurant orders, UI, or inventory.
(() => {
  const el = document.getElementById('lineman-queue-host');
  if (!el) return;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]);
  function time(s) {
    const date=new Date(s);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit'});
  }
  async function refresh() {
    try {
      const response = await fetch('/api/lineman/orders',{cache:'no-store'});
      if (response.status===401) {
        el.innerHTML='<div class="lmq-access">🛵 LINE MAN — <button type="button" data-login="1">เข้าสู่คิว LINE MAN</button></div>';
        return;
      }
      if (!response.ok) {
        el.innerHTML='<div class="lmq-access">⚠️ คิว LINE MAN ยังไม่ได้ตั้งค่าบน Render</div>';
        return;
      }
      const data=await response.json();
      let html='<div class="lmq-head">🛵 LINE MAN <span>'+ (data.online ? '🟢 เชื่อมต่อ Windows' : '⚠️ Windows ไม่ออนไลน์') +'</span></div>';
      const rows=Array.isArray(data.orders)?data.orders:[];
      if (!rows.length) html+='<div class="lmq-access">ไม่มีคิว LINE MAN ค้างอยู่</div>';
      for (const order of rows) {
        const st=order.printStatus;
        const pending=Boolean(order.commandPending);
        const status=st==='printed' ? '🖨️ พิมพ์แล้ว' : st==='printing' ? '⏳ กำลังพิมพ์' :
          st==='pending' ? '⏳ รอพิมพ์' : st==='uncertain' ? '⚠️ สถานะไม่แน่นอน' : '⚠️ พิมพ์ไม่สำเร็จ';
        const isPrinted=st==='printed';
        const parts=(order.items || []).map(i => {
          const qty=Number(i.quantity) || 1;
          const note=i.notes ? '<div class="lmq-note">-(โน๊ต: '+esc(i.notes)+')</div>' : '';
          const opts=Array.isArray(i.options) ? i.options.map(o=>'<div class="lmq-note">- '+esc(o)+'</div>').join('') : '';
          return '<div style="padding:3px 0">• '+esc(i.name)+' <strong>x'+qty+'</strong>'+note+opts+'</div>';
        }).join('');
        html += `<div class="kitchen-card ${isPrinted ? '' : 'unprinted-blink'}" style="${isPrinted ? 'border-left-color:#3742fa;background:#f0f4ff;' : ''}">
          <div class="lmq-card-head"><b>🛵 LINE MAN #${esc(order.shortId || order.orderKey || order.id)}</b><span>${esc(time(order.createdAt))}</span></div>
          <div class="lmq-items">${parts}</div>
          <div class="lmq-status">${status}${order.printMessage ? ' · '+esc(order.printMessage) : ''}</div>
          ${pending ? '<div class="lmq-status">⏳ รอ Windows ดำเนินการ: '+esc(order.commandPending)+'</div>' : ''}
          <div class="lmq-actions">
            <button class="btn-action" data-lmq-id="${esc(order.id)}" data-lmq-action="complete" ${pending || !data.online ? 'disabled' : ''}>✔️ เสร็จ</button>
            <button class="btn-print" data-lmq-id="${esc(order.id)}" data-lmq-action="reprint" ${pending || !data.online ? 'disabled' : ''}>🔄 พิมพ์ใหม่</button>
          </div>
        </div>`;
      }
      el.innerHTML=html;
    } catch(e) {
      el.innerHTML='<div class="lmq-access">⚠️ โหลดคิว LINE MAN ไม่ได้ (คิวร้านยังทำงานปกติ)</div>';
    }
  }
  async function login() {
    const passcode=prompt('รหัสเข้าหน้าจัดการคิว LINE MAN (ตั้งไว้ใน Render):');
    if (!passcode) return;
    try {
      const response=await fetch('/api/lineman/session',{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({passcode})
      });
      if (!response.ok) {alert('เข้าสู่ระบบคิว LINE MAN ไม่สำเร็จ');return;}
      await refresh();
    } catch {alert('ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์คิว LINE MAN');}
  }
  async function action(orderId, type, btn) {
    if (type==='reprint' && !confirm('ต้องการพิมพ์ใบ LINE MAN นี้ซ้ำอีกหนึ่งใบใช่หรือไม่?')) return;
    if (type==='complete' && !confirm('ยืนยันว่าอาหารออเดอร์ LINE MAN นี้ทำเสร็จแล้ว?')) return;
    btn.disabled=true;
    try {
      const response=await fetch('/api/lineman/orders/'+encodeURIComponent(orderId)+'/action',{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:type})
      });
      if (!response.ok) {
        let data={};try{data=await response.json();}catch{}
        alert(data.error || 'สั่งงานไม่สำเร็จ');
      }
      await refresh();
    } catch {alert('เชื่อมต่อคำสั่ง LINE MAN ไม่สำเร็จ');btn.disabled=false;}
  }
  el.addEventListener('click', e=>{
    const btn=e.target.closest('button'); if (!btn) return;
    if (btn.dataset.login) login();
    else if (btn.dataset.lmqAction) action(btn.dataset.lmqId,btn.dataset.lmqAction,btn);
  });
  setInterval(refresh,5000);
  refresh();
})();
