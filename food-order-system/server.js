const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ตั้งค่าการเชื่อมต่อ PostgreSQL / pgAdmin 4
const pool = new Pool({
    user: 'postgres',         // ชื่อผู้ใช้ของคุณ
    host: 'localhost',        // หรือ IP ของฐานข้อมูล
    database: 'restaurant_db',// ชื่อฐานข้อมูลที่คุณสร้างไว้
    password: '136120',       // รหัสผ่านของ pgAdmin 4 คุณ
    port: 21715,              // พอร์ตมาตรฐานของ PostgreSQL
});

// ตรวจสอบการเชื่อมต่อฐานข้อมูล
pool.connect((err, client, release) => {
    if (err) {
        console.error('Error connecting to PostgreSQL database:', err.stack);
    } else {
        console.log('Connected to PostgreSQL database successfully.');
        release();
        initDatabase();
    }
});

// สร้างตารางโครงสร้างเริ่มต้นอัตโนมัติ (ถ้ายังไม่มี)
async function initDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS categories (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) UNIQUE NOT NULL
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS menu_items (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                price NUMERIC(10, 2) NOT NULL,
                category_name VARCHAR(100) NOT NULL,
                image_url TEXT,
                category_id INTEGER,
                FOREIGN KEY(category_id) REFERENCES categories(id)
            );
        `);

        // สร้างตาราง orders รองรับ table_id เป็นตัวอักษรหรือตัวเลข (VARCHAR)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS orders (
                id SERIAL PRIMARY KEY,
                table_id VARCHAR(50) NOT NULL,
                status VARCHAR(50) DEFAULT 'กำลังทำอาหาร',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // สร้างตาราง order_items สำหรับเก็บรายการอาหารในแต่ละออเดอร์
        await pool.query(`
            CREATE TABLE IF NOT EXISTS order_items (
                id SERIAL PRIMARY KEY,
                order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
                menu_item_id INTEGER REFERENCES menu_items(id),
                quantity INTEGER NOT NULL,
                price NUMERIC(10, 2) NOT NULL
            );
        `);
    
        console.log('Database tables checked/initialized successfully.');
    } catch (err) {
        console.error('Error initializing database tables:', err.message);
    }
}

// --- API Endpoints ---

// 1. ดึงรายการเมนูทั้งหมด
app.get('/api/menu', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM menu_items ORDER BY id ASC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. รับออเดอร์ใหม่
app.post('/api/orders', async (req, res) => {
    const { table_id, items } = req.body;
    if (!table_id || !items || items.length === 0) {
        return res.status(400).json({ error: 'ข้อมูลออเดอร์ไม่ครบถ้วน' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const orderResult = await client.query(
            'INSERT INTO orders (table_id) VALUES ($1) RETURNING id',
            [table_id]
        );
        const orderId = orderResult.rows[0].id;

        for (const item of items) {
            await client.query(
                'INSERT INTO order_items (order_id, menu_item_id, quantity, price) VALUES ($1, $2, $3, $4)',
                [orderId, item.menu_item_id, item.quantity, item.price]
            );
        }

        await client.query('COMMIT');
        res.json({ message: 'สั่งอาหารสำเร็จ', order_id: orderId });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// 3. ดึงประวัติออเดอร์ตามโต๊ะ
app.get('/api/orders/table/:tableId', async (req, res) => {
    const tableId = req.params.tableId;
    try {
        const ordersResult = await pool.query(
            'SELECT * FROM orders WHERE table_id = $1 ORDER BY created_at DESC',
            [tableId]
        );
        const orders = ordersResult.rows;

        if (orders.length === 0) return res.json([]);

        for (let i = 0; i < orders.length; i++) {
            const itemsResult = await pool.query(`
                SELECT oi.quantity, oi.price, m.name 
                FROM order_items oi 
                JOIN menu_items m ON oi.menu_item_id = m.id 
                WHERE oi.order_id = $1
            `, [orders[i].id]);
            orders[i].items = itemsResult.rows;
        }

        res.json(orders);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. ดึงออเดอร์ทั้งหมดสำหรับหน้าจอครัว (Admin)
app.get('/api/admin/orders', async (req, res) => {
    try {
        const ordersResult = await pool.query(
            'SELECT * FROM orders ORDER BY created_at DESC'
        );
        const orders = ordersResult.rows;

        if (orders.length === 0) return res.json([]);

        for (let i = 0; i < orders.length; i++) {
            const itemsResult = await pool.query(`
                SELECT oi.quantity, oi.price, m.name 
                FROM order_items oi 
                JOIN menu_items m ON oi.menu_item_id = m.id 
                WHERE oi.order_id = $1
            `, [orders[i].id]);
            orders[i].items = itemsResult.rows;
        }

        res.json(orders);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5. อัปเดตสถานะออเดอร์
app.put('/api/admin/orders/:id/status', async (req, res) => {
    const orderId = req.params.id;
    const { status } = req.body;

    try {
        await pool.query('UPDATE orders SET status = $1 WHERE id = $2', [status, orderId]);
        res.json({ message: 'อัปเดตสถานะสำเร็จ' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 6. ลบ/เคลียร์ออเดอร์ของโต๊ะ
app.delete('/api/orders/table/:tableId', async (req, res) => {
    const tableId = req.params.tableId;
    try {
        const ordersResult = await pool.query('SELECT id FROM orders WHERE table_id = $1', [tableId]);
        const orders = ordersResult.rows;

        if (orders.length === 0) {
            return res.json({ success: true, message: 'No orders found for this table' });
        }

        const orderIds = orders.map(o => o.id);
        
        await pool.query('DELETE FROM order_items WHERE order_id = ANY($1::int[])', [orderIds]);
        await pool.query('DELETE FROM orders WHERE table_id = $1', [tableId]);

        res.json({ success: true, message: `Cleared orders for table ${tableId} successfully` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 7. เพิ่มเมนูอาหารใหม่
app.post('/api/menu', async (req, res) => {
    const { name, price, category_name, image_url, category_id } = req.body;
    try {
        const result = await pool.query(
            `INSERT INTO menu_items (name, price, category_name, image_url, category_id) 
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [name, price, category_name, image_url || 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c', category_id || 1]
        );
        res.json({ success: true, id: result.rows[0].id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 8. ลบเมนูอาหาร
app.delete('/api/menu/:id', async (req, res) => {
    const menuId = req.params.id;
    try {
        await pool.query('DELETE FROM menu_items WHERE id = $1', [menuId]);
        res.json({ success: true, message: 'Deleted menu successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});