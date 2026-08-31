require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  try {
    await pool.query('ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_reason_ck;');
    console.log('Successfully dropped old constraint');
  } catch (err) {
    console.error('Error dropping constraint', err);
  } finally {
    await pool.end();
  }
}
run();
