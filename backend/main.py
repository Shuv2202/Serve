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
    # This finds the current highest order number and adds 1. If it's the first order, it starts at 1.
    max_order = db.query(func.max(models.Order.order_number)).filter(models.Order.restaurant_id == restaurant_id).scalar()
    next_order_number = (max_order or 0) + 1

    # 3. Calculate Total Amount securely & lock in the prices
    total_amount = 0.0
    order_items = []

    for item_req in order_req.items:
        # Fetch the item from the database to get the CURRENT price securely
        menu_item = db.query(models.MenuItem).filter(models.MenuItem.id == item_req.menu_item_id).first()
        
        if not menu_item or not menu_item.is_available:
            raise HTTPException(status_code=400, detail=f"Item ID {item_req.menu_item_id} is unavailable")

        # Calculate math on the backend so customers can't hack the price
        item_total = menu_item.price * item_req.quantity
        total_amount += item_total

        # Prepare the item for the database, locking in the price
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
    db.flush() # This assigns an ID to db_order without finalizing the save yet

    # 5. Attach all the individual items to this Order
    for o_item in order_items:
        o_item.order_id = db_order.id
        db.add(o_item)

    # 6. Save everything to the MySQL database
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
