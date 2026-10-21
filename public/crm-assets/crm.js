(function () {
  'use strict';
  // Glad U Came Lead Inbox. Every enquiry (Instagram, website chatbot, enquiry form) in one place, kept in the
  // studio's own database. Works the same on a desktop (list and conversation side by side) and a phone
  // (list, then the conversation slides in).

  var $ = function (id) { return document.getElementById(id); };
  var STATUS_NEXT = { new: 'contacted', contacted: 'closed', closed: 'new' };
  var state = { leads: [], filter: 'all', query: '', openId: null, selectMode: false, selected: new Set(), sig: '', leadSig: {}, seen: null };
  var toastTimer = null;

  // ---------- small helpers ----------
  function esc(v) { var d = document.createElement('div'); d.textContent = v == null ? '' : String(v); return d.innerHTML; }
  function isNarrow() { return window.matchMedia('(max-width: 899px)').matches; }
  function timeAgo(t) {
    var mins = Math.floor((Date.now() - new Date(t).getTime()) / 60000);
    if (mins < 1) return 'now';
    if (mins < 60) return mins + 'm';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h';
    var days = Math.floor(hrs / 24);
    if (days === 1) return 'Yesterday';
    if (days < 7) return days + 'd';
    return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }
  function dayLabel(t) {
    var d = new Date(t); var now = new Date();
    var diff = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  }
  function clock(t) { return new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); }
  function initials(name) {
    var p = String(name || '').trim().split(/\s+/).filter(Boolean);
    return ((p[0] || '?')[0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
  }
  // a calm, muted colour per person, so the list is easy to scan without being loud
  function tint(name) {
    var hues = [28, 14, 38, 160, 205, 340, 262];
    var h = 0, s = String(name || '?');
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return 'hsl(' + hues[h % hues.length] + ', 24%, 46%)';
  }
  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }
  function statusLabel(s) { return { new: 'New', contacted: 'Contacted', closed: 'Closed' }[s || 'new'] || 'New'; }

  var ICON = {
    instagram: '<svg class="i" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="5"/><circle cx="12" cy="12" r="3.6"/><circle cx="16.8" cy="7.2" r="0.6" fill="currentColor"/></svg>',
    web: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.4 3.6 5.3 3.6 8.5s-1 6.1-3.6 8.5c-2.6-2.4-3.6-5.3-3.6-8.5s1-6.1 3.6-8.5z"/></svg>',
    form: '<svg class="i" viewBox="0 0 24 24"><rect x="5" y="3.5" width="14" height="17" rx="2.5"/><path d="M9 8.5h6M9 12h6M9 15.5h3.5"/></svg>',
    chat: '<svg class="i" viewBox="0 0 24 24"><path d="M5 5h14a2 2 0 012 2v8a2 2 0 01-2 2h-7l-4.5 3.5V17H5a2 2 0 01-2-2V7a2 2 0 012-2z"/></svg>',
    phone: '<svg class="i" viewBox="0 0 24 24"><path d="M6.5 4h3l1.5 4-2 1.3a10 10 0 005.7 5.7L16 13l4 1.5v3a2 2 0 01-2.2 2A15.5 15.5 0 014.5 6.2 2 2 0 016.5 4z"/></svg>',
    mail: '<svg class="i" viewBox="0 0 24 24"><rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/><path d="M4 8l8 5.5L20 8"/></svg>',
    check: '<svg class="i" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    users: '<svg class="i" viewBox="0 0 24 24"><path d="M3.5 6.5h17M3.5 12h17M3.5 17.5h11"/></svg>',
    trash: '<svg class="i" viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>'
  };
  function sourceIcon(l) { return l.channel === 'instagram' ? ICON.instagram : l.channel === 'web' ? ICON.web : l.source === 'Enquiry form' ? ICON.form : ICON.chat; }

  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 3600);
  }
  function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || 'GET', headers: {} };
    if (opts.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
    return fetch(path, init).then(function (r) {
      if (r.status === 401) { showLogin(); throw new Error('signed out'); }
      return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || 'Something went wrong'); return j; });
    });
  }

  // ---------- sign in / out ----------
  function showLogin() { $('login').classList.add('show'); setTimeout(function () { $('pw').focus(); }, 50); }
  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    $('loginErr').textContent = '';
    fetch('/api/crm-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('pw').value }) })
      .then(function (r) { if (!r.ok) throw new Error('That password is not right.'); $('pw').value = ''; $('login').classList.remove('show'); return loadAll(); })
      .catch(function (err) { $('loginErr').textContent = err.message; });
  });
  $('signOut').addEventListener('click', function () { fetch('/api/logout', { method: 'POST' }).then(function () { location.reload(); }); });

  // ---------- data ----------
  function leadSignature(l) { return JSON.stringify([l.status, l.name, l.phone, l.email, l.summary, l.projectType, l.location, l.budget, l.call, l.stage, l.transcript.length, (l.transcript[l.transcript.length - 1] || {}).content, l.transcript.map(function (t) { return t.removed ? 1 : t.image ? 2 : 0; }).join('')]); }
  function loadLeads() {
    return api('/api/crm/leads').then(function (data) {
      $('login').classList.remove('show');
      var fresh = data.leads || [];
      var ids = new Set(fresh.map(function (l) { return l.id; }));
      var added = state.seen ? fresh.some(function (l) { return !state.seen.has(l.id); }) : false;
      state.seen = ids;
      var sig = JSON.stringify(fresh.map(function (l) { return [l.id, leadSignature(l)]; }));
      var changed = sig !== state.sig;
      var openChanged = false;
      fresh.forEach(function (l) { var s = leadSignature(l); if (l.id === state.openId && state.leadSig[l.id] !== s) openChanged = true; state.leadSig[l.id] = s; });
      state.sig = sig;
      state.leads = fresh;
      if (changed) { renderStats(); renderList(); }
      if (state.openId && !state.leads.some(function (l) { return l.id === state.openId; })) closeDetail(true);
      else if (openChanged || (changed && state.openId && !$('detailBody').firstChild)) renderDetail();
      if (added) toast('New lead received');
    }).catch(function () { /* signed out or offline: the next tick tries again */ });
  }
  function loadUsage() {
    return api('/api/crm/usage').then(function (u) {
      meter('Photos', u.photos.used, u.photos.limit, ' · ' + u.photos.count + (u.photos.count === 1 ? ' photo' : ' photos'));
      meter('Db', u.database.used, u.database.limit, '');
      $('retention').value = String(u.photo_days);
    }).catch(function () {});
  }
  function meter(which, used, limit, extra) {
    var pct = limit ? Math.min(100, (used / limit) * 100) : 0;
    var bar = $('bar' + which);
    bar.style.width = Math.max(pct, used > 0 ? 1.2 : 0) + '%';
    bar.className = pct >= 95 ? 'full' : pct >= 80 ? 'warn' : '';
    $('txt' + which).textContent = fmtBytes(used) + ' of ' + fmtBytes(limit) + extra;
  }
  // Instagram connection: a green "Live" dot while it works, a red banner with a Reconnect button when Instagram ends the session.
  function loadInstagram() {
    return api('/api/crm/instagram').then(function (s) {
      var ok = !!s.connected;
      $('igLive').classList.toggle('bad', !ok);
      $('igLiveTxt').textContent = ok ? (s.username ? 'Instagram connected' : 'Live') : 'Instagram disconnected';
      $('igBanner').hidden = ok;
      if (!ok) {
        $('igReconnect').hidden = !s.can_connect;
        $('igBannerText').textContent = s.can_connect
          ? 'The assistant cannot answer Instagram messages until you reconnect. It takes about 20 seconds.'
          : 'The assistant cannot answer Instagram messages right now. Please contact your agency to reconnect.';
      }
    }).catch(function () {});
  }
  function loadAll() { return loadLeads().then(loadUsage).then(loadInstagram); }

  // ---------- list ----------
  function visibleLeads() {
    var q = state.query.trim().toLowerCase();
    return state.leads.filter(function (l) {
      if (state.filter !== 'all' && l.status !== state.filter) return false;
      if (!q) return true;
      return [l.name, l.contact, l.projectType, l.location, l.summary, l.source].join(' ').toLowerCase().indexOf(q) >= 0;
    });
  }
  function renderStats() {
    var week = Date.now() - 7 * 86400000;
    $('statTotal').textContent = state.leads.length;
    $('statWeek').textContent = state.leads.filter(function (l) { return new Date(l.time).getTime() > week; }).length;
    $('statNew').textContent = state.leads.filter(function (l) { return l.status === 'new'; }).length;
    var counts = { all: state.leads.length, new: 0, contacted: 0, closed: 0 };
    state.leads.forEach(function (l) { counts[l.status] = (counts[l.status] || 0) + 1; });
    $('filters').innerHTML = ['all', 'new', 'contacted', 'closed'].map(function (f) {
      return '<button type="button" role="tab" data-filter="' + f + '" class="' + (state.filter === f ? 'on' : '') + '" aria-selected="' + (state.filter === f) + '">' + (f === 'all' ? 'All' : statusLabel(f)) + '<em>' + counts[f] + '</em></button>';
    }).join('');
  }
  function renderList() {
    var list = $('leadList');
    var shown = visibleLeads();
    $('listCard').classList.toggle('select-mode', state.selectMode);
    $('selectToggle').textContent = state.selectMode ? 'Done' : 'Select';
    if (!shown.length) {
      list.innerHTML = '<div class="empty">' + ICON.users + '<b>' + (state.leads.length ? 'Nothing here' : 'No leads yet') + '</b>' +
        (state.leads.length ? 'No leads match this view.' : 'Instagram and website conversations appear here as soon as someone shares their details.') + '</div>';
      updateBulk();
      return;
    }
    list.innerHTML = shown.map(function (l) {
      var sub = [l.projectType, l.location].filter(Boolean).join(' · ') || l.contact || 'No details yet';
      return '<div class="row' + (l.id === state.openId && !state.selectMode ? ' active' : '') + (state.selected.has(l.id) ? ' picked' : '') + '" role="listitem" tabindex="0" data-id="' + l.id + '">' +
        '<span class="check">' + ICON.check + '</span>' +
        '<span class="avatar" style="background:' + tint(l.name) + '">' + esc(initials(l.name)) + '</span>' +
        '<div class="main"><div class="name">' + esc(l.name || 'Unknown') + '</div><div class="sub">' + esc(sub) + '</div>' +
        '<div class="meta"><span class="chip">' + sourceIcon(l) + esc(l.source) + '</span><span class="chip ' + l.status + '">' + statusLabel(l.status) + '</span></div></div>' +
        '<span class="when">' + timeAgo(l.time) + '</span></div>';
    }).join('');
    updateBulk();
  }
  $('leadList').addEventListener('click', function (e) {
    var row = e.target.closest('.row');
    if (!row) return;
    var id = Number(row.dataset.id);
    if (state.selectMode) { toggleSelect(id); return; }
    openLead(id);
  });
  $('leadList').addEventListener('keydown', function (e) {
    var row = e.target.closest && e.target.closest('.row');
    if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); row.click(); }
  });
  $('filters').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    state.filter = b.dataset.filter;
    renderStats(); renderList();
  });
  $('search').addEventListener('input', function () { state.query = this.value; renderList(); });
  $('selectToggle').addEventListener('click', function () { state.selectMode = !state.selectMode; if (!state.selectMode) state.selected.clear(); renderList(); });

  // ---------- picking several leads ----------
  function toggleSelect(id) { if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id); renderList(); }
  function updateBulk() {
    var ids = new Set(state.leads.map(function (l) { return l.id; }));
    state.selected.forEach(function (id) { if (!ids.has(id)) state.selected.delete(id); });
    $('bulkbar').classList.toggle('show', state.selectMode && state.selected.size > 0);
    $('bulkCount').textContent = state.selected.size + ' selected';
  }
  function removeLeads(idsArr, scope) {
    return api('/api/crm/leads/delete', { method: 'POST', body: { ids: idsArr, scope: scope } }).then(function (j) {
      idsArr.forEach(function (id) { state.selected.delete(id); });
      state.sig = '';
      toast(scope === 'leads' ? 'Deleted ' + j.leads + ' lead' + (j.leads === 1 ? '' : 's') + ', freed ' + fmtBytes(j.bytes) : 'Removed ' + j.photos + ' photo' + (j.photos === 1 ? '' : 's') + ', freed ' + fmtBytes(j.bytes));
      if (scope === 'leads' && idsArr.indexOf(state.openId) >= 0) closeDetail(true);
      return loadAll();
    }).catch(function (err) { if (err.message !== 'signed out') alert(err.message); });
  }
  $('bulkLeads').addEventListener('click', function () {
    var n = state.selected.size;
    if (confirm('Delete ' + n + ' lead' + (n === 1 ? '' : 's') + ' and their photos for good? This cannot be undone.')) removeLeads(Array.from(state.selected), 'leads');
  });
  $('bulkPhotos').addEventListener('click', function () {
    var n = state.selected.size;
    if (confirm('Delete the photos of ' + n + ' lead' + (n === 1 ? '' : 's') + '? The chats and details stay.')) removeLeads(Array.from(state.selected), 'photos');
  });

  // ---------- one lead ----------
  function digits(p) { var d = String(p || '').replace(/\D/g, ''); return d.length === 10 ? '91' + d : d; }
  function fact(label, value) { return value ? '<div><dt>' + label + '</dt><dd>' + esc(value) + '</dd></div>' : ''; }
  function openLead(id) {
    state.openId = id;
    renderList();
    renderDetail();
    var pane = $('detail');
    if (isNarrow()) {
      if (!pane.classList.contains('open')) history.pushState({ detail: 1 }, '');
      pane.classList.add('open');
      pane.scrollTop = 0;
    } else {
      pane.scrollTop = 0;
    }
  }
  function closeDetail(silent) {
    var pane = $('detail');
    var wasOpen = pane.classList.contains('open');
    state.openId = null;
    pane.classList.remove('open');
    $('detailBody').innerHTML = placeholder();
    renderList();
    if (!silent && wasOpen && history.state && history.state.detail) history.back();
  }
  function placeholder() { return '<div class="detail-empty"><div>' + ICON.chat + '<b>Select a lead</b>Choose someone from the list to read the conversation.</div></div>'; }

  function renderDetail() {
    var l = state.leads.filter(function (x) { return x.id === state.openId; })[0];
    var body = $('detailBody');
    if (!l) { body.innerHTML = placeholder(); return; }
    var keepScroll = $('detail').scrollTop;
    var contactBits = [];
    if (l.phone) contactBits.push('<a href="tel:' + esc(l.phone) + '">' + esc(l.phone) + '</a>');
    if (l.email) contactBits.push('<a href="mailto:' + esc(l.email) + '">' + esc(l.email) + '</a>');
    if (!contactBits.length && l.contact) contactBits.push(esc(l.contact));
    var first = (l.name || '').split(/\s+/)[0] || 'there';
    var wa = l.phone ? 'https://wa.me/' + digits(l.phone) + '?text=' + encodeURIComponent('Hi ' + first + ', this is the Glad U Came team. Thank you for getting in touch about your enquiry.') : '';

    // conversation, grouped by day, photos as pictures
    var lastDay = '';
    var thread = (l.transcript || []).map(function (m) {
      var out = '';
      if (m.at) { var dl = dayLabel(m.at); if (dl !== lastDay) { lastDay = dl; out += '<div class="day">' + dl + '</div>'; } }
      var side = m.role === 'user' ? 'in' : 'out';
      var stamp = m.at ? '<time>' + clock(m.at) + '</time>' : '';
      var caption = String(m.content || '').replace(/^\[Photo\]\s*/, '');
      if (m.removed) return out + '<div class="bubble ' + side + ' gone">Photo removed' + stamp + '</div>';
      if (m.image) return out + '<div class="bubble ' + side + ' photo"><img data-full="' + m.image + '" src="' + m.image + '" alt="Photo sent by the customer" loading="lazy" />' + (caption ? '<span class="cap">' + esc(caption) + '</span>' : '') + stamp + '</div>';
      return out + '<div class="bubble ' + side + '">' + esc(m.content) + stamp + '</div>';
    }).join('');

    body.innerHTML =
      '<div class="detail-body">' +
      '<div class="d-head"><span class="avatar lg" style="background:' + tint(l.name) + '">' + esc(initials(l.name)) + '</span><div><h2>' + esc(l.name || 'Unknown') + '</h2>' +
      '<div class="sub">' + contactBits.join('<span>·</span>') + (contactBits.length ? '<span>·</span>' : '') + '<span class="chip">' + sourceIcon(l) + esc(l.source) + '</span><span>' + timeAgo(l.time) + (timeAgo(l.time) === 'now' ? '' : ' ago') + '</span></div></div></div>' +
      '<div class="d-status"><div class="seg wide" id="statusSeg">' + ['new', 'contacted', 'closed'].map(function (s) { return '<button type="button" data-status="' + s + '" class="' + (l.status === s ? 'on' : '') + '">' + statusLabel(s) + '</button>'; }).join('') + '</div></div>' +
      '<div class="d-actions">' +
      (wa ? '<a class="btn primary sm" target="_blank" rel="noopener" href="' + wa + '">' + ICON.chat + 'WhatsApp</a>' : '') +
      (l.phone ? '<a class="btn sm" href="tel:' + esc(l.phone) + '">' + ICON.phone + 'Call</a>' : '') +
      (l.email ? '<a class="btn sm" href="mailto:' + esc(l.email) + '">' + ICON.mail + 'Email</a>' : '') + '</div>' +
      '<div class="section"><h3>Summary</h3><p class="summary">' + esc(l.summary || 'No summary yet.') + '</p></div>' +
      '<div class="section"><h3>Details</h3><dl class="facts">' +
      fact('Service', l.projectType) + fact('Brand details', l.bhk) + fact('Location', l.location) + fact('Budget', l.budget) + fact('Timeline', l.timeline) + fact('Call', l.call) + fact('Stage', l.stage) + fact('Source', l.source) +
      '</dl></div>' +
      '<div class="section"><h3>Conversation</h3><div class="thread">' + (thread || '<div class="day">No messages yet</div>') + '</div></div>' +
      '<div class="d-foot"><button class="btn danger sm" id="deleteLead" type="button">' + ICON.trash + 'Delete lead</button></div></div>';
    $('detail').scrollTop = keepScroll;
  }
  $('detailBody').addEventListener('click', function (e) {
    var seg = e.target.closest('#statusSeg button');
    if (seg) { setStatus(state.openId, seg.dataset.status); return; }
    var del = e.target.closest('#deleteLead');
    if (del) { if (confirm('Delete this lead and its photos for good? This cannot be undone.')) removeLeads([state.openId], 'leads'); return; }
    var img = e.target.closest('.bubble.photo img');
    if (img) openLightbox(img.getAttribute('data-full'));
  });
  function setStatus(id, status) {
    var l = state.leads.filter(function (x) { return x.id === id; })[0];
    if (!l || l.status === status) return;
    var prev = l.status;
    l.status = status;
    state.leadSig[id] = leadSignature(l);
    state.sig = '';
    renderStats(); renderList(); renderDetail();
    api('/api/crm/leads/' + id, { method: 'PATCH', body: { status: status } }).catch(function () {
      l.status = prev; state.leadSig[id] = leadSignature(l); state.sig = ''; renderStats(); renderList(); renderDetail();
      toast('Could not save that change');
    });
  }
  $('backBtn').addEventListener('click', function () { closeDetail(false); });

  // ---------- photo viewer: Back, the browser's Back and Esc all return to the chat ----------
  var lbMedia = null;
  var skipPop = false;
  function openLightbox(src) {
    lbMedia = src.split('/').pop();
    $('lbImg').src = src;
    $('lbDownload').href = src;
    $('lbDownload').setAttribute('download', 'photo-' + lbMedia);
    $('lightbox').classList.add('show');
    history.pushState({ lightbox: 1 }, '');
  }
  function hideLightbox() { $('lightbox').classList.remove('show'); $('lbImg').removeAttribute('src'); lbMedia = null; }
  function closeLightbox() {
    if (!$('lightbox').classList.contains('show')) return;
    hideLightbox();
    if (history.state && history.state.lightbox) { skipPop = true; history.back(); } // undo the entry added on open, without the page reading it as a second Back
  }
  $('lightbox').addEventListener('click', function (e) { if (e.target.id === 'lightbox' || e.target.id === 'lbImg') closeLightbox(); });
  $('lbBack').addEventListener('click', closeLightbox);
  $('lbDelete').addEventListener('click', function () {
    if (!lbMedia || !confirm('Delete this photo for good? The chat will keep a note that it was removed.')) return;
    api('/api/media/' + lbMedia, { method: 'DELETE' }).then(function () { closeLightbox(); state.sig = ''; state.leadSig = {}; return loadAll(); })
      .catch(function (err) { if (err.message !== 'signed out') alert(err.message); });
  });
  window.addEventListener('popstate', function () {
    if (skipPop) { skipPop = false; return; }
    if ($('lightbox').classList.contains('show')) { hideLightbox(); return; }
    if ($('detail').classList.contains('open')) { $('detail').classList.remove('open'); state.openId = null; $('detailBody').innerHTML = placeholder(); renderList(); }
  });

  // ---------- clean up ----------
  var cl = { scope: 'photos', days: '90', status: 'closed' };
  var previewTimer = null;
  function segment(id, key) {
    $(id).addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      cl[key] = b.dataset.v;
      Array.prototype.forEach.call(this.children, function (c) { c.classList.toggle('on', c === b); });
      refreshPreview();
    });
  }
  segment('optScope', 'scope'); segment('optDays', 'days'); segment('optStatus', 'status');
  function refreshPreview() {
    var box = $('cleanupPreview'), go = $('cleanupGo');
    box.classList.remove('warn');
    box.textContent = 'Checking...';
    go.disabled = true;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(function () {
      api('/api/crm/cleanup/preview', { method: 'POST', body: { days: Number(cl.days), status: cl.status, scope: cl.scope } }).then(function (p) {
        var older = document.querySelector('#optDays .on').textContent.toLowerCase();
        var n;
        if (cl.scope === 'photos') {
          n = p.photos;
          box.textContent = n ? n + ' photo' + (n === 1 ? '' : 's') + ' from ' + p.photo_leads + ' lead' + (p.photo_leads === 1 ? '' : 's') + ' (' + fmtBytes(p.bytes) + ') older than ' + older + ' will be removed. The leads and their chats stay.' : 'No photos match right now.';
        } else {
          n = p.leads;
          box.classList.toggle('warn', n > 0);
          box.textContent = n ? n + ' lead' + (n === 1 ? '' : 's') + ' and ' + p.photos + ' photo' + (p.photos === 1 ? '' : 's') + ' (' + fmtBytes(p.bytes) + ') older than ' + older + ' will be removed for good.' : 'No leads match right now.';
        }
        go.disabled = !n;
      }).catch(function () { box.textContent = 'Could not check just now.'; });
    }, 220);
  }
  function openCleanup() { $('cleanup').classList.add('show'); refreshPreview(); loadUsage(); }
  function closeCleanup() { $('cleanup').classList.remove('show'); }
  $('openCleanup').addEventListener('click', openCleanup);
  $('cleanupCancel').addEventListener('click', closeCleanup);
  $('cleanup').addEventListener('click', function (e) { if (e.target === $('cleanup')) closeCleanup(); });
  $('cleanupCsv').addEventListener('click', exportCsv);
  $('cleanupGo').addEventListener('click', function () {
    this.disabled = true;
    var totals = { leads: 0, photos: 0, bytes: 0 };
    function step() {
      return api('/api/crm/cleanup', { method: 'POST', body: { days: Number(cl.days), status: cl.status, scope: cl.scope } }).then(function (j) {
        totals.leads += j.leads; totals.photos += j.photos; totals.bytes += j.bytes;
        return j.remaining > 0 ? step() : totals;
      });
    }
    step().then(function (t) {
      closeCleanup();
      state.selected.clear(); state.sig = ''; state.leadSig = {};
      toast(cl.scope === 'leads' ? 'Removed ' + t.leads + ' lead' + (t.leads === 1 ? '' : 's') + ' and ' + t.photos + ' photo' + (t.photos === 1 ? '' : 's') + ', freed ' + fmtBytes(t.bytes) : 'Removed ' + t.photos + ' photo' + (t.photos === 1 ? '' : 's') + ', freed ' + fmtBytes(t.bytes));
      return loadAll();
    }).catch(function (err) { if (err.message !== 'signed out') alert(err.message); refreshPreview(); });
  });
  $('retention').addEventListener('change', function () {
    var days = Number(this.value);
    api('/api/crm/retention', { method: 'PUT', body: { photo_days: days } })
      .then(function () { toast(days ? 'Photos will be deleted automatically after that time' : 'Photos will be kept'); })
      .catch(function () { alert('Could not save that setting. Please try again.'); loadUsage(); });
  });

  // ---------- export ----------
  function csvCell(v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }
  function exportCsv() {
    if (!state.leads.length) { toast('Nothing to export yet'); return; }
    var cols = ['Name', 'Phone', 'Email', 'Source', 'Service', 'Brand details', 'Location', 'Budget', 'Timeline', 'Status', 'Captured', 'Summary'];
    var rows = state.leads.map(function (l) { return [l.name, l.phone, l.email, l.source, l.projectType, l.bhk, l.location, l.budget, l.timeline, statusLabel(l.status), l.time, l.summary]; });
    var csv = cols.map(csvCell).join(',') + '\n' + rows.map(function (r) { return r.map(csvCell).join(','); }).join('\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'gladucame-leads-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  $('exportCsv').addEventListener('click', exportCsv);

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if ($('lightbox').classList.contains('show')) closeLightbox();
    else if ($('cleanup').classList.contains('show')) closeCleanup();
  });

  // ---------- go ----------
  $('detailBody').innerHTML = placeholder();
  renderStats();
  renderList();
  loadAll().then(function () {
    var m = location.hash.match(/lead=(\d+)/);
    if (m) openLead(Number(m[1]));
  });
  setInterval(function () { if (!document.hidden) loadLeads(); }, 6000);
  setInterval(function () { if (!document.hidden) { loadUsage(); loadInstagram(); } }, 60000);
  // Coming back from Instagram's approval page.
  (function () {
    var m = location.search.match(/[?&]ig=(\w+)/);
    if (!m) return;
    var why = (location.search.match(/[?&]m=([^&]+)/) || [])[1];
    var msgs = { connected: 'Instagram is connected again', denied: 'Instagram was not connected. You can try again any time.', expired: 'That link timed out. Please tap Reconnect again.', failed: why ? decodeURIComponent(why) : 'Could not connect Instagram. Please try again.' };
    toast(msgs[m[1]] || 'Done');
    history.replaceState(null, '', '/crm');
  })();
  document.addEventListener('visibilitychange', function () { if (!document.hidden) loadAll(); });
})();
