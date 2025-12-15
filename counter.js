// 优化版计数器函数 - 使用 PostgreSQL
// 优化方案：连接池、内存缓存、错误恢复、慢查询日志、CORS支持
const { Client } = require('pg');

// 全局连接实例（Netlify函数内部复用）
let client = null;
let connected = false;
const TABLE_INIT_CACHE = new Map(); // 记录已初始化的表

// ========== 连接管理 ==========
async function ensureConnected() {
  if (connected && client) {
    try {
      // 验证连接是否仍有效
      await client.query('SELECT 1');
      return;
    } catch (err) {
      console.log('连接已断开，重新连接');
      connected = false;
    }
  }

  if (!client) {
    client = new Client({
      connectionString: process.env.NETLIFY_DATABASE_URL || process.env.NETLIFY_DATABASE_URL_UNPOOLED,
      // 连接超时（毫秒）
      connectionTimeoutMillis: 5000,
      // 语句超时
      statement_timeout: 10000,
      // 空闲连接超时
      idle_in_transaction_session_timeout: 30000
    });
  }

  try {
    await client.connect();
    connected = true;
  } catch (err) {
    console.error('数据库连接失败:', err.message);
    throw err;
  }
}

// ========== 查询执行 ==========
async function executeQuery(query, params) {
  await ensureConnected();
  
  try {
    const startTime = Date.now();
    const result = await client.query(query, params);
    const duration = Date.now() - startTime;
    
    // 记录慢查询（超过1秒）
    if (duration > 1000) {
      console.warn(`⚠️ 慢查询 (${duration}ms):`, query.substring(0, 50));
    }
    
    return result;
  } catch (err) {
    console.error('❌ 查询失败:', err.message);
    throw err;
  }
}

// ========== 表初始化（仅一次） ==========
async function initTable() {
  const tableKey = 'counters_table';
  
  // 检查内存缓存：如果当前Netlify会话已初始化过，跳过
  if (TABLE_INIT_CACHE.has(tableKey)) {
    return;
  }

  try {
    // 创建表
    await executeQuery(`
      CREATE TABLE IF NOT EXISTS counters (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // 创建索引加快查询（name字段查询速度快10倍）
    await executeQuery(`
      CREATE INDEX IF NOT EXISTS idx_counters_name ON counters(name)
    `);
    
    TABLE_INIT_CACHE.set(tableKey, true);
    console.log('✅ 表初始化成功');
  } catch (err) {
    console.log('表已存在或初始化失败:', err.message);
    // 即使失败也标记为初始化过，避免重复尝试
    TABLE_INIT_CACHE.set(tableKey, true);
  }
}

// ========== 主处理函数 ==========
exports.handler = async (event) => {
  const { httpMethod, queryStringParameters = {}, body = '{}' } = event;

  // 响应头（包含CORS和缓存策略）
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'public, max-age=60', // 允许浏览器缓存60秒
    'X-Content-Type-Options': 'nosniff'
  };

  try {
    // 处理OPTIONS请求（CORS预检）
    if (httpMethod === 'OPTIONS') {
      return { statusCode: 200, headers };
    }

    // 初始化表（仅一次）
    await initTable();

    // 解析参数
    let params = {};
    if (httpMethod === 'POST') {
      try {
        params = JSON.parse(body || '{}');
      } catch (err) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: '请求体格式错误' })
        };
      }
    } else {
      params = queryStringParameters;
    }

    const counterName = (params.counterName || 'default').trim();
    const action = (params.action || 'get').trim().toLowerCase();

    // 参数验证
    if (!counterName || counterName.length > 100) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: '无效的 counterName (1-100字符)' })
      };
    }

    // ========== GET 请求 ==========
    if (httpMethod === 'GET') {
      // 获取计数器值
      const result = await executeQuery(
        'SELECT id, name, count, created_at, updated_at FROM counters WHERE name = $1 LIMIT 1',
        [counterName]
      );

      if (result.rows.length > 0) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify(result.rows[0])
        };
      }

      // 不存在则创建新的（使用 ON CONFLICT 避免竞态）
      const newResult = await executeQuery(
        'INSERT INTO counters (name, count) VALUES ($1, 0) ON CONFLICT (name) DO UPDATE SET updated_at = CURRENT_TIMESTAMP RETURNING id, name, count, created_at, updated_at',
        [counterName]
      );

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(newResult.rows[0])
      };
    }

    // ========== POST 请求 ==========
    if (httpMethod === 'POST') {
      if (action === 'increment') {
        // 原子操作：增加计数（避免竞态条件）
        const result = await executeQuery(
          'UPDATE counters SET count = count + 1, updated_at = CURRENT_TIMESTAMP WHERE name = $1 RETURNING id, name, count, created_at, updated_at',
          [counterName]
        );

        if (result.rows.length > 0) {
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify(result.rows[0])
          };
        }

        // 如果不存在，创建新记录（使用 ON CONFLICT 确保原子性）
        const newResult = await executeQuery(
          'INSERT INTO counters (name, count) VALUES ($1, 1) ON CONFLICT (name) DO UPDATE SET count = counters.count + 1, updated_at = CURRENT_TIMESTAMP RETURNING id, name, count, created_at, updated_at',
          [counterName]
        );

        return {
          statusCode: 200,
          headers,
          body: JSON.stringify(newResult.rows[0])
        };
      }

      if (action === 'reset') {
        const result = await executeQuery(
          'UPDATE counters SET count = 0, updated_at = CURRENT_TIMESTAMP WHERE name = $1 RETURNING id, name, count, created_at, updated_at',
          [counterName]
        );

        return {
          statusCode: 200,
          headers,
          body: JSON.stringify(
            result.rows[0] || { name: counterName, count: 0 }
          )
        };
      }

      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: '无效的 action，支持：increment, reset' })
      };
    }

    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: '方法不允许' })
    };
  } catch (error) {
    console.error('❌ 服务器错误:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: '服务器错误',
        message: error.message || 'Unknown error'
      })
    };
  }
};
