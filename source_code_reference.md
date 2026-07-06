# ServeMe Source Code Reference

This document compiles the complete source code for the backend and frontend components of the **ServeMe** SaaS monorepo.

---

## ⚙️ Backend (FastAPI + SQLAlchemy)

### 1. `backend/database.py`
Defines the connection string and db session generator. Includes automatic fallback to SQLite if local MySQL is unavailable.
```python
# backend/database.py
import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

# Update 'root' and 'password' to match your local MySQL credentials
MYSQL_URL = "mysql+pymysql://root:password@localhost:3306/serveme_db"
SQLALCHEMY_DATABASE_URL = os.getenv("DATABASE_URL", MYSQL_URL)

try:
    if SQLALCHEMY_DATABASE_URL.startswith("sqlite"):
        engine = create_engine(SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False})
    else:
        engine = create_engine(SQLALCHEMY_DATABASE_URL)
        # Test connection quickly
        with engine.connect() as conn:
            pass
except Exception as e:
    print(f"Warning: Failed to connect to MySQL ({SQLALCHEMY_DATABASE_URL}): {e}")
    print("Falling back to SQLite (sqlite:///./serveme.db) for local development.")
    SQLALCHEMY_DATABASE_URL = "sqlite:///./serveme.db"
    engine = create_engine(SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False})

# Create a session local class for database interactions
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# Dependency function to get the database session in our API routes
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
```

### 2. `backend/models.py`
Declares SQLAlchemy ORM tables, status enums, and relationships for Restaurants, Categories, Menu Items, Orders, and Order Items.
```python
# backend/models.py
from datetime import datetime
import enum

from sqlalchemy import Column, Integer, String, Float, Boolean, ForeignKey, DateTime, Enum
from sqlalchemy.orm import relationship, declarative_base

Base = declarative_base()

class Restaurant(Base):
    __tablename__ = "restaurants"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)

    # Relationships
    categories = relationship("Category", back_populates="restaurant", cascade="all, delete-orphan")


class Category(Base):
    __tablename__ = "categories"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    restaurant_id = Column(Integer, ForeignKey("restaurants.id", ondelete="CASCADE"), nullable=False)

    # Relationships
    restaurant = relationship("Restaurant", back_populates="categories")
    menu_items = relationship("MenuItem", back_populates="category", cascade="all, delete-orphan")


class MenuItem(Base):
    __tablename__ = "menu_items"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    description = Column(String(500), nullable=True)
    price = Column(Float, nullable=False)
    image_url = Column(String(500), nullable=True)
    is_available = Column(Boolean, default=True)
    category_id = Column(Integer, ForeignKey("categories.id", ondelete="CASCADE"), nullable=False)

    # Relationships
    category = relationship("Category", back_populates="menu_items")


class OrderStatus(str, enum.Enum):
    PENDING = "pending"
    COOKING = "cooking"
    READY = "ready"
    COMPLETED = "completed"


class Order(Base):
    __tablename__ = "orders"

    id = Column(Integer, primary_key=True, index=True)
    restaurant_id = Column(Integer, ForeignKey("restaurants.id", ondelete="CASCADE"), nullable=False)
    order_number = Column(Integer, nullable=False)
    total_amount = Column(Float, nullable=False)
    status = Column(
        Enum(OrderStatus, values_callable=lambda statuses: [status.value for status in statuses]),
        nullable=False,
        default=OrderStatus.PENDING,
    )
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)

    # Relationships
    restaurant = relationship("Restaurant")
    items = relationship("OrderItem", back_populates="order", cascade="all, delete-orphan")


class OrderItem(Base):
    __tablename__ = "order_items"

    id = Column(Integer, primary_key=True, index=True)
    order_id = Column(Integer, ForeignKey("orders.id", ondelete="CASCADE"), nullable=False)
    menu_item_id = Column(Integer, ForeignKey("menu_items.id", ondelete="CASCADE"), nullable=False)
    quantity = Column(Integer, nullable=False)
    price_at_time_of_order = Column(Float, nullable=False)

    # Relationships
    order = relationship("Order", back_populates="items")
    menu_item = relationship("MenuItem")
```

### 3. `backend/schemas.py`
Pydantic schemas used for request/response serialization, typing, and validation.
```python
# backend/schemas.py
from pydantic import BaseModel
from typing import List, Optional

# --- Menu Items ---
class MenuItemBase(BaseModel):
    name: str
    description: Optional[str] = None
    price: float
    image_url: Optional[str] = None

class MenuItemCreate(MenuItemBase):
    pass

class MenuItemResponse(MenuItemBase):
    id: int
    is_available: bool

    class Config:
        from_attributes = True

# --- Categories ---
class CategoryBase(BaseModel):
    name: str

class CategoryCreate(CategoryBase):
    pass

class CategoryResponse(CategoryBase):
    id: int
    menu_items: List[MenuItemResponse] = []

    class Config:
        from_attributes = True

# --- Restaurants ---
class RestaurantBase(BaseModel):
    name: str

class RestaurantCreate(RestaurantBase):
    pass

class RestaurantResponse(RestaurantBase):
    id: int
    categories: List[CategoryResponse] = []

    class Config:
        from_attributes = True


# --- Orders & Checkout ---
class OrderItemCreate(BaseModel):
    menu_item_id: int
    quantity: int

class OrderCreate(BaseModel):
    items: List[OrderItemCreate]

class OrderItemResponse(BaseModel):
    id: int
    menu_item_id: int
    quantity: int
    price_at_time_of_order: float

    class Config:
        from_attributes = True

class OrderResponse(BaseModel):
    id: int
    restaurant_id: int
    order_number: int
    total_amount: float
    status: str
    items: List[OrderItemResponse]

    class Config:
        from_attributes = True


class OrderStatusUpdate(BaseModel):
    status: str
```

### 4. `backend/main.py`
Entry point of the FastAPI application. Sets up CORS, WebSockets for the kitchen dashboard, and defines the core REST routes.
```python
# backend/main.py
import io
from typing import Dict, List

from fastapi import FastAPI, Depends, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from sqlalchemy import func, inspect, text
from sqlalchemy.orm import Session
import qrcode
from database import engine, get_db
import models
import schemas

# Create tables
models.Base.metadata.create_all(bind=engine)


def ensure_order_kitchen_columns():
    inspector = inspect(engine)
    if not inspector.has_table("orders"):
        return

    existing_columns = {column["name"] for column in inspector.get_columns("orders")}
    dialect = engine.dialect.name

    with engine.begin() as conn:
        if "status" not in existing_columns:
            if dialect == "mysql":
                conn.execute(text("ALTER TABLE orders ADD COLUMN status VARCHAR(9) NOT NULL DEFAULT 'pending'"))
            else:
                conn.execute(text("ALTER TABLE orders ADD COLUMN status VARCHAR(9) NOT NULL DEFAULT 'pending'"))

        if "created_at" not in existing_columns:
            if dialect == "mysql":
                conn.execute(text("ALTER TABLE orders ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP"))
            else:
                conn.execute(text("ALTER TABLE orders ADD COLUMN created_at DATETIME DEFAULT CURRENT_TIMESTAMP"))


ensure_order_kitchen_columns()

app = FastAPI(title="ServeMe API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- WebSocket Connection Manager ---
class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[int, List[WebSocket]] = {}

    async def connect(self, websocket: WebSocket, restaurant_id: int):
        await websocket.accept()
        self.active_connections.setdefault(restaurant_id, []).append(websocket)

    def disconnect(self, websocket: WebSocket, restaurant_id: int):
        connections = self.active_connections.get(restaurant_id, [])
        if websocket in connections:
            connections.remove(websocket)
        if not connections and restaurant_id in self.active_connections:
            del self.active_connections[restaurant_id]

    async def broadcast(self, restaurant_id: int, message: str):
        connections = list(self.active_connections.get(restaurant_id, []))
        for connection in connections:
            try:
                await connection.send_text(message)
            except RuntimeError:
                self.disconnect(connection, restaurant_id)


manager = ConnectionManager()


# 1. Create a Restaurant
@app.post("/restaurants/", response_model=schemas.RestaurantResponse)
def create_restaurant(restaurant: schemas.RestaurantCreate, db: Session = Depends(get_db)):
    db_restaurant = models.Restaurant(name=restaurant.name)
    db.add(db_restaurant)
    db.commit()
    db.refresh(db_restaurant)
    return db_restaurant

# 2. Get a Restaurant and its Full Menu
@app.get("/restaurants/{restaurant_id}", response_model=schemas.RestaurantResponse)
def get_restaurant_menu(restaurant_id: int, db: Session = Depends(get_db)):
    db_restaurant = db.query(models.Restaurant).filter(models.Restaurant.id == restaurant_id).first()
    if db_restaurant is None:
        raise HTTPException(status_code=404, detail="Restaurant not found")
    return db_restaurant


# 3. Create a Category for a Restaurant
@app.post("/restaurants/{restaurant_id}/categories/", response_model=schemas.CategoryResponse)
def create_category(restaurant_id: int, category: schemas.CategoryCreate, db: Session = Depends(get_db)):
    # Verify restaurant exists
    db_restaurant = db.query(models.Restaurant).filter(models.Restaurant.id == restaurant_id).first()
    if not db_restaurant:
        raise HTTPException(status_code=404, detail="Restaurant not found")
        
    db_category = models.Category(**category.dict(), restaurant_id=restaurant_id)
    db.add(db_category)
    db.commit()
    db.refresh(db_category)
    return db_category


# 4. Add a Menu Item to a Category
@app.post("/categories/{category_id}/items/", response_model=schemas.MenuItemResponse)
def create_menu_item(category_id: int, item: schemas.MenuItemCreate, db: Session = Depends(get_db)):
    # Verify category exists
    db_category = db.query(models.Category).filter(models.Category.id == category_id).first()
    if not db_category:
        raise HTTPException(status_code=404, detail="Category not found")
        
    db_item = models.MenuItem(**item.dict(), category_id=category_id)
    db.add(db_item)
    db.commit()
    db.refresh(db_item)
    return db_item


# 5. Place an Order (Checkout)
@app.post("/restaurants/{restaurant_id}/orders/", response_model=schemas.OrderResponse)
async def place_order(restaurant_id: int, order_req: schemas.OrderCreate, db: Session = Depends(get_db)):
    # 1. Verify the restaurant exists
    db_restaurant = db.query(models.Restaurant).filter(models.Restaurant.id == restaurant_id).first()
    if not db_restaurant:
        raise HTTPException(status_code=404, detail="Restaurant not found")

    # 2. Generate the unique Order Number for this restaurant
    max_order = db.query(func.max(models.Order.order_number)).filter(models.Order.restaurant_id == restaurant_id).scalar()
    next_order_number = (max_order or 0) + 1

    # 3. Calculate Total Amount securely & lock in the prices
    total_amount = 0.0
    order_items = []

    for item_req in order_req.items:
        menu_item = db.query(models.MenuItem).filter(models.MenuItem.id == item_req.menu_item_id).first()
        
        if not menu_item or not menu_item.is_available:
            raise HTTPException(status_code=400, detail=f"Item ID {item_req.menu_item_id} is unavailable")

        item_total = menu_item.price * item_req.quantity
        total_amount += item_total

        order_items.append(
            models.OrderItem(
                menu_item_id=menu_item.id,
                quantity=item_req.quantity,
                price_at_time_of_order=menu_item.price
            )
        )

    # 4. Create the main Order row
    db_order = models.Order(
        restaurant_id=restaurant_id,
        order_number=next_order_number,
        total_amount=total_amount
    )
    db.add(db_order)
    db.flush()

    # 5. Attach all the individual items to this Order
    for o_item in order_items:
        o_item.order_id = db_order.id
        db.add(o_item)

    # 6. Save everything
    db.commit()
    db.refresh(db_order)

    await manager.broadcast(restaurant_id, "UPDATE_ORDERS")
    
    return db_order


# 6. KITCHEN: Get all active orders (Hide completed ones)
@app.get("/restaurants/{restaurant_id}/orders/", response_model=List[schemas.OrderResponse])
def get_active_orders(restaurant_id: int, db: Session = Depends(get_db)):
    db_restaurant = db.query(models.Restaurant).filter(models.Restaurant.id == restaurant_id).first()
    if not db_restaurant:
        raise HTTPException(status_code=404, detail="Restaurant not found")

    orders = db.query(models.Order).filter(
        models.Order.restaurant_id == restaurant_id,
        models.Order.status != models.OrderStatus.COMPLETED
    ).order_by(models.Order.created_at.asc()).all()
    return orders


# 7. KITCHEN: Update Order Status
@app.patch("/orders/{order_id}/status", response_model=schemas.OrderResponse)
async def update_order_status(order_id: int, status_update: schemas.OrderStatusUpdate, db: Session = Depends(get_db)):
    valid_statuses = {status.value for status in models.OrderStatus}
    if status_update.status not in valid_statuses:
        raise HTTPException(status_code=400, detail="Invalid order status")

    db_order = db.query(models.Order).filter(models.Order.id == order_id).first()
    if not db_order:
        raise HTTPException(status_code=404, detail="Order not found")

    db_order.status = status_update.status
    db.commit()
    db.refresh(db_order)

    await manager.broadcast(db_order.restaurant_id, "UPDATE_ORDERS")
    return db_order


# 8. ADMIN: Generate a printable QR Code for the restaurant
@app.get("/restaurants/{restaurant_id}/qrcode")
def generate_restaurant_qrcode(restaurant_id: int, db: Session = Depends(get_db)):
    db_restaurant = db.query(models.Restaurant).filter(models.Restaurant.id == restaurant_id).first()
    if not db_restaurant:
        raise HTTPException(status_code=404, detail="Restaurant not found")

    qr_url = f"http://localhost:5173/?restaurant_id={restaurant_id}"

    qr = qrcode.QRCode(
        version=1,
        error_correction=qrcode.constants.ERROR_CORRECT_L,
        box_size=10,
        border=4,
    )
    qr.add_data(qr_url)
    qr.make(fit=True)

    img = qr.make_image(fill_color="black", back_color="white")

    img_buffer = io.BytesIO()
    img.save(img_buffer, "PNG")
    img_buffer.seek(0)

    return StreamingResponse(
        img_buffer,
        media_type="image/png",
        headers={"Content-Disposition": f"attachment; filename=restaurant_{restaurant_id}_qr.png"},
    )


# 9. KITCHEN WEBSOCKET: Real-time connection
@app.websocket("/ws/kitchen/{restaurant_id}")
async def websocket_kitchen(websocket: WebSocket, restaurant_id: int):
    await manager.connect(websocket, restaurant_id)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket, restaurant_id)
```

---

## 🎨 Frontend (React + Vite + Vanilla CSS)

### 1. `frontend/src/main.jsx`
Mounts the React application. Provides simple routing between the customer menu (`App`) and the kitchen dashboard (`Kitchen`).
```javascript
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import Kitchen from './Kitchen.jsx'

// Simple client-side routing check
const isKitchen = window.location.pathname === '/kitchen' || new URLSearchParams(window.location.search).get('view') === 'kitchen';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {isKitchen ? <Kitchen /> : <App />}
  </StrictMode>,
)
```

### 2. `frontend/src/App.jsx`
Customer-facing QR menu. Loads menu items, handles the cart logic, and interacts with the Place Order API.
```javascript
import { useState, useEffect } from 'react';
import './App.css';

const API_URL = `http://${window.location.hostname}:8000`;

function App() {
  const [restaurant, setRestaurant] = useState(null);
  const [error, setError] = useState('');
  const [cart, setCart] = useState({});
  const [orderNumber, setOrderNumber] = useState(null);

  const params = new URLSearchParams(window.location.search);
  const RESTAURANT_ID = Number(params.get('restaurant_id')) || 1;

  useEffect(() => {
    // Fetch the menu data when the app loads
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

  const addToCart = (item) => {
    setCart((prev) => ({
      ...prev,
      [item.id]: {
        ...item,
        quantity: (prev[item.id]?.quantity || 0) + 1,
      },
    }));
  };

  const handleCheckout = async () => {
    // Format cart data for the backend schema
    const orderItems = Object.values(cart).map((item) => ({
      menu_item_id: item.id,
      quantity: item.quantity,
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
          <a key={cat.id} href={`#category-${cat.id}`} className="category-pill">
            {cat.name}
          </a>
        ))}
      </div>

      {/* Menu Items List */}
      <main className="menu-list">
        {restaurant.categories.map((category) => (
          <div key={category.id} id={`category-${category.id}`} className="category-section">
            <h2 className="category-title">{category.name}</h2>
            {category.menu_items.map((item) => (
              <div key={item.id} className="menu-item">
                <div className="item-info">
                  <h3 className="item-name">{item.name}</h3>
                  <p className="item-desc">{item.description}</p>
                  <p className="item-price">₹{item.price}</p>
                </div>
                <button className="add-btn" onClick={() => addToCart(item)}>
                  Add
                </button>
              </div>
            ))}
          </div>
        ))}
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
```

### 3. `frontend/src/Kitchen.jsx`
Real-time Kitchen Display System (KDS). Fetches active orders, updates cooking status, and updates live via WebSocket events.
```javascript
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
```

### 4. `frontend/src/App.css`
Minimalist, high-contrast monochrome design stylesheet covering all components and layouts.
```css
/* Base Styles */
* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}

body {
  background-color: #ffffff;
  color: #000000;
  -webkit-font-smoothing: antialiased;
}

.app-container {
  padding-bottom: 100px; /* Space for the sticky footer */
}

/* Header */
.header {
  padding: 24px 20px 16px;
  border-bottom: 2px solid #000000;
}

.header h1 {
  font-size: 28px;
  font-weight: 800;
  letter-spacing: -0.5px;
}

/* Categories Nav (Horizontal Scroll) */
.categories-nav {
  display: flex;
  overflow-x: auto;
  padding: 16px 20px;
  gap: 12px;
  border-bottom: 1px solid #e0e0e0;
  position: sticky;
  top: 0;
  background: #ffffff;
  z-index: 10;
}

.categories-nav::-webkit-scrollbar {
  display: none;
}

.category-pill {
  padding: 8px 16px;
  background-color: #f5f5f5;
  color: #000000;
  text-decoration: none;
  font-weight: 600;
  font-size: 14px;
  border-radius: 30px;
  white-space: nowrap;
}

/* Menu Items */
.menu-list {
  padding: 0 20px;
}

.category-section {
  padding-top: 24px;
}

.category-title {
  font-size: 22px;
  font-weight: 800;
  margin-bottom: 16px;
  text-transform: uppercase;
  letter-spacing: 1px;
}

.menu-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20px 0;
  border-bottom: 1px solid #e0e0e0;
}

.item-info {
  flex: 1;
  padding-right: 16px;
}

.item-name {
  font-size: 18px;
  font-weight: 700;
  margin-bottom: 4px;
}

.item-desc {
  font-size: 14px;
  color: #666666;
  line-height: 1.4;
  margin-bottom: 8px;
}

.item-price {
  font-size: 16px;
  font-weight: 600;
}

.add-btn {
  background-color: #ffffff;
  color: #000000;
  border: 2px solid #000000;
  padding: 8px 24px;
  font-weight: 700;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.add-btn:active {
  background-color: #000000;
  color: #ffffff;
}

/* Sticky Footer */
.sticky-footer {
  position: fixed;
  bottom: 0;
  left: 0;
  width: 100%;
  background-color: #000000;
  color: #ffffff;
  padding: 16px 20px 24px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.cart-summary {
  display: flex;
  flex-direction: column;
}

.cart-summary span:first-child {
  font-size: 14px;
  color: #a0a0a0;
}

.cart-summary span:last-child {
  font-size: 20px;
  font-weight: 800;
}

.checkout-btn {
  background-color: #ffffff;
  color: #000000;
  border: none;
  padding: 14px 32px;
  font-size: 16px;
  font-weight: 800;
  cursor: pointer;
}

/* Success Screen */
.success-screen {
  height: 100vh;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  text-align: center;
  padding: 20px;
  background-color: #000000;
  color: #ffffff;
}

.success-screen h2 {
  font-size: 24px;
  font-weight: 400;
  margin-bottom: 10px;
}

.giant-number {
  font-size: 96px;
  font-weight: 900;
  margin-bottom: 30px;
}

.success-screen p {
  font-size: 18px;
  color: #cccccc;
  margin-bottom: 8px;
}

/* Kitchen Dashboard Styles */
.kitchen-container {
  padding: 24px;
  background-color: #f5f5f5;
  min-height: 100vh;
  color: #000;
}

.kitchen-header {
  margin-bottom: 24px;
  border-bottom: 3px solid #000;
  padding-bottom: 12px;
}

.kitchen-header h1 {
  font-weight: 900;
  font-size: 32px;
  letter-spacing: -1px;
}

.orders-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 20px;
}

.order-card {
  background-color: #fff;
  border: 2px solid #000;
  padding: 20px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  box-shadow: 4px 4px 0px 0px #000;
}

.order-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid #ccc;
  padding-bottom: 10px;
  margin-bottom: 15px;
}

.order-card-header h2 {
  font-size: 28px;
  font-weight: 900;
}

.status-badge {
  text-transform: uppercase;
  font-size: 12px;
  font-weight: 800;
  border: 1px solid #000;
  padding: 2px 6px;
}

.order-items-list {
  list-style: none;
  margin-bottom: 20px;
  font-size: 16px;
}

.order-items-list li {
  margin-bottom: 8px;
}

.order-actions button {
  width: 100%;
  padding: 12px;
  border: 2px solid #000;
  font-weight: 800;
  cursor: pointer;
  text-transform: uppercase;
  transition: all 0.15s ease;
}

.btn-cooking {
  background-color: #fff;
  color: #000;
}
.btn-cooking:hover {
  background-color: #000;
  color: #fff;
}

.btn-ready {
  background-color: #000;
  color: #fff;
}
.btn-ready:hover {
  background-color: #fff;
  color: #000;
}

.btn-complete {
  background-color: #000;
  color: #fff;
  border-style: dashed !important;
}

.no-orders {
  font-size: 20px;
  font-weight: 700;
  color: #666;
  grid-column: 1 / -1;
  text-align: center;
  margin-top: 40px;
}
```
