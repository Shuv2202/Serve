import { useCallback, useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import './App.css';
import { API_URL, IS_MISSING_CONFIG } from './config';
import { io } from 'socket.io-client';

// ─── Helper: compute minutes since a timestamp ───────────────────────────────
function getAgeMinutes(createdAt, now) {
  if (!createdAt) return 0;
  const dateStr = createdAt.endsWith('Z') ? createdAt : `${createdAt}Z`;
  return Math.floor((now - new Date(dateStr).getTime()) / 60000);
}

// ─── Helper: format elapsed time in MM:SS ────────────────────────────────────
function formatElapsed(createdAt, now) {
  if (!createdAt) return '00:00';
  const dateStr = createdAt.endsWith('Z') ? createdAt : `${createdAt}Z`;
  const diffMs = now - new Date(dateStr).getTime();
  if (diffMs < 0) return '00:00';
  const diffSecs = Math.floor(diffMs / 1000);
  const mins = Math.floor(diffSecs / 60);
  const secs = diffSecs % 60;
  
  if (mins >= 60) {
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    return `${hours}h ${String(remMins).padStart(2, '0')}m`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

// ─── Urgency tier based on age + status ──────────────────────────────────────
function getUrgencyClass(status, ageMinutes) {
  if (status !== 'pending' && status !== 'cooking') return '';
  if (ageMinutes >= 10) return 'urgency-critical';
  if (ageMinutes >= 5) return 'urgency-high';
  return '';
}

// ─── Web Audio chime ─────────────────────────────────────────────────────────
function playChime(volume = 0.5) {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    [[523.25, 0, 0.3], [659.25, 0.1, 0.4]].forEach(([freq, delay, stop]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, ctx.currentTime + delay);
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.setValueAtTime(0.15 * volume, ctx.currentTime + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + stop);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + delay);
      osc.stop(ctx.currentTime + stop);
    });
  } catch (e) {
    console.error('Audio error:', e);
  }
}

// ─── Recipe Modal Component ──────────────────────────────────────────────────
function RecipeModal({ item, onClose }) {
  return (
    <AnimatePresence>
      {item && (
        <motion.div
          className="recipe-modal-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            className="recipe-modal"
            initial={{ opacity: 0, scale: 0.88, y: 30 }}
            animate={{ opacity: 1, scale: 1, y: 0, transition: { type: 'spring', stiffness: 320, damping: 28 } }}
            exit={{ opacity: 0, scale: 0.92, y: 20, transition: { duration: 0.2 } }}
            onClick={e => e.stopPropagation()}
          >
            <div className="recipe-modal-header">
              <div className="recipe-modal-title-area">
                <span className="recipe-modal-icon">🍳</span>
                <h2 className="recipe-modal-title">{item.name}</h2>
              </div>
              <button className="recipe-modal-close" onClick={onClose}>✕</button>
            </div>
            <div className="recipe-modal-body">
              {item.recipe_instructions ? (
                <div className="recipe-content">
                  <p className="recipe-label">Preparation Instructions</p>
                  <div className="recipe-text">{item.recipe_instructions}</div>
                </div>
              ) : (
                <div className="recipe-empty">
                  <span className="recipe-empty-icon">📋</span>
                  <p>No recipe instructions registered for this dish.</p>
                  <p className="recipe-empty-sub">Instructions can be added via the database editor.</p>
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}


// ─── Main Kitchen Component ───────────────────────────────────────────────────
function Kitchen() {
  if (IS_MISSING_CONFIG) {
    return (
      <div className="kitchen-container" style={{ padding: '40px', textAlign: 'center' }}>
        <h2>Backend Connection Required</h2>
        <p style={{ margin: '15px 0' }}>The kitchen dashboard is deployed, but the backend API URL has not been configured.</p>
        <p style={{ fontSize: '14px', color: '#666' }}>
          Please add the <code>VITE_API_URL</code> environment variable in your site configuration settings.
        </p>
      </div>
    );
  }

  const [orders, setOrders] = useState([]);
  const [soundEnabled, setSoundEnabled] = useState(() => {
    const s = localStorage.getItem('serveme_kitchen_sound');
    return s !== null ? JSON.parse(s) : true;
  });
  const [volume, setVolume] = useState(() => {
    const v = localStorage.getItem('serveme_kitchen_volume');
    return v !== null ? Number(v) : 0.5;
  });
  const [seenOrderIds, setSeenOrderIds] = useState(new Set());
  const [newOrderIds, setNewOrderIds] = useState([]);
  const [now, setNow] = useState(Date.now());

  const [recipeItem, setRecipeItem] = useState(null); // { name, recipe_instructions }
  const [activeTab, setActiveTab] = useState('pending');

  const params = new URLSearchParams(window.location.search);
  const RESTAURANT_ID = Number(params.get('restaurant_id')) || 1;

  // Clock tick every second for high-precision timer display
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const fetchOrders = useCallback(() => {
    fetch(`${API_URL}/restaurants/${RESTAURANT_ID}/orders/`)
      .then(res => { if (!res.ok) throw new Error('Failed'); return res.json(); })
      .then(data => setOrders(data))
      .catch(err => console.error(err));
  }, [RESTAURANT_ID]);

  // New order detection + chime
  useEffect(() => {
    if (orders.length === 0) return;
    const currentIds = orders.map(o => o.id);
    const newIds = currentIds.filter(id => !seenOrderIds.has(id));
    if (newIds.length > 0) {
      if (seenOrderIds.size > 0 && soundEnabled) playChime(volume);
      if (seenOrderIds.size > 0) {
        setNewOrderIds(prev => [...prev, ...newIds]);
        setTimeout(() => setNewOrderIds(prev => prev.filter(id => !newIds.includes(id))), 5000);
      }
      setSeenOrderIds(prev => { const n = new Set(prev); newIds.forEach(id => n.add(id)); return n; });
    }
  }, [orders, seenOrderIds, soundEnabled, volume]);

  // Socket.io real-time connection
  useEffect(() => {
    fetchOrders();
    const socket = io(API_URL, { path: '/socket.io' });
    socket.on('connect', () => {
      socket.emit('join_restaurant', { restaurant_id: RESTAURANT_ID });
    });
    socket.on('order_update', data => {
      if (data === 'UPDATE_ORDERS') fetchOrders();
    });
    return () => socket.disconnect();
  }, [RESTAURANT_ID, fetchOrders]);

  const updateStatus = async (orderId, newStatus) => {
    const res = await fetch(`${API_URL}/orders/${orderId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    });
    if (!res.ok) return;
    setOrders(prev =>
      prev.map(o => o.id === orderId ? { ...o, status: newStatus } : o)
          .filter(o => o.status !== 'completed')
    );
  };

  const toggleSound = () => {
    setSoundEnabled(prev => {
      const next = !prev;
      localStorage.setItem('serveme_kitchen_sound', JSON.stringify(next));
      if (next) playChime(volume);
      return next;
    });
  };

  const handleVolumeChange = e => {
    const v = parseFloat(e.target.value);
    setVolume(v);
    localStorage.setItem('serveme_kitchen_volume', String(v));
    playChime(v);
  };

  // Status-based ordering
  const pendingOrders = useMemo(() => orders.filter(o => o.status === 'pending'), [orders]);
  const cookingOrders = useMemo(() => orders.filter(o => o.status === 'cooking'), [orders]);
  const readyOrders = useMemo(() => orders.filter(o => o.status === 'ready'), [orders]);

  // General counts
  const pendingCount = pendingOrders.length;
  const cookingCount = cookingOrders.length;
  const readyCount = readyOrders.length;



  const cardVariants = {
    initial: { opacity: 0, scale: 0.92, y: 15 },
    animate: { opacity: 1, scale: 1, y: 0, transition: { type: 'spring', stiffness: 300, damping: 25 } },
    exit: { opacity: 0, x: -50, scale: 0.95, transition: { duration: 0.2 } }
  };

  const renderOrderCard = (order) => {
    const isNew = newOrderIds.includes(order.id);
    const displayNum = String(order.order_number).padStart(3, '0');
    const ageMinutes = getAgeMinutes(order.created_at, now);
    const elapsedStr = formatElapsed(order.created_at, now);
    const urgencyClass = getUrgencyClass(order.status, ageMinutes);
    const statusClass = order.status.toLowerCase();

    return (
      <motion.div
        key={order.id}
        layout
        variants={cardVariants}
        initial="initial"
        animate="animate"
        exit="exit"
        className={`order-card-glass status-${statusClass} ${isNew ? 'new-order-glow' : ''} ${urgencyClass}`}
      >
        {/* Glowing top status bar */}
        <div className={`card-edge edge-${statusClass}`} />

        {/* Card Header */}
        <div className="order-card-header">
          <div className="order-id-area">
            <span className="order-number">#{displayNum}</span>
            <span className="order-age">⏳ {elapsedStr}</span>
          </div>
          <div className={`status-led-group status-${statusClass}`}>
            <span className={`status-led ${urgencyClass ? 'led-urgent' : ''}`} />
            <span className="status-label">{order.status}</span>
          </div>
        </div>

        {/* Order Items */}
        <ul className="order-items-list">
          {order.items.map(item => (
            <li key={item.id}>
              <div className="order-item-line">
                <span className="item-qty">{item.quantity}×</span>
                <div className="order-item-info">
                  <button
                    className="item-name-btn"
                    onClick={() => setRecipeItem({
                      name: item.menu_item_name || `Item #${item.menu_item_id}`,
                      recipe_instructions: item.recipe_instructions
                    })}
                    title="Click to view preparation recipe"
                    style={{
                      background: 'none',
                      border: 'none',
                      color: '#cbd5e1',
                      fontFamily: 'inherit',
                      fontSize: '14px',
                      fontWeight: 500,
                      textAlign: 'left',
                      cursor: 'pointer',
                      padding: 0
                    }}
                  >
                    {item.menu_item_name || `Item #${item.menu_item_id}`}
                  </button>
                  {item.notes && (
                    <span className="item-notes">📝 {item.notes}</span>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>

        {/* Action Button */}
        <div className="order-actions">
          {order.status === 'pending' && (
            <button onClick={() => updateStatus(order.id, 'cooking')} className="btn-pill btn-cooking">
              <span className="btn-icon">🔥</span>
              <span className="btn-text">Start Cooking</span>
            </button>
          )}
          {order.status === 'cooking' && (
            <button onClick={() => updateStatus(order.id, 'ready')} className="btn-pill btn-ready">
              <span className="btn-icon">✅</span>
              <span className="btn-text">Mark Ready</span>
            </button>
          )}
          {order.status === 'ready' && (
            <button onClick={() => updateStatus(order.id, 'completed')} className="btn-pill btn-complete">
              <span className="btn-icon">🤝</span>
              <span className="btn-text">Picked Up</span>
            </button>
          )}
        </div>
      </motion.div>
    );
  };

  return (
    <div className="kitchen-container">
      {/* ── Recipe Modal Popup ── */}
      <RecipeModal item={recipeItem} onClose={() => setRecipeItem(null)} />

      {/* ── Header ── */}
      <header className="kitchen-header">
        <div className="kitchen-title-area">
          <h1>Kitchen Dashboard</h1>
          <span className="live-indicator">Live</span>
        </div>

        {/* Aggregate Stats */}
        <div className="kitchen-stats">
          <div className="stat-chip pending">
            <span className="stat-dot dot-pending" />
            <span className="label">Pending</span>
            <span className="value">{pendingCount}</span>
          </div>
          <div className="stat-chip cooking">
            <span className="stat-dot dot-cooking" />
            <span className="label">Cooking</span>
            <span className="value">{cookingCount}</span>
          </div>
          <div className="stat-chip ready">
            <span className="stat-dot dot-ready" />
            <span className="label">Ready</span>
            <span className="value">{readyCount}</span>
          </div>

        </div>

        {/* Global Toolbar */}
        <div className="kitchen-header-actions">

          
          <div className="sound-controls">
            <button
              className={`sound-toggle-btn ${!soundEnabled ? 'muted' : ''}`}
              onClick={toggleSound}
              title={soundEnabled ? 'Mute' : 'Unmute'}
            >
              {soundEnabled ? '🔊' : '🔇'}
            </button>
            {soundEnabled && (
              <>
                <input
                  type="range" min="0" max="1" step="0.1"
                  value={volume} onChange={handleVolumeChange}
                  className="volume-slider" title="Adjust Volume"
                />

              </>
            )}
          </div>
        </div>
      </header>



      {/* Mobile Kanban Tabs Bar */}
      <div className="mobile-kanban-tabs">
        <button
          className={`kanban-tab-btn tab-pending ${activeTab === 'pending' ? 'active' : ''}`}
          onClick={() => setActiveTab('pending')}
        >
          <span className="tab-dot dot-pending" />
          <span>Pending ({pendingCount})</span>
        </button>
        <button
          className={`kanban-tab-btn tab-cooking ${activeTab === 'cooking' ? 'active' : ''}`}
          onClick={() => setActiveTab('cooking')}
        >
          <span className="tab-dot dot-cooking" />
          <span>Cooking ({cookingCount})</span>
        </button>
        <button
          className={`kanban-tab-btn tab-ready ${activeTab === 'ready' ? 'active' : ''}`}
          onClick={() => setActiveTab('ready')}
        >
          <span className="tab-dot dot-ready" />
          <span>Ready ({readyCount})</span>
        </button>
      </div>

      {/* ── 3-Column Kanban Board View ── */}
      <div className="kitchen-board-columns">
        
        {/* 1. Pending Column */}
        <div className={`kanban-column column-pending ${activeTab === 'pending' ? 'mobile-visible' : 'mobile-hidden'}`}>
          <div className="column-header">
            <h3>Pending Orders</h3>
            <span className="column-count-badge">{pendingCount}</span>
          </div>
          <div className="column-cards-container">
            <AnimatePresence mode="popLayout">
              {pendingOrders.map(order => renderOrderCard(order))}
            </AnimatePresence>
            {pendingCount === 0 && (
              <div className="column-empty-state">
                <p>No pending orders</p>
              </div>
            )}
          </div>
        </div>

        {/* 2. Cooking Column */}
        <div className={`kanban-column column-cooking ${activeTab === 'cooking' ? 'mobile-visible' : 'mobile-hidden'}`}>
          <div className="column-header">
            <h3>Cooking / Preparing</h3>
            <span className="column-count-badge">{cookingCount}</span>
          </div>
          <div className="column-cards-container">
            <AnimatePresence mode="popLayout">
              {cookingOrders.map(order => renderOrderCard(order))}
            </AnimatePresence>
            {cookingCount === 0 && (
              <div className="column-empty-state">
                <p>No active cooking items</p>
              </div>
            )}
          </div>
        </div>

        {/* 3. Ready Column */}
        <div className={`kanban-column column-ready ${activeTab === 'ready' ? 'mobile-visible' : 'mobile-hidden'}`}>
          <div className="column-header">
            <h3>Ready for Pickup</h3>
            <span className="column-count-badge">{readyCount}</span>
          </div>
          <div className="column-cards-container">
            <AnimatePresence mode="popLayout">
              {readyOrders.map(order => renderOrderCard(order))}
            </AnimatePresence>
            {readyCount === 0 && (
              <div className="column-empty-state">
                <p>No orders ready yet</p>
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}

export default Kitchen;
