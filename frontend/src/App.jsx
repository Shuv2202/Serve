import { useState, useEffect, useCallback, useMemo } from 'react';
import './App.css';
import { API_URL, IS_MISSING_CONFIG } from './config';
import { io } from 'socket.io-client';

function App() {
  if (IS_MISSING_CONFIG) {
    return (
      <div className="loading" style={{ padding: '40px', textAlign: 'center' }}>
        <h2>Backend Connection Required</h2>
        <p style={{ margin: '15px 0' }}>The application is deployed, but the backend API URL has not been configured.</p>
        <p style={{ fontSize: '14px', color: '#888' }}>
          Please add the <code>VITE_API_URL</code> environment variable in your site configuration settings pointing to your backend URL (e.g. <code>https://your-backend-url.com</code>).
        </p>
      </div>
    );
  }

  const [restaurant, setRestaurant] = useState(null);
  const [error, setError] = useState('');
  const [cart, setCart] = useState({});
  const [orderNumber, setOrderNumber] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState(1);
  const [isCheckingOut, setIsCheckingOut] = useState(false);
  const [isCartOpen, setIsCartOpen] = useState(false);

  const params = new URLSearchParams(window.location.search);
  const RESTAURANT_ID = Number(params.get('restaurant_id')) || 1;

  // Filter categories to only those containing items matching the search query
  const filteredCategories = useMemo(() => {
    if (!restaurant) return [];
    return restaurant.categories.map((category) => ({
      ...category,
      menu_items: category.menu_items.filter((item) =>
        item.name.toLowerCase().includes(searchQuery.toLowerCase())
      )
    })).filter((category) => category.menu_items.length > 0);
  }, [restaurant, searchQuery]);

  const fetchMenu = useCallback(() => {
    fetch(`${API_URL}/restaurants/${RESTAURANT_ID}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Restaurant ${RESTAURANT_ID} was not found`);
        return res.json();
      })
      .then((data) => {
        setError('');
        setRestaurant(data);
        if (data.categories && data.categories.length > 0) {
          setActiveCategory(data.categories[0].id);
        }
      })
      .catch((err) => {
        console.error("Failed to load menu", err);
        setRestaurant(null);
        setError(err.message);
      });
  }, [RESTAURANT_ID]);

  useEffect(() => {
    fetchMenu();
  }, [fetchMenu]);

  useEffect(() => {
    const socket = io(API_URL, {
      path: '/socket.io'
    });

    socket.on('connect', () => {
      console.log('Connected to Socket.io backend');
      socket.emit('join_restaurant', { restaurant_id: RESTAURANT_ID });
    });

    socket.on('menu_update', (data) => {
      if (data === 'UPDATE_MENU') {
        console.log('Real-time menu update received. Refreshing menu.');
        fetchMenu();
      }
    });

    return () => {
      socket.disconnect();
    };
  }, [RESTAURANT_ID, fetchMenu]);

  // Keep active category pill in view inside scrollable nav bar
  useEffect(() => {
    const activePill = document.querySelector('.category-pill.active');
    if (activePill) {
      activePill.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'center'
      });
    }
  }, [activeCategory]);

  // Adjust activeCategory if the current active category is filtered out by search
  useEffect(() => {
    if (filteredCategories.length > 0) {
      const isActiveVisible = filteredCategories.some(cat => cat.id === activeCategory);
      if (!isActiveVisible) {
        setActiveCategory(filteredCategories[0].id);
      }
    }
  }, [filteredCategories, activeCategory]);

  const handleCategoryClick = (e, catId) => {
    e.preventDefault();
    setActiveCategory(catId);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const addToCart = (item) => {
    setCart((prev) => {
      const currentQty = prev[item.id]?.quantity || 0;
      if (item.stock !== undefined && item.stock !== null && currentQty >= item.stock) {
        alert(`Sorry, only ${item.stock} quantity available in stock for "${item.name}".`);
        return prev;
      }
      return {
        ...prev,
        [item.id]: {
          ...item,
          quantity: currentQty + 1,
        },
      };
    });
  };

  const removeFromCart = (itemId) => {
    setCart((prev) => {
      const newCart = { ...prev };
      if (newCart[itemId]) {
        if (newCart[itemId].quantity > 1) {
          newCart[itemId].quantity -= 1;
        } else {
          delete newCart[itemId];
        }
      }
      // Auto close cart drawer if empty
      const remainingItems = Object.values(newCart).reduce((sum, item) => sum + item.quantity, 0);
      if (remainingItems === 0) {
        setIsCartOpen(false);
      }
      return newCart;
    });
  };

  const updateCartItemNotes = (itemId, notes) => {
    setCart((prev) => {
      if (!prev[itemId]) return prev;
      return {
        ...prev,
        [itemId]: {
          ...prev[itemId],
          notes,
        },
      };
    });
  };

  const toggleQuickNote = (itemId, noteText) => {
    setCart((prev) => {
      if (!prev[itemId]) return prev;
      const currentNotes = prev[itemId].notes || '';
      let notesList = currentNotes ? currentNotes.split(',').map(n => n.trim()).filter(Boolean) : [];
      
      if (notesList.includes(noteText)) {
        notesList = notesList.filter(n => n !== noteText);
      } else {
        notesList.push(noteText);
      }
      
      return {
        ...prev,
        [itemId]: {
          ...prev[itemId],
          notes: notesList.join(', '),
        },
      };
    });
  };

  const handleCheckout = async () => {
    if (isCheckingOut) return;
    setIsCheckingOut(true);

    const orderItems = Object.values(cart).map((item) => ({
      menu_item_id: item.id,
      quantity: item.quantity,
      notes: item.notes || null,
    }));

    try {
      const response = await fetch(`${API_URL}/restaurants/${RESTAURANT_ID}/orders/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: orderItems }),
      });
      if (!response.ok) {
        throw new Error("Could not submit order. Please try again.");
      }
      const data = await response.json();
      setOrderNumber(data.order_number);
      setCart({});
      setIsCartOpen(false);
    } catch (error) {
      console.error("Checkout failed", error);
      alert(error.message || "Place order failed. Check server connection.");
    } finally {
      setIsCheckingOut(false);
    }
  };

  // Calculate Cart Totals
  const totalItems = Object.values(cart).reduce((sum, item) => sum + item.quantity, 0);
  const totalPrice = Object.values(cart).reduce((sum, item) => sum + (item.price * item.quantity), 0);

  // If order is placed, show the success screen
  if (orderNumber) {
    return (
      <div className="success-screen">
        <div className="success-card" style={{
          background: 'rgba(255, 255, 255, 0.05)',
          backdropFilter: 'blur(24px)',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          padding: '44px 32px',
          borderRadius: '28px',
          boxShadow: '0 30px 60px rgba(0,0,0,0.5)',
          maxWidth: '420px',
          width: '90%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center'
        }}>
          <div style={{ fontSize: '48px', marginBottom: '16px', animation: 'bounce 2s infinite' }}>🛎️</div>
          <h2>Order Received!</h2>
          <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: '11px', letterSpacing: '1.5px', textTransform: 'uppercase', marginTop: '12px', fontWeight: 600 }}>Your Token Number</div>
          <h1 className="giant-number" style={{ margin: '8px 0 24px 0' }}>#{orderNumber}</h1>
          <p style={{ margin: '0 0 16px 0', fontSize: '15px', color: 'rgba(255,255,255,0.9)', fontWeight: 500 }}>
            👨‍🍳 The kitchen is now preparing your delicious meal!
          </p>
          <div style={{ margin: '0 0 32px 0', display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <p style={{ margin: 0, fontSize: '13px', color: 'rgba(255,255,255,0.5)', lineHeight: 1.5 }}>
              Listen for your token number at the counter.
            </p>
            <p style={{ margin: 0, fontSize: '13px', color: 'rgba(255,255,255,0.5)', lineHeight: 1.5 }}>
              You can pay when picking up your food.
            </p>
          </div>
          <button
            className="checkout-btn"
            style={{ width: '100%', background: 'linear-gradient(135deg, #f97316, #ea580c)', boxShadow: '0 6px 20px rgba(249, 115, 22, 0.3)' }}
            onClick={() => { setOrderNumber(null); }}
          >
            Order More Dishes
          </button>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="loading">
        {error}. Try <strong>?restaurant_id=1</strong> or create this restaurant first.
      </div>
    );
  }

  if (!restaurant) return <div className="loading">Loading Menu...</div>;

  return (
    <div className="app-container">
      {/* Header */}
      <header className="header">
        <div>
          <h1>{restaurant.name}</h1>
          <p style={{ fontSize: '12px', color: '#999', marginTop: '2px', fontWeight: 500 }}>
            ✨ Table Service
          </p>
        </div>
      </header>

      {/* Horizontal Categories Menu */}
      <div className="categories-nav">
        {filteredCategories.map((cat) => (
          <a
            key={cat.id}
            href={`#category-${cat.id}`}
            className={`category-pill ${activeCategory === cat.id ? 'active' : ''}`}
            onClick={(e) => handleCategoryClick(e, cat.id)}
          >
            {cat.name}
          </a>
        ))}
      </div>

      {/* Search Bar */}
      <div className="search-container">
        <input
          type="text"
          className="search-input"
          placeholder="🔍  Search delicious dishes..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      {/* Menu Items List */}
      <main className="menu-list">
        {filteredCategories
          .filter((category) => category.id === activeCategory)
          .map((category) => (
            <div key={category.id} className="category-section">
              <h2 className="category-title">{category.name}</h2>
              <div className="menu-items-grid">
                {category.menu_items.map((item) => (
                  <div key={item.id} className="menu-item-card">
                    {item.image_url && (
                      <img src={item.image_url} alt={item.name} className="item-thumbnail" />
                    )}
                    <div className="item-details">
                      <div className="item-title-row">
                        {item.is_veg !== undefined && (
                          <span className={`veg-indicator ${item.is_veg ? 'veg' : 'non-veg'}`}>
                            <span className="dot"></span>
                          </span>
                        )}
                        <h3 className="item-name">{item.name}</h3>
                        {item.is_spicy && <span className="spicy-icon" title="Spicy">🌶️</span>}
                      </div>
                      <p className="item-price">₹{item.price}</p>
                      {item.description && <p className="item-desc">{item.description}</p>}
                      
                      {item.stock !== undefined && item.stock !== null && item.stock > 0 && item.stock <= 5 && (
                        <p className="low-stock-warning">⚠️ Only {item.stock} left!</p>
                      )}
                      {item.stock !== undefined && item.stock !== null && item.stock <= 0 && (
                        <p className="out-of-stock-warning">🚫 Out of stock</p>
                      )}

                      {cart[item.id] && (
                        <div className="instructions-area">
                          <div className="quick-notes-container">
                            {['🌶️ Spicy', '🚫 No Onion', '🚫 No Garlic', '🧀 More Cheese', '🧂 Less Salt'].map((option) => {
                              const isSelected = (cart[item.id].notes || '').includes(option);
                              return (
                                <button
                                  key={option}
                                  className={`quick-note-chip ${isSelected ? 'selected' : ''}`}
                                  onClick={() => toggleQuickNote(item.id, option)}
                                >
                                  {option}
                                </button>
                              );
                            })}
                          </div>
                          <input
                            type="text"
                            className="cart-item-notes-input"
                            placeholder="Or type other instructions..."
                            value={cart[item.id].notes || ''}
                            onChange={(e) => updateCartItemNotes(item.id, e.target.value)}
                          />
                        </div>
                      )}
                    </div>
                    
                    <div className="item-action-area">
                      {item.stock !== undefined && item.stock !== null && item.stock <= 0 ? (
                        <button className="add-btn out-of-stock" disabled>
                          Out of Stock
                        </button>
                      ) : cart[item.id] ? (
                        <div className="quantity-control">
                          <button className="qty-btn" onClick={() => removeFromCart(item.id)}>-</button>
                          <span className="qty-text">{cart[item.id].quantity}</span>
                          <button 
                            className="qty-btn" 
                            onClick={() => addToCart(item)}
                            disabled={item.stock !== undefined && item.stock !== null && cart[item.id].quantity >= item.stock}
                          >+</button>
                        </div>
                      ) : (
                        <button className="add-btn" onClick={() => addToCart(item)}>
                          Add
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
      </main>

      {/* Sticky Cart Footer with Collapsible Drawer */}
      {totalItems > 0 && (
        <>
          {isCartOpen && (
            <div className="cart-drawer-overlay" onClick={() => setIsCartOpen(false)} style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: 'rgba(0, 0, 0, 0.4)',
              backdropFilter: 'blur(4px)',
              zIndex: 90
            }}>
              <div className="cart-drawer" onClick={(e) => e.stopPropagation()} style={{
                position: 'fixed',
                bottom: '108px',
                left: '50%',
                transform: 'translateX(-50%)',
                width: 'calc(100% - 32px)',
                maxWidth: '560px',
                background: '#ffffff',
                borderRadius: '24px',
                padding: '24px',
                boxShadow: '0 -10px 30px rgba(0,0,0,0.1), 0 20px 40px rgba(0,0,0,0.2)',
                border: '1px solid rgba(0,0,0,0.05)',
                zIndex: 95,
                maxHeight: '60vh',
                overflowY: 'auto'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', borderBottom: '1px solid #f5f5f4', paddingBottom: '12px' }}>
                  <h3 style={{ fontSize: '18px', fontWeight: 800 }}>Review Your Order</h3>
                  <button onClick={() => setIsCartOpen(false)} style={{ background: 'none', border: 'none', fontSize: '24px', cursor: 'pointer', color: '#a8a29e', lineHeight: 1 }}>×</button>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {Object.values(cart).map((item) => (
                    <div key={item.id} style={{ display: 'flex', flexDirection: 'column', borderBottom: '1px solid #faf9f6', paddingBottom: '12px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div className="quantity-control" style={{ height: '30px' }}>
                            <button className="qty-btn" style={{ width: '28px' }} onClick={() => removeFromCart(item.id)}>-</button>
                            <span className="qty-text" style={{ fontSize: '12px' }}>{item.quantity}</span>
                            <button className="qty-btn" style={{ width: '28px' }} onClick={() => addToCart(item)} disabled={item.stock !== undefined && item.stock !== null && item.quantity >= item.stock}>+</button>
                          </div>
                          <span style={{ fontWeight: 600, fontSize: '14px' }}>{item.name}</span>
                        </div>
                        <span style={{ fontWeight: 700, fontSize: '14px' }}>₹{item.price * item.quantity}</span>
                      </div>
                      <div className="instructions-area">
                        <div className="quick-notes-container">
                          {['🌶️ Spicy', '🚫 No Onion', '🚫 No Garlic', '🧀 More Cheese', '🧂 Less Salt'].map((option) => {
                            const isSelected = (item.notes || '').includes(option);
                            return (
                              <button
                                key={option}
                                className={`quick-note-chip ${isSelected ? 'selected' : ''}`}
                                onClick={() => toggleQuickNote(item.id, option)}
                              >
                                {option}
                              </button>
                            );
                          })}
                        </div>
                        <input
                          type="text"
                          className="cart-item-notes-input"
                          placeholder="Or type other instructions..."
                          value={item.notes || ''}
                          onChange={(e) => updateCartItemNotes(item.id, e.target.value)}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="sticky-footer" onClick={() => setIsCartOpen(!isCartOpen)}>
            <div className="cart-summary">
              <span>{totalItems} Item{totalItems > 1 ? 's' : ''} • {isCartOpen ? 'Tap to Close' : 'Tap to Review'}</span>
              <span>₹{totalPrice}</span>
            </div>
            <button
              className="checkout-btn"
              onClick={(e) => {
                e.stopPropagation();
                handleCheckout();
              }}
              disabled={isCheckingOut}
            >
              {isCheckingOut ? 'Placing Order...' : 'Place Order'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default App;
