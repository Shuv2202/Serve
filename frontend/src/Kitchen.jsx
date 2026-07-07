import { useCallback, useState, useEffect, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import './App.css';
import { API_URL, IS_MISSING_CONFIG } from './config';
import { io } from 'socket.io-client';

// ─── Helper: compute minutes since a timestamp ───────────────────────────────
function getAgeMinutes(createdAt, now) {
  if (!createdAt) return 0;
  return Math.floor((now - new Date(createdAt).getTime()) / 60000);
}

function formatAge(minutes) {
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// ─── Urgency tier based on age + status ──────────────────────────────────────
function getUrgencyClass(status, ageMinutes) {
  if (status !== 'pending') return '';
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

// ─── Recipe Modal ─────────────────────────────────────────────────────────────
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
                  <p>No recipe on file for this item.</p>
                  <p className="recipe-empty-sub">Ask your head chef or update via the admin panel.</p>
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ─── Prep View Panel ──────────────────────────────────────────────────────────
function PrepView({ orders }) {
  // Aggregate quantities for pending + cooking orders only
  const aggregated = useMemo(() => {
    const map = {};
    orders
      .filter(o => o.status === 'pending' || o.status === 'cooking')
      .forEach(order => {
        order.items.forEach(item => {
          const name = item.menu_item_name || `Item #${item.menu_item_id}`;
          map[name] = (map[name] || 0) + item.quantity;
        });
      });
    return Object.entries(map).sort((a, b) => b[1] - a[1]);
  }, [orders]);

  if (aggregated.length === 0) {
    return (
      <div className="prep-view-panel">
        <p className="prep-view-empty">No active items to prep right now.</p>
      </div>
    );
  }

  return (
    <div className="prep-view-panel">
      <p className="prep-view-subtitle">Aggregate across all pending & cooking orders</p>
      <div className="prep-chips-grid">
        {aggregated.map(([name, qty]) => (
          <div key={name} className="prep-item-chip">
            <span className="prep-qty">{qty}×</span>
            <span className="prep-name">{name}</span>
          </div>
        ))}
      </div>
    </div>
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
  const [prepViewOpen, setPrepViewOpen] = useState(false);
  const [recipeItem, setRecipeItem] = useState(null); // { name, recipe_instructions }

  const params = new URLSearchParams(window.location.search);
  const RESTAURANT_ID = Number(params.get('restaurant_id')) || 1;

  // Clock tick every 30s for urgency recalculation
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
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

  // Socket.io real-time
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

  // Stats
  const pendingCount = orders.filter(o => o.status === 'pending').length;
  const cookingCount = orders.filter(o => o.status === 'cooking').length;
  const readyCount = orders.filter(o => o.status === 'ready').length;

  const avgPrepTime = useMemo(() => {
    const active = orders.filter(o => o.status === 'cooking' || o.status === 'pending');
    if (!active.length) return null;
    const total = active.reduce((s, o) => s + getAgeMinutes(o.created_at, now), 0);
    return Math.round(total / active.length);
  }, [orders, now]);

  const cardVariants = {
    initial: { opacity: 0, scale: 0.92, y: 20 },
    animate: { opacity: 1, scale: 1, y: 0, transition: { type: 'spring', stiffness: 280, damping: 24 } },
    exit: { opacity: 0, x: 80, scale: 0.95, transition: { duration: 0.3 } }
  };

  return (
    <div className="kitchen-container">
      {/* ── Recipe Modal ── */}
      <RecipeModal item={recipeItem} onClose={() => setRecipeItem(null)} />

      {/* ── Header ── */}
      <header className="kitchen-header">
        <div className="kitchen-title-area">
          <h1>Kitchen</h1>
          <span className="live-indicator">Live</span>
        </div>

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
          {avgPrepTime !== null && (
            <div className="stat-chip prep-time">
              <span className="label">Avg Wait</span>
              <span className="value">{formatAge(avgPrepTime)}</span>
            </div>
          )}
        </div>

        <div className="kitchen-header-actions">
          <button
            className={`prep-view-toggle ${prepViewOpen ? 'active' : ''}`}
            onClick={() => setPrepViewOpen(p => !p)}
          >
            <span>⚡</span>
            <span>Prep View</span>
          </button>
          <div className="sound-controls">
            <button
              className={`sound-toggle-btn ${!soundEnabled ? 'muted' : ''}`}
              onClick={toggleSound}
              title={soundEnabled ? 'Mute' : 'Unmute'}
            >
              {soundEnabled ? '🔊' : '🔇'}
            </button>
            {soundEnabled && (
              <input
                type="range" min="0" max="1" step="0.1"
                value={volume} onChange={handleVolumeChange}
                className="volume-slider" title="Adjust Volume"
              />
            )}
          </div>
        </div>
      </header>

      {/* ── Prep Aggregation Panel ── */}
      <AnimatePresence>
        {prepViewOpen && (
          <motion.div
            key="prep-panel"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto', transition: { duration: 0.3 } }}
            exit={{ opacity: 0, height: 0, transition: { duration: 0.2 } }}
            style={{ overflow: 'hidden' }}
          >
            <PrepView orders={orders} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Order Cards ── */}
      <div className="orders-masonry">
        <AnimatePresence>
          {orders.map(order => {
            const isNew = newOrderIds.includes(order.id);
            const displayNum = String(order.order_number).padStart(3, '0');
            const ageMinutes = getAgeMinutes(order.created_at, now);
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
                {/* Glowing top edge */}
                <div className={`card-edge edge-${statusClass}`} />

                {/* Card Header */}
                <div className="order-card-header">
                  <div className="order-id-area">
                    <span className="order-number">#{displayNum}</span>
                    <span className="order-age">{formatAge(ageMinutes)} ago</span>
                  </div>
                  <div className={`status-led-group status-${statusClass}`}>
                    <span className={`status-led ${urgencyClass ? 'led-urgent' : ''}`} />
                    <span className="status-label">{order.status}</span>
                  </div>
                </div>

                {/* Items List */}
                <ul className="order-items-list">
                  {order.items.map(item => (
                    <li key={item.id}>
                      <div className="order-item-line">
                        <span className="item-qty">{item.quantity}×</span>
                        <div className="order-item-info">
                          <button
                            className="item-name item-name-btn"
                            onClick={() => setRecipeItem({
                              name: item.menu_item_name || `Item #${item.menu_item_id}`,
                              recipe_instructions: item.recipe_instructions
                            })}
                            title="View preparation instructions"
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
          })}
        </AnimatePresence>

        {orders.length === 0 && (
          <div className="no-orders">
            <span style={{ fontSize: '48px', display: 'block', marginBottom: '16px' }}>👨‍🍳</span>
            <p style={{ fontSize: '18px', fontWeight: 600, marginBottom: '8px' }}>All caught up!</p>
            <p>No active orders right now. Kitchen is clear.</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default Kitchen;
