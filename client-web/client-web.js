// client-web-server.js - 客户端Web管理界面服务器（多端口优化版）
// 提供可视化的内网穿透客户端管理和监控界面

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
        const { name, localHost, localPort, preferredPort, protocol = 'tcp', description, enabled = true, autoReconnect = true } = req.body;
        
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
            protocol,
            enabled,
            description: description || '',
            autoReconnect
        };
        
        config.portMappings.push(newMapping);
        
        if (saveConfig(config)) {
            broadcastLog('success', `端口映射已添加: ${name} (${protocol.toUpperCase()})`);
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
        updateClientStatus('connecting');
        startAllMappings();
        res.json({ success: true, message: '客户端已启动' });
    } else {
        res.json({ success: true, message: '客户端已在运行中' });
    }
});

app.post('/api/stop', (req, res) => {
    if (shouldMaintainConnection) {
        shouldMaintainConnection = false;
        stopAllMappings();
        updateClientStatus('stopped');
        res.json({ success: true, message: '客户端已停止' });
    } else {
        res.json({ success: true, message: '客户端已处于停止状态' });
    }
});

app.post('/api/restart', (req, res) => {
    broadcastLog('info', '正在重启客户端服务...');
    shouldMaintainConnection = false;
    stopAllMappings();
    updateClientStatus('connecting');
    setTimeout(() => {
        shouldMaintainConnection = true;
        startAllMappings();
        broadcastLog('success', '客户端服务重启完成');
    }, 1000);
    res.json({ success: true, message: '客户端正在重启' });
});

// 启动所有映射
function startAllMappings() {
    updateClientStatus('connecting');
    const enabledMappings = config.portMappings.filter(mapping => mapping.enabled);
    
    if (enabledMappings.length === 0) {
        updateClientStatus('stopped');
        return;
    }
    
    let startedCount = 0;
    let errorCount = 0;
    
    enabledMappings.forEach(mapping => {
        startMapping(mapping)
            .then(() => {
                startedCount++;
                if (startedCount + errorCount === enabledMappings.length) {
                    if (startedCount > 0) {
                        checkConnectionHealth();
                    } else {
                        updateClientStatus('error');
                    }
                }
            })
            .catch(error => {
                errorCount++;
                broadcastLog('error', `启动映射失败: ${mapping.name} - ${error.message}`);
                if (startedCount + errorCount === enabledMappings.length) {
                    if (startedCount > 0) {
                        checkConnectionHealth();
                    } else {
                        updateClientStatus('error');
                    }
                }
            });
    });
}

// 停止所有映射
function stopAllMappings() {
    activeMappings.forEach((_, mappingId) => {
        stopMapping(mappingId);
    });
    updateClientStatus('stopped');
}

// 更新客户端状态
function updateClientStatus(status) {
    connectionStats.currentStatus = status;
    broadcastStats();
}

// 检查连接健康状态
function checkConnectionHealth() {
    if (!shouldMaintainConnection) {
        return;
    }
    
    const totalActiveConnections = Array.from(connectionPools.values())
        .reduce((sum, pool) => sum + pool.activeConnections, 0);
    const totalIdleConnections = Array.from(connectionPools.values())
        .reduce((sum, pool) => sum + pool.idleConnections, 0);
    
    if (activeMappings.size === 0) {
        updateClientStatus('stopped');
    } else if (totalActiveConnections > 0 || totalIdleConnections > 0) {
        updateClientStatus('connected');
    } else {
        // 检查是否连接失败次数过多
        const recentFailures = connectionHistory
            .filter(conn => {
                const timeDiff = Date.now() - new Date(conn.startTime).getTime();
                return timeDiff < 60000 && // 最近1分钟内
                       (conn.status === 'failed' || conn.errors.length > 0);
            }).length;
        
        if (recentFailures > 5) {
            updateClientStatus('error');
        } else {
            // 如果有活跃映射但没有连接，说明在重连中
            updateClientStatus('connecting');
        }
    }
}

// 启动单个映射
async function startMapping(mapping) {
    if (activeMappings.has(mapping.id)) {
        broadcastLog('warning', `映射 ${mapping.name} 已经在运行`);
        return;
    }
    
    try {
        // 更新状态为连接中
        updateClientStatus('connecting');
        
        let publicPort;
        
        // 如果映射已经有公网端口，尝试重用它
        if (mapping.publicPort) {
            try {
                // 验证端口是否仍然可用
                await requestPortAllocation(mapping);
                publicPort = mapping.publicPort;
                broadcastLog('info', `重用现有端口映射: ${mapping.name} -> 公网:${publicPort}`);
            } catch (error) {
                // 如果现有端口不可用，重新分配
                broadcastLog('warning', `端口 ${mapping.publicPort} 不可用，重新分配: ${error.message}`);
                mapping.publicPort = null;
                publicPort = await requestPortAllocation(mapping);
            }
        } else {
            // 请求新的端口分配
            publicPort = await requestPortAllocation(mapping);
        }
        
        mapping.publicPort = publicPort;
        
        // 保存更新后的配置
        const mappingIndex = config.portMappings.findIndex(m => m.id === mapping.id);
        if (mappingIndex !== -1) {
            config.portMappings[mappingIndex].publicPort = publicPort;
            saveConfig(config);
        }
        
        // 测试本地服务器连接
        try {
            await testLocalServerConnection(mapping.localHost, mapping.localPort, mapping.protocol);
            broadcastLog('success', `本地服务器 ${mapping.localHost}:${mapping.localPort} 连接测试通过`);
        } catch (error) {
            broadcastLog('warning', `本地服务器 ${mapping.localHost}:${mapping.localPort} 连接测试失败: ${error.message}`);
            // 继续执行，因为某些UDP服务器可能不响应测试包
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
        
        // 不在这里立即设置为 connected，等待实际连接建立后再更新状态
        
    } catch (error) {
        broadcastLog('error', `启动映射 ${mapping.name} 失败: ${error.message}`);
        updateClientStatus('error');
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
    
    // 如果没有活跃映射了，更新状态为停止
    if (activeMappings.size === 0) {
        updateClientStatus('stopped');
    }
}

// 请求端口分配
async function requestPortAllocation(mapping) {
    try {
        const serverWebPort = 3000; // 服务端Web端口，可以从配置获取
        
        // 如果映射已有公网端口，优先使用它作为首选端口
        const preferredPort = mapping.publicPort || mapping.preferredPort;
        
        // 使用 http 模块替代 fetch
        const requestData = JSON.stringify({
            localPort: mapping.localPort,
            preferredPort: preferredPort,
            protocol: mapping.protocol || 'tcp' // 添加协议类型支持
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
        
        // 检查连接健康状态
        checkConnectionHealth();
        
        // 发送端口映射信息
        const header = Buffer.alloc(4);
        header.writeUInt32BE(mapping.publicPort, 0);
        proxySocket.write(header);
        
        // 等待外部连接数据
        proxySocket.on('data', (data) => {
            // 检查是否是UDP数据包（包装格式：8字节头 + UDP数据）
            if (data.length >= 8) {
                // 读取客户端信息头
                const clientIP = `${data.readUInt8(0)}.${data.readUInt8(1)}.${data.readUInt8(2)}.${data.readUInt8(3)}`;
                const clientPort = data.readUInt16BE(4);
                const udpDataLength = data.readUInt16BE(6);
                
                // 检查是否是UDP数据包（通过检查IP是否为0.0.0.0来区分UDP响应）
                const isUdpResponse = (clientIP === '0.0.0.0' && clientPort === 0);
                
                if (!isUdpResponse && data.length >= 8 + udpDataLength && udpDataLength > 0) {
                    // 这是一个来自外部的UDP数据包
                    const udpData = data.slice(8, 8 + udpDataLength);
                    
                    broadcastLog('info', `收到UDP数据包，来自 ${clientIP}:${clientPort}，目标端口: ${mapping.localPort}，大小: ${udpDataLength}字节`);
                    
                    // 检查是否为L4D2映射（使用连接池）
                    const isL4D2 = mapping.localPort === 27015 || mapping.name.toLowerCase().includes('l4d2');
                    
                    let localUdpClient;
                    
                    if (isL4D2) {
                        // 使用L4D2连接池
                        localUdpClient = getOrCreateL4D2UdpClient(mapping.id, clientIP, clientPort, mapping.localHost, mapping.localPort);
                    } else {
                        // 创建新的UDP客户端
                        localUdpClient = dgram.createSocket('udp4');
                    }
                    
                    // 设置接收响应的监听器
                    let responseReceived = false;
                    let responseTimeout = null;
                    
                    const handleResponse = (responseMsg, responseRinfo) => {
                        if (responseReceived) return; // 防止重复处理
                        responseReceived = true;
                        
                        // 清除超时定时器
                        if (responseTimeout) {
                            clearTimeout(responseTimeout);
                            responseTimeout = null;
                        }
                        
                        broadcastLog('success', `收到本地UDP响应，来自 ${responseRinfo.address}:${responseRinfo.port}，大小: ${responseMsg.length}字节`);
                        
                        // 包装响应数据，保持与服务端约定的格式一致
                        const responseHeader = Buffer.alloc(8);
                        // 前4字节：响应标识（设为0表示响应）
                        responseHeader.writeUInt8(0, 0);
                        responseHeader.writeUInt8(0, 1);
                        responseHeader.writeUInt8(0, 2);
                        responseHeader.writeUInt8(0, 3);
                        // 第5-6字节：端口号（设为0）
                        responseHeader.writeUInt16BE(0, 4);
                        // 第7-8字节：数据长度
                        responseHeader.writeUInt16BE(responseMsg.length, 6);
                        
                        const wrappedResponse = Buffer.concat([responseHeader, responseMsg]);
                        
                        // 通过TCP连接发送回代理服务器
                        if (!proxySocket.destroyed) {
                            proxySocket.write(wrappedResponse);
                            connectionRecord.bytesTransferred += responseMsg.length;
                            connectionStats.totalDataTransferred += responseMsg.length;
                            broadcastLog('success', `UDP响应已发送回代理服务器，大小: ${responseMsg.length}字节`);
                        }
                        
                        // 对于非L4D2连接，延迟关闭UDP客户端
                        if (!isL4D2) {
                            setTimeout(() => {
                                if (!localUdpClient.destroyed) {
                                    localUdpClient.close();
                                }
                            }, 500);
                        }
                    };
                    
                    // 如果是新创建的客户端，添加事件监听器
                    if (!isL4D2 || !localUdpClient.listenerCount('message')) {
                        localUdpClient.on('message', handleResponse);
                        
                        localUdpClient.on('error', (err) => {
                            broadcastLog('error', `UDP本地客户端错误: ${err.message}`);
                            responseReceived = true;
                            if (responseTimeout) {
                                clearTimeout(responseTimeout);
                                responseTimeout = null;
                            }
                            if (!isL4D2 && !localUdpClient.destroyed) {
                                localUdpClient.close();
                            }
                        });
                    }
                    
                    // 转发UDP数据到本地服务器
                    localUdpClient.send(udpData, mapping.localPort, mapping.localHost, (err) => {
                        if (err) {
                            broadcastLog('error', `UDP转发到本地失败: ${err.message}`);
                            responseReceived = true;
                            if (responseTimeout) {
                                clearTimeout(responseTimeout);
                                responseTimeout = null;
                            }
                            if (!isL4D2 && !localUdpClient.destroyed) {
                                localUdpClient.close();
                            }
                        } else {
                            broadcastLog('success', `UDP数据已转发到本地 ${mapping.localHost}:${mapping.localPort} ${isL4D2 ? '(L4D2连接池)' : ''}`);
                            connectionRecord.bytesTransferred += udpDataLength;
                            connectionStats.totalDataTransferred += udpDataLength;
                            connectionStats.lastActivity = new Date();
                        }
                    });
                    
                    // 设置UDP响应超时（L4D2使用更长的超时时间）
                    const timeoutDuration = isL4D2 ? 15000 : 5000; // L4D2用15秒，其他用5秒
                    responseTimeout = setTimeout(() => {
                        if (!responseReceived) {
                            responseReceived = true;
                            broadcastLog('warning', `UDP响应超时(${timeoutDuration/1000}秒)，${isL4D2 ? 'L4D2连接' : '关闭连接'} - 来自 ${clientIP}:${clientPort}`);
                            if (!isL4D2 && !localUdpClient.destroyed) {
                                localUdpClient.close();
                            }
                        }
                    }, timeoutDuration);
                    
                    return; // UDP处理完成，直接返回
                }
            }
            
            if (!connectionRecord.localConnected) {
                // 原有的TCP连接处理逻辑
                // 建立到本地服务的连接
                const localSocket = net.connect(mapping.localPort, mapping.localHost);
                connectionRecord.localConnected = true;
                pool.idleConnections--;
                pool.activeConnections++;
                
                localSocket.on('connect', () => {
                    broadcastLog('success', `连接 ${connId} 已连接到本地服务 ${mapping.localHost}:${mapping.localPort}`);
                    
                    // 更新连接健康状态
                    checkConnectionHealth();
                    
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
                        
                        // 检查连接健康状态
                        checkConnectionHealth();
                        
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
                    
                    // 检查连接健康状态
                    checkConnectionHealth();
                    
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
        
        // 检查是否所有连接都失败了
        checkConnectionHealth();
        
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

// 测试本地服务器连接
async function testLocalServerConnection(host, port, protocol = 'tcp') {
    return new Promise((resolve, reject) => {
        if (protocol === 'tcp' || protocol === 'both') {
            // 测试TCP连接
            const testSocket = net.createConnection({
                host: host,
                port: port,
                timeout: 3000
            });
            
            testSocket.on('connect', () => {
                broadcastLog('success', `本地TCP服务器 ${host}:${port} 连接测试成功`);
                testSocket.end();
                resolve({ tcp: true });
            });
            
            testSocket.on('timeout', () => {
                broadcastLog('warning', `本地TCP服务器 ${host}:${port} 连接超时`);
                testSocket.destroy();
                reject(new Error(`TCP连接超时`));
            });
            
            testSocket.on('error', (err) => {
                broadcastLog('error', `本地TCP服务器 ${host}:${port} 连接失败: ${err.message}`);
                reject(err);
            });
        }
        
        if (protocol === 'udp' || protocol === 'both') {
            // 测试UDP连接（发送测试包）
            const testUdpClient = dgram.createSocket('udp4');
            const testMessage = Buffer.from('test');
            
            testUdpClient.send(testMessage, port, host, (err) => {
                if (err) {
                    broadcastLog('warning', `本地UDP服务器 ${host}:${port} 测试包发送失败: ${err.message}`);
                } else {
                    broadcastLog('info', `本地UDP服务器 ${host}:${port} 测试包已发送`);
                }
                testUdpClient.close();
                
                if (protocol === 'udp') {
                    resolve({ udp: true });
                }
            });
        }
    });
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
        connectionHistory: connectionHistory.slice(-50),
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

// L4D2 UDP连接池管理
const l4d2UdpPools = new Map(); // mappingId -> { pool: Map<clientKey, udpClient>, lastCleanup: timestamp }

// 获取或创建L4D2 UDP连接
function getOrCreateL4D2UdpClient(mappingId, clientIP, clientPort, localHost, localPort) {
    const clientKey = `${clientIP}:${clientPort}`;
    
    if (!l4d2UdpPools.has(mappingId)) {
        l4d2UdpPools.set(mappingId, {
            pool: new Map(),
            lastCleanup: Date.now()
        });
    }
    
    const poolInfo = l4d2UdpPools.get(mappingId);
    
    // 检查是否有现有连接
    if (poolInfo.pool.has(clientKey)) {
        const existingClient = poolInfo.pool.get(clientKey);
        if (!existingClient.destroyed) {
            broadcastLog('info', `重用L4D2 UDP连接: ${clientKey}`);
            return existingClient;
        } else {
            poolInfo.pool.delete(clientKey);
        }
    }
    
    // 创建新的UDP客户端
    const udpClient = dgram.createSocket('udp4');
    poolInfo.pool.set(clientKey, udpClient);
    
    // 设置连接超时清理
    setTimeout(() => {
        if (poolInfo.pool.has(clientKey)) {
            const client = poolInfo.pool.get(clientKey);
            if (!client.destroyed) {
                client.close();
            }
            poolInfo.pool.delete(clientKey);
            broadcastLog('info', `清理L4D2 UDP连接: ${clientKey}`);
        }
    }, 30000); // 30秒后清理
    
    broadcastLog('info', `创建新的L4D2 UDP连接: ${clientKey}`);
    return udpClient;
}

// 清理过期的L4D2 UDP连接
function cleanupL4D2UdpPools() {
    const now = Date.now();
    for (const [mappingId, poolInfo] of l4d2UdpPools) {
        // 每5分钟清理一次
        if (now - poolInfo.lastCleanup > 300000) {
            for (const [clientKey, udpClient] of poolInfo.pool) {
                if (!udpClient.destroyed) {
                    udpClient.close();
                }
            }
            poolInfo.pool.clear();
            poolInfo.lastCleanup = now;
            broadcastLog('info', `清理映射 ${mappingId} 的所有L4D2 UDP连接`);
        }
    }
}

// 定期清理UDP连接池
setInterval(cleanupL4D2UdpPools, 60000); // 每分钟检查一次

// 启动Web服务器
server.listen(WEB_PORT, () => {
    console.log(`客户端Web管理界面启动成功，访问地址: http://localhost:${WEB_PORT}`);
    broadcastLog('success', `客户端Web管理界面启动成功，端口: ${WEB_PORT}`);
    
    // 自动启动已启用的映射
    setTimeout(() => {
        broadcastLog('info', '开始自动启动已配置的端口映射...');
        shouldMaintainConnection = true;
        connectionStats.currentStatus = 'running';
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
setInterval(() => {
    checkConnectionHealth();
    broadcastStats();
}, 3000);

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