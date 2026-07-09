# seed_menu.py
import requests

BASE_URL = "http://127.0.0.1:8000"

def create_restaurant(name):
    r = requests.post(f"{BASE_URL}/restaurants/", json={"name": name})
    r.raise_for_status()
    return r.json()["id"]

def create_category(restaurant_id, name):
    r = requests.post(f"{BASE_URL}/restaurants/{restaurant_id}/categories/", json={"name": name})
    r.raise_for_status()
    return r.json()["id"]

def create_menu_item(category_id, name, description, price, is_veg=True, is_spicy=False, tags=None, image_url=None):
    payload = {
        "name": name,
        "description": description,
        "price": price,
        "is_veg": is_veg,
        "is_spicy": is_spicy,
        "tags": tags
    }
    if image_url:
        payload["image_url"] = image_url
    r = requests.post(f"{BASE_URL}/categories/{category_id}/items/", json=payload)
    r.raise_for_status()
    return r.json()["id"]

def main():
    # 1. Restaurant
    restaurant_id = create_restaurant("Serve Me")
    print("Created restaurant id", restaurant_id)

    # 2. Categories
    category_names = [
        "Starter", "Soup", "Salad", "Pizza", "Chinese", 
        "Punjabi", "South Indian", "Sizzlers", "Beverages", "Dessert"
    ]
    
    categories = {}
    for cat_name in category_names:
        cat_id = create_category(restaurant_id, cat_name)
        categories[cat_name] = cat_id
        print(f"Created category '{cat_name}' id", cat_id)

    # 3. Items for "Starter"
    starter_items = [
        {"name": "French Fries", "price": 400.0, "tags": "Special", "image_url": "/images/french_fries.png"},
        {"name": "Peri Peri French Fries", "price": 180.0, "image_url": "/images/french_fries.png"},
        {"name": "Cheese French Fries", "price": 160.0, "image_url": "/images/french_fries.png"},
        {"name": "Fully Loaded French Fries", "price": 170.0, "image_url": "/images/french_fries.png"},
        {"name": "Cheese Ball", "price": 209.0, "image_url": "/images/pakoda.png"},
        {"name": "Chilli Paneer", "price": 450.0, "tags": "Special", "image_url": "/images/pakoda.png"},
        {"name": "Dragon Potato", "price": 280.0, "is_spicy": True, "image_url": "/images/french_fries.png"},
        {"name": "Onion Pakoda", "price": 110.0, "image_url": "/images/pakoda.png"},
        {"name": "Chana Dal Chat", "price": 70.0, "image_url": "/images/pakoda.png"},
        {"name": "Plain Maggie", "price": 200.0, "tags": "Special", "image_url": "/images/maggi.png"},
        {"name": "Cheese Maggie", "price": 120.0, "tags": "Customizable", "image_url": "/images/maggi.png"},
        {"name": "Vegetable Maggi", "price": 100.0, "tags": "Bestseller", "image_url": "/images/maggi.png"},
        {"name": "Chilli Potato", "price": 240.0, "tags": "Customizable, Bestseller", "image_url": "/images/french_fries.png"},
    ]

    starter_cat_id = categories["Starter"]
    for item in starter_items:
        item_id = create_menu_item(
            category_id=starter_cat_id,
            name=item["name"],
            description=None,
            price=item["price"],
            is_veg=True, # all items in the image are veg
            is_spicy=item.get("is_spicy", False),
            tags=item.get("tags"),
            image_url=item.get("image_url")
        )
        print(f"  Added menu item '{item['name']}' id", item_id)

if __name__ == "__main__":
    main()
