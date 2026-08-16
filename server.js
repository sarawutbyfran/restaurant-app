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
                session_token VARCHAR(100),
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // พยายามเพิ่ม session_token เผื่อกรณีที่ตารางมีอยู่แล้วแต่ยังไม่มีคอลัมน์นี้
        try {
            await pool.query(`ALTER TABLE tables ADD COLUMN session_token VARCHAR(100);`);
        } catch (e) {
            // ข้ามไปหากมีคอลัมน์นี้อยู่แล้ว
        }

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
                kitchen_type VARCHAR(50) DEFAULT 'kitchen_1',
                FOREIGN KEY(category_id) REFERENCES categories(id)
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS orders (
                id SERIAL PRIMARY KEY,
                table_id VARCHAR(50) NOT NULL,
                status VARCHAR(50) DEFAULT 'กำลังทำอาหาร',
                printed_kitchen_1 INT2 DEFAULT 0,
                printed_kitchen_2 INT2 DEFAULT 0,
                printed_drink INT2 DEFAULT 0,
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

app.get('/api/menu', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM menu_items ORDER BY category_id ASC, id ASC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ตรวจสอบสถานะโต๊ะ/คิว
app.get('/api/check-table-status/:tableId', async (req, res) => {
    const tableId = String(req.params.tableId).toUpperCase();
    try {
        if (tableId === 'PENDING_QUEUE') return res.json({ active: true });

        const result = await pool.query("SELECT status FROM tables WHERE UPPER(table_id) = $1", [tableId]);
        if (result.rows.length === 0 || result.rows[0].status === 'closed') {
            return res.json({ active: false });
        }
        res.json({ active: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// เปิดโต๊ะเฉพาะตอนสแกน QR Code จริงๆ
app.post('/api/open-table', async (req, res) => {
    const { table_id } = req.body;
    if (!table_id) return res.status(400).json({ error: 'Missing table_id' });
    
    const tableId = String(table_id).toUpperCase();
    
    try {
        // 1. ตรวจสอบว่าโต๊ะนี้มี Token อยู่แล้วหรือไม่ และสถานะยัง active หรือไม่
        const check = await pool.query(
            "SELECT session_token FROM tables WHERE table_id = $1 AND status = 'active'", 
            [tableId]
        );

        if (check.rows.length > 0 && check.rows[0].session_token) {
            // ถ้าโต๊ะ Active อยู่แล้ว ให้คืน Token เดิมที่มีอยู่กลับไป (เพื่อให้เครื่องอื่นที่สั่งทีหลังใช้รหัสเดียวกัน)
            return res.json({ success: true, token: check.rows[0].session_token });
        } else {
            // ถ้ายังไม่มี หรือโต๊ะถูกปิดไปแล้ว (closed) ให้สร้างใหม่
            const newToken = Math.random().toString(36).substring(7);
            
            await pool.query(`
                INSERT INTO tables (table_id, status, session_token, updated_at) 
                VALUES ($1, 'active', $2, CURRENT_TIMESTAMP) 
                ON CONFLICT (table_id) 
                DO UPDATE SET status = 'active', session_token = $2, updated_at = CURRENT_TIMESTAMP
            `, [tableId, newToken]);
            
            return res.json({ success: true, token: newToken });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// สร้างเลขคิวใหม่สำหรับ Walk-in (แก้ไขเรื่องเลขคิวซ้ำซ้อน)
app.post('/api/walk-in-queue', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // ล็อคตารางเพื่อป้องกันการแจกเลขคิวซ้ำเมื่อมีคนสแกนพร้อมกัน
        await client.query('LOCK TABLE tables IN EXCLUSIVE MODE');

        // เปลี่ยนมาเช็คคิวจาก tables ที่จองไว้แทน orders
        const activeQueues = await client.query("SELECT table_id FROM tables WHERE table_id LIKE 'Q%'");
        let nextQNum = 1;
        if (activeQueues.rows.length > 0) {
            const nums = activeQueues.rows.map(row => {
                const parsed = parseInt(row.table_id.replace('Q', ''));
                return isNaN(parsed) ? 0 : parsed;
            });
            nextQNum = Math.max(...nums) + 1;
        }
        const newQueueId = `Q${String(nextQNum).padStart(3, '0')}`;
        
        // เปิดสถานะคิวใหม่ในตาราง tables ทันที
        await client.query(`
            INSERT INTO tables (table_id, status, updated_at) 
            VALUES ($1, 'active', CURRENT_TIMESTAMP) 
            ON CONFLICT (table_id) 
            DO UPDATE SET status = 'active', updated_at = CURRENT_TIMESTAMP
        `, [newQueueId]);

        await client.query('COMMIT');
        res.json({ success: true, queue_id: newQueueId });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

app.post('/api/orders', async (req, res) => {
    const { table_id, token, items } = req.body;
    if (!table_id || !token || !items || items.length === 0) {
        return res.status(400).json({ error: 'ข้อมูลไม่ครบถ้วน' });
    }
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const upperTableId = String(table_id).toUpperCase();
        
        // ตรวจสอบว่าโต๊ะนี้ active และ token ยังถูกต้องอยู่ไหม
        const check = await client.query(
            "SELECT status FROM tables WHERE table_id = $1 AND session_token = $2", 
            [upperTableId, token]
        );

        if (check.rows.length === 0 || check.rows[0].status === 'closed') {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'โต๊ะนี้เช็คบิลแล้ว ขอบคุณที่ใช้บริการ' });
        }
        
        const orderResult = await client.query('INSERT INTO orders (table_id) VALUES ($1) RETURNING id', [upperTableId]);
        const orderId = orderResult.rows[0].id;
        
        for (const item of items) {
            await client.query('INSERT INTO order_items (order_id, menu_item_id, quantity, price, notes, options, name) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
                orderId, item.menu_item_id, item.quantity, item.price, item.notes || null, item.options || null, item.name || null
            ]);
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
        const ordersResult = await pool.query('SELECT * FROM orders WHERE UPPER(table_id) = $1 ORDER BY created_at DESC', [tableId]);
        const orders = ordersResult.rows;

        if (orders.length === 0) return res.json([]);

        for (let i = 0; i < orders.length; i++) {
            const itemsResult = await pool.query(`
                SELECT oi.quantity, oi.price, oi.notes, oi.options, oi.name 
                FROM order_items oi WHERE oi.order_id = $1
            `, [orders[i].id]);
            orders[i].items = consolidateItems(itemsResult.rows);
        }
        res.json(orders);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/orders', async (req, res) => {
    try {
        const ordersResult = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
        const orders = ordersResult.rows;

        if (orders.length === 0) return res.json([]);

        for (let i = 0; i < orders.length; i++) {
            const itemsResult = await pool.query(`
                SELECT oi.quantity, oi.price, oi.notes, oi.options, oi.name 
                FROM order_items oi WHERE oi.order_id = $1
            `, [orders[i].id]);
            orders[i].items = consolidateItems(itemsResult.rows);
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

app.put('/api/admin/orders/:id/reset-print', async (req, res) => {
    const orderId = req.params.id;
    try {
        await pool.query('UPDATE orders SET printed_kitchen_1 = 0, printed_kitchen_2 = 0, printed_drink = 0, status = $1 WHERE id = $2', ['กำลังทำอาหาร', orderId]);
        res.json({ success: true, message: 'รีเซ็ตสถานะพิมพ์สำเร็จ' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/orders/:orderId/item/:itemIndex', async (mainReq, mainRes) => {
    const orderId = mainReq.params.orderId;
    const itemIndex = parseInt(mainReq.params.itemIndex);
    try {
        const itemsResult = await pool.query('SELECT id FROM order_items WHERE order_id = $1 ORDER BY id ASC', [orderId]);
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
    if (!new_table_id) return res.status(400).json({ error: 'กรุณาระบุโต๊ะปลายทาง' });

    const targetNewId = String(new_table_id).toUpperCase();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const updateResult = await client.query('UPDATE orders SET table_id = $1 WHERE UPPER(table_id) = $2', [targetNewId, oldTableId]);
        if (updateResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'ไม่พบออเดอร์ของโต๊ะต้นทางที่ต้องการย้าย' });
        }
        await client.query("UPDATE tables SET status = 'closed' WHERE table_id = $1", [oldTableId]);
        await client.query("INSERT INTO tables (table_id, status) VALUES ($1, 'active') ON CONFLICT (table_id) DO UPDATE SET status = 'active', updated_at = CURRENT_TIMESTAMP", [targetNewId]);
        await client.query('COMMIT');
        res.json({ success: true, message: `ย้ายออเดอร์สำเร็จ` });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// เช็คบิลโต๊ะ/คิว
app.delete('/api/orders/table/:tableId', async (req, res) => {
    const tableId = String(req.params.tableId).toUpperCase();
    try {
        await pool.query("UPDATE tables SET status = 'closed' WHERE table_id = $1", [tableId]);
        const ordersResult = await pool.query('SELECT id FROM orders WHERE UPPER(table_id) = $1', [tableId]);
        const orders = ordersResult.rows;
        if (orders.length > 0) {
            const orderIds = orders.map(o => o.id);
            await pool.query('DELETE FROM order_items WHERE order_id = ANY($1::int[])', [orderIds]);
            await pool.query('DELETE FROM orders WHERE UPPER(table_id) = $1', [tableId]);
        }
        res.json({ success: true });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

app.post('/api/menu', upload.single('image'), async (req, res) => {
    const { name, price, category_name, category_id, is_recommended, is_admin_menu, allow_egg, kitchen_type } = req.body;
    const image_url = req.file ? `/uploads/${req.file.filename}` : (req.body.image_url || '/uploads/menu.jpg');
    try {
        const result = await pool.query(
            `INSERT INTO menu_items (name, price, category_name, image_url, category_id, is_recommended, is_admin_menu, allow_egg, kitchen_type) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
            [name, price, category_name, image_url, category_id || 1, is_recommended || 0, is_admin_menu || 0, allow_egg || 0, kitchen_type || 'kitchen_1']
        );
        res.json({ success: true, id: result.rows[0].id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/menu/:id', upload.single('image'), async (req, res) => {
    const menuId = req.params.id;
    const { name, price, category_name, is_recommended, is_admin_menu, allow_egg, kitchen_type } = req.body;
    try {
        const recVal = is_recommended !== undefined ? is_recommended : 0;
        const adminVal = is_admin_menu !== undefined ? is_admin_menu : 0;
        const eggVal = allow_egg !== undefined ? allow_egg : 0;
        const kType = kitchen_type !== undefined ? kitchen_type : 'kitchen_1';

        let query = `UPDATE menu_items SET name = $1, price = $2, category_name = $3, is_recommended = $4, is_admin_menu = $5, allow_egg = $6, kitchen_type = $7`;
        let params = [name, price, category_name, recVal, adminVal, eggVal, kType];

        if (req.file) {
            const image_url = `/uploads/${req.file.filename}`;
            query += `, image_url = $8 WHERE id = $9`;
            params.push(image_url, menuId);
        } else {
            query += ` WHERE id = $8`;
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
        const consolidatedItems = consolidateItems(items || []);
        const result = await pool.query(
            `INSERT INTO sales_history (table_id, title, total_price, items, print_status) 
             VALUES ($1, $2, $3, $4, 'รอพิมพ์ใบเสร็จ') RETURNING id`,
            [table_id, title, total_price, JSON.stringify(consolidatedItems)]
        );
        res.status(200).json({ success: true, id: result.rows[0].id });
    } catch (err) {
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
        }
        query += ' ORDER BY checked_out_at DESC';
        const result = await pool.query(query, queryParams);
        res.status(200).json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/unprinted-receipts', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM sales_history WHERE print_status = 'รอพิมพ์ใบเสร็จ' ORDER BY checked_out_at ASC");
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/admin/receipts/:id/printed', async (req, res) => {
    const receiptId = req.params.id;
    try {
        await pool.query("UPDATE sales_history SET print_status = 'พิมพ์แล้ว' WHERE id = $1", [receiptId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/kitchen-split-orders', async (req, res) => {
    try {
        const ordersResult = await pool.query('SELECT * FROM orders WHERE status != $1 ORDER BY created_at ASC', ['เสร็จสิ้น']);
        const orders = ordersResult.rows;

        let kitchen1Items = [], kitchen2Items = [], drinkItems = [];
        let k1OrderIds = [], k2OrderIds = [], drinkOrderIds = [];

        for (const ord of orders) {
            let tableStr = String(ord.table_id);
            let locationLabel = tableStr.startsWith('Z') ? `ซุ้ม ${tableStr}` : (isNaN(tableStr) ? `คิว ${tableStr}` : `โต๊ะ ${tableStr}`);

            const itemsResult = await pool.query(`
                SELECT oi.*, COALESCE(mi.kitchen_type, 'kitchen_1') as kitchen_type 
                FROM order_items oi LEFT JOIN menu_items mi ON oi.menu_item_id = mi.id 
                WHERE oi.order_id = $1
            `, [ord.id]);

            let hasK1 = false, hasK2 = false, hasDrk = false;

            itemsResult.rows.forEach(item => {
                const kType = item.kitchen_type;
                const wrappedItem = {
                    order_id: ord.id, table_label: locationLabel, name: item.name,
                    quantity: item.quantity, price: item.price, notes: item.notes, created_at: ord.created_at
                };

                if (kType === 'drink') {
                    if (ord.printed_drink === 0) { drinkItems.push(wrappedItem); hasDrk = true; }
                } else if (kType === 'kitchen_2') {
                    if (ord.printed_kitchen_2 === 0) { kitchen2Items.push(wrappedItem); hasK2 = true; }
                } else {
                    if (ord.printed_kitchen_1 === 0) { kitchen1Items.push(wrappedItem); hasK1 = true; }
                }
            });

            if (hasK1 && ord.printed_kitchen_1 === 0) k1OrderIds.push(ord.id);
            if (hasK2 && ord.printed_kitchen_2 === 0) k2OrderIds.push(ord.id);
            if (hasDrk && ord.printed_drink === 0) drinkOrderIds.push(ord.id);
        }

        res.json({
            kitchen_main: consolidateItems(kitchen1Items),
            kitchen_forest: consolidateItems(kitchen2Items),
            drinks: consolidateItems(drinkItems),
            target_ids: { k1: k1OrderIds, k2: k2OrderIds, drk: drinkOrderIds }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/admin/kitchen-orders/:type/printed', async (req, res) => {
    const kitchenType = req.params.type; 
    const { order_ids } = req.body;
    if (!order_ids || order_ids.length === 0) return res.json({ success: true });

    let colName = 'printed_kitchen_1';
    if (kitchenType === 'k2') colName = 'printed_kitchen_2';
    if (kitchenType === 'drk') colName = 'printed_drink';

    try {
        await pool.query(`UPDATE orders SET ${colName} = 1 WHERE id = ANY($1::int[])`, [order_ids]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});