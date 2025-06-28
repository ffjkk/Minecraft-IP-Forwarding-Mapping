// client.js （修复版 - 预连接池客户端）
const net = require('net');

const PUBLIC_SERVER_IP = '159.75.133.177';
const PUBLIC_SERVER_PORT = 9000;
const LOCAL_MC_SERVER = '127.0.0.1';
const LOCAL_MC_PORT = 25565;

let activeConnections = 0;
let reconnectDelay = 2000;
let shouldMaintainConnection = true;

function createConnection() {
    if (!shouldMaintainConnection) return;
    
    console.log(`[${new Date().toLocaleTimeString()}] 建立新连接... (总连接数: ${activeConnections})`);
    
    // 连接到公网服务器
    const proxySocket = net.connect(PUBLIC_SERVER_PORT, PUBLIC_SERVER_IP);
    
    proxySocket.on('connect', () => {
        activeConnections++;
        console.log(`✓ 公网连接成功 (活跃连接: ${activeConnections})`);
        
        // 连接到本地MC服务器
        const mcSocket = net.connect(LOCAL_MC_PORT, LOCAL_MC_SERVER);
        
        mcSocket.on('connect', () => {
            console.log(`✓ 隧道建立成功，等待外部连接`);
            
            // 建立数据转发
            let isActive = true;
            let hasClientConnected = false;
            
            const cleanup = () => {
                if (!isActive) return;
                isActive = false;
                
                activeConnections--;
                console.log(`[${new Date().toLocaleTimeString()}] 隧道关闭 (剩余: ${activeConnections})`);
                
                if (!proxySocket.destroyed) {
                    proxySocket.destroy();
                }
                if (!mcSocket.destroyed) {
                    mcSocket.destroy();
                }
                
                // 连接使用完后，如果没有其他连接在等待，才重建一个
                if (shouldMaintainConnection && activeConnections === 0) {
                    console.log(`[${new Date().toLocaleTimeString()}] 所有连接已关闭，重建等待连接...`);
                    setTimeout(() => {
                        createConnection();
                    }, 1000);
                }
            };
            
            // 数据转发 - 检测到数据传输时说明有客户端连接
            proxySocket.on('data', (data) => {
                if (isActive && !mcSocket.destroyed) {
                    if (!hasClientConnected) {
                        hasClientConnected = true;
                        console.log(`[${new Date().toLocaleTimeString()}] 客户端开始使用此连接`);
                        
                        // 客户端开始使用连接时，立即准备下一个等待连接
                        if (activeConnections === 1) {
                            setTimeout(() => {
                                createConnection();
                            }, 100);
                        }
                    }
                    mcSocket.write(data);
                }
            });
            
            mcSocket.on('data', (data) => {
                if (isActive && !proxySocket.destroyed) {
                    proxySocket.write(data);
                }
            });
            
            // 错误和关闭处理
            proxySocket.on('close', cleanup);
            proxySocket.on('error', cleanup);
            mcSocket.on('close', cleanup);
            mcSocket.on('error', cleanup);
        });
        
        mcSocket.on('error', (err) => {
            console.log(`[MC服务器] 连接失败: ${err.code || err.message}`);
            activeConnections--;
            proxySocket.destroy();
            
            // 重试
            if (shouldMaintainConnection && activeConnections === 0) {
                setTimeout(() => {
                    createConnection();
                }, reconnectDelay * 2); // MC服务器错误时延长重试时间
            }
        });
    });
    
    proxySocket.on('error', (err) => {
        console.log(`[公网服务器] 连接失败: ${err.code || err.message}`);
        
        // 重试
        if (shouldMaintainConnection && activeConnections === 0) {
            setTimeout(() => {
                createConnection();
            }, reconnectDelay);
        }
    });
}

function startClient() {
    console.log('启动内网穿透客户端（按需连接模式）...');
    console.log(`目标服务器: ${PUBLIC_SERVER_IP}:${PUBLIC_SERVER_PORT}`);
    console.log(`本地MC服务器: ${LOCAL_MC_SERVER}:${LOCAL_MC_PORT}`);
    console.log('注意：请确保MC服务器已关闭正版验证');
    console.log('策略：始终保持1个空闲连接等待，有客户端连接时立即创建新的等待连接');
    
    // 启动时只建立一个连接等待
    createConnection();
    
    // 定期检查，确保至少有一个连接等待（降低检查频率）
    setInterval(() => {
        if (shouldMaintainConnection && activeConnections === 0) {
            console.log(`[${new Date().toLocaleTimeString()}] 无活跃连接，重新建立等待连接...`);
            createConnection();
        }
    }, 30000); // 改为30秒检查一次
}

// 优雅关闭
process.on('SIGINT', () => {
    console.log('正在关闭客户端...');
    shouldMaintainConnection = false;
    process.exit(0);
});

// 启动
startClient();