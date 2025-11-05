import { strict as assert } from 'node:assert';
import { type AddressInfo, createServer } from 'node:net';
import { MinecraftDebugSession, QuickJSDebugConnection } from '../src/index.js';

const Minecraft = {} as typeof import('@minecraft/server');

async function test(session: MinecraftDebugSession) {
    const topStack = await session.getTopStack();
    assert.equal(topStack.fileName, 'main.js');
    assert.equal(topStack.lineNumber, 12);
    const result = await topStack.evaluate(
        ({ blockId }) => {
            const permutation = Minecraft.BlockPermutation.resolve(blockId);
            return permutation.getTags();
        },
        { blockId: 'cobblestone' },
    );
    assert.deepEqual(result, ['stone']);
    process.stdout.write(
        await topStack.evaluate(() => {
            const player = [...Minecraft.world.getPlayers()][0];
            const { location } = player;
            return `${player.name}(${location.x},${location.y},${location.z})`;
        }),
    );
    process.stdout.write('\n');
    await session.continue();
}

function main([port]: string[]) {
    const server = createServer((socket) => {
        const conn = new QuickJSDebugConnection(socket);
        const session = new MinecraftDebugSession(conn);
        session.setBreakpoints('main.js', [{ line: 12 }]);
        session.resume();
        session.on('stopped', (ev) => {
            if (ev.reason === 'breakpoint') {
                test(session)
                    .catch((err) => {
                        console.error(err);
                    })
                    .finally(() => {
                        conn.close();
                    });
            }
        });
    });
    server.listen(port);
    const addr = server.address() as AddressInfo;
    process.stdout.write(`Please type '/script debugger connect <host>:${addr.port}' in Minecraft\n`);
}

main(process.argv.slice(2));
