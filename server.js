const express = require('express');
const sqlite3 = require('sqlite'); // เปลี่ยนเป็น sqlite
const sqliteDriver = require('sqlite3'); // ใช้ sqlite3 เป็น Driver เบื้องหลัง
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let db;

// ฟังก์ชันเชื่อมต่อฐานข้อมูลและสร้างตาราง
async function initDatabase() {
    db = await sqlite3.open({
        filename: path.join(__dirname, 'database.sqlite'),
        driver: sqliteDriver.Database
    });

    // สร้างตาราง
    await db.exec(`
        CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS menu_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            price REAL NOT NULL,
            category_id INTEGER,
            image_url TEXT,
            FOREIGN KEY (category_id) REFERENCES categories(id)
        );

        CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_id TEXT NOT NULL,
            status TEXT DEFAULT 'pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS order_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER,
            menu_item_id INTEGER,
            quantity INTEGER,
            price REAL,
            notes TEXT,
            options TEXT,
            FOREIGN KEY (order_id) REFERENCES orders(id),
            FOREIGN KEY (menu_item_id) REFERENCES menu_items(id)
        );
    `);
    console.log('Connected to SQLite database (Async/Await).');
}

initDatabase();

// 1. API ดึงรายการเมนูทั้งหมด
app.get('/api/menu', async (req, res) => {
    try {
        const query = `
            SELECT menu_items.*, categories.name as category_name 
            FROM menu_items 
            LEFT JOIN categories ON menu_items.category_id = categories.id
        `;
        const rows = await db.all(query);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. API สั่งอาหาร
app.post('/api/orders', async (req, res) => {
    const { table_id, items } = req.body;

    if (!table_id || !items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'ข้อมูลออเดอร์ไม่ถูกต้อง' });
    }

    try {
        const result = await db.run(
            `INSERT INTO orders (table_id, status) VALUES (?, ?)`, 
            [table_id, 'pending']
        );
        const orderId = result.lastID;

        for (const item of items) {
            await db.run(
                `INSERT INTO order_items (order_id, menu_item_id, quantity, price, notes, options) VALUES (?, ?, ?, ?, ?, ?)`,
                [orderId, item.menu_item_id, item.quantity, item.price, item.notes || null, item.options || null]
            );
        }

        res.json({ success: true, order_id: orderId, message: 'สั่งอาหารสำเร็จ' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. API ดึงประวัติการสั่งอาหารตามโต๊ะหรือซุ้ม
app.get('/api/orders/table/:tableId', async (req, res) => {
    const tableId = req.params.tableId;

    try {
        const orders = await db.all(`SELECT * FROM orders WHERE table_id = ? ORDER BY created_at DESC`, [tableId]);
        
        const fullOrders = await Promise.all(orders.map(async (ord) => {
            const items = await db.all(`
                SELECT order_items.*, menu_items.name 
                FROM order_items 
                LEFT JOIN menu_items ON order_items.menu_item_id = menu_items.id 
                WHERE order_items.order_id = ?
            `, [ord.id]);
            return { ...ord, items };
        }));

        res.json(fullOrders);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});