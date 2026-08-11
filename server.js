const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// กำหนด Path ของ Disk ให้ตรงกับที่ตั้งค่าไว้ใน Render Dashboard
const uploadDir = process.env.NODE_ENV === 'production' 
    ? '/opt/render/project/src/uploads' 
    : path.join(__dirname, 'public', 'uploads');

if (!fs.existsSync(uploadDir)){
    fs.mkdirSync(uploadDir, { recursive: true });
}

app.use('/uploads', express.static(uploadDir));

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

pool.connect((err, client, release) => {
    if (err) {
        console.error('Error connecting to PostgreSQL database:', err.stack);
    } else {
        console.log('Connected to PostgreSQL database successfully.');
        release();
        initDatabase();
    }
});

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
                is_recommended INT2 DEFAULT 0,
                is_admin_menu INT2 DEFAULT 0,
                allow_egg INT2 DEFAULT 0,
                FOREIGN KEY(category_id) REFERENCES categories(id)
            );
        `);

        await pool.query(`
            ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS is_recommended INT2 DEFAULT 0;
            ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS is_admin_menu INT2 DEFAULT 0;
            ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS allow_egg INT2 DEFAULT 0;
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS orders (
                id SERIAL PRIMARY KEY,
                table_id VARCHAR(50) NOT NULL,
                status VARCHAR(50) DEFAULT 'กำลังทำอาหาร',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS order_items (
                id SERIAL PRIMARY KEY,
                order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
                menu_item_id INTEGER REFERENCES menu_items(id),
                quantity INTEGER NOT NULL,
                price NUMERIC(10, 2) NOT NULL,
                notes TEXT,
                options TEXT,
                name TEXT
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS sales_history (
                id SERIAL PRIMARY KEY,
                table_id VARCHAR(50) NOT NULL,
                title VARCHAR(100) NOT NULL,
                total_price NUMERIC(10, 2) NOT NULL,
                items JSONB,
                print_status VARCHAR(50) DEFAULT 'รอพิมพ์ใบเสร็จ',
                checked_out_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            ALTER TABLE sales_history ADD COLUMN IF NOT EXISTS print_status VARCHAR(50) DEFAULT 'รอพิมพ์ใบเสร็จ';
        `);
    
        console.log('Database tables checked/initialized successfully.');
    } catch (err) {
        console.error('Error initializing database tables:', err.message);
    }
}

// --- API Endpoints ---

app.get('/api/menu', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM menu_items ORDER BY id ASC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

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
            [String(table_id).toUpperCase()]
        );
        const orderId = orderResult.rows[0].id;

        for (const item of items) {
            await client.query(
                'INSERT INTO order_items (order_id, menu_item_id, quantity, price, notes, options, name) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                [
                    orderId, 
                    item.menu_item_id, 
                    item.quantity, 
                    item.price, 
                    item.notes || null, 
                    item.options ? JSON.stringify(item.options) : (item.options_str || null),
                    item.name || null
                ]
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

app.get('/api/orders/table/:tableId', async (req, res) => {
    const tableId = String(req.params.tableId).toUpperCase();
    try {
        const ordersResult = await pool.query(
            'SELECT * FROM orders WHERE UPPER(table_id) = $1 ORDER BY created_at DESC',
            [tableId]
        );
        const orders = ordersResult.rows;

        if (orders.length === 0) return res.json([]);

        for (let i = 0; i < orders.length; i++) {
            const itemsResult = await pool.query(`
                SELECT oi.quantity, oi.price, oi.notes, oi.options, oi.name 
                FROM order_items oi 
                WHERE oi.order_id = $1
            `, [orders[i].id]);
            orders[i].items = itemsResult.rows;
        }

        res.json(orders);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/orders', async (req, res) => {
    try {
        const ordersResult = await pool.query(
            'SELECT * FROM orders ORDER BY created_at DESC'
        );
        const orders = ordersResult.rows;

        if (orders.length === 0) return res.json([]);

        for (let i = 0; i < orders.length; i++) {
            const itemsResult = await pool.query(`
                SELECT oi.quantity, oi.price, oi.notes, oi.options, oi.name 
                FROM order_items oi 
                WHERE oi.order_id = $1
            `, [orders[i].id]);
            orders[i].items = itemsResult.rows;
        }

        res.json(orders);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

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

app.delete('/api/orders/:orderId/item/:itemIndex', async (mainReq, mainRes) => {
    const orderId = mainReq.params.orderId;
    const itemIndex = parseInt(mainReq.params.itemIndex);

    try {
        const itemsResult = await pool.query(
            'SELECT id FROM order_items WHERE order_id = $1 ORDER BY id ASC',
            [orderId]
        );

        if (itemsResult.rows.length <= itemIndex) {
            return mainRes.status(404).json({ error: 'ไม่พบรายการอาหารที่ต้องการลบ' });
        }

        const targetItemId = itemsResult.rows[itemIndex].id;

        await pool.query('DELETE FROM order_items WHERE id = $1', [targetItemId]);

        const checkRemaining = await pool.query('SELECT COUNT(*) FROM order_items WHERE order_id = $1', [orderId]);
        if (parseInt(checkRemaining.rows[0].count) === 0) {
            await pool.query('DELETE FROM orders WHERE id = $1', [orderId]);
        }

        mainRes.json({ success: true, message: 'ลบรายการอาหารสำเร็จ' });
    } catch (err) {
        mainRes.status(500).json({ error: err.message });
    }
});

app.put('/api/orders/table/:tableId/move', async (req, res) => {
    const oldTableId = String(req.params.tableId).toUpperCase();
    const { new_table_id } = req.body;

    if (!new_table_id) {
        return res.status(400).json({ error: 'กรุณาระบุโต๊ะปลายทาง' });
    }

    const targetNewId = String(new_table_id).toUpperCase();

    try {
        const updateResult = await pool.query(
            'UPDATE orders SET table_id = $1 WHERE UPPER(table_id) = $2',
            [targetNewId, oldTableId]
        );

        if (updateResult.rowCount === 0) {
            return res.status(404).json({ error: 'ไม่พบออเดอร์ของโต๊ะต้นทางที่ต้องการย้าย' });
        }

        res.json({ success: true, message: `ย้ายออเดอร์จาก ${oldTableId} ไปยัง ${targetNewId} สำเร็จ` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/orders/table/:tableId', async (req, res) => {
    const tableId = String(req.params.tableId).toUpperCase();
    try {
        const ordersResult = await pool.query('SELECT id FROM orders WHERE UPPER(table_id) = $1', [tableId]);
        const orders = ordersResult.rows;

        if (orders.length === 0) {
            return res.json({ success: true, message: 'No orders found for this table' });
        }

        const orderIds = orders.map(o => o.id);
        
        await pool.query('DELETE FROM order_items WHERE order_id = ANY($1::int[])', [orderIds]);
        await pool.query('DELETE FROM orders WHERE UPPER(table_id) = $1', [tableId]);

        res.json({ success: true, message: `Cleared orders for table ${tableId} successfully` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/menu', upload.single('image'), async (req, res) => {
    const { name, price, category_name, category_id, is_recommended, is_admin_menu, allow_egg } = req.body;
    const image_url = req.file ? `/uploads/${req.file.filename}` : (req.body.image_url || 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c');
    
    try {
        const result = await pool.query(
            `INSERT INTO menu_items (name, price, category_name, image_url, category_id, is_recommended, is_admin_menu, allow_egg) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [
                name, 
                price, 
                category_name, 
                image_url, 
                category_id || 1, 
                is_recommended || 0, 
                is_admin_menu || 0,
                allow_egg || 0
            ]
        );
        res.json({ success: true, id: result.rows[0].id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/menu/:id', upload.single('image'), async (req, res) => {
    const menuId = req.params.id;
    const { name, price, category_name, is_recommended, is_admin_menu, allow_egg } = req.body;

    try {
        const recVal = is_recommended !== undefined ? is_recommended : 0;
        const adminVal = is_admin_menu !== undefined ? is_admin_menu : 0;
        const eggVal = allow_egg !== undefined ? allow_egg : 0;

        let query = `UPDATE menu_items SET name = $1, price = $2, category_name = $3, is_recommended = $4, is_admin_menu = $5, allow_egg = $6`;
        let params = [name, price, category_name, recVal, adminVal, eggVal];

        if (req.file) {
            const image_url = `/uploads/${req.file.filename}`;
            query += `, image_url = $7 WHERE id = $8`;
            params.push(image_url, menuId);
        } else {
            query += ` WHERE id = $7`;
            params.push(menuId);
        }

        await pool.query(query, params);
        res.json({ success: true, message: 'อัปเดตเมนูสำเร็จ' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/menu/:id', async (req, res) => {
    const menuId = req.params.id;
    try {
        await pool.query('DELETE FROM menu_items WHERE id = $1', [menuId]);
        res.json({ success: true, message: 'Deleted menu successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/sales-history', async (req, res) => {
    try {
        const { table_id, title, total_price, items } = req.body;
        
        const result = await pool.query(
            `INSERT INTO sales_history (table_id, title, total_price, items, print_status) 
             VALUES ($1, $2, $3, $4, 'รอพิมพ์ใบเสร็จ') RETURNING id`,
            [table_id, title, total_price, JSON.stringify(items)]
        );

        res.status(200).json({ success: true, id: result.rows[0].id, message: 'บันทึกประวัติยอดขายสำเร็จ' });
    } catch (err) {
        console.error('Server Error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/sales-history', async (req, res) => {
    try {
        let { start_date, end_date } = req.query;
        let query = 'SELECT * FROM sales_history';
        let queryParams = [];

        if (start_date && end_date) {
            query += ' WHERE checked_out_at >= $1 AND checked_out_at < ($2::date + INTERVAL \'1 day\')';
            queryParams = [start_date, end_date];
        } else if (start_date) {
            query += ' WHERE checked_out_at >= $1';
            queryParams = [start_date];
        } else if (end_date) {
            query += ' WHERE checked_out_at < ($1::date + INTERVAL \'1 day\')';
            queryParams = [end_date];
        }

        query += ' ORDER BY checked_out_at DESC';

        const result = await pool.query(query, queryParams);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('Server Error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/unprinted-receipts', async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT * FROM sales_history WHERE print_status = 'รอพิมพ์ใบเสร็จ' ORDER BY checked_out_at ASC"
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/admin/receipts/:id/printed', async (req, res) => {
    const receiptId = req.params.id;
    try {
        await pool.query(
            "UPDATE sales_history SET print_status = 'พิมพ์แล้ว' WHERE id = $1",
            [receiptId]
        );
        res.json({ success: true, message: 'อัปเดตสถานะใบเสร็จเป็นพิมพ์แล้ว' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});