// client-web-server.js - 客户端Web管理界面服务器（多端口优化版）
// 提供可视化的内网穿透客户端管理和监控界面

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const net = require('net');
const fs = require('fs');

// 配置文件管理  
const CONFIG_FILE = path.join(__dirname, 'config.json');

// 加载配置
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const data = fs.readFileSync(CONFIG_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.log('加载配置文件失败，使用默认配置');
    }
    
    // 默认配置
    return {
        server: {
            host: "159.75.133.177",
            port: 9000,
            webPort: 3001
        },
        portMappings: [
            {
                id: "minecraft",
                name: "Minecraft服务器",
                localHost: "127.0.0.1",
                localPort: 25565,
                publicPort: null,
                preferredPort: 25565,
                enabled: true,
                description: "我的世界服务器",
                autoReconnect: true
            }
        ],
        connection: {
            minIdleConnections: 1,
            maxTotalConnections: 100,
            checkInterval: 5000,
            reconnectDelay: 2000
        }
    };
}

// 保存配置
function saveConfig(config) {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        return true;
    } catch (error) {
        console.error('保存配置失败:', error);
        return false;
    }
}

// 加载配置
let config = loadConfig();

// Web服务器配置
const WEB_PORT = config.server.webPort;
const PUBLIC_SERVER_IP = config.server.host;
const PUBLIC_SERVER_PORT = config.server.port;

// 连接池配置
const MIN_IDLE_CONNECTIONS = config.connection.minIdleConnections;
const MAX_TOTAL_CONNECTIONS = config.connection.maxTotalConnections;
const CONNECTION_CHECK_INTERVAL = config.connection.checkInterval;

// 全局状态管理
let connectionId = 0;
const activeMappings = new Map(); // mappingId -> mapping info
const connectionPools = new Map(); // mappingId -> { activeConnections, idleConnections, reconnectDelay }
let shouldMaintainConnection = true;
const connectionHistory = [];

// 统计信息
const connectionStats = {
    totalConnections: 0,
    successfulConnections: 0,
    failedConnections: 0,
    totalDataTransferred: 0,
    clientStartTime: new Date(),
    lastActivity: new Date(),
    reconnectAttempts: 0,
    currentStatus: 'stopped',
    activeMappings: 0,
    totalMappings: 0
};

// 创建Express应用
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// 中间件
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API路由
app.get('/api/stats', (req, res) => {
    const totalActiveConnections = Array.from(connectionPools.values())
        .reduce((sum, pool) => sum + pool.activeConnections, 0);
    const totalIdleConnections = Array.from(connectionPools.values())
        .reduce((sum, pool) => sum + pool.idleConnections, 0);
    
    res.json({
        ...connectionStats,
        activeConnections: totalActiveConnections,
        idleConnections: totalIdleConnections,
        totalConnections: totalActiveConnections + totalIdleConnections,
        uptime: Date.now() - connectionStats.clientStartTime.getTime(),
        connectionHistory: connectionHistory.slice(-50),
        activeMappings: activeMappings.size,
        totalMappings: config.portMappings.length
    });
});

// 配置管理API
app.get('/api/config', (req, res) => {
    res.json(config);
});

app.post('/api/config', (req, res) => {
    try {
        config = { ...config, ...req.body };
        if (saveConfig(config)) {
            broadcastLog('success', '配置已更新');
            res.json({ success: true, message: '配置保存成功' });
        } else {
            res.status(500).json({ success: false, message: '配置保存失败' });
        }
    } catch (error) {
        res.status(400).json({ success: false, message: '配置格式错误' });
    }
});

// 端口映射管理API
app.get('/api/mappings', (req, res) => {
    const mappings = config.portMappings.map(mapping => ({
        ...mapping,
        active: activeMappings.has(mapping.id),
        connections: connectionPools.has(mapping.id) ? 
            connectionPools.get(mapping.id).activeConnections + connectionPools.get(mapping.id).idleConnections : 0
    }));
    res.json(mappings);
});

app.post('/api/mappings', (req, res) => {
    try {
        const { name, localHost, localPort, preferredPort, description, enabled = true, autoReconnect = true } = req.body;
        
        if (!name || !localHost || !localPort) {
            return res.status(400).json({ success: false, message: '缺少必要参数' });
        }
        
        const newMapping = {
            id: Date.now().toString(),
            name,
            localHost,
            localPort: parseInt(localPort),
            publicPort: null,
            preferredPort: preferredPort ? parseInt(preferredPort) : null,
            enabled,
            description: description || '',
            autoReconnect
        };
        
        config.portMappings.push(newMapping);
        
        if (saveConfig(config)) {
            broadcastLog('success', `端口映射已添加: ${name}`);
            res.json({ success: true, mapping: newMapping });
        } else {
            res.status(500).json({ success: false, message: '保存配置失败' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/mappings/:id', (req, res) => {
    try {
        const mappingId = req.params.id;
        const mappingIndex = config.portMappings.findIndex(m => m.id === mappingId);
        
        if (mappingIndex === -1) {
            return res.status(404).json({ success: false, message: '映射不存在' });
        }
        
        config.portMappings[mappingIndex] = { ...config.portMappings[mappingIndex], ...req.body };
        
        if (saveConfig(config)) {
            broadcastLog('success', `端口映射已更新: ${config.portMappings[mappingIndex].name}`);
            res.json({ success: true, mapping: config.portMappings[mappingIndex] });
        } else {
            res.status(500).json({ success: false, message: '保存配置失败' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/mappings/:id', (req, res) => {
    try {
        const mappingId = req.params.id;
        const mappingIndex = config.portMappings.findIndex(m => m.id === mappingId);
        
        if (mappingIndex === -1) {
            return res.status(404).json({ success: false, message: '映射不存在' });
        }
        
        const mapping = config.portMappings[mappingIndex];
        
        // 如果映射正在运行，先停止它
        if (activeMappings.has(mappingId)) {
            stopMapping(mappingId);
        }
        
        config.portMappings.splice(mappingIndex, 1);
        
        if (saveConfig(config)) {
            broadcastLog('success', `端口映射已删除: ${mapping.name}`);
            res.json({ success: true, message: '映射已删除' });
        } else {
            res.status(500).json({ success: false, message: '保存配置失败' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/mappings/:id/start', (req, res) => {
    const mappingId = req.params.id;
    const mapping = config.portMappings.find(m => m.id === mappingId);
    
    if (!mapping) {
        return res.status(404).json({ success: false, message: '映射不存在' });
    }
    
    if (activeMappings.has(mappingId)) {
        return res.status(400).json({ success: false, message: '映射已在运行中' });
    }
    
    startMapping(mapping)
        .then(() => {
            res.json({ success: true, message: `映射 ${mapping.name} 已启动` });
        })
        .catch(error => {
            res.status(500).json({ success: false, message: error.message });
        });
});

app.post('/api/mappings/:id/stop', (req, res) => {
    const mappingId = req.params.id;
    const mapping = config.portMappings.find(m => m.id === mappingId);
    
    if (!mapping) {
        return res.status(404).json({ success: false, message: '映射不存在' });
    }
    
    if (!activeMappings.has(mappingId)) {
        return res.status(400).json({ success: false, message: '映射未在运行' });
    }
    
    stopMapping(mappingId);
    res.json({ success: true, message: `映射 ${mapping.name} 已停止` });
});

// 控制API
app.post('/api/start', (req, res) => {
    if (!shouldMaintainConnection) {
        shouldMaintainConnection = true;
        startAllMappings();
        connectionStats.currentStatus = 'running';
        res.json({ success: true, message: '客户端已启动' });
    } else {
        res.json({ success: true, message: '客户端已在运行中' });
    }
});

app.post('/api/stop', (req, res) => {
    if (shouldMaintainConnection) {
        shouldMaintainConnection = false;
        stopAllMappings();
        connectionStats.currentStatus = 'stopped';
        res.json({ success: true, message: '客户端已停止' });
    } else {
        res.json({ success: true, message: '客户端已处于停止状态' });
    }
});

app.post('/api/restart', (req, res) => {
    broadcastLog('info', '正在重启客户端服务...');
    shouldMaintainConnection = false;
    stopAllMappings();
    setTimeout(() => {
        shouldMaintainConnection = true;
        startAllMappings();
        connectionStats.currentStatus = 'running';
        broadcastLog('success', '客户端服务重启完成');
    }, 1000);
    res.json({ success: true, message: '客户端正在重启' });
});

// 启动所有映射
function startAllMappings() {
    config.portMappings.forEach(mapping => {
        if (mapping.enabled) {
            startMapping(mapping).catch(error => {
                broadcastLog('error', `启动映射失败: ${mapping.name} - ${error.message}`);
            });
        }
    });
}

// 停止所有映射
function stopAllMappings() {
    activeMappings.forEach((_, mappingId) => {
        stopMapping(mappingId);
    });
}

// 启动单个映射
async function startMapping(mapping) {
    if (activeMappings.has(mapping.id)) {
        broadcastLog('warning', `映射 ${mapping.name} 已经在运行`);
        return;
    }
    
    try {
        // 请求端口分配
        const publicPort = await requestPortAllocation(mapping);
        mapping.publicPort = publicPort;
        
        // 保存更新后的配置
        const mappingIndex = config.portMappings.findIndex(m => m.id === mapping.id);
        if (mappingIndex !== -1) {
            config.portMappings[mappingIndex].publicPort = publicPort;
            saveConfig(config);
        }
        
        // 启动连接池
        connectionPools.set(mapping.id, {
            activeConnections: 0,
            idleConnections: 0,
            reconnectDelay: config.connection.reconnectDelay
        });
        
        activeMappings.set(mapping.id, {
            ...mapping,
            startTime: new Date()
        });
        
        connectionStats.activeMappings = activeMappings.size;
        
        // 开始维护此映射的连接
        maintainMappingConnections(mapping);
        
        broadcastLog('success', `映射 ${mapping.name} 启动成功: ${mapping.localHost}:${mapping.localPort} -> 公网:${publicPort}`);
        
    } catch (error) {
        broadcastLog('error', `启动映射 ${mapping.name} 失败: ${error.message}`);
        throw error;
    }
}

// 停止单个映射
function stopMapping(mappingId) {
    const mapping = activeMappings.get(mappingId);
    if (!mapping) return;
    
    activeMappings.delete(mappingId);
    connectionPools.delete(mappingId);
    connectionStats.activeMappings = activeMappings.size;
    
    broadcastLog('info', `映射 ${mapping.name} 已停止`);
}

// 请求端口分配
async function requestPortAllocation(mapping) {
    try {
        const serverWebPort = 3000; // 服务端Web端口，可以从配置获取
        
        // 使用 http 模块替代 fetch
        const requestData = JSON.stringify({
            localPort: mapping.localPort,
            preferredPort: mapping.preferredPort
        });
        
        return new Promise((resolve, reject) => {
            const options = {
                hostname: PUBLIC_SERVER_IP,
                port: serverWebPort,
                path: '/api/ports/allocate',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(requestData)
                }
            };
            
            const req = http.request(options, (res) => {
                let data = '';
                
                res.on('data', (chunk) => {
                    data += chunk;
                });
                
                res.on('end', () => {
                    try {
                        const result = JSON.parse(data);
                        if (res.statusCode === 200 && result.success) {
                            broadcastLog('success', `端口分配成功: ${mapping.localPort} -> ${result.publicPort}`);
                            resolve(result.publicPort);
                        } else {
                            broadcastLog('error', `端口分配失败: ${result.message}`);
                            reject(new Error(result.message));
                        }
                    } catch (error) {
                        broadcastLog('error', `解析服务器响应失败: ${error.message}`);
                        reject(error);
                    }
                });
            });
            
            req.on('error', (error) => {
                broadcastLog('error', `连接服务器失败: ${error.message}`);
                reject(error);
            });
            
            req.write(requestData);
            req.end();
        });
    } catch (error) {
        broadcastLog('error', `请求端口分配失败: ${error.message}`);
        throw error;
    }
}

// 维护映射连接
function maintainMappingConnections(mapping) {
    const pool = connectionPools.get(mapping.id);
    if (!pool || !shouldMaintainConnection || !activeMappings.has(mapping.id)) {
        return;
    }
    
    // 检查是否需要更多连接
    if (pool.idleConnections < MIN_IDLE_CONNECTIONS) {
        createMappingConnection(mapping);
    }
    
    // 设置下次检查
    setTimeout(() => maintainMappingConnections(mapping), CONNECTION_CHECK_INTERVAL);
}

// 创建映射连接
function createMappingConnection(mapping) {
    if (!shouldMaintainConnection || !activeMappings.has(mapping.id)) {
        return;
    }
    
    const pool = connectionPools.get(mapping.id);
    if (!pool) return;
    
    const totalConnections = pool.activeConnections + pool.idleConnections;
    if (totalConnections >= MAX_TOTAL_CONNECTIONS) {
        return;
    }
    
    const connId = ++connectionId;
    connectionStats.totalConnections++;
    pool.idleConnections++;
    
    broadcastLog('info', `为映射 ${mapping.name} 创建新连接 (ID: ${connId})`);
    
    // 连接到公网服务器
    const proxySocket = net.connect(PUBLIC_SERVER_PORT, PUBLIC_SERVER_IP);
    
    const connectionRecord = {
        id: connId,
        mappingId: mapping.id,
        startTime: new Date(),
        status: 'connecting',
        proxyConnected: false,
        localConnected: false,
        bytesTransferred: 0,
        errors: []
    };
    
    connectionHistory.push(connectionRecord);
    
    proxySocket.on('connect', () => {
        broadcastLog('success', `连接 ${connId} 已连接到代理服务器`);
        connectionRecord.proxyConnected = true;
        connectionRecord.status = 'connected';
        connectionStats.successfulConnections++;
        connectionStats.lastActivity = new Date();
        
        // 发送端口映射信息
        const header = Buffer.alloc(4);
        header.writeUInt32BE(mapping.publicPort, 0);
        proxySocket.write(header);
        
        // 等待外部连接数据
        proxySocket.on('data', (data) => {
            if (!connectionRecord.localConnected) {
                // 建立到本地服务的连接
                const localSocket = net.connect(mapping.localPort, mapping.localHost);
                connectionRecord.localConnected = true;
                pool.idleConnections--;
                pool.activeConnections++;
                
                localSocket.on('connect', () => {
                    broadcastLog('success', `连接 ${connId} 已连接到本地服务 ${mapping.localHost}:${mapping.localPort}`);
                    
                    // 转发首次接收到的数据
                    localSocket.write(data);
                    
                    const forwardData = (source, target, direction) => {
                        return (data) => {
                            if (!target.destroyed) {
                                target.write(data);
                                connectionRecord.bytesTransferred += data.length;
                                connectionStats.totalDataTransferred += data.length;
                                connectionStats.lastActivity = new Date();
                            }
                        };
                    };
                    
                    // 建立双向数据转发
                    const forwardProxyToLocal = forwardData(proxySocket, localSocket, 'proxy->local');
                    const forwardLocalToProxy = forwardData(localSocket, proxySocket, 'local->proxy');
                    
                    proxySocket.on('data', forwardProxyToLocal);
                    localSocket.on('data', forwardLocalToProxy);
                    
                    const cleanup = () => {
                        if (pool.activeConnections > 0) {
                            pool.activeConnections--;
                        }
                        connectionRecord.status = 'closed';
                        
                        // 移除事件监听器
                        proxySocket.removeListener('data', forwardProxyToLocal);
                        localSocket.removeListener('data', forwardLocalToProxy);
                        
                        // 关闭连接
                        if (!proxySocket.destroyed) proxySocket.destroy();
                        if (!localSocket.destroyed) localSocket.destroy();
                        
                        broadcastLog('info', `连接 ${connId} 已关闭`);
                        
                        // 创建新的空闲连接来替代
                        if (shouldMaintainConnection && activeMappings.has(mapping.id)) {
                            setTimeout(() => createMappingConnection(mapping), 1000);
                        }
                    };
                    
                    proxySocket.on('close', cleanup);
                    proxySocket.on('error', cleanup);
                    localSocket.on('close', cleanup);
                    localSocket.on('error', cleanup);
                });
                
                localSocket.on('error', (err) => {
                    broadcastLog('error', `连接 ${connId} 本地连接失败: ${err.message}`);
                    connectionRecord.errors.push(err.message);
                    pool.idleConnections--;
                    if (!proxySocket.destroyed) proxySocket.destroy();
                    
                    // 重试连接
                    setTimeout(() => {
                        if (shouldMaintainConnection && activeMappings.has(mapping.id)) {
                            connectionStats.reconnectAttempts++;
                            createMappingConnection(mapping);
                        }
                    }, pool.reconnectDelay);
                });
            }
        });
    });
    
    proxySocket.on('error', (err) => {
        broadcastLog('error', `连接 ${connId} 代理连接失败: ${err.message}`);
        connectionRecord.errors.push(err.message);
        connectionRecord.status = 'failed';
        connectionStats.failedConnections++;
        
        if (pool.idleConnections > 0) {
            pool.idleConnections--;
        }
        
        // 重连延迟
        setTimeout(() => {
            if (shouldMaintainConnection && activeMappings.has(mapping.id)) {
                connectionStats.reconnectAttempts++;
                createMappingConnection(mapping);
            }
        }, pool.reconnectDelay);
    });
    
    broadcastStats();
}

// 广播状态更新到所有连接的客户端
function broadcastStats() {
    const totalActiveConnections = Array.from(connectionPools.values())
        .reduce((sum, pool) => sum + pool.activeConnections, 0);
    const totalIdleConnections = Array.from(connectionPools.values())
        .reduce((sum, pool) => sum + pool.idleConnections, 0);
    
    io.emit('stats-update', {
        ...connectionStats,
        activeConnections: totalActiveConnections,
        idleConnections: totalIdleConnections,
        totalConnections: totalActiveConnections + totalIdleConnections,
        uptime: Date.now() - connectionStats.clientStartTime.getTime(),
        activeMappings: activeMappings.size
    });
}

// 广播连接事件
function broadcastConnectionEvent(event, data) {
    io.emit('connection-event', { event, data, timestamp: new Date() });
}

// 广播日志消息
function broadcastLog(level, message, data = {}) {
    const logEntry = { level, message, data, timestamp: new Date() };
    io.emit('log-message', logEntry);
    
    // 同时在服务器控制台输出
    const timeStr = logEntry.timestamp.toLocaleTimeString();
    console.log(`[${timeStr}] [${level.toUpperCase()}] ${message}`);
}

// 启动Web服务器
server.listen(WEB_PORT, () => {
    console.log(`客户端Web管理界面启动成功，访问地址: http://localhost:${WEB_PORT}`);
    broadcastLog('success', `客户端Web管理界面启动成功，端口: ${WEB_PORT}`);
    
    // 自动启动已启用的映射
    setTimeout(() => {
        broadcastLog('info', '开始自动启动已配置的端口映射...');
        startAllMappings();
    }, 2000);
});

// WebSocket连接处理
io.on('connection', (socket) => {
    console.log('新的WebSocket连接已建立');
    
    // 发送当前状态
    socket.emit('stats-update', {
        ...connectionStats,
        uptime: Date.now() - connectionStats.clientStartTime.getTime()
    });
    
    socket.on('disconnect', () => {
        console.log('WebSocket连接已断开');
    });
});

// 定期广播统计信息
setInterval(broadcastStats, 3000);

// 全局异常处理
process.on('uncaughtException', (err) => {
    console.error('未捕获的异常:', err);
    broadcastLog('error', `系统异常: ${err.message}`);
});

process.on('SIGINT', () => {
    console.log('\n正在关闭客户端服务...');
    shouldMaintainConnection = false;
    stopAllMappings();
    process.exit(0);
});