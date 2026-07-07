import { useState, useEffect, useCallback } from 'react';
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

  const params = new URLSearchParams(window.location.search);
  const RESTAURANT_ID = Number(params.get('restaurant_id')) || 1;

  const fetchMenu = useCallback(() => {
    fetch(`${API_URL}/restaurants/${RESTAURANT_ID}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Restaurant ${RESTAURANT_ID} was not found`);
        return res.json();
      })
      .then((data) => {
        setError('');
        setRestaurant(data);
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

  const addToCart = (item) => {
    setCart((prev) => ({
      ...prev,
      [item.id]: {
        ...item,
        quantity: (prev[item.id]?.quantity || 0) + 1,
      },
    }));
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

  const handleCheckout = async () => {
    // Format cart data for the backend schema
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
      const data = await response.json();
      setOrderNumber(data.order_number);
    } catch (error) {
      console.error("Checkout failed", error);
    }
  };

  // Calculate Cart Totals
  const totalItems = Object.values(cart).reduce((sum, item) => sum + item.quantity, 0);
  const totalPrice = Object.values(cart).reduce((sum, item) => sum + (item.price * item.quantity), 0);

  // If order is placed, show the success screen
  if (orderNumber) {
    return (
      <div className="success-screen">
        <h2>Your Order Is</h2>
        <h1 className="giant-number">#{orderNumber}</h1>
        <p>Listen for your number at the counter.</p>
        <p>You can pay when you pick up your food.</p>
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
        <h1>{restaurant.name}</h1>
      </header>

      {/* Horizontal Categories Menu */}
      <div className="categories-nav">
        {restaurant.categories.map((cat) => (
          <a
            key={cat.id}
            href={`#category-${cat.id}`}
            className={`category-pill ${activeCategory === cat.id ? 'active' : ''}`}
            onClick={() => setActiveCategory(cat.id)}
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
          placeholder="Search within menu"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      {/* Menu Items List */}
      <main className="menu-list">
        {restaurant.categories.map((category) => {
          const filteredItems = category.menu_items.filter((item) =>
            item.name.toLowerCase().includes(searchQuery.toLowerCase())
          );

          if (filteredItems.length === 0) return null;

          return (
            <div key={category.id} id={`category-${category.id}`} className="category-section">
              <h2 className="category-title">{category.name}</h2>
              <div className="menu-items-grid">
                {filteredItems.map((item) => (
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
                      {cart[item.id] && (
                        <input
                          type="text"
                          className="cart-item-notes-input"
                          placeholder="Instructions (e.g., Less spicy, no onion)"
                          value={cart[item.id].notes || ''}
                          onChange={(e) => updateCartItemNotes(item.id, e.target.value)}
                        />
                      )}
                      <a href="#" className="more-link" onClick={(e) => e.preventDefault()}>More</a>
                    </div>
                    <div className="item-action-area">
                      {cart[item.id] ? (
                        <div className="quantity-control">
                          <button className="qty-btn" onClick={() => removeFromCart(item.id)}>-</button>
                          <span className="qty-text">{cart[item.id].quantity}</span>
                          <button className="qty-btn" onClick={() => addToCart(item)}>+</button>
                        </div>
                      ) : (
                        <button className="add-btn" onClick={() => addToCart(item)}>
                          Add
                        </button>
                      )}
                      {item.tags && (
                        <div className="item-tags">
                          {item.tags.split(',').map(tag => (
                            <span key={tag} className={`tag tag-${tag.trim().toLowerCase().replace(/\s+/g, '-')}`}>
                              {tag.trim()}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </main>

      {/* Sticky Cart Footer */}
      {totalItems > 0 && (
        <div className="sticky-footer">
          <div className="cart-summary">
            <span>{totalItems} Items</span>
            <span>₹{totalPrice}</span>
          </div>
          <button className="checkout-btn" onClick={handleCheckout}>
            Place Order
          </button>
        </div>
      )}
    </div>
  );
}

export default App;
