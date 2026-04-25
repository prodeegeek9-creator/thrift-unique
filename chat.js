/*
  =============================================
  UNIQUE THRIFT — LIVE CHAT WIDGET
  Add this to index.html just before </body>:
  <script src="./chat.js"></script>
  =============================================
*/

(function () {
  const SUPABASE_URL = 'https://gkjafimeduwdvpuknzuy.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_0_3aVoO9ilHRPYpHvXEjMA_SxEWzHBY';

  // How many minutes of inactivity before owner is considered offline
  const OWNER_TIMEOUT_MINUTES = 5;

  // Owner's WhatsApp number for direct link when offline
  const OWNER_WHATSAPP = '+2348000000000'; // Replace with real number

  let chatOpen = false;
  let ownerOnline = false;
  let sessionId = null;
  let messages = [];
  let pollInterval = null;
  let currentProductId = null;
  let currentProductTitle = null;
  let sbClient = null;

  // ── INIT ──
  async function init() {
    // Wait for Supabase SDK to be ready
    if (!window.supabase) {
      setTimeout(init, 500);
      return;
    }

    sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    sessionId = getOrCreateSession();
    injectStyles();
    injectWidget();
    await checkOwnerStatus();

    // Check owner status every 30 seconds
    setInterval(checkOwnerStatus, 30000);
  }

  // ── SESSION ──
  function getOrCreateSession() {
    let id = sessionStorage.getItem('ut_chat_session');
    if (!id) {
      id = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      sessionStorage.setItem('ut_chat_session', id);
    }
    return id;
  }

  // ── OWNER STATUS ──
  async function checkOwnerStatus() {
    try {
      const { data } = await sbClient
        .from('owner_status')
        .select('last_seen, is_online')
        .eq('id', 1)
        .single();

      if (data) {
        const lastSeen = new Date(data.last_seen);
        const minutesAgo = (Date.now() - lastSeen.getTime()) / 60000;
        ownerOnline = data.is_online && minutesAgo < OWNER_TIMEOUT_MINUTES;
      } else {
        ownerOnline = false;
      }
    } catch {
      ownerOnline = false;
    }
    updateOnlineIndicator();
  }

  function updateOnlineIndicator() {
    const dot = document.getElementById('ut-online-dot');
    const label = document.getElementById('ut-online-label');
    if (!dot || !label) return;
    dot.style.background = ownerOnline ? '#4f9d6e' : '#9a9086';
    label.textContent = ownerOnline ? 'Online — usually replies instantly' : 'Offline — leave a message';
  }

  // ── INJECT STYLES ──
  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      #ut-chat-btn {
        position: fixed;
        bottom: 24px;
        right: 24px;
        width: 56px;
        height: 56px;
        background: #1a1a18;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        z-index: 9998;
        box-shadow: 0 4px 20px rgba(0,0,0,0.25);
        transition: transform 0.2s, background 0.2s;
        border: none;
      }

      #ut-chat-btn:hover { transform: scale(1.08); background: #c4622d; }

      #ut-chat-btn svg { width: 24px; height: 24px; fill: white; }

      #ut-unread-badge {
        position: absolute;
        top: -4px;
        right: -4px;
        background: #c4622d;
        color: white;
        font-size: 10px;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        display: none;
        align-items: center;
        justify-content: center;
        font-family: 'DM Sans', sans-serif;
        font-weight: 500;
      }

      #ut-chat-window {
        position: fixed;
        bottom: 92px;
        right: 24px;
        width: 340px;
        height: 480px;
        background: white;
        border-radius: 20px;
        box-shadow: 0 8px 40px rgba(0,0,0,0.18);
        display: none;
        flex-direction: column;
        z-index: 9999;
        overflow: hidden;
        font-family: 'DM Sans', Arial, sans-serif;
        animation: utSlideUp 0.25s ease;
      }

      @keyframes utSlideUp {
        from { opacity: 0; transform: translateY(16px); }
        to { opacity: 1; transform: translateY(0); }
      }

      #ut-chat-window.open { display: flex; }

      .ut-header {
        background: #1a1a18;
        padding: 16px 18px;
        display: flex;
        align-items: center;
        gap: 12px;
      }

      .ut-avatar {
        width: 38px;
        height: 38px;
        border-radius: 50%;
        background: #c4622d;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 18px;
        flex-shrink: 0;
      }

      .ut-header-info { flex: 1; }

      .ut-header-name {
        font-size: 14px;
        font-weight: 600;
        color: #f5f0e8;
      }

      .ut-header-status {
        display: flex;
        align-items: center;
        gap: 5px;
        margin-top: 2px;
      }

      #ut-online-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: #9a9086;
        transition: background 0.3s;
      }

      #ut-online-label {
        font-size: 11px;
        color: #9a9086;
      }

      .ut-close-btn {
        background: none;
        border: none;
        color: rgba(245,240,232,0.5);
        font-size: 20px;
        cursor: pointer;
        padding: 4px;
        line-height: 1;
        transition: color 0.2s;
      }

      .ut-close-btn:hover { color: #f5f0e8; }

      /* TABS */
      .ut-tabs {
        display: flex;
        border-bottom: 1px solid #e8e0d0;
        background: #faf8f4;
      }

      .ut-tab {
        flex: 1;
        padding: 10px;
        text-align: center;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        color: #9a9086;
        border-bottom: 2px solid transparent;
        transition: all 0.2s;
      }

      .ut-tab.active { color: #c4622d; border-bottom-color: #c4622d; background: white; }

      /* MESSAGES AREA */
      .ut-messages {
        flex: 1;
        overflow-y: auto;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        background: #faf8f4;
      }

      .ut-messages::-webkit-scrollbar { width: 4px; }
      .ut-messages::-webkit-scrollbar-thumb { background: #e8e0d0; border-radius: 2px; }

      .ut-msg {
        max-width: 80%;
        padding: 10px 13px;
        border-radius: 14px;
        font-size: 13px;
        line-height: 1.5;
        animation: utFadeIn 0.2s ease;
      }

      @keyframes utFadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; } }

      .ut-msg.buyer {
        background: #1a1a18;
        color: #f5f0e8;
        align-self: flex-end;
        border-bottom-right-radius: 4px;
      }

      .ut-msg.owner {
        background: white;
        color: #1a1a18;
        align-self: flex-start;
        border: 1px solid #e8e0d0;
        border-bottom-left-radius: 4px;
      }

      .ut-msg.system {
        background: transparent;
        color: #9a9086;
        font-size: 11px;
        text-align: center;
        align-self: center;
        padding: 4px 8px;
      }

      .ut-msg-time {
        font-size: 10px;
        opacity: 0.5;
        margin-top: 4px;
      }

      .ut-typing {
        display: none;
        align-items: center;
        gap: 4px;
        padding: 10px 13px;
        background: white;
        border: 1px solid #e8e0d0;
        border-radius: 14px;
        border-bottom-left-radius: 4px;
        align-self: flex-start;
        width: fit-content;
      }

      .ut-typing.show { display: flex; }

      .ut-typing span {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #9a9086;
        animation: utBounce 1s infinite;
      }

      .ut-typing span:nth-child(2) { animation-delay: 0.15s; }
      .ut-typing span:nth-child(3) { animation-delay: 0.3s; }

      @keyframes utBounce {
        0%, 60%, 100% { transform: translateY(0); }
        30% { transform: translateY(-5px); }
      }

      /* INPUT AREA */
      .ut-input-area {
        padding: 12px 14px;
        border-top: 1px solid #e8e0d0;
        display: flex;
        gap: 8px;
        align-items: flex-end;
        background: white;
      }

      .ut-input {
        flex: 1;
        border: 1.5px solid #e8e0d0;
        border-radius: 20px;
        padding: 9px 14px;
        font-family: 'DM Sans', Arial, sans-serif;
        font-size: 13px;
        outline: none;
        resize: none;
        max-height: 80px;
        overflow-y: auto;
        transition: border-color 0.2s;
        line-height: 1.4;
      }

      .ut-input:focus { border-color: #c4622d; }

      .ut-send-btn {
        width: 36px;
        height: 36px;
        background: #1a1a18;
        border: none;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        flex-shrink: 0;
        transition: background 0.2s;
      }

      .ut-send-btn:hover { background: #c4622d; }
      .ut-send-btn svg { width: 16px; height: 16px; fill: white; }

      /* OFFLINE FORM */
      .ut-offline-form {
        flex: 1;
        padding: 16px;
        overflow-y: auto;
        background: #faf8f4;
        display: none;
        flex-direction: column;
        gap: 10px;
      }

      .ut-offline-form.show { display: flex; }

      .ut-offline-title {
        font-size: 14px;
        font-weight: 600;
        color: #1a1a18;
        margin-bottom: 4px;
      }

      .ut-offline-sub {
        font-size: 12px;
        color: #9a9086;
        margin-bottom: 8px;
        line-height: 1.5;
      }

      .ut-form-input, .ut-form-textarea {
        width: 100%;
        padding: 10px 13px;
        border: 1.5px solid #e8e0d0;
        border-radius: 10px;
        font-family: 'DM Sans', Arial, sans-serif;
        font-size: 13px;
        outline: none;
        background: white;
        transition: border-color 0.2s;
      }

      .ut-form-input:focus, .ut-form-textarea:focus { border-color: #c4622d; }
      .ut-form-textarea { resize: vertical; min-height: 80px; line-height: 1.5; }

      .ut-submit-btn {
        width: 100%;
        padding: 11px;
        background: #1a1a18;
        color: white;
        border: none;
        border-radius: 100px;
        font-family: 'DM Sans', Arial, sans-serif;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        transition: background 0.2s;
        margin-top: 4px;
      }

      .ut-submit-btn:hover { background: #c4622d; }

      .ut-whatsapp-btn {
        width: 100%;
        padding: 11px;
        background: #25D366;
        color: white;
        border: none;
        border-radius: 100px;
        font-family: 'DM Sans', Arial, sans-serif;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        text-decoration: none;
        transition: opacity 0.2s;
      }

      .ut-whatsapp-btn:hover { opacity: 0.9; }

      .ut-divider {
        display: flex;
        align-items: center;
        gap: 8px;
        color: #9a9086;
        font-size: 11px;
      }

      .ut-divider::before, .ut-divider::after {
        content: '';
        flex: 1;
        height: 1px;
        background: #e8e0d0;
      }

      .ut-success-msg {
        text-align: center;
        padding: 20px;
        display: none;
      }

      .ut-success-msg.show { display: block; }
      .ut-success-icon { font-size: 40px; margin-bottom: 10px; }
      .ut-success-text { font-size: 14px; font-weight: 500; color: #1a1a18; margin-bottom: 6px; }
      .ut-success-sub { font-size: 12px; color: #9a9086; }

      /* Name prompt */
      .ut-name-prompt {
        padding: 16px;
        background: #faf8f4;
        flex: 1;
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 12px;
      }

      .ut-name-prompt h4 { font-size: 15px; font-weight: 600; color: #1a1a18; }
      .ut-name-prompt p { font-size: 13px; color: #9a9086; line-height: 1.5; }

      @media (max-width: 400px) {
        #ut-chat-window { width: calc(100vw - 32px); right: 16px; bottom: 80px; }
      }
    `;
    document.head.appendChild(style);
  }

  // ── INJECT WIDGET HTML ──
  function injectWidget() {
    const btn = document.createElement('button');
    btn.id = 'ut-chat-btn';
    btn.setAttribute('aria-label', 'Open chat');
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/>
      </svg>
      <div id="ut-unread-badge"></div>`;
    btn.onclick = toggleChat;
    document.body.appendChild(btn);

    const win = document.createElement('div');
    win.id = 'ut-chat-window';
    win.innerHTML = `
      <div class="ut-header">
        <div class="ut-avatar">🛍️</div>
        <div class="ut-header-info">
          <div class="ut-header-name">Unique Thrift Support</div>
          <div class="ut-header-status">
            <div id="ut-online-dot"></div>
            <div id="ut-online-label">Checking...</div>
          </div>
        </div>
        <button class="ut-close-btn" onclick="window.__utChat.close()">✕</button>
      </div>

      <div class="ut-tabs" id="ut-tabs">
        <div class="ut-tab active" onclick="window.__utChat.switchTab('chat', this)">💬 Live Chat</div>
        <div class="ut-tab" onclick="window.__utChat.switchTab('message', this)">📩 Leave Message</div>
      </div>

      <!-- CHAT TAB -->
      <div id="ut-chat-tab">
        <!-- Name prompt (shown first) -->
        <div class="ut-name-prompt" id="ut-name-prompt">
          <h4>👋 Hey there!</h4>
          <p>Before we chat, what should we call you?</p>
          <input type="text" class="ut-form-input" id="ut-buyer-name" placeholder="Your name" />
          <input type="email" class="ut-form-input" id="ut-buyer-email" placeholder="Email (optional)" />
          <button class="ut-submit-btn" onclick="window.__utChat.startChat()">Start Chat →</button>
        </div>

        <!-- Messages -->
        <div class="ut-messages" id="ut-messages" style="display:none">
          <div class="ut-typing" id="ut-typing">
            <span></span><span></span><span></span>
          </div>
        </div>

        <div class="ut-input-area" id="ut-input-area" style="display:none">
          <textarea class="ut-input" id="ut-msg-input" placeholder="Type a message..." rows="1"
            onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();window.__utChat.send();}"></textarea>
          <button class="ut-send-btn" onclick="window.__utChat.send()">
            <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
          </button>
        </div>
      </div>

      <!-- OFFLINE / LEAVE MESSAGE TAB -->
      <div id="ut-message-tab" style="display:none">
        <div class="ut-offline-form show" id="ut-offline-form">
          <div class="ut-offline-title">Leave us a message</div>
          <div class="ut-offline-sub">We'll get back to you via email or WhatsApp as soon as possible.</div>
          <input type="text" class="ut-form-input" id="ut-off-name" placeholder="Your name *" />
          <input type="email" class="ut-form-input" id="ut-off-email" placeholder="Email address *" />
          <input type="tel" class="ut-form-input" id="ut-off-phone" placeholder="WhatsApp number (optional)" />
          <textarea class="ut-form-textarea" id="ut-off-message" placeholder="Your message *"></textarea>
          <button class="ut-submit-btn" onclick="window.__utChat.submitOffline()">Send Message →</button>
          <div class="ut-divider">or reach us directly</div>
          <a class="ut-whatsapp-btn" href="https://wa.me/${OWNER_WHATSAPP.replace(/[^0-9]/g,'')}" target="_blank">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="white"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
            Chat on WhatsApp
          </a>
        </div>
        <div class="ut-success-msg" id="ut-offline-success">
          <div class="ut-success-icon">✅</div>
          <div class="ut-success-text">Message sent!</div>
          <div class="ut-success-sub">We'll get back to you within 24 hours via email or WhatsApp.</div>
        </div>
      </div>
    `;
    document.body.appendChild(win);

    // Expose public API
    window.__utChat = { close: closeChat, switchTab, startChat, send, submitOffline };
  }

  // ── TOGGLE CHAT ──
  function toggleChat() {
    chatOpen ? closeChat() : openChat();
  }

  function openChat() {
    chatOpen = true;
    document.getElementById('ut-chat-window').classList.add('open');
    document.getElementById('ut-unread-badge').style.display = 'none';

    // Auto-switch to offline form if owner is offline
    if (!ownerOnline) {
      switchTab('message', document.querySelectorAll('.ut-tab')[1]);
    }

    updateOnlineIndicator();
  }

  function closeChat() {
    chatOpen = false;
    document.getElementById('ut-chat-window').classList.remove('open');
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  }

  // ── TABS ──
  function switchTab(tab, el) {
    document.querySelectorAll('.ut-tab').forEach(t => t.classList.remove('active'));
    if (el) el.classList.add('active');
    document.getElementById('ut-chat-tab').style.display = tab === 'chat' ? 'flex' : 'none';
    document.getElementById('ut-chat-tab').style.flexDirection = 'column';
    document.getElementById('ut-message-tab').style.display = tab === 'message' ? 'flex' : 'none';
    document.getElementById('ut-message-tab').style.flexDirection = 'column';
  }

  // ── START CHAT ──
  async function startChat() {
    const name = document.getElementById('ut-buyer-name').value.trim();
    if (!name) {
      document.getElementById('ut-buyer-name').style.borderColor = '#d94f4f';
      return;
    }

    sessionStorage.setItem('ut_buyer_name', name);
    sessionStorage.setItem('ut_buyer_email', document.getElementById('ut-buyer-email').value.trim());

    document.getElementById('ut-name-prompt').style.display = 'none';
    document.getElementById('ut-messages').style.display = 'flex';
    document.getElementById('ut-input-area').style.display = 'flex';

    // Load existing messages for this session
    await loadMessages();

    // Add welcome message if no history
    if (messages.length === 0) {
      addLocalMessage('system', ownerOnline
        ? `Hi ${name}! 👋 We're online and ready to help. What can we assist you with?`
        : `Hi ${name}! 👋 We're currently offline but will reply as soon as we're back. Leave your message below!`
      );
    }

    // Start polling for new messages
    pollInterval = setInterval(loadMessages, 4000);
    document.getElementById('ut-msg-input').focus();
  }

  // ── SEND MESSAGE ──
  async function send() {
    const input = document.getElementById('ut-msg-input');
    const text = input.value.trim();
    if (!text) return;

    const name = sessionStorage.getItem('ut_buyer_name') || 'Buyer';
    const email = sessionStorage.getItem('ut_buyer_email') || '';

    input.value = '';
    input.style.height = 'auto';

    // Optimistically show message
    addLocalMessage('buyer', text);

    // Save to Supabase
    await sbClient.from('chat_messages').insert({
      session_id: sessionId,
      sender: 'buyer',
      sender_name: name,
      sender_email: email,
      message: text,
      product_id: currentProductId || null,
      product_title: currentProductTitle || null
    });
  }

  // ── LOAD MESSAGES ──
  async function loadMessages() {
    const { data } = await sbClient
      .from('chat_messages')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });

    if (!data) return;

    const container = document.getElementById('ut-messages');
    const typing = document.getElementById('ut-typing');

    // Only re-render if count changed
    if (data.length === messages.length) return;

    messages = data;
    container.innerHTML = '';
    container.appendChild(typing);

    data.forEach(m => {
      const div = document.createElement('div');
      div.className = `ut-msg ${m.sender}`;
      div.innerHTML = `
        ${m.message}
        <div class="ut-msg-time">${formatTime(m.created_at)}</div>`;
      container.appendChild(div);
    });

    container.scrollTop = container.scrollHeight;

    // Show unread badge if chat is closed
    if (!chatOpen && data[data.length - 1]?.sender === 'owner') {
      const badge = document.getElementById('ut-unread-badge');
      badge.style.display = 'flex';
      badge.textContent = '1';
    }
  }

  function addLocalMessage(type, text) {
    const container = document.getElementById('ut-messages');
    const typing = document.getElementById('ut-typing');
    const div = document.createElement('div');
    div.className = `ut-msg ${type}`;
    div.innerHTML = `${text}<div class="ut-msg-time">${formatTime(new Date().toISOString())}</div>`;
    container.insertBefore(div, typing);
    container.scrollTop = container.scrollHeight;
  }

  // ── OFFLINE FORM ──
  async function submitOffline() {
    const name = document.getElementById('ut-off-name').value.trim();
    const email = document.getElementById('ut-off-email').value.trim();
    const phone = document.getElementById('ut-off-phone').value.trim();
    const message = document.getElementById('ut-off-message').value.trim();

    if (!name || !email || !message) {
      if (!name) document.getElementById('ut-off-name').style.borderColor = '#d94f4f';
      if (!email) document.getElementById('ut-off-email').style.borderColor = '#d94f4f';
      if (!message) document.getElementById('ut-off-message').style.borderColor = '#d94f4f';
      return;
    }

    await sbClient.from('messages').insert({
      sender_name: name,
      sender_email: email,
      sender_phone: phone,
      message,
      product_id: currentProductId || null
    });

    document.getElementById('ut-offline-form').classList.remove('show');
    document.getElementById('ut-offline-success').classList.add('show');
  }

  // ── UTILS ──
  function formatTime(iso) {
    return new Date(iso).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' });
  }

  // ── SET PRODUCT CONTEXT (called from product modal) ──
  window.utSetProduct = function(id, title) {
    currentProductId = id;
    currentProductTitle = title;
  };

  // Start
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
