// web-server.js - Web管理界面服务器
// 提供可视化的代理服务器管理和监控界面

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const net = require('net');

// Web服务器配置
const WEB_PORT = 3000;              // Web管理界面端口
const EXTERNAL_PORT = 25565;       // 外部用户连接的端口
const LOCAL_PROXY_PORT = 9000;     // 内网客户端连接的端口

// 全局状态管理
let connectionId = 0;
const waitingQueue = [];
const idleLocalSockets = [];
const activeConnections = new Map();
const connectionStats = {
    totalConnections: 0,
    activeConnections: 0,
    totalDataTransferred: 0,
    serverStartTime: new Date(),
    lastActivity: new Date()
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
        waitingQueueLength: waitingQueue.length,
        idleConnectionsCount: idleLocalSockets.length,
        activeConnectionsCount: activeConnections.size,
        uptime: Date.now() - connectionStats.serverStartTime.getTime()
    });
});

// 广播状态更新到所有连接的客户端
function broadcastStats() {
    io.emit('stats-update', {
        ...connectionStats,
        waitingQueueLength: waitingQueue.length,
        idleConnectionsCount: idleLocalSockets.length,
        activeConnectionsCount: activeConnections.size,
        uptime: Date.now() - connectionStats.serverStartTime.getTime()
    });
}

// 广播连接事件
function broadcastConnectionEvent(event, data) {
    io.emit('connection-event', { event, data, timestamp: new Date() });
}

// 广播日志消息
function broadcastLog(level, message, data = {}) {
    io.emit('log-message', { level, message, data, timestamp: new Date() });
}

// 连接匹配函数（带Web界面更新）
function tryMatchConnections() {
    while (waitingQueue.length > 0 && idleLocalSockets.length > 0) {
        const connectionInfo = waitingQueue.shift();
        const externalSocket = connectionInfo.socket;
        const connId = connectionInfo.id;
        
        const localSocket = idleLocalSockets.shift();
        
        if (externalSocket.destroyed) {
            broadcastLog('warning', `代理${connId}的外部连接已断开，尝试下一个连接`);
            continue;
        }
        
        if (localSocket.destroyed) {
            broadcastLog('warning', '内网连接已断开，尝试下一个连接');
            continue;
        }
        
        establishConnection(externalSocket, localSocket, connId);
    }
    broadcastStats();
}

// 建立连接函数（带Web界面更新）
function establishConnection(externalSocket, localSocket, connId) {
    broadcastLog('success', `代理${connId}建立连接映射`, {
        connId,
        externalIP: externalSocket.remoteAddress,
        localIP: localSocket.remoteAddress,
        queueRemaining: waitingQueue.length,
        idleConnections: idleLocalSockets.length
    });
    
    // 记录活跃连接
    const connectionData = {
        id: connId,
        externalIP: externalSocket.remoteAddress,
        localIP: localSocket.remoteAddress,
        startTime: new Date(),
        bytesTransferred: 0
    };
    activeConnections.set(connId, connectionData);
    connectionStats.activeConnections++;
    
    broadcastConnectionEvent('established', connectionData);
    
    let isConnectionActive = true;
    
    const createDataForwarder = (sourceSocket, targetSocket, direction) => {
        return (data) => {
            if (isConnectionActive && !targetSocket.destroyed) {
                targetSocket.write(data);
                
                // 更新数据传输统计
                const connection = activeConnections.get(connId);
                if (connection) {
                    connection.bytesTransferred += data.length;
                    connectionStats.totalDataTransferred += data.length;
                    connectionStats.lastActivity = new Date();
                }
            }
        };
    };
    
    const forwardExternalToLocal = createDataForwarder(externalSocket, localSocket, '外部→内网');
    const forwardLocalToExternal = createDataForwarder(localSocket, externalSocket, '内网→外部');
    
    externalSocket.on('data', forwardExternalToLocal);
    localSocket.on('data', forwardLocalToExternal);
    
    const cleanupConnection = () => {
        if (!isConnectionActive) return;
        isConnectionActive = false;
        
        broadcastLog('info', `代理${connId}连接结束，开始清理资源`);
        
        // 更新统计信息
        const connection = activeConnections.get(connId);
        if (connection) {
            connectionStats.activeConnections--;
            broadcastConnectionEvent('closed', {
                ...connection,
                endTime: new Date(),
                duration: Date.now() - connection.startTime.getTime()
            });
            activeConnections.delete(connId);
        }
        
        externalSocket.removeListener('data', forwardExternalToLocal);
        localSocket.removeListener('data', forwardLocalToExternal);
        
        if (!externalSocket.destroyed) {
            externalSocket.destroy();
        }
        if (!localSocket.destroyed) {
            localSocket.destroy();
        }
        
        broadcastStats();
    };
    
    externalSocket.on('close', () => {
        broadcastLog('info', `外部用户${connId}连接已关闭`);
        cleanupConnection();
    });
    
    externalSocket.on('error', (err) => {
        broadcastLog('error', `外部用户${connId}连接发生错误: ${err.code || err.message}`);
        cleanupConnection();
    });
    
    localSocket.on('close', () => {
        broadcastLog('info', `内网客户端${connId}连接已关闭`);
        cleanupConnection();
    });
    
    localSocket.on('error', (err) => {
        broadcastLog('error', `内网客户端${connId}连接发生错误: ${err.code || err.message}`);
        cleanupConnection();
    });
    
    broadcastStats();
}

// 创建外部用户连接服务器
const externalServer = net.createServer((externalSocket) => {
    const connId = ++connectionId;
    connectionStats.totalConnections++;
    
    broadcastLog('info', `外部用户${connId}连接建立: ${externalSocket.remoteAddress}`);
    
    const connectionInfo = {
        id: connId,
        socket: externalSocket,
        timestamp: Date.now()
    };
    
    waitingQueue.push(connectionInfo);
    broadcastLog('info', `外部连接${connId}加入等待队列，当前队列长度: ${waitingQueue.length}`);
    
    tryMatchConnections();
    
    const timeout = setTimeout(() => {
        const index = waitingQueue.findIndex(conn => conn.id === connId);
        if (index !== -1) {
            waitingQueue.splice(index, 1);
            broadcastLog('warning', `外部用户${connId}等待超时(60s)，连接被关闭`);
            if (!externalSocket.destroyed) {
                externalSocket.end();
            }
        }
    }, 60000);
    
    externalSocket.on('close', () => {
        clearTimeout(timeout);
        const index = waitingQueue.findIndex(conn => conn.id === connId);
        if (index !== -1) {
            waitingQueue.splice(index, 1);
            broadcastLog('info', `外部用户${connId}主动断开，已从队列移除`);
        }
        broadcastStats();
    });
    
    externalSocket.on('error', (err) => {
        clearTimeout(timeout);
        const index = waitingQueue.findIndex(conn => conn.id === connId);
        if (index !== -1) {
            waitingQueue.splice(index, 1);
            broadcastLog('error', `外部用户${connId}发生错误: ${err.code || err.message}`);
        }
        broadcastStats();
    });
});

// 创建内网客户端连接服务器
const localProxyServer = net.createServer((localSocket) => {
    broadcastLog('success', `内网客户端新连接建立: ${localSocket.remoteAddress}`);
    
    idleLocalSockets.push(localSocket);
    broadcastLog('info', `内网连接加入空闲池，当前空闲连接数: ${idleLocalSockets.length}`);
    
    const onLocalClose = () => {
        const index = idleLocalSockets.indexOf(localSocket);
        if (index !== -1) {
            idleLocalSockets.splice(index, 1);
            broadcastLog('info', `内网空闲连接已关闭，从连接池移除，剩余: ${idleLocalSockets.length}`);
        }
        broadcastStats();
    };
    
    const onLocalError = (err) => {
        const index = idleLocalSockets.indexOf(localSocket);
        if (index !== -1) {
            idleLocalSockets.splice(index, 1);
            broadcastLog('error', `内网空闲连接发生错误: ${err.code || err.message}，从连接池移除`);
        }
        broadcastStats();
    };
    
    localSocket.on('close', onLocalClose);
    localSocket.on('error', onLocalError);
    
    tryMatchConnections();
});

// 启动代理服务器
localProxyServer.listen(LOCAL_PROXY_PORT, () => {
    broadcastLog('success', `内网代理服务器已启动，监听端口: ${LOCAL_PROXY_PORT}`);
});

externalServer.listen(EXTERNAL_PORT, () => {
    broadcastLog('success', `外部访问服务器已启动，监听端口: ${EXTERNAL_PORT}`);
});

// 启动Web服务器
server.listen(WEB_PORT, () => {
    console.log(`\n🚀 代理服务器Web管理界面已启动!`);
    console.log(`📊 管理界面: http://localhost:${WEB_PORT}`);
    console.log(`🌐 外部访问端口: ${EXTERNAL_PORT}`);
    console.log(`🔗 内网代理端口: ${LOCAL_PROXY_PORT}\n`);
    
    broadcastLog('success', 'Web管理界面服务器启动成功');
});

// WebSocket连接处理
io.on('connection', (socket) => {
    console.log('Web客户端已连接');
    
    // 发送当前统计信息
    socket.emit('stats-update', {
        ...connectionStats,
        waitingQueueLength: waitingQueue.length,
        idleConnectionsCount: idleLocalSockets.length,
        activeConnectionsCount: activeConnections.size,
        uptime: Date.now() - connectionStats.serverStartTime.getTime()
    });
    
    // 发送当前活跃连接列表
    socket.emit('active-connections', Array.from(activeConnections.values()));
    
    socket.on('disconnect', () => {
        console.log('Web客户端已断开');
    });
});

// 定期广播统计信息
setInterval(broadcastStats, 5000);

// 全局异常处理
process.on('uncaughtException', (err) => {
    broadcastLog('error', `捕获到未处理异常: ${err.message}`, { stack: err.stack });
});

process.on('SIGINT', () => {
    broadcastLog('warning', '接收到终止信号，正在优雅关闭服务器...');
    
    if (localProxyServer) {
        localProxyServer.close(() => {
            broadcastLog('info', '内网代理服务器已关闭');
        });
    }
    
    if (externalServer) {
        externalServer.close(() => {
            broadcastLog('info', '外部访问服务器已关闭');
        });
    }
    
    waitingQueue.forEach((connectionInfo) => {
        if (!connectionInfo.socket.destroyed) {
            connectionInfo.socket.destroy();
        }
    });
    
    idleLocalSockets.forEach((localSocket) => {
        if (!localSocket.destroyed) {
            localSocket.destroy();
        }
    });
    
    broadcastLog('info', '服务器已完全关闭');
    process.exit(0);
});
