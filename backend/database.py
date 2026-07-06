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
