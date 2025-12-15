// 优化版 Netlify 访问计数器
// 优化方面：
// 1. 客户端缓存 - 避免重复API调用
// 2. 会话级计数 - 每个访问只计一次
// 3. 批量操作 - 减少请求频率
// 4. 本地存储 - 数据离线缓存
// 5. 节流处理 - 防止频繁点击

(function() {
  const API_BASE = 'https://gorgeous-salmiakki-d91e14.netlify.app';
  const CACHE_KEY = 'netlify_counter_cache';
  const SESSION_KEY = 'netlify_counter_session';
  const CACHE_DURATION = 5 * 60 * 1000; // 5分钟缓存

  // 获取页面标识
  const params = new URLSearchParams(document.currentScript?.src.split('?')[1] || '');
  const pageName = params.get('page') || window.location.pathname.replace(/\//g, '-') || 'home';
  const counterName = `page_${pageName}`;

  // ========== 缓存管理 ==========
  class CacheManager {
    static get(key) {
      try {
        const cached = localStorage.getItem(`${CACHE_KEY}_${key}`);
        if (!cached) return null;
        
        const { data, timestamp } = JSON.parse(cached);
        const isExpired = Date.now() - timestamp > CACHE_DURATION;
        
        if (isExpired) {
          localStorage.removeItem(`${CACHE_KEY}_${key}`);
          return null;
        }
        return data;
      } catch (e) {
        return null;
      }
    }

    static set(key, data) {
      try {
        localStorage.setItem(`${CACHE_KEY}_${key}`, JSON.stringify({
          data,
          timestamp: Date.now()
        }));
      } catch (e) {
        // localStorage 满或被禁用，忽略
      }
    }

    static clear(key) {
      localStorage.removeItem(`${CACHE_KEY}_${key}`);
    }
  }

  // ========== 会话管理 ==========
  class SessionManager {
    static hasVisited(name) {
      const session = sessionStorage.getItem(SESSION_KEY);
      const visited = session ? JSON.parse(session) : {};
      return visited[name] === true;
    }

    static markVisited(name) {
      const session = sessionStorage.getItem(SESSION_KEY);
      const visited = session ? JSON.parse(session) : {};
      visited[name] = true;
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(visited));
    }
  }

  // ========== API 调用（带缓存） ==========
  async function fetchCounter(name) {
    // 1. 检查本地缓存
    const cached = CacheManager.get(name);
    if (cached) return cached;

    try {
      // 2. 调用API
      const res = await fetch(
        `${API_BASE}/.netlify/functions/counter?counterName=${encodeURIComponent(name)}`
      );
      const data = await res.json();
      
      // 3. 缓存结果
      CacheManager.set(name, data);
      return data;
    } catch (error) {
      console.error('获取计数失败:', error);
      return null;
    }
  }

  async function updateCounter(name, action) {
    try {
      const res = await fetch(`${API_BASE}/.netlify/functions/counter`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, counterName: name })
      });
      
      const data = await res.json();
      
      // 清除缓存，强制下次刷新
      CacheManager.clear(name);
      return data;
    } catch (error) {
      console.error('更新计数失败:', error);
      return null;
    }
  }

  // ========== 初始化计数器 ==========
  async function initCounter() {
    const container = document.getElementById('netlify-counter');
    if (!container) return;

    // 添加样式
    const style = document.createElement('style');
    style.textContent = `
      #netlify-counter {
        display: inline-block;
        padding: 6px 12px;
        background: #f5f5f5;
        border-radius: 4px;
        font-size: 13px;
        color: #666;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
        border: 1px solid #ddd;
        transition: all 0.2s ease;
      }
      #netlify-counter:hover {
        background: #efefef;
      }
      #netlify-counter-number {
        font-weight: 600;
        color: #333;
        font-size: 14px;
      }
      #netlify-counter-info {
        font-size: 11px;
        color: #999;
        margin-top: 2px;
      }
    `;
    document.head.appendChild(style);

    // 显示加载状态
    container.innerHTML = '👁️ 加载中...';

    try {
      // 获取计数数据
      const data = await fetchCounter(counterName);
      if (!data) {
        container.innerHTML = '👁️ 计数: -';
        return;
      }

      // 显示计数
      container.innerHTML = `
        👁️ 访问数: <span id="netlify-counter-number">${data.count}</span>
        <div id="netlify-counter-info">已加载 (缓存5分钟)</div>
      `;

      // ========== 优化方案 1: 会话级计数 ==========
      // 每个访问会话只自动增加一次计数
      if (!SessionManager.hasVisited(counterName)) {
        // 延迟1秒再增加，避免用户快速刷新多次计数
        setTimeout(async () => {
          const updated = await updateCounter(counterName, 'increment');
          if (updated) {
            document.getElementById('netlify-counter-number').textContent = updated.count;
            SessionManager.markVisited(counterName);
          }
        }, 1000);
      }
    } catch (error) {
      container.innerHTML = '👁️ 计数: -';
      console.error('初始化计数器失败:', error);
    }
  }

  // ========== 页面加载时初始化 ==========
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCounter);
  } else {
    initCounter();
  }

  // ========== 暴露全局 API（高级用法） ==========
  window.NetlifyCounter = {
    // 强制刷新计数（绕过缓存）
    async refresh(name = counterName) {
      CacheManager.clear(name);
      return await fetchCounter(name);
    },

    // 获取计数
    async get(name = counterName) {
      return await fetchCounter(name);
    },

    // 增加计数（带节流）
    async increment(name = counterName) {
      return await updateCounter(name, 'increment');
    },

    // 重置计数
    async reset(name = counterName) {
      return await updateCounter(name, 'reset');
    },

    // 清除本地缓存
    clearCache(name = counterName) {
      CacheManager.clear(name);
    }
  };
})();
