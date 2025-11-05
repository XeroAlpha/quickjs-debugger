import { strict as assert } from 'node:assert';
import { type AddressInfo, createServer, type Socket } from 'node:net';
import { inspect } from 'node:util';
import { QuickJSDebugConnection, QuickJSDebugSession } from '../src/index.js';

type QuickJSGlobal = { Global: QuickJSGlobal } & {
    -readonly [K in keyof typeof globalThis]: (typeof globalThis)[K];
};

async function test(socket: Socket) {
    const conn = new QuickJSDebugConnection(socket);
    const session = new QuickJSDebugSession(conn);
    const topStack = await session.getTopStack();
    const target = {} as QuickJSGlobal;
    const scopes = await topStack.getScopes();
    await Promise.all(
        scopes.map(async (scope) => {
            (target as Record<string, unknown>)[scope.name] = await scope.inspect({ inspectProto: true });
        }),
    );
    process.stdout.write(`${inspect(target)}\n`);
    assert.equal(target.Global.JSON, target.Global.globalThis.JSON);
    session.resume();
    conn.close();
}

function main([port]: string[]) {
    const server = createServer((socket) => {
        test(socket).catch((err) => {
            console.error(err);
        });
    });
    server.listen(port);
    const addr = server.address() as AddressInfo;
    process.stdout.write(`Please connect to <host>:${addr.port}\n`);
}

main(process.argv.slice(2));
