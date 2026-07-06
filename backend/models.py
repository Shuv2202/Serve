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
    is_veg = Column(Boolean, default=True)
    is_spicy = Column(Boolean, default=False)
    tags = Column(String(255), nullable=True) # e.g., "Special, Bestseller"
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
