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
            CREATE TABLE IF NOT EXISTS tables (
                table_id VARCHAR(50) PRIMARY KEY,
                status VARCHAR(20) DEFAULT 'active',
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        // ... (ตารางอื่นๆ คงเดิม) ...
        await pool.query(`CREATE TABLE IF NOT EXISTS categories (id SERIAL PRIMARY KEY, name VARCHAR(100) UNIQUE NOT NULL);`);
        await pool.query(`CREATE TABLE IF NOT EXISTS menu_items (id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, price NUMERIC(10, 2) NOT NULL, category_name VARCHAR(100) NOT NULL, image_url TEXT, category_id INTEGER, is_recommended INT2 DEFAULT 0, is_admin_menu INT2 DEFAULT 0, allow_egg INT2 DEFAULT 0, kitchen_type VARCHAR(50) DEFAULT 'kitchen_1', FOREIGN KEY(category_id) REFERENCES categories(id));`);
        await pool.query(`CREATE TABLE IF NOT EXISTS orders (id SERIAL PRIMARY KEY, table_id VARCHAR(50) NOT NULL, status VARCHAR(50) DEFAULT 'กำลังทำอาหาร', printed_kitchen_1 INT2 DEFAULT 0, printed_kitchen_2 INT2 DEFAULT 0, printed_drink INT2 DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
        await pool.query(`CREATE TABLE IF NOT EXISTS order_items (id SERIAL PRIMARY KEY, order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE, menu_item_id INTEGER REFERENCES menu_items(id), quantity INTEGER NOT NULL, price NUMERIC(10, 2) NOT NULL, notes TEXT, options TEXT, name TEXT);`);
        await pool.query(`CREATE TABLE IF NOT EXISTS sales_history (id SERIAL PRIMARY KEY, table_id VARCHAR(50) NOT NULL, title VARCHAR(100) NOT NULL, total_price NUMERIC(10, 2) NOT NULL, items JSONB, print_status VARCHAR(50) DEFAULT 'รอพิมพ์ใบเสร็จ', checked_out_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
    
        console.log('Database tables checked/initialized successfully.');
    } catch (err) {
        console.error('Error initializing database tables:', err.message);
    }
}

function consolidateItems(items) {
    const map = {};
    items.forEach(item => {
        const key = `${item.name}_${item.notes || ''}_${item.price}`;
        if (map[key]) {
            map[key].quantity += Number(item.quantity);
        } else {
            map[key] = { ...item, quantity: Number(item.quantity) };
        }
    });
    return Object.values(map);
}

// --- API Endpoints ---

app.get('/api/check-table-status/:tableId', async (req, res) => {
    const tableId = String(req.params.tableId).toUpperCase();
    try {
        if (tableId === 'PENDING_QUEUE') return res.json({ active: true });
        const result = await pool.query("SELECT status FROM tables WHERE UPPER(table_id) = $1", [tableId]);
        if (result.rows.length === 0 || result.rows[0].status === 'closed') {
            return res.json({ active: false });
        }
        res.json({ active: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/orders', async (req, res) => {
    const { table_id, items } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const upperTableId = String(table_id).toUpperCase();
        await client.query(`INSERT INTO tables (table_id, status) VALUES ($1, 'active') ON CONFLICT (table_id) DO UPDATE SET status = 'active', updated_at = CURRENT_TIMESTAMP`, [upperTableId]);
        const orderResult = await client.query('INSERT INTO orders (table_id) VALUES ($1) RETURNING id', [upperTableId]);
        const orderId = orderResult.rows[0].id;
        for (const item of items) {
            await client.query('INSERT INTO order_items (order_id, menu_item_id, quantity, price, notes, options, name) VALUES ($1, $2, $3, $4, $5, $6, $7)', [orderId, item.menu_item_id, item.quantity, item.price, item.notes || null, item.options ? JSON.stringify(item.options) : (item.options_str || null), item.name || null]);
        }
        await client.query('COMMIT');
        res.json({ success: true, order_id: orderId });
    } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } finally { client.release(); }
});

app.put('/api/orders/table/:tableId/move', async (req, res) => {
    const oldTableId = String(req.params.tableId).toUpperCase();
    const { new_table_id } = req.body;
    const targetNewId = String(new_table_id).toUpperCase();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // อัปเดตออเดอร์
        await client.query('UPDATE orders SET table_id = $1 WHERE UPPER(table_id) = $2', [targetNewId, oldTableId]);
        // ปิดโต๊ะเก่า
        await client.query("UPDATE tables SET status = 'closed' WHERE table_id = $1", [oldTableId]);
        // เปิดโต๊ะใหม่
        await client.query(`INSERT INTO tables (table_id, status) VALUES ($1, 'active') ON CONFLICT (table_id) DO UPDATE SET status = 'active', updated_at = CURRENT_TIMESTAMP`, [targetNewId]);
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } finally { client.release(); }
});

app.delete('/api/orders/table/:tableId', async (req, res) => {
    const tableId = String(req.params.tableId).toUpperCase();
    try {
        const ordersResult = await pool.query('SELECT id FROM orders WHERE UPPER(table_id) = $1', [tableId]);
        const orderIds = ordersResult.rows.map(o => o.id);
        if (orderIds.length > 0) {
            await pool.query('DELETE FROM order_items WHERE order_id = ANY($1::int[])', [orderIds]);
            await pool.query('DELETE FROM orders WHERE id = ANY($1::int[])', [orderIds]);
        }
        await pool.query("UPDATE tables SET status = 'closed' WHERE table_id = $1", [tableId]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ... (API อื่นๆ ที่เหลือคงเดิม) ...

app.listen(PORT, () => { console.log(`Server running on http://localhost:${PORT}`); });