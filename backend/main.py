# backend/main.py
import io
import os
import uuid
from typing import Dict, List, Optional
from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI, Depends, HTTPException, WebSocket, WebSocketDisconnect, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from sqlalchemy import func, inspect, text
from sqlalchemy.orm import Session, joinedload
import qrcode
import socketio
import cloudinary
import cloudinary.uploader
from database import engine, get_db
import models
import schemas

# Configure Cloudinary
cloudinary.config(
    cloud_name=os.getenv("CLOUDINARY_CLOUD_NAME"),
    api_key=os.getenv("CLOUDINARY_API_KEY"),
    api_secret=os.getenv("CLOUDINARY_API_SECRET")
)

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


def ensure_menu_item_columns():
    inspector = inspect(engine)
    if not inspector.has_table("menu_items"):
        return

    existing_columns = {column["name"] for column in inspector.get_columns("menu_items")}
    dialect = engine.dialect.name

    with engine.begin() as conn:
        if "is_active" not in existing_columns:
            if dialect == "mysql":
                conn.execute(text("ALTER TABLE menu_items ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1"))
            else:
                conn.execute(text("ALTER TABLE menu_items ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT 1"))

        if "stock" not in existing_columns:
            if dialect == "mysql":
                conn.execute(text("ALTER TABLE menu_items ADD COLUMN stock INT NOT NULL DEFAULT 0"))
            else:
                conn.execute(text("ALTER TABLE menu_items ADD COLUMN stock INTEGER NOT NULL DEFAULT 0"))


ensure_order_kitchen_columns()
ensure_menu_item_columns()

def ensure_new_kitchen_columns():
    """Safely add recipe_instructions to menu_items and notes to order_items."""
    inspector = inspect(engine)
    dialect = engine.dialect.name

    with engine.begin() as conn:
        if inspector.has_table("menu_items"):
            existing = {c["name"] for c in inspector.get_columns("menu_items")}
            if "recipe_instructions" not in existing:
                conn.execute(text("ALTER TABLE menu_items ADD COLUMN recipe_instructions TEXT"))

        if inspector.has_table("order_items"):
            existing = {c["name"] for c in inspector.get_columns("order_items")}
            if "notes" not in existing:
                if dialect == "mysql":
                    conn.execute(text("ALTER TABLE order_items ADD COLUMN notes VARCHAR(500)"))
                else:
                    conn.execute(text("ALTER TABLE order_items ADD COLUMN notes VARCHAR(500)"))

ensure_new_kitchen_columns()

app = FastAPI(title="ServeMe API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

sio = socketio.AsyncServer(async_mode='asgi', cors_allowed_origins='*')

@sio.event
async def connect(sid, environ):
    print(f"Socket.io client connected: {sid}", flush=True)

@sio.event
async def disconnect(sid):
    print(f"Socket.io client disconnected: {sid}", flush=True)

@sio.on('join_restaurant')
async def join_restaurant(sid, data):
    restaurant_id = data.get("restaurant_id")
    if restaurant_id:
        await sio.enter_room(sid, f"restaurant_{restaurant_id}")
        print(f"Socket.io client {sid} joined room restaurant_{restaurant_id}", flush=True)






# 1. Create a Restaurant
@app.post("/restaurants/", response_model=schemas.RestaurantResponse)
def create_restaurant(restaurant: schemas.RestaurantCreate, db: Session = Depends(get_db)):
    db_restaurant = models.Restaurant(name=restaurant.name)
    db.add(db_restaurant)
    db.commit()
    db.refresh(db_restaurant)
    return db_restaurant

# 2. Get a Restaurant and its Full Menu (accepts admin query parameter to return all or only active items)
@app.get("/restaurants/{restaurant_id}", response_model=schemas.RestaurantResponse)
def get_restaurant_menu(restaurant_id: int, admin: bool = False, db: Session = Depends(get_db)):
    db_restaurant = db.query(models.Restaurant).filter(models.Restaurant.id == restaurant_id).first()
    if db_restaurant is None:
        raise HTTPException(status_code=404, detail="Restaurant not found")
        
    if admin:
        return db_restaurant

    # Filter out inactive/unapplied menu items for customer menu
    filtered_categories = []
    for category in db_restaurant.categories:
        active_items = [item for item in category.menu_items if item.is_active and item.is_available]
        filtered_categories.append({
            "id": category.id,
            "name": category.name,
            "menu_items": active_items
        })

    return {
        "id": db_restaurant.id,
        "name": db_restaurant.name,
        "categories": filtered_categories
    }


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
        
        if not menu_item or not menu_item.is_available or not menu_item.is_active:
            raise HTTPException(status_code=400, detail=f"Item ID {item_req.menu_item_id} is unavailable")

        # Calculate math on the backend so customers can't hack the price
        item_total = menu_item.price * item_req.quantity
        total_amount += item_total

        # Prepare the item for the database, locking in the price
        order_items.append(
            models.OrderItem(
                menu_item_id=menu_item.id,
                quantity=item_req.quantity,
                price_at_time_of_order=menu_item.price,
                notes=item_req.notes
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

    # 6. Save everything to the database
    db.commit()
    db.refresh(db_order)

    # Enrich response with product names, notes, and recipe instructions
    for item in db_order.items:
        item.menu_item_name = item.menu_item.name if item.menu_item else f"Item #{item.menu_item_id}"
        item.recipe_instructions = item.menu_item.recipe_instructions if item.menu_item else None

    await sio.emit("order_update", "UPDATE_ORDERS", room=f"restaurant_{restaurant_id}")
    
    return db_order


# 6. KITCHEN: Get all active orders (Hide completed ones)
@app.get("/restaurants/{restaurant_id}/orders/", response_model=List[schemas.OrderResponse])
def get_active_orders(restaurant_id: int, db: Session = Depends(get_db)):
    db_restaurant = db.query(models.Restaurant).filter(models.Restaurant.id == restaurant_id).first()
    if not db_restaurant:
        raise HTTPException(status_code=404, detail="Restaurant not found")

    orders = db.query(models.Order).options(
        joinedload(models.Order.items).joinedload(models.OrderItem.menu_item)
    ).filter(
        models.Order.restaurant_id == restaurant_id,
        models.Order.status != models.OrderStatus.COMPLETED
    ).order_by(models.Order.created_at.asc()).all()

    # Enrich each order item with the product name, notes, and recipe instructions
    for order in orders:
        for item in order.items:
            item.menu_item_name = item.menu_item.name if item.menu_item else f"Item #{item.menu_item_id}"
            item.recipe_instructions = item.menu_item.recipe_instructions if item.menu_item else None

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

    await sio.emit("order_update", "UPDATE_ORDERS", room=f"restaurant_{db_order.restaurant_id}")
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


# 9. ADMIN: Toggle Menu Item Visibility
@app.patch("/menu-items/{item_id}/visibility", response_model=schemas.MenuItemResponse)
async def update_item_visibility(item_id: int, visibility_update: schemas.MenuItemVisibilityUpdate, db: Session = Depends(get_db)):
    db_item = db.query(models.MenuItem).filter(models.MenuItem.id == item_id).first()
    if not db_item:
        raise HTTPException(status_code=404, detail="Menu item not found")
        
    db_item.is_active = visibility_update.is_active
    db.commit()
    db.refresh(db_item)
    
    # Broadcast to all clients in the restaurant room
    restaurant_id = db_item.category.restaurant_id
    await sio.emit("menu_update", "UPDATE_MENU", room=f"restaurant_{restaurant_id}")
    
    return db_item



# --- PRODUCT CATALOG INTEGRATION ENDPOINTS ---

@app.post("/api/upload")
async def upload_image(file: UploadFile = File(...)):
    result = cloudinary.uploader.upload(file.file)
    return {"url": result.get("secure_url")}


@app.get("/api/vendor/stats")
def get_vendor_stats(restaurant_id: int = 1, db: Session = Depends(get_db)):
    total_products = db.query(models.MenuItem).join(models.Category).filter(models.Category.restaurant_id == restaurant_id).count()
    total_orders = db.query(models.Order).filter(models.Order.restaurant_id == restaurant_id).count()
    total_payments = db.query(func.sum(models.Order.total_amount)).filter(models.Order.restaurant_id == restaurant_id).scalar() or 0.0
    total_customers = db.query(models.Order.id).filter(models.Order.restaurant_id == restaurant_id).distinct().count()
    return {
        "total_orders": total_orders,
        "total_payments": total_payments,
        "total_products": total_products,
        "total_customers": total_customers
    }


@app.get("/api/orders")
def get_orders(restaurant_id: int = 1, db: Session = Depends(get_db)):
    orders = db.query(models.Order).filter(models.Order.restaurant_id == restaurant_id).order_by(models.Order.id.desc()).all()
    result = []
    for order in orders:
        result.append({
            "id": f"ORD-{order.id:03d}",
            "date": order.created_at.strftime("%Y-%m-%d %H:%M") if order.created_at else "",
            "customer": "Walk-in Customer",
            "mobile": "N/A",
            "amount": order.total_amount
        })
    return result


@app.delete("/api/orders/{order_id}")
def delete_order(order_id: int, restaurant_id: int = 1, db: Session = Depends(get_db)):
    order = db.query(models.Order).filter(models.Order.id == order_id, models.Order.restaurant_id == restaurant_id).first()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    db.delete(order)
    db.commit()
    return {"message": "Order deleted successfully"}


@app.delete("/api/orders")
def delete_all_orders(restaurant_id: int = 1, db: Session = Depends(get_db)):
    db.query(models.Order).filter(models.Order.restaurant_id == restaurant_id).delete()
    db.commit()
    return {"message": "All orders deleted successfully"}


@app.get("/api/products")
def get_products(status: Optional[str] = None, restaurant_id: int = 1, db: Session = Depends(get_db)):
    query = db.query(models.MenuItem).join(models.Category).filter(models.Category.restaurant_id == restaurant_id)
    if status:
        is_active_val = True if status == "active" else False
        query = query.filter(models.MenuItem.is_active == is_active_val)
    
    menu_items = query.all()
    
    products = []
    for item in menu_items:
        products.append({
            "id": item.id,
            "product_name": item.name,
            "sku": item.tags or "",
            "status": "active" if item.is_active else "inactive",
            "price": item.price,
            "category": item.category.name if item.category else None,
            "image_url": item.image_url,
            "is_veg": item.is_veg,
            "is_spicy": item.is_spicy,
            "stock": item.stock,
            "recipe_instructions": item.recipe_instructions
        })
    return products


@app.post("/api/products")
async def create_product(product: schemas.ProductCreate, restaurant_id: int = 1, db: Session = Depends(get_db)):
    sku_val = f"SKU-{uuid.uuid4().hex[:8].upper()}"
    
    cat_name = (product.category or "Others").strip().title()
    category = db.query(models.Category).filter(
        func.lower(models.Category.name) == func.lower(cat_name),
        models.Category.restaurant_id == restaurant_id
    ).first()
    
    if not category:
        # Verify restaurant exists
        db_restaurant = db.query(models.Restaurant).filter(models.Restaurant.id == restaurant_id).first()
        if not db_restaurant:
            db_restaurant = models.Restaurant(id=restaurant_id, name="Serve Me")
            db.add(db_restaurant)
            db.commit()
            db.refresh(db_restaurant)
            
        category = models.Category(name=cat_name, restaurant_id=restaurant_id)
        db.add(category)
        db.commit()
        db.refresh(category)
        
    is_active_val = True if product.status == "active" else False
    
    db_item = models.MenuItem(
        name=product.product_name,
        description=f"Delicious {product.product_name}.",
        price=product.price,
        image_url=product.image_url,
        is_active=is_active_val,
        is_available=is_active_val,  # Set available immediately if active so it displays on the menu
        is_veg=product.is_veg,
        is_spicy=product.is_spicy,
        tags=sku_val,
        stock=product.stock,
        category_id=category.id
    )
    db.add(db_item)
    db.commit()
    db.refresh(db_item)
    
    # Broadcast Socket.io update to the restaurant
    await sio.emit("menu_update", "UPDATE_MENU", room=f"restaurant_{restaurant_id}")
    
    return {
        "id": db_item.id,
        "product_name": db_item.name,
        "sku": db_item.tags,
        "status": "active" if db_item.is_active else "inactive",
        "price": db_item.price,
        "category": category.name,
        "image_url": db_item.image_url,
        "is_veg": db_item.is_veg,
        "is_spicy": db_item.is_spicy,
        "stock": db_item.stock
    }


@app.put("/api/products/bulk")
async def update_products_bulk(updates: List[schemas.ProductStatusUpdate], restaurant_id: int = 1, db: Session = Depends(get_db)):
    try:
        for update in updates:
            db_item = db.query(models.MenuItem).join(models.Category).filter(
                models.MenuItem.id == update.id,
                models.Category.restaurant_id == restaurant_id
            ).first()
            if db_item:
                is_act = True if update.status == "active" else False
                db_item.is_active = is_act
                db_item.is_available = is_act
        db.commit()
        
        await sio.emit("menu_update", "UPDATE_MENU", room=f"restaurant_{restaurant_id}")
        return {"message": "Updated successfully"}
    except Exception as e:
        db.rollback()
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.put("/api/products/{product_id}")
async def update_product(product_id: int, product: schemas.ProductUpdate, restaurant_id: int = 1, db: Session = Depends(get_db)):
    db_item = db.query(models.MenuItem).join(models.Category).filter(
        models.MenuItem.id == product_id,
        models.Category.restaurant_id == restaurant_id
    ).first()
    
    if not db_item:
        raise HTTPException(status_code=404, detail="Product not found")
        
    cat_name = (product.category or "Others").strip().title()
    category = db.query(models.Category).filter(
        func.lower(models.Category.name) == func.lower(cat_name),
        models.Category.restaurant_id == restaurant_id
    ).first()
    
    if not category:
        category = models.Category(name=cat_name, restaurant_id=restaurant_id)
        db.add(category)
        db.commit()
        db.refresh(category)
        
    is_active_val = True if product.status == "active" else False
    
    db_item.name = product.product_name
    db_item.price = product.price
    db_item.is_active = is_active_val
    db_item.is_available = is_active_val  # Set available immediately if active so it displays on the menu
    if product.image_url is not None:
        db_item.image_url = product.image_url
    db_item.is_veg = product.is_veg
    db_item.is_spicy = product.is_spicy
    db_item.stock = product.stock
    db_item.category_id = category.id
    
    db.commit()
    db.refresh(db_item)
    
    await sio.emit("menu_update", "UPDATE_MENU", room=f"restaurant_{restaurant_id}")
    
    return {
        "id": db_item.id,
        "product_name": db_item.name,
        "sku": db_item.tags,
        "status": "active" if db_item.is_active else "inactive",
        "price": db_item.price,
        "category": category.name,
        "image_url": db_item.image_url,
        "is_veg": db_item.is_veg,
        "is_spicy": db_item.is_spicy,
        "stock": db_item.stock
    }


@app.delete("/api/products/{product_id}")
async def delete_product(product_id: int, restaurant_id: int = 1, db: Session = Depends(get_db)):
    db_item = db.query(models.MenuItem).join(models.Category).filter(
        models.MenuItem.id == product_id,
        models.Category.restaurant_id == restaurant_id
    ).first()
    
    if not db_item:
        raise HTTPException(status_code=404, detail="Product not found")
        
    db.delete(db_item)
    db.commit()
    
    await sio.emit("menu_update", "UPDATE_MENU", room=f"restaurant_{restaurant_id}")
    return {"message": "Product deleted successfully"}


# Wrap the FastAPI app with the Socket.io ASGIApp so that uvicorn runs it directly
app = socketio.ASGIApp(sio, other_asgi_app=app)
