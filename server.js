const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // ตั้งค่าโฟลเดอร์สำหรับไฟล์ static เช่น รูปภาพ/HTML

// เชื่อมต่อฐานข้อมูล SQLite (หรือสร้างไฟล์ใหม่ถ้ายังไม่มี)
const db = new SQLite3.Database(path.join(__dirname, 'database.sqlite'), (err) => {
    if (err) {
        console.error('Error opening database', err.message);
    } else {
        console.log('Connected to SQLite database.');
        initDatabase();
    }
});

// สร้างตารางข้อมูลเริ่มต้น (รองรับ table_id เป็น TEXT เพื่อรองรับรหัสซุ้ม เช่น Z1)
function initDatabase() {
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS menu_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            price REAL NOT NULL,
            category_id INTEGER,
            image_url TEXT,
            FOREIGN KEY (category_id) REFERENCES categories(id)
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_id TEXT NOT NULL,
            status TEXT DEFAULT 'pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // ตารางเก็บรายการอาหารในแต่ละออเดอร์ (เพิ่มคอลัมน์ options สำหรับเก็บตัวเลือกเสริม เช่น ไข่ดาว/ไข่เจียว)
        db.run(`CREATE TABLE IF NOT EXISTS order_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER,
            menu_item_id INTEGER,
            quantity INTEGER,
            price REAL,
            notes TEXT,
            options TEXT,
            FOREIGN KEY (order_id) REFERENCES orders(id),
            FOREIGN KEY (menu_item_id) REFERENCES menu_items(id)
        )`);
    });
}

// 1. API ดึงรายการเมนูทั้งหมด
app.get('/api/menu', (req, res) => {
    const query = `
        SELECT menu_items.*, categories.name as category_name 
        FROM menu_items 
        LEFT JOIN categories ON menu_items.category_id = categories.id
    `;
    db.all(query, [], (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows);
    });
});

// 2. API สั่งอาหาร (บันทึกลงฐานข้อมูล)
app.post('/api/orders', (req, res) => {
    const { table_id, items } = req.body;

    if (!table_id || !items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'ข้อมูลออเดอร์ไม่ถูกต้อง' });
    }

    db.run(`INSERT INTO orders (table_id, status) VALUES (?, ?)`, [table_id, 'pending'], function(err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }

        const orderId = this.lastID;
        const stmt = db.prepare(`INSERT INTO order_items (order_id, menu_item_id, quantity, price, notes, options) VALUES (?, ?, ?, ?, ?, ?)`);

        items.forEach(item => {
            stmt.run(orderId, item.menu_item_id, item.quantity, item.price, item.notes || null, item.options || null);
        });

        stmt.finalize((err) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            res.json({ success: true, order_id: orderId, message: 'สั่งอาหารสำเร็จ' });
        });
    });
});

// 3. API ดึงประวัติการสั่งอาหารตามโต๊ะหรือซุ้ม (รองรับตัวอักษรเช่น Z1)
app.get('/api/orders/table/:tableId', (req, res) => {
    const tableId = req.params.tableId;

    const queryOrders = `SELECT * FROM orders WHERE table_id = ? ORDER BY created_at DESC`;
    db.all(queryOrders, [tableId], async (err, orders) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }

        // ดึงรายการอาหารย่อยของแต่ละออเดอร์มาประกอบกัน
        const fullOrders = await Promise.all(orders.map(async (ord) => {
            return new Promise((resolve, reject) => {
                const queryItems = `
                    SELECT order_items.*, menu_items.name 
                    FROM order_items 
                    LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id 
                    WHERE order_items.order_id = ?
                `;
                db.all(queryItems, [ord.id], (err, items) => {
                    if (err) reject(err);
                    else resolve({ ...ord, items });
                });
            });
        }));

        res.json(fullOrders);
    });
});

// เริ่มต้นรัน Server
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});