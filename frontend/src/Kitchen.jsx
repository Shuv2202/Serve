import { useCallback, useState, useEffect } from 'react';
import './App.css';

const API_URL = `http://${window.location.hostname}:8000`;

function Kitchen() {
  const [orders, setOrders] = useState([]);
  const params = new URLSearchParams(window.location.search);
  const RESTAURANT_ID = Number(params.get('restaurant_id')) || 1;

  const fetchOrders = useCallback(() => {
    fetch(`${API_URL}/restaurants/${RESTAURANT_ID}/orders/`)
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load orders');
        return res.json();
      })
      .then((data) => setOrders(data))
      .catch((err) => console.error(err));
  }, [RESTAURANT_ID]);

  useEffect(() => {
    fetchOrders();

    const ws = new WebSocket(`ws://${window.location.hostname}:8000/ws/kitchen/${RESTAURANT_ID}`);

    ws.onmessage = (event) => {
      if (event.data === 'UPDATE_ORDERS') {
        console.log('Real-time order signal received. Refreshing dashboard.');
        fetchOrders();
      }
    };

    ws.onerror = (error) => {
      console.error('Kitchen WebSocket error', error);
    };

    return () => ws.close();
  }, [RESTAURANT_ID, fetchOrders]);

  const updateStatus = async (orderId, newStatus) => {
    const response = await fetch(`${API_URL}/orders/${orderId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    });

    if (!response.ok) {
      console.error('Failed to update order status');
      return;
    }

    setOrders((currentOrders) =>
      currentOrders
        .map((order) => (order.id === orderId ? { ...order, status: newStatus } : order))
        .filter((order) => order.status !== 'completed'),
    );
  };

  return (
    <div className="kitchen-container">
      <header className="kitchen-header">
        <h1>Kitchen Display System</h1>
      </header>

      <div className="orders-grid">
        {orders.map((order) => (
          <div key={order.id} className={`order-card status-${order.status.toLowerCase()}`}>
            <div className="order-card-header">
              <h2>#{order.order_number}</h2>
              <span className="status-badge">{order.status}</span>
            </div>

            <ul className="order-items-list">
              {order.items.map((item) => (
                <li key={item.id}>
                  <strong>{item.quantity}x</strong> Item ID: {item.menu_item_id}
                </li>
              ))}
            </ul>

            <div className="order-actions">
              {order.status === 'pending' && (
                <button onClick={() => updateStatus(order.id, 'cooking')} className="btn-cooking">
                  Start Cooking
                </button>
              )}
              {order.status === 'cooking' && (
                <button onClick={() => updateStatus(order.id, 'ready')} className="btn-ready">
                  Mark Ready
                </button>
              )}
              {order.status === 'ready' && (
                <button onClick={() => updateStatus(order.id, 'completed')} className="btn-complete">
                  Handed to Customer
                </button>
              )}
            </div>
          </div>
        ))}

        {orders.length === 0 && <p className="no-orders">No active orders. Kitchen is clear!</p>}
      </div>
    </div>
  );
}

export default Kitchen;
