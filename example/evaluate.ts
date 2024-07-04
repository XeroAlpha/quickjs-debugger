import { strict as assert } from 'assert';
import net from 'net';
import { QuickJSDebugConnection, QuickJSDebugSession } from '../src/index.js';

async function test(socket: net.Socket) {
    const conn = new QuickJSDebugConnection(socket);
    const session = new QuickJSDebugSession(conn);
    const topStack = await session.getTopStack();
    const expected = {
        number: 1,
        float: 0.125,
        string: 'Hello world',
        boolean: false,
        null: null,
        undefined,
        object: { array: [1, 2, 3] }
    };
    const resultRef = await topStack.evaluateExpression(`({
        number: 1,
        float: 0.125,
        string: "Hello world",
        boolean: false,
        null: null,
        undefined,
        object: { array: [1, 2, 3] }
    })`);
    const result = await resultRef.inspect();
    assert.deepEqual(result, expected);
    process.stdout.write('Local scope\n');
    process.stdout.write(
        await topStack.evaluate(() => {
            const error = new Error();
            return error.stack ?? '';
        })
    );
    process.stdout.write('Global scope\n');
    process.stdout.write(
        await topStack.evaluateGlobal(() => {
            const error = new Error();
            return error.stack ?? '';
        })
    );
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
