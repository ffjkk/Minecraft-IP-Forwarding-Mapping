// web-server.js - Web管理界面服务器
// 提供可视化的代理服务器管理和监控界面

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const net = require('net');
const dgram = require('dgram'); // 添加UDP支持
const fs = require('fs');

// 配置文件管理
const CONFIG_FILE = path.join(__dirname, 'config.json');

// 加载配置
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const configData = fs.readFileSync(CONFIG_FILE, 'utf8');
            return JSON.parse(configData);
        }
    } catch (error) {
        console.error('加载配置文件失败:', error);
    }
    
    // 默认配置
    return {
        server: {
            webPort: 3000,
            localProxyPort: 9000
        },
        portRanges: [],
        specificPorts: []
    };
}

// 保存配置
function saveConfig(config) {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 4), 'utf8');
        return true;
    } catch (error) {
        console.error('保存配置文件失败:', error);
        return false;
    }
}

// 获取所有可用端口
function getAvailablePorts(config) {
    const availablePorts = [];
    
    // 添加端口范围
    config.portRanges.forEach(range => {
        if (range.enabled) {
            for (let port = range.startPort; port <= range.endPort; port++) {
                availablePorts.push({
                    port: port,
                    type: 'range',
                    source: range.name,
                    id: `${range.id}-${port}`,
                    enabled: true
                });
            }
        }
    });
    
    // 添加特定端口
    config.specificPorts.forEach(portConfig => {
        if (portConfig.enabled) {
            availablePorts.push({
                port: portConfig.port,
                type: 'specific',
                source: portConfig.name,
                id: portConfig.id,
                enabled: true
            });
        }
    });
    
    return availablePorts;
}

// 检查端口是否被占用
function isPortOccupied(port) {
    return activeServers.has(port) || activeUdpServers.has(port) || 
           port === config.server.webPort || port === config.server.localProxyPort;
}

// Web服务器配置
let config = loadConfig();
const WEB_PORT = config.server.webPort;
const LOCAL_PROXY_PORT = config.server.localProxyPort;

// 全局状态管理
let connectionId = 0;
const waitingQueue = new Map(); // port -> queue
const idleLocalSockets = new Map(); // port -> sockets array
const activeConnections = new Map(); // connectionId -> connection info
const activeServers = new Map(); // port -> server instance (TCP)
const activeUdpServers = new Map(); // port -> server instance (UDP)
const udpClientMappings = new Map(); // port -> { address, port } mappings for UDP clients
const portMappings = new Map(); // localPort -> publicPort
const portProtocols = new Map(); // publicPort -> 'tcp' | 'udp' | 'both'
const connectionStats = {
    totalConnections: 0,
    activeConnections: 0,
    totalDataTransferred: 0,
    serverStartTime: new Date(),
    lastActivity: new Date(),
    activePorts: 0,
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
    res.json({
        ...connectionStats,
        activeConnectionsCount: activeConnections.size,
        uptime: Date.now() - connectionStats.serverStartTime.getTime(),
        activePorts: activeServers.size,
        totalMappings: portMappings.size
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

// 端口管理API
app.get('/api/ports/available', (req, res) => {
    const availablePorts = getAvailablePorts(config);
    res.json(availablePorts);
});

app.get('/api/ports/active', (req, res) => {
    const activePorts = Array.from(activeServers.keys()).map(port => ({
        port: port,
        connections: activeConnections.size,
        uptime: Date.now() - connectionStats.serverStartTime.getTime()
    }));
    res.json(activePorts);
});

app.post('/api/ports/allocate', (req, res) => {
    const { localPort, preferredPort, protocol = 'both' } = req.body; // 添加协议类型支持
    
    try {
        let allocatedPort = null;
        
        if (preferredPort && !isPortOccupied(preferredPort)) {
            // 检查首选端口是否在可用端口列表中
            const availablePorts = getAvailablePorts(config);
            const isPreferredAvailable = availablePorts.some(p => p.port === preferredPort && p.enabled);
            
            if (isPreferredAvailable) {
                allocatedPort = preferredPort;
            }
        }
        
        if (!allocatedPort) {
            // 自动分配端口
            const availablePorts = getAvailablePorts(config);
            const unoccupiedPorts = availablePorts.filter(p => p.enabled && !isPortOccupied(p.port));
            
            if (unoccupiedPorts.length > 0) {
                allocatedPort = unoccupiedPorts[0].port;
            }
        }
        
        if (allocatedPort) {
            // 创建端口映射和服务器
            const success = createPortMapping(localPort, allocatedPort, protocol);
            if (success) {
                broadcastLog('success', `端口分配成功: ${localPort} -> ${allocatedPort} (${protocol})`);
                res.json({
                    success: true,
                    localPort: localPort,
                    publicPort: allocatedPort,
                    protocol: protocol,
                    message: `端口映射创建成功: ${localPort} -> ${allocatedPort} (${protocol})`
                });
            } else {
                res.status(500).json({
                    success: false,
                    message: '创建端口映射失败'
                });
            }
        } else {
            res.status(400).json({
                success: false,
                message: '没有可用的端口'
            });
        }
    } catch (error) {
        broadcastLog('error', `端口分配失败: ${error.message}`);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

app.delete('/api/ports/mapping/:localPort', (req, res) => {
    const localPort = parseInt(req.params.localPort);
    const publicPort = portMappings.get(localPort);
    
    if (publicPort) {
        const success = removePortMapping(localPort);
        if (success) {
            res.json({
                success: true,
                message: `端口映射已删除: ${localPort} -> ${publicPort}`
            });
        } else {
            res.status(500).json({
                success: false,
                message: '删除端口映射失败'
            });
        }
    } else {
        res.status(404).json({
            success: false,
            message: '端口映射不存在'
        });
    }
});

// 创建端口映射
function createPortMapping(localPort, publicPort, protocol = 'both') {
    try {
        if (activeServers.has(publicPort) || activeUdpServers.has(publicPort)) {
            return false; // 端口已被使用
        }
        
        // 保存协议类型
        portProtocols.set(publicPort, protocol);
        
        let tcpSuccess = true;
        let udpSuccess = true;
        
        // 创建TCP服务器
        if (protocol === 'tcp' || protocol === 'both') {
            try {
                const externalServer = net.createServer((externalSocket) => {
                    handleExternalConnection(externalSocket, publicPort, localPort, 'tcp');
                });
                
                externalServer.listen(publicPort, () => {
                    broadcastLog('success', `TCP外部访问服务器已启动: ${publicPort} -> ${localPort}`);
                    activeServers.set(publicPort, externalServer);
                });
                
                externalServer.on('error', (err) => {
                    broadcastLog('error', `TCP服务器 ${publicPort} 启动失败: ${err.message}`);
                    tcpSuccess = false;
                });
            } catch (error) {
                tcpSuccess = false;
            }
        }
        
        // 创建UDP服务器
        if (protocol === 'udp' || protocol === 'both') {
            try {
                const udpServer = dgram.createSocket('udp4');
                
                udpServer.on('message', (msg, rinfo) => {
                    handleUdpMessage(msg, rinfo, publicPort, localPort);
                });
                
                udpServer.on('listening', () => {
                    broadcastLog('success', `UDP外部访问服务器已启动: ${publicPort} -> ${localPort}`);
                    activeUdpServers.set(publicPort, udpServer);
                });
                
                udpServer.on('error', (err) => {
                    broadcastLog('error', `UDP服务器 ${publicPort} 启动失败: ${err.message}`);
                    udpSuccess = false;
                });
                
                udpServer.bind(publicPort);
            } catch (error) {
                udpSuccess = false;
            }
        }
        
        // 只要有一个协议成功就算成功
        if (tcpSuccess || udpSuccess) {
            portMappings.set(localPort, publicPort);
            connectionStats.activePorts = activeServers.size + activeUdpServers.size;
            connectionStats.totalMappings = portMappings.size;
            
            // 初始化队列和连接池
            if (!waitingQueue.has(publicPort)) {
                waitingQueue.set(publicPort, []);
            }
            if (!idleLocalSockets.has(publicPort)) {
                idleLocalSockets.set(publicPort, []);
            }
            
            broadcastStats();
            return true;
        }
        
        return false;
    } catch (error) {
        broadcastLog('error', `创建端口映射失败: ${error.message}`);
        return false;
    }
}

// 处理UDP消息
function handleUdpMessage(msg, rinfo, publicPort, localPort) {
    const connId = ++connectionId;
    connectionStats.totalConnections++;
    
    broadcastLog('info', `UDP消息从 ${rinfo.address}:${rinfo.port} 到端口 ${publicPort}，大小: ${msg.length}字节`);
    
    // 获取空闲的本地连接来转发UDP数据
    const sockets = idleLocalSockets.get(publicPort) || [];
    
    if (sockets.length === 0) {
        broadcastLog('warning', `端口 ${publicPort} 没有可用的内网连接来转发UDP数据`);
        return;
    }
    
    // 使用第一个可用的本地连接
    const localSocket = sockets.shift();
    idleLocalSockets.set(publicPort, sockets);
    
    if (localSocket.destroyed) {
        broadcastLog('warning', '选中的内网连接已断开，重新尝试');
        handleUdpMessage(msg, rinfo, publicPort, localPort); // 递归重试
        return;
    }
    
    // 创建UDP转发连接记录
    const connectionData = {
        id: connId,
        externalIP: rinfo.address,
        externalPort: rinfo.port,
        publicPort: publicPort,
        localPort: localPort,
        startTime: new Date(),
        bytesTransferred: msg.length,
        isUDP: true
    };
    
    activeConnections.set(connId, connectionData);
    connectionStats.activeConnections++;
    
    broadcastLog('success', `UDP代理${connId}建立: ${rinfo.address}:${rinfo.port} -> ${publicPort} -> ${localPort}`);
    broadcastConnectionEvent('established', connectionData);
    
    // 包装UDP数据包，添加客户端信息头
    const clientInfo = Buffer.alloc(8);
    // 写入客户端IP（假设IPv4）
    const ipParts = rinfo.address.split('.');
    for (let i = 0; i < 4; i++) {
        clientInfo.writeUInt8(parseInt(ipParts[i]) || 0, i);
    }
    // 写入客户端端口
    clientInfo.writeUInt16BE(rinfo.port, 4);
    // 写入数据长度
    clientInfo.writeUInt16BE(msg.length, 6);
    
    const wrappedData = Buffer.concat([clientInfo, msg]);
    
    // 通过TCP连接转发包装后的UDP数据
    localSocket.write(wrappedData);
    
    connectionStats.totalDataTransferred += msg.length;
    connectionStats.lastActivity = new Date();
    
    // 设置响应处理
    const responseHandler = (data) => {
        // 检查是否是UDP响应数据
        if (data.length >= 8) {
            const responseLength = data.readUInt16BE(6);
            if (data.length >= 8 + responseLength) {
                // 提取UDP响应数据
                const responseMsg = data.slice(8, 8 + responseLength);
                
                // 发送UDP响应回外部客户端
                const udpServer = activeUdpServers.get(publicPort);
                if (udpServer) {
                    udpServer.send(responseMsg, rinfo.port, rinfo.address, (err) => {
                        if (err) {
                            broadcastLog('error', `UDP响应发送失败: ${err.message}`);
                        } else {
                            broadcastLog('info', `UDP响应已发送回 ${rinfo.address}:${rinfo.port}，大小: ${responseMsg.length}字节`);
                            connectionData.bytesTransferred += responseMsg.length;
                            connectionStats.totalDataTransferred += responseMsg.length;
                        }
                    });
                }
                
                // 清理连接
                activeConnections.delete(connId);
                connectionStats.activeConnections--;
                broadcastConnectionEvent('closed', connectionData);
                
                // 移除响应处理器
                localSocket.removeListener('data', responseHandler);
                
                // 将连接返回空闲池
                const currentSockets = idleLocalSockets.get(publicPort) || [];
                currentSockets.push(localSocket);
                idleLocalSockets.set(publicPort, currentSockets);
            }
        }
    };
    
    // 添加响应处理器
    localSocket.on('data', responseHandler);
    
    // 设置超时清理
    setTimeout(() => {
        if (activeConnections.has(connId)) {
            activeConnections.delete(connId);
            connectionStats.activeConnections--;
            localSocket.removeListener('data', responseHandler);
            
            // 将连接返回空闲池
            const currentSockets = idleLocalSockets.get(publicPort) || [];
            currentSockets.push(localSocket);
            idleLocalSockets.set(publicPort, currentSockets);
            
            broadcastLog('info', `UDP连接${connId}超时清理`);
        }
    }, 30000); // 30秒超时
}

// 删除端口映射
function removePortMapping(localPort) {
    try {
        const publicPort = portMappings.get(localPort);
        if (!publicPort) return false;
        
        // 关闭TCP服务器
        const server = activeServers.get(publicPort);
        if (server) {
            server.close(() => {
                broadcastLog('info', `TCP外部服务器 ${publicPort} 已关闭`);
            });
            activeServers.delete(publicPort);
        }
        
        // 关闭UDP服务器
        const udpServer = activeUdpServers.get(publicPort);
        if (udpServer) {
            udpServer.close(() => {
                broadcastLog('info', `UDP外部服务器 ${publicPort} 已关闭`);
            });
            activeUdpServers.delete(publicPort);
        }
        
        // 清理连接
        const queue = waitingQueue.get(publicPort) || [];
        queue.forEach(conn => {
            if (!conn.socket.destroyed) {
                conn.socket.destroy();
            }
        });
        
        const sockets = idleLocalSockets.get(publicPort) || [];
        sockets.forEach(socket => {
            if (!socket.destroyed) {
                socket.destroy();
            }
        });
        
        // 清理映射
        portMappings.delete(localPort);
        waitingQueue.delete(publicPort);
        idleLocalSockets.delete(publicPort);
        portProtocols.delete(publicPort);
        
        connectionStats.activePorts = activeServers.size + activeUdpServers.size;
        connectionStats.totalMappings = portMappings.size;
        
        broadcastStats();
        return true;
    } catch (error) {
        broadcastLog('error', `删除端口映射失败: ${error.message}`);
        return false;
    }
}

// 广播状态更新到所有连接的客户端
function broadcastStats() {
    io.emit('stats-update', {
        ...connectionStats,
        activeConnectionsCount: activeConnections.size,
        uptime: Date.now() - connectionStats.serverStartTime.getTime(),
        activePorts: activeServers.size,
        totalMappings: portMappings.size
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

// 处理外部连接
function handleExternalConnection(externalSocket, publicPort, localPort, protocol = 'tcp') {
    const connId = ++connectionId;
    connectionStats.totalConnections++;
    
    broadcastLog('info', `外部用户${connId}连接到端口${publicPort}: ${externalSocket.remoteAddress}`);
    
    const connectionInfo = {
        id: connId,
        socket: externalSocket,
        timestamp: Date.now(),
        publicPort: publicPort,
        localPort: localPort
    };
    
    const queue = waitingQueue.get(publicPort) || [];
    queue.push(connectionInfo);
    waitingQueue.set(publicPort, queue);
    
    broadcastLog('info', `外部连接${connId}加入端口${publicPort}等待队列，当前队列长度: ${queue.length}`);
    
    tryMatchConnections(publicPort);
    
    const timeout = setTimeout(() => {
        const currentQueue = waitingQueue.get(publicPort) || [];
        const index = currentQueue.findIndex(conn => conn.id === connId);
        if (index !== -1) {
            currentQueue.splice(index, 1);
            waitingQueue.set(publicPort, currentQueue);
            broadcastLog('warning', `外部用户${connId}等待超时(60s)，连接被关闭`);
            if (!externalSocket.destroyed) {
                externalSocket.end();
            }
        }
    }, 60000);
    
    externalSocket.on('close', () => {
        clearTimeout(timeout);
        const currentQueue = waitingQueue.get(publicPort) || [];
        const index = currentQueue.findIndex(conn => conn.id === connId);
        if (index !== -1) {
            currentQueue.splice(index, 1);
            waitingQueue.set(publicPort, currentQueue);
            broadcastLog('info', `外部用户${connId}主动断开，已从队列移除`);
        }
        broadcastStats();
    });
    
    externalSocket.on('error', (err) => {
        clearTimeout(timeout);
        const currentQueue = waitingQueue.get(publicPort) || [];
        const index = currentQueue.findIndex(conn => conn.id === connId);
        if (index !== -1) {
            currentQueue.splice(index, 1);
            waitingQueue.set(publicPort, currentQueue);
            broadcastLog('error', `外部用户${connId}发生错误: ${err.code || err.message}`);
        }
        broadcastStats();
    });
}

// 连接匹配函数（针对特定端口）
function tryMatchConnections(publicPort) {
    const queue = waitingQueue.get(publicPort) || [];
    const sockets = idleLocalSockets.get(publicPort) || [];
    
    while (queue.length > 0 && sockets.length > 0) {
        const connectionInfo = queue.shift();
        const externalSocket = connectionInfo.socket;
        const connId = connectionInfo.id;
        
        const localSocket = sockets.shift();
        
        if (externalSocket.destroyed) {
            broadcastLog('warning', `代理${connId}的外部连接已断开，尝试下一个连接`);
            continue;
        }
        
        if (localSocket.destroyed) {
            broadcastLog('warning', '内网连接已断开，尝试下一个连接');
            continue;
        }
        
        establishConnection(externalSocket, localSocket, connId, publicPort, connectionInfo.localPort);
    }
    
    waitingQueue.set(publicPort, queue);
    idleLocalSockets.set(publicPort, sockets);
    broadcastStats();
}

// 建立连接函数（更新版）
function establishConnection(externalSocket, localSocket, connId, publicPort, localPort) {
    broadcastLog('success', `代理${connId}建立连接映射: ${publicPort} -> ${localPort}`, {
        connId,
        externalIP: externalSocket.remoteAddress,
        localIP: localSocket.remoteAddress,
        publicPort: publicPort,
        localPort: localPort
    });
    
    // 记录活跃连接
    const connectionData = {
        id: connId,
        externalIP: externalSocket.remoteAddress,
        localIP: localSocket.remoteAddress,
        publicPort: publicPort,
        localPort: localPort,
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

// 创建内网客户端连接服务器
const localProxyServer = net.createServer((localSocket) => {
    broadcastLog('success', `内网客户端新连接建立: ${localSocket.remoteAddress}`);
    
    // 等待客户端发送端口映射信息
    let headerReceived = false;
    let targetPort = null;
    
    localSocket.on('data', (data) => {
        if (!headerReceived && data.length >= 4) {
            try {
                // 读取4字节的端口号（大端字节序）
                targetPort = data.readUInt32BE(0);
                headerReceived = true;
                
                broadcastLog('info', `内网客户端指定目标端口: ${targetPort}`);
                
                // 检查端口映射是否存在
                if (!activeServers.has(targetPort)) {
                    broadcastLog('warning', `端口${targetPort}没有对应的外部服务器，连接将被关闭`);
                    localSocket.destroy();
                    return;
                }
                
                // 将连接添加到对应端口的空闲池
                const sockets = idleLocalSockets.get(targetPort) || [];
                sockets.push(localSocket);
                idleLocalSockets.set(targetPort, sockets);
                
                broadcastLog('info', `内网连接加入端口${targetPort}空闲池，当前空闲连接数: ${sockets.length}`);
                
                // 尝试匹配连接
                tryMatchConnections(targetPort);
                
                return;
            } catch (error) {
                broadcastLog('error', `解析客户端端口信息失败: ${error.message}`);
                localSocket.destroy();
                return;
            }
        } else if (!headerReceived) {
            // 如果数据长度不足4字节，等待更多数据
            return;
        }
        
        // 如果已经建立连接，这里不应该收到数据，降低日志级别避免刷屏
        // broadcastLog('warning', '未建立映射的内网连接收到数据，忽略');
    });
    
    const onLocalClose = () => {
        if (targetPort) {
            const sockets = idleLocalSockets.get(targetPort) || [];
            const index = sockets.indexOf(localSocket);
            if (index !== -1) {
                sockets.splice(index, 1);
                idleLocalSockets.set(targetPort, sockets);
                broadcastLog('info', `端口${targetPort}的空闲连接已关闭，从连接池移除，剩余: ${sockets.length}`);
            }
        }
        broadcastStats();
    };
    
    const onLocalError = (err) => {
        if (targetPort) {
            const sockets = idleLocalSockets.get(targetPort) || [];
            const index = sockets.indexOf(localSocket);
            if (index !== -1) {
                sockets.splice(index, 1);
                idleLocalSockets.set(targetPort, sockets);
                broadcastLog('error', `端口${targetPort}的空闲连接发生错误: ${err.code || err.message}，从连接池移除`);
            }
        }
        broadcastStats();
    };
    
    localSocket.on('close', onLocalClose);
    localSocket.on('error', onLocalError);
    
    // 超时处理：如果10秒内没有收到端口信息，关闭连接
    const timeout = setTimeout(() => {
        if (!headerReceived) {
            broadcastLog('warning', '内网客户端10秒内未发送端口信息，连接被关闭');
            localSocket.destroy();
        }
    }, 10000);
    
    localSocket.on('close', () => clearTimeout(timeout));
    localSocket.on('error', () => clearTimeout(timeout));
});

// 启动代理服务器
localProxyServer.listen(LOCAL_PROXY_PORT, () => {
    broadcastLog('success', `内网代理服务器已启动，监听端口: ${LOCAL_PROXY_PORT}`);
});

// 启动Web服务器
server.listen(WEB_PORT, () => {
    console.log(`\n🚀 代理服务器Web管理界面已启动!`);
    console.log(`📊 管理界面: http://localhost:${WEB_PORT}`);
    console.log(`🔗 内网代理端口: ${LOCAL_PROXY_PORT}`);
    console.log(`⚙️ 配置文件: ${CONFIG_FILE}\n`);
    
    broadcastLog('success', 'Web管理界面服务器启动成功');
    
    // 加载默认端口映射（如果配置中有的话）
    loadDefaultMappings();
});

// 加载默认端口映射
function loadDefaultMappings() {
    // 这里可以根据需要加载一些默认的端口映射
    broadcastLog('info', '代理服务器已就绪，等待客户端连接...');
}

// WebSocket连接处理
io.on('connection', (socket) => {
    console.log('Web客户端已连接');
    
    // 发送当前统计信息
    socket.emit('stats-update', {
        ...connectionStats,
        waitingQueueLength: Array.from(waitingQueue.values()).reduce((sum, queue) => sum + queue.length, 0),
        idleConnectionsCount: Array.from(idleLocalSockets.values()).reduce((sum, sockets) => sum + sockets.length, 0),
        activeConnectionsCount: activeConnections.size,
        uptime: Date.now() - connectionStats.serverStartTime.getTime(),
        activePorts: activeServers.size,
        totalMappings: portMappings.size
    });
    
    // 发送当前活跃连接列表
    socket.emit('active-connections', Array.from(activeConnections.values()));
    
    // 发送端口映射信息
    socket.emit('port-mappings', Array.from(portMappings.entries()).map(([localPort, publicPort]) => ({
        localPort,
        publicPort,
        active: activeServers.has(publicPort)
    })));
    
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
    
    // 关闭所有活跃的外部服务器
    activeServers.forEach((server, port) => {
        server.close(() => {
            broadcastLog('info', `外部服务器 ${port} 已关闭`);
        });
    });
    
    // 清理所有等待队列
    waitingQueue.forEach((queue) => {
        queue.forEach((connectionInfo) => {
            if (!connectionInfo.socket.destroyed) {
                connectionInfo.socket.destroy();
            }
        });
    });
    
    // 清理所有空闲连接
    idleLocalSockets.forEach((sockets) => {
        sockets.forEach((localSocket) => {
            if (!localSocket.destroyed) {
                localSocket.destroy();
            }
        });
    });
    
    broadcastLog('info', '服务器已完全关闭');
    process.exit(0);
});
