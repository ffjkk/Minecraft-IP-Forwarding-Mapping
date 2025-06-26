// client-web-server.js - 客户端Web管理界面服务器（优化版）
// 提供可视化的内网穿透客户端管理和监控界面

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const net = require('net');

// Web服务器配置
const WEB_PORT = 3001;                  // 客户端Web管理界面端口
const PUBLIC_SERVER_IP = '159.75.133.177';
const PUBLIC_SERVER_PORT = 9000;       // 公网服务器端口
const LOCAL_MC_SERVER = '127.0.0.1';   // 本地MC服务器地址
const LOCAL_MC_PORT = 25565;           // 本地MC服务器端口

// 连接池配置
const MIN_IDLE_CONNECTIONS = 2;        // 最少空闲连接数
const MAX_TOTAL_CONNECTIONS = 10;      // 最大总连接数
const CONNECTION_CHECK_INTERVAL = 5000; // 连接检查间隔(5秒)

// 全局状态管理
let connectionId = 0;                   // 连接ID计数器
let activeConnections = 0;              // 当前活跃连接数
let idleConnections = 0;                // 当前空闲连接数
let reconnectDelay = 2000;              // 重连延迟时间
let shouldMaintainConnection = true;    // 是否维持连接标志
const connectionHistory = [];          // 连接历史记录
const connectionStats = {
    totalConnections: 0,                // 总连接数
    successfulConnections: 0,           // 成功连接数
    failedConnections: 0,               // 失败连接数
    totalDataTransferred: 0,            // 总数据传输量
    clientStartTime: new Date(),        // 客户端启动时间
    lastActivity: new Date(),           // 最后活动时间
    reconnectAttempts: 0,               // 重连尝试次数
    currentStatus: 'stopped'            // 当前状态: stopped, connecting, connected, error
};

// 创建Express应用
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// 静态文件服务
app.use(express.static(path.join(__dirname, 'public')));

// API路由
app.get('/api/stats', (req, res) => {
    res.json({
        ...connectionStats,
        activeConnections,
        idleConnections,
        totalConnections: activeConnections + idleConnections,
        uptime: Date.now() - connectionStats.clientStartTime.getTime(),
        connectionHistory: connectionHistory.slice(-50) // 只返回最近50条记录
    });
});

// 控制API
app.post('/api/start', (req, res) => {
    if (!shouldMaintainConnection) {
        shouldMaintainConnection = true;
        connectionStats.currentStatus = 'connecting';
        startClient();
        broadcastLog('info', '客户端服务已启动');
        res.json({ success: true, message: '客户端已启动' });
    } else {
        res.json({ success: false, message: '客户端已在运行中' });
    }
});

app.post('/api/stop', (req, res) => {
    if (shouldMaintainConnection) {
        shouldMaintainConnection = false;
        connectionStats.currentStatus = 'stopped';
        broadcastLog('warning', '客户端服务已停止');
        res.json({ success: true, message: '客户端已停止' });
    } else {
        res.json({ success: false, message: '客户端未在运行' });
    }
});

app.post('/api/restart', (req, res) => {
    broadcastLog('info', '正在重启客户端服务...');
    shouldMaintainConnection = false;
    setTimeout(() => {
        shouldMaintainConnection = true;
        connectionStats.currentStatus = 'connecting';
        startClient();
        broadcastLog('success', '客户端服务重启完成');
    }, 1000);
    res.json({ success: true, message: '客户端正在重启' });
});

// 广播状态更新到所有连接的客户端
function broadcastStats() {
    io.emit('stats-update', {
        ...connectionStats,
        activeConnections,
        idleConnections,
        totalConnections: activeConnections + idleConnections,
        uptime: Date.now() - connectionStats.clientStartTime.getTime()
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

// 检查并维护连接池
function maintainConnectionPool() {
    if (!shouldMaintainConnection) return;
    
    const totalConnections = activeConnections + idleConnections;
    const needMoreConnections = idleConnections < MIN_IDLE_CONNECTIONS;
    const canCreateMore = totalConnections < MAX_TOTAL_CONNECTIONS;
    
    if (needMoreConnections && canCreateMore) {
        const connectionsToCreate = Math.min(
            MIN_IDLE_CONNECTIONS - idleConnections,
            MAX_TOTAL_CONNECTIONS - totalConnections
        );
        
        broadcastLog('info', `连接池不足，准备创建 ${connectionsToCreate} 个新连接 (当前: 活跃${activeConnections}, 空闲${idleConnections})`);
        
        for (let i = 0; i < connectionsToCreate; i++) {
            setTimeout(() => createConnection(), i * 100); // 间隔100ms创建
        }
    }
}

// 创建连接函数（优化版）
function createConnection() {
    if (!shouldMaintainConnection) return;
    
    const totalConnections = activeConnections + idleConnections;
    if (totalConnections >= MAX_TOTAL_CONNECTIONS) {
        broadcastLog('warning', `已达到最大连接数限制 (${MAX_TOTAL_CONNECTIONS})，跳过创建新连接`);
        return;
    }
    
    const connId = ++connectionId;
    connectionStats.totalConnections++;
    idleConnections++;
    
    broadcastLog('info', `创建新连接 (ID: ${connId}) - 总连接: ${totalConnections + 1}, 活跃: ${activeConnections}, 空闲: ${idleConnections}`);
    
    // 连接到公网服务器
    const proxySocket = net.connect(PUBLIC_SERVER_PORT, PUBLIC_SERVER_IP);
    
    const connectionRecord = {
        id: connId,
        startTime: new Date(),
        status: 'connecting',
        proxyConnected: false,
        mcConnected: false,
        hasClientUsed: false,
        bytesTransferred: 0,
        errors: []
    };
    
    connectionHistory.push(connectionRecord);
    
    proxySocket.on('connect', () => {
        connectionRecord.proxyConnected = true;
        connectionRecord.status = 'proxy-connected';
        
        if (connectionStats.currentStatus !== 'connected') {
            connectionStats.currentStatus = 'connected';
        }
        
        broadcastLog('success', `代理连接成功 (ID: ${connId}) - 服务器: ${PUBLIC_SERVER_IP}:${PUBLIC_SERVER_PORT}`);
        broadcastConnectionEvent('proxy-connected', { 
            id: connId, 
            activeConnections,
            idleConnections,
            serverIP: PUBLIC_SERVER_IP,
            serverPort: PUBLIC_SERVER_PORT
        });
        
        // 连接到本地MC服务器
        const mcSocket = net.connect(LOCAL_MC_PORT, LOCAL_MC_SERVER);
        
        mcSocket.on('connect', () => {
            connectionRecord.mcConnected = true;
            connectionRecord.status = 'idle-waiting';
            
            broadcastLog('success', `隧道就绪 (ID: ${connId}) - 本地: ${LOCAL_MC_SERVER}:${LOCAL_MC_PORT}`);
            broadcastConnectionEvent('tunnel-ready', { 
                id: connId,
                localServer: `${LOCAL_MC_SERVER}:${LOCAL_MC_PORT}`
            });
            
            // 建立数据转发
            let isActive = true;
            let hasClientConnected = false;
            
            const cleanup = () => {
                if (!isActive) return;
                isActive = false;
                
                // 更新连接计数
                if (hasClientConnected) {
                    activeConnections--;
                } else {
                    idleConnections--;
                }
                
                connectionRecord.status = 'closed';
                connectionRecord.endTime = new Date();
                connectionRecord.duration = connectionRecord.endTime - connectionRecord.startTime;
                
                broadcastLog('info', `连接关闭 (ID: ${connId}) - 剩余: 活跃${activeConnections}, 空闲${idleConnections}`);
                broadcastConnectionEvent('connection-closed', {
                    id: connId,
                    duration: connectionRecord.duration,
                    bytesTransferred: connectionRecord.bytesTransferred,
                    wasUsed: hasClientConnected
                });
                
                if (!proxySocket.destroyed) {
                    proxySocket.destroy();
                }
                if (!mcSocket.destroyed) {
                    mcSocket.destroy();
                }
                
                // 检查是否需要补充连接池
                setTimeout(() => {
                    maintainConnectionPool();
                }, 1000);
                
                broadcastStats();
            };
            
            // 数据转发 - 检测到数据传输时说明有客户端连接
            proxySocket.on('data', (data) => {
                if (isActive && !mcSocket.destroyed) {
                    if (!hasClientConnected) {
                        hasClientConnected = true;
                        connectionRecord.hasClientUsed = true;
                        connectionRecord.firstDataTime = new Date();
                        connectionRecord.status = 'active-forwarding';
                        
                        // 从空闲连接转为活跃连接
                        idleConnections--;
                        activeConnections++;
                        
                        broadcastLog('success', `外部客户端开始使用连接 (ID: ${connId}) - 活跃: ${activeConnections}, 空闲: ${idleConnections}`);
                        broadcastConnectionEvent('client-connected', { 
                            id: connId,
                            clientStartTime: connectionRecord.firstDataTime
                        });
                        
                        // 立即检查连接池
                        setTimeout(() => {
                            maintainConnectionPool();
                        }, 100);
                    }
                    
                    mcSocket.write(data);
                    connectionRecord.bytesTransferred += data.length;
                    connectionStats.totalDataTransferred += data.length;
                    connectionStats.lastActivity = new Date();
                }
            });
            
            mcSocket.on('data', (data) => {
                if (isActive && !proxySocket.destroyed) {
                    proxySocket.write(data);
                    connectionRecord.bytesTransferred += data.length;
                    connectionStats.totalDataTransferred += data.length;
                    connectionStats.lastActivity = new Date();
                }
            });
            
            // 错误和关闭处理
            proxySocket.on('close', cleanup);
            proxySocket.on('error', (err) => {
                connectionRecord.errors.push({
                    type: 'proxy-error',
                    error: err.code || err.message,
                    timestamp: new Date()
                });
                cleanup();
            });
            mcSocket.on('close', cleanup);
            mcSocket.on('error', (err) => {
                connectionRecord.errors.push({
                    type: 'mc-error',
                    error: err.code || err.message,
                    timestamp: new Date()
                });
                cleanup();
            });
        });
        
        mcSocket.on('error', (err) => {
            const errorMsg = `MC服务器连接失败: ${err.code || err.message}`;
            broadcastLog('error', errorMsg);
            
            connectionRecord.errors.push({
                type: 'mc-connection-error',
                error: err.code || err.message,
                timestamp: new Date()
            });
            connectionRecord.status = 'mc-connection-failed';
            connectionStats.failedConnections++;
            
            idleConnections--;
            proxySocket.destroy();
            
            // 重试
            if (shouldMaintainConnection) {
                connectionStats.reconnectAttempts++;
                setTimeout(() => {
                    maintainConnectionPool();
                }, reconnectDelay * 2);
            }
            
            broadcastStats();
        });
    });
    
    proxySocket.on('error', (err) => {
        const errorMsg = `公网服务器连接失败: ${err.code || err.message}`;
        broadcastLog('error', errorMsg);
        
        connectionRecord.errors.push({
            type: 'proxy-connection-error',
            error: err.code || err.message,
            timestamp: new Date()
        });
        connectionRecord.status = 'proxy-connection-failed';
        connectionStats.failedConnections++;
        
        idleConnections--;
        
        if (activeConnections === 0 && idleConnections === 0) {
            connectionStats.currentStatus = 'error';
        }
        
        // 重试
        if (shouldMaintainConnection) {
            connectionStats.reconnectAttempts++;
            setTimeout(() => {
                maintainConnectionPool();
            }, reconnectDelay);
        }
        
        broadcastStats();
    });
    
    broadcastStats();
}

// 启动客户端函数
function startClient() {
    broadcastLog('success', '启动内网穿透客户端（连接池模式）...');
    broadcastLog('info', `目标服务器: ${PUBLIC_SERVER_IP}:${PUBLIC_SERVER_PORT}`);
    broadcastLog('info', `本地MC服务器: ${LOCAL_MC_SERVER}:${LOCAL_MC_PORT}`);
    broadcastLog('info', `连接池配置: 最少空闲${MIN_IDLE_CONNECTIONS}个, 最大总数${MAX_TOTAL_CONNECTIONS}个`);
    broadcastLog('info', '策略：动态维护连接池，根据需求自动调整连接数量');
    
    // 初始化连接池
    maintainConnectionPool();
    
    // 定期检查连接池状态
    const checkInterval = setInterval(() => {
        if (!shouldMaintainConnection) {
            clearInterval(checkInterval);
            return;
        }
        
        maintainConnectionPool();
        
        // 定期输出状态
        const totalConnections = activeConnections + idleConnections;
        if (totalConnections > 0) {
            broadcastLog('info', `连接池状态 - 总计: ${totalConnections}, 活跃: ${activeConnections}, 空闲: ${idleConnections}`);
        } else {
            broadcastLog('warning', '连接池为空，正在重建连接...');
        }
    }, CONNECTION_CHECK_INTERVAL);
}

// 启动Web服务器
server.listen(WEB_PORT, () => {
    console.log(`\n🚀 内网穿透客户端Web管理界面已启动!`);
    console.log(`📊 客户端管理界面: http://localhost:${WEB_PORT}`);
    console.log(`🌐 目标服务器: ${PUBLIC_SERVER_IP}:${PUBLIC_SERVER_PORT}`);
    console.log(`🎮 本地MC服务器: ${LOCAL_MC_SERVER}:${LOCAL_MC_PORT}`);
    console.log(`🔗 连接池配置: 最少${MIN_IDLE_CONNECTIONS}个空闲, 最大${MAX_TOTAL_CONNECTIONS}个总连接\n`);
    
    broadcastLog('success', 'Web管理界面服务器启动成功');
    
    // 自动启动客户端
    setTimeout(() => {
        startClient();
    }, 1000);
});

// WebSocket连接处理
io.on('connection', (socket) => {
    console.log('Web客户端已连接');
    
    // 发送当前统计信息
    socket.emit('stats-update', {
        ...connectionStats,
        activeConnections,
        idleConnections,
        totalConnections: activeConnections + idleConnections,
        uptime: Date.now() - connectionStats.clientStartTime.getTime()
    });
    
    // 发送连接历史记录
    socket.emit('connection-history', connectionHistory.slice(-20));
    
    socket.on('disconnect', () => {
        console.log('Web客户端已断开');
    });
});

// 定期广播统计信息
setInterval(broadcastStats, 3000);

// 全局异常处理
process.on('uncaughtException', (err) => {
    broadcastLog('error', `捕获到未处理异常: ${err.message}`, { stack: err.stack });
});

process.on('SIGINT', () => {
    broadcastLog('warning', '接收到终止信号，正在优雅关闭客户端...');
    shouldMaintainConnection = false;
    connectionStats.currentStatus = 'stopped';
    
    setTimeout(() => {
        broadcastLog('info', '客户端已完全关闭');
        process.exit(0);
    }, 1000);
});