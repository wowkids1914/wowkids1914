import * as zookeeper from 'node-zookeeper-client';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import _ from 'lodash';

const argv = await yargs(hideBin(process.argv))
    .option('zk', {
        alias: 'zookeeper',
        type: 'string',
        description: 'Zookeeper 连接串',
        default: '70.36.96.27:2181',
        demandOption: false,
    })
    .option('path', {
        alias: 'barrierPath',
        type: 'string',
        description: '屏障节点路径',
        default: '/barrier',
        demandOption: false,
    })
    .option('count', {
        alias: 'participantCount',
        type: 'number',
        description: '需要同步的进程数量',
        default: 50,
        demandOption: false,
    })
    .option('value', {
        alias: 'participantValue',
        type: 'number',
        description: '参与者数值',
        demandOption: false,
    })
    .option('exitDelay', {
        alias: 'exitDelayMs',
        type: 'number',
        description: '屏障通过后安全退出的延迟时间（毫秒）',
        default: 2000,
        demandOption: false,
    })
    .help()
    .argv;

const zkConnectionString = argv.zk;
const barrierPath = argv.path;
const participantCount = argv.count;
const participantValue = argv.value;
const exitDelayMs = argv.exitDelay;

const client = zookeeper.createClient(zkConnectionString);

process.on('SIGINT', async () => {
    // Ctrl+C
    console.log('SIGINT: 用户中断');
    client.close();
    process.exit();
});

process.on('SIGTERM', async () => {
    // timeout docker-compose down/stop 会触发 SIGTERM 信号
    console.log('SIGTERM: 终止请求');
    client.close();
    process.exit();
});

// 屏障同步逻辑，统计数值
function enterBarrier(client: zookeeper.Client, barrierPath: string, participantCount: number, participantValue: number): Promise<void> {
    return new Promise((resolve, reject) => {
        // 记录屏障开始时间
        const startTime = Date.now();

        // 创建屏障父节点（如不存在）
        client.mkdirp(barrierPath, (err) => {
            if (err) return reject(err);

            // 每个参与者创建自己的临时子节点
            const nodePath = `${barrierPath}/participant-`;

            client.create(
                nodePath,
                participantValue && Buffer.from(participantValue.toString()),
                zookeeper.CreateMode.EPHEMERAL_SEQUENTIAL,
                (err, createdPath) => {
                    if (err) return reject(err);

                    let lastChildren: string[] = [];
                    const nodeValueCache = new Map<string, number>();

                    function checkBarrier() {
                        client.getChildren(
                            barrierPath,
                            (event) => {
                                // 节点变更时再次检查
                                checkBarrier();
                            },
                            async (err, children) => {
                                if (err) return reject(err);

                                // 找出新增节点
                                const added = children.filter(child => !lastChildren.includes(child));
                                lastChildren = children;

                                // 只对新增节点 getData
                                if (participantValue != null && added.length > 0) {
                                    const startGet = Date.now();
                                    await Promise.all(
                                        added.map(child => {
                                            const fullPath = `${barrierPath}/${child}`;
                                            return new Promise<void>(resolve2 => {
                                                client.getData(fullPath, (err, data) => {
                                                    if (!err && data) {
                                                        nodeValueCache.set(child, Number(data.toString()));
                                                    }
                                                    resolve2();
                                                });
                                            });
                                        })
                                    );

                                    // 统计所有已知节点的数值
                                    const allValues = children.map(child => nodeValueCache.get(child)).filter(Boolean) as number[];
                                    const max = _.max(allValues);
                                    const min = _.min(allValues);
                                    const avg = _.mean(allValues);

                                    console.log('当前节点总数:', allValues.length);
                                    console.log(`最大值: ${max}, 最小值: ${min}, 平均值: ${avg}`);

                                    // 打印新增节点及其数值
                                    for (const child of added) {
                                        const val = nodeValueCache.get(child);
                                        console.log('新增节点 id:', child, '数值:', val);
                                    }
                                    console.log(`本轮耗时: ${((Date.now() - startGet) / 1000).toFixed(1)} 秒`);
                                }

                                if (children.length >= participantCount) {
                                    console.log('屏障已通过！所有参与者已就绪。');
                                    console.log(`屏障耗时: ${((Date.now() - startTime) / 1000).toFixed(1)} 秒`);
                                    resolve();
                                } else {
                                    console.log(barrierPath, `等待中，当前已就绪: ${children.length} / ${participantCount}`);
                                }
                            }
                        );
                    }

                    checkBarrier();
                }
            );
        });
    });
}

client.once('connected', async () => {
    try {
        await enterBarrier(client, barrierPath, participantCount, participantValue);
        console.log('屏障已通过，等待所有参与者检测到屏障...');

        setTimeout(() => {
            console.log('安全退出');
            client.close();
            process.exit();
        }, exitDelayMs);
    } catch (e) {
        console.error('屏障出错:', e);
        client.close();
        process.exit(1);
    }
});

client.connect();