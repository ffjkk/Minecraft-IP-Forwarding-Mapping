// server.js - 透明代理服务器，实现内网穿透功能
// 为每个外部连接创建独立的内网连接，支持多客户端并发访问

// 导入Node.js网络模块，用于创建TCP服务器和客户端
const net = require('net');

// 配置端口设置
const EXTERNAL_PORT = 25565;      // 外部用户连接的端口（MC服务器默认端口）
const LOCAL_PROXY_PORT = 9000;    // 内网客户端连接的端口（代理服务端口）

// 全局变量初始化
let connectionId = 0;              // 连接ID计数器，用于标识每个连接
const waitingQueue = [];           // 等待队列：存储等待内网连接处理的外部连接
const idleLocalSockets = [];       // 空闲内网连接池：存储等待处理外部连接的内网连接

// 创建外部用户连接服务器
// 当外部用户（如MC客户端）连接时，将连接加入等待队列
const externalServer = net.createServer((externalSocket) => {
    // 为每个新连接分配唯一ID
    const connId = ++connectionId;
    
    // 记录外部用户连接信息
    console.log(`[外部用户${connId}] 连接建立: ${externalSocket.remoteAddress}`);
    
    // 创建连接信息对象，包含连接的所有必要信息
    const connectionInfo = {
        id: connId,                    // 连接唯一标识符
        socket: externalSocket,        // TCP套接字对象
        timestamp: Date.now()          // 连接建立时间戳
    };
    
    // 将外部连接加入等待队列，等待内网客户端处理
    waitingQueue.push(connectionInfo);
    console.log(`[队列管理] 外部连接${connId}加入等待队列，当前队列长度: ${waitingQueue.length}`);
    
    // 尝试立即匹配空闲的内网连接
    tryMatchConnections();
    
    // 设置连接超时机制，防止长时间占用资源
    // 60秒后如果仍未被处理，则自动清理连接
    const timeout = setTimeout(() => {
        // 查找并移除超时的连接
        const index = waitingQueue.findIndex(conn => conn.id === connId);
        if (index !== -1) {
            waitingQueue.splice(index, 1);                    // 从队列中移除
            console.log(`[超时处理] 外部用户${connId}等待超时(60s)，连接被关闭`);
            
            // 安全关闭套接字连接
            if (!externalSocket.destroyed) {
                externalSocket.end();
            }
        }
    }, 60000); // 60秒超时设置
    
    // 监听外部连接主动关闭事件
    externalSocket.on('close', () => {
        clearTimeout(timeout);                              // 清除超时定时器
        
        // 从等待队列中移除已关闭的连接
        const index = waitingQueue.findIndex(conn => conn.id === connId);
        if (index !== -1) {
            waitingQueue.splice(index, 1);
            console.log(`[连接关闭] 外部用户${connId}主动断开，已从队列移除`);
        }
    });
    
    // 监听外部连接错误事件
    externalSocket.on('error', (err) => {
        clearTimeout(timeout);                              // 清除超时定时器
        
        // 从等待队列中移除出错的连接
        const index = waitingQueue.findIndex(conn => conn.id === connId);
        if (index !== -1) {
            waitingQueue.splice(index, 1);
            console.log(`[连接错误] 外部用户${connId}发生错误: ${err.code || err.message}`);
        }
    });
});

// 连接匹配函数：尝试匹配等待的外部连接和空闲的内网连接
function tryMatchConnections() {
    // 当有等待的外部连接和空闲的内网连接时，进行匹配
    while (waitingQueue.length > 0 && idleLocalSockets.length > 0) {
        // 获取等待队列中的第一个外部连接
        const connectionInfo = waitingQueue.shift();
        const externalSocket = connectionInfo.socket;
        const connId = connectionInfo.id;
        
        // 获取空闲连接池中的第一个内网连接
        const localSocket = idleLocalSockets.shift();
        
        // 检查连接是否仍然有效
        if (externalSocket.destroyed) {
            console.log(`[连接检查] 代理${connId}的外部连接已断开，尝试下一个连接`);
            continue;
        }
        
        if (localSocket.destroyed) {
            console.log(`[连接检查] 内网连接已断开，尝试下一个连接`);
            continue;
        }
        
        // 建立连接映射
        establishConnection(externalSocket, localSocket, connId);
    }
}

// 建立连接函数：为匹配的外部连接和内网连接建立数据转发
function establishConnection(externalSocket, localSocket, connId) {
    console.log(`[连接映射] 代理${connId}建立连接映射，队列剩余: ${waitingQueue.length}, 空闲连接: ${idleLocalSockets.length}`);
    console.log(`[连接详情] 代理${connId} 外部IP: ${externalSocket.remoteAddress} <-> 内网IP: ${localSocket.remoteAddress}`);
    
    // 设置连接活跃状态标志，用于控制数据转发
    let isConnectionActive = true;
    
    // 创建数据转发函数工厂
    // 返回一个函数，用于在两个套接字间转发数据
    const createDataForwarder = (sourceSocket, targetSocket, direction) => {
        return (data) => {
            // 只有在连接活跃且目标套接字未销毁时才转发数据
            if (isConnectionActive && !targetSocket.destroyed) {
                targetSocket.write(data);                // 写入数据到目标套接字
                // 可选的详细日志（性能考虑，默认注释）
                // console.log(`[数据转发] 代理${connId} ${direction} 转发 ${data.length} 字节`);
            }
        };
    };
    
    // 创建双向数据转发处理器
    const forwardExternalToLocal = createDataForwarder(externalSocket, localSocket, '外部→内网');
    const forwardLocalToExternal = createDataForwarder(localSocket, externalSocket, '内网→外部');
    
    // 绑定数据事件监听器，实现双向数据转发
    externalSocket.on('data', forwardExternalToLocal);  // 外部数据转发到内网
    localSocket.on('data', forwardLocalToExternal);     // 内网数据转发到外部
    
    // 定义连接清理函数，确保资源正确释放
    const cleanupConnection = () => {
        // 防止重复清理
        if (!isConnectionActive) return;
        isConnectionActive = false;
        
        console.log(`[资源清理] 代理${connId}连接结束，开始清理资源`);
        
        // 移除所有事件监听器，防止内存泄漏
        externalSocket.removeListener('data', forwardExternalToLocal);
        localSocket.removeListener('data', forwardLocalToExternal);
        
        // 安全关闭所有连接
        if (!externalSocket.destroyed) {
            externalSocket.destroy();                    // 销毁外部连接
        }
        if (!localSocket.destroyed) {
            localSocket.destroy();                      // 销毁内网连接
        }
    };
    
    // 绑定连接关闭和错误事件处理器
    
    // 外部连接关闭事件
    externalSocket.on('close', () => {
        console.log(`[连接关闭] 外部用户${connId}连接已关闭`);
        cleanupConnection();                            // 执行清理操作
    });
    
    // 外部连接错误事件
    externalSocket.on('error', (err) => {
        console.log(`[连接错误] 外部用户${connId}连接发生错误: ${err.code || err.message}`);
        cleanupConnection();                            // 执行清理操作
    });
    
    // 内网连接关闭事件
    localSocket.on('close', () => {
        console.log(`[连接关闭] 内网客户端${connId}连接已关闭`);
        cleanupConnection();                            // 执行清理操作
    });
    
    // 内网连接错误事件
    localSocket.on('error', (err) => {
        console.log(`[连接错误] 内网客户端${connId}连接发生错误: ${err.code || err.message}`);
        cleanupConnection();                            // 执行清理操作
    });
}

// 创建内网客户端连接服务器
// 当内网客户端连接时，将其加入空闲连接池或立即匹配外部连接
const localProxyServer = net.createServer((localSocket) => {
    // 记录新的内网客户端连接
    console.log(`[内网客户端] 新连接建立: ${localSocket.remoteAddress}`);
    
    // 将内网连接加入空闲连接池
    idleLocalSockets.push(localSocket);
    console.log(`[连接池] 内网连接加入空闲池，当前空闲连接数: ${idleLocalSockets.length}`);
    
    // 设置空闲连接的事件监听器
    const onLocalClose = () => {
        // 从空闲连接池中移除已关闭的连接
        const index = idleLocalSockets.indexOf(localSocket);
        if (index !== -1) {
            idleLocalSockets.splice(index, 1);
            console.log(`[连接池] 内网空闲连接已关闭，从连接池移除，剩余: ${idleLocalSockets.length}`);
        }
    };
    
    const onLocalError = (err) => {
        // 从空闲连接池中移除出错的连接
        const index = idleLocalSockets.indexOf(localSocket);
        if (index !== -1) {
            idleLocalSockets.splice(index, 1);
            console.log(`[连接池] 内网空闲连接发生错误: ${err.code || err.message}，从连接池移除`);
        }
    };
    
    // 绑定事件监听器
    localSocket.on('close', onLocalClose);
    localSocket.on('error', onLocalError);
    
    // 尝试立即匹配等待的外部连接
    tryMatchConnections();
});

// 启动内网客户端代理服务器
// 监听指定端口，等待内网客户端连接
localProxyServer.listen(LOCAL_PROXY_PORT, () => {
    console.log(`[服务启动] 内网代理服务器已启动，监听端口: ${LOCAL_PROXY_PORT}`);
    console.log(`[服务状态] 等待内网客户端连接...`);
});

// 启动外部用户访问服务器
// 监听指定端口，等待外部用户（如MC客户端）连接
externalServer.listen(EXTERNAL_PORT, () => {
    console.log(`[服务启动] 外部访问服务器已启动，监听端口: ${EXTERNAL_PORT}`);
    console.log(`[服务信息] 外部用户可通过此端口连接到内网MC服务器`);
    console.log(`[代理模式] 透明代理模式，支持多客户端并发访问`);
});

// 全局异常处理机制
// 捕获未处理的异常，防止程序崩溃
process.on('uncaughtException', (err) => {
    console.log(`[全局异常] 捕获到未处理异常: ${err.message}`);
    console.log(`[异常堆栈] ${err.stack}`);
    // 在生产环境中，可能需要更优雅的错误处理和服务重启
});

// 监听程序终止信号（Ctrl+C）
// 实现优雅关闭，清理资源
process.on('SIGINT', () => {
    console.log(`[服务关闭] 接收到终止信号，正在优雅关闭服务器...`);
    
    // 关闭服务器，停止接受新连接
    if (localProxyServer) {
        localProxyServer.close(() => {
            console.log(`[服务关闭] 内网代理服务器已关闭`);
        });
    }
    
    if (externalServer) {
        externalServer.close(() => {
            console.log(`[服务关闭] 外部访问服务器已关闭`);
        });
    }
    
    // 清理等待队列中的连接
    waitingQueue.forEach((connectionInfo, index) => {
        if (!connectionInfo.socket.destroyed) {
            connectionInfo.socket.destroy();
            console.log(`[队列清理] 已清理等待队列中的连接${connectionInfo.id}`);
        }
    });
    
    // 清理空闲连接池中的连接
    idleLocalSockets.forEach((localSocket, index) => {
        if (!localSocket.destroyed) {
            localSocket.destroy();
            console.log(`[连接池清理] 已清理空闲连接池中的连接${index + 1}`);
        }
    });
    
    console.log(`[服务关闭] 服务器已完全关闭，程序退出`);
    process.exit(0);  // 正常退出程序
});