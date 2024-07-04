import { strict as assert } from 'assert';
import net from 'net';
import util from 'util';
import { QuickJSDebugConnection, QuickJSDebugSession } from '../src/index.js';

type QuickJSGlobal = typeof globalThis & {
    Global: typeof globalThis;
};

async function test(socket: net.Socket) {
    const conn = new QuickJSDebugConnection(socket);
    const session = new QuickJSDebugSession(conn);
    const topStack = await session.getTopStack();
    const target = {} as QuickJSGlobal;
    const scopes = await topStack.getScopes();
    await Promise.all(
        scopes.map(async (scope) => {
            target[scope.name] = await scope.inspect({ inspectProto: true });
        })
    );
    process.stdout.write(`${util.inspect(target)}\n`);
    assert.equal(target.Global.JSON, target.Global.globalThis.JSON);
    session.resume();
    conn.close();
}

function main([port]: string[]) {
    const server = net.createServer((socket) => {
        test(socket).catch((err) => {
            console.error(err);
        });
    });
    server.listen(port);
    const addr = server.address() as net.AddressInfo;
    process.stdout.write(`Please connect to <host>:${addr.port}\n`);
}

main(process.argv.slice(2));
