# backend/schemas.py
from pydantic import BaseModel
from typing import List, Optional

# --- Menu Items ---
class MenuItemBase(BaseModel):
    name: str
    description: Optional[str] = None
    price: float
    image_url: Optional[str] = None
    is_veg: Optional[bool] = True
    is_spicy: Optional[bool] = False
    tags: Optional[str] = None

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
